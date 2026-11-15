import type { Metadata } from "next"
import Link from "next/link"

import { Badge, Empty, PageHeader, Pager, STOCK_TONES } from "@/components/ui"
import { formatMoney } from "@/lib/format"
import { CATEGORY_LABELS, STOCK_STATUS_LABELS, UNIT_LABELS } from "@/lib/labels"
import { requireViewer } from "@/lib/session"
import { CATEGORIES, listProducts, STOCK_STATUSES, type Category, type StockStatus } from "@/lib/warehouse"

export const metadata: Metadata = { title: "Products" }

const LIMIT = 25
type Search = { q?: string; category?: string; status?: string; sort?: string; dir?: string; cursor?: string }

export default async function ProductsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const viewer = await requireViewer()
  const sp = await searchParams
  const cost = viewer.can("products.cost")
  const sortable = ["sku", "name", "stock", "salePrice", ...(cost ? ["purchaseCost"] : [])]
  const sort = sp.sort && sortable.includes(sp.sort) ? { field: sp.sort, dir: sp.dir === "desc" ? ("desc" as const) : ("asc" as const) } : undefined
  const category = CATEGORIES.includes(sp.category as Category) ? (sp.category as Category) : undefined
  const status = STOCK_STATUSES.includes(sp.status as StockStatus) ? (sp.status as StockStatus) : undefined
  const cursor = sp.cursor && /^\d+$/.test(sp.cursor) ? sp.cursor : undefined
  const page = await listProducts(viewer.orgId, {
    filters: { ...(category ? { category } : {}), ...(status ? { stockStatus: status } : {}) },
    ...(sp.q ? { text: sp.q } : {}),
    ...(sort ? { sort } : {}),
    ...(cursor ? { cursor } : {}),
    limit: LIMIT,
  })
  const keep = { q: sp.q, category, status, sort: sort?.field, dir: sort?.dir }
  const sortHref = (field: string) => {
    const dir = sort?.field === field && sort.dir === "asc" ? "desc" : "asc"
    const params = new URLSearchParams(Object.entries({ ...keep, sort: field, dir }).filter((e): e is [string, string] => Boolean(e[1])))
    return `/products?${params}`
  }
  const Th = ({ field, children, right }: { field: string; children: React.ReactNode; right?: boolean }) => (
    <th className={right ? "text-right" : undefined}>
      <Link href={sortHref(field)} className="hover:text-stone-900">
        {children}
        {sort?.field === field ? (sort.dir === "asc" ? " ↑" : " ↓") : ""}
      </Link>
    </th>
  )
  return (
    <>
      <PageHeader title="Products">
        <form className="flex flex-wrap gap-2" action="/products">
          <input name="q" defaultValue={sp.q} placeholder="Search name or SKU" className="field w-48" />
          <select name="category" defaultValue={category ?? ""} className="field">
            <option value="">All categories</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c].en}
              </option>
            ))}
          </select>
          <select name="status" defaultValue={status ?? ""} className="field">
            <option value="">Any stock</option>
            {STOCK_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STOCK_STATUS_LABELS[s].en}
              </option>
            ))}
          </select>
          <button className="btn-quiet" type="submit">
            Filter
          </button>
        </form>
      </PageHeader>
      <section className="card overflow-x-auto">
        {page.rows.length ? (
          <table className="table">
            <thead>
              <tr>
                <Th field="sku">SKU</Th>
                <Th field="name">Name</Th>
                <th>Category</th>
                <Th field="stock" right>
                  Stock
                </Th>
                <th className="text-right">Reorder at</th>
                <th>Status</th>
                <Th field="salePrice" right>
                  Price
                </Th>
                {cost ? (
                  <Th field="purchaseCost" right>
                    Cost
                  </Th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {page.rows.map((p) => (
                <tr key={p.id}>
                  <td className="font-mono text-xs text-stone-500">{p.sku}</td>
                  <td>
                    <Link href={`/products/${p.id}`} className="hover:underline">
                      {p.name}
                    </Link>
                  </td>
                  <td className="text-stone-600">{CATEGORY_LABELS[p.category].en}</td>
                  <td className="text-right tabular-nums">
                    {p.stock} <span className="text-xs text-stone-400">{UNIT_LABELS[p.unit].en}</span>
                  </td>
                  <td className="text-right tabular-nums text-stone-500">{p.reorderLevel}</td>
                  <td>
                    <Badge tone={STOCK_TONES[p.stockStatus]}>{STOCK_STATUS_LABELS[p.stockStatus].en}</Badge>
                  </td>
                  <td className="text-right tabular-nums">{formatMoney(p.salePrice)}</td>
                  {cost ? <td className="text-right tabular-nums text-stone-600">{formatMoney(p.purchaseCost)}</td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>No product matches.</Empty>
        )}
        <Pager path="/products" params={keep} next={page.next} offset={Number(cursor ?? 0)} limit={LIMIT} total={page.total} />
      </section>
    </>
  )
}
