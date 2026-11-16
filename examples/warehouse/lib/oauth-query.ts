// The signed OAuth request the sign-in and consent pages carry, when it no longer holds. Plain functions (no server
// imports), so the tests use them as the pages do.

/** better-auth refused the signed request (its answer's `error`): older than its ten minutes, or altered. */
export const staleOAuthQuery = (data: Record<string, unknown>) => data.error === "invalid_signature"

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
  return `/api/auth/oauth2/authorize?${query}`
}

/**
 * How long after better-auth signed it a request is still started again. Past that the app that asked (ChatGPT,
 * Claude…) has most likely given up on it or started another one: its code would be refused there ("missing OAuth
 * data"), so the person is told to start again from the app instead.
 */
export const RESTART_WITHIN_MS = 30 * 60_000

/** How long ago better-auth signed the request (`ba_iat`, ms), or null when it says nothing usable. */
export function signedAgeMs(oauthQuery: string, now = Date.now()): number | null {
  const issuedAt = Number(new URLSearchParams(oauthQuery).get("ba_iat"))
  return Number.isFinite(issuedAt) && issuedAt > 0 ? now - issuedAt : null
}

/** A signed request that no longer holds but is recent enough to start again (see RESTART_WITHIN_MS). */
export function restartable(oauthQuery: string, now = Date.now()): boolean {
  const age = signedAgeMs(oauthQuery, now)
  return age !== null && age >= 0 && age <= RESTART_WITHIN_MS
}

/** The message for a connection page too old to go on with. */
export const TOO_OLD_MESSAGE = "This connection page was opened too long ago and the app has moved on. Close this tab and start connecting again from the app you were using."

/** Where a step of the flow sends the person, for the logs: origin, path and the names of the parameters (never their values). */
export function describeRedirect(url: string): string {
  const u = new URL(url, "http://relative.invalid")
  return `${u.origin === "http://relative.invalid" ? "" : u.origin}${u.pathname} [${[...new Set(u.searchParams.keys())].join(",")}]`
}
