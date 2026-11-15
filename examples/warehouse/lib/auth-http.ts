import "server-only"

import { verifyOAuthQueryParams } from "@better-auth/oauth-provider"
import { parseSetCookieHeader, toCookieOptions } from "better-auth/cookies"
import { cookies, headers } from "next/headers"

import { getAuth } from "./auth"
import { publicUrl } from "./site"

export { restartAuthorization, staleOAuthQuery } from "./oauth-query"

/**
 * A POST to one of better-auth's endpoints from a server action, as the browser would make it (its cookies, the
 * site's origin), with the cookies better-auth sets passed on to the browser. Used where better-auth continues an
 * OAuth authorization (sign-in with `oauth_query`, consent): it answers `{ redirect: true, url }` to follow.
 */
export async function authPost(path: string, body: Record<string, unknown>): Promise<{ ok: boolean; status: number; data: Record<string, unknown>; setCookies: string[] }> {
  const auth = await getAuth()
  const incoming = await headers()
  const site = publicUrl()
  const response = await auth.handler(
    new Request(`${site}/api/auth${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        origin: site,
        cookie: incoming.get("cookie") ?? "",
        "user-agent": incoming.get("user-agent") ?? "",
        // The client's address, as the platform (Vercel, `next start`) gave it: better-auth rate-limits sign-ins per address.
        ...(incoming.get("x-forwarded-for") ? { "x-forwarded-for": incoming.get("x-forwarded-for")! } : {}),
      },
      body: JSON.stringify(body),
    }),
  )
  const jar = await cookies()
  for (const line of response.headers.getSetCookie()) for (const [name, attributes] of parseSetCookieHeader(line)) jar.set(name, attributes.value, toCookieOptions(attributes))
  const text = await response.text()
  let data: Record<string, unknown> = {}
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  } catch {
    data = { message: text }
  }
  return { ok: response.ok, status: response.status, data, setCookies: response.headers.getSetCookie() }
}

/** Where better-auth says to go next (`{ redirect: true, url }`), or null. */
export const nextUrl = (data: Record<string, unknown>) => (data.redirect === true && typeof data.url === "string" ? data.url : null)

/** The signed OAuth request a page was opened with (`…&sig=…`), as a query string; null when the page was opened normally. */
export function oauthQueryOf(searchParams: Record<string, string | string[] | undefined>): string | null {
  if (typeof searchParams.sig !== "string") return null
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(searchParams)) for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(key, v)
  return query.toString()
}

/** Whether better-auth still accepts a signed request: signed by it, unchanged, and inside its ten minutes. */
export async function oauthQueryHolds(oauthQuery: string): Promise<boolean> {
  return verifyOAuthQueryParams(oauthQuery, (await (await getAuth()).$context).secret)
}

/**
 * Runs `restartAuthorization`'s request inside a server action, as the person: their cookies, with the session a
 * sign-in just made (`setCookies`) in place of the old one; answers where it goes next. A server action's redirect
 * to an API route would be fetched twice by Next (once for its page data, once for real), so the action asks here.
 */
export async function authorizeAgain(path: string, setCookies: string[] = []): Promise<string | null> {
  const incoming = await headers()
  const jar = new Map<string, string>()
  for (const pair of [...(incoming.get("cookie") ?? "").split(";"), ...setCookies.map((line) => line.split(";")[0]!)]) {
    const at = pair.indexOf("=")
    if (at > 0) jar.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim())
  }
  const response = await (await getAuth()).handler(
    new Request(`${publicUrl()}${path}`, { headers: { accept: "text/html", cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "), "user-agent": incoming.get("user-agent") ?? "" }, redirect: "manual" }),
  )
  const location = response.headers.get("location")
  if (location) return location
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>
  return nextUrl(data) ?? (typeof data.url === "string" && response.ok ? data.url : null)
}
