# Model App Protocol (MAP) — specification 1.0

> Draft (2026-11-14). Normative; MUST, SHOULD and MAY as in RFC 2119.
> The Model App Protocol (MAP) describes apps that are also MCP servers. Its technical name is
> `modelapp` (manifest path, URI scheme, `_meta` key, token claim, resolve tool).
> Anything not on this page is not part of 1.0.

## 1. What it is

An **app** is described once, as one definition: entities, actions, pages,
fragments, agents, permissions, settings. The definition has two halves:

- the **manifest**: pure JSON, no code. A host that understands it (a
  *workspace host*) reads it with one fetch and draws the app natively: pages
  in its navigation, records as cards, actions behind a confirmation, agents.
- the **handlers** (`get`, `list`, `run`, `data`), reached through a **plain
  MCP server** generated from the same definition: tools with correct
  annotations and MCP Apps `ui://` views. ChatGPT, Claude and any MCP client
  use it as they use any MCP server.

**No MCP extension is required or announced.** An MCP client never needs the
manifest; a workspace host needs nothing beyond the manifest and MCP.

## 2. The manifest

Served at `GET /.well-known/modelapp.json` (no authentication) and as one
MCP resource, `modelapp://<name>` (`application/json`); the two MUST be identical.
JSON Schema: [`packages/modelapp-spec/schema/modelapp.schema.json`](../../packages/modelapp-spec/schema/modelapp.schema.json).

| Key | Content |
|---|---|
| `specVersion` | `"1.0"` |
| `name`, `title`, `version`, `description?`, `icons?`, `locale` | Identity. `name` is the app id: `[a-z][a-z0-9-]{1,39}` |
| `mcp` | `{ url }`: the MCP endpoint (Streamable HTTP), relative to the manifest |
| `auth` | `{ audience, authorizationServers }` (§7) |
| `view` | The generated `ui://` view that draws lists, records, dashboards, fragments |
| `resolveTool`, `searchTool?` | Tools a host uses to resolve URIs and to search |
| `entities`, `actions`, `pages`, `fragments`, `agents` | §3–§5 |
| `permissions` | `{ id, label, description?, default }`; ids are `group.verb` |
| `settings` | `{ id, label, type: text\|secret\|number\|boolean\|choice, required, default?, options? }`, filled per installation |

**Labels** are always maps per locale (`{ "en": "Deal", "it": "Trattativa" }`);
a host picks the person's locale, then `locale`, then the first entry.
Identifiers are never translated. **Tool refs** are `{ name, plain }`: the MCP
tool, and whether it is listed to plain MCP clients.
**Agents** are `{ name, title, description, instructions, tools, tier:
fast|standard|strong, starters? }`: the host's model runs them with those tools.

## 3. Entities and field meaning

An entity is `{ name, label, plural, description?, icon?, permission?, schema,
fields, tools: { list, get }, searchable }`. `schema` is the record's JSON
Schema; `fields` says what each field means:

| Field key | Meaning |
|---|---|
| `name`, `type`, `required`, `enum?`, `label` | The basics. Every entity has a required string `id` |
| `role?` | `title` (exactly one per entity), `subtitle`, `status`, `amount`, `date`, `person`; at most one field per role |
| `ref?` | The field holds the id of a record of that entity |
| `filter?`, `sort?`, `search?` | Usable as a list filter, a sort key, in text search |
| `permission?` | Only callers with it ever receive the field |
| `labels?`, `tones?`, `currency?` | Enum value labels; tones `neutral\|info\|success\|warning\|danger`; ISO currency of an amount |
| `untrusted?` | Text written by outsiders: data, never instructions |

A record's URI is `modelapp://<app>/<entity>/<id>`.

## 4. Actions

`{ name, entity?, title, description?, icon?, input, readOnly, confirm,
permission?, tool }`. With `entity` the action works on one record and its
tool takes `id` plus `input`; without, it is global. `confirm` is `always`
(the default for writes), `optional` or `never` (always, for reads). A result
is `{ ok: true, message, record?, data? }`.

## 5. Pages and fragments

A **page** is `{ name, kind, title, icon?, permission?, params, tool, … }`:

| `kind` | Extra keys | Drawn |
|---|---|---|
| `list` | `entity`, `columns` | Natively, from the list tool's rows |
| `record` | `entity`, `sections?` | Natively. Every entity has one (`derived: true` unless declared) |
| `dashboard` | `view` | Fragments on a grid |
| `custom` | `view`, or `view` + `url` | The developer's MCP Apps document, or their site in an isolated frame |

A **fragment** is a small live piece of the app shown in answers and on
dashboards: `{ type, title, description?, params, template?, view?, tool,
permission?, actions?, size? }`. Templates are `record` (one per entity,
`params { id }`), `card`, `stat`, `list`, `chart`; a fragment without a
template has only a `view`. A fragment instance's URI is
`modelapp://<app>/<type>/<base64url of its params, keys sorted>`.

**Views** are MCP Apps documents (`ui://<app>/…`, `text/html;profile=mcp-app`).
Any generated view MAY be overridden per entity, page or fragment; the
manifest then names the override in `view`. A host MAY still draw natively.

## 6. The generated MCP server

Streamable HTTP at `mcp.url`. Tools, in this order of derivation:

| Tool | From | Kind |
|---|---|---|
| `<entity>_list`, `<entity>_get` | each entity (filters, `query`, `sort`, `dir`, `cursor`, `limit` ≤ 100, default 25) | read |
| `search`, `fetch` | entities with a `search` field | read |
| `modelapp_resolve` | always: `{ uris, want? }` → each URI's state `ok \| gone \| no-access` and data, for hosts; hidden from models | read |
| `<entity>_<action>` or `<action>` | each action | read or write |
| `open_<page>` | each page except `record` pages (those are `<entity>_get`) | read |
| `show_<fragment>` | each non-record fragment | read |

Rules:

1. Names match `[a-zA-Z0-9_.-]{1,64}`, are unique, and MAY be renamed by the developer; the manifest carries the actual names.
2. Names, titles and descriptions are in the app's `locale` and identical for every caller and every call. Data labels follow the caller's locale.
3. Reads carry `readOnlyHint: true`. Writes carry `readOnlyHint: false` and `destructiveHint: true` exactly when `confirm` is `always`.
4. A write is listed to plain MCP clients only when the developer opted in (`plain: true`). An entity, page or fragment MAY be hidden from them (`plain: false`).
5. A tool the caller lacks the permission for is not listed.
6. Tools with a view name it in `_meta.ui.resourceUri`; the data to draw is the result's `structuredContent`.
7. Hand-written tools, resources and views MAY be added to the same server; they are outside the manifest.

## 7. Enforcement

All of it happens in the server, for both surfaces, before any handler runs.

- **Authorization is MCP's**: OAuth bearer tokens, protected-resource metadata (RFC 9728), a `401` with `WWW-Authenticate: Bearer resource_metadata=…`. Tokens are JWTs from an issuer the app trusts, with `aud` = `auth.audience` and one claim, `modelapp: { installation, person?, permissions?, locale?, host?: "workspace" | "plain" }`. There is no second sign-in.
- **Permissions**: entity, action, page, fragment and field permissions are checked on every call.
- **Field visibility**: a field the caller may not see is absent from rows, records, cards, filters and sorts.
- **Data per installation**: every handler receives `installation` and MUST scope every read and write by it.
- **Confirmation** of a write whose `confirm` is `always`:
  - a workspace host shows the person the exact values, then sends a proof: a JWT (`typ: modelapp-confirm+jwt`) signed by the token's issuer, bound to the tool, the call id and the hash of the arguments. Without a valid proof the call fails with `confirmation_required` and `error.confirm` describes what to show;
  - a plain client that supports MCP elicitation is asked to confirm;
  - otherwise the client's own approval applies, guided by `destructiveHint`.
- **Idempotency**: a write with a call id runs once per installation and tool; a repeat returns the first result, the same id with other arguments fails with `conflict`.
- **Host metadata**: one key. Requests MAY carry `_meta.modelapp = { call, confirmation, settings }`; results MAY carry `_meta.modelapp = { notifications, untrusted }` (`untrusted`: JSON pointers into `structuredContent`; in text, such values are wrapped in `<untrusted>`).
- **Errors**: `isError: true` and `structuredContent.error = { code, message }`, `code` one of `unauthorized`, `permission_denied`, `not_found`, `invalid_input`, `confirmation_required`, `conflict`, `internal`.

## 8. Conformance

[`packages/modelapp-spec`](../../packages/modelapp-spec) checks any app from outside,
over HTTP, whatever it is built with:

```sh
npm run modelapp:check -- https://crm.example.com --token <a plain caller's bearer>
```

| Check | Passes when |
|---|---|
| `manifest.served` | `GET /.well-known/modelapp.json` answers 200 with JSON |
| `manifest.schema` | the manifest validates against the JSON Schema |
| `manifest.references` | names refer to things the manifest declares; tool names are unique and valid |
| `auth.mcp` | without a token the endpoint answers 401 and points to protected-resource metadata |
| `mcp.initialize` | `initialize` succeeds with no extension |
| `mcp.tools` | tools match the manifest: names, `readOnlyHint`, `destructiveHint`; nothing hidden is listed |
| `mcp.deterministic` | `tools/list` is the same on every call |
| `mcp.views` | every view a tool names is served as an MCP Apps document |
| `mcp.manifest` | the manifest is one MCP resource, identical to the file |

An app is conformant when every check passes with a token.
