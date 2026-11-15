// The CRM's own functions on the database: tenants, lists in SQL, provisioning.
import assert from "node:assert/strict"
import { test } from "node:test"

import { users } from "./setup"

import { and, eq } from "drizzle-orm"

import { companies, deals, tenants } from "../db/schema"
import { createDeal, CrmError, forgetProvisioned, getDeal, listContacts, listDeals, logCall, markWon, personNames, provisionWorkspace, setStage } from "../lib/crm"
import { db } from "../lib/db"
import { permissionsForRole } from "../lib/permissions"

const ORBITA = "org_orbita"
const KESTREL = "org_kestrel"

test("each organization sees its own records only", async () => {
  const orbita = await listDeals(ORBITA, { limit: 50 })
  const kestrel = await listDeals(KESTREL, { limit: 50 })
  assert.equal(orbita.total, 5)
  assert.deepEqual(kestrel.rows.map((d) => d.name), ["Fiori Bakery — new brand"])
  // Same ids in both tenants, different records.
  assert.equal((await getDeal(ORBITA, "d1"))!.name, "Officine Bianchi — 40 seats")
  assert.equal((await getDeal(KESTREL, "d1"))!.name, "Fiori Bakery — new brand")
  // A change in one never reaches the other.
  await setStage(KESTREL, "d1", "lost")
  assert.equal((await getDeal(ORBITA, "d1"))!.stage, "proposal")
  await assert.rejects(createDeal(KESTREL, { id: users.elena }, { name: "Cross-tenant", company: "co2", value: 1, closeDate: "2027-01-01" }), (e) => e instanceof CrmError && e.code === "unknown_company")
  await assert.rejects(logCall(KESTREL, "ct2", { personId: users.elena, note: "Not ours" }), (e) => e instanceof CrmError && e.code === "not_found")
})

test("lists filter, search, sort and page in SQL", async () => {
  const proposal = await listDeals(ORBITA, { filters: { stage: "proposal" }, limit: 50 })
  assert.deepEqual(proposal.rows.map((d) => d.id), ["d1"])
  const open = await listDeals(ORBITA, { filters: { stage: { in: ["lead", "qualified", "proposal"] } }, sort: { field: "value", dir: "desc" }, limit: 50 })
  assert.deepEqual(open.rows.map((d) => d.value), [18000, 12500, 6000])
  const range = await listDeals(ORBITA, { filters: { closeDate: { gte: "2026-11-01", lte: "2026-12-31" } }, sort: { field: "closeDate", dir: "asc" }, limit: 50 })
  assert.deepEqual(range.rows.map((d) => d.id), ["d1", "d2"])
  // Text only in the fields asked for, case-insensitive; LIKE's wildcards are plain text.
  assert.deepEqual((await listDeals(ORBITA, { text: "VERDI", textFields: ["name"], limit: 50 })).rows.map((d) => d.id), ["d2", "d5"])
  assert.equal((await listDeals(ORBITA, { text: "verdi", textFields: [], limit: 50 })).total, 0)
  assert.equal((await listDeals(ORBITA, { text: "%", textFields: ["name"], limit: 50 })).total, 0)
  assert.deepEqual((await listContacts(ORBITA, { text: "pixellab", textFields: ["email"], limit: 50 })).rows.map((c) => c.id), ["ct4"])
  // Pages: the cursor carries on where the last page stopped, the total stays.
  const first = await listDeals(ORBITA, { sort: { field: "value", dir: "asc" }, limit: 2 })
  assert.deepEqual([first.rows.map((d) => d.value), first.total, first.next], [[4200, 6000], 5, "2"])
  const second = await listDeals(ORBITA, { sort: { field: "value", dir: "asc" }, cursor: first.next!, limit: 2 })
  assert.deepEqual(second.rows.map((d) => d.value), [9000, 12500])
  const last = await listDeals(ORBITA, { sort: { field: "value", dir: "asc" }, cursor: second.next!, limit: 2 })
  assert.deepEqual([last.rows.map((d) => d.value), last.next], [[18000], undefined])
  // Without a sort: the order the records were made in.
  assert.deepEqual((await listDeals(ORBITA, { limit: 50 })).rows.map((d) => d.id), ["d1", "d2", "d3", "d4", "d5"])
  // Optional fields are left out, not null.
  const contacts = (await listContacts(ORBITA, { limit: 50 })).rows
  assert.deepEqual(contacts.find((c) => c.id === "ct2"), { id: "ct2", name: "Marco Verdi", email: "marco@verdi-retail.example", company: "co2" })
  await assert.rejects(listDeals(ORBITA, { filters: { secret: 1 }, limit: 5 }), (e) => e instanceof CrmError && e.code === "invalid")
  await assert.rejects(listDeals(ORBITA, { cursor: "-1", limit: 5 }), (e) => e instanceof CrmError && e.code === "invalid")
})

test("closed deals stay closed; a call updates the contact and its history", async () => {
  const deal = await createDeal(ORBITA, { id: users.bruno }, { name: "Studio Neri — workshop", company: "co3", value: 1500, closeDate: "2027-02-10" })
  assert.equal(deal.stage, "lead")
  const won = await markWon(ORBITA, deal.id, { note: "Signed today" })
  assert.equal(won.stage, "won")
  assert.equal((await getDeal(ORBITA, deal.id))!.wonNote, "Signed today")
  await assert.rejects(markWon(ORBITA, deal.id), (e) => e instanceof CrmError && e.code === "closed")
  await assert.rejects(setStage(ORBITA, deal.id, "lead"), (e) => e instanceof CrmError && e.code === "closed")
  const contact = await logCall(ORBITA, "ct2", { personId: users.bruno, note: "Interested in the pilot" })
  assert.equal(contact.lastNote, "Interested in the pilot")
  assert.equal(contact.lastCall, new Date().toISOString().slice(0, 10))
})

test("a workspace installation gets its own copy of the demo data, once, even when called at the same time", async () => {
  const installation = "acme-node@https://node.example"
  await Promise.all([provisionWorkspace(installation), provisionWorkspace(installation), provisionWorkspace(installation)])
  forgetProvisioned()
  await provisionWorkspace(installation)
  const all = await listDeals(installation, { limit: 50 })
  assert.equal(all.total, 5)
  assert.equal(all.rows.find((d) => d.id === "d1")!.owner, "ada")
  const [tenant] = await db().select().from(tenants).where(eq(tenants.id, installation))
  assert.equal(tenant!.kind, "workspace")
  // Its own copy: a change there is not the organization's.
  await markWon(installation, "d1")
  assert.equal((await getDeal(ORBITA, "d1"))!.stage, "proposal")
  assert.deepEqual(await personNames(installation, ["ada", "bruno", "nobody"]), { ada: "Ada Rossi", bruno: "Bruno Neri" })
  const [co] = await db().select().from(companies).where(and(eq(companies.orgId, installation), eq(companies.id, "co1")))
  assert.equal(co!.name, "Officine Bianchi")
  // An organization id is never provisioned this way.
  await assert.rejects(provisionWorkspace("org_new"))
})

test("people are named from the organization's members only", async () => {
  assert.deepEqual(await personNames(ORBITA, [users.ada, users.bruno, users.elena]), { [users.ada]: "Ada Rossi", [users.bruno]: "Bruno Neri" })
  assert.deepEqual(await personNames(KESTREL, [users.ada, users.elena]), { [users.elena]: "Elena Conti" })
  const owners = new Set((await db().select({ owner: deals.ownerId }).from(deals).where(eq(deals.orgId, ORBITA))).map((r) => r.owner))
  assert.ok(owners.has(users.ada) && owners.has(users.bruno))
})

test("roles map to permissions: admins and owners all, members no money", () => {
  assert.deepEqual(permissionsForRole("admin"), ["deals.view", "deals.edit", "deals.values", "contacts.edit"])
  assert.deepEqual(permissionsForRole("owner"), permissionsForRole("admin"))
  assert.deepEqual(permissionsForRole("member"), ["deals.view", "deals.edit", "contacts.edit"])
  assert.deepEqual(permissionsForRole("member,admin"), permissionsForRole("admin"))
  assert.deepEqual(permissionsForRole("guest"), [])
})
