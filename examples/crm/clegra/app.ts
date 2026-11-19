// The CRM as a Clegra app (docs/examples/crm.md): one defineApp object over
// the functions the CRM already has (lib/crm.ts). Hosts and MCP clients get
// the same rules as the pages: the tenant from the verified caller, the field
// permissions applied by the SDK, the changes through the same functions.
import { AppError, defineApp, ref, SqlStore, type App, type AuthOptions, type Context, type IdempotencyStore } from "@clegra/sdk"
import { z } from "zod"

import {
  closingSoon,
  createContact,
  createDeal,
  CrmError,
  deleteWorkspace,
  getCompany,
  getContact,
  getDeal,
  isWorkspaceInstallation,
  listCompanies,
  listContacts,
  listDeals,
  logCall,
  markWon,
  openPipeline,
  personNames,
  pipelineByStage,
  provisionWorkspace,
  setErpCustomer,
  setStage,
  STAGES,
  tenantData,
} from "@/lib/crm"
import { database } from "@/lib/db"
import { STAGE_WORDS } from "@/lib/format"

// ------------------------------------------------------------------ schemas (fields carry their meaning)

const stageLabels = STAGE_WORDS

const companySchema = z.object({
  id: z.string(),
  // Free text, typed in from outside (a web form, an import): marked `untrusted`, so a model reads it as data.
  name: z.string().meta({ role: "title", label: { en: "Name", it: "Nome" }, search: true, sort: true, untrusted: true }),
  city: z.string().meta({ role: "subtitle", label: { en: "City", it: "Città" }, filter: true, untrusted: true }),
  industry: z.enum(["manufacturing", "retail", "services", "software"]).meta({
    label: { en: "Industry", it: "Settore" },
    filter: true,
    labels: { manufacturing: { en: "Manufacturing", it: "Manifattura" }, retail: { en: "Retail", it: "Commercio" }, services: { en: "Services", it: "Servizi" }, software: "Software" },
  }),
  // What other apps can find the company by (kind organization): its VAT number, an exact filter, and its website.
  vatId: z.string().optional().meta({ as: "vatID", label: { en: "VAT number", it: "Partita IVA" }, filter: true }),
  website: z.string().optional().meta({ as: "url", label: { en: "Website", it: "Sito web" } }),
  // The same company in another app (an ERP's customer): a record URI of kind organization. The CRM keeps the URI
  // only; hosts show the ERP's live title to people who may see it there.
  erpCustomer: ref.kind("organization").optional().meta({ label: { en: "ERP customer", it: "Cliente nel gestionale" } }),
})

const contactSchema = z.object({
  id: z.string(),
  name: z.string().meta({ role: "title", label: { en: "Name", it: "Nome" }, search: true, sort: true, untrusted: true }),
  // Kind person: the email is its key, an exact filter (hosts find the same person in other apps by it).
  email: z.string().meta({ role: "subtitle", as: "email", label: "Email", filter: true, search: true, untrusted: true }),
  company: ref("company").meta({ as: "worksFor", label: { en: "Company", it: "Azienda" }, filter: true }),
  lastCall: z.string().optional().meta({ role: "date", label: { en: "Last call", it: "Ultima chiamata" }, sort: true }),
  lastNote: z.string().optional().meta({ label: { en: "Last note", it: "Ultima nota" }, untrusted: true }),
})

const dealSchema = z.object({
  id: z.string(),
  name: z.string().meta({ role: "title", label: { en: "Deal", it: "Trattativa" }, search: true, untrusted: true }),
  company: ref("company").meta({ label: { en: "Company", it: "Azienda" }, filter: true }),
  stage: z.enum(STAGES).meta({ role: "status", label: { en: "Stage", it: "Fase" }, filter: true, labels: stageLabels, tones: { lead: "neutral", qualified: "info", proposal: "warning", won: "success", lost: "danger" } }),
  value: z.number().meta({ role: "amount", currency: "EUR", label: { en: "Value", it: "Valore" }, sort: true, permission: "deals.values" }),
  closeDate: z.string().meta({ role: "date", label: { en: "Close date", it: "Chiusura prevista" }, sort: true, filter: true }),
  owner: z.string().meta({ role: "person", label: { en: "Owner", it: "Responsabile" } }),
})

// ------------------------------------------------------------------ the tenant

/**
 * The tenant of this call: `ctx.installation`, from the verified token. The CRM's own users call for their
 * organization (its id); a workspace host for one of its installations (`<installation>@<issuer>`), which
 * gets its own copy of the demo data on its first call.
 */
async function tenant(ctx: Pick<Context, "installation">): Promise<string> {
  if (isWorkspaceInstallation(ctx.installation)) await provisionWorkspace(ctx.installation)
  return ctx.installation
}

/** The CRM's refusals in the caller's language; anything else stays an internal error. */
function refused(error: unknown, ctx: Context, closed?: { en: string; it: string }): never {
  if (!(error instanceof CrmError)) throw error
  if (error.code === "closed" && closed) throw new AppError("conflict", ctx.t(closed))
  if (error.code === "not_found") throw new AppError("not_found", ctx.t({ en: "Not found.", it: "Non trovato." }))
  throw new AppError("invalid_input", error.message)
}

// ------------------------------------------------------------------ the app

/**
 * Who may frame the CRM's embedded pages (/embed/*, spec §5.1): Clegra's web client, ChatGPT and Claude with the
 * sandbox origins their MCP Apps views run on, and any local port while developing. Every frame up to the top
 * must be one of them; a sign-in ticket is issued only for a frame of one of them.
 */
export const EMBED_HOSTS = [
  "https://app.clegra.com",
  "https://chatgpt.com",
  "https://*.web-sandbox.oaiusercontent.com",
  "https://claude.ai",
  "https://*.claudemcpcontent.com",
  ...(process.env.NODE_ENV === "production" ? [] : ["http://localhost:*", "http://127.0.0.1:*"]),
]

export type CrmAppOptions = {
  /** Who may call: the app's own users (`resolve`: better-auth access tokens, clegra/auth.ts) and workspace hosts (`issuers`). */
  auth: AuthOptions
  /** Default: the `clegra_store` table in the CRM's database. */
  store?: IdempotencyStore
}

export function createCrmApp({ auth, store = new SqlStore((text, params) => database().query(text, params)) }: CrmAppOptions): App {
  return defineApp({
    name: "crm",
    title: { en: "CRM", it: "CRM" },
    version: "1.0.0",
    description: { en: "Companies, contacts and deals of a small sales team.", it: "Aziende, contatti e trattative di un piccolo team commerciale." },
    locale: "en",
    instructions: "A CRM. Use search or the *_list tools to find records, *_get for one record, open_pipeline for the overview. Changes need the person's confirmation.",
    auth,
    store,
    // The board (app/embed/pipeline) framed by hosts, signed in with a one-minute ticket. Its key is derived from the
    // CRM's one secret (the SDK's HKDF keeps the uses apart).
    embed: { frameAncestors: EMBED_HOSTS, secret: process.env.BETTER_AUTH_SECRET },
    // Deal owners are person ids: their names, so a host never shows an id.
    people: async (ids, ctx) => personNames(await tenant(ctx), ids),

    permissions: {
      "deals.view": { label: { en: "See deals", it: "Vedere le trattative" }, default: true },
      "deals.edit": { label: { en: "Change deals", it: "Modificare le trattative" }, default: true },
      "deals.values": { label: { en: "See deal values", it: "Vedere i valori delle trattative" } },
      "contacts.edit": { label: { en: "Add contacts and log calls", it: "Aggiungere contatti e registrare chiamate" }, default: true },
    },
  
    settings: {
      follow_up_days: { label: { en: "Follow-up after (days)", it: "Richiamare dopo (giorni)" }, type: "number", default: 7 },
    },
  
    entities: {
      company: {
        label: { en: "Company", it: "Azienda" },
        plural: { en: "Companies", it: "Aziende" },
        description: { en: "A customer or prospect company", it: "Un'azienda cliente o potenziale" },
        icon: "building-2",
        kind: "organization",
        schema: companySchema,
        get: async (id, ctx) => getCompany(await tenant(ctx), id),
        list: async (q, ctx) => listCompanies(await tenant(ctx), q),
      },
      contact: {
        label: { en: "Contact", it: "Contatto" },
        plural: { en: "Contacts", it: "Contatti" },
        description: { en: "A person at a company", it: "Una persona di un'azienda" },
        icon: "user",
        kind: "person",
        schema: contactSchema,
        get: async (id, ctx) => getContact(await tenant(ctx), id),
        list: async (q, ctx) => listContacts(await tenant(ctx), q),
      },
      deal: {
        label: { en: "Deal", it: "Trattativa" },
        plural: { en: "Deals", it: "Trattative" },
        description: { en: "A sales opportunity with a company", it: "Un'opportunità di vendita con un'azienda" },
        icon: "briefcase",
        schema: dealSchema,
        permission: "deals.view",
        get: async (id, ctx) => {
          const deal = await getDeal(await tenant(ctx), id)
          if (!deal) return null
          const { wonNote: _, ...fields } = deal
          return fields
        },
        list: async (q, ctx) => listDeals(await tenant(ctx), q),
      },
    },

    // Writes reach plain MCP clients (ChatGPT, Claude) only with `expose: { plain: true }`.
    actions: {
      mark_won: {
        on: "deal",
        title: { en: "Mark as won", it: "Segna come vinta" },
        description: { en: "Closes the deal as won. Only when the person says so", it: "Chiude la trattativa come vinta. Solo se la persona lo dice" },
        icon: "trophy",
        input: z.object({ note: z.string().max(500).optional().meta({ label: { en: "Note", it: "Nota" } }) }),
        confirm: true,
        permission: "deals.edit",
        expose: { plain: true },
        run: async (input, ctx, deal) => {
          await markWon(await tenant(ctx), deal.id, input).catch((e) => refused(e, ctx, { en: `${deal.name} is already closed.`, it: `${deal.name} è già chiusa.` }))
          ctx.notify({ title: { en: `Deal won: ${deal.name}`, it: `Trattativa vinta: ${deal.name}` }, uri: ctx.uri("deal", deal.id) })
          return { message: ctx.t({ en: `${deal.name} marked as won.`, it: `${deal.name} segnata come vinta.` }), record: deal.id }
        },
      },
      set_stage: {
        on: "deal",
        title: { en: "Move to stage", it: "Sposta di fase" },
        description: { en: "Moves an open deal to another open stage, or to lost", it: "Sposta una trattativa aperta in un'altra fase aperta, o tra le perse" },
        input: z.object({ stage: z.enum(["lead", "qualified", "proposal", "lost"]).meta({ label: { en: "Stage", it: "Fase" }, labels: stageLabels }) }),
        confirm: "optional",
        permission: "deals.edit",
        expose: { plain: true },
        run: async (input, ctx, deal) => {
          await setStage(await tenant(ctx), deal.id, input.stage).catch((e) => refused(e, ctx, { en: "Closed deals don't move.", it: "Le trattative chiuse non si spostano." }))
          return { message: ctx.t({ en: `${deal.name}: now ${stageLabels[input.stage].en}.`, it: `${deal.name}: ora ${stageLabels[input.stage].it}.` }), record: deal.id }
        },
      },
      log_call: {
        on: "contact",
        title: { en: "Log a call", it: "Registra chiamata" },
        description: { en: "Records that we called this contact today, with a note", it: "Registra che abbiamo chiamato oggi questo contatto, con una nota" },
        icon: "phone",
        input: z.object({ note: z.string().min(1).max(500).meta({ label: { en: "Note", it: "Nota" } }) }),
        permission: "contacts.edit",
        expose: { plain: true },
        run: async (input, ctx, contact) => {
          await logCall(await tenant(ctx), contact.id, { personId: ctx.person?.id ?? "unknown", note: input.note }).catch((e) => refused(e, ctx))
          return { message: ctx.t({ en: `Call with ${contact.name} logged.`, it: `Chiamata con ${contact.name} registrata.` }), record: contact.id }
        },
      },
      link_erp_customer: {
        on: "company",
        title: { en: "Link to the ERP customer", it: "Collega al cliente del gestionale" },
        description: { en: "Records which customer of another app (the ERP) this company is", it: "Registra quale cliente di un'altra app (il gestionale) è questa azienda" },
        icon: "link",
        input: z.object({ customer: ref.kind("organization").meta({ label: { en: "ERP customer", it: "Cliente nel gestionale" } }) }),
        confirm: "optional",
        permission: "deals.edit",
        expose: { plain: true },
        run: async (input, ctx, company) => {
          await setErpCustomer(await tenant(ctx), company.id, input.customer).catch((e) => refused(e, ctx))
          return { message: ctx.t({ en: `${company.name} linked to ${input.customer}.`, it: `${company.name} collegata a ${input.customer}.` }), record: company.id }
        },
      },
      create_contact: {
        title: { en: "New contact", it: "Nuovo contatto" },
        description: { en: "Adds a person at one of our companies", it: "Aggiunge una persona di una delle nostre aziende" },
        icon: "user-plus",
        input: z.object({
          name: z.string().min(2).max(120).meta({ label: { en: "Name", it: "Nome" } }),
          email: z.email().meta({ label: "Email" }),
          // On the contacts page filtered by a company (`?company=…`) this is filled in.
          company: ref("company").meta({ label: { en: "Company", it: "Azienda" } }),
        }),
        permission: "contacts.edit",
        expose: { plain: true },
        run: async (input, ctx) => {
          const contact = await createContact(await tenant(ctx), input).catch((e) => refused(e, ctx))
          return { message: ctx.t({ en: `Contact ${contact.name} added.`, it: `Contatto ${contact.name} aggiunto.` }), record: ctx.uri("contact", contact.id) }
        },
      },
      create_deal: {
        title: { en: "New deal", it: "Nuova trattativa" },
        description: { en: "Creates a deal for a company", it: "Crea una trattativa per un'azienda" },
        icon: "plus",
        input: z.object({
          name: z.string().min(2).max(120).meta({ label: { en: "Name", it: "Nome" } }),
          company: ref("company").meta({ label: { en: "Company", it: "Azienda" } }),
          value: z.number().min(0).meta({ label: { en: "Value", it: "Valore" }, currency: "EUR" }),
          closeDate: z.iso.date().meta({ label: { en: "Close date", it: "Chiusura prevista" } }),
        }),
        permission: "deals.edit",
        expose: { plain: true },
        run: async (input, ctx) => {
          const orgId = await tenant(ctx)
          // A host's people are no users here: their name is kept with the tenant, so others see it.
          const owner = { id: ctx.person?.id ?? "unknown", ...(isWorkspaceInstallation(orgId) && ctx.person?.name ? { name: ctx.person.name } : {}) }
          const deal = await createDeal(orgId, owner, input).catch((e) => {
            if (e instanceof CrmError && e.code === "unknown_company") throw new AppError("invalid_input", ctx.t({ en: `Unknown company ${input.company}.`, it: `Azienda ${input.company} sconosciuta.` }))
            throw e
          })
          return { message: ctx.t({ en: `Deal «${input.name}» created.`, it: `Trattativa «${input.name}» creata.` }), record: ctx.uri("deal", deal.id) }
        },
      },
    },

    fragments: {
      // The deals page's badge (a stat fragment: its value is the count).
      open_deals: {
        title: { en: "Open deals", it: "Trattative aperte" },
        description: { en: "How many deals are open", it: "Quante trattative sono aperte" },
        params: z.object({}),
        permission: "deals.view",
        // A count for the navigation, not something a model needs: views and the host call it, models never get it.
        visibility: "app",
        template: "stat",
        data: async (_p, ctx) => {
          const open = await openPipeline(await tenant(ctx))
          return { label: ctx.t({ en: "Open deals", it: "Trattative aperte" }), value: open.count, format: "number" }
        },
      },
      pipeline_total: {
        title: { en: "Open pipeline", it: "Pipeline aperta" },
        description: { en: "The total value of open deals", it: "Il valore totale delle trattative aperte" },
        params: z.object({}),
        permission: "deals.values",
        template: "stat",
        data: async (_p, ctx) => {
          const open = await openPipeline(await tenant(ctx))
          return { label: ctx.t(open.count === 1 ? { en: "1 open deal", it: "1 trattativa aperta" } : { en: `${open.count} open deals`, it: `${open.count} trattative aperte` }), value: open.value, format: "money", currency: "EUR" }
        },
      },
      deals_by_stage: {
        title: { en: "Deals by stage", it: "Trattative per fase" },
        description: { en: "How many deals are in each stage", it: "Quante trattative ci sono in ogni fase" },
        params: z.object({}),
        permission: "deals.view",
        template: "chart",
        data: async (_p, ctx) => ({ kind: "bar", points: (await pipelineByStage(await tenant(ctx))).map((s) => ({ label: ctx.t(stageLabels[s.stage]), value: s.count })) }),
      },
      closing_soon: {
        title: { en: "Closing soon", it: "In chiusura" },
        description: { en: "Open deals closing within some days", it: "Trattative aperte che chiudono entro alcuni giorni" },
        params: z.object({ days: z.number().int().min(1).max(365).default(60) }),
        permission: "deals.view",
        template: "list",
        // Deal names are outsiders' text.
        untrusted: true,
        actions: ["create_deal"],
        data: async (p, ctx) => ({
          items: (await closingSoon(await tenant(ctx), p.days))
            // The date as people read it, in the caller's language (a template's texts are shown as they are).
            .map((d) => ({ title: d.name, subtitle: new Intl.DateTimeFormat(ctx.locale, { dateStyle: "medium" }).format(new Date(`${d.closeDate}T12:00:00`)), status: ctx.t(stageLabels[d.stage]), uri: ctx.uri("deal", d.id) })),
        }),
      },
    },

    pages: {
      // «New deal» is the page's primary action, its form prefilled from the page's filter (`?company=…`); the badge counts open deals.
      deals: { title: { en: "Deals", it: "Trattative" }, icon: "briefcase", list: "deal", columns: ["name", "company", "stage", "value", "closeDate", "owner"], actions: ["create_deal"], badge: "open_deals" },
      companies: { title: { en: "Companies", it: "Aziende" }, icon: "building-2", list: "company", columns: ["name", "city", "industry"] },
      contacts: { title: { en: "Contacts", it: "Contatti" }, icon: "users", list: "contact", columns: ["name", "email", "company", "lastCall"], actions: ["create_contact"] },
      deal: {
        record: "deal",
        sections: [
          { title: { en: "Deal", it: "Trattativa" }, fields: ["name", "company", "stage", "value"] },
          { title: { en: "Planning", it: "Pianificazione" }, fields: ["closeDate", "owner"] },
        ],
      },
      pipeline: {
        title: { en: "Pipeline", it: "Pipeline" },
        icon: "chart-column",
        permission: "deals.view",
        params: z.object({ days: z.number().int().min(1).max(365).optional() }),
        dashboard: (p: { days?: number }) => [
          { type: "pipeline_total", params: {}, size: "small" },
          { type: "deals_by_stage", params: {}, size: "medium" },
          { type: "closing_soon", params: { days: p.days ?? 60 }, size: "medium" },
        ],
      },
      // A custom page: our own MCP Apps document (forecast-view.ts) instead of a generated view.
      forecast: {
        title: { en: "Forecast", it: "Previsione" },
        icon: "calculator",
        description: { en: "A weighted forecast you can tune", it: "Una previsione pesata da regolare" },
        permission: "deals.values",
        view: { html: () => import("./forecast-view").then((m) => m.forecastHtml) },
      },
      // A page of the CRM itself (app/embed/pipeline), framed by hosts at the app's own address with a sign-in ticket.
      board: {
        title: { en: "Board", it: "Bacheca" },
        icon: "kanban",
        description: { en: "The pipeline board, by stage", it: "La bacheca delle trattative, per fase" },
        permission: "deals.view",
        url: "/embed/pipeline",
      },
    },
  
    // The host's navigation: selling first, then the people and companies we sell to.
    nav: [
      { section: { en: "Sales", it: "Vendite" }, pages: ["pipeline", "deals", "board", "forecast"] },
      { section: { en: "Customers", it: "Clienti" }, pages: ["companies", "contacts"] },
    ],

    // A workspace host tells the CRM when its installation is uninstalled, takes its data out, and deletes them
    // (30 days later, or at once). Only a workspace installation's tenant is exported or deleted: an organization of
    // the CRM's own users is never deleted through a host.
    lifecycle: {
      export: async (ctx) => {
        if (!isWorkspaceInstallation(ctx.installation)) return null
        return { name: "crm-export.json", contentType: "application/json", body: JSON.stringify(await tenantData(ctx.installation), null, 2) }
      },
      delete: async (ctx) => {
        if (!isWorkspaceInstallation(ctx.installation)) return
        return { counts: await deleteWorkspace(ctx.installation) }
      },
    },

    agents: {
      sales_assistant: {
        title: { en: "Sales assistant", it: "Assistente vendite" },
        description: { en: "Finds deals, prepares follow-ups, moves deals between stages", it: "Trova trattative, prepara i richiami, sposta le trattative di fase" },
        instructions:
          "You help a sales team. Find deals and contacts with search and the list tools; never guess amounts, read them. Propose a stage change or a won deal only when the person asks, and let them confirm. Suggest calling contacts not called in the last follow_up_days days.",
        uses: ["deal", "contact", "company", "set_stage", "mark_won", "log_call"],
        tier: "fast",
        starters: [{ en: "Which deals close this month?", it: "Quali trattative chiudono questo mese?" }],
      },
    },
  })
}
