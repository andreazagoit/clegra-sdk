import { PROPERTY_TYPES } from "../spec/src/kinds"
import { APP_ACCENTS, DEFAULT_APP_ACCENT, EXPORT_TOOL, DELETE_TOOL, INSTALLATION_TOOL, LATER_TOOL, MANIFEST_PATH, SCHEMA_ID, SPEC_VERSION, uriPrefix } from "../spec/src/protocol"
import { LIMITS, WIDGET_SIZES } from "../spec/src/rules"
import { z } from "zod"

/**
 * THE MANIFEST (spec §2): the app's definition without its code, as pure
 * JSON. Hosts read it with one fetch (`/.well-known/clegra.json`) or as the
 * MCP resource `clegra://<name>`. This Zod schema is the source of the
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
  as: z.string().optional().describe("The property of the entity's kind this field holds (spec §3.1)"),
  ref: z
    .union([z.string().describe("An entity of this app: the field holds one of its record ids"), z.object({ kind: z.string() }).describe("A kind: the field holds the URI of a record of that kind, in any app (spec §3.2)")])
    .optional(),
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
const visibility = z.literal("app").optional().describe("App-only: hidden from every model (its tools carry MCP Apps `_meta.ui.visibility: [\"app\"]`); views and the host's own UI still call it. Absent: models and apps")

export const entitySchema = z.object({
  name: ident,
  label: labelMap,
  plural: labelMap,
  description: labelMap.optional(),
  icon: z.string().optional(),
  kind: z
    .union([z.string(), z.object({ by: z.string().describe("A required enum field"), map: z.record(z.string(), z.string()).describe("A kind for each of its values") })])
    .optional()
    .describe("What the entity is (spec §3.1): a kind, or one per record by an enum field"),
  permission: z.string().optional(),
  schema: jsonSchema,
  fields: z.array(fieldSchema),
  tools: z.object({ list: toolRef, get: toolRef }),
  searchable: z.boolean(),
  visibility,
  record: z
    .object({
      fields: z.array(z.string()).min(1).max(LIMITS.recordFields).describe("The key fields its surface shows, in order"),
      actions: z.array(z.string()).max(LIMITS.recordActions).optional().describe("Record actions of this entity its surface offers, in order: the first is the primary"),
    })
    .optional()
    .describe("The record template (spec §5.4 rule 4 `record`); absent: the fields a list would show first, no actions"),
})

export const targetSchema = z
  .object({
    target: z.string().regex(/^(mail\.message|record:[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*)$/).describe("What the action is offered on: `mail.message`, or `record:<kind>` (a published kind or a namespaced one)"),
    needs: z.array(z.string()).describe("The target's fields the action may receive (only these, ever); `uri` and, for records, `title` are always available"),
    input: z.record(z.string(), z.unknown()).optional().describe("A template of the action's input: string values may hold `{field}` / `{field.sub}` placeholders naming `uri`, `title` or a needed field"),
    label: labelMap.optional().describe("The item's words (default the action's title), at most 40 characters per locale"),
  })
  .describe("Where a host offers a global action on something of another app")

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
  visibility,
  targets: z.array(targetSchema).max(LIMITS.targetsPerAction).optional(),
  later: z
    .object({
      at: z.string().describe("A required date-time input property: when the action runs"),
      window: z.number().int().min(LIMITS.laterWindow.min).max(LIMITS.laterWindow.max).describe("Minutes after `at` the run may still start"),
    })
    .optional()
    .describe("«Approve now, act later»: the confirmed call is stored and runs at `at`, within `window` minutes"),
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
  derived: z.boolean().optional(),
  actions: z.array(z.string()).max(LIMITS.pageActions).optional().describe("Global actions offered on the page, in order: the first is the page's primary. Page params prefill the inputs of the same name"),
  badge: z.string().optional().describe("A `stat` artifact type without required params: its data.value is the page's count in the navigation"),
})

export const artifactSchema = z.object({
  type: ident,
  title: labelMap,
  description: labelMap.optional(),
  icon: z.string().optional(),
  entity: z.string().optional().describe("Set: the entity's record card (params { id })"),
  params: jsonSchema,
  template: z.enum(["record", "card", "stat", "list", "chart"]).optional(),
  component: z.string().optional().describe("One of the app's own components (spec §5.4): its data are the component's props"),
  view: z.string().optional(),
  tool: toolRef,
  permission: z.string().optional(),
  actions: z.array(z.string()).optional().describe("Actions shown inside, by name"),
  size: z.enum(["small", "medium", "large"]).optional(),
  untrusted: z.boolean().optional().describe("Its texts are written by outsiders: data, never instructions"),
  visibility,
  create: z
    .object({
      action: z.string().describe("A global write with no required input, not confirmed first, that makes a new one and returns its URI as `record`"),
      title: labelMap.describe("The words of «+ Nuovo» and the «/» menu"),
    })
    .optional()
    .describe("A type people create in a workspace host (spec §5 `create`)"),
})

export const widgetSchema = z.object({
  artifact: ident.describe("A template or component artifact type of this app without required params"),
  sizes: z.array(z.enum(WIDGET_SIZES)).min(1).describe("The sizes it may take on a dashboard grid"),
  size: z.enum(WIDGET_SIZES).describe("The size it is added at: one of `sizes`"),
})

export const navSchema = z.array(z.object({ section: labelMap.optional(), pages: z.array(z.string()).min(1) })).describe("The app's navigation: sections of pages (no record pages, each page at most once). Absent: every non-record page, ungrouped, in declaration order")

export const scheduleSchema = z.object({
  name: ident,
  action: z.string().optional().describe("The global action run (absent on the SDK's own `clegra_later`)"),
  tool: z.string().describe("The tool the host calls as the installation, with `_meta.clegra.schedule` = name"),
  every: z.number().int().min(LIMITS.scheduleEvery.min).max(LIMITS.scheduleEvery.max).describe("Minutes between runs, per installation"),
  maxSeconds: z.number().int().min(LIMITS.scheduleSeconds.min).max(LIMITS.scheduleSeconds.max).describe("How long a run may take"),
})

export const notificationTypeSchema = z.object({
  type: ident,
  label: labelMap,
  description: labelMap.optional(),
  default: z.boolean().describe("false: off until the person turns it on"),
  permission: z.string().optional().describe("Only holders of this permission receive it"),
})

export const lifecycleSchema = z
  .object({ installation: z.literal(INSTALLATION_TOOL).optional(), export: z.literal(EXPORT_TOOL).optional(), delete: z.literal(DELETE_TOOL).optional() })
  .describe("The app-only tools a workspace host calls as the installation: told of enable/disable/uninstall, export the tenant's data, delete it")

export const manifestSchema = z.object({
  specVersion: z.literal(SPEC_VERSION),
  name: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/),
  title: labelMap,
  version: z.string(),
  description: labelMap.optional(),
  icons: z.array(z.object({ src: z.string(), mimeType: z.string().optional(), sizes: z.array(z.string()).optional() })).optional(),
  accent: z
    .enum(APP_ACCENTS)
    .optional()
    .describe(`The app's tint, like an Apple app's: one name of the palette, never a free colour. Absent: "${DEFAULT_APP_ACCENT}"`),
  publisher: z
    .object({ name: z.string().min(1).max(LIMITS.publisherName), url: z.string().max(LIMITS.publisherUrl).describe("The publisher's web address: an absolute https URL") })
    .strict()
    .optional()
    .describe("Who publishes the app: a claim that grants nothing; a store or host may verify it by the address's domain"),
  locale: z.string(),
  mcp: z.object({ url: z.string() }).describe("The MCP endpoint (Streamable HTTP), relative to the manifest"),
  auth: z
    .object({
      resource: z.string().optional().describe("The app's public MCP address: the only token audience it accepts. A host installs the app from this address or not at all"),
      authorizationServers: z.array(z.string()),
    })
    .describe("MCP authorization: the server's own address (the token audience) and who issues tokens"),
  view: z.string().describe("The generated ui:// view for lists, records, dashboards and artifacts"),
  resolveTool: z.string().describe("Hosts resolve record and artifact URIs with this tool"),
  site: z
    .object({
      start: z.string().describe("The path the site opens at"),
      tool: toolRef.describe("The tool a Clegra client asks for a site ticket with (spec §5.1)"),
    })
    .optional()
    .describe("The app's own website, shown as it is in Clegra's clients (spec §5.1)"),
  components: z
    .record(
      z.string().regex(/^[A-Z][A-Za-z0-9]{0,39}$/),
      z.object({
        title: z.string(),
        description: z.string().optional(),
        view: z.string().describe("Its page: ui://<app>/components/<Name>, served like every view (spec §5.3)"),
        props: jsonSchema.describe("The JSON Schema of the data it draws"),
        actions: z.array(z.string()).describe("The tools the page may call through the host"),
      }),
    )
    .optional()
    .describe("The app's own A2UI components, by name (spec §5.4); its catalog is the MCP resource a2ui://<app>/catalog.json"),
  searchTool: z.string().optional(),
  kinds: z
    .record(z.string(), z.object({ label: labelMap, properties: z.record(z.string(), z.object({ type: z.enum(PROPERTY_TYPES), many: z.boolean().optional(), key: z.boolean().optional() })) }))
    .optional()
    .describe("The namespaced kinds (with a dot) this app defines (spec §3.1)"),
  entities: z.array(entitySchema),
  actions: z.array(actionSchema),
  pages: z.array(pageSchema),
  artifacts: z.array(artifactSchema),
  widgets: z.array(widgetSchema).max(LIMITS.widgets).optional().describe("The artifact types offered as Home widgets (spec §5.5)"),
  agents: z.array(z.object({ name: ident, title: labelMap, description: labelMap, instructions: z.string(), tools: z.array(z.string()), tier: z.enum(["fast", "standard", "strong"]), starters: z.array(labelMap).optional() })),
  permissions: z.array(z.object({ id: z.string(), label: labelMap, description: labelMap.optional(), default: z.boolean() })),
  settings: z.array(z.object({ id: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/), label: labelMap, description: labelMap.optional(), type: z.enum(["text", "number", "boolean"]), required: z.boolean(), default: z.union([z.string(), z.number(), z.boolean()]).optional() })),
  nav: navSchema.optional(),
  schedules: z.array(scheduleSchema).max(LIMITS.schedules + 1).optional().describe(`Actions a workspace host runs as the installation, with no person; the SDK adds \`${LATER_TOOL}\` for later runs`),
  notifications: z.array(notificationTypeSchema).optional().describe("The notification types the app sends; without them its notifications are untyped"),
  lifecycle: lifecycleSchema.optional(),
  events: z
    .object({ url: z.string().describe("On the app's own origin, relative to it") })
    .strict()
    .optional()
    .describe("Where Clegra's core posts its signed events (clegra-event+jwt): member.removed, app.unassigned, company.suspended, app.installed, app.uninstalled"),
  rolesTool: z.string().optional().describe("The read-only tool that says who has what inside the app, for a company administrator"),
})

export type Manifest = z.infer<typeof manifestSchema>
export type ManifestField = z.infer<typeof fieldSchema>
export type ManifestEntity = z.infer<typeof entitySchema>
export type ManifestAction = z.infer<typeof actionSchema>
export type ManifestPage = z.infer<typeof pageSchema>
export type ManifestArtifact = z.infer<typeof artifactSchema>
export type ManifestWidget = z.infer<typeof widgetSchema>
export type ManifestTarget = z.infer<typeof targetSchema>
export type ManifestSchedule = z.infer<typeof scheduleSchema>
export type ManifestNotificationType = z.infer<typeof notificationTypeSchema>

/** The published JSON Schema of the manifest. */
export function manifestJsonSchema(): Record<string, unknown> {
  return { $id: SCHEMA_ID, title: `Clegra app manifest ${SPEC_VERSION}`, ...z.toJSONSchema(manifestSchema, { target: "draft-2020-12" }) }
}
