"use server"
import { APIError } from "better-auth/api"
import { headers } from "next/headers"
import { redirect } from "next/navigation"

import { auth } from "@/lib/auth"
import { DEMO_USERS } from "@/lib/demo-data"
import { authRequest, followOAuth } from "@/lib/oauth-pages"

/**
 * Signs in. With `oauthQuery` (the page was opened by an OAuth authorization: ChatGPT, Claude, a workspace host),
 * better-auth continues that authorization and answers where to go: the consent page, or straight back to the
 * client when the person already agreed.
 */
async function signIn(email: string, password: string, oauthQuery: string | null) {
  const requestHeaders = await headers()
  const response = await auth()
    .api.signInEmail({ body: { email, password, ...(oauthQuery ? { oauth_query: oauthQuery } : {}) }, headers: requestHeaders, request: authRequest("/sign-in/email", requestHeaders), asResponse: true })
    .catch((error: unknown) => {
      // A signed authorization request that expired or was altered: start again from the app.
      if (error instanceof APIError && oauthQuery) redirect(`/sign-in?error=${encodeURIComponent("This connection request has expired. Start connecting again from the app you were using.")}`)
      throw error
    })
  if (response.status === 401 || response.status === 403) {
    redirect(signInWith(oauthQuery, "Wrong email or password."))
  }
  if (oauthQuery) await followOAuth(response)
  if (!response.ok) throw new Error(`Sign-in failed (${response.status}).`)
  redirect("/")
}

/** Back to the sign-in page with a message, keeping the OAuth request (every value of it) when there is one. */
function signInWith(oauthQuery: string | null, error: string) {
  const query = new URLSearchParams(oauthQuery ?? "")
  query.set("error", error)
  return `/sign-in?${query}`
}

const queryOf = (form: FormData) => {
  const q = form.get("oauth_query")
  return typeof q === "string" && q ? q : null
}

export async function signInAction(form: FormData) {
  const email = String(form.get("email") ?? "").trim()
  const password = String(form.get("password") ?? "")
  if (!email || !password) redirect(signInWith(queryOf(form), "Enter your email and password."))
  await signIn(email, password, queryOf(form))
}

/**
 * One-click sign-in as a seeded demo account (DEMO_SIGNIN=1 only): the password stays on the server
 * (DEMO_PASSWORD), nobody types it. Only the demo accounts, never another email. Continues an OAuth
 * authorization like the form does.
 */
export async function demoSignInAction(email: string, form: FormData) {
  if (process.env.DEMO_SIGNIN !== "1") throw new Error("The demo sign-in is off (DEMO_SIGNIN=1 turns it on).")
  const demo = DEMO_USERS.find((u) => u.email === email)
  const password = process.env.DEMO_PASSWORD
  if (!demo) throw new Error("Not a demo account.")
  if (!password) throw new Error("DEMO_PASSWORD is not set: run `npm run setup`.")
  await signIn(demo.email, password, queryOf(form))
}
