/**
 * The demo companies and people (invented). Their password is never in the
 * code: `DEMO_PASSWORD` from the environment (`npm run setup` writes one into
 * `.env.local`).
 */
export type DemoUser = { email: string; name: string; role: "admin" | "member"; company: CompanySlug }
export type CompanySlug = "aurora-hardware" | "hummingbird-crafts"

export const COMPANIES: Record<CompanySlug, { name: string }> = {
  "aurora-hardware": { name: "Aurora Hardware" },
  "hummingbird-crafts": { name: "Hummingbird Crafts" },
}

export const DEMO_USERS: DemoUser[] = [
  { email: "ada.fernley@aurora.example", name: "Ada Fernley", role: "admin", company: "aurora-hardware" },
  { email: "luke.marsh@aurora.example", name: "Luke Marsh", role: "member", company: "aurora-hardware" },
  { email: "sophie.green@hummingbird.example", name: "Sophie Green", role: "admin", company: "hummingbird-crafts" },
  { email: "owen.rivers@hummingbird.example", name: "Owen Rivers", role: "member", company: "hummingbird-crafts" },
]

export function demoPassword(): string {
  const p = process.env.DEMO_PASSWORD
  if (!p || p.length < 12) throw new Error("DEMO_PASSWORD is not set (at least 12 characters). Run `npm run setup`, or set it in .env.local.")
  return p
}
