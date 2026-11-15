import Link from "next/link"

import { Badge, Empty, KIND_TONES } from "@/components/ui"
import { formatDateTime } from "@/lib/format"
import { MOVEMENT_KIND_LABELS } from "@/lib/labels"
import type { Movement } from "@/lib/warehouse"

export function MovementTable({ rows, people, showProduct = true }: { rows: Movement[]; people: Record<string, string>; showProduct?: boolean }) {
  if (!rows.length) return <Empty>No movements.</Empty>
  return (
    <table className="table">
      <thead>
        <tr>
          <th>When</th>
          <th>Kind</th>
          <th>{showProduct ? "Movement" : "Quantity"}</th>
          <th>Note</th>
          <th>By</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((m) => (
          <tr key={m.id}>
            <td className="whitespace-nowrap text-stone-500">{formatDateTime(m.date)}</td>
            <td>
              <Badge tone={KIND_TONES[m.kind]}>{MOVEMENT_KIND_LABELS[m.kind].en}</Badge>
            </td>
            <td>
              {showProduct ? (
                <Link href={`/products/${m.product}`} className="hover:underline">
                  {m.summary}
                </Link>
              ) : (
                <span className="tabular-nums">{m.summary.split(" ")[0]}</span>
              )}
            </td>
            <td className="text-stone-600">
              {m.order ? (
                <Link href={`/orders/${m.order}`} className="hover:underline">
                  {m.note}
                </Link>
              ) : (
                m.note
              )}
            </td>
            <td className="text-stone-500">{m.by ? (people[m.by] ?? "Former member") : ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
