import Link from "next/link"

type Tone = "neutral" | "info" | "success" | "warning" | "danger"

const TONES: Record<Tone, string> = {
  neutral: "bg-stone-100 text-stone-700",
  info: "bg-sky-50 text-sky-800",
  success: "bg-teal-50 text-teal-800",
  warning: "bg-amber-50 text-amber-800",
  danger: "bg-red-50 text-red-800",
}

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: React.ReactNode }) {
  return <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${TONES[tone]}`}>{children}</span>
}

export const STOCK_TONES = { ok: "success", low: "warning", out: "danger" } as const
export const ORDER_TONES = { draft: "neutral", confirmed: "info", shipped: "success", cancelled: "danger" } as const
export const KIND_TONES = { in: "success", out: "info", adjustment: "warning" } as const

export function PageHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <h1>{title}</h1>
      {children}
    </div>
  )
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-3 py-6 text-center text-sm text-stone-500">{children}</p>
}

/** «Previous / Next» links for a list page, keeping the other search parameters. */
export function Pager({ path, params, next, offset, limit, total }: { path: string; params: Record<string, string | undefined>; next?: string | undefined; offset: number; limit: number; total: number }) {
  const href = (cursor: number) => {
    const sp = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => Boolean(e[1])))
    if (cursor > 0) sp.set("cursor", String(cursor))
    else sp.delete("cursor")
    const s = sp.toString()
    return s ? `${path}?${s}` : path
  }
  if (!total) return null
  return (
    <div className="flex items-center justify-between px-3 py-2 text-xs text-stone-500">
      <span>
        {offset + 1}–{Math.min(offset + limit, total)} of {total}
      </span>
      <span className="flex gap-3">
        {offset > 0 ? <Link href={href(Math.max(0, offset - limit))} className="hover:text-stone-900">← Previous</Link> : null}
        {next ? <Link href={href(Number(next))} className="hover:text-stone-900">Next →</Link> : null}
      </span>
    </div>
  )
}
