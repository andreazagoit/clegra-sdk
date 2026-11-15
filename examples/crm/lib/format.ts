import type { Industry, Stage } from "./crm"

export const STAGE_LABELS: Record<Stage, string> = { lead: "Lead", qualified: "Qualified", proposal: "Proposal", won: "Won", lost: "Lost" }
export const INDUSTRY_LABELS: Record<Industry, string> = { manufacturing: "Manufacturing", retail: "Retail", services: "Services", software: "Software" }

const money = new Intl.NumberFormat("en-GB", { style: "currency", currency: "EUR", maximumFractionDigits: 0 })
const day = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" })

export const formatMoney = (value: number) => money.format(value)
/** A `YYYY-MM-DD` date as people read it. */
export const formatDate = (date: string) => day.format(new Date(`${date}T12:00:00Z`))
