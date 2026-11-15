import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"

import { cancelOrderAction, confirmOrderAction } from "@/app/actions"
import { ActionForm } from "@/components/action-form"
import { Badge, Empty, ORDER_TONES } from "@/components/ui"
import { formatDate, formatDateTime, formatMoney } from "@/lib/format"
import { ORDER_STATUS_LABELS } from "@/lib/labels"
import { requireViewer } from "@/lib/session"
import { getOrder, listProducts } from "@/lib/warehouse"

export const metadata: Metadata = { title: "Order" }

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireViewer()
  if (!viewer.can("orders.view")) return <Empty>You may not see orders.</Empty>
  const { id } = await params
  const order = await getOrder(viewer.orgId, id)
  if (!order) notFound()
  const lines = order.lines ?? []
  // Stock of the order's products, to show what confirming would take.
  const stock = new Map((await listProducts(viewer.orgId, { filters: { id: { in: [...new Set(lines.map((l) => l.product))] } }, limit: 50 })).rows.map((p) => [p.id, p.stock]))
  const draft = order.status === "draft"
  return (
    <>
      <Link href="/orders" className="text-sm text-stone-500 hover:text-stone-900">
        ← Orders
      </Link>
      <div className="mt-2 mb-4 flex flex-wrap items-center gap-3">
        <h1>Order {order.number}</h1>
        <Badge tone={ORDER_TONES[order.status]}>{ORDER_STATUS_LABELS[order.status].en}</Badge>
        {order.confirmedAt ? <span className="text-sm text-stone-500">goods out {formatDateTime(order.confirmedAt)}</span> : null}
      </div>
      <dl className="card grid grid-cols-2 gap-4 p-4 sm:grid-cols-3">
        <div>
          <dt className="text-xs text-stone-500">Customer</dt>
          <dd className="mt-0.5 font-medium">{order.customer}</dd>
        </div>
        <div>
          <dt className="text-xs text-stone-500">Date</dt>
          <dd className="mt-0.5 font-medium">{formatDate(order.date)}</dd>
        </div>
        <div>
          <dt className="text-xs text-stone-500">Total</dt>
          <dd className="mt-0.5 font-medium tabular-nums">{formatMoney(order.total)}</dd>
        </div>
      </dl>
      <section className="card mt-4 overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Product</th>
              <th className="text-right">Quantity</th>
              {draft ? <th className="text-right">In stock</th> : null}
              <th className="text-right">Price</th>
              <th className="text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const have = stock.get(l.product) ?? 0
              return (
                <tr key={i}>
                  <td>
                    <Link href={`/products/${l.product}`} className="hover:underline">
                      {l.productName}
                    </Link>
                  </td>
                  <td className="text-right tabular-nums">{l.quantity}</td>
                  {draft ? <td className={`text-right tabular-nums ${have < l.quantity ? "font-medium text-red-700" : "text-stone-500"}`}>{have}</td> : null}
                  <td className="text-right tabular-nums">{formatMoney(l.unitPrice)}</td>
                  <td className="text-right tabular-nums">{formatMoney(l.unitPrice * l.quantity)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </section>
      {draft && viewer.can("orders.manage") ? (
        <section className="card mt-4 flex flex-wrap items-start gap-6 p-4">
          <ActionForm action={confirmOrderAction} submit="Confirm order">
            <input type="hidden" name="orderId" value={order.id} />
            <p className="mb-2 max-w-md text-sm text-stone-600">Confirming takes the goods out of the warehouse, all lines at once.</p>
          </ActionForm>
          <ActionForm action={cancelOrderAction} submit="Cancel draft" quiet>
            <input type="hidden" name="orderId" value={order.id} />
            <p className="mb-2 text-sm text-stone-600">Nothing moves.</p>
          </ActionForm>
        </section>
      ) : null}
      {draft && !viewer.can("orders.manage") ? <p className="mt-4 text-sm text-stone-500">An admin confirms orders.</p> : null}
    </>
  )
}
