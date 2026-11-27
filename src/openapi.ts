import type { Manifest } from "./manifest"

/**
 * THE INDEX AS OPENAPI 3.1 (spec §7 «The index as OpenAPI»): the same operations the manifest and MCP give — every
 * read and action a plain client may call, with its input, its effect and whether it needs a sign-in — rendered as
 * an OpenAPI 3.1 document at `<path>/openapi.json`, each operation callable over plain HTTP as
 * `POST <path>/operations/<tool>` with the same caller, permissions and checks as its MCP tool. The pages ride along as
 * `x-clegra-pages`. Nothing in it is new: it is a view of the index, for tools that read OpenAPI.
 */

/** Where the document is served, under the app's `path`. */
export const OPENAPI_PATH = "/openapi.json"
/** Where operations are called, under the app's `path`: `POST <path>/operations/<tool>`. */
export const OPERATIONS_PATH = "/operations"

/** An OpenAPI 3.1 document (only what the SDK writes is typed). */
export type OpenApiDocument = {
  openapi: "3.1.1"
  info: { title: string; version: string; description?: string }
  servers: { url: string }[]
  paths: Record<string, { post: Record<string, unknown> }>
  components: { securitySchemes?: Record<string, unknown>; schemas: Record<string, unknown> }
  security?: Record<string, string[]>[]
  "x-clegra-manifest": string
  "x-clegra-pages": { name: string; kind: string; title: Record<string, string>; tool: string }[]
}

/** A tool as `tools/list` gives it to a caller who may use everything a plain client may. */
export type ListedTool = { name: string; title?: string; description?: string; inputSchema: Record<string, unknown>; outputSchema?: Record<string, unknown>; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }

/** What the error codes of a call become over HTTP. */
export const ERROR_STATUS: Record<string, number> = { invalid_input: 400, unauthorized: 401, permission_denied: 403, not_found: 404, conflict: 409, confirmation_required: 428, rate_limited: 429, internal: 500 }

const ERROR_SCHEMA = {
  type: "object",
  required: ["error"],
  properties: { error: { type: "object", required: ["code", "message"], properties: { code: { type: "string", enum: Object.keys(ERROR_STATUS) }, message: { type: "string" } }, additionalProperties: true } },
}

/**
 * The document. `origin` is the app's public origin, `base` its `path`; `oauth` the sign-in module's endpoints when
 * the app has one (else the scheme is a bearer token of the app's own authorization server).
 */
export function openApiDocument(input: {
  manifest: Manifest
  tools: ListedTool[]
  origin: string
  base: string
  locale: string
  oauth: { authorizationUrl: string; tokenUrl: string; scopes: { id: string; label: string }[] } | null
  signsIn: boolean
}): OpenApiDocument {
  const { manifest, locale } = input
  const say = (l: Record<string, string> | undefined) => (l ? (l[locale] ?? l[manifest.locale] ?? Object.values(l)[0]) : undefined)
  const actions = new Map(manifest.actions.map((a) => [a.tool.name, a]))
  const entities = new Map<string, { entity: string; op: "list" | "get" }>()
  for (const e of manifest.entities) {
    entities.set(e.tools.list.name, { entity: e.name, op: "list" })
    entities.set(e.tools.get.name, { entity: e.name, op: "get" })
  }
  const scheme = input.oauth ? "signIn" : "bearer"
  const paths: OpenApiDocument["paths"] = {}
  for (const t of input.tools) {
    const action = actions.get(t.name)
    const read = entities.get(t.name)
    const effect = action ? action.effect : t.annotations?.readOnlyHint ? "read" : "write"
    const errors = Object.fromEntries(
      Object.entries(ERROR_STATUS)
        .filter(([code]) => code !== "unauthorized" || !action?.public)
        .map(([code, status]) => [String(status), { description: code.replace(/_/g, " "), content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } }]),
    )
    paths[`${input.base}${OPERATIONS_PATH}/${t.name}`] = {
      post: {
        operationId: t.name,
        summary: action ? say(action.title) : (t.title ?? t.name),
        ...(t.description ? { description: t.description } : {}),
        tags: [action?.entity ?? read?.entity ?? manifest.name],
        requestBody: { required: true, content: { "application/json": { schema: t.inputSchema } } },
        responses: {
          "200": { description: "The result: what the tool's structured content says", content: { "application/json": { schema: t.outputSchema ?? { type: "object", additionalProperties: true } } } },
          ...errors,
        },
        ...(action?.public ? { security: [] } : {}),
        parameters: effect === "read" ? [] : [{ name: "Idempotency-Key", in: "header", required: false, description: "The call id: a write with the same key runs once per caller (the MCP call id)", schema: { type: "string", maxLength: 128 } }],
        "x-clegra-effect": effect,
        "x-mcp-tool": t.name,
        ...(action ? { "x-clegra-confirm": action.confirm, ...(action.entity ? { "x-clegra-entity": action.entity } : {}) } : {}),
        ...(read ? { "x-clegra-entity": read.entity, "x-clegra-read": read.op } : {}),
      },
    }
  }
  const securitySchemes = input.oauth
    ? {
        signIn: {
          type: "oauth2",
          description: "The app's own sign-in: authorization code with PKCE S256, clients by Client ID Metadata Document; DPoP-bound tokens are sent as `Authorization: DPoP` with a proof for the operation's URL",
          flows: { authorizationCode: { authorizationUrl: input.oauth.authorizationUrl, tokenUrl: input.oauth.tokenUrl, scopes: Object.fromEntries(input.oauth.scopes.map((s) => [s.id, s.label])) } },
        },
      }
    : input.signsIn
      ? { bearer: { type: "http", scheme: "bearer", description: "An access token of the app's own authorization server, for this app's MCP address (RFC 8707)" } }
      : undefined
  return {
    openapi: "3.1.1",
    info: { title: say(manifest.title) ?? manifest.name, version: manifest.version, ...(manifest.description ? { description: say(manifest.description) } : {}) },
    servers: [{ url: input.origin }],
    paths,
    components: { ...(securitySchemes ? { securitySchemes } : {}), schemas: { Error: ERROR_SCHEMA } },
    ...(securitySchemes ? { security: [{ [scheme]: [] }] } : {}),
    "x-clegra-manifest": "/.well-known/clegra.json",
    "x-clegra-pages": manifest.pages.filter((p) => !p.derived).map((p) => ({ name: p.name, kind: p.kind, title: p.title, tool: p.tool.name })),
  }
}
