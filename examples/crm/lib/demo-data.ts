// Invented data only: no real companies or people.
import type { INDUSTRIES, STAGES } from "@/db/schema"

/** The sales team, by the keys deals' owners hold here; the seed maps them to real user ids. */
export type OwnerKey = "alice" | "ben" | "emma"

export type DemoData = {
  companies: { id: string; name: string; city: string; industry: (typeof INDUSTRIES)[number]; vatId?: string; website?: string }[]
  contacts: { id: string; name: string; email: string; company: string; lastCall?: string; lastNote?: string }[]
  deals: { id: string; name: string; company: string; stage: (typeof STAGES)[number]; value: number; closeDate: string; owner: OwnerKey }[]
}

/** The main organization's pipeline; also every new workspace-host installation's starting copy. */
export const SALES_TEAM_DATA: DemoData = {
  companies: [
    // VAT numbers are invented (GB000…): no real company has them.
    { id: "co1", name: "Hartley Engineering", city: "Manchester", industry: "manufacturing", vatId: "GB000000001", website: "https://hartley-engineering.example" },
    { id: "co2", name: "Greenfield Retail", city: "London", industry: "retail", vatId: "GB000000002", website: "https://greenfield-retail.example" },
    { id: "co3", name: "Lane Studio", city: "Bristol", industry: "services", website: "https://lane-studio.example" },
    { id: "co4", name: "Pixel Lab", city: "Cambridge", industry: "software", vatId: "GB000000004", website: "https://pixellab.example" },
  ],
  contacts: [
    { id: "ct1", name: "Grace Hartley", email: "grace@hartley-engineering.example", company: "co1", lastCall: "2026-11-03", lastNote: "Wants a quote for 40 seats." },
    { id: "ct2", name: "Mark Green", email: "mark@greenfield-retail.example", company: "co2" },
    { id: "ct3", name: "Sarah Lane", email: "sarah@lane-studio.example", company: "co3", lastCall: "2026-10-28" },
    { id: "ct4", name: "Luke Ferris", email: "luke@pixellab.example", company: "co4" },
  ],
  deals: [
    { id: "d1", name: "Hartley Engineering — 40 seats", company: "co1", stage: "proposal", value: 18000, closeDate: "2026-11-28", owner: "alice" },
    { id: "d2", name: "Greenfield Retail — pilot", company: "co2", stage: "qualified", value: 6000, closeDate: "2026-12-15", owner: "ben" },
    { id: "d3", name: "Lane Studio — renewal", company: "co3", stage: "won", value: 4200, closeDate: "2026-10-30", owner: "ben" },
    { id: "d4", name: "Pixel Lab — integration", company: "co4", stage: "lead", value: 12500, closeDate: "2027-01-20", owner: "alice" },
    { id: "d5", name: "Greenfield Retail — 3 stores", company: "co2", stage: "lost", value: 9000, closeDate: "2026-09-12", owner: "alice" },
  ],
}

/** The second organization: small, to show that tenants never see each other's records. */
export const DESIGN_STUDIO_DATA: DemoData = {
  companies: [{ id: "co1", name: "Rosewood Bakery", city: "York", industry: "retail", vatId: "GB000000101", website: "https://rosewood-bakery.example" }],
  contacts: [{ id: "ct1", name: "Paul Rose", email: "paul@rosewood-bakery.example", company: "co1" }],
  deals: [{ id: "d1", name: "Rosewood Bakery — new brand", company: "co1", stage: "proposal", value: 3500, closeDate: "2026-12-05", owner: "emma" }],
}

/** Names of the owner keys, for workspace-host installations (their people are not users here). */
export const OWNER_NAMES: Record<OwnerKey, string> = { alice: "Alice Morgan", ben: "Ben Carter", emma: "Emma Hayes" }

export const ORGANIZATIONS = [
  { id: "org_orbit", name: "Orbit Sales", slug: "orbit", data: SALES_TEAM_DATA },
  { id: "org_kestrel", name: "Kestrel Design", slug: "kestrel", data: DESIGN_STUDIO_DATA },
] as const

/** The demo accounts (the password is DEMO_PASSWORD, set at seed time; never in the code). */
export const DEMO_USERS = [
  { key: "alice", name: "Alice Morgan", email: "alice@orbit.example", organization: "org_orbit", role: "admin", label: "Alice Morgan (sales manager)" },
  { key: "ben", name: "Ben Carter", email: "ben@orbit.example", organization: "org_orbit", role: "member", label: "Ben Carter (sales rep)" },
  { key: "emma", name: "Emma Hayes", email: "emma@kestrel.example", organization: "org_kestrel", role: "admin", label: "Emma Hayes (Kestrel Design)" },
] as const satisfies readonly { key: OwnerKey; name: string; email: string; organization: string; role: string; label: string }[]
