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
