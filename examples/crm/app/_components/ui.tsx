import Link from "next/link"
import type { ReactNode } from "react"

import type { Stage } from "@/lib/crm"
import { STAGE_LABELS } from "@/lib/format"

const STAGE_TONES: Record<Stage, string> = {
  lead: "bg-zinc-100 text-zinc-700 ring-zinc-200",
  qualified: "bg-sky-50 text-sky-700 ring-sky-200",
  proposal: "bg-amber-50 text-amber-800 ring-amber-200",
  won: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  lost: "bg-rose-50 text-rose-700 ring-rose-200",
}

export function StageBadge({ stage }: { stage: Stage }) {
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${STAGE_TONES[stage]}`}>{STAGE_LABELS[stage]}</span>
}

export function PageTitle({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-xl font-semibold tracking-tight">{children}</h1>
      {actions}
    </div>
  )
}

export function Card({ title, children, className = "" }: { title?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border border-zinc-200 bg-white p-4 shadow-xs ${className}`}>
      {title ? <h2 className="mb-3 text-sm font-semibold text-zinc-700">{title}</h2> : null}
      {children}
    </section>
  )
}

/** The outcome of the last action, carried in the address (`?notice=` / `?error=`). */
export function Notice({ notice, error }: { notice?: string | undefined; error?: string | undefined }) {
  if (error) return <p role="alert" className="mb-4 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-rose-800">{error}</p>
  if (notice) return <p role="status" className="mb-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-800">{notice}</p>
  return null
}

export function NoAccess({ what }: { what: string }) {
  return <Card><p className="text-zinc-600">You don&apos;t have access to {what}.</p></Card>
}

export const inputClass = "rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm shadow-xs focus:border-zinc-500 focus:outline-none"
export const buttonClass = "rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white shadow-xs hover:bg-zinc-700 disabled:opacity-50"
export const secondaryButtonClass = "rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-800 shadow-xs hover:bg-zinc-100"

export function Th({ children, className = "" }: { children?: ReactNode; className?: string }) {
  return <th className={`border-b border-zinc-200 px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-zinc-500 ${className}`}>{children}</th>
}

export function Td({ children, className = "" }: { children?: ReactNode; className?: string }) {
  return <td className={`border-b border-zinc-100 px-3 py-2 align-top ${className}`}>{children}</td>
}

export function TextLink({ href, children }: { href: string; children: ReactNode }) {
  return <Link href={href} className="font-medium text-zinc-900 underline-offset-2 hover:underline">{children}</Link>
}

/** One string from a search parameter. */
export const param = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)
