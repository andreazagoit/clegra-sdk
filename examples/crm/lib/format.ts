import type { Industry, Stage } from "./crm"

/** A stage in each language the CRM speaks: the app's labels (clegra/app.ts) and the board a host frames. */
export const STAGE_WORDS: Record<Stage, { en: string; it: string }> = {
  lead: { en: "Lead", it: "Contatto" },
  qualified: { en: "Qualified", it: "Qualificata" },
  proposal: { en: "Proposal", it: "Proposta" },
  won: { en: "Won", it: "Vinta" },
  lost: { en: "Lost", it: "Persa" },
}
/** The CRM's own pages are in English. */
export const STAGE_LABELS = Object.fromEntries(Object.entries(STAGE_WORDS).map(([stage, words]) => [stage, words.en])) as Record<Stage, string>
export const INDUSTRY_LABELS: Record<Industry, string> = { manufacturing: "Manufacturing", retail: "Retail", services: "Services", software: "Software" }

/** The language of a page a host frames: the caller's (Italian or English), else English. */
export const embedLanguage = (locale?: string): "en" | "it" => (locale?.toLowerCase().startsWith("it") ? "it" : "en")
const tag = { en: "en-GB", it: "it-IT" } as const

export const formatMoney = (value: number, language: "en" | "it" = "en") =>
  new Intl.NumberFormat(tag[language], { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(value)
/** A `YYYY-MM-DD` date as people read it. */
export const formatDate = (date: string, language: "en" | "it" = "en") =>
  new Intl.DateTimeFormat(tag[language], { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`))
