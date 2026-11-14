// The canonical v1 example (docs/mcp-workspaces/examples/crm.md): a small CRM
// with companies, contacts and deals, in memory, one copy of the data per
// installation. Invented data only.
import { McpWorkspacesServer, ref, WorkspaceError, type AuthOptions, type Context } from "@mcpw/server"
import { z } from "zod"

// ------------------------------------------------------------------ server

/** How the server accepts callers: dev sign-in locally, plus the issuers given by the environment (a Clegra node). */
export function authFromEnv(env: NodeJS.ProcessEnv = process.env): AuthOptions {
  const issuers = (env.MCPW_ISSUERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [issuer, jwksUri] = entry.split("|")
      return { issuer: issuer!, ...(jwksUri ? { jwksUri } : {}) }
    })
  return {
    issuers,
    ...(env.MCPW_RESOURCE ? { resource: env.MCPW_RESOURCE } : {}),
    ...(env.MCPW_DEV !== "0"
      ? {
          dev: {
            people: [
              { id: "ada", name: "Ada Rossi (sales manager)", permissions: "all" as const },
              { id: "bruno", name: "Bruno Neri (sales rep)", permissions: ["deals.view", "deals.edit", "contacts.edit"] },
            ],
            installation: "demo",
            ...(env.MCPW_DEV_CODE ? { code: env.MCPW_DEV_CODE } : {}),
          },
        }
      : {}),
  }
}

export const app = new McpWorkspacesServer({
  name: "crm",
  title: { en: "CRM", it: "CRM" },
  version: "1.0.0",
  description: { en: "Companies, contacts and deals of a small sales team.", it: "Aziende, contatti e trattative di un piccolo team commerciale." },
  locale: "en",
  instructions: "A CRM. Use search or the *_list tools to find records, *_get for one record, open_pipeline for the overview. Changes need the person's confirmation.",
  auth: authFromEnv(),
})

// ------------------------------------------------------------------ permissions and settings

export const canViewDeals = app.registerPermission("deals.view", { label: { en: "See deals", it: "Vedere le trattative" }, default: true })
export const canEditDeals = app.registerPermission("deals.edit", { label: { en: "Change deals", it: "Modificare le trattative" }, default: true })
export const canSeeValues = app.registerPermission("deals.values", { label: { en: "See deal values", it: "Vedere i valori delle trattative" } })
export const canEditContacts = app.registerPermission("contacts.edit", { label: { en: "Log calls with contacts", it: "Registrare le chiamate ai contatti" }, default: true })

app.registerSetting("followUpDays", { label: { en: "Follow-up after (days)", it: "Richiamare dopo (giorni)" }, type: "number", default: 7 })

// ------------------------------------------------------------------ entities

export const STAGES = ["lead", "qualified", "proposal", "won", "lost"] as const
const stageLabels = {
  lead: { en: "Lead", it: "Contatto" },
  qualified: { en: "Qualified", it: "Qualificata" },
  proposal: { en: "Proposal", it: "Proposta" },
  won: { en: "Won", it: "Vinta" },
  lost: { en: "Lost", it: "Persa" },
}

const companySchema = z.object({
  id: z.string(),
  name: z.string().meta({ role: "title", label: { en: "Name", it: "Nome" }, search: true, sort: true }),
  city: z.string().meta({ role: "subtitle", label: { en: "City", it: "Città" }, filter: true }),
  industry: z.enum(["manufacturing", "retail", "services", "software"]).meta({
    label: { en: "Industry", it: "Settore" },
    filter: true,
    labels: { manufacturing: { en: "Manufacturing", it: "Manifattura" }, retail: { en: "Retail", it: "Commercio" }, services: { en: "Services", it: "Servizi" }, software: "Software" },
  }),
})

const contactSchema = z.object({
  id: z.string(),
  name: z.string().meta({ role: "title", label: { en: "Name", it: "Nome" }, search: true, sort: true }),
  email: z.string().meta({ role: "subtitle", label: "Email", search: true }),
  company: ref("company").meta({ label: { en: "Company", it: "Azienda" }, filter: true }),
  lastCall: z.string().optional().meta({ role: "date", label: { en: "Last call", it: "Ultima chiamata" }, sort: true }),
  lastNote: z.string().optional().meta({ label: { en: "Last note", it: "Ultima nota" }, untrusted: true }),
})

const dealSchema = z.object({
  id: z.string(),
  name: z.string().meta({ role: "title", label: { en: "Deal", it: "Trattativa" }, search: true }),
  company: ref("company").meta({ label: { en: "Company", it: "Azienda" }, filter: true }),
  stage: z.enum(STAGES).meta({ role: "status", label: { en: "Stage", it: "Fase" }, filter: true, labels: stageLabels, tones: { lead: "neutral", qualified: "info", proposal: "warning", won: "success", lost: "danger" } }),
  value: z.number().meta({ role: "amount", currency: "EUR", label: { en: "Value", it: "Valore" }, sort: true, permission: "deals.values" }),
  closeDate: z.string().meta({ role: "date", label: { en: "Close date", it: "Chiusura prevista" }, sort: true, filter: true }),
  owner: z.string().meta({ role: "person", label: { en: "Owner", it: "Responsabile" } }),
})

type Company = z.infer<typeof companySchema>
type Contact = z.infer<typeof contactSchema>
type Deal = z.infer<typeof dealSchema>

// ------------------------------------------------------------------ data (in memory, per installation)

const SEED = {
  companies: [
    { id: "co1", name: "Officine Bianchi", city: "Torino", industry: "manufacturing" },
    { id: "co2", name: "Verdi Retail", city: "Milano", industry: "retail" },
    { id: "co3", name: "Studio Neri", city: "Bologna", industry: "services" },
    { id: "co4", name: "Pixel Lab", city: "Padova", industry: "software" },
  ] as Company[],
  contacts: [
    { id: "ct1", name: "Giulia Bianchi", email: "giulia@officine-bianchi.example", company: "co1", lastCall: "2026-11-03", lastNote: "Wants a quote for 40 seats." },
    { id: "ct2", name: "Marco Verdi", email: "marco@verdi-retail.example", company: "co2" },
    { id: "ct3", name: "Sara Neri", email: "sara@studio-neri.example", company: "co3", lastCall: "2026-10-28" },
    { id: "ct4", name: "Luca Ferri", email: "luca@pixellab.example", company: "co4" },
  ] as Contact[],
  deals: [
    { id: "d1", name: "Officine Bianchi — 40 seats", company: "co1", stage: "proposal", value: 18000, closeDate: "2026-11-28", owner: "ada" },
    { id: "d2", name: "Verdi Retail — pilot", company: "co2", stage: "qualified", value: 6000, closeDate: "2026-12-15", owner: "bruno" },
    { id: "d3", name: "Studio Neri — renewal", company: "co3", stage: "won", value: 4200, closeDate: "2026-10-30", owner: "bruno" },
    { id: "d4", name: "Pixel Lab — integration", company: "co4", stage: "lead", value: 12500, closeDate: "2027-01-20", owner: "ada" },
    { id: "d5", name: "Verdi Retail — 3 stores", company: "co2", stage: "lost", value: 9000, closeDate: "2026-09-12", owner: "ada" },
  ] as Deal[],
}

type Data = { companies: Map<string, Company>; contacts: Map<string, Contact>; deals: Map<string, Deal>; seq: number }
const byInstallation = new Map<string, Data>()

/**
 * This installation's data. A real app reads its own database here, always
 * with `WHERE installation_id = ctx.installation` (spec §9).
 */
export function dataOf(ctx: Pick<Context, "installation">): Data {
  let d = byInstallation.get(ctx.installation)
  if (!d) {
    const copy = <T extends { id: string }>(rows: T[]) => new Map(rows.map((r) => [r.id, { ...r }]))
    d = { companies: copy(SEED.companies), contacts: copy(SEED.contacts), deals: copy(SEED.deals), seq: 100 }
    byInstallation.set(ctx.installation, d)
  }
  return d
}

export function resetData() {
  byInstallation.clear()
}

/** A generic in-memory list: filters (value, in, range), text, sort, cursor. */
function listOf<T extends Record<string, unknown>>(rows: T[], q: import("@mcpw/server").Query, textFields: (keyof T)[]) {
  const match = (row: T) =>
    Object.entries(q.filters).every(([field, f]) => {
      const v = row[field] as string | number | undefined
      if (f !== null && typeof f === "object" && "in" in f) return f.in.includes(v as never)
      if (f !== null && typeof f === "object") return (f.gte === undefined || (v !== undefined && v >= f.gte)) && (f.lte === undefined || (v !== undefined && v <= f.lte))
      return v === f
    }) && (!q.text || textFields.some((k) => String(row[k] ?? "").toLowerCase().includes(q.text!.toLowerCase())))
  const all = rows.filter(match)
  if (q.sort) {
    const { field, dir } = q.sort
    all.sort((a, b) => (String(a[field] ?? "") < String(b[field] ?? "") ? -1 : 1) * (dir === "desc" ? -1 : 1))
    if (typeof all[0]?.[field] === "number") all.sort((a, b) => ((a[field] as number) - (b[field] as number)) * (dir === "desc" ? -1 : 1))
  }
  const from = q.cursor ? Number(q.cursor) : 0
  const to = from + q.limit
  return { rows: all.slice(from, to), total: all.length, ...(to < all.length ? { next: String(to) } : {}) }
}

export const CompanyEntity = app.registerEntity("company", {
  label: { en: "Company", it: "Azienda" },
  plural: { en: "Companies", it: "Aziende" },
  description: { en: "A customer or prospect company", it: "Un'azienda cliente o potenziale" },
  icon: "building-2",
  schema: companySchema,
  get: (id, ctx) => dataOf(ctx).companies.get(id) ?? null,
  list: (q, ctx) => listOf([...dataOf(ctx).companies.values()], q, ["name"]),
})

export const ContactEntity = app.registerEntity("contact", {
  label: { en: "Contact", it: "Contatto" },
  plural: { en: "Contacts", it: "Contatti" },
  description: { en: "A person at a company", it: "Una persona di un'azienda" },
  icon: "user",
  schema: contactSchema,
  get: (id, ctx) => dataOf(ctx).contacts.get(id) ?? null,
  list: (q, ctx) => listOf([...dataOf(ctx).contacts.values()], q, ["name", "email"]),
})

export const DealEntity = app.registerEntity("deal", {
  label: { en: "Deal", it: "Trattativa" },
  plural: { en: "Deals", it: "Trattative" },
  description: { en: "A sales opportunity with a company", it: "Un'opportunità di vendita con un'azienda" },
  icon: "briefcase",
  schema: dealSchema,
  permission: canViewDeals,
  get: (id, ctx) => dataOf(ctx).deals.get(id) ?? null,
  list: (q, ctx) => listOf([...dataOf(ctx).deals.values()], q, ["name"]),
})

// ------------------------------------------------------------------ actions

export const markWon = app.registerAction(
  "mark_won",
  {
    entity: DealEntity,
    title: { en: "Mark as won", it: "Segna come vinta" },
    description: { en: "Closes the deal as won. Only when the person says so", it: "Chiude la trattativa come vinta. Solo se la persona lo dice" },
    icon: "trophy",
    input: z.object({ note: z.string().max(500).optional().meta({ label: { en: "Note", it: "Nota" } }) }),
    confirm: "always",
    permission: canEditDeals,
  },
  (input, ctx, deal) => {
    if (deal.stage === "won" || deal.stage === "lost") throw new WorkspaceError("conflict", ctx.t({ en: `${deal.name} is already closed.`, it: `${deal.name} è già chiusa.` }))
    dataOf(ctx).deals.set(deal.id, { ...deal, stage: "won", closeDate: new Date().toISOString().slice(0, 10) })
    ctx.notify({ title: { en: `Deal won: ${deal.name}`, it: `Trattativa vinta: ${deal.name}` }, uri: ctx.uri("deal", deal.id) })
    return { message: ctx.t({ en: `${deal.name} marked as won.`, it: `${deal.name} segnata come vinta.` }), record: deal.id }
  },
)

export const setStage = app.registerAction(
  "set_stage",
  {
    entity: DealEntity,
    title: { en: "Move to stage", it: "Sposta di fase" },
    description: { en: "Moves an open deal to another open stage, or to lost", it: "Sposta una trattativa aperta in un'altra fase aperta, o tra le perse" },
    input: z.object({ stage: z.enum(["lead", "qualified", "proposal", "lost"]).meta({ label: { en: "Stage", it: "Fase" } }) }),
    confirm: "optional",
    permission: canEditDeals,
  },
  (input, ctx, deal) => {
    if (deal.stage === "won" || deal.stage === "lost") throw new WorkspaceError("conflict", ctx.t({ en: "Closed deals don't move.", it: "Le trattative chiuse non si spostano." }))
    dataOf(ctx).deals.set(deal.id, { ...deal, stage: input.stage })
    return { message: ctx.t({ en: `${deal.name}: now ${stageLabels[input.stage].en}.`, it: `${deal.name}: ora ${stageLabels[input.stage].it}.` }), record: deal.id }
  },
)

export const logCall = app.registerAction(
  "log_call",
  {
    entity: ContactEntity,
    title: { en: "Log a call", it: "Registra chiamata" },
    description: { en: "Records that we called this contact today, with a note", it: "Registra che abbiamo chiamato oggi questo contatto, con una nota" },
    icon: "phone",
    input: z.object({ note: z.string().min(1).max(500).meta({ label: { en: "Note", it: "Nota" } }) }),
    permission: canEditContacts,
  },
  (input, ctx, contact) => {
    dataOf(ctx).contacts.set(contact.id, { ...contact, lastCall: new Date().toISOString().slice(0, 10), lastNote: input.note })
    return { message: ctx.t({ en: `Call with ${contact.name} logged.`, it: `Chiamata con ${contact.name} registrata.` }), record: contact.id }
  },
)

export const createDeal = app.registerAction(
  "create_deal",
  {
    title: { en: "New deal", it: "Nuova trattativa" },
    description: { en: "Creates a deal for a company", it: "Crea una trattativa per un'azienda" },
    icon: "plus",
    input: z.object({
      name: z.string().min(2).max(120).meta({ label: { en: "Name", it: "Nome" } }),
      company: ref("company").meta({ label: { en: "Company", it: "Azienda" } }),
      value: z.number().min(0).meta({ label: { en: "Value (EUR)", it: "Valore (EUR)" } }),
      closeDate: z.iso.date().meta({ label: { en: "Close date", it: "Chiusura prevista" } }),
    }),
    permission: canEditDeals,
  },
  (input, ctx) => {
    const d = dataOf(ctx)
    if (!d.companies.has(input.company)) throw new WorkspaceError("invalid_input", ctx.t({ en: `Unknown company ${input.company}.`, it: `Azienda ${input.company} sconosciuta.` }))
    const id = `d${++d.seq}`
    d.deals.set(id, { id, ...input, stage: "lead", owner: ctx.person?.id ?? "unknown" })
    return { message: ctx.t({ en: `Deal «${input.name}» created.`, it: `Trattativa «${input.name}» creata.` }), record: ctx.uri("deal", id) }
  },
)

// ------------------------------------------------------------------ fragments

const openDeals = (ctx: Context) => [...dataOf(ctx).deals.values()].filter((d) => d.stage !== "won" && d.stage !== "lost")

export const pipelineTotal = app.registerFragment("pipeline_total", {
  title: { en: "Open pipeline", it: "Pipeline aperta" },
  description: { en: "The total value of open deals", it: "Il valore totale delle trattative aperte" },
  params: z.object({}),
  permission: canSeeValues,
  template: "stat",
  data: (_p, ctx) => {
    const open = openDeals(ctx)
    return { label: ctx.t({ en: `${open.length} open deals`, it: `${open.length} trattative aperte` }), value: open.reduce((s, d) => s + d.value, 0), format: "money", currency: "EUR" }
  },
})

export const dealsByStage = app.registerFragment("deals_by_stage", {
  title: { en: "Deals by stage", it: "Trattative per fase" },
  description: { en: "How many deals are in each stage", it: "Quante trattative ci sono in ogni fase" },
  params: z.object({}),
  template: "chart",
  data: (_p, ctx) => ({
    kind: "bar",
    points: STAGES.map((s) => ({ label: ctx.t(stageLabels[s]), value: [...dataOf(ctx).deals.values()].filter((d) => d.stage === s).length })),
  }),
})

export const closingSoon = app.registerFragment("closing_soon", {
  title: { en: "Closing soon", it: "In chiusura" },
  description: { en: "Open deals closing within some days", it: "Trattative aperte che chiudono entro alcuni giorni" },
  params: z.object({ days: z.number().int().min(1).max(365).default(60) }),
  template: "list",
  actions: [createDeal],
  data: (p, ctx) => {
    const until = new Date(Date.now() + p.days * 86_400_000).toISOString().slice(0, 10)
    return {
      items: openDeals(ctx)
        .filter((d) => d.closeDate <= until)
        .sort((a, b) => a.closeDate.localeCompare(b.closeDate))
        .map((d) => ({ title: d.name, subtitle: d.closeDate, status: ctx.t(stageLabels[d.stage]), uri: ctx.uri("deal", d.id) })),
    }
  },
})

// ------------------------------------------------------------------ pages

app.registerPage("deals", {
  kind: "list",
  title: { en: "Deals", it: "Trattative" },
  icon: "briefcase",
  entity: DealEntity,
  columns: ["name", "company", "stage", "value", "closeDate", "owner"],
})

app.registerPage("companies", {
  kind: "list",
  title: { en: "Companies", it: "Aziende" },
  icon: "building-2",
  entity: CompanyEntity,
  columns: ["name", "city", "industry"],
})

app.registerPage("contacts", {
  kind: "list",
  title: { en: "Contacts", it: "Contatti" },
  icon: "users",
  entity: ContactEntity,
  columns: ["name", "email", "company", "lastCall"],
})

app.registerPage("deal", {
  kind: "record",
  entity: DealEntity,
  sections: [
    { title: { en: "Deal", it: "Trattativa" }, fields: ["name", "company", "stage", "value"] },
    { title: { en: "Planning", it: "Pianificazione" }, fields: ["closeDate", "owner"] },
  ],
})

app.registerPage("pipeline", {
  kind: "dashboard",
  title: { en: "Pipeline", it: "Pipeline" },
  icon: "chart-column",
  params: z.object({ days: z.number().int().min(1).max(365).optional() }),
  fragments: (p) => [
    { type: "pipeline_total", params: {}, size: "small" },
    { type: "deals_by_stage", params: {}, size: "medium" },
    { type: "closing_soon", params: { days: p.days ?? 60 }, size: "medium" },
  ],
})

app.registerPage("forecast", {
  kind: "custom",
  title: { en: "Forecast", it: "Previsione" },
  icon: "calculator",
  description: { en: "A weighted forecast you can tune (an MCP Apps view)", it: "Una previsione pesata da regolare (una vista MCP Apps)" },
  permission: canSeeValues,
  view: { html: () => import("./forecast-view").then((m) => m.forecastHtml) },
})

// ------------------------------------------------------------------ agent

app.registerAgent("sales_assistant", {
  title: { en: "Sales assistant", it: "Assistente vendite" },
  description: { en: "Finds deals, prepares follow-ups, moves deals between stages", it: "Trova trattative, prepara i richiami, sposta le trattative di fase" },
  instructions:
    "You help a sales team. Find deals and contacts with search and the list tools; never guess amounts, read them. Propose a stage change or a won deal only when the person asks, and let them confirm. Suggest calling contacts not called in the last followUpDays days.",
  tools: [DealEntity, ContactEntity, CompanyEntity, setStage, markWon, logCall],
  tier: "fast",
  starters: [{ en: "Which deals close this month?", it: "Quali trattative chiudono questo mese?" }],
})
