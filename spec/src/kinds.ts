/**
 * KINDS (spec §3.1): what an entity is, the same in every app. The vocabulary
 * of this spec version (published as `spec/kinds.json`, written from this file
 * by `npm run schema`) and the rules every manifest is checked against. The SDK
 * (at definition time) and the conformance checks (from outside) use the same
 * functions, so the two never disagree. No dependencies.
 */

import { URI_SCHEME } from "./protocol"

/** What a property holds. `date`: an RFC 3339 date or date-time string; `address`: a string or a schema.org PostalAddress object; `money`: a number whose field names its `currency`. */
export const PROPERTY_TYPES = ["string", "number", "boolean", "date", "address", "money"] as const
export type PropertyType = (typeof PROPERTY_TYPES)[number]

/** How a key's values are compared (spec §3.1 rule 5). */
export type Normalisation = "lowercase" | "uppercase-no-spaces" | "digits" | "exact"

export type PropertyDef = { type: PropertyType; many?: boolean; key?: boolean }
export type StandardProperty = PropertyDef & { normalise?: Normalisation }
export type KindDef = { label: Record<string, string>; properties: Record<string, PropertyDef> }
export type StandardKind = { label: Record<string, string>; properties: Record<string, StandardProperty>; required: string[] }

/** The seven kinds of 1.0. Property names are schema.org's, verbatim (JSCalendar's where schema.org has none: `due`, `uid`). */
export const KINDS: Record<string, StandardKind> = {
  person: {
    label: { en: "Person", it: "Persona" },
    properties: {
      givenName: { type: "string" },
      familyName: { type: "string" },
      email: { type: "string", many: true, key: true, normalise: "lowercase" },
      telephone: { type: "string", many: true },
      jobTitle: { type: "string" },
      worksFor: { type: "string" },
      address: { type: "address" },
      image: { type: "string" },
    },
    required: [],
  },
  organization: {
    label: { en: "Organization", it: "Organizzazione" },
    properties: {
      legalName: { type: "string" },
      email: { type: "string", many: true },
      telephone: { type: "string", many: true },
      url: { type: "string" },
      address: { type: "address" },
      vatID: { type: "string", key: true, normalise: "uppercase-no-spaces" },
      taxID: { type: "string" },
    },
    required: [],
  },
  event: {
    label: { en: "Event", it: "Evento" },
    properties: {
      startDate: { type: "date" },
      endDate: { type: "date" },
      location: { type: "address" },
      attendee: { type: "string", many: true },
      organizer: { type: "string" },
      uid: { type: "string", key: true, normalise: "exact" },
    },
    required: ["startDate"],
  },
  task: {
    label: { en: "Task", it: "Attività" },
    properties: {
      due: { type: "date" },
      startDate: { type: "date" },
      completed: { type: "boolean" },
      assignee: { type: "string" },
    },
    required: [],
  },
  document: {
    label: { en: "Document", it: "Documento" },
    properties: {
      url: { type: "string" },
      encodingFormat: { type: "string" },
      author: { type: "string" },
      contentSize: { type: "string" },
    },
    required: [],
  },
  product: {
    label: { en: "Product", it: "Prodotto" },
    properties: {
      sku: { type: "string" },
      gtin: { type: "string", key: true, normalise: "digits" },
      brand: { type: "string" },
      price: { type: "money" },
    },
    required: [],
  },
  order: {
    label: { en: "Order", it: "Ordine" },
    properties: {
      orderNumber: { type: "string" },
      orderDate: { type: "date" },
      customer: { type: "string" },
      totalPrice: { type: "money" },
    },
    required: [],
  },
}

/** Properties any entity MAY mark, with or without a kind. On a kind that defines the same name (`url` of organization and document), the kind's meaning applies. */
export const UNIVERSAL: Record<string, PropertyDef> = {
  url: { type: "string" },
  dateCreated: { type: "date" },
  dateModified: { type: "date" },
}

/** Reserved for later versions: not kinds of 1.0, and no app may use them. */
export const RESERVED_KINDS = ["message", "place", "invoice", "project"] as const

/** A third party's kind: reverse-DNS under a domain it controls, at least one dot (`com.acme.shipment`). */
export const NAMESPACED_KIND = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/
/** A property name of a namespaced kind. */
export const PROPERTY_NAME = /^[a-z][A-Za-z0-9]{0,63}$/
/** A record URI, `clegra://<app>/<entity>/<id>` (spec §3): what a cross-app reference holds. */
export const RECORD_URI = new RegExp(`^${URI_SCHEME}://[a-z][a-z0-9-]{1,39}/[a-z][a-z0-9_]{0,39}/[^/?#\\s]+$`)

/** The published vocabulary (`spec/kinds.json`). */
export function kindsDocument(specVersion: string) {
  return { specVersion, kinds: KINDS, universal: UNIVERSAL, reserved: [...RESERVED_KINDS] }
}

// ------------------------------------------------------------------ names and keys

export type EntityKind = string | { by: string; map: Record<string, string> }

/** The kinds an entity's records can have, in declaration order, without repeats. */
export function kindsOf(kind: EntityKind | undefined): string[] {
  if (kind === undefined) return []
  return typeof kind === "string" ? [kind] : [...new Set(Object.values(kind.map))]
}

/** The kind of one record (null: the record has none, e.g. an unmapped value). */
export function kindOfRecord(kind: EntityKind | undefined, row: Record<string, unknown>): string | null {
  if (kind === undefined) return null
  if (typeof kind === "string") return kind
  const value = row[kind.by]
  return typeof value === "string" && Object.hasOwn(kind.map, value) ? kind.map[value]! : null
}

/** The fixed sentence that ends an entity tool's description (spec §6): `Kind: person.`, `Kind: organization or person (by type).` */
export function kindSentence(kind: EntityKind): string {
  const names = kindsOf(kind)
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}` : names[0]
  return typeof kind === "string" ? `Kind: ${list}.` : `Kind: ${list} (by ${kind.by}).`
}

/** A kind's definition: the standard one, or the app's own for a namespaced kind (undefined: unknown). */
function definitionOf(name: string, own: Record<string, KindDef> | undefined): { properties: Record<string, StandardProperty>; required: string[] } | undefined {
  if (Object.hasOwn(KINDS, name)) return KINDS[name]
  if (NAMESPACED_KIND.test(name) && own && Object.hasOwn(own, name)) return { properties: own[name]!.properties, required: [] }
  return undefined
}

/** What is wrong with a kind name (null: nothing). */
export function kindNameProblem(name: unknown): string | null {
  if (typeof name !== "string") return "a kind is a string"
  if ((RESERVED_KINDS as readonly string[]).includes(name)) return `kind "${name}" is reserved, not defined in this version`
  if (Object.hasOwn(KINDS, name)) return null
  if (NAMESPACED_KIND.test(name)) return null
  return `kind "${name}" is not a kind of this specification (${Object.keys(KINDS).join(", ")}); a third party's kind has a dot (com.example.${name})`
}

/** The definition of a property on any of these kinds, or a universal one (undefined: none). */
export function propertyOf(property: string, kinds: string[], own?: Record<string, KindDef>): PropertyDef | undefined {
  for (const k of kinds) {
    const p = definitionOf(k, own)?.properties[property]
    if (p) return p
  }
  return Object.hasOwn(UNIVERSAL, property) ? UNIVERSAL[property] : undefined
}

// ------------------------------------------------------------------ values (spec §3.1 rule 4)

const POSTAL_ADDRESS = new Set(["@type", "streetAddress", "postOfficeBoxNumber", "addressLocality", "addressRegion", "postalCode", "addressCountry", "name"])
const RFC3339 = /^\d{4}-\d{2}-\d{2}([Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2}))?$/

/** What is wrong with one value of a property (null: nothing). `email` an addr-spec; `vatID` the country prefix and number, no spaces; `gtin` 8, 12, 13 or 14 digits; dates RFC 3339; `address` a string or a PostalAddress. */
export function valueProblem(property: string, def: PropertyDef, value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (property === "email") return typeof value === "string" && /^[^\s@]+@[^\s@]+$/.test(value) ? null : "not an email address"
  if (property === "vatID") return typeof value === "string" && /^[A-Za-z]{2}[0-9A-Za-z+*.]{2,13}$/.test(value) ? null : "not a VAT number (country prefix and number, no spaces)"
  if (property === "gtin") return typeof value === "string" && /^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(value) ? null : "not a GTIN (8, 12, 13 or 14 digits)"
  if (def.type === "date") return typeof value === "string" && RFC3339.test(value) && !Number.isNaN(Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value)) ? null : "not an RFC 3339 date or date-time"
  if (def.type === "address") return typeof value === "string" || (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((k) => POSTAL_ADDRESS.has(k))) ? null : "not an address (a string or a PostalAddress)"
  if (def.type === "number" || def.type === "money") return typeof value === "number" && Number.isFinite(value) ? null : "not a number"
  if (def.type === "boolean") return typeof value === "boolean" ? null : "not a boolean"
  return typeof value === "string" ? null : "not a string"
}

/** How a key property's values are compared; null when the property is not a key of any of these kinds. */
export function keyOf(property: string, kinds: string[], own?: Record<string, KindDef>): Normalisation | null {
  for (const k of kinds) {
    const p = definitionOf(k, own)?.properties[property]
    if (p?.key) return (p as StandardProperty).normalise ?? "exact"
  }
  return null
}

/** A key value as it is compared (spec §3.1 rule 5); null when it can't be one (a gtin with letters). */
export function normaliseKey(value: string, how: Normalisation): string | null {
  if (how === "lowercase") return value.toLowerCase()
  if (how === "uppercase-no-spaces") return value.replace(/\s+/g, "").toUpperCase()
  if (how === "digits") {
    const digits = value.replace(/[\s-]+/g, "")
    return /^\d+$/.test(digits) ? digits : null
  }
  return value
}

// ------------------------------------------------------------------ the rules of §3.1, on manifest-shaped data

/** A field as the rules need it: the manifest's keys, and the item type of an array (from the entity's JSON Schema). */
export type KindField = { name: string; type: string; required: boolean; enum?: string[]; permission?: string; as?: string; filter?: boolean; currency?: string; itemType?: string }

const fits = (t: PropertyType, field: KindField, many: boolean): boolean => {
  const one = (type: string | undefined): boolean => {
    if (t === "string" || t === "date") return type === "string"
    if (t === "number") return type === "number" || type === "integer"
    if (t === "money") return (type === "number" || type === "integer") && typeof field.currency === "string" && field.currency.length > 0
    if (t === "boolean") return type === "boolean"
    return type === "string" || type === "object"
  }
  if (field.type === "array") return many && (field.itemType === undefined ? t === "string" || t === "date" : one(field.itemType))
  return one(field.type)
}

const typeName = (t: PropertyType, many: boolean) => `${t === "money" ? "a number with a currency" : t === "date" ? "a date string" : t === "address" ? "a string or an object" : `a ${t}`}${many ? " (or an array of them)" : ""}`

/** What is wrong with an app's own kind definitions (`kinds` in the manifest). */
export function kindDefinitionProblems(own: Record<string, KindDef> | undefined): string[] {
  const problems: string[] = []
  for (const [name, def] of Object.entries(own ?? {})) {
    if (!NAMESPACED_KIND.test(name)) problems.push(`kinds: "${name}" is not a namespaced kind (com.example.thing); kinds without a dot are this specification's`)
    if (!def || typeof def !== "object" || !def.properties || typeof def.properties !== "object") {
      problems.push(`kinds: "${name}" needs properties`)
      continue
    }
    for (const [p, d] of Object.entries(def.properties)) {
      if (!PROPERTY_NAME.test(p)) problems.push(`kinds: "${name}": property "${p}" is not a name ([a-z][A-Za-z0-9]*)`)
      if (!d || !(PROPERTY_TYPES as readonly string[]).includes(d.type)) problems.push(`kinds: "${name}": property "${p}" needs a type, one of ${PROPERTY_TYPES.join(", ")}`)
      else if (d.key && d.type !== "string") problems.push(`kinds: "${name}": key "${p}" must be a string property`)
    }
  }
  return problems
}

/**
 * What is wrong with one entity's kind and its fields' `as` (spec §3.1 rules 1–5). `where` prefixes every problem.
 * The same list is a definition error in the SDK and a failed check in conformance.
 */
export function entityKindProblems(where: string, kind: EntityKind | undefined, fields: KindField[], own?: Record<string, KindDef>, options: { names?: boolean } = {}): string[] {
  const problems: string[] = []
  const kinds: string[] = []
  if (kind !== undefined) {
    if (typeof kind === "string") kinds.push(kind)
    else if (!kind || typeof kind !== "object" || typeof kind.by !== "string" || !kind.map || typeof kind.map !== "object") problems.push(`${where}: kind is a kind name or { by, map }`)
    else {
      const by = fields.find((f) => f.name === kind.by)
      if (!by) problems.push(`${where}: kind.by "${kind.by}" is not a field`)
      else {
        if (!by.required || !by.enum?.length) problems.push(`${where}: kind.by "${kind.by}" must be a required enum field`)
        if (by.permission) problems.push(`${where}: kind.by "${kind.by}" can't have a permission (a record's kind is seen with the record)`)
        for (const v of by.enum ?? []) if (!Object.hasOwn(kind.map, v)) problems.push(`${where}: kind.map gives no kind for "${v}"`)
        for (const v of Object.keys(kind.map)) if (by.enum && !by.enum.includes(v)) problems.push(`${where}: kind.map: "${v}" is not a value of ${kind.by}`)
      }
      kinds.push(...new Set(Object.values(kind.map)))
    }
  }
  if (options.names !== false)
    for (const k of kinds) {
      const p = kindNameProblem(k)
      if (p) problems.push(`${where}: ${p}`)
    }
  const defined = kinds.map((k) => ({ name: k, def: definitionOf(k, own) }))
  const counts = new Map<string, string[]>()
  for (const f of fields) {
    if (f.as === undefined) continue
    const at = `${where}, field "${f.name}"`
    if (typeof f.as !== "string" || !f.as) {
      problems.push(`${at}: as names a property`)
      continue
    }
    const holders = defined.filter((d) => d.def && Object.hasOwn(d.def.properties, f.as!))
    const universal = Object.hasOwn(UNIVERSAL, f.as) ? UNIVERSAL[f.as] : undefined
    if (!holders.length && !universal) {
      problems.push(kinds.length ? `${at}: as "${f.as}" is not a property of kind ${kinds.join(" or ")} (nor url, dateCreated, dateModified)` : `${at}: as "${f.as}" needs a kind on the entity (without one only url, dateCreated, dateModified)`)
      continue
    }
    const defs = holders.length ? holders.map((h) => h.def!.properties[f.as!]!) : [universal!]
    for (const d of defs) if (!fits(d.type, f, Boolean(d.many))) problems.push(`${at}: as "${f.as}" holds ${typeName(d.type, Boolean(d.many))}; the field is ${f.type === "array" ? `an array of ${f.itemType ?? "values"}` : `a ${f.type}`}${d.type === "money" && !f.currency ? " without a currency" : ""}`)
    if (defs.some((d) => d.key) && !f.filter) problems.push(`${at}: as "${f.as}" is a key of its kind: the field needs filter: true`)
    const list = counts.get(f.as) ?? []
    list.push(f.name)
    counts.set(f.as, list)
  }
  for (const [property, names] of counts) {
    if (names.length < 2) continue
    const many = defined.some((d) => d.def?.properties[property]?.many)
    if (!many) problems.push(`${where}: as "${property}" is on ${names.join(" and ")}; it is single-valued, so at most one field holds it`)
  }
  for (const d of defined) for (const r of d.def?.required ?? []) if (!counts.has(r)) problems.push(`${where}: kind ${d.name} requires a field with as "${r}"`)
  return problems
}
