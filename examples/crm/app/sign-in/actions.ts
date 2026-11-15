"use server"
import { headers } from "next/headers"
import { redirect } from "next/navigation"

import { DEMO_USERS } from "@/lib/demo-data"
import { signIn, signInWith } from "@/lib/sign-in"

const queryOf = (form: FormData) => {
  const q = form.get("oauth_query")
  return typeof q === "string" && q ? q : null
}

export async function signInAction(form: FormData) {
  const email = String(form.get("email") ?? "").trim()
  const password = String(form.get("password") ?? "")
  if (!email || !password) redirect(signInWith(queryOf(form), "Enter your email and password."))
  await signIn(email, password, queryOf(form), await headers())
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
  await signIn(demo.email, password, queryOf(form), await headers())
}
