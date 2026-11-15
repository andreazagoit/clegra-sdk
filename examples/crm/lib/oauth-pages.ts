// What the sign-in and consent pages need from an OAuth authorization in progress. better-auth sends the person
// to them with the authorization request in the address, signed (`sig`); the pages hand it back unchanged
// (`oauth_query`), and better-auth answers where to go next.
import { APIError } from "better-auth/api"
import { redirect } from "next/navigation"

import { auth } from "./auth"
import { authIssuer } from "./site"

/**
 * The page's query as better-auth signed it (its `ba_param` names, `sig`), or null when the page was opened
 * directly. Anything the page added to its own address (an error message) is left out: it would break the signature.
 */
export function oauthQueryOf(searchParams: Record<string, string | string[] | undefined>): string | null {
  if (typeof searchParams.sig !== "string") return null
  const values = (key: string) => {
    const v = searchParams[key]
    return Array.isArray(v) ? v : v === undefined ? [] : [v]
  }
  const signed = new Set(values("ba_param"))
  if (!signed.size) return null
  const query = new URLSearchParams()
  for (const key of Object.keys(searchParams)) if (key === "sig" || signed.has(key)) for (const v of values(key)) query.append(key, v)
  return query.toString()
}

/** Follows better-auth's answer to a step of the flow: a redirect (`location`), or `{ redirect: true, url }`. */
export async function followOAuth(response: Response): Promise<never> {
  const location = response.headers.get("location")
  if (location) redirect(location)
  const body = (await response.json().catch(() => null)) as { url?: unknown; message?: unknown; error_description?: unknown } | null
  if (response.ok && typeof body?.url === "string") redirect(body.url)
  throw new Error(`The authorization could not continue (${response.status}${typeof body?.error_description === "string" ? `: ${body.error_description}` : typeof body?.message === "string" ? `: ${body.message}` : ""}).`)
}

/**
 * The request a server action makes to a better-auth endpoint on the person's behalf. better-auth continues an
 * authorization only for a call that has one (as its HTTP handler has), so the action passes it with `request`.
 */
export function authRequest(path: string, headers: Headers): Request {
  return new Request(`${authIssuer()}${path}`, { method: "POST", headers })
}

/** better-auth refused the signed request: older than its ten minutes, or altered. */
export const isStaleOAuthQuery = (error: unknown) => error instanceof APIError && (error.body as { error?: unknown } | undefined)?.error === "invalid_signature"

/**
 * The authorization request again, as the client sent it (better-auth's own fields dropped), for a signed request
 * that no longer holds: a page left open longer than ten minutes. Opening it starts the same authorization afresh
 * (better-auth checks all of it again and signs a new request), and the client still gets its code with its own
 * `state`, so the person goes on instead of starting over from the app. `signedIn`: the person has just signed in,
 * which answers `prompt=login` and `max_age`, as better-auth does for a fresh sign-in.
 */
export function restartAuthorization(oauthQuery: string, { signedIn }: { signedIn: boolean }): string {
  const query = new URLSearchParams(oauthQuery)
  for (const key of ["sig", "exp", "ba_iat", "ba_param", "ba_pl"]) query.delete(key)
  if (signedIn) {
    query.delete("max_age")
    const prompt = (query.get("prompt") ?? "").split(" ").filter((p) => p && p !== "login")
    if (prompt.length) query.set("prompt", prompt.join(" "))
    else query.delete("prompt")
  }
  return `${new URL(authIssuer()).pathname}/oauth2/authorize?${query}`
}

/**
 * Runs `restartAuthorization`'s request inside a server action, as the person: their cookies, with the session a
 * sign-in just made (`signedIn`'s cookies) in place of the old one. A server action's redirect to an API route
 * would be fetched twice by Next (once for its page data, once for real), so the action follows the answer itself.
 */
export async function authorizeAgain(path: string, requestHeaders: Headers, signedIn?: Response): Promise<never> {
  const cookies = new Map<string, string>()
  for (const pair of (requestHeaders.get("cookie") ?? "").split(";")) {
    const at = pair.indexOf("=")
    if (at > 0) cookies.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim())
  }
  for (const line of signedIn?.headers.getSetCookie() ?? []) {
    const pair = line.split(";")[0]!
    const at = pair.indexOf("=")
    if (at > 0) cookies.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim())
  }
  const headers = new Headers({ accept: "text/html", cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") })
  const userAgent = requestHeaders.get("user-agent")
  if (userAgent) headers.set("user-agent", userAgent)
  return followOAuth(await auth().handler(new Request(new URL(path, authIssuer()), { headers, redirect: "manual" })))
}
