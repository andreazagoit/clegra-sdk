"use server"
import { APIError } from "better-auth/api"
import { headers } from "next/headers"
import { redirect } from "next/navigation"

import { auth } from "@/lib/auth"
import { DEMO_USERS } from "@/lib/demo-data"

async function signIn(email: string, password: string) {
  try {
    await auth().api.signInEmail({ body: { email, password }, headers: await headers() })
  } catch (error) {
    if (error instanceof APIError) redirect(`/sign-in?error=${encodeURIComponent("Wrong email or password.")}`)
    throw error
  }
  redirect("/")
}

export async function signInAction(form: FormData) {
  const email = String(form.get("email") ?? "").trim()
  const password = String(form.get("password") ?? "")
  if (!email || !password) redirect(`/sign-in?error=${encodeURIComponent("Enter your email and password.")}`)
  await signIn(email, password)
}

/**
 * One-click sign-in as a seeded demo account (DEMO_SIGNIN=1 only): the password stays on the server
 * (DEMO_PASSWORD), nobody types it. Only the demo accounts, never another email.
 */
export async function demoSignInAction(email: string) {
  if (process.env.DEMO_SIGNIN !== "1") throw new Error("The demo sign-in is off (DEMO_SIGNIN=1 turns it on).")
  const demo = DEMO_USERS.find((u) => u.email === email)
  const password = process.env.DEMO_PASSWORD
  if (!demo) throw new Error("Not a demo account.")
  if (!password) throw new Error("DEMO_PASSWORD is not set: run `npm run setup`.")
  await signIn(demo.email, password)
}
