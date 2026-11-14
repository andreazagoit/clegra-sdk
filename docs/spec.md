# MCP Workspaces v1 — specification

> Draft 1.0 (2026-11-14). Normative. Placeholder names (`mcpw`, `@mcpw/server`,
> `io.mcpworkspaces/app`) wait for open question Q1. Everything not in this
> page is a [future extension](future/README.md) and not part of v1.

The words MUST, SHOULD and MAY are used as in RFC 2119.

## 1. What it is

**An MCP Workspaces app is one MCP server that is also a complete business
application.** The developer declares, on top of the official MCP SDK:

| Declaration | What it is |
|---|---|
| **entity** | A kind of record (Contact, Deal) as a Zod schema whose fields carry meaning |
| **action** | Something that can be done, on a record or globally, with a typed input and a confirmation policy |
| **page** | A screen people use without AI: `list`, `record`, `dashboard` or `custom` |
| **fragment type** | An interactive template filled with live data, shown in answers, on dashboards and in pages |
| **agent** | Instructions plus a subset of tools, run by the host's model |
| **permission**, **setting** | Who may do what; what an administrator configures per installation |

From these the SDK derives two things:

1. **Plain MCP tools and MCP Apps views** for any MCP host (ChatGPT, Claude,
   an IDE). They need nothing beyond MCP and MCP Apps.
2. **The workspace card**, a JSON document a **workspace host** (Clegra is
   the first) reads to mount the whole app natively: its pages in the
   navigation, its records as cards, its actions behind a confirmation, its
   agents.

**Why one server for both.** A developer writes and runs one thing. Plain
hosts get a good MCP server for free; a workspace host gets the meaning it
needs to draw native UI and enforce confirmations, without a second API.

## 2. The server

```ts
const app = new McpWorkspacesServer({
  name: "crm",                          // the app id: [a-z][a-z0-9-]{1,39}
  title: { en: "CRM", it: "CRM" },
  version: "1.0.0",
  description: { en: "Companies, contacts and deals." },
  icons: [{ src: "https://crm.example.com/icon.png", sizes: ["128x128"], mimeType: "image/png" }],
  locale: "en",                         // default locale of the labels
  auth: { issuers: [{ issuer: "https://node.example.com" }] },
})
// app.registerEntity / registerAction / registerPage / registerFragment /
// registerAgent / registerPermission / registerSetting
await app.listen({ port: 3920 })        // MCP at /mcp, card at /.well-known/mcp-workspace.json
```

The constructor takes no page or link: everything people see is declared
with `register…`. The server speaks MCP over Streamable HTTP (stateless) at
`/mcp` and announces the extension in `initialize`:

```json
{ "capabilities": { "extensions": { "io.mcpworkspaces/app": { "version": "1.0", "card": "mcpw://crm" } } } }
```

## 3. Labels and locales

Every label, title and description is a `Label`: a string (in the app's
`locale`) or a map `{ "en": "Deal", "it": "Trattativa" }`. The card carries
the maps; hosts pick the person's locale, then the app's `locale`, then the
first entry. Handlers read `ctx.locale` (from the token, else the app's) and
`ctx.t(label)`. Derived MCP tool titles and descriptions use `ctx.locale`.
Identifiers are never translated.

## 4. Entities

```ts
const deal = z.object({
  id: z.string(),                                                     // required, opaque, ≤ 200 chars
  name: z.string().meta({ role: "title", label: { en: "Name", it: "Nome" }, search: true }),
  company: ref("company").meta({ label: "Company", filter: true }),
  stage: z.enum(["open", "won", "lost"]).meta({ role: "status", label: "Stage", filter: true,
    labels: { open: "Open", won: "Won", lost: "Lost" }, tones: { won: "success", lost: "danger" } }),
  value: z.number().meta({ role: "amount", currency: "EUR", label: "Value", sort: true, permission: "deals.values" }),
  closeDate: z.string().meta({ role: "date", label: "Close date", sort: true, filter: true }),
  owner: z.string().meta({ role: "person", label: "Owner" }),
  notes: z.string().optional().meta({ label: "Notes", untrusted: true }),
})
const Deal = app.registerEntity("deal", {
  label: "Deal", plural: "Deals", icon: "handshake",
  description: "A sales opportunity with a company.",
  schema: deal,
  permission: "deals.view",                 // optional: who may see deals at all
  get: async (id, ctx) => /* the row or null */,
  list: async (query, ctx) => /* { rows, next?, total? } */,
})
```

**Field meaning** (`.meta()` keys; all optional):

| Key | Meaning |
|---|---|
| `role` | `title`, `subtitle`, `status`, `amount`, `date`, `person`: how hosts draw the record. At most one field per role; an entity MUST have a `title` |
| `label` | The field's label |
| `ref` | The field holds the id of a record of another entity of this app (`ref("company")`) |
| `permission` | Only callers with this permission see the field (field permission) |
| `filter`, `sort`, `search` | The field may be filtered on, sorted by, matched by text search |
| `labels`, `tones` | For an enum: a label per value; a tone per value (`neutral`, `info`, `success`, `warning`, `danger`) |
| `currency` | For `amount`: ISO 4217 code |
| `untrusted` | The value is text written by outsiders (emails, notes): hosts and models treat it as data, never instructions |

**Reads.** `get(id, ctx)` returns the record or `null`. `list(query, ctx)`
receives:

```ts
type Query = {
  filters: Record<string, Value | { in: Value[] } | { gte?: Value; lte?: Value }>  // only `filter` fields
  text?: string            // only when some field has `search`
  sort?: { field: string; dir: "asc" | "desc" }                                   // only `sort` fields
  cursor?: string          // opaque, from the previous page's `next`
  limit: number            // 1..100, default 25
}
```

and returns `{ rows, next?, total? }`. The SDK validates the query against
the declared meaning before the handler runs: a filter or sort on a field
that doesn't allow it, or on a field the caller may not see, is refused
(`invalid_input`). The handler MUST scope every read by `ctx.installation`
(§9).

**Derived tools.** `<entity>_list` takes the filter fields as top-level
arguments (a value, `{ "in": [...] }` or `{ "gte", "lte" }`), `query` (text),
`sort`, `dir`, `cursor`, `limit`; `<entity>_get` takes `id`. Results carry
the rows, their URIs, and `refs` (the titles of referenced records, field →
id → title) so hosts never show bare ids.

**URIs.** Every record has one address, `mcpw://<app>/<entity>/<id>` (id
percent-encoded as one segment). Results carry URIs; an app stores another
app's record as its URI, never a copy.

## 5. Actions

```ts
app.registerAction("mark_won", {
  entity: Deal,                                   // optional: on a record (the tool takes `id`)
  title: "Mark as won",
  description: "Closes the deal as won. Only when the person says so.",
  input: z.object({ note: z.string().max(500).optional() }),
  confirm: "always",                              // "always" | "optional" | "never"
  permission: "deals.edit",
}, async (input, ctx, record) => {
  /* change it, scoped by ctx.installation */
  return { message: `${record.name} marked as won.`, record: record.id }
})
```

- `readOnly: true` marks a read; its `confirm` is `never`. Every other action
  is a **write** and its `confirm` defaults to `always`.
- `always`: the host MUST show the person a confirmation with the action's
  title, the record and **every** input value, and call the tool only after
  the person confirms. `optional`: the host decides (a person acting on a
  page, an agent its author trusts). `never`: no confirmation.
- The handler returns `{ message?, record?, data? }`. `record` names the
  record it created or changed (id or URI).

## 6. Pages

Every page has a name, `title`, optional `icon`, optional `permission`, and
**params**: a Zod object describing the state it opens in (filters, a record
id, a tab). Hosts put params in the page's address; an assistant opens a page
in a state by giving params.

| `kind` | Declares | Drawn by |
|---|---|---|
| `list` | `entity`, `columns`, optional `params` + `query(params)` (default params: the entity's `filter` fields and `text`) | The host, natively |
| `record` | `entity`, optional `sections: [{ title, fields }]`; params `{ id }` | The host, natively, with the entity's actions |
| `dashboard` | `fragments(params, ctx)`: fragment instances in a grid | The host, natively (templates) or with each fragment's view |
| `custom` | `view: { html }` (an MCP Apps view) **or** `url` (the developer's own site) | The host, in an isolated frame |

Every entity gets a `record` page by default (its name is the entity's);
`registerPage` with the same name replaces it. A `custom` page with `url` is
shown in a sandboxed iframe with no access to the host's origin; with `view`,
it is an MCP Apps view and may call the app's tools through the host (which
applies permissions and confirmations as for any call).

**Why native pages first.** Lists, records and dashboards cover most
business screens; drawn by the host they look native on every platform, are
accessible, and stay usable without AI. `custom` is the escape hatch, not
the default.

## 7. Fragments

A **fragment instance** is `{ app, type, params }`: a live, interactive piece
of the app that an assistant puts in an answer, a dashboard shows, and people
can pin. It is always drawn from the app's live answer for the viewer.

- **Record cards.** Every entity is a fragment type of the same name with
  params `{ id }`: title, subtitle, status, amount, date, person, plus the
  entity's actions as buttons.
- **Custom types.** `registerFragment(type, { title, description, params,
  data, template | view })`. `data(params, ctx)` returns the live data;
  `template` is one of the native templates below, or `view` is an MCP Apps
  view that receives the data. `actions` lists the actions shown inside.

| Template | Data |
|---|---|
| `card` | `{ title, subtitle?, status?, fields: [{ label, value }], uri? }` |
| `stat` | `{ label, value, format?: "number" \| "money" \| "percent", currency?, hint? }` |
| `list` | `{ items: [{ title, subtitle?, status?, uri? }] }` |
| `chart` | `{ kind: "bar" \| "line" \| "pie", points: [{ label, value }], format? }` |

A fragment instance's URI is `mcpw://<app>/<type>/<key>`: `key` is the record
id for record cards, and base64url of the params' JSON (keys sorted) for
custom types. Type names and entity names share one namespace.

**Why templates.** Models never write UI or data: they pick a fragment type
and fill typed params, and the host draws a template it knows. Free-form
views remain possible, but a template works on every surface (chat, phone,
voice summary) without HTML.

## 8. Agents, permissions, settings, notifications

- `registerAgent(name, { title, description, instructions, tools, tier,
  starters? })`: `tools` are the app's entities (their read tools) and
  actions; `tier` is `fast`, `standard` or `strong`. The **host** runs the
  agent with its own model of that tier, under the person's permissions and
  the actions' confirmations. Plain hosts ignore agents.
- `registerPermission(id, { label, description?, default? })`: `id` is
  `group.verb` (`deals.edit`). The host grants permissions per person and
  puts them in the token (§9). `default: true` means granted to everyone of
  the installation unless an administrator removes it.
- `registerSetting(id, { label, type, required?, default?, options? })`:
  `type` is `text`, `secret`, `number`, `boolean` or `choice`. An
  administrator fills settings per installation in the host; the host sends
  them with every call (§10) and keeps secrets encrypted. Handlers read
  `ctx.settings`.
- `ctx.notify({ title, body?, uri?, to? })` inside a handler: the
  notification travels back with the result (§10); the host delivers it
  in-app to `to` (person ids; default the caller).

## 9. Auth and installations

Auth is **MCP authorization** (OAuth 2.1 with the app as the protected
resource). The app serves `/.well-known/oauth-protected-resource` naming its
authorization servers and answers 401 with `WWW-Authenticate` pointing to
it. The authorization server is either **the host** (a workspace host issues
tokens for its people: Clegra's company server does) or **the app's own**.
The app trusts a list of issuers; access tokens are JWTs verified with the
issuer's JWKS (`/.well-known/jwks.json` under the issuer by default).

Claims an app reads:

```json
{ "iss": "https://node.example.com", "aud": "crm", "sub": "p_81", "exp": 1763100000,
  "mcpw": { "installation": "inst_4c1", "person": { "id": "p_81", "name": "Ada Rossi" },
            "permissions": ["deals.view", "deals.edit"], "locale": "it", "host": "workspace" } }
```

- `aud` MUST be the app's name or its MCP resource URL.
- `mcpw.installation` is the tenant: one company's (or one person's) copy of
  the app. **Every read and write MUST be scoped by it.** A token without it
  is refused.
- `mcpw.permissions` are the caller's permissions among the app's own.
- `mcpw.host: "workspace"` says the caller is a workspace host, which
  confirms writes itself and sends proofs (§10). Any other token is a plain
  host's.
- **Dev mode** (`auth: { dev: true }`): the SDK generates a signing key and
  serves a minimal authorization server (dynamic client registration,
  PKCE, a sign-in page that asks for a one-time code printed on the console)
  for test people. Only when listening on a loopback address; never in
  production.

## 10. The wire, per call

`tools/call` MAY carry in `params._meta`:

| Key | Value |
|---|---|
| `mcpw/call` | The call id, unique per logical call; a retry keeps it |
| `mcpw/confirmation` | The confirmation proof, a JWS (below) |
| `mcpw/settings` | The installation's setting values |

Hosts resolve URIs into cards with the tool `mcpw_resolve` (`{ uris, want }`,
at most 50; hidden from models): one result per URI, in order, with `state`
`ok`, `no-access` (nothing else said) or `gone`.

Results carry `structuredContent` (the data, with URIs) and, in `_meta`,
`mcpw/notifications` (from `ctx.notify`) and `mcpw/untrusted` (JSON pointers
of untrusted values). Errors are results with `isError: true` and
`structuredContent.error = { code, message }`, `code` one of
`unauthorized`, `permission_denied`, `not_found`, `invalid_input`,
`confirmation_required`, `conflict`, `internal`.

**Confirmation proof.** After the person confirms, a workspace host signs,
with the same key as its tokens, a JWT of type `mcpw-confirm+jwt`:
`{ iss, aud, sub, tool, args, call, iat, exp }`, where `args` is base64url
SHA-256 of the arguments' JSON with keys sorted recursively, and `exp - iat
≤ 300`. For a workspace caller, an `always` action without a valid proof for
exactly these arguments and this call returns `confirmation_required` with
the action, record and input, so the host can ask and retry.

## 11. Security invariants

1. **Confirmation by the host, with the full input.** A workspace host shows
   every input value of an `always` action before it runs; the SDK refuses
   the call without the host's proof for exactly those arguments. Plain hosts
   get write tools marked `destructiveHint` and apply their own approval.
2. **Permissions enforced by the SDK.** Entity, action, page and fragment
   permissions and field permissions are checked on every call from the
   token, whatever the host did: hidden fields are removed from results and
   refused in filters and sorts.
3. **Untrusted text is marked.** Fields declared `untrusted` are listed in
   `_meta["mcpw/untrusted"]` and wrapped in the text the model reads;
   hosts never treat them as instructions.
4. **No data copies on the host.** A host keeps URIs, never records: every
   page, card and answer is read live from the app for that viewer (a
   display cache of seconds is allowed).
5. **Writes are idempotent by call id.** The SDK stores a write's result by
   `(installation, mcpw/call)` for 24 hours; a retry with the same id and
   arguments gets the stored result, with other arguments `conflict`.
6. **Tenancy.** Data are scoped by `mcpw.installation`; the SDK never serves
   a call without one.

## 12. What hosts see

| | Plain MCP host (ChatGPT, Claude) | Workspace host (Clegra) |
|---|---|---|
| Records | `search`, `fetch`, `<entity>_list`, `<entity>_get` tools, results drawn by the SDK's MCP Apps view | Native lists, record pages and cards from the card; the same tools for its assistant |
| Actions | `<entity>_<action>` / `<action>` tools; writes marked destructive; the host's own approval | Native buttons and assistant tools behind its «Confirm» with full input, proof sent |
| Pages | `open_<page>` tools showing the page in the SDK's view (custom pages: their own view) | In its navigation, native; custom pages in an isolated frame |
| Fragments | `show_<type>` tools with the SDK's view | Native templates in chat, dashboards and pins |
| Agents, settings, notifications | — | Run, filled and delivered by the host |

The card is served at `/.well-known/mcp-workspace.json` and as the MCP
resource `mcpw://<app>`. It lists, with localized labels: `name`, `title`,
`version`, `description`, `icons`, `locale`, `mcp.url`, `auth`
(`audience`, `authorizationServers`), `entities` (JSON Schema with meaning,
tools), `actions` (input schema, `confirm`, `permission`, tool), `pages`
(kind, params schema, tool, view), `fragments` (template or view, params,
tool), `agents`, `permissions`, `settings`.

## 13. Out of v1

Boards, calendars, events and webhooks, schedules, cross-app actions,
aggregates, presence, request objects, offline, store listing and every
other part of the earlier drafts are [future extensions](future/README.md).
