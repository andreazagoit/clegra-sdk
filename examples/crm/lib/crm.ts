// The CRM's own functions: what the pages and server actions call, and what
// the app handlers (clegra/app.ts) call too. Every function takes the tenant
// (`orgId`) first and touches that tenant's rows only.
import { randomUUID } from "node:crypto"

import { and, asc, count, desc, eq, gte, ilike, inArray, lte, notInArray, or, sql, type SQL } from "drizzle-orm"
import type { PgColumn } from "drizzle-orm/pg-core"

import { calls, companies, contacts, deals, INDUSTRIES, member, people, STAGES, tenants, user } from "@/db/schema"

import { db, type Tx } from "./db"
import { OWNER_NAMES, SALES_TEAM_DATA, type DemoData, type OwnerKey } from "./demo-data"

export { INDUSTRIES, STAGES }
export type Stage = (typeof STAGES)[number]
export type Industry = (typeof INDUSTRIES)[number]
export const OPEN_STAGES = ["lead", "qualified", "proposal"] as const satisfies readonly Stage[]

export type Company = { id: string; name: string; city: string; industry: Industry; vatId?: string; website?: string; erpCustomer?: string }
export type Contact = { id: string; name: string; email: string; company: string; lastCall?: string; lastNote?: string }
export type Deal = { id: string; name: string; company: string; stage: Stage; value: number; closeDate: string; owner: string; wonNote?: string }
export type Call = { id: string; contact: string; person: string; note?: string; calledOn: string }

/** A refused change, with a reason the caller turns into words. */
export class CrmError extends Error {
  constructor(
    readonly code: "not_found" | "closed" | "unknown_company" | "invalid",
    message: string,
  ) {
    super(message)
    this.name = "CrmError"
  }
}

const today = () => new Date().toISOString().slice(0, 10)
const newId = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`
const isClosed = (stage: Stage) => stage === "won" || stage === "lost"

// ------------------------------------------------------------------ lists

export type FilterValue = string | number | boolean
export type ListFilter = FilterValue | { in: FilterValue[] } | { gte?: FilterValue; lte?: FilterValue }

/** A list request: filters by field, text in `textFields`, sort, an opaque cursor, a page size. */
export type ListQuery = {
  filters?: Record<string, ListFilter>
  text?: string
  textFields?: string[]
  sort?: { field: string; dir: "asc" | "desc" }
  cursor?: string
  limit: number
}
export type ListPage<Row> = { rows: Row[]; total: number; next?: string }

/** `keys`: fields compared on a normalised value (kinds' keys: an email without regard to case), as SQL over the column. The filter value arrives normalised. */
type ListSpec = { orgId: PgColumn; id: PgColumn; order: PgColumn; fields: Record<string, PgColumn>; keys?: Record<string, SQL> }

const escapeLike = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`)

function columnOf(spec: ListSpec, field: string): PgColumn {
  const column = spec.fields[field]
  if (!column) throw new CrmError("invalid", `Unknown field "${field}"`)
  return column
}

/** Filters, text search, sort and paging, all in SQL. The cursor is the offset of the next page. */
function listParts(spec: ListSpec, orgId: string, q: ListQuery) {
  const where: SQL[] = [eq(spec.orgId, orgId)]
  for (const [field, f] of Object.entries(q.filters ?? {})) {
    const column = columnOf(spec, field)
    const key = spec.keys?.[field]
    if (key) {
      // A key: a value or a set of values (the SDK refuses ranges), compared on the normalised column.
      if (f !== null && typeof f === "object" && "in" in f) where.push(f.in.length ? inArray(key, f.in) : sql`false`)
      else if (f === null || typeof f !== "object") where.push(eq(key, f))
      else throw new CrmError("invalid", `"${field}" is matched exactly`)
    } else if (f !== null && typeof f === "object" && "in" in f) where.push(f.in.length ? inArray(column, f.in) : sql`false`)
    else if (f !== null && typeof f === "object") {
      if (f.gte !== undefined) where.push(gte(column, f.gte))
      if (f.lte !== undefined) where.push(lte(column, f.lte))
    } else where.push(eq(column, f))
  }
  if (q.text?.trim()) {
    // Only the fields the caller may search: a field they can't see must not answer.
    const pattern = `%${escapeLike(q.text.trim())}%`
    const fields = (q.textFields ?? []).map((f) => ilike(columnOf(spec, f), pattern))
    where.push(fields.length ? or(...fields)! : sql`false`)
  }
  const order = q.sort
    ? [q.sort.dir === "desc" ? sql`${columnOf(spec, q.sort.field)} desc nulls last` : sql`${columnOf(spec, q.sort.field)} asc nulls last`, asc(spec.id)]
    : [asc(spec.order), asc(spec.id)]
  const offset = q.cursor === undefined ? 0 : Number(q.cursor)
  if (!Number.isSafeInteger(offset) || offset < 0) throw new CrmError("invalid", "Invalid cursor")
  const limit = Math.max(1, Math.min(200, Math.trunc(q.limit)))
  return { where: and(...where)!, order, offset, limit }
}

const page = <Row>(rows: Row[], total: number, offset: number, limit: number): ListPage<Row> => ({
  rows,
  total,
  ...(offset + limit < total ? { next: String(offset + limit) } : {}),
})

// ------------------------------------------------------------------ companies

const companyFields = { id: companies.id, name: companies.name, city: companies.city, industry: companies.industry, vatId: companies.vatId, website: companies.website, erpCustomer: companies.erpCustomer }
// A VAT number is matched upper-cased and without spaces, whatever was typed in.
const companySpec: ListSpec = { orgId: companies.orgId, id: companies.id, order: companies.createdAt, fields: companyFields, keys: { vatId: sql`upper(replace(${companies.vatId}, ' ', ''))` } }
type CompanyRow = { id: string; name: string; city: string; industry: Industry; vatId: string | null; website: string | null; erpCustomer: string | null }
const toCompany = ({ vatId, website, erpCustomer, ...rest }: CompanyRow): Company => ({ ...rest, ...(vatId ? { vatId } : {}), ...(website ? { website } : {}), ...(erpCustomer ? { erpCustomer } : {}) })

export async function listCompanies(orgId: string, q: ListQuery): Promise<ListPage<Company>> {
  const { where, order, offset, limit } = listParts(companySpec, orgId, q)
  const [rows, [total]] = await Promise.all([
    db().select(companyFields).from(companies).where(where).orderBy(...order).limit(limit).offset(offset),
    db().select({ n: count() }).from(companies).where(where),
  ])
  return page(rows.map(toCompany), total?.n ?? 0, offset, limit)
}

export async function getCompany(orgId: string, id: string): Promise<Company | null> {
  const [row] = await db().select(companyFields).from(companies).where(and(eq(companies.orgId, orgId), eq(companies.id, id)))
  return row ? toCompany(row) : null
}

/**
 * Links a company to its record in another app (a record URI, e.g. `clegra://erp/customer/1001`), or unlinks it
 * (null). Only the URI is kept: the other app's data stay there, read live by whoever may see them.
 */
export async function setErpCustomer(orgId: string, id: string, uri: string | null): Promise<Company> {
  const [row] = await db().update(companies).set({ erpCustomer: uri }).where(and(eq(companies.orgId, orgId), eq(companies.id, id))).returning(companyFields)
  if (!row) throw new CrmError("not_found", `No company ${id}`)
  return toCompany(row)
}

/** Company names by id, for showing references. */
export async function companyNames(orgId: string, ids: string[]): Promise<Record<string, string>> {
  if (!ids.length) return {}
  const rows = await db().select({ id: companies.id, name: companies.name }).from(companies).where(and(eq(companies.orgId, orgId), inArray(companies.id, ids)))
  return Object.fromEntries(rows.map((r) => [r.id, r.name]))
}

// ------------------------------------------------------------------ contacts

const contactFields = { id: contacts.id, name: contacts.name, email: contacts.email, company: contacts.companyId, lastCall: contacts.lastCallOn, lastNote: contacts.lastNote }
// An email is matched without regard to case.
const contactSpec: ListSpec = { orgId: contacts.orgId, id: contacts.id, order: contacts.createdAt, fields: contactFields, keys: { email: sql`lower(${contacts.email})` } }
type ContactRow = { id: string; name: string; email: string; company: string; lastCall: string | null; lastNote: string | null }
const toContact = ({ lastCall, lastNote, ...rest }: ContactRow): Contact => ({ ...rest, ...(lastCall ? { lastCall } : {}), ...(lastNote ? { lastNote } : {}) })

export async function listContacts(orgId: string, q: ListQuery): Promise<ListPage<Contact>> {
  const { where, order, offset, limit } = listParts(contactSpec, orgId, q)
  const [rows, [total]] = await Promise.all([
    db().select(contactFields).from(contacts).where(where).orderBy(...order).limit(limit).offset(offset),
    db().select({ n: count() }).from(contacts).where(where),
  ])
  return page(rows.map(toContact), total?.n ?? 0, offset, limit)
}

export async function getContact(orgId: string, id: string): Promise<Contact | null> {
  const [row] = await db().select(contactFields).from(contacts).where(and(eq(contacts.orgId, orgId), eq(contacts.id, id)))
  return row ? toContact(row) : null
}

/** Records a call with a contact today, by `personId`: the call's history and the contact's latest call, in one step. */
export async function logCall(orgId: string, contactId: string, input: { personId: string; note: string }): Promise<Contact> {
  const note = input.note.trim()
  if (!note) throw new CrmError("invalid", "A call needs a note")
  return db().transaction(async (tx) => {
    const calledOn = today()
    const [row] = await tx
      .update(contacts)
      .set({ lastCallOn: calledOn, lastNote: note })
      .where(and(eq(contacts.orgId, orgId), eq(contacts.id, contactId)))
      .returning(contactFields)
    if (!row) throw new CrmError("not_found", `No contact ${contactId}`)
    await tx.insert(calls).values({ orgId, id: newId("call"), contactId, personId: input.personId, note, calledOn })
    return toContact(row)
  })
}

export async function callsWith(orgId: string, contactIds: string[], limit = 20): Promise<Call[]> {
  if (!contactIds.length) return []
  const rows = await db()
    .select({ id: calls.id, contact: calls.contactId, person: calls.personId, note: calls.note, calledOn: calls.calledOn })
    .from(calls)
    .where(and(eq(calls.orgId, orgId), inArray(calls.contactId, contactIds)))
    .orderBy(desc(calls.calledOn), desc(calls.createdAt))
    .limit(limit)
  return rows.map(({ note, ...rest }) => ({ ...rest, ...(note ? { note } : {}) }))
}

// ------------------------------------------------------------------ deals

const dealFields = { id: deals.id, name: deals.name, company: deals.companyId, stage: deals.stage, value: deals.value, closeDate: deals.closeDate, owner: deals.ownerId }
const dealSpec: ListSpec = { orgId: deals.orgId, id: deals.id, order: deals.createdAt, fields: dealFields }

export async function listDeals(orgId: string, q: ListQuery): Promise<ListPage<Deal>> {
  const { where, order, offset, limit } = listParts(dealSpec, orgId, q)
  const [rows, [total]] = await Promise.all([
    db().select(dealFields).from(deals).where(where).orderBy(...order).limit(limit).offset(offset),
    db().select({ n: count() }).from(deals).where(where),
  ])
  return page(rows, total?.n ?? 0, offset, limit)
}

export async function getDeal(orgId: string, id: string): Promise<Deal | null> {
  const [row] = await db()
    .select({ ...dealFields, wonNote: deals.wonNote })
    .from(deals)
    .where(and(eq(deals.orgId, orgId), eq(deals.id, id)))
  if (!row) return null
  const { wonNote, ...deal } = row
  return { ...deal, ...(wonNote ? { wonNote } : {}) }
}

/** The deal, locked for this transaction: a change reads and writes the same version. */
async function lockedDeal(tx: Tx, orgId: string, id: string): Promise<Deal> {
  const [row] = await tx.select(dealFields).from(deals).where(and(eq(deals.orgId, orgId), eq(deals.id, id))).for("update")
  if (!row) throw new CrmError("not_found", `No deal ${id}`)
  return row
}

/** Moves an open deal to another open stage, or to lost. */
export async function setStage(orgId: string, dealId: string, stage: Exclude<Stage, "won">): Promise<Deal> {
  return db().transaction(async (tx) => {
    const deal = await lockedDeal(tx, orgId, dealId)
    if (isClosed(deal.stage)) throw new CrmError("closed", `${deal.name} is closed`)
    await tx.update(deals).set({ stage }).where(and(eq(deals.orgId, orgId), eq(deals.id, dealId)))
    return { ...deal, stage }
  })
}

/** Closes an open deal as won today. */
export async function markWon(orgId: string, dealId: string, input: { note?: string } = {}): Promise<Deal> {
  return db().transaction(async (tx) => {
    const deal = await lockedDeal(tx, orgId, dealId)
    if (isClosed(deal.stage)) throw new CrmError("closed", `${deal.name} is already closed`)
    const closeDate = today()
    const wonNote = input.note?.trim() || null
    await tx.update(deals).set({ stage: "won", closeDate, wonNote }).where(and(eq(deals.orgId, orgId), eq(deals.id, dealId)))
    return { ...deal, stage: "won", closeDate, ...(wonNote ? { wonNote } : {}) }
  })
}

/**
 * A new deal at the `lead` stage, owned by `owner`. `owner.name` is kept only when given: for people
 * a workspace host signed in, whom the CRM can't name from its own users.
 */
export async function createDeal(orgId: string, owner: { id: string; name?: string }, input: { name: string; company: string; value: number; closeDate: string }): Promise<Deal> {
  return db().transaction(async (tx) => {
    const [company] = await tx.select({ id: companies.id }).from(companies).where(and(eq(companies.orgId, orgId), eq(companies.id, input.company)))
    if (!company) throw new CrmError("unknown_company", `Unknown company ${input.company}`)
    const deal: Deal = { id: newId("d"), name: input.name.trim(), company: input.company, stage: "lead", value: input.value, closeDate: input.closeDate, owner: owner.id }
    await tx.insert(deals).values({ orgId, id: deal.id, name: deal.name, companyId: deal.company, stage: deal.stage, value: deal.value, closeDate: deal.closeDate, ownerId: deal.owner })
    if (owner.name) await tx.insert(people).values({ orgId, id: owner.id, name: owner.name }).onConflictDoUpdate({ target: [people.orgId, people.id], set: { name: owner.name } })
    return deal
  })
}

// ------------------------------------------------------------------ pipeline

export type StageSummary = { stage: Stage; count: number; value: number }

/** Deals and their value per stage, every stage present. */
export async function pipelineByStage(orgId: string): Promise<StageSummary[]> {
  const rows = await db()
    .select({ stage: deals.stage, count: count(), value: sql<string>`coalesce(sum(${deals.value}), 0)` })
    .from(deals)
    .where(eq(deals.orgId, orgId))
    .groupBy(deals.stage)
  return STAGES.map((stage) => {
    const row = rows.find((r) => r.stage === stage)
    return { stage, count: row?.count ?? 0, value: Number(row?.value ?? 0) }
  })
}

/** Open deals: how many, and their total value. */
export async function openPipeline(orgId: string): Promise<{ count: number; value: number }> {
  const [row] = await db()
    .select({ count: count(), value: sql<string>`coalesce(sum(${deals.value}), 0)` })
    .from(deals)
    .where(and(eq(deals.orgId, orgId), inArray(deals.stage, OPEN_STAGES)))
  return { count: row?.count ?? 0, value: Number(row?.value ?? 0) }
}

/** Open deals closing within `days` from today, soonest first. */
export async function closingSoon(orgId: string, days: number): Promise<Deal[]> {
  const until = new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)
  return db()
    .select(dealFields)
    .from(deals)
    .where(and(eq(deals.orgId, orgId), notInArray(deals.stage, ["won", "lost"]), lte(deals.closeDate, until)))
    .orderBy(asc(deals.closeDate), asc(deals.id))
}

/** Every deal of the tenant, by stage, for the board. */
export async function boardDeals(orgId: string): Promise<Deal[]> {
  return db().select(dealFields).from(deals).where(eq(deals.orgId, orgId)).orderBy(asc(deals.closeDate), asc(deals.id))
}

// ------------------------------------------------------------------ people

/** Names by person id: the organization's members (better-auth users), then people a workspace host signed in. */
export async function personNames(orgId: string, ids: string[]): Promise<Record<string, string>> {
  if (!ids.length) return {}
  const [members, others] = await Promise.all([
    db()
      .select({ id: user.id, name: user.name })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(and(eq(member.organizationId, orgId), inArray(user.id, ids))),
    db().select({ id: people.id, name: people.name }).from(people).where(and(eq(people.orgId, orgId), inArray(people.id, ids))),
  ])
  return Object.fromEntries([...others, ...members].map((p) => [p.id, p.name]))
}

// ------------------------------------------------------------------ tenants

/** A workspace host's installation (`<installation>@<issuer>`): never a better-auth organization id. */
export const isWorkspaceInstallation = (id: string) => id.includes("@")

/** A tenant's starting data, its owners mapped to person ids. Inside the transaction that creates the tenant. */
export async function insertTenantData(tx: Tx, orgId: string, data: DemoData, owners: Record<OwnerKey, string>) {
  // Rows in a stable order: lists without a sort show them as the data lists them.
  const at = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, i))
  if (data.companies.length) await tx.insert(companies).values(data.companies.map((c, i) => ({ orgId, ...c, createdAt: at(i) })))
  if (data.contacts.length)
    await tx.insert(contacts).values(data.contacts.map((c, i) => ({ orgId, id: c.id, name: c.name, email: c.email, companyId: c.company, lastCallOn: c.lastCall ?? null, lastNote: c.lastNote ?? null, createdAt: at(i) })))
  const called = data.contacts.filter((c) => c.lastCall)
  if (called.length) await tx.insert(calls).values(called.map((c) => ({ orgId, id: `call-${c.id}`, contactId: c.id, personId: owners.alice, note: c.lastNote ?? null, calledOn: c.lastCall! })))
  if (data.deals.length)
    await tx.insert(deals).values(data.deals.map((d, i) => ({ orgId, id: d.id, name: d.name, companyId: d.company, stage: d.stage, value: d.value, closeDate: d.closeDate, ownerId: owners[d.owner], createdAt: at(i) })))
}

const provisioned = new Set<string>()

/**
 * A workspace host's installation gets its own copy of the sales team's data the first time it calls:
 * one transaction, idempotent (a second caller finds the tenant and adds nothing).
 */
export async function provisionWorkspace(installation: string): Promise<void> {
  if (!isWorkspaceInstallation(installation)) throw new Error(`"${installation}" is not a workspace installation`)
  if (provisioned.has(installation)) return
  await db().transaction(async (tx) => {
    const created = await tx.insert(tenants).values({ id: installation, kind: "workspace" }).onConflictDoNothing().returning({ id: tenants.id })
    if (!created.length) return
    // The host's people are named by their ids there; the demo owners keep theirs.
    const owners = { alice: "alice", ben: "ben", emma: "emma" } satisfies Record<OwnerKey, string>
    await insertTenantData(tx, installation, SALES_TEAM_DATA, owners)
    await tx.insert(people).values(Object.entries(OWNER_NAMES).map(([id, name]) => ({ orgId: installation, id, name })))
  })
  provisioned.add(installation)
}

/** For tests: forget which installations were provisioned in this process. */
export function forgetProvisioned() {
  provisioned.clear()
}

