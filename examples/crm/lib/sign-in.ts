// What the sign-in and consent pages' server actions do, with the request's headers passed in (the actions read
// them with next/headers), so the tests run the same code.
import { redirect } from "next/navigation"

import { auth } from "./auth"
import { authorizeAgain, authRequest, followOAuth, isStaleOAuthQuery, restartable, restartAuthorization, signedAgeMs, TOO_OLD_MESSAGE } from "./oauth-pages"

/**
 * Signs in. With `oauthQuery` (the page was opened by an OAuth authorization: ChatGPT, Claude, a workspace host),
 * better-auth continues that authorization and answers where to go: the consent page, or straight back to the
 * client when the person already agreed. Ends in a redirect.
 */
export async function signIn(email: string, password: string, oauthQuery: string | null, requestHeaders: Headers): Promise<never> {
  const call = (query: string | null) =>
    auth().api.signInEmail({ body: { email, password, ...(query ? { oauth_query: query } : {}) }, headers: requestHeaders, request: authRequest("/sign-in/email", requestHeaders), asResponse: true })
  let response = await call(oauthQuery).catch((error: unknown) => {
    if (oauthQuery && isStaleOAuthQuery(error)) return null
    throw error
  })
  if (oauthQuery) console.info(`[oauth] sign-in with a signed request ${ageOf(oauthQuery)} old${response ? "" : ", no longer valid"}`)
  // Opened so long ago that the app has moved on: its code would be refused there. Say so instead.
  if (!response && oauthQuery && !restartable(oauthQuery)) redirect(`/sign-in?error=${encodeURIComponent(TOO_OLD_MESSAGE)}`)
  // The page was open longer than the signed request lives (ten minutes): sign in, then the same authorization
  // again, now with a session, so it goes on to the consent page (or straight back to the app).
  const restart = !response && oauthQuery ? restartAuthorization(oauthQuery, { signedIn: true }) : null
  if (!response) response = await call(null)
  if (response.status === 401 || response.status === 403) redirect(signInWith(oauthQuery, "Wrong email or password."))
  if (restart && response.ok) await authorizeAgain(restart, requestHeaders, response)
  if (oauthQuery && !restart) await followOAuth(response, "sign-in")
  if (!response.ok) throw new Error(`Sign-in failed (${response.status}).`)
  redirect("/")
}

/** Back to the sign-in page with a message, keeping the OAuth request (every value of it) when there is one. */
export function signInWith(oauthQuery: string | null, error: string) {
  const query = new URLSearchParams(oauthQuery ?? "")
  query.set("error", error)
  return `/sign-in?${query}`
}

/** The person's answer on the consent page: better-auth sends them back to the client, with a code or `access_denied`. */
export async function answerConsent(oauthQuery: string, accept: boolean, requestHeaders: Headers): Promise<never> {
  const response = await auth()
    .api.oauth2Consent({ body: { accept, oauth_query: oauthQuery }, headers: requestHeaders, request: authRequest("/oauth2/consent", requestHeaders), asResponse: true })
    // Answered after the signed request's ten minutes: the same authorization again, which asks once more.
    .catch((error: unknown) => {
      if (!isStaleOAuthQuery(error)) throw error
      console.info(`[oauth] consent on a signed request ${ageOf(oauthQuery)} old, no longer valid`)
      if (!restartable(oauthQuery)) redirect(`/sign-in?error=${encodeURIComponent(TOO_OLD_MESSAGE)}`)
      return authorizeAgain(restartAuthorization(oauthQuery, { signedIn: false }), requestHeaders)
    })
  return followOAuth(response, "consent")
}

const ageOf = (oauthQuery: string) => {
  const age = signedAgeMs(oauthQuery)
  return age === null ? "of unknown age" : `${Math.round(age / 1000)} s`
}
