// The CRM's own functions on the database: tenants, lists in SQL, provisioning.
import assert from "node:assert/strict"
import { test } from "node:test"

import { users } from "./setup"

import { and, eq } from "drizzle-orm"

import { companies, deals, tenants } from "../db/schema"
import { createDeal, CrmError, getDeal, listContacts, listDeals, logCall, markWon, personNames, setStage } from "../lib/crm"
import { db } from "../lib/db"
import { permissionsForRole } from "../lib/permissions"

const ORBIT = "org_orbit"
const KESTREL = "org_kestrel"

test("each organization sees its own records only", async () => {
  const orbit = await listDeals(ORBIT, { limit: 50 })
  const kestrel = await listDeals(KESTREL, { limit: 50 })
  assert.equal(orbit.total, 5)
  assert.deepEqual(kestrel.rows.map((d) => d.name), ["Rosewood Bakery — new brand"])
  // Same ids in both tenants, different records.
  assert.equal((await getDeal(ORBIT, "d1"))!.name, "Hartley Engineering — 40 seats")
  assert.equal((await getDeal(KESTREL, "d1"))!.name, "Rosewood Bakery — new brand")
  // A change in one never reaches the other.
  await setStage(KESTREL, "d1", "lost")
  assert.equal((await getDeal(ORBIT, "d1"))!.stage, "proposal")
  await assert.rejects(createDeal(KESTREL, { id: users.emma }, { name: "Cross-tenant", company: "co2", value: 1, closeDate: "2027-01-01" }), (e) => e instanceof CrmError && e.code === "unknown_company")
  await assert.rejects(logCall(KESTREL, "ct2", { personId: users.emma, note: "Not ours" }), (e) => e instanceof CrmError && e.code === "not_found")
})

test("lists filter, search, sort and page in SQL", async () => {
  const proposal = await listDeals(ORBIT, { filters: { stage: "proposal" }, limit: 50 })
  assert.deepEqual(proposal.rows.map((d) => d.id), ["d1"])
  const open = await listDeals(ORBIT, { filters: { stage: { in: ["lead", "qualified", "proposal"] } }, sort: { field: "value", dir: "desc" }, limit: 50 })
  assert.deepEqual(open.rows.map((d) => d.value), [18000, 12500, 6000])
  const range = await listDeals(ORBIT, { filters: { closeDate: { gte: "2026-11-01", lte: "2026-12-31" } }, sort: { field: "closeDate", dir: "asc" }, limit: 50 })
  assert.deepEqual(range.rows.map((d) => d.id), ["d1", "d2"])
  // Text only in the fields asked for, case-insensitive; LIKE's wildcards are plain text.
  assert.deepEqual((await listDeals(ORBIT, { text: "GREENFIELD", textFields: ["name"], limit: 50 })).rows.map((d) => d.id), ["d2", "d5"])
  assert.equal((await listDeals(ORBIT, { text: "greenfield", textFields: [], limit: 50 })).total, 0)
  assert.equal((await listDeals(ORBIT, { text: "%", textFields: ["name"], limit: 50 })).total, 0)
  assert.deepEqual((await listContacts(ORBIT, { text: "pixellab", textFields: ["email"], limit: 50 })).rows.map((c) => c.id), ["ct4"])
  // Pages: the cursor carries on where the last page stopped, the total stays.
  const first = await listDeals(ORBIT, { sort: { field: "value", dir: "asc" }, limit: 2 })
  assert.deepEqual([first.rows.map((d) => d.value), first.total, first.next], [[4200, 6000], 5, "2"])
  const second = await listDeals(ORBIT, { sort: { field: "value", dir: "asc" }, cursor: first.next!, limit: 2 })
  assert.deepEqual(second.rows.map((d) => d.value), [9000, 12500])
  const last = await listDeals(ORBIT, { sort: { field: "value", dir: "asc" }, cursor: second.next!, limit: 2 })
  assert.deepEqual([last.rows.map((d) => d.value), last.next], [[18000], undefined])
  // Without a sort: the order the records were made in.
  assert.deepEqual((await listDeals(ORBIT, { limit: 50 })).rows.map((d) => d.id), ["d1", "d2", "d3", "d4", "d5"])
  // Optional fields are left out, not null.
  const contacts = (await listContacts(ORBIT, { limit: 50 })).rows
  assert.deepEqual(contacts.find((c) => c.id === "ct2"), { id: "ct2", name: "Mark Green", email: "mark@greenfield-retail.example", company: "co2" })
  await assert.rejects(listDeals(ORBIT, { filters: { secret: 1 }, limit: 5 }), (e) => e instanceof CrmError && e.code === "invalid")
  await assert.rejects(listDeals(ORBIT, { cursor: "-1", limit: 5 }), (e) => e instanceof CrmError && e.code === "invalid")
})

test("closed deals stay closed; a call updates the contact and its history", async () => {
  const deal = await createDeal(ORBIT, { id: users.ben }, { name: "Lane Studio — workshop", company: "co3", value: 1500, closeDate: "2027-02-10" })
  assert.equal(deal.stage, "lead")
  const won = await markWon(ORBIT, deal.id, { note: "Signed today" })
  assert.equal(won.stage, "won")
  assert.equal((await getDeal(ORBIT, deal.id))!.wonNote, "Signed today")
  await assert.rejects(markWon(ORBIT, deal.id), (e) => e instanceof CrmError && e.code === "closed")
  await assert.rejects(setStage(ORBIT, deal.id, "lead"), (e) => e instanceof CrmError && e.code === "closed")
  const contact = await logCall(ORBIT, "ct2", { personId: users.ben, note: "Interested in the pilot" })
  assert.equal(contact.lastNote, "Interested in the pilot")
  assert.equal(contact.lastCall, new Date().toISOString().slice(0, 10))
})

test("people are named from the organization's members only", async () => {
  assert.deepEqual(await personNames(ORBIT, [users.alice, users.ben, users.emma]), { [users.alice]: "Alice Morgan", [users.ben]: "Ben Carter" })
  assert.deepEqual(await personNames(KESTREL, [users.alice, users.emma]), { [users.emma]: "Emma Hayes" })
  const owners = new Set((await db().select({ owner: deals.ownerId }).from(deals).where(eq(deals.orgId, ORBIT))).map((r) => r.owner))
  assert.ok(owners.has(users.alice) && owners.has(users.ben))
})

test("roles map to permissions: admins and owners all, members no money", () => {
  assert.deepEqual(permissionsForRole("admin"), ["deals.view", "deals.edit", "deals.values", "contacts.edit"])
  assert.deepEqual(permissionsForRole("owner"), permissionsForRole("admin"))
  assert.deepEqual(permissionsForRole("member"), ["deals.view", "deals.edit", "contacts.edit"])
  assert.deepEqual(permissionsForRole("member,admin"), permissionsForRole("admin"))
  assert.deepEqual(permissionsForRole("guest"), [])
})
