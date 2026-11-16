"use server"

import { revalidatePath } from "next/cache"
import { headers } from "next/headers"
import { redirect } from "next/navigation"

import type { ActionState } from "@/components/action-form"
import { getAuth } from "@/lib/auth"
import { authorizeAgain, authPost, describeRedirect, nextUrl, restartable, restartAuthorization, signedAgeMs, staleOAuthQuery, TOO_OLD_MESSAGE } from "@/lib/auth-http"
import { DEMO_USERS, demoPassword } from "@/lib/demo"
import { requirePermission } from "@/lib/session"
import { cancelOrder, confirmOrder, MOVEMENT_KINDS, registerMovement, WarehouseError, type MovementKind } from "@/lib/warehouse"

// Every server action checks the session and the permission itself: they are reachable by a plain POST.

const text = (form: FormData, key: string) => {
  const v = form.get(key)
  return typeof v === "string" ? v.trim() : ""
}

/** The typed fields, to give back with a refusal (never a password). */
const typed = (form: FormData): Record<string, string> =>
  Object.fromEntries([...form.entries()].flatMap(([k, v]) => (typeof v === "string" && k !== "password" && !k.startsWith("$ACTION") ? [[k, v]] : [])))

/** A refusal the person can act on, as the form's message; anything else is a bug and stays an error. */
function refusal(error: unknown, form: FormData): ActionState {
  if (error instanceof WarehouseError) return { error: error.message, values: typed(form) }
  throw error
}

/**
 * Signs in through better-auth's own endpoint. When the page was opened by an OAuth authorization (ChatGPT, Claude,
 * Clegra connecting), its signed request rides along as `oauth_query` and better-auth answers where it continues
 * (the consent page, or straight back to the client); otherwise the person lands on the dashboard.
 */
async function signIn(email: string, password: string, form: FormData): Promise<ActionState> {
  const oauthQuery = text(form, "oauth_query")
  let { ok, status, data, setCookies } = await authPost("/sign-in/email", { email, password, ...(oauthQuery ? { oauth_query: oauthQuery } : {}) })
  const stale = !!oauthQuery && !ok && staleOAuthQuery(data)
  if (oauthQuery) console.info(`[oauth] sign-in with a signed request ${ageOf(oauthQuery)} old${stale ? ", no longer valid" : ""}`)
  // Opened so long ago that the app has moved on: its code would be refused there. Say so instead.
  if (stale && !restartable(oauthQuery)) return { error: TOO_OLD_MESSAGE }
  // The page was open longer than the signed request lives (ten minutes): sign in, then the same authorization
  // again, now with a session, so it goes on to the consent page (or straight back to the app).
  const restart = stale ? restartAuthorization(oauthQuery, { signedIn: true }) : null
  if (restart) ({ ok, status, data, setCookies } = await authPost("/sign-in/email", { email, password }))
  if (!ok) return { error: status === 401 ? "Wrong email or password." : status === 429 ? "Too many sign-in attempts from here: wait a few seconds and try again." : `Sign-in failed (${String(data.error_description ?? data.message ?? status)}).`, values: typed(form) }
  if (restart) {
    const url = await authorizeAgain(restart, setCookies)
    if (!url) return { error: "The connection could not continue. Start again from the app that asked.", values: typed(form) }
    console.info(`[oauth] authorize again → ${describeRedirect(url)}`)
    redirect(url)
  }
  const next = nextUrl(data)
  if (oauthQuery && next) console.info(`[oauth] sign-in → ${describeRedirect(next)}`)
  redirect(next ?? "/")
}

export async function signInAction(_state: ActionState, form: FormData): Promise<ActionState> {
  const email = text(form, "email").toLowerCase()
  const password = typeof form.get("password") === "string" ? (form.get("password") as string) : ""
  if (!email || !password) return { error: "Give your email and password.", values: typed(form) }
  return signIn(email, password, form)
}

/** One-click sign-in as a seeded demo person (DEMO_SIGNIN=1 only): the password never leaves the server. */
export async function demoSignInAction(_state: ActionState, form: FormData): Promise<ActionState> {
  if (process.env.DEMO_SIGNIN !== "1") return { error: "Demo sign-in is off." }
  const user = DEMO_USERS.find((u) => u.email === text(form, "email"))
  if (!user) return { error: "Not a demo person." }
  const result = await signIn(user.email, demoPassword(), form)
  return result?.error?.startsWith("Wrong") ? { error: "The demo people are not seeded with this DEMO_PASSWORD: run `npm run db:seed`." } : result
}

/** The person's answer on the consent page: better-auth sends the client its code (or the refusal). */
export async function consentAction(_state: ActionState, form: FormData): Promise<ActionState> {
  const oauthQuery = text(form, "oauth_query")
  if (!oauthQuery) return { error: "This page was not opened by an authorization request." }
  const { ok, data } = await authPost("/oauth2/consent", { accept: text(form, "decision") === "accept", oauth_query: oauthQuery })
  // Answered after the signed request's ten minutes: the same authorization again, which asks once more.
  if (!ok && staleOAuthQuery(data)) {
    console.info(`[oauth] consent on a signed request ${ageOf(oauthQuery)} old, no longer valid`)
    if (!restartable(oauthQuery)) return { error: TOO_OLD_MESSAGE }
    const again = await authorizeAgain(restartAuthorization(oauthQuery, { signedIn: false }))
    if (again) redirect(again)
  }
  const url = nextUrl(data)
  if (!ok || !url) return { error: `The authorization can't continue (${String(data.error_description ?? data.message ?? "no redirect")}). Start again from the app that asked.` }
  console.info(`[oauth] consent → ${describeRedirect(url)}`)
  redirect(url)
}

const ageOf = (oauthQuery: string) => {
  const age = signedAgeMs(oauthQuery)
  return age === null ? "of unknown age" : `${Math.round(age / 1000)} s`
}

export async function signOutAction(): Promise<void> {
  await (await getAuth()).api.signOut({ headers: await headers() })
  redirect("/sign-in")
}

export async function registerMovementAction(_state: ActionState, form: FormData): Promise<ActionState> {
  const viewer = await requirePermission("stock.move")
  const kind = text(form, "kind") as MovementKind
  if (!MOVEMENT_KINDS.includes(kind)) return { error: "Choose in, out or adjustment.", values: typed(form) }
  const quantity = Number(text(form, "quantity"))
  try {
    const { movement, stock } = await registerMovement(viewer.orgId, { id: viewer.userId }, { productId: text(form, "productId"), kind, quantity, note: text(form, "note") || undefined })
    revalidatePath("/", "layout")
    return { ok: `Registered ${movement.summary}. Now ${stock} in stock.` }
  } catch (error) {
    return refusal(error, form)
  }
}

export async function confirmOrderAction(_state: ActionState, form: FormData): Promise<ActionState> {
  const viewer = await requirePermission("orders.manage")
  try {
    const order = await confirmOrder(viewer.orgId, { id: viewer.userId }, text(form, "orderId"))
    revalidatePath("/", "layout")
    return { ok: `Order ${order.number} confirmed: the goods left the warehouse.` }
  } catch (error) {
    return refusal(error, form)
  }
}

export async function cancelOrderAction(_state: ActionState, form: FormData): Promise<ActionState> {
  const viewer = await requirePermission("orders.manage")
  try {
    const order = await cancelOrder(viewer.orgId, text(form, "orderId"))
    revalidatePath("/", "layout")
    return { ok: `Order ${order.number} cancelled.` }
  } catch (error) {
    return refusal(error, form)
  }
}
