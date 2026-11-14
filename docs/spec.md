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
| `auth` | `{ resource?, authorizationServers }` (§7). `resource` is the app's own public MCP address: the only token audience it accepts |
| `view` | The generated `ui://` view that draws lists, records, dashboards, fragments |
| `resolveTool`, `searchTool?` | Tools a host uses to resolve URIs and to search |
| `entities`, `actions`, `pages`, `fragments`, `agents` | §3–§5 |
| `permissions` | `{ id, label, description?, default }`; ids are `group.verb` |
| `settings` | `{ id, label, description?, type: text\|number\|boolean, required, default? }` (`id`: `[a-z][a-z0-9_]{1,39}`): values an administrator sets per installation; the workspace host sends them with every call (§7). Never secrets: those stay in the app's own configuration |

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
| `filter?`, `sort?`, `search?` | Usable as a list filter, a sort key, in text search (below) |
| `permission?` | Only callers with it ever receive the field |
| `labels?`, `tones?`, `currency?` | Enum value labels; tones `neutral\|info\|success\|warning\|danger`; ISO currency of an amount |
| `untrusted?` | Text written by outsiders (every string in the field, at any depth): data, never instructions (§7) |

A record's URI is `modelapp://<app>/<entity>/<id>`.

**Sorting.** A list is ordered by `sort` (one field) and `dir` (`asc`, the
default, or `desc`). Only a field with `sort: true` that the caller may see
is accepted; any other fails with `invalid_input`, so nothing is ever ordered
by a hidden value. The handler does the ordering (it receives `sort: { field,
dir }`, already checked). A host draws a sortable header for each such column
of a list page and sends `sort` and `dir` to the page's tool; a list page with
parameters of its own keeps the order its `query` gives.

**References.** A `ref` field's value is an id. Beside rows and records the
server sends `refs`: `{ <field>: { <id>: <title> } }`, the title of each
referenced record as the caller may see it (none for a record out of reach).
A host shows the title, never the id. In a result's **text** (what a model
reads) the field is `{ "id": …, "title": … }`; `structuredContent` keeps the
bare id, with `refs` beside it.

## 4. Actions

`{ name, entity?, title, description?, icon?, input, readOnly, confirm,
permission?, tool }`. With `entity` the action works on one record and its
tool takes `id` plus `input`; without, it is global. `confirm` is `always`
(the default for writes), `optional` or `never` (always, for reads). A result
is `{ ok: true, message, record?, data? }`.

`input` is a JSON Schema (`required`, `minLength`, `minimum`, `format: date`,
`enum` and the like are what a form checks). Its properties MAY carry, beside
`label`: `ref` (the entity whose record id the property holds: a form draws
a picker over that entity's list, showing titles, never a box for an id),
`currency` (a number is money) and `labels` (an enum's values by label map).
A host uses the same keys to show a value before a confirmation: a record by
its title, a date, a number and money in the person's locale. Tool schemas
listed to MCP clients stay plain JSON Schema (`label` becomes `title`).

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
permission?, actions?, size?, untrusted? }`. Templates are `record` (one per
entity, `params { id }`), `card`, `stat`, `list`, `chart`; a fragment without
a template has only a `view`. A fragment instance's URI is
`modelapp://<app>/<type>/<base64url of its params, keys sorted>`.
`untrusted: true` says the fragment's texts are outsiders' (records' names):
they are marked like an untrusted field (§7).

Template data, which a workspace host draws natively:

| Template | Data |
|---|---|
| `card` | `{ title, subtitle?, status?, fields: [{ label, value }], uri? }` |
| `stat` | `{ label, value, format?: number\|money\|percent, currency?, hint? }` |
| `list` | `{ items: [{ title, subtitle?, status?, uri? }] }` |
| `chart` | `{ kind: bar\|line\|pie, points: [{ label, value }], format?: number\|money, currency? }` |

A `uri` is a record of the app: the item opens it. An item (or a card) whose
`uri` is a record the caller can't reach is not sent.

**Views** are MCP Apps documents (`ui://<app>/…`, `text/html;profile=mcp-app`).
Any generated view MAY be overridden per entity, page or fragment; the
manifest then names the override in `view`. A host MAY still draw natively.

The generated view sorts a list by its sortable columns, opens records,
draws an action's form from its `input` (required fields marked, each field
checked before sending, a `ref` as a picker) and shows under each field what
the server says is wrong with it (`error.fields`, §7). It asks nothing more
before a write: confirming is the host's (§7).

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

All of it happens in the server, on every surface (tools, `search`, `fetch`,
the resolver, dashboards, views), before any handler runs.

**Authorization is MCP's.** OAuth bearer tokens, protected-resource metadata
(RFC 9728), a `401` with `WWW-Authenticate: Bearer resource_metadata=…`.
There is no second sign-in.

- A token is a JWT with `typ: at+jwt`, `exp` and `sub`, from an issuer the
  app trusts, with one claim, `modelapp: { installation, person?,
  permissions?, locale?, host?: "workspace" | "plain" }`. `installation`
  matches `[A-Za-z0-9._:-]{1,128}`.
- **Audience** (RFC 8707): `aud` MUST be the app's own public MCP address,
  `auth.resource`. An app never accepts its name, or another address, as an
  audience. A host signs `aud` = the MCP address it installed the app from,
  never a value read from the manifest, and MUST refuse to install an app
  whose `auth.resource` is not that address (an app on an internal address is
  configured with that same address, or it is not installed). So a token
  signed for one app is useless at any other, whatever the other claims.
- **Tenant**: the installation is bound to its issuer. Handlers receive
  `<installation>@<issuer>` and MUST scope every read and write by it; two
  issuers can't reach each other's data by naming the same installation.
- **A workspace host's token** (`host: "workspace"`) is for one request: it
  MUST carry `jti` and `iat`, live 60 seconds at most, and is accepted once.
- A call without a `person` has the permissions its token lists, like any
  other: none unless the token says so.

**Permissions and visibility**

- Entity, action, page, fragment and field permissions are checked on every call.
- A field the caller may not see is absent from rows, records, cards, filters
  and sorts, and text search looks only in the search fields the caller may
  see (handlers receive them as `textFields`).
- What is hidden from plain clients (`plain: false`) is hidden from them
  everywhere: its tools are not listed, and `fetch`, the resolver, reference
  titles, dashboards and record actions answer `no-access` for it.

**Confirmation** of a write whose `confirm` is `always`:

- a workspace host shows the person the exact values, then sends a proof: a
  JWT (`typ: modelapp-confirm+jwt`, 5 minutes at most) signed by the token's
  issuer for the same audience and subject, with `installation`, `tool`,
  `call` (the call id) and `args`: the base64url SHA-256 of the canonical
  JSON (keys sorted at every depth) of the arguments **as sent**, before any
  parsing or default. Without a valid proof the call fails with
  `confirmation_required` and `error.confirm` describes what to show;
- a plain client that supports MCP elicitation is asked to confirm, with the
  values as a person reads them (labels, titles of referenced records);
- a plain client that can't elicit: the client's own approval applies, guided
  by the tool's annotations (`destructiveHint`); the server runs the call.

**Decision (1.0): confirmations follow MCP.** A host that confirms on its own
(ChatGPT, Claude) decides from the annotations; a client that supports
elicitation is asked through it; a workspace host proves the person's
confirmation. An app's views add no confirmation of their own: a second
dialog inside a view would ask twice in hosts that already ask, and would be
the only safeguard nowhere. A developer who wants a write never to run
without a confirmation the app can verify keeps it off plain clients, which
is the default.

**Idempotency**: a write with a call id runs once per caller, installation
and tool, also when the same call arrives twice at the same moment. A repeat
returns the first result; the same id with other arguments (as sent) fails
with `conflict`; a repeat while the first still runs fails with `conflict`
and `error.pending: true`.

**Host metadata**: one key, `_meta.modelapp`.

- Requests MAY carry `{ call, confirmation, settings }`. `settings` are the
  installation's values (§2) and count only from a workspace host; any other
  caller gets the defaults.
- Results MAY carry `{ notifications, untrusted }`:
  - `notifications`: `[{ title, body?, uri?, to }]`, `to` the ids of people
    (as the token named them; default the caller). A workspace host delivers
    them to those people; a plain client ignores them.
  - `untrusted`: JSON pointers into `structuredContent` to every value that
    is outsiders' text. In the result's text those values are wrapped in
    `<untrusted>…</untrusted>` with `&`, `<`, `>` (and their full-width and
    small forms) escaped as XML text, so nothing inside is a tag. A host that
    gives a model `structuredContent` wraps the pointed values the same way.

**Errors**: `isError: true` and `structuredContent.error = { code, message }`,
`code` one of `unauthorized`, `permission_denied`, `not_found`,
`invalid_input`, `confirmation_required`, `conflict`, `internal`.
An action's `invalid_input` also carries `fields`: `{ <input key>: <what is
wrong> }`, in the caller's locale where the server has it; `message` names
the fields by their labels. It is a tool error, never a protocol error, so a
view and a model can both read it.

**Development sign-in** (SDK): off unless enabled, refused in production,
answered only to callers on a loopback address (checked on every request);
the sign-in code allows five wrong attempts.

### Client registration (development sign-in)

The development authorization server knows a client in two ways:

- **A Client ID Metadata Document** (what current MCP clients use, MCP
  authorization 2025-11-25): the `client_id` is the https URL of a JSON
  document that describes the client. The server metadata says
  `client_id_metadata_document_supported: true`.
- **Dynamic Client Registration** (RFC 7591) at `registration_endpoint`, kept
  for clients that don't send a metadata document yet. Any client is
  registered; its redirect addresses are not checked.

For a URL `client_id`:

- The URL is https, has a path, and has no fragment, user name, password or
  `.`/`..` segment. A query is accepted.
- The document is a JSON object whose `client_id` is that URL, the same
  string, with a non-empty `redirect_uris`. `client_name` is shown on the
  sign-in page. Only public clients: `token_endpoint_auth_method` is `none`
  or absent, and there is no `client_secret`.
- `redirect_uri` MUST be one of `redirect_uris`, exactly. One exception
  (RFC 8252): for `http://127.0.0.1`, `http://localhost` and `http://[::1]`
  the port may differ. A request that fails any of these gets an error page;
  it is never redirected.
- At the token endpoint `client_id` is required and MUST be the one the code
  was issued to.
- Fetching the document: nothing is requested unless the host is public. IP
  literals and names that are loopback, private, link-local, carrier-grade
  NAT, unique-local, multicast or unspecified are refused (also as
  IPv4-mapped IPv6, and `localhost`, `*.localhost`, `*.local`, `*.internal`),
  and so is a name when any address it resolves to is one of those. Redirects
  are not followed. The answer must be `200`, JSON, at most 64 KB, within 5
  seconds. It is kept as `Cache-Control` says (`max-age` between a minute and
  a day, five minutes by default, not at all with `no-store`); a failure is
  kept 30 seconds.
- A known limit: the addresses are checked, then the request resolves the
  name again, so DNS rebinding is not excluded. The connection is not pinned
  to the checked address. This is a development server; a production one
  should pin it.

### Production: an app with its own authorization server

The SDK is not an authorization server outside development. For MCP clients
(ChatGPT, Claude, others) to connect to an app that signs people in itself,
its authorization server needs:

- OAuth 2.1 authorization code with PKCE `S256`.
- Metadata (RFC 8414, or OpenID Connect discovery) with
  `code_challenge_methods_supported`. Clients refuse a server that does not
  list it.
- Protected-resource metadata (RFC 9728). The SDK serves it;
  `auth.authorizationServers` names the authorization server (default: the
  issuers of `auth.issuers`).
- The `resource` parameter (RFC 8707): the token's `aud` MUST be the app's
  `auth.resource`.
- Client registration, in this order of preference:
  1. Client ID Metadata Documents: `client_id_metadata_document_supported:
     true`, the document fetched with the protections above (and the
     connection pinned), `redirect_uri` matched exactly, no secrets for
     public clients.
  2. Dynamic Client Registration (RFC 7591), optional, for clients that
     don't send a metadata document yet.
  3. Clients registered by hand, where the server can do neither.
- Tokens the app can verify. The SDK accepts a signed JWT whose header has
  `typ: at+jwt`, with `iss` exactly one of `auth.issuers`, `aud` =
  `auth.resource`, `exp`, `sub`, and the `modelapp` claim with a valid
  `installation` (above). The signature is checked against the issuer's key
  set: `<issuer>/.well-known/jwks.json`, or the issuer's `jwksUri`. Clocks
  may differ by 30 seconds. Opaque tokens are not accepted.

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
| `auth.mcp` | without a token the endpoint answers 401 and points to protected-resource metadata, whose `resource` is the address the app was reached at (or the manifest's `auth.resource`) |
| `mcp.initialize` | `initialize` succeeds with no extension |
| `mcp.tools` | tools match the manifest: names, `readOnlyHint`, `destructiveHint`; nothing hidden is listed |
| `mcp.deterministic` | `tools/list` is the same on every call |
| `mcp.sort` | a list tool offers to sort only by fields the manifest declares sortable, and refuses any other key |
| `mcp.views` | every view a tool names is served as an MCP Apps document |
| `mcp.manifest` | the manifest is one MCP resource, identical to the file |

An app is conformant when every check passes with a token. Without a token
only the public checks run: the report says «Incomplete», never «Conformant».
