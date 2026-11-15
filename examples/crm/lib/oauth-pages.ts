// What the sign-in and consent pages need from an OAuth authorization in progress. better-auth sends the person
// to them with the authorization request in the address, signed (`sig`); the pages hand it back unchanged
// (`oauth_query`), and better-auth answers where to go next.
import { redirect } from "next/navigation"

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
