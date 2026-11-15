import "server-only"

import { parseSetCookieHeader, toCookieOptions } from "better-auth/cookies"
import { cookies, headers } from "next/headers"

import { getAuth } from "./auth"
import { publicUrl } from "./site"

/**
 * A POST to one of better-auth's endpoints from a server action, as the browser would make it (its cookies, the
 * site's origin), with the cookies better-auth sets passed on to the browser. Used where better-auth continues an
 * OAuth authorization (sign-in with `oauth_query`, consent): it answers `{ redirect: true, url }` to follow.
 */
export async function authPost(path: string, body: Record<string, unknown>): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
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
  return { ok: response.ok, status: response.status, data }
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
