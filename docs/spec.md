# Clegra apps — specification

> Version 1.0, draft (2026-11-14). Normative; MUST, SHOULD and MAY as in RFC 2119.
> Clegra apps are Clegra's own developer platform: apps that Clegra draws natively
> in its workspace and that are, at the same time, plain MCP servers that ChatGPT,
> Claude and any MCP client use as they are. The package `clegra` builds them; this
> page is the contract they meet. The wire name is `clegra` (manifest path, URI
> scheme, `_meta` key, token claim, OAuth scope, resolve tool).
> Anything not on this page is not part of 1.0.

## 1. What it is

An **app** is described once, as one definition: entities, actions, pages,
fragments, agents, permissions, settings. The definition has two halves:

- the **manifest**: pure JSON, no code. The *workspace host* (Clegra: the
  node of the company or person that installed the app; «host» below) reads it
  with one fetch and draws the app natively: pages in its navigation, records
  as cards, actions behind a confirmation, agents.
- the **handlers** (`get`, `list`, `run`, `data`), reached through a **plain
  MCP server** generated from the same definition: tools with correct
  annotations and MCP Apps `ui://` views. ChatGPT, Claude and any MCP client
  use it as they use any MCP server.

**No MCP extension is required or announced.** An MCP client never needs the
manifest; the workspace host needs nothing beyond the manifest and MCP.

## 2. The manifest

Served at `GET /.well-known/clegra.json` (no authentication) and as one
MCP resource, `clegra://<name>` (`application/json`); the two MUST be identical.
JSON Schema: [`packages/clegra/spec/schema/clegra.schema.json`](../../packages/clegra/spec/schema/clegra.schema.json).

| Key | Content |
|---|---|
| `specVersion` | `"1.0"` |
| `name`, `title`, `version`, `description?`, `icons?`, `locale` | Identity. `name` is the app id: `[a-z][a-z0-9-]{1,39}` |
| `mcp` | `{ url }`: the MCP endpoint (Streamable HTTP), relative to the manifest (`/mcp`, or under the app's path, `/api/clegra/mcp`). The manifest and the OAuth metadata are always under `/.well-known/` at the root |
| `auth` | `{ resource?, authorizationServers }` (§7). `resource` is the app's own public MCP address: the only token audience it accepts |
| `view` | The generated `ui://` view that draws lists, records, dashboards, fragments |
| `resolveTool`, `searchTool?` | Tools a host uses to resolve URIs and to search |
| `embed?` | `{ tool, path, frameAncestors }`: the app's own pages that hosts frame (§5.1). Present exactly when a page has a same-site `url` |
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
| `ref?` | An entity name: the field holds the id of a record of that entity. Or `{ kind }`: the field holds the URI of a record of that kind, in any app (§3.2) |
| `filter?`, `sort?`, `search?` | Usable as a list filter, a sort key, in text search (below) |
| `permission?` | Only callers with it ever receive the field |
| `labels?`, `tones?`, `currency?` | Enum value labels; tones `neutral\|info\|success\|warning\|danger`; ISO currency of an amount |
| `untrusted?` | Text written by outsiders (every string in the field, at any depth): data, never instructions (§7) |

A record's URI is `clegra://<app>/<entity>/<id>`.

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
as [`packages/clegra/spec/kinds.json`](../../packages/clegra/spec/kinds.json).
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

### 3.2 References across apps

A field with `ref: { kind }` holds a record URI, `clegra://<app>/<entity>/<id>`
(`<app>` the name the app has in the workspace, §9): a record of that kind in
any app, this one included. Syntactically valid means: `<app>` matches
`[a-z][a-z0-9-]{1,39}`, `<entity>` `[a-z][a-z0-9_]{0,39}`, and `<id>` is one
or more characters without `/`, `?`, `#` or white space (an id that has them
is percent-encoded). The app stores the URI and nothing else of the
record (a title would be a copy that outlives permissions). It MUST accept any
syntactically valid record URI, MUST NOT call the other app, and sends no
`refs` entry for the field: the host resolves it for each viewer (§9). In a
result's text the field is `{ "uri": …, "kind": … }`, and the descriptions of
the entity's tools say, in a fixed sentence before the kind's, that the app
the URI names opens it with its `fetch` tool. An action input property MAY
carry the same `ref` (§4); its tool's description says it takes the URI.

A workspace host that relays a result to the app's view MAY add
`_meta.clegra.resolved`: `{ <uri>: { state, title? } }`, `state` being
`ok` (with the title) or one of the states of §9 rule 3. The generated view shows the title for `ok` and the state
otherwise; without it (a plain host) it shows the app and entity the URI
names, never a title.

## 4. Actions

`{ name, entity?, title, description?, icon?, input, readOnly, confirm,
permission?, tool }`. With `entity` the action works on one record and its
tool takes `id` plus `input`; without, it is global. `confirm` is `always`
(the default for writes), `optional` or `never` (always, for reads). A result
is `{ ok: true, message, record?, data? }`.

`input` is a JSON Schema (`required`, `minLength`, `minimum`, `format: date`,
`enum` and the like are what a form checks). Its properties MAY carry, beside
`label`: `ref` (the entity whose record id the property holds: a form draws
a picker over that entity's list, showing titles, never a box for an id; or
`{ kind }`: the property holds a record URI of that kind in any app, §3.2,
and a workspace host draws its picker over every app of the workspace with
that kind),
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
`clegra://<app>/<type>/<base64url of its params, keys sorted>`.
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

The generated view and the host (MCP Apps, `2026-01-26`):

- It sends `ui/initialize`, then `ui/notifications/initialized`, and makes
  no `tools/call` before the host answered. A host that answers is called
  over that bridge (ChatGPT included). Only a host that refuses
  `ui/initialize` and offers `window.openai.callTool` is called through it,
  and an answer without the result's `structuredContent` is an error.
- It draws the result of the call that opened it once: from
  `ui/notifications/tool-result`, or from `window.openai.toolOutput` (its
  `_meta` from `toolResponseMetadata`, the MCP result envelope) when that is
  there first. Later tool-result notifications (hosts send them for the
  view's own calls too) and `openai:set_globals` events never replace what
  the person opened since; a new locale draws the same screen again.
- Every click that calls a tool shows progress at once, then the result, or
  what the app or the host said (a host's refusal in its own words, a host
  that doesn't answer within 30 seconds), where the person is looking: a
  status line kept at the top of the view. A click is never silent.
- A record's action sends `id` and the record's title as `record_title`
  (§6 rule 10). After a change made in the view it sends
  `ui/update-model-context` with the result's text, so the model knows in
  its next turn.

### 5.1 Embedded pages: the sign-in ticket

A `custom` page whose `url` is a path on the app's own site (an *embed
page*) is framed by hosts on other sites, where the app's own session cookie
is a third-party cookie that browsers block. The viewer is signed in to it
with a ticket instead:

1. **Declared.** An app with an embed page MUST have `embed` in its manifest:
   `tool` (`clegra_embed`), `path` (default `/embed`; every embed page is
   under it) and `frameAncestors`, the hosts that may frame embed pages, as
   CSP sources: `https://host[:port]`, `https://*.host`, `'self'`; outside
   production `http://localhost` and `http://127.0.0.1` (port or `:*`).
2. **Asked for.** The host, holding the viewer's token for the app, calls
   `clegra_embed { page, origin }`: `origin` is the origin of the document
   that will frame the page and post the ticket. The tool is listed to every
   caller with `_meta.ui.visibility: ["app"]` (hidden from models). It MUST
   refuse a page the caller can't open (the page's permission, `plain`), an
   origin that is opaque (`null`), not a serialized origin, or not matched by
   `frameAncestors`. It answers `{ page, action, field, ticket, expiresAt }`.
3. **The ticket** is a JWT (`typ: clegra-embed+jwt`, HMAC with a key only
   the app holds), `iss` the app's origin, `aud` the page's absolute URL,
   `origin`, `jti`, `iat`, `exp` at most 60 seconds after `iat`, and the
   caller as the app named it (`clegra: { installation, person,
   permissions, locale?, host }`), nothing more.
4. **Posted, never in a URL.** The framing document submits a form with
   `method="post"`, `action` = `<app origin><path>/_ticket`, `target` = the
   frame, the ticket in the field `field`. So the ticket is never in an
   address bar, the history, a server's access log or a `Referer`, and the
   browser itself states the poster's `Origin`.
5. **Exchanged once.** The app MUST refuse (a 4xx, no cookie) a request that
   is not a POST, whose `Sec-Fetch-Dest` is not `iframe`, whose `Origin` is
   not the ticket's `origin` or no longer matched by `frameAncestors`, and a
   ticket that is tampered, of another app, for a page that isn't one of its
   embed pages, expired, issued more than 5 seconds in the future, living
   longer than 60 seconds, or already used (its `jti` kept, atomically,
   until it expires: shared by every instance). Otherwise it answers `303` to
   the page (absolute, from the ticket: never from the request) with
   `Referrer-Policy: no-referrer`, `Cache-Control: no-store` and a session
   cookie: `Secure; HttpOnly; SameSite=None; Partitioned` (CHIPS: kept under
   the host's top-level site only), `Path` = the page's path, no `Domain`, a
   short `Max-Age` (default 10 minutes, at most an hour), holding the
   ticket's caller signed with another key than tickets.
6. **Read by the page.** The page's caller is the session's (scope by its
   `installation`, as a handler's `ctx`). The session counts only for its own
   page and never for a top-level navigation (`Sec-Fetch-Dest: document`).
7. **Framing.** Every response under `path` (the pages, the exchange and its
   refusals) MUST carry `Content-Security-Policy: frame-ancestors` with
   exactly the declared sources, and no `X-Frame-Options`. Every frame up to
   the top must match one, so a host whose view runs in an opaque sandbox
   frames embed pages from its own document, not from inside that view.

The SDK's view of an embed page (`ui://<app>/pages/<page>`) does steps 2 and 4
over the MCP Apps bridge, with its own `location.origin`; a host that draws
natively does them itself. A page on another site (`https://…`) is framed as
it is, with no ticket.

## 6. The generated MCP server

Streamable HTTP at `mcp.url`. Tools, in this order of derivation:

| Tool | From | Kind |
|---|---|---|
| `<entity>_list`, `<entity>_get` | each entity (filters, `query`, `sort`, `dir`, `cursor`, `limit` ≤ 100, default 25) | read |
| `search`, `fetch` | entities with a `search` field; `search` takes an optional `kind` (an enum of the searchable entities' kinds) and each result carries `kind` when its entity has one; `fetch` carries it in `metadata` | read |
| `clegra_resolve` | always: `{ uris, want? }` → each URI's state `ok \| gone \| no-access \| not_found` and data, for hosts; hidden from models. `not_found`: a URI that is not this app's (a host MUST send an app only its own URIs); `gone`: this app's record or type that doesn't exist | read |
| `<entity>_<action>` or `<action>` | each action | read or write |
| `open_<page>` | each page except `record` pages (those are `<entity>_get`) | read |
| `show_<fragment>` | each non-record fragment | read |

Rules:

1. Names match `[a-zA-Z0-9_.-]{1,64}`, are unique, and MAY be renamed by the developer; the manifest carries the actual names.
2. Names, titles and descriptions are in the app's `locale` and identical for every caller and every call. Data labels follow the caller's locale.
3. Reads carry `readOnlyHint: true`. Writes carry `readOnlyHint: false` and `destructiveHint: true` exactly when `confirm` is `always`.
4. A write is listed to plain MCP clients only when the developer opted in (`plain: true`). An entity, page or fragment MAY be hidden from them (`plain: false`).
5. A tool the caller lacks the permission for is not listed.
6. Tools with a view name it in `_meta.ui.resourceUri`; the data to draw is the result's `structuredContent`. Every tool a view calls (lists, records, actions, pages) carries `_meta.ui.visibility` with `"app"` (ChatGPT also reads `openai/widgetAccessible: true`); a host refuses a view's call to any other tool.
7. Hand-written tools, resources and views MAY be added to the same server; they are outside the manifest.
8. Entity tools (`<entity>_list`, `<entity>_get`) carry `_meta.clegra: { entity, kind? }`, `kind` as in the manifest. With a kind, their description ends with one fixed sentence: `Kind: person.`; with `{ by, map }`, the kinds in the map's order and the field: `Kind: organization or person (by type).`
9. A list filter on a field with `as` names the property in its description (`Company (worksFor): …`); a key filter says it is exact (`Email: exact email; a value or { in: [...] }`) and carries `format` where JSON Schema has one (`email`).
10. **Records are named by their title.** In the text a model reads, every record of a list, a get, `search` and `fetch` carries its `title` beside its `uri` (an outsider's title wrapped, §7). A tool of an action on a record takes `id` (required) and `record_title` (optional string, at most 300 characters): the record's title as the model read it, so a client that writes its own approval prompt from the arguments can name the record the person approves. Both descriptions tell the model to name the record by its title, never by its id. `record_title` is a display hint and never trusted: the app names the record from `id` in everything it shows or confirms, never passes the hint to the handler, and refuses the call with `invalid_input` (`fields.record_title`) when the hint names another record (compared without the untrusted wrapper, case, width, quotes and extra spaces). `record_title` is reserved: an action's `input` can't declare it.

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
   app's own tokens»). No `clegra` claim is involved.
2. **A workspace host's** (in-house apps a company installs into its own
   host): the trusted-issuer mode, with the `clegra` claim. The rest of this
   list is about these.

- A workspace host's token is a JWT with `typ: at+jwt`, `exp` and `sub`, from an issuer the
  app trusts, with one claim, `clegra: { installation, person?,
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
the trusted-issuer mode. How Clegra does it (where its client documents and
redirect URI live, which client authentication, the tokens kept per person on
the company server): [host-oauth.md](host-oauth.md), non-normative.

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
  JWT (`typ: clegra-confirm+jwt`, 5 minutes at most) signed by the token's
  issuer for the same audience and subject, with `installation`, `tool`,
  `call` (the call id) and `args`: the base64url SHA-256 of the canonical
  JSON (keys sorted at every depth) of the arguments **as sent**, before any
  parsing or default. Without a valid proof the call fails with
  `confirmation_required` and `error.confirm` describes what to show;
- a plain client that supports MCP elicitation is asked to confirm, with the
  values as a person reads them (labels, titles of referenced records);
- a plain client that can't elicit: the client's own approval applies, guided
  by the tool's annotations (`destructiveHint`); the server runs the call.

What a person confirms names the record by the title the app reads from `id`
(`error.confirm.record`, the elicitation's text), never by the model's
`record_title`, and a host MUST NOT show that hint as the app's. A client's own
approval prompt is written from the arguments: there the hint is the only
title, and a hint that names another record stops the call (§6 rule 10), so
the person can't approve one record and change another.

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

**Host metadata**: one key, `_meta.clegra`.

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
`auth.resource`, `exp`, `sub`, and the `clegra` claim with a valid
`installation` (above). The signature is checked against the issuer's key
set: `<issuer>/.well-known/jwks.json`, or the issuer's `jwksUri`. Clocks may
differ by 30 seconds. Opaque tokens are not accepted in this mode.

## 8. Conformance

[`packages/clegra/spec`](../../packages/clegra/spec) checks any app from outside,
over HTTP, whatever it is built with:

```sh
npx clegra check https://crm.example.com --token <a plain caller's bearer>
```

| Check | Passes when |
|---|---|
| `manifest.served` | `GET /.well-known/clegra.json` answers 200 with JSON |
| `manifest.schema` | the manifest validates against the JSON Schema |
| `manifest.references` | names refer to things the manifest declares; tool names are unique and valid |
| `auth.mcp` | without a token the endpoint answers 401 and points to protected-resource metadata, whose `resource` is the address the app was reached at (or the manifest's `auth.resource`) |
| `mcp.initialize` | `initialize` succeeds with no extension |
| `mcp.tools` | tools match the manifest: names, `readOnlyHint`, `destructiveHint`; nothing hidden is listed |
| `mcp.deterministic` | `tools/list` is the same on every call |
| `mcp.sort` | a list tool offers to sort only by fields the manifest declares sortable, and refuses any other key |
| `mcp.views` | every view a tool names is served as an MCP Apps document |
| `mcp.titles` | each row of a list's text carries its `uri` and `title`, and the record's text from its get tool the same title; every action tool on a record takes a required string `id` and an optional string `record_title` |
| `mcp.app-callable` | the tools a view calls (lists, records, actions, pages) don't leave `"app"` out of `_meta.ui.visibility` |
| `mcp.manifest` | the manifest is one MCP resource, identical to the file |
| `kinds.known` | every unprefixed kind is in `kinds.json` for the `specVersion`; every dotted kind is well-formed |
| `kinds.properties` | every `as` belongs to the entity's kind (or is universal) with a matching type; single-valued properties appear once; required ones exist; keys are filters; `kinds` definitions are well-formed |
| `kinds.keys` | listing with a key value taken from a returned record, in another letter case where case doesn't count, returns that record and only records holding that value |
| `kinds.values` | sampled records: `email`, `vatID`, `gtin`, dates, `address` and numbers have the stated form |
| `kinds.tools` | entity tools carry the kind in the description and in `_meta.clegra`; `search` offers `kind`, keeps to it, and names each result's kind |
| `refs.cross` | a `ref: { kind }` field's values are record URIs; its text form is `{ uri, kind }`; no `refs` title is sent for it; such an action input is a string |
| `resolve.foreign` | the resolver answers `not_found` for another app's URI |
| `embed.frame-ancestors` | (public) an app with same-site pages declares `embed`; each embed page and `GET <path>/_ticket` (refused) answer with `frame-ancestors` exactly the declared sources, no `X-Frame-Options` |
| `embed.ticket` | a ticket for a declared origin is a ≤ 60 s JWT for the page with a `jti`; an undeclared origin gets none; posted from another `Origin`, a second time, or by a top-level page it is refused; posted right it answers 303 to the page with `Referrer-Policy: no-referrer` and a `Secure; HttpOnly; SameSite=None; Partitioned` cookie scoped to the page's path |

The `kinds.*` checks are skipped, not failed, for an app that declares no
kinds (and `kinds.keys` when no listed record holds a key value to try);
`refs.cross` for an app without references to other apps; the `embed.*`
checks for an app without same-site pages.

An app is conformant when every check passes with a token. Without a token
only the public checks run: the report says «Incomplete», never «Conformant».

## 9. Workspace hosts: across apps

What a workspace host does when it draws several apps together. None of it
needs anything from an app beyond §2–§7.

1. **Names.** An app is the connection an administrator installed (its
   address, public or local); there is no global app id. A host MUST NOT hold
   two apps with the same `name` in one workspace: when an app's `name` is
   taken, the administrator gives it another name there at install time, and
   the host uses that name in the workspace's record URIs and translates them
   to and from the app's own `name` in every call. Record URIs are therefore
   scoped to the workspace and resolved by its host. The name is kept for the
   installation's life (other apps store URIs that carry it). When another app
   of the workspace is named as a renamed app's own `name`, the host MUST NOT
   send the renamed app a URI of that other app (it would read as its own):
   it refuses the call instead. (A public directory of
   apps may give them globally unique, publisher-verified names; that is a
   listing, outside this specification.)
2. **Caller.** Every call a host makes to list, search, match or resolve
   across apps MUST be made for the viewer, with the viewer's token for that
   app. A host MUST NOT show a person data obtained with another caller's
   token, and MUST NOT keep a copy of records beyond the response it is drawing.
3. **Resolving.** For a cross-app reference the host calls the owning app's
   resolver and shows the title, or one of `no-access`, `not-linked` (the app
   signs people in itself and the viewer has not linked their account: the
   host offers to link it), `gone`, `unreachable` (a timeout or an error),
   `unknown-app` (no app of that name in the workspace), each distinguishable
   to the person. It MUST NOT show a title
   from an earlier response in place of a failed one.
4. **Fan-out.** A federated list calls every source in parallel with a time
   limit per source. The result MUST name every source with its state (`ok`,
   `timeout`, `error`, `no-access`, `not-linked`) and MUST be marked partial
   unless all are `ok`. A total is shown only when every source gave one. A
   host MUST NOT substitute other data for a failed source.
5. **Order.** A merged order across sources is allowed only by a property
   every included source declares sortable; otherwise results are grouped by
   source in each source's own order.
6. **Matching.** Two records are *matched* only when they have the same kind
   and an equal normalised key (§3.1 rule 5), found by the key's exact filter.
   A host MUST NOT match on names or any non-key value, MUST NOT store matches,
   MUST NOT present matched records as one record, and MUST show each one's
   source.
7. **Links.** A host MAY store a person's statement that two records are, or
   are not, the same thing: the two URIs, who, when — no field values. A link
   belongs to the workspace (anyone may benefit from it) and is shown only to a
   viewer for whom both URIs resolve `ok`.
8. **Models.** What a host gives a model from these calls keeps `untrusted`
   marks (§7) and names the source of every record.
