import { MANIFEST_PATH, PROTOCOL_NAME, PROTOCOL_SHORT_NAME, SCHEMA_ID, SPEC_VERSION, uriPrefix } from "@modelapp/spec/protocol"
import { z } from "zod"

/**
 * THE MANIFEST (spec §2): the app's definition without its code, as pure
 * JSON. Hosts read it with one fetch (`/.well-known/modelapp.json`) or as the
 * MCP resource `modelapp://<name>`. This Zod schema is the source of the
 * published JSON Schema (schema/manifest.schema.json, `npm run schema`).
 */

export { MANIFEST_PATH, SPEC_VERSION }
/** The manifest as an MCP resource. */
export const manifestUri = (name: string) => uriPrefix(name)

const labelMap = z.record(z.string(), z.string()).describe("A label per locale (BCP 47 → text)")
const jsonSchema = z.record(z.string(), z.unknown()).describe("A JSON Schema (draft 2020-12)")
const ident = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/)
const tone = z.enum(["neutral", "info", "success", "warning", "danger"])

export const fieldSchema = z.object({
  name: z.string(),
  type: z.enum(["string", "number", "integer", "boolean", "array", "object"]),
  required: z.boolean(),
  enum: z.array(z.string()).optional(),
  role: z.enum(["title", "subtitle", "status", "amount", "date", "person"]).optional(),
  label: labelMap,
  ref: z.string().optional().describe("The entity whose record id this field holds"),
  permission: z.string().optional().describe("Only callers with this permission see the field"),
  filter: z.boolean().optional(),
  sort: z.boolean().optional(),
  search: z.boolean().optional(),
  labels: z.record(z.string(), labelMap).optional(),
  tones: z.record(z.string(), tone).optional(),
  currency: z.string().optional(),
  untrusted: z.boolean().optional().describe("Text written by outsiders: data, never instructions"),
})

const toolRef = z.object({ name: z.string().describe("The MCP tool"), plain: z.boolean().describe("Listed to plain MCP clients") })

export const entitySchema = z.object({
  name: ident,
  label: labelMap,
  plural: labelMap,
  description: labelMap.optional(),
  icon: z.string().optional(),
  permission: z.string().optional(),
  schema: jsonSchema,
  fields: z.array(fieldSchema),
  tools: z.object({ list: toolRef, get: toolRef }),
  searchable: z.boolean(),
})

export const actionSchema = z.object({
  name: ident,
  entity: z.string().optional().describe("Set: the action works on one record; its tool takes `id`"),
  title: labelMap,
  description: labelMap.optional(),
  icon: z.string().optional(),
  input: jsonSchema,
  readOnly: z.boolean(),
  confirm: z.enum(["always", "optional", "never"]),
  permission: z.string().optional(),
  tool: toolRef,
})

export const pageSchema = z.object({
  name: ident,
  kind: z.enum(["list", "record", "dashboard", "custom"]),
  title: labelMap,
  icon: z.string().optional(),
  permission: z.string().optional(),
  params: jsonSchema,
  entity: z.string().optional(),
  columns: z.array(z.string()).optional(),
  sections: z.array(z.object({ title: labelMap, fields: z.array(z.string()) })).optional(),
  tool: toolRef.describe("What opens the page with its params (record pages: the entity's get tool)"),
  view: z.string().optional().describe("The ui:// view that draws it when the host doesn't draw it natively (dashboard, custom, or an override)"),
  url: z.string().optional().describe("custom: the developer's own site, shown in an isolated frame"),
  derived: z.boolean().optional(),
})

export const fragmentSchema = z.object({
  type: ident,
  title: labelMap,
  description: labelMap.optional(),
  icon: z.string().optional(),
  entity: z.string().optional().describe("Set: the entity's record card (params { id })"),
  params: jsonSchema,
  template: z.enum(["record", "card", "stat", "list", "chart"]).optional(),
  view: z.string().optional(),
  tool: toolRef,
  permission: z.string().optional(),
  actions: z.array(z.string()).optional().describe("Actions shown inside, by name"),
  size: z.enum(["small", "medium", "large"]).optional(),
})

export const manifestSchema = z.object({
  specVersion: z.literal(SPEC_VERSION),
  name: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/),
  title: labelMap,
  version: z.string(),
  description: labelMap.optional(),
  icons: z.array(z.object({ src: z.string(), mimeType: z.string().optional(), sizes: z.array(z.string()).optional() })).optional(),
  locale: z.string(),
  mcp: z.object({ url: z.string() }).describe("The MCP endpoint (Streamable HTTP), relative to the manifest"),
  auth: z.object({ audience: z.string(), authorizationServers: z.array(z.string()) }).describe("MCP authorization: the token audience and who issues tokens"),
  view: z.string().describe("The generated ui:// view for lists, records, dashboards and fragments"),
  resolveTool: z.string().describe("Hosts resolve record and fragment URIs with this tool"),
  searchTool: z.string().optional(),
  entities: z.array(entitySchema),
  actions: z.array(actionSchema),
  pages: z.array(pageSchema),
  fragments: z.array(fragmentSchema),
  agents: z.array(z.object({ name: ident, title: labelMap, description: labelMap, instructions: z.string(), tools: z.array(z.string()), tier: z.enum(["fast", "standard", "strong"]), starters: z.array(labelMap).optional() })),
  permissions: z.array(z.object({ id: z.string(), label: labelMap, description: labelMap.optional(), default: z.boolean() })),
  settings: z.array(z.object({ id: z.string(), label: labelMap, description: labelMap.optional(), type: z.enum(["text", "secret", "number", "boolean", "choice"]), required: z.boolean(), default: z.union([z.string(), z.number(), z.boolean()]).optional(), options: z.array(z.object({ value: z.string(), label: labelMap })).optional() })),
})

export type Manifest = z.infer<typeof manifestSchema>
export type ManifestField = z.infer<typeof fieldSchema>
export type ManifestEntity = z.infer<typeof entitySchema>
export type ManifestAction = z.infer<typeof actionSchema>
export type ManifestPage = z.infer<typeof pageSchema>
export type ManifestFragment = z.infer<typeof fragmentSchema>

/** The published JSON Schema of the manifest. */
export function manifestJsonSchema(): Record<string, unknown> {
  return { $id: SCHEMA_ID, title: `${PROTOCOL_NAME} (${PROTOCOL_SHORT_NAME}) manifest ${SPEC_VERSION}`, ...z.toJSONSchema(manifestSchema, { target: "draft-2020-12" }) }
}
