import type { Metadata } from "next"
import Link from "next/link"

import { PageHeader } from "@/components/ui"
import { STOCK_STATUS_LABELS } from "@/lib/labels"
import { requireViewer } from "@/lib/session"
import { listProducts, type StockStatus } from "@/lib/warehouse"

export const metadata: Metadata = { title: "Stock board" }

const BAR: Record<StockStatus, string> = { ok: "bg-teal-600", low: "bg-amber-500", out: "bg-red-600" }

/**
 * Every product's stock against its reorder level, the most urgent first. A page of the warehouse like the others:
 * for its own users, and for a Clegra client's person when the warehouse is shown as its site there (lib/session.ts).
 */
export default async function StockBoardPage() {
  const viewer = await requireViewer()
  if (!viewer.can("products.view")) return <p className="text-stone-600">You may not see the stock.</p>
  const { rows } = await listProducts(viewer.orgId, { sort: { field: "stock", dir: "asc" }, limit: 200 })
  const ordered = [...rows].sort((a, b) => a.stock / Math.max(a.reorderLevel, 1) - b.stock / Math.max(b.reorderLevel, 1))
  const counts = { ok: 0, low: 0, out: 0 }
  for (const p of rows) counts[p.stockStatus]++
  return (
    <>
      <PageHeader title="Stock board">
        <p className="flex gap-3 text-xs text-stone-500">
          {(["out", "low", "ok"] as const).map((s) => (
            <span key={s} className="flex items-center gap-1">
              <span className={`inline-block size-2 rounded-full ${BAR[s]}`} /> {STOCK_STATUS_LABELS[s].en} {counts[s]}
            </span>
          ))}
        </p>
      </PageHeader>
      <section className="card p-4">
        <ul className="flex flex-col gap-1.5" data-board data-viewer={viewer.name}>
          {ordered.map((p) => {
            // The bar's full width is twice the reorder level; the tick marks the level itself.
            const scale = Math.max(p.reorderLevel * 2, p.stock, 1)
            return (
              <li key={p.id} className="grid grid-cols-[minmax(8rem,14rem)_1fr_3.5rem] items-center gap-2" title={`${p.name}: ${p.stock} in stock, reorder at ${p.reorderLevel}`}>
                <Link href={`/products/${p.id}`} className="truncate text-stone-700 hover:underline">
                  {p.name}
                </Link>
                <span className="relative h-3 rounded bg-stone-100">
                  <span className={`absolute inset-y-0 left-0 rounded ${BAR[p.stockStatus]}`} style={{ width: `${(Math.max(p.stock, 0) / scale) * 100}%` }} />
                  <span className="absolute -inset-y-0.5 w-px bg-stone-900" style={{ left: `${(p.reorderLevel / scale) * 100}%` }} />
                </span>
                <span className="text-right tabular-nums text-stone-600">
                  {p.stock}/{p.reorderLevel}
                </span>
              </li>
            )
          })}
        </ul>
      </section>
    </>
  )
}
