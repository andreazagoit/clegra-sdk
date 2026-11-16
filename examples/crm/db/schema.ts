// The CRM's tables. Every row belongs to a tenant (`org_id`): a better-auth
// organization (its id), or an installation of a workspace host such as Clegra
// (`<installation>@<issuer>`, never an organization: those callers have no
// account here). `tenants` holds both kinds, so the data tables can point at it.
import { boolean, date, foreignKey, index, jsonb, numeric, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core"

export * from "./auth-schema"

export const STAGES = ["lead", "qualified", "proposal", "won", "lost"] as const
export const INDUSTRIES = ["manufacturing", "retail", "services", "software"] as const

export const tenants = pgTable("tenants", {
  id: text("id").primaryKey(),
  kind: text("kind", { enum: ["organization", "workspace"] }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
})

export const companies = pgTable(
  "companies",
  {
    orgId: text("org_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    name: text("name").notNull(),
    city: text("city").notNull(),
    industry: text("industry", { enum: INDUSTRIES }).notNull(),
    // The company's VAT number (country prefix and number, no spaces) and website: what other apps can match it by.
    vatId: text("vat_id"),
    website: text("website"),
    // The same company's record in another app of the workspace (e.g. the ERP's customer): its record URI, nothing else of it.
    erpCustomer: text("erp_customer"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.id] }), index("companies_org_name_idx").on(t.orgId, t.name)],
)

export const contacts = pgTable(
  "contacts",
  {
    orgId: text("org_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    companyId: text("company_id").notNull(),
    // The latest call, kept with the contact so lists filter and sort on it (history in `calls`).
    lastCallOn: date("last_call_on", { mode: "string" }),
    lastNote: text("last_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.id] }),
    foreignKey({ columns: [t.orgId, t.companyId], foreignColumns: [companies.orgId, companies.id] }).onDelete("cascade"),
    index("contacts_org_company_idx").on(t.orgId, t.companyId),
  ],
)

export const deals = pgTable(
  "deals",
  {
    orgId: text("org_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    name: text("name").notNull(),
    companyId: text("company_id").notNull(),
    stage: text("stage", { enum: STAGES }).notNull(),
    value: numeric("value", { precision: 12, scale: 2, mode: "number" }).notNull(),
    closeDate: date("close_date", { mode: "string" }).notNull(),
    // A better-auth user id, or a workspace host's person id (named in `people`).
    ownerId: text("owner_id").notNull(),
    wonNote: text("won_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.id] }),
    foreignKey({ columns: [t.orgId, t.companyId], foreignColumns: [companies.orgId, companies.id] }).onDelete("cascade"),
    index("deals_org_stage_idx").on(t.orgId, t.stage),
    index("deals_org_close_date_idx").on(t.orgId, t.closeDate),
  ],
)

export const calls = pgTable(
  "calls",
  {
    orgId: text("org_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    contactId: text("contact_id").notNull(),
    personId: text("person_id").notNull(),
    note: text("note"),
    calledOn: date("called_on", { mode: "string" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.id] }),
    foreignKey({ columns: [t.orgId, t.contactId], foreignColumns: [contacts.orgId, contacts.id] }).onDelete("cascade"),
    index("calls_org_contact_idx").on(t.orgId, t.contactId),
  ],
)

/** Names of people a workspace host signed in (better-auth users are named from `user`). */
export const people = pgTable(
  "people",
  {
    orgId: text("org_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    name: text("name").notNull(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.id] })],
)

/** The Clegra app server's idempotency store: the table of `SqlStore.schema()` (clegra). */
export const clegraStore = pgTable(
  "clegra_store",
  {
    key: text("key").primaryKey(),
    args: text("args").notNull(),
    result: jsonb("result"),
    done: boolean("done").default(false).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("clegra_store_expires_at").on(t.expiresAt)],
)
