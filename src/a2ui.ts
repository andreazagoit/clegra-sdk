/**
 * Artifacts as A2UI 1.0 surfaces (spec §5.4). An artifact's template data (or a component artifact's props) become
 * one A2UI `createSurface` message: Basic Catalog components bound to a data model that is the data as the app
 * returned them, Clegra's `Chart` and functions where the Basic Catalog has none, and the app's own components from
 * its catalog (`a2ui://<app>/catalog.json`). Pure: no I/O.
 *
 * A2UI 1.0: https://a2ui.org, `specification/v1_0` of github.com/a2ui-project/a2ui.
 */

import type { RecordSurfaceData, TemplateData } from "./types"

export const A2UI_VERSION = "1.0"
export const A2UI_MIME_TYPE = "application/a2ui+json"
export const BASIC_CATALOG_ID = "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json"
export const CLEGRA_CATALOG_ID = "https://clegra.com/a2ui/v1_0/catalog.json"
/** The component-scope extension that carries a style hint (spec §5.4 rule 4). */
export const STYLE_EXTENSION = "com_clegra_style"
/** The catalog-component extension that says where an app's own component is drawn from (spec §5.4 rule 6). */
export const COMPONENT_EXTENSION = "com_clegra_component"
/** The names an app's own component can't take: the Basic Catalog's, Clegra's, and A2UI's reserved `Surface`. */
export const RESERVED_COMPONENTS = ["Text", "Image", "Icon", "Video", "AudioPlayer", "Row", "Column", "List", "Card", "Tabs", "Modal", "Divider", "Button", "CheckBox", "TextField", "DateTimeInput", "ChoicePicker", "Slider", "Chart", "Spreadsheet", "TodoList", "AppBlock", "Surface", "McpApp"] as const
export const COMPONENT_NAME = /^[A-Z][A-Za-z0-9]{0,39}$/

/** The app's own catalog id. */
export const appCatalogId = (app: string) => `a2ui://${app}/catalog.json`
/** The MCP resource a `show_<type>` result embeds its surface as. */
export const surfaceResourceUri = (app: string, type: string) => `a2ui://${app}/surfaces/${type}`

export type Style = "title" | "value" | "status" | "muted"
export type Binding = { "@path": string }
export type FunctionCall = { "@call": string; catalogId?: string; args?: Record<string, unknown> }
export type A2uiComponent = { id: string; component: string; "@catalogId"?: string; "@metadata"?: { extensions: Record<string, unknown> }; [prop: string]: unknown }
export type CreateSurface = {
  version: typeof A2UI_VERSION
  createSurface: { surfaceId: string; catalogId: string; components: A2uiComponent[]; dataModel: Record<string, unknown> }
}
/** What an artifact carries: exactly one `createSurface` (spec §5.4 rule 2). */
export type A2uiSurface = [CreateSurface]

/** An action offered inside (spec §5.4 rule 5): its tool, its title in the caller's language, and the event's context (a record action's `{ id }`). */
export type SurfaceAction = { tool: string; title: string; context?: Record<string, unknown> }

const at = (path: string): Binding => ({ "@path": path })
const styled = (c: A2uiComponent, style?: Style): A2uiComponent => (style ? { ...c, "@metadata": { extensions: { [STYLE_EXTENSION]: style } } } : c)
const text = (id: string, value: unknown, style?: Style, variant?: "caption"): A2uiComponent => styled({ id, component: "Text", text: value, ...(variant ? { variant } : {}) }, style)
const openRecord = (uri: Binding) => ({ functionCall: { "@call": "openRecord", catalogId: CLEGRA_CATALOG_ID, args: { uri } } })

/** The `actions` row: one Button per action, the first the primary; each an event the host turns into the action's form. */
function actionsRow(actions: readonly SurfaceAction[]): A2uiComponent[] {
  if (!actions.length) return []
  const buttons = actions.flatMap((a, n) => [
    { id: `action_${n}`, component: "Button", child: `action_${n}_label`, variant: n === 0 ? "primary" : "default", action: { event: { name: a.tool, context: a.context ?? {} } } },
    text(`action_${n}_label`, a.title),
  ])
  return [{ id: "actions", component: "Row", children: actions.map((_, n) => `action_${n}`), justify: "start" }, ...buttons]
}

/** root Card → body Column [children…, actions?]. */
function frame(children: string[], parts: A2uiComponent[], actions: readonly SurfaceAction[]): A2uiComponent[] {
  const row = actionsRow(actions)
  return [{ id: "root", component: "Card", child: "body" }, { id: "body", component: "Column", children: [...children, ...(row.length ? ["actions"] : [])], align: "stretch" }, ...parts, ...row]
}

const has = (v: unknown) => v !== undefined && v !== null && v !== ""

/** A figure as A2UI formats it, in the reader's locale (spec §5.4 rule 4, `stat`). */
function figure(data: TemplateData["stat"]): unknown {
  if (typeof data.value !== "number") return at("/value")
  if (data.format === "money") return { "@call": "formatCurrency", args: { value: at("/value"), currency: typeof data.currency === "string" ? at("/currency") : "EUR" } }
  if (data.format === "percent") return { "@call": "formatPercent", catalogId: CLEGRA_CATALOG_ID, args: { value: at("/value") } }
  return { "@call": "formatNumber", args: { value: at("/value") } }
}

export type SurfaceInput = {
  /** The surface's id: the artifact instance's URI. */
  surfaceId: string
  /** The artifact's own title, in the caller's language. */
  title: string
  actions?: readonly SurfaceAction[]
}

/** A template artifact's surface (spec §5.4 rule 4): the tree for its template, the data as its data model. */
export function templateSurface<T extends keyof TemplateData>(template: T, data: TemplateData[T], input: SurfaceInput): A2uiSurface {
  const actions = input.actions ?? []
  const heading = text("heading", input.title, "title")
  let components: A2uiComponent[]
  if (template === "card") {
    const d = data as TemplateData["card"]
    const title = has(d.uri)
      ? [{ id: "title", component: "Button", child: "title_text", variant: "borderless", action: openRecord(at("/uri")) }, text("title_text", at("/title"), "title")]
      : [text("title", at("/title"), "title")]
    components = frame(
      ["head", ...(has(d.subtitle) ? ["subtitle"] : []), ...(d.fields?.length ? ["fields"] : [])],
      [
        { id: "head", component: "Row", children: ["title", ...(has(d.status) ? ["status"] : [])], justify: "spaceBetween", align: "center" },
        ...title,
        ...(has(d.status) ? [text("status", at("/status"), "status")] : []),
        ...(has(d.subtitle) ? [text("subtitle", at("/subtitle"), "muted", "caption")] : []),
        ...(d.fields?.length
          ? [
              { id: "fields", component: "List", children: { path: "/fields", componentId: "field" } },
              { id: "field", component: "Row", children: ["field_label", "field_value"], justify: "spaceBetween" },
              text("field_label", at("label"), "muted", "caption"),
              text("field_value", at("value")),
            ]
          : []),
      ],
      actions,
    )
  } else if (template === "stat") {
    const d = data as TemplateData["stat"]
    components = frame(
      ["heading", "value", ...(has(d.label) ? ["label"] : []), ...(has(d.hint) ? ["hint"] : [])],
      [heading, text("value", figure(d), "value"), ...(has(d.label) ? [text("label", at("/label"), "muted", "caption")] : []), ...(has(d.hint) ? [text("hint", at("/hint"), "muted", "caption")] : [])],
      actions,
    )
  } else if (template === "list") {
    const d = data as TemplateData["list"]
    const linked = (d.items ?? []).some((i) => has(i.uri))
    components = frame(
      ["heading", "items"],
      [
        heading,
        { id: "items", component: "List", children: { path: "/items", componentId: "item" } },
        { id: "item", component: "Row", children: ["item_main", "item_status"], justify: "spaceBetween", align: "center" },
        { id: "item_main", component: "Column", children: ["item_title", "item_subtitle"] },
        ...(linked ? [{ id: "item_title", component: "Button", child: "item_title_text", variant: "borderless", action: openRecord(at("uri")) }, text("item_title_text", at("title"))] : [text("item_title", at("title"))]),
        text("item_subtitle", at("subtitle"), "muted", "caption"),
        text("item_status", at("status"), "status"),
      ],
      actions,
    )
  } else {
    const d = data as TemplateData["chart"]
    components = frame(
      ["heading", "chart"],
      [heading, { id: "chart", component: "Chart", "@catalogId": CLEGRA_CATALOG_ID, kind: at("/kind"), points: at("/points"), ...(has(d.format) ? { format: at("/format") } : {}), ...(has(d.currency) ? { currency: at("/currency") } : {}) }],
      actions,
    )
  }
  return [{ version: A2UI_VERSION, createSurface: { surfaceId: input.surfaceId, catalogId: BASIC_CATALOG_ID, components, dataModel: data as Record<string, unknown> } }]
}

/**
 * A record's surface (spec §5.4 rule 4 `record`): its title opening the record, its status as a chip, its key fields
 * as label and value, its record actions. The data model is the record template's data, every value a text.
 */
export function recordSurface(data: RecordSurfaceData, input: SurfaceInput): A2uiSurface {
  const components = frame(
    ["head", ...(has(data.subtitle) ? ["subtitle"] : []), ...(data.fields.length ? ["fields"] : [])],
    [
      { id: "head", component: "Row", children: ["title", ...(has(data.status) ? ["status"] : [])], justify: "spaceBetween", align: "center" },
      { id: "title", component: "Button", child: "title_text", variant: "borderless", action: openRecord(at("/uri")) },
      text("title_text", at("/title"), "title"),
      ...(has(data.status) ? [text("status", at("/status"), "status")] : []),
      ...(has(data.subtitle) ? [text("subtitle", at("/subtitle"), "muted", "caption")] : []),
      ...(data.fields.length
        ? [
            { id: "fields", component: "List", children: { path: "/fields", componentId: "field" } },
            { id: "field", component: "Row", children: ["field_label", "field_value"], justify: "spaceBetween" },
            text("field_label", at("label"), "muted", "caption"),
            text("field_value", at("value")),
          ]
        : []),
    ],
    input.actions ?? [],
  )
  return [{ version: A2UI_VERSION, createSurface: { surfaceId: input.surfaceId, catalogId: BASIC_CATALOG_ID, components, dataModel: data as unknown as Record<string, unknown> } }]
}

/** A component artifact's surface (spec §5.4 rule 4): its heading, the app's component with each prop bound to the data model. */
export function componentSurface(app: string, component: string, props: Record<string, unknown>, propNames: readonly string[], input: SurfaceInput): A2uiSurface {
  const bound = Object.fromEntries(propNames.map((p) => [p, at(`/${p.replace(/~/g, "~0").replace(/\//g, "~1")}`)]))
  const components = frame(["heading", "component"], [text("heading", input.title, "title"), { id: "component", component, "@catalogId": appCatalogId(app), ...bound }], input.actions ?? [])
  return [{ version: A2UI_VERSION, createSurface: { surfaceId: input.surfaceId, catalogId: BASIC_CATALOG_ID, components, dataModel: props } }]
}

const dynamic = (description: string) => ({ $ref: "common_types.json#/$defs/DynamicValue", description })
const dynamicString = (description: string) => ({ $ref: "common_types.json#/$defs/DynamicString", description })

/**
 * Clegra's A2UI 1.0 catalog (spec §5.4 rule 3): what the Basic Catalog has not and Clegra's artifacts need.
 * `catalogId` and `$id` are the same string, as A2UI asks; it is an identifier, not an address to fetch.
 */
export const CLEGRA_A2UI_CATALOG = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: CLEGRA_CATALOG_ID,
  protocolVersion: A2UI_VERSION,
  title: "Clegra A2UI catalog",
  description: "Components and functions of Clegra's artifacts that the A2UI Basic Catalog does not have.",
  catalogId: CLEGRA_CATALOG_ID,
  components: {
    Chart: {
      type: "object",
      description: "A chart of labelled values, drawn by the host in its own design system.",
      properties: {
        component: { const: "Chart" },
        kind: dynamicString("bar, line or pie"),
        points: dynamic("The points: [{ label, value }]"),
        format: dynamicString("number (default) or money"),
        currency: dynamicString("ISO 4217 currency of money values (default EUR)"),
      },
      required: ["component", "kind", "points"],
    },
  },
  functions: {
    formatPercent: {
      type: "object",
      description: "Formats a share (0.125) as a percentage in the reader's locale («12,5 %»).",
      returnType: "string",
      allowedCallers: "rendererOnly",
      properties: { "@call": { const: "formatPercent" }, args: { type: "object", properties: { value: { $ref: "common_types.json#/$defs/DynamicNumber" } }, required: ["value"], additionalProperties: false } },
      required: ["@call", "args"],
    },
    openRecord: {
      type: "object",
      description: "Opens the record a clegra:// URI names, where records open in this host. An empty URI does nothing.",
      returnType: "void",
      allowedCallers: "rendererOnly",
      requiresUserActivation: true,
      properties: { "@call": { const: "openRecord" }, args: { type: "object", properties: { uri: dynamicString("The record's clegra:// URI") }, required: ["uri"], additionalProperties: false } },
      required: ["@call", "args"],
    },
  },
  $defs: {
    anyComponent: { oneOf: [{ $ref: "#/components/Chart" }], discriminator: { propertyName: "component" } },
    anyFunction: { oneOf: [{ $ref: "#/functions/formatPercent" }, { $ref: "#/functions/openRecord" }] },
  },
} as const

/** An app's own component, as its catalog and the manifest describe it (spec §5.4 rule 6). */
export type ComponentEntry = { name: string; title: string; description?: string; view: string; props: Record<string, unknown>; actions: string[] }

/** The app's own A2UI 1.0 catalog: one catalog component per component of the app. */
export function appCatalog(app: string, title: string, components: readonly ComponentEntry[]) {
  const id = appCatalogId(app)
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: id,
    protocolVersion: A2UI_VERSION,
    title: `${title} components`,
    catalogId: id,
    components: Object.fromEntries(
      components.map((c) => {
        const props = (c.props.properties ?? {}) as Record<string, { description?: string }>
        const required = Array.isArray(c.props.required) ? (c.props.required as string[]) : []
        return [
          c.name,
          {
            type: "object",
            description: c.description ?? c.title,
            properties: { component: { const: c.name }, ...Object.fromEntries(Object.entries(props).map(([k, p]) => [k, dynamic(p?.description ?? k)])) },
            required: ["component", ...required],
            metadata: { extensions: { [COMPONENT_EXTENSION]: { view: c.view, props: c.props, actions: c.actions } } },
          },
        ]
      }),
    ),
    $defs: {
      anyComponent: { oneOf: components.map((c) => ({ $ref: `#/components/${c.name}` })), discriminator: { propertyName: "component" } },
      // No function of its own: a schema nothing matches.
      anyFunction: { not: {} },
    },
  }
}
