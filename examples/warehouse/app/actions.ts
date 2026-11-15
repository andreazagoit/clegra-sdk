"use server"

import { isAPIError } from "better-auth/api"
import { revalidatePath } from "next/cache"
import { headers } from "next/headers"
import { redirect } from "next/navigation"

import type { ActionState } from "@/components/action-form"
import { getAuth } from "@/lib/auth"
import { DEMO_USERS, demoPassword } from "@/lib/demo"
import { requirePermission } from "@/lib/session"
import { cancelOrder, confirmOrder, MOVEMENT_KINDS, registerMovement, WarehouseError, type MovementKind } from "@/lib/warehouse"

// Every server action checks the session and the permission itself: they are reachable by a plain POST.

const text = (form: FormData, key: string) => {
  const v = form.get(key)
  return typeof v === "string" ? v.trim() : ""
}

/** A refusal the person can act on, as the form's message; anything else is a bug and stays an error. */
function refusal(error: unknown): ActionState {
  if (error instanceof WarehouseError) return { error: error.message }
  throw error
}

export async function signInAction(_state: ActionState, form: FormData): Promise<ActionState> {
  const email = text(form, "email").toLowerCase()
  const password = typeof form.get("password") === "string" ? (form.get("password") as string) : ""
  if (!email || !password) return { error: "Give your email and password." }
  try {
    await (await getAuth()).api.signInEmail({ body: { email, password }, headers: await headers() })
  } catch (error) {
    if (isAPIError(error)) return { error: "Wrong email or password." }
    throw error
  }
  redirect("/")
}

/** One-click sign-in as a seeded demo person (DEMO_SIGNIN=1 only): the password never leaves the server. */
export async function demoSignInAction(_state: ActionState, form: FormData): Promise<ActionState> {
  if (process.env.DEMO_SIGNIN !== "1") return { error: "Demo sign-in is off." }
  const user = DEMO_USERS.find((u) => u.email === text(form, "email"))
  if (!user) return { error: "Not a demo person." }
  try {
    await (await getAuth()).api.signInEmail({ body: { email: user.email, password: demoPassword() }, headers: await headers() })
  } catch (error) {
    if (isAPIError(error)) return { error: "The demo people are not seeded with this DEMO_PASSWORD: run `npm run db:seed`." }
    throw error
  }
  redirect("/")
}

export async function signOutAction(): Promise<void> {
  await (await getAuth()).api.signOut({ headers: await headers() })
  redirect("/sign-in")
}

export async function registerMovementAction(_state: ActionState, form: FormData): Promise<ActionState> {
  const viewer = await requirePermission("stock.move")
  const kind = text(form, "kind") as MovementKind
  if (!MOVEMENT_KINDS.includes(kind)) return { error: "Choose in, out or adjustment." }
  const quantity = Number(text(form, "quantity"))
  try {
    const { movement, stock } = await registerMovement(viewer.orgId, viewer.userId, { productId: text(form, "productId"), kind, quantity, note: text(form, "note") || undefined })
    revalidatePath("/", "layout")
    return { ok: `Registered ${movement.summary}. Now ${stock} in stock.` }
  } catch (error) {
    return refusal(error)
  }
}

export async function confirmOrderAction(_state: ActionState, form: FormData): Promise<ActionState> {
  const viewer = await requirePermission("orders.manage")
  try {
    const order = await confirmOrder(viewer.orgId, viewer.userId, text(form, "orderId"))
    revalidatePath("/", "layout")
    return { ok: `Order ${order.number} confirmed: the goods left the warehouse.` }
  } catch (error) {
    return refusal(error)
  }
}

export async function cancelOrderAction(_state: ActionState, form: FormData): Promise<ActionState> {
  const viewer = await requirePermission("orders.manage")
  try {
    const order = await cancelOrder(viewer.orgId, text(form, "orderId"))
    revalidatePath("/", "layout")
    return { ok: `Order ${order.number} cancelled.` }
  } catch (error) {
    return refusal(error)
  }
}
