import type { Metadata } from "next"
import Link from "next/link"

import { MovementForm } from "@/components/movement-form"
import { MovementTable } from "@/components/movement-table"
import { PageHeader, Pager } from "@/components/ui"
import { MOVEMENT_KIND_LABELS } from "@/lib/labels"
import { requireViewer } from "@/lib/session"
import { listMovements, listProducts, personNames, MOVEMENT_KINDS, type MovementKind } from "@/lib/warehouse"

export const metadata: Metadata = { title: "Movements" }

const LIMIT = 30

export default async function MovementsPage({ searchParams }: { searchParams: Promise<{ kind?: string; q?: string; cursor?: string }> }) {
  const viewer = await requireViewer()
  const sp = await searchParams
  const kind = MOVEMENT_KINDS.includes(sp.kind as MovementKind) ? (sp.kind as MovementKind) : undefined
  const cursor = sp.cursor && /^\d+$/.test(sp.cursor) ? sp.cursor : undefined
  const [page, products] = await Promise.all([
    listMovements(viewer.orgId, { filters: kind ? { kind } : {}, ...(sp.q ? { text: sp.q } : {}), sort: { field: "date", dir: "desc" }, ...(cursor ? { cursor } : {}), limit: LIMIT }),
    viewer.can("stock.move") ? listProducts(viewer.orgId, { sort: { field: "sku", dir: "asc" }, limit: 200 }) : null,
  ])
  const people = await personNames(viewer.orgId, [...new Set(page.rows.flatMap((m) => (m.by ? [m.by] : [])))])
  return (
    <>
      <PageHeader title="Movements">
        <form className="flex flex-wrap gap-2" action="/movements">
          <input name="q" defaultValue={sp.q} placeholder="Search product or note" className="field w-52" />
          <button className="btn-quiet" type="submit">
            Search
          </button>
        </form>
      </PageHeader>
      {products ? (
        <section className="card mb-4 p-4">
          <h2 className="mb-3">Register a movement</h2>
          <MovementForm products={products.rows} />
        </section>
      ) : null}
      <div className="mb-2 flex gap-1 text-sm">
        {[undefined, ...MOVEMENT_KINDS].map((k) => (
          <Link key={k ?? "all"} href={k ? `/movements?kind=${k}` : "/movements"} className={`rounded-md px-2.5 py-1 ${k === kind ? "bg-stone-900 text-white" : "text-stone-600 hover:bg-stone-200"}`}>
            {k ? MOVEMENT_KIND_LABELS[k].en : "All"}
          </Link>
        ))}
      </div>
      <section className="card overflow-x-auto">
        <MovementTable rows={page.rows} people={people} />
        <Pager path="/movements" params={{ kind, q: sp.q }} next={page.next} offset={Number(cursor ?? 0)} limit={LIMIT} total={page.total} />
      </section>
    </>
  )
}
