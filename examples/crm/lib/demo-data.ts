// Invented data only: no real companies or people.
import type { INDUSTRIES, STAGES } from "@/db/schema"

/** The sales team, by the keys deals' owners hold here; the seed maps them to real user ids. */
export type OwnerKey = "ada" | "bruno" | "elena"

export type DemoData = {
  companies: { id: string; name: string; city: string; industry: (typeof INDUSTRIES)[number] }[]
  contacts: { id: string; name: string; email: string; company: string; lastCall?: string; lastNote?: string }[]
  deals: { id: string; name: string; company: string; stage: (typeof STAGES)[number]; value: number; closeDate: string; owner: OwnerKey }[]
}

/** The main organization's pipeline; also every new workspace-host installation's starting copy. */
export const SALES_TEAM_DATA: DemoData = {
  companies: [
    { id: "co1", name: "Officine Bianchi", city: "Torino", industry: "manufacturing" },
    { id: "co2", name: "Verdi Retail", city: "Milano", industry: "retail" },
    { id: "co3", name: "Studio Neri", city: "Bologna", industry: "services" },
    { id: "co4", name: "Pixel Lab", city: "Padova", industry: "software" },
  ],
  contacts: [
    { id: "ct1", name: "Giulia Bianchi", email: "giulia@officine-bianchi.example", company: "co1", lastCall: "2026-11-03", lastNote: "Wants a quote for 40 seats." },
    { id: "ct2", name: "Marco Verdi", email: "marco@verdi-retail.example", company: "co2" },
    { id: "ct3", name: "Sara Neri", email: "sara@studio-neri.example", company: "co3", lastCall: "2026-10-28" },
    { id: "ct4", name: "Luca Ferri", email: "luca@pixellab.example", company: "co4" },
  ],
  deals: [
    { id: "d1", name: "Officine Bianchi — 40 seats", company: "co1", stage: "proposal", value: 18000, closeDate: "2026-11-28", owner: "ada" },
    { id: "d2", name: "Verdi Retail — pilot", company: "co2", stage: "qualified", value: 6000, closeDate: "2026-12-15", owner: "bruno" },
    { id: "d3", name: "Studio Neri — renewal", company: "co3", stage: "won", value: 4200, closeDate: "2026-10-30", owner: "bruno" },
    { id: "d4", name: "Pixel Lab — integration", company: "co4", stage: "lead", value: 12500, closeDate: "2027-01-20", owner: "ada" },
    { id: "d5", name: "Verdi Retail — 3 stores", company: "co2", stage: "lost", value: 9000, closeDate: "2026-09-12", owner: "ada" },
  ],
}

/** The second organization: small, to show that tenants never see each other's records. */
export const DESIGN_STUDIO_DATA: DemoData = {
  companies: [{ id: "co1", name: "Fiori Bakery", city: "Verona", industry: "retail" }],
  contacts: [{ id: "ct1", name: "Paolo Fiori", email: "paolo@fiori-bakery.example", company: "co1" }],
  deals: [{ id: "d1", name: "Fiori Bakery — new brand", company: "co1", stage: "proposal", value: 3500, closeDate: "2026-12-05", owner: "elena" }],
}

/** Names of the owner keys, for workspace-host installations (their people are not users here). */
export const OWNER_NAMES: Record<OwnerKey, string> = { ada: "Ada Rossi", bruno: "Bruno Neri", elena: "Elena Conti" }

export const ORGANIZATIONS = [
  { id: "org_orbita", name: "Orbita Sales", slug: "orbita", data: SALES_TEAM_DATA },
  { id: "org_kestrel", name: "Kestrel Design", slug: "kestrel", data: DESIGN_STUDIO_DATA },
] as const

/** The demo accounts (the password is DEMO_PASSWORD, set at seed time; never in the code). */
export const DEMO_USERS = [
  { key: "ada", name: "Ada Rossi", email: "ada@orbita.example", organization: "org_orbita", role: "admin", label: "Ada Rossi (sales manager)" },
  { key: "bruno", name: "Bruno Neri", email: "bruno@orbita.example", organization: "org_orbita", role: "member", label: "Bruno Neri (sales rep)" },
  { key: "elena", name: "Elena Conti", email: "elena@kestrel.example", organization: "org_kestrel", role: "admin", label: "Elena Conti (Kestrel Design)" },
] as const satisfies readonly { key: OwnerKey; name: string; email: string; organization: string; role: string; label: string }[]
