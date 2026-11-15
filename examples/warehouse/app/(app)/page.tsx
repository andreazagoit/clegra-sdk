import Link from "next/link"

import { Badge, Empty, KIND_TONES, PageHeader, STOCK_TONES } from "@/components/ui"
import { formatDateTime, formatMoney, formatNumber } from "@/lib/format"
import { MOVEMENT_KIND_LABELS, STOCK_STATUS_LABELS } from "@/lib/labels"
import { requireViewer } from "@/lib/session"
import { listMovements, listOrders, lowStock, outgoingByWeek, stockValue } from "@/lib/warehouse"

export default async function DashboardPage() {
  const viewer = await requireViewer()
  const [value, low, recent, weeks, drafts] = await Promise.all([
    viewer.can("products.cost") ? stockValue(viewer.orgId) : null,
    lowStock(viewer.orgId, 8),
    listMovements(viewer.orgId, { sort: { field: "date", dir: "desc" }, limit: 8 }),
    outgoingByWeek(viewer.orgId, 8),
    viewer.can("orders.view") ? listOrders(viewer.orgId, { filters: { status: "draft" }, limit: 1 }) : null,
  ])
  const peak = Math.max(1, ...weeks.map((w) => w.units))
  return (
    <>
      <PageHeader title="Dashboard">
        <Link href="/embed/stock" target="_blank" className="text-sm text-accent hover:underline">
          Stock board (embeddable) ↗
        </Link>
      </PageHeader>
      <div className="grid gap-4 md:grid-cols-3">
        {value ? (
          <section className="card p-4">
            <h2>Stock value</h2>
            <p className="mt-2 text-2xl font-semibold">{formatMoney(value.value)}</p>
            <p className="text-sm text-stone-500">
              at purchase cost · {formatNumber(value.units)} units of {value.products} products
            </p>
          </section>
        ) : null}
        <section className="card p-4">
          <h2>Under reorder level</h2>
          <p className="mt-2 text-2xl font-semibold">{low.length}</p>
          <p className="text-sm text-stone-500">products to reorder</p>
        </section>
        {drafts ? (
          <section className="card p-4">
            <h2>Draft orders</h2>
            <p className="mt-2 text-2xl font-semibold">{drafts.total}</p>
            <Link href="/orders?status=draft" className="text-sm text-accent hover:underline">
              to confirm →
            </Link>
          </section>
        ) : null}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <section className="card">
          <h2 className="px-4 pt-4">Low stock</h2>
          {low.length ? (
            <table className="table mt-2">
              <tbody>
                {low.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link href={`/products/${p.id}`} className="hover:underline">
                        {p.name}
                      </Link>
                      <div className="text-xs text-stone-500">{p.sku}</div>
                    </td>
                    <td className="text-right tabular-nums">
                      {p.stock} / {p.reorderLevel}
                    </td>
                    <td className="text-right">
                      <Badge tone={STOCK_TONES[p.stockStatus]}>{STOCK_STATUS_LABELS[p.stockStatus].en}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>Every product is above its reorder level.</Empty>
          )}
        </section>

        <section className="card p-4">
          <h2>Units out per week</h2>
          <div className="mt-4 flex h-40 items-end gap-2" role="img" aria-label="Units that left the warehouse in each of the last 8 weeks">
            {weeks.map((w) => (
              <div key={w.week} className="flex flex-1 flex-col items-center gap-1">
                <span className="text-xs tabular-nums text-stone-500">{w.units}</span>
                <div className="w-full rounded-t bg-accent/80" style={{ height: `${Math.max(2, (w.units / peak) * 120)}px` }} />
                <span className="text-[10px] text-stone-400">{w.week.slice(5)}</span>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="card mt-4">
        <div className="flex items-center justify-between px-4 pt-4">
          <h2>Recent movements</h2>
          <Link href="/movements" className="text-sm text-accent hover:underline">
            All movements →
          </Link>
        </div>
        <table className="table mt-2">
          <tbody>
            {recent.rows.map((m) => (
              <tr key={m.id}>
                <td className="whitespace-nowrap text-stone-500">{formatDateTime(m.date)}</td>
                <td>
                  <Badge tone={KIND_TONES[m.kind]}>{MOVEMENT_KIND_LABELS[m.kind].en}</Badge>
                </td>
                <td>
                  <Link href={`/products/${m.product}`} className="hover:underline">
                    {m.summary}
                  </Link>
                </td>
                <td className="text-stone-500">{m.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  )
}
