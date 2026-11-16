import { z } from "zod"

import { kindNameProblem, RECORD_URI } from "../spec/src/kinds"
import { isLabel, type Label } from "./labels"

/**
 * FIELD MEANING (spec §4): what an entity's Zod schema says beyond types,
 * written with `.meta()`. Read back from the schema's JSON Schema, where Zod
 * puts the metadata of every field (merged along `.meta()` chains and
 * through `.optional()`).
 */

export const ROLES = ["title", "subtitle", "status", "amount", "date", "person"] as const
export type Role = (typeof ROLES)[number]
export const TONES = ["neutral", "info", "success", "warning", "danger"] as const
export type Tone = (typeof TONES)[number]

/** The keys a field's `.meta()` may carry. */
export type FieldMeta = {
  role?: Role
  label?: Label
  /** The property of the entity's kind this field holds (spec §3.1): `email`, `vatID`, `startDate`… */
  as?: string
  /** An entity of this app (the field holds a record id), or `{ kind }`: the URI of a record of that kind in any app (spec §3.2). */
  ref?: string | { kind: string }
  permission?: string
  filter?: boolean
  sort?: boolean
  search?: boolean
  labels?: Record<string, Label>
  tones?: Record<string, Tone>
  currency?: string
  untrusted?: boolean
}

export type FieldType = "string" | "number" | "integer" | "boolean" | "array" | "object"

/** One field of an entity, as the SDK and the card know it. */
export type FieldInfo = {
  name: string
  type: FieldType
  required: boolean
  enum?: string[]
  /** The field's JSON Schema without the meaning keys. */
  schema: Record<string, unknown>
} & FieldMeta

const META_KEYS = ["role", "label", "as", "ref", "permission", "filter", "sort", "search", "labels", "tones", "currency", "untrusted"] as const

/**
 * A string field holding the id of another entity's record of this app: `ref("company")`.
 * `ref.kind("organization")`: the URI of a record of that kind in ANY app (spec §3.2), as a field or an action
 * input. The app stores the URI and nothing else of the record; any syntactically valid record URI is accepted
 * (checked), and the app never calls the other app: hosts resolve it, for each viewer.
 */
export const ref = Object.assign(
  function ref(entity: string) {
    return z.string().meta({ ref: entity })
  },
  {
    kind(kind: string) {
      const problem = kindNameProblem(kind)
      if (problem) throw new Error(`ref.kind: ${problem}`)
      return z.string().regex(RECORD_URI, { error: "a record URI: clegra://<app>/<entity>/<id>" }).meta({ ref: { kind } })
    },
  },
)

/** The entity of this app a field (or an input) holds record ids of. */
export const localRef = (meta: { ref?: unknown }): string | undefined => (typeof meta.ref === "string" ? meta.ref : undefined)
/** The kind a cross-app reference holds a record URI of (spec §3.2). */
export function kindRef(meta: { ref?: unknown }): string | undefined {
  const r = meta.ref
  return r && typeof r === "object" && !Array.isArray(r) && typeof (r as { kind?: unknown }).kind === "string" ? (r as { kind: string }).kind : undefined
}

/** JSON Schema of a Zod schema, without `$schema` (the shape tools and the card carry). */
export function jsonSchemaOf(schema: z.ZodType, io: "input" | "output" = "output"): Record<string, unknown> {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema, { io, unrepresentable: "any" }) as Record<string, unknown>
  return rest
}

/** The same JSON Schema with every meaning key removed, at any depth: what plain MCP hosts get. */
export function plainSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(plainSchema)
  if (!schema || typeof schema !== "object") return schema
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(schema)) {
    if ((META_KEYS as readonly string[]).includes(k) && k !== "label") continue
    if (k === "label") {
      if (typeof v === "string") out.title = v
      continue
    }
    out[k] = k === "properties" && v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([p, s]) => [p, plainSchema(s)])) : plainSchema(v)
  }
  return out
}

const typeOf = (s: Record<string, unknown>): FieldType => {
  const t = Array.isArray(s.type) ? s.type.find((x) => x !== "null") : s.type
  if (t === "number" || t === "integer" || t === "boolean" || t === "array" || t === "object") return t
  if (!t && Array.isArray(s.anyOf)) {
    const inner = (s.anyOf as Record<string, unknown>[]).find((x) => x.type !== "null")
    if (inner) return typeOf(inner)
  }
  return "string"
}

/** The fields of an entity's object schema, with their meaning, in declaration order. Throws on meaning that can't be right. */
export function fieldsOf(entity: string, schema: z.ZodObject): FieldInfo[] {
  const json = jsonSchemaOf(schema)
  const properties = (json.properties ?? {}) as Record<string, Record<string, unknown>>
  const required = new Set((json.required as string[] | undefined) ?? [])
  const fields: FieldInfo[] = []
  for (const [name, prop] of Object.entries(properties)) {
    const inner = Array.isArray(prop.anyOf) ? ((prop.anyOf as Record<string, unknown>[]).find((x) => x.type !== "null") ?? prop) : prop
    const merged = { ...inner, ...prop }
    const meta: FieldMeta = {}
    for (const key of META_KEYS) if (merged[key] !== undefined) (meta as Record<string, unknown>)[key] = merged[key]
    const where = `entity "${entity}", field "${name}"`
    if (meta.role !== undefined && !ROLES.includes(meta.role)) throw new Error(`${where}: role must be one of ${ROLES.join(", ")}`)
    if (meta.label !== undefined && !isLabel(meta.label)) throw new Error(`${where}: label must be a string or a map of strings per locale`)
    if (meta.tones) for (const [v, t] of Object.entries(meta.tones)) if (!TONES.includes(t)) throw new Error(`${where}: tone of "${v}" must be one of ${TONES.join(", ")}`)
    if (meta.permission !== undefined && typeof meta.permission !== "string") throw new Error(`${where}: permission must be a permission id`)
    if (meta.ref !== undefined && !localRef(meta) && !kindRef(meta)) throw new Error(`${where}: ref is an entity name or { kind }`)
    const crossKind = kindRef(meta)
    if (crossKind !== undefined && kindNameProblem(crossKind)) throw new Error(`${where}: ref: ${kindNameProblem(crossKind)}`)
    const enumValues = Array.isArray(merged.enum) ? (merged.enum as unknown[]).map(String) : undefined
    const plain = plainSchema(prop) as Record<string, unknown>
    fields.push({ name, type: typeOf(merged), required: required.has(name), ...(enumValues ? { enum: enumValues } : {}), schema: plain, ...meta })
  }
  const id = fields.find((f) => f.name === "id")
  if (!id || id.type !== "string" || !id.required) throw new Error(`entity "${entity}": the schema needs a required string field "id"`)
  for (const role of ROLES) {
    const holders = fields.filter((f) => f.role === role)
    if (holders.length > 1) throw new Error(`entity "${entity}": role "${role}" is on ${holders.map((f) => f.name).join(" and ")}; at most one field per role`)
  }
  if (!fields.some((f) => f.role === "title")) throw new Error(`entity "${entity}": one field needs role "title"`)
  return fields
}
