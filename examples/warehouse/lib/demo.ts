/**
 * The demo companies and people (invented). Their password is never in the
 * code: `DEMO_PASSWORD` from the environment (`npm run setup` writes one into
 * `.env.local`).
 */
export type DemoUser = { email: string; name: string; role: "admin" | "member"; company: CompanySlug }
export type CompanySlug = "ferramenta-aurora" | "bottega-colibri"

export const COMPANIES: Record<CompanySlug, { name: string }> = {
  "ferramenta-aurora": { name: "Ferramenta Aurora" },
  "bottega-colibri": { name: "Bottega Colibrì" },
}

export const DEMO_USERS: DemoUser[] = [
  { email: "ada.ferri@aurora.example", name: "Ada Ferri", role: "admin", company: "ferramenta-aurora" },
  { email: "luca.marini@aurora.example", name: "Luca Marini", role: "member", company: "ferramenta-aurora" },
  { email: "sofia.greco@colibri.example", name: "Sofia Greco", role: "admin", company: "bottega-colibri" },
  { email: "enzo.riva@colibri.example", name: "Enzo Riva", role: "member", company: "bottega-colibri" },
]

export function demoPassword(): string {
  const p = process.env.DEMO_PASSWORD
  if (!p || p.length < 12) throw new Error("DEMO_PASSWORD is not set (at least 12 characters). Run `npm run setup`, or set it in .env.local.")
  return p
}
