import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"

import { MovementForm } from "@/components/movement-form"
import { MovementTable } from "@/components/movement-table"
import { Badge, STOCK_TONES } from "@/components/ui"
import { formatMoney } from "@/lib/format"
import { CATEGORY_LABELS, STOCK_STATUS_LABELS, UNIT_LABELS } from "@/lib/labels"
import { requireViewer } from "@/lib/session"
import { getProduct, listMovements, memberNames } from "@/lib/warehouse"

export const metadata: Metadata = { title: "Product" }

export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireViewer()
  const { id } = await params
  const product = await getProduct(viewer.orgId, id)
  if (!product) notFound()
  const movements = await listMovements(viewer.orgId, { filters: { product: product.id }, sort: { field: "date", dir: "desc" }, limit: 50 })
  const people = await memberNames(viewer.orgId, [...new Set(movements.rows.flatMap((m) => (m.by ? [m.by] : [])))])
  const facts: [string, React.ReactNode][] = [
    ["In stock", `${product.stock} ${UNIT_LABELS[product.unit].en}`],
    ["Reorder at", String(product.reorderLevel)],
    ["Sale price", formatMoney(product.salePrice)],
    ...(viewer.can("products.cost") ? ([["Purchase cost", formatMoney(product.purchaseCost)]] as [string, string][]) : []),
    ["Category", CATEGORY_LABELS[product.category].en],
  ]
  return (
    <>
      <Link href="/products" className="text-sm text-stone-500 hover:text-stone-900">
        ← Products
      </Link>
      <div className="mt-2 mb-4 flex flex-wrap items-center gap-3">
        <h1>{product.name}</h1>
        <span className="font-mono text-xs text-stone-500">{product.sku}</span>
        <Badge tone={STOCK_TONES[product.stockStatus]}>{STOCK_STATUS_LABELS[product.stockStatus].en}</Badge>
      </div>
      <dl className="card grid grid-cols-2 gap-4 p-4 sm:grid-cols-5">
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs text-stone-500">{label}</dt>
            <dd className="mt-0.5 font-medium tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      {viewer.can("stock.move") ? (
        <section className="card mt-4 p-4">
          <h2 className="mb-3">Register a movement</h2>
          <MovementForm product={product} />
        </section>
      ) : null}
      <section className="card mt-4">
        <h2 className="px-4 pt-4">Movements</h2>
        <div className="mt-2 overflow-x-auto">
          <MovementTable rows={movements.rows} people={people} showProduct={false} />
        </div>
      </section>
    </>
  )
}
