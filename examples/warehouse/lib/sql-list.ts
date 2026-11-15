import type { Row, Sql } from "./db"

/**
 * One list query in plain SQL: filters, text search, sort, offset cursor,
 * limit — always parameterized. Field names never reach the SQL text: each
 * one is looked up in `columns` (field → SQL expression), and an unknown
 * field is an error.
 */
export type FilterValue = string | number | boolean
export type ListFilter = FilterValue | { in: FilterValue[] } | { gte?: FilterValue; lte?: FilterValue }

/** The shape of a list request (the same as a MAP `Query`, so the pages and the MAP handlers both use it). */
export type ListQuery = {
  filters?: Record<string, ListFilter>
  text?: string
  /** Where `text` is searched (default: the list's `search` fields). */
  textFields?: string[]
  sort?: { field: string; dir: "asc" | "desc" }
  /** An offset, as a string, from a previous page's `next`. */
  cursor?: string
  limit?: number
}

export type ListPage<T> = { rows: T[]; next?: string; total: number }

export class ListError extends Error {}

export type ListSpec = {
  /** `SELECT … FROM …`, without WHERE. */
  select: string
  /** Conditions that always hold (the tenant), with their `$1…` parameters in `params`. */
  where: string[]
  params: unknown[]
  columns: Record<string, string>
  /** The fields searched when a request gives text but no `textFields`. */
  search: string[]
  defaultSort: { field: string; dir: "asc" | "desc" }
  /** A unique column, last in every ORDER BY, so pages never overlap. */
  tieBreak: string
}

export const MAX_LIMIT = 200

export async function listPage<T>(sql: Sql, spec: ListSpec, q: ListQuery, map: (row: Row) => T): Promise<ListPage<T>> {
  const params = [...spec.params]
  const p = (value: unknown) => {
    params.push(value)
    return `$${params.length}`
  }
  const column = (field: string) => {
    const c = spec.columns[field]
    if (!c) throw new ListError(`unknown field "${field}"`)
    return c
  }
  const where = [...spec.where]
  for (const [field, f] of Object.entries(q.filters ?? {})) {
    const c = column(field)
    if (f !== null && typeof f === "object" && "in" in f) where.push(`${c} = ANY(${p(f.in)})`)
    else if (f !== null && typeof f === "object") {
      if (f.gte !== undefined) where.push(`${c} >= ${p(f.gte)}`)
      if (f.lte !== undefined) where.push(`${c} <= ${p(f.lte)}`)
    } else where.push(`${c} = ${p(f)}`)
  }
  const text = q.text?.trim()
  if (text) {
    const fields = q.textFields ?? spec.search
    // No field to search in (all hidden from this caller): nothing matches, rather than everything.
    if (!fields.length) where.push("FALSE")
    else {
      const pattern = p(`%${text.replace(/[\\%_]/g, (m) => `\\${m}`)}%`)
      where.push(`(${fields.map((f) => `${column(f)}::text ILIKE ${pattern}`).join(" OR ")})`)
    }
  }
  const filtered = `${spec.select} WHERE ${where.join(" AND ")}`
  const countParams = [...params]
  const sort = q.sort ?? spec.defaultSort
  const order = `${column(sort.field)} ${sort.dir === "desc" ? "DESC" : "ASC"} NULLS LAST, ${spec.tieBreak} ASC`
  if (q.cursor !== undefined && !/^\d{1,9}$/.test(q.cursor)) throw new ListError("invalid cursor")
  const offset = Number(q.cursor ?? 0)
  const limit = Math.min(Math.max(1, Math.floor(q.limit ?? 50)), MAX_LIMIT)
  const rows = await sql(`${filtered} ORDER BY ${order} LIMIT ${p(limit + 1)} OFFSET ${p(offset)}`, params)
  const counted = await sql<{ count: number }>(`SELECT count(*)::integer AS count FROM (${filtered}) t`, countParams)
  const more = rows.length > limit
  return { rows: rows.slice(0, limit).map(map), total: counted[0]?.count ?? 0, ...(more ? { next: String(offset + limit) } : {}) }
}
