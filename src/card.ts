/**
 * THE WORKSPACE CARD (spec §12): what a workspace host reads to mount the
 * app. Labels are maps per locale. Types only: no dependency, so hosts can
 * import this file alone.
 */

export const SPEC_VERSION = "1.0"
export const EXTENSION_ID = "io.mcpworkspaces/app"
export const CARD_PATH = "/.well-known/mcp-workspace.json"
export const CARD_URI = (app: string) => `mcpw://${app}`

export type LabelMap = Record<string, string>

export type CardField = {
  name: string
  type: "string" | "number" | "integer" | "boolean" | "array" | "object"
  required: boolean
  enum?: string[]
  role?: "title" | "subtitle" | "status" | "amount" | "date" | "person"
  label: LabelMap
  ref?: string
  permission?: string
  filter?: boolean
  sort?: boolean
  search?: boolean
  labels?: Record<string, LabelMap>
  tones?: Record<string, "neutral" | "info" | "success" | "warning" | "danger">
  currency?: string
  untrusted?: boolean
}

export type CardEntity = {
  name: string
  label: LabelMap
  plural: LabelMap
  description?: LabelMap
  icon?: string
  permission?: string
  schema: Record<string, unknown>
  fields: CardField[]
  tools: { get: string; list: string }
  searchable: boolean
}

export type CardAction = {
  name: string
  tool: string
  entity?: string
  title: LabelMap
  description?: LabelMap
  icon?: string
  input: Record<string, unknown>
  readOnly: boolean
  confirm: "always" | "optional" | "never"
  permission?: string
  plainHosts?: false
}

export type CardPage = {
  name: string
  kind: "list" | "record" | "dashboard" | "custom"
  title: LabelMap
  icon?: string
  permission?: string
  params: Record<string, unknown>
  entity?: string
  columns?: string[]
  sections?: { title: LabelMap; fields: string[] }[]
  tool: string
  /** dashboard and custom: the MCP Apps view that draws it. */
  view?: string
  /** custom: the developer's site shown in the view. */
  url?: string
  derived?: boolean
}

export type CardFragment = {
  type: string
  title: LabelMap
  description?: LabelMap
  icon?: string
  entity?: string
  params: Record<string, unknown>
  template?: "record" | "card" | "stat" | "list" | "chart"
  view?: string
  tool: string
  permission?: string
  actions?: string[]
  size?: "small" | "medium" | "large"
}

export type Card = {
  mcpWorkspaces: string
  name: string
  title: LabelMap
  version: string
  description?: LabelMap
  icons?: { src: string; mimeType?: string; sizes?: string[] }[]
  locale: string
  mcp: { url: string; transport: "streamable-http" }
  auth: { audience: string; resource?: string; authorizationServers: string[]; dev?: boolean }
  /** The SDK's generic MCP Apps view. */
  view: string
  resolveTool: string
  searchTool?: string
  entities: CardEntity[]
  actions: CardAction[]
  pages: CardPage[]
  fragments: CardFragment[]
  agents: { name: string; title: LabelMap; description: LabelMap; instructions: string; tools: string[]; tier: "fast" | "standard" | "strong"; starters?: LabelMap[] }[]
  permissions: { id: string; label: LabelMap; description?: LabelMap; default: boolean }[]
  settings: { id: string; label: LabelMap; description?: LabelMap; type: "text" | "secret" | "number" | "boolean" | "choice"; required: boolean; default?: string | number | boolean; options?: { value: string; label: LabelMap }[] }[]
}

/** Whether a JSON value looks like a v1 card. */
export function isCard(value: unknown): value is Card {
  const c = value as Partial<Card> | null
  return Boolean(c && typeof c === "object" && typeof c.mcpWorkspaces === "string" && c.mcpWorkspaces.startsWith("1.") && typeof c.name === "string" && Array.isArray(c.entities) && Array.isArray(c.pages))
}
