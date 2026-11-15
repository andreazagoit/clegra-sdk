import type { Metadata } from "next"
import Link from "next/link"

import { Badge, Empty, ORDER_TONES, PageHeader, Pager } from "@/components/ui"
import { formatDate, formatMoney } from "@/lib/format"
import { ORDER_STATUS_LABELS } from "@/lib/labels"
import { requireViewer } from "@/lib/session"
import { listOrders, ORDER_STATUSES, type OrderStatus } from "@/lib/warehouse"

export const metadata: Metadata = { title: "Orders" }

const LIMIT = 25

export default async function OrdersPage({ searchParams }: { searchParams: Promise<{ status?: string; q?: string; cursor?: string }> }) {
  const viewer = await requireViewer()
  if (!viewer.can("orders.view")) return <Empty>You may not see orders.</Empty>
  const sp = await searchParams
  const status = ORDER_STATUSES.includes(sp.status as OrderStatus) ? (sp.status as OrderStatus) : undefined
  const cursor = sp.cursor && /^\d+$/.test(sp.cursor) ? sp.cursor : undefined
  const page = await listOrders(viewer.orgId, { filters: status ? { status } : {}, ...(sp.q ? { text: sp.q } : {}), ...(cursor ? { cursor } : {}), limit: LIMIT })
  return (
    <>
      <PageHeader title="Orders">
        <form className="flex flex-wrap gap-2" action="/orders">
          {status ? <input type="hidden" name="status" value={status} /> : null}
          <input name="q" defaultValue={sp.q} placeholder="Search number or customer" className="field w-56" />
          <button className="btn-quiet" type="submit">
            Search
          </button>
        </form>
      </PageHeader>
      <div className="mb-2 flex gap-1 text-sm">
        {[undefined, ...ORDER_STATUSES].map((s) => (
          <Link key={s ?? "all"} href={s ? `/orders?status=${s}` : "/orders"} className={`rounded-md px-2.5 py-1 ${s === status ? "bg-stone-900 text-white" : "text-stone-600 hover:bg-stone-200"}`}>
            {s ? ORDER_STATUS_LABELS[s].en : "All"}
          </Link>
        ))}
      </div>
      <section className="card overflow-x-auto">
        {page.rows.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>Number</th>
                <th>Customer</th>
                <th>Date</th>
                <th>Status</th>
                <th className="text-right">Lines</th>
                <th className="text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {page.rows.map((o) => (
                <tr key={o.id}>
                  <td className="font-mono text-xs">
                    <Link href={`/orders/${o.id}`} className="hover:underline">
                      {o.number}
                    </Link>
                  </td>
                  <td>{o.customer}</td>
                  <td className="text-stone-500">{formatDate(o.date)}</td>
                  <td>
                    <Badge tone={ORDER_TONES[o.status]}>{ORDER_STATUS_LABELS[o.status].en}</Badge>
                  </td>
                  <td className="text-right tabular-nums text-stone-500">{o.lineCount}</td>
                  <td className="text-right tabular-nums">{formatMoney(o.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>No order matches.</Empty>
        )}
        <Pager path="/orders" params={{ status, q: sp.q }} next={page.next} offset={Number(cursor ?? 0)} limit={LIMIT} total={page.total} />
      </section>
    </>
  )
}
