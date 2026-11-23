"use server"
// The pages' changes. Each one checks the session and the permission itself (a server action is a
// public POST endpoint), then calls the same function the app's actions call (lib/crm.ts).
import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { revalidatePath } from "next/cache"

import { auth } from "@/lib/auth"
import { createDeal, CrmError, logCall, markWon, setStage, type Stage } from "@/lib/crm"
import { STAGE_LABELS } from "@/lib/format"
import { ownerOf, requirePermission } from "@/lib/session"

const MOVABLE = ["lead", "qualified", "proposal", "lost"] as const satisfies readonly Exclude<Stage, "won">[]

const text = (form: FormData, name: string) => {
  const v = form.get(name)
  return typeof v === "string" ? v.trim() : ""
}

/** Back to a page of this app, never elsewhere. */
const back = (form: FormData, fallback: string) => {
  const to = text(form, "returnTo")
  return to.startsWith("/") && !to.startsWith("//") ? to : fallback
}

const withMessage = (path: string, key: "notice" | "error", message: string) => `${path}${path.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(message)}`

const reason = (error: unknown): string => {
  if (!(error instanceof CrmError)) throw error
  if (error.code === "closed") return "This deal is closed: it can't change any more."
  if (error.code === "not_found") return "That record doesn't exist (any more)."
  if (error.code === "unknown_company") return "Pick a company of this organization."
  return error.message
}

export async function setStageAction(dealId: string, form: FormData) {
  const member = await requirePermission("deals.edit")
  const stage = text(form, "stage") as (typeof MOVABLE)[number]
  const to = back(form, `/deals/${dealId}`)
  if (!MOVABLE.includes(stage)) redirect(withMessage(to, "error", "Pick a stage."))
  let message: string
  try {
    const deal = await setStage(member.orgId, dealId, stage)
    message = `${deal.name}: now ${STAGE_LABELS[stage]}.`
  } catch (error) {
    redirect(withMessage(to, "error", reason(error)))
  }
  revalidatePath("/", "layout")
  redirect(withMessage(to, "notice", message))
}

export async function markWonAction(dealId: string, form: FormData) {
  const member = await requirePermission("deals.edit")
  const to = back(form, `/deals/${dealId}`)
  const note = text(form, "note").slice(0, 500)
  let message: string
  try {
    const deal = await markWon(member.orgId, dealId, note ? { note } : {})
    message = `${deal.name} marked as won.`
  } catch (error) {
    redirect(withMessage(to, "error", reason(error)))
  }
  revalidatePath("/", "layout")
  redirect(withMessage(to, "notice", message))
}

export async function logCallAction(contactId: string, form: FormData) {
  const member = await requirePermission("contacts.edit")
  const to = back(form, "/contacts")
  const note = text(form, "note").slice(0, 500)
  if (!note) redirect(withMessage(to, "error", "Write a short note about the call."))
  let message: string
  try {
    const contact = await logCall(member.orgId, contactId, { personId: member.user.id, note })
    message = `Call with ${contact.name} logged.`
  } catch (error) {
    redirect(withMessage(to, "error", reason(error)))
  }
  revalidatePath("/", "layout")
  redirect(withMessage(to, "notice", message))
}

export async function createDealAction(form: FormData) {
  const member = await requirePermission("deals.edit")
  const name = text(form, "name")
  const company = text(form, "company")
  const value = Number(text(form, "value"))
  const closeDate = text(form, "closeDate")
  if (name.length < 2 || name.length > 120) redirect(withMessage("/deals", "error", "A deal needs a name (2–120 characters)."))
  if (!Number.isFinite(value) || value < 0) redirect(withMessage("/deals", "error", "The value must be a positive number."))
  if (!/^\d{4}-\d{2}-\d{2}$/.test(closeDate) || Number.isNaN(Date.parse(closeDate))) redirect(withMessage("/deals", "error", "Pick a close date."))
  let id: string
  try {
    id = (await createDeal(member.orgId, ownerOf(member), { name, company, value, closeDate })).id
  } catch (error) {
    redirect(withMessage("/deals", "error", reason(error)))
  }
  revalidatePath("/", "layout")
  redirect(withMessage(`/deals/${id}`, "notice", `Deal «${name}» created.`))
}

export async function signOutAction() {
  await auth().api.signOut({ headers: await headers() })
  redirect("/sign-in")
}
