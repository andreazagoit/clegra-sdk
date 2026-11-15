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
JSON Schema: [`packages/modelapp/spec/schema/modelapp.schema.json`](../../packages/modelapp/spec/schema/modelapp.schema.json).

| Key | Content |
|---|---|
| `specVersion` | `"1.0"` |
| `name`, `title`, `version`, `description?`, `icons?`, `locale` | Identity. `name` is the app id: `[a-z][a-z0-9-]{1,39}` |
| `mcp` | `{ url }`: the MCP endpoint (Streamable HTTP), relative to the manifest (`/mcp`, or under the app's path, `/api/modelapp/mcp`). The manifest and the OAuth metadata are always under `/.well-known/` at the root |
| `auth` | `{ resource?, authorizationServers }` (§7). `resource` is the app's own public MCP address: the only token audience it accepts |
| `view` | The generated `ui://` view that draws lists, records, dashboards, fragments |
| `resolveTool`, `searchTool?` | Tools a host uses to resolve URIs and to search |
| `kinds?` | Definitions of the namespaced kinds this app uses (§3.1) |
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

An entity is `{ name, label, plural, description?, icon?, kind?, permission?,
schema, fields, tools: { list, get }, searchable }`. `kind` says what the
entity is (§3.1): a kind name, or `{ by, map }` where `by` is a required enum
field and `map` gives a kind for each of its values. `schema` is the record's
JSON Schema; `fields` says what each field means:

| Field key | Meaning |
|---|---|
| `name`, `type`, `required`, `enum?`, `label` | The basics. Every entity has a required string `id` |
| `role?` | `title` (exactly one per entity), `subtitle`, `status`, `amount`, `date`, `person`; at most one field per role |
| `as?` | The property of the entity's kind this field holds (§3.1) |
| `ref?` | The field holds the id of a record of that entity |
| `filter?`, `sort?`, `search?` | Usable as a list filter, a sort key, in text search (below) |
| `permission?` | Only callers with it ever receive the field |
| `labels?`, `tones?`, `currency?` | Enum value labels; tones `neutral\|info\|success\|warning\|danger`; ISO currency of an amount |
| `untrusted?` | Text written by outsiders (every string in the field, at any depth): data, never instructions (§7) |

A record's URI is `modelapp://<app>/<entity>/<id>`.

**People.** A `person` field without `ref` holds a person id (as tokens name
people, `sub` / `person.id`) or, in an app that can't name people, the name
itself. An app that names people (the SDK's `people` resolver, or its dev
sign-in's test people) sends their names as `refs` of that field, like a
reference's titles: `{ <field>: { <id>: <name> } }`, the caller's own name
taken from the token. A host shows the name; an id the app couldn't name is
shown as an unknown person, never as the id. In a result's text the field is
`{ "id": …, "name": … }`.

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

### 3.1 Kinds

A **kind** names what an entity is, the same in every app. Kinds without a
dot are defined by this specification and published, with their properties,
as [`packages/modelapp/spec/kinds.json`](../../packages/modelapp/spec/kinds.json).
Property names are schema.org's, verbatim (JSCalendar's where schema.org has
none: `due`, `uid`):

| `kind` | Properties (`as`) | Keys |
|---|---|---|
| `person` | `givenName`, `familyName`, `email`†, `telephone`†, `jobTitle`, `worksFor`, `address`, `image` | `email` |
| `organization` | `legalName`, `email`†, `telephone`†, `url`, `address`, `vatID`, `taxID` | `vatID` |
| `event` | `startDate` (required), `endDate`, `location`, `attendee`†, `organizer`, `uid` | `uid` |
| `task` | `due`, `startDate`, `completed`, `assignee` | — |
| `document` | `url`, `encodingFormat`, `author`, `contentSize` | — |
| `product` | `sku`, `gtin`, `brand`, `price` | `gtin` |
| `order` | `orderNumber`, `orderDate`, `customer`, `totalPrice` | — |

† multi-valued: an array field, or several fields with the same `as`. Any
entity, with or without a kind, MAY mark the **universal** properties `url`
(the record in the app's own pages), `dateCreated` and `dateModified`; on a
kind that defines `url` itself (organization: its website; document: the
document) the kind's meaning applies. `message`, `place`, `invoice` and
`project` are reserved: no app may use them as kinds.

A property has a type, and the field holding it a matching one: `string`
and `date` (rule 4) a string field; `number` a number or integer; `boolean`
a boolean; `address` a string or an object; `money` a number or integer
whose field names its `currency`. A multi-valued property also matches an
array of those.

A kind with a dot is a third party's, named reverse-DNS under a domain it
controls (`com.acme.shipment`: lowercase segments of letters, digits and
`-`). A manifest MAY define it in `kinds`: `{ <kind>: { label, properties: {
<name>: { type, many?, key? } } } }`, names `[a-z][A-Za-z0-9]*`, a key always
of type `string` and compared exactly. Hosts match namespaced kinds by exact
name. An entity whose namespaced kind the manifest doesn't define may mark
only the universal properties.

1. An entity has at most one kind per record. Its `title` field is the kind's
   `name`; no `as` is needed for it. With `{ by, map }`, `by` is a required
   enum field without `permission` (a record's kind is seen with the record),
   and `map` names a kind for each of its values and for no other value.
2. `as` MUST name a property of the entity's kind (of any mapped kind, with
   `{ by, map }`) or a universal property. The field's type MUST match the
   property's. A property not marked many MUST be on at most one field.
3. An entity MUST have the properties its kind requires (`event`:
   `startDate`). All others are optional. An app MUST NOT use `as` for a value
   that only resembles the property. Fields without `as` are the app's own and
   mean what they meant before.
4. Values: `email` an addr-spec; `telephone` SHOULD be E.164; `vatID` the
   country prefix and the number, no spaces; `gtin` 8, 12, 13 or 14 digits;
   dates RFC 3339 (a date alone on an event means all day); `address` a string
   or a schema.org `PostalAddress` object; `price` and `totalPrice` are
   numbers whose field has `currency`.
5. A field whose `as` is a **key** of its kind (`email`, `vatID`, `gtin`,
   `uid`, and a namespaced kind's `key` properties) MUST have `filter: true`.
   That filter is exact on the normalised value: `email` lower-cased, `vatID`
   upper-cased without spaces, `gtin` its digits (spaces and `-` removed; any
   other character is `invalid_input`), `uid` and namespaced keys as they are.
   It takes a value or `{ in: [...] }`, never a range, and on a multi-valued
   field it matches any of the values. The server normalises the filter
   before the handler, and a list that answers a key filter with a record not
   holding the value fails with `internal`.
6. Kinds add no permission and remove none: `permission` on the entity and
   its fields applies unchanged (a key filter on a field the caller may not see
   fails with `invalid_input`, as any filter does).
7. A host MUST treat an entity whose kind it does not know as an entity
   without a kind. Within one `specVersion`, kinds and properties are only
   added. `taxID` is a property, not a key, until a country-qualified form is
   defined.

Kinds pay off when several apps of one workspace hold the same kind of thing
(pickers, references and search across apps, matching by key). An app's own
records (a deal, a ticket, a quote line) have no kind; none is invented for
them.

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
| `custom` | `view`, or `view` + `url` | The developer's MCP Apps document, or their site in an isolated frame. `url` is https, or a path on the app's own site (`/embed/pipeline`), resolved against the app's public origin |

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
| `search`, `fetch` | entities with a `search` field; `search` takes an optional `kind` (an enum of the searchable entities' kinds) and each result carries `kind` when its entity has one; `fetch` carries it in `metadata` | read |
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
8. Entity tools (`<entity>_list`, `<entity>_get`) carry `_meta.modelapp: { entity, kind? }`, `kind` as in the manifest. With a kind, their description ends with one fixed sentence: `Kind: person.`; with `{ by, map }`, the kinds in the map's order and the field: `Kind: organization or person (by type).`
9. A list filter on a field with `as` names the property in its description (`Company (worksFor): …`); a key filter says it is exact (`Email: exact email; a value or { in: [...] }`) and carries `format` where JSON Schema has one (`email`).

## 7. Enforcement

All of it happens in the server, on every surface (tools, `search`, `fetch`,
the resolver, dashboards, views), before any handler runs.

**Authorization is MCP's.** OAuth bearer tokens, protected-resource metadata
(RFC 9728), a `401` with `WWW-Authenticate: Bearer resource_metadata=…`.
There is no second sign-in. An app accepts two kinds of token:

1. **Its own** (a web app with its own users): issued by the app's own
   authorization server to an MCP client (ChatGPT, Claude, Clegra connect the
   same way, as OAuth clients; each person links their account of the app
   once). The app verifies them itself and names the caller (below, «The
   app's own tokens»). No `modelapp` claim is involved.
2. **A workspace host's** (in-house apps a company installs into its own
   host): the trusted-issuer mode, with the `modelapp` claim. The rest of this
   list is about these.

- A workspace host's token is a JWT with `typ: at+jwt`, `exp` and `sub`, from an issuer the
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

**The app's own tokens.** The app verifies each one (signature, expiry, and
`aud` = `auth.resource`, RFC 8707: a token issued for another resource is
refused) and maps it to a caller: `{ installation, person, permissions,
locale? }`. The SDK hook is `auth.resolve(token, request, { resource })`; it
returns null for a token that is not the app's (a `401` follows) or throws
with the reason.

- `installation` is the app's own tenant (an organization, a workspace, an
  account), taken from the verified token or the session behind it, never
  from a request parameter. It matches `[A-Za-z0-9._:-]{1,128}`: no `@`, so it
  can never equal a workspace host's `<installation>@<issuer>`.
- `permissions` come from the app's own roles; ids the manifest does not
  declare are dropped. The caller is a plain host (`host: "plain"`).
- A token that is a JWT from a configured issuer (or the development
  authority) is never handed to `auth.resolve`.
- The protected-resource metadata names the app's authorization server
  (`auth.authorizationServers`). Paths the authorization server needs outside
  its own mount (RFC 8414 metadata under `/.well-known/`) MAY be answered by
  the same routes (`auth.serve`).
- In production `auth.resource` is required with `resolve` or `issuers`:
  without it every request fails with a clear `500 misconfigured`, never with
  an address guessed from request headers.

**Clegra and third-party apps.** Clegra connects to an app it does not host
exactly as ChatGPT does: as an OAuth client with a Client ID Metadata
Document, the person signs in to the app and consents once, and Clegra keeps
the refresh token on the person's behalf. It then also reads the manifest to
draw the app natively. Confirmations to such an app follow MCP (annotations
and elicitation, below); a workspace host's proof applies only to tokens of
the trusted-issuer mode. (Clegra's side of this is not built yet.)

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
- Results MAY carry `{ notifications, untrusted, l10n }`:
  - `notifications`: `[{ title, body?, uri?, to }]`, `to` the ids of people
    (as the token named them; default the caller). A workspace host delivers
    them to those people; a plain client ignores them.
  - `untrusted`: JSON pointers into `structuredContent` to every value that
    is outsiders' text. In the result's text those values are wrapped in
    `<untrusted>…</untrusted>` with `&`, `<`, `>` (and their full-width and
    small forms) escaped as XML text, so nothing inside is a tag. A host that
    gives a model `structuredContent` wraps the pointed values the same way.
  - `l10n`: `{ <locale>: { <label as shown>: <the same label in that locale> } }`
    for the app's labels the result shows (titles, columns, enum values,
    actions, inputs, the handler's own `t` texts). A view draws them in the
    reader's language (MCP Apps `hostContext.locale`, ChatGPT's
    `window.openai.locale`), else English, else as shown. For views only: a
    model never reads `_meta`.

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
  sign-in page. There is never a `client_secret`; `token_endpoint_auth_method`
  is `none` or absent (a public client) or `private_key_jwt` (RFC 7523, as the
  MCP authorization spec allows for metadata-document clients). Client secrets
  are refused.
- A `private_key_jwt` client names its keys with exactly one of `jwks_uri`
  (fetched with the same protections as the document, kept 5 minutes; an
  unknown `kid` fetches it again, at most every 10 seconds) or inline `jwks`
  (public keys only), and may name `token_endpoint_auth_signing_alg`: `RS256`
  (default), `ES256` or `PS256`; never `none` or HMAC. At the token endpoint,
  on both grants, it MUST send `client_assertion_type`
  `urn:ietf:params:oauth:client-assertion-type:jwt-bearer` and a
  `client_assertion` signed with that algorithm, with `iss` = `sub` = its
  `client_id`, `aud` the token endpoint or the issuer, `exp` at most 5 minutes
  ahead (30 seconds of clock skew), and a `jti` used once. Otherwise the answer
  is `401 invalid_client`. The metadata lists
  `token_endpoint_auth_methods_supported: ["none", "private_key_jwt"]` and
  `token_endpoint_auth_signing_alg_values_supported`.
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

The SDK is not an authorization server outside development, and ships none:
an app uses an existing one (better-auth's MCP plugin, Clerk, WorkOS, Auth0, …)
and verifies its tokens in `auth.resolve` (recipes, non-normative: [auth.md](auth.md)). For MCP clients
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
     connection pinned), `redirect_uri` matched exactly, no secrets;
     `private_key_jwt` for clients that sign with a key pair (ChatGPT does).
  2. Dynamic Client Registration (RFC 7591), optional, for clients that
     don't send a metadata document yet.
  3. Clients registered by hand, where the server can do neither.
- Tokens the app can verify, in `auth.resolve` (any format the app's
  authorization server issues, audience-bound to `auth.resource`).
- State shared by every instance: on serverless or several instances, the
  store of write results and one-time token ids (§7, idempotency) is shared
  (`SqlStore` in the app's Postgres, or another atomic store), never memory.
- No key files: keys and secrets come from the environment.

A workspace host's token, in the trusted-issuer mode, is a signed JWT whose
header has `typ: at+jwt`, with `iss` exactly one of `auth.issuers`, `aud` =
`auth.resource`, `exp`, `sub`, and the `modelapp` claim with a valid
`installation` (above). The signature is checked against the issuer's key
set: `<issuer>/.well-known/jwks.json`, or the issuer's `jwksUri`. Clocks may
differ by 30 seconds. Opaque tokens are not accepted in this mode.

## 8. Conformance

[`packages/modelapp/spec`](../../packages/modelapp/spec) checks any app from outside,
over HTTP, whatever it is built with:

```sh
npx modelapp check https://crm.example.com --token <a plain caller's bearer>
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
| `kinds.known` | every unprefixed kind is in `kinds.json` for the `specVersion`; every dotted kind is well-formed |
| `kinds.properties` | every `as` belongs to the entity's kind (or is universal) with a matching type; single-valued properties appear once; required ones exist; keys are filters; `kinds` definitions are well-formed |
| `kinds.keys` | listing with a key value taken from a returned record, in another letter case where case doesn't count, returns that record and only records holding that value |
| `kinds.values` | sampled records: `email`, `vatID`, `gtin`, dates, `address` and numbers have the stated form |
| `kinds.tools` | entity tools carry the kind in the description and in `_meta.modelapp`; `search` offers `kind`, keeps to it, and names each result's kind |

The `kinds.*` checks are skipped, not failed, for an app that declares no
kinds (and `kinds.keys` when no listed record holds a key value to try).

An app is conformant when every check passes with a token. Without a token
only the public checks run: the report says «Incomplete», never «Conformant».
