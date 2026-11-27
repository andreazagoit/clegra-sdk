# Clegra apps — specification

> Version 1.0, draft (2026-11-16). Normative; MUST, SHOULD and MAY as in RFC 2119.
> Clegra apps are Clegra's own developer platform: apps that Clegra draws natively
> in its workspace and that are, at the same time, plain MCP servers that ChatGPT,
> Claude and any MCP client use as they are. The package `@clegra/sdk` builds them; this
> page is the contract they meet. The wire name is `clegra` (manifest path, URI
> scheme, `_meta` key, token claim, OAuth scope, resolve tool).
> Anything not on this page is not part of 1.0.

## 1. What it is

An **app** is described once, as one definition: entities, actions, pages,
artifacts, agents, permissions, settings, and optionally its navigation,
schedules, notification types and lifecycle. The definition has two halves:

- the **manifest**: pure JSON, no code. The *workspace host* (Clegra: the
  node of the company or person that installed the app; «host» below) reads it
  with one fetch and draws the app natively: pages in its navigation, records
  as cards, actions behind a confirmation, agents.
- the **handlers** (`get`, `list`, `run`, `data`), reached through a **plain
  MCP server** generated from the same definition: tools with correct
  annotations and MCP Apps `ui://` views. ChatGPT, Claude and any MCP client
  use it as they use any MCP server.

**No MCP extension is required or announced.** An MCP client never needs the
manifest; the workspace host needs nothing beyond the manifest and MCP. Every
feature on this page degrades to plain MCP: what ChatGPT, Claude and other
clients see of each one is in §6.1. The same operations are also an OpenAPI 3.1
document, callable over plain HTTP (§7, «The index as OpenAPI»).

**Authoring with the SDK** (non-normative for other implementations). The
definition is written one thing per file and served apart from it:

- `defineEntity`, `defineAction`, `defineArtifact`, `defineComponent`,
  `definePage` and `defineAgent` each take one thing (with its `name`) and
  return a **handle**. One thing names another by its imported handle, never by
  a string: an action `on: deal`, a page `list: deal`, `actions: [markWon]`,
  `badge: openDeals`, a dashboard item `{ artifact: pipelineTotal }`, an
  artifact `component: stageFunnel`, an agent `uses: [deal, markWon]`.
  References between records stay by entity name (`ref("company")`, §3).
- `defineApp({ name, title, version, permissions, settings, kinds,
  notifications, entities: [...], actions: [...], components: [...],
  artifacts: [...], pages: [...], nav, agents: [...], schedules: [...],
  lifecycle })` assembles the handles (conventionally `clegra/app.ts`). It is
  pure: it checks everything at once (a handle that is not one of its own, a
  wrong permission, a column that is not a field fails here), its manifest is
  computable (`app.manifest()`: MCP at `/mcp`, no authorization server, no
  site), and nothing is served.
- `serve(app, { auth, store, people, site, clientOrigins, path, mcp })` is the
  runtime: who may call (§7), where write results, one-time ids and later runs
  are kept, the names of people, the app's own site (§5.1) and the clients that
  frame it, the path of its routes, and the raw-MCP escape hatch. It returns
  the served app, one `fetch(request)` for every route (MCP, the manifest, the
  OpenAPI index and its operations, the sign-in module, views, the site's
  bridge); `served.manifest()` is the one hosts read.
- The core runs on Web APIs only (Fetch, Web Crypto): Node, Deno, Bun, edge
  runtimes. Thin adapters mount it: `@clegra/sdk/node` (`listen(served)`,
  `toNodeHandler(served)`), `@clegra/sdk/express` (`clegraMiddleware(served)`),
  `@clegra/sdk/next` (`toNextHandlers(served)`, `withClegra`). What the core
  needs of its runtime beyond Web APIs, the DNS resolver that checks a
  client's host before its metadata document is fetched (§7), an adapter gives
  it (`useHostLookup`); without one a host name is refused, never fetched
  unchecked.

## 2. The manifest

Served at `GET /.well-known/clegra.json` (no authentication) and as one
MCP resource, `clegra://<name>` (`application/json`); the two MUST be identical.
JSON Schema: [`spec/schema/clegra.schema.json`](../spec/schema/clegra.schema.json).

| Key | Content |
|---|---|
| `specVersion` | `"1.0"` |
| `name`, `title`, `version`, `description?`, `icons?`, `locale` | Identity. `name` is the app id: `[a-z][a-z0-9-]{1,39}` |
| `accent?` | The app's tint, like an Apple app's: one name of a closed palette, `blue`, `indigo`, `purple`, `pink`, `red`, `orange`, `yellow`, `green`, `teal`, `gray` (`APP_ACCENTS`), never a free colour; absent means `blue`. A host draws the app's own controls in it (primary buttons, selected rows and filters, links, switches, progress, the focus ring) and keeps its own chrome and the status colours. The colours of each name, light and dark, are the host's (Clegra's: `@clegra/ui/accents`, every pair WCAG AA) |
| `publisher?` | `{ name, url }`: who publishes the app. `name` is the publisher's own name (1–100 characters, no spaces around it, no control characters), `url` its web address, an absolute `https` URL without credentials (at most 300 characters). A claim: it grants nothing. A store or host may verify it against the domain of `url` and show the app's publisher as verified; an unverified publisher is never shown as verified |
| `mcp` | `{ url }`: the MCP endpoint (Streamable HTTP), relative to the manifest (`/mcp`, or under the app's path, `/api/clegra/mcp`). The manifest and the OAuth metadata are always under `/.well-known/` at the root |
| `auth` | `{ resource?, authorizationServers }` (§7). `resource` is the app's own public MCP address: the only token audience it accepts |
| `view` | The generated `ui://` view that draws lists, records, dashboards, artifacts |
| `resolveTool`, `searchTool?` | Tools a host uses to resolve URIs and to search |
| `site?` | `{ start, tool }`: the app's own website, shown as it is in Clegra's clients (§5.1) |
| `components?` | The app's own A2UI components, by name (§5.4): `{ <Name>: { title, description?, view, props, actions? } }` |
| `kinds?` | Definitions of the namespaced kinds this app uses (§3.1) |
| `entities`, `actions`, `pages`, `artifacts`, `agents` | §3–§5 |
| `widgets?` | `[{ artifact, sizes, size }]`: the artifact types the app offers as Home widgets (§5.5) |
| `permissions` | `{ id, label, description?, default }`; ids are `group.verb` |
| `settings` | `{ id, label, description?, type: text\|number\|boolean, required, default? }` (`id`: `[a-z][a-z0-9_]{1,39}`): values an administrator sets per installation; the workspace host sends them with every call (§7). Never secrets: those stay in the app's own configuration |
| `nav?` | `[{ section?, pages }]`: the app's navigation (§5.2) |
| `schedules?` | `[{ name, action?, tool, every, maxSeconds }]`: actions the workspace host runs as the installation (§11) |
| `notifications?` | `[{ type, label, description?, default, permission? }]`: the notification types the app sends (§12) |
| `lifecycle?` | `{ installation?, export?, delete? }`: the reserved lifecycle tools the app implements (§13) |

**Labels** are always maps per locale (`{ "en": "Deal", "it": "Trattativa" }`);
a host picks the person's locale, then `locale`, then the first entry.
Identifiers are never translated. **Tool refs** are `{ name, plain }`: the MCP
tool, and whether it is listed to plain MCP clients.
**Agents** are `{ name, title, description, instructions, tools, tier:
fast|standard|strong, starters? }`: the host's model runs them with those tools.
**Reserved names**: the tools `clegra_later`, `clegra_installation`,
`clegra_export` and `clegra_delete` are the installation's (§10); no entity, action, page or artifact tool takes them. The schedule and notification type
`clegra_later` are the SDK's (§4.2). Identifiers of schedules and notification
types match `[a-z][a-z0-9_]{0,39}`.

The rules a manifest meets beyond its JSON Schema (the publisher above, §4.1,
§4.2, §5.2, §6 rule 11, §11, §12) are one piece of code, `spec/src/rules.ts`: the
SDK runs it when the app is defined (a wrong name fails at start, naming its
place: `page "x": …`) and the conformance check `manifest.references` (§8)
runs it from outside.

## 3. Entities and field meaning

An entity is `{ name, label, plural, description?, icon?, kind?, permission?,
schema, fields, tools: { list, get }, searchable, visibility?, record? }` (`visibility`:
§6 rule 11; `record`: its record template, §5.4 rule 4). `kind` says what the
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
as [`spec/kinds.json`](../spec/kinds.json).
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
permission?, tool, visibility?, targets?, later? }`. With `entity` the action
works on one record and its tool takes `id` plus `input`; without, it is
global. `visibility`: §6 rule 11; `targets`: §4.1; `later`: §4.2. `confirm` is `always`
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

### 4.1 Targets: actions offered on other things

A global action MAY say where a workspace host offers it outside the app: on
an email, or on a record of a kind held by another app (Clegra's «Azioni»).
`targets` is a list of `{ target, needs, input?, label? }`:

1. `target` is `mail.message` or `record:<kind>`, `<kind>` a published kind
   (`kinds.json`) or a namespaced one (§3.1). At most 4 targets per action and
   12 per app. An action with `entity` has no targets (it has its record).
2. `needs` names the target's fields the action may receive, and the host
   sends it only these, ever: for `mail.message` a subset of `subject`, `from`,
   `to`, `date`, `text`, `attachments`; for `record:<kind>` properties of that
   kind (`kinds.json`, or the manifest's `kinds`; for another app's namespaced
   kind, well-formed property names). Always available without being needed:
   `uri` (the email's or the record's `clegra://` URI) and, for a record,
   `title`. A name appears once.
3. `input` is a template of the action's input. Each key MUST be a property
   of the action's `input`. String values MAY hold placeholders `{field}` or
   `{field.sub}` (`{from.address}`), each naming `uri`, `title` (records) or a
   needed field. A value that is exactly one placeholder keeps the field's
   type; otherwise the text around it is kept and the placeholders are
   replaced by the values' text. A missing value is empty.
4. `label` is the item's words (default the action's title), at most 40
   characters per locale.

The host reads a record's needed properties for the viewer, with the viewer's
token, from the app that owns the record (the fields whose `as` is the
property, §3.1). Picking the item opens the action's form filled from the
template; a write then goes through the confirmation (§7) like any other.
Everything from an email or another app's record is outsiders' text
(`untrusted`) to the action's app. A plain MCP client sees none of this: the
action is its tool, as without targets.

### 4.2 Approve now, act later

An action MAY carry `later: { at, window }`: the person confirms the call now
and it runs at the time `at` names, as its author, without being asked again.

1. **Declared.** Only on a write whose `confirm` is `always`. `at` names a
   *required* input property that is a string with `format: date-time`.
   `window` is whole minutes, 10–10080 (7 days); the manifest always carries
   it (the SDK's default is 60). An app with such an action has the schedule
   and the notification type `clegra_later` (below), and a store that keeps
   later runs.
2. **Confirmed.** The call is confirmed as any `always` write (§7). The
   app refuses with `invalid_input` (on `at`) a time more than 5 minutes past
   or more than 366 days ahead, before anyone is asked. A workspace host's
   proof then also carries `until`: epoch seconds, `floor(Date.parse(at) /
   1000) + window × 60` computed from the arguments as sent; the app computes
   the same and refuses another value (`confirmation_required`, «the proof is
   for another deadline»). Its `confirmation_required` carries
   `error.confirm.later: { at, until }`, so the host can say when the call
   will run and by when.
3. **Stored, not run.** Instead of calling the handler the app keeps a
   *later run*: its id (a UUID), the tenant, the tool, the arguments as
   received and their hash, `at`, `until`, the author (`{ id, name }`, the
   confirming person), the permissions the action needs that the author held,
   the proof (with its issuer, subject, installation and call id), and when it
   was confirmed (the proof's `iat`). It answers `{ ok: true, message:
   "Scheduled for <at>.", data: { later: { id, at, until } } }`; a repeated
   call id answers the same (idempotency, §7).
4. **Run once.** The tool `clegra_later` (input `{}`, only for the
   installation-level caller, §10) takes the caller's tenant's runs that are
   due (`at` ≤ now) and *claims* each atomically: a claimed run is never given
   to anyone again, whatever happens next. For each it checks that the
   arguments' hash and `at` are still the confirmed ones, that the stored
   proof verifies against the issuer's keys *as of its confirmation time*,
   covers these arguments, this call and this `until`, and has that `iat`, and
   that the author may still use the action with the stored permissions
   (otherwise `refused`). After `until` the run is `expired`. Otherwise the
   handler runs with the stored input re-parsed (a record action reads its
   record again), `ctx.person` = the author, `ctx.permissions` = the stored
   ones, `ctx.later = { id, at, until, confirmedAt }`, `ctx.schedule =
   "clegra_later"` and the settings the host sent with this call. The
   outcome is kept: `done`, `failed`, `expired` or `refused`, with a message.
   The result is `{ runs: [{ id, tool, at, status, message }] }`, and its
   notifications (the handlers', the author by default) go out as any result's
   (§12). An `expired` or `refused` run tells its author with the type
   `clegra_later` (title: the action's title and «did not run»).
5. **Cancelled.** A handler of the same tenant MAY cancel a pending run by
   its id (`ctx.cancelLater(id)`: false when there is none, or it already ran
   or started).
6. **Scheduled.** The SDK adds the schedule `{ name: "clegra_later", tool:
   "clegra_later", every: 5 }` (no `action`) and the notification type
   `clegra_later` («Scheduled actions that did not run», `default: true`),
   exactly when an action has `later`; no app declares them itself.
7. **Plain clients.** A client that is not a workspace host can't produce a
   proof. There a later action is an `always` write (elicitation where the
   client supports it, else the client's own approval, guided by
   `destructiveHint`, §7), and its run is stored with the caller as author and
   no proof (`proof: null`): the caller's token was verified when the call was
   confirmed. A run made with the app's own tokens belongs to the app's own
   tenant, which no workspace host runs: the app runs its tenants' due runs
   from its own cron (the SDK's `app.runLater(tenant)`; the notifications it
   returns are the app's to deliver).

## 5. Pages and artifacts

A **page** is `{ name, kind, title, icon?, permission?, params, tool,
actions?, badge?, … }` (`actions`, `badge`: §5.2):

| `kind` | Extra keys | Drawn |
|---|---|---|
| `list` | `entity`, `columns` | Natively, from the list tool's rows |
| `record` | `entity`, `sections?` | Natively. Every entity has one (`derived: true` unless declared) |
| `dashboard` | `view` | Artifacts on a grid |
| `custom` | `view` | The developer's MCP Apps document |

An **artifact** is a small live piece of the app shown in answers and on
dashboards: `{ type, title, description?, params, template?, component?, view?, tool,
permission?, actions?, size?, untrusted?, visibility?, create? }` (`visibility`: §6
rule 11; `create`: below). Templates are `record` (one per
entity, `params { id }`), `card`, `stat`, `list`, `chart`; `component` names
one of the app's own components (§5.4); an artifact with neither has only a `view`. An artifact instance's URI is
`clegra://<app>/<type>/<base64url of its params, keys sorted>`.
`untrusted: true` says the artifact's texts are outsiders' (records' names):
they are marked like an untrusted field (§7).

Template data, which a workspace host draws natively, as the A2UI surface the
SDK writes from them (§5.4):

| Template | Data |
|---|---|
| `card` | `{ title, subtitle?, status?, fields: [{ label, value }], uri? }` |
| `stat` | `{ label, value, format?: number\|money\|percent, currency?, hint? }` |
| `list` | `{ items: [{ title, subtitle?, status?, uri? }] }` |
| `chart` | `{ kind: bar\|line\|pie, points: [{ label, value }], format?: number\|money, currency? }` |

A `uri` is a record of the app: the item opens it. An item (or a card) whose
`uri` is a record the caller can't reach is not sent.

**Creatable types.** `create: { action, title }` (the SDK: `creates` on the
action, `creates: thing` or `creates: { of: thing, title }`) makes an artifact type one
people create in a workspace host, as a new file in a folder: Clegra lists it in
«+ Nuovo» of a space and in a document's «/» block menu. `action` names a global
write (§4) that makes a new, empty one from nothing: no required input (its
defaults fill it), never `confirm: "always"`, never `later`; it answers with the
new artifact instance's URI as `record` (a record type: the new record's URI,
`ctx.uri(entity, id)`). `title` is the menu's words (default the type's title).
Only record, template and component types are creatable. A host lists the type
only for who may run the action and see the type, calls the action with `{}` as
the person, and keeps or embeds the URI it answers; what was made is then edited
as the app allows (its surface's actions, §5.4 rule 8, or the app's own pages).

**Views** are MCP Apps documents (`ui://<app>/…`, `text/html;profile=mcp-app`).
Any generated view MAY be overridden per entity, page or artifact; the
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

### 5.1 The app's own site

An app with a website of its own (its screens, its sidebar, its forms) is shown
**as that site** in a workspace client (Clegra's web and desktop clients): the
client frames the app's real pages at the app's own origin and draws nothing
around them. The generated views (§5, §5.3) stay for an app without a site and
for every other host (ChatGPT, Claude: MCP Apps).

1. **Declared.** The manifest's `site` is `{ start }`, the path the app opens at
   (default `/`; a path on the app's own origin, never under `/clegra/`). The
   app lists the clients that may frame it (`serve(app, { site, clientOrigins
   })`: exact origins,
   the desktop app's own scheme included, e.g. `app://client`).
2. **Framed by those clients only.** Every page of the site answers
   `Content-Security-Policy: frame-ancestors 'self' <client origins>`
   (`siteProxy` in `@clegra/sdk/next`, `siteFraming()` for any server), never
   `X-Frame-Options`.
3. **Signed in by the app, in the frame.** The client never signs anyone in to
   the app and sends no identity: the frame shows the app's own sign-in when the
   person has no session there. Its session cookie must work in a cross-site
   frame: `Secure; HttpOnly; SameSite=None; Partitioned` (CHIPS: kept under the
   client's top-level site only; `frameCookie` of `@clegra/sdk/signin`). Signing
   out in the frame ends the app's session, nothing else.
4. **Linked in the same frame.** When the person has not linked the app to the
   client's assistant yet, the client opens the app's authorization endpoint in
   the frame with `response_mode=web_message` (§7, «Your sign-in»): the app's
   own sign-in, then its consent, then the answer posted to the client, which
   finishes the link on its server (PKCE, `iss`, the code at the token
   endpoint, as after a redirect).
5. **The bridge.** A page loads `/clegra/site/bridge.js` (`<ClegraSite />`):
   inside a frame of one of the client origins it posts `{ type:
   "clegra/location", path, title }` on every navigation and applies `{ type:
   "clegra/context", theme, locale }` from the client (the page hears a
   `clegra:context` event). Outside such a frame it does nothing.


### 5.2 Navigation, page actions and badges

1. **Navigation.** `nav` is a list of sections `{ section?, pages }`, in
   order: `section` a label (absent: ungrouped), `pages` one or more page
   names. Every page named exists, is not a `record` page, and appears at most
   once over all sections. Without `nav` a host shows every non-record page,
   ungrouped, in declaration order. With `nav`, a page not named is not in the
   navigation, and is still reachable (links, page actions, record pages).
2. **Page actions.** A page's `actions` names up to 8 *global* actions (no
   `entity`), in order; the first is the page's **primary**. A `record` page
   has none (its record's actions are there). The page's params prefill the
   action's inputs of the same name. A host draws the primary prominently and
   the others in a menu; each opens the action's form drawn from its `input`
   (§4), prefilled, and a read's form shows its result. A write goes through
   the confirmation (§7).
3. **Badge.** A page's `badge` names an artifact type with `template: "stat"`
   whose params have no required key (not on a `record` page). The page's
   count in the navigation is the artifact's `data.value` (a number), called
   as the viewer with params `{}`. A badge the viewer can't show is not drawn.
4. **In the view.** A page's result carries what the generated view needs to
   draw the same thing in any MCP Apps host: `structuredContent.view.actions`
   (`[{ tool, title, confirm, input, prefill? }]`, only the actions this caller
   may use) and `view.nav` (`[{ section?, pages: [{ name, title, tool, badge? }]
   }]`, `badge` the stat artifact's tool, only the pages this caller may open).

**Host guidance** (non-normative; nothing in the manifest): Clegra derives a
list page's filters from the fields' meaning: an `enum` field with `filter` is
a choice, the first date field with `filter` (`format: date` or `date-time`)
a period sent as `{ gte, lte }` (a date-time as the bounds of the days in the
workspace's time zone). A list page whose entity has a record page is drawn
with the record beside the list.

### 5.3 Views at the app's own origin: the view ticket

A Clegra client shows an app's MCP Apps views (§5) in a frame loaded from the
app's own origin, never as a document it writes on an origin of its own or
shared with other apps. With `clientOrigins`:

1. **Asked for.** The client, holding a token the app issued to it for the
   person (never the public caller), calls
   `clegra_view { view, origin }`: `view` one of the app's view URIs
   (`ui://<app>/…`), `origin` the origin of the document that will frame the
   view and post the ticket. The tool is app-only (`_meta.ui.visibility:
   ["app"]`) and listed only to a signed-in person. It refuses a view the app doesn't have and an origin
   that is not exactly one of the app's client origins (`clientOrigins`; the
   desktop app's `app://client` included). It
   answers `{ view, action, field, ticket, expiresAt }`: `action` is
   `<app origin><path>/clegra/views/<the URI's path>`
   (`ui://crm/pages/board` → `/clegra/views/pages/board`), `field` is
   `ticket`.
2. **The ticket** is opaque (32 random bytes, base64url), kept in the app's
   store (shared by every instance) for at most 60 seconds with the view, the
   origin, the tenant and the person, and is used once.
3. **Posted, never in a URL.** The framing document submits a form with
   `method="post"`, `action`, `target` = the frame, the ticket in `field`.
4. **Opened once.** The app MUST refuse (a 4xx, framable by no one:
   `frame-ancestors 'none'`) a request that is not a POST (`405`), whose
   `Sec-Fetch-Dest` is not `iframe`, whose `Origin` is not a client origin or
   not the ticket's, and a ticket that is unknown, expired, for another view,
   already used, or issued to a person removed (or a tenant closed) since.
   Otherwise it answers `200` with the view's document and:
   - `Content-Security-Policy`: `default-src 'none'`, inline scripts and
     styles plus the declared `resourceDomains`, `connect-src`,
     `frame-src` and `base-uri` exactly the declared domains (`'none'`
     without), `form-action 'none'`, `object-src 'none'`, and
     `frame-ancestors` exactly the ticket's origin; no `X-Frame-Options`;
   - `Referrer-Policy: same-origin` (the view's own requests to the app keep
     their `Origin`; other origins get no referrer),
     `Cache-Control: no-store`,
     `X-Content-Type-Options: nosniff`;
   - `<meta name="clegra-host" content="<the ticket's origin>">` first in the
     document's head.
5. **The bridge.** A view served this way speaks MCP Apps with
   `window.parent` only: it posts every message with `targetOrigin` the
   `clegra-host` origin and takes a message only when its `source` is
   `window.parent` and its `origin` is that origin. The SDK's views do this;
   a hand-written view SHOULD read the same meta tag. In other hosts (no meta
   tag) the SDK's views behave as before (`"*"`). The client takes a message
   only when its `source` is that frame's window and its `origin` is the
   origin of that app's registered address, and posts to the frame with that
   exact `targetOrigin`; another app's origin is refused. The host context
   (theme, locale, the app's accent in `_meta["clegra/ui"]`) travels in
   `ui/initialize` and `ui/notifications/host-context-changed`.
6. **The frame.** The client frames it with `sandbox="allow-scripts
   allow-forms allow-same-origin"` (the app's own origin, never the
   client's: a client refuses a view whose origin is its own), no
   `allow-top-navigation`, no `allow-popups-to-escape-sandbox`, and its own
   `frame-src` lists exactly the company's app origins.

### 5.4 Artifacts as A2UI surfaces

Every artifact with a template or a component reaches hosts as an **A2UI 1.0
surface** ([A2UI](https://a2ui.org), specification v1.0, stable since
2026-11-11: `specification/v1_0` of `a2ui-project/a2ui`). The app keeps declaring
templates (§5) and its own components (rule 6); the SDK writes the surface from
the data, and the data stay the app's: they travel only in the surface's data
model, read for the caller like any artifact. A host renders the surface
natively, with its own design system in the app's accent (§2); the app's own
components are pages of the app, framed (rule 7). The same surface is drawn in
an assistant's answer, on a home or a dashboard, in a record, and in any other
A2UI host. An app's own site (§5.1) is not a surface: it stays a frame.

1. **Version.** Messages are A2UI 1.0 exactly: `"version": "1.0"` on every
   message, component ids UAX #31 identifiers (`item_title`, never
   `item-title`), bindings `{ "@path": "/…" }` (relative inside a list
   template), function calls `{ "@call", "args", "catalogId"? }`, no `theme`
   (A2UI 1.0 removed it: the look is the host's). A host refuses a surface of
   another version, one that is not valid against the A2UI 1.0 schemas and
   the catalogs below, or one over the host's size limit; it never guesses.
2. **Where.** The resolved artifact (`show_<type>`'s `structuredContent`,
   `clegra_resolve` with `want: "artifact"`, a dashboard's artifacts) carries
   `a2ui`: an array of exactly one `createSurface` message with `surfaceId` the
   artifact instance's URI, `catalogId` the Basic Catalog's, `components` (one
   with `id: "root"`) and `dataModel` the template's data as the app returned
   them (a component artifact: its props). `show_<type>` also returns the same
   array as an MCP embedded resource, `{ type: "resource", resource: { uri:
   "a2ui://<app>/surfaces/<type>", mimeType: "application/a2ui+json", text } }`,
   beside its text (A2UI over MCP), so any A2UI host can render it. Surface ids
   are the host's to keep unique (A2UI's rule for orchestrators): it MAY
   prefix them per place it draws. A host MUST NOT send `updateComponents` it
   did not get from the app; a newer read of the artifact is a new surface.
3. **Catalogs.** Three, all A2UI 1.0 (`protocolVersion: "1.0"`):

   | `catalogId` | What |
   |---|---|
   | `https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json` | The Basic Catalog: `Card`, `Column`, `Row`, `List`, `Text`, `Button`, `Divider`; functions `formatNumber`, `formatCurrency`, `formatString`. The surface's default |
   | `https://clegra.com/a2ui/v1_0/catalog.json` | Clegra's (exported as `CLEGRA_A2UI_CATALOG`): the components `Chart` `{ kind, points, format?, currency? }` (each a binding) and `Spreadsheet` (rule 9), the functions `formatPercent { value }` (a share, 0.125 → «12,5 %» in the reader's locale) and `openRecord { uri }` (`rendererOnly`, `requiresUserActivation`: the host opens the record a `clegra://` URI names where records open in that host; an empty URI does nothing) |
   | `a2ui://<app>/catalog.json` | The app's own components (rule 6), served by the app as an MCP resource at that URI (`application/json`) |

   A component or function of the two others names its catalog (`@catalogId`
   on a component, `catalogId` on a call).
4. **Templates as components.** The SDK writes these trees (ids fixed, so
   hosts and tests can rely on them). Texts are bound to the data model, never
   pasted into a format string, so no text of a record is ever read as
   Markdown. The style hints are a component-scope extension,
   `"@metadata": { "extensions": { "com_clegra_style": <hint> } }`, with
   `title` (the card's heading), `value` (a figure, large), `status` (a word
   of state, as a badge) and `muted` (secondary text); a host that doesn't know
   it draws plain text (A2UI: unknown extension keys are ignored). A part whose
   data are absent (no `subtitle`, no `status`, no `hint`) is left out of the
   tree; inside a list, an empty text is not drawn.

   | Template | Tree |
   |---|---|
   | `card` | `root` Card → `body` Column [`head` Row (spaceBetween) [`title`, `status`?], `subtitle`?, `fields` List (template `/fields` → `field` Row (spaceBetween) [`field_label` Text caption `label`, `field_value` Text `value`]), `actions`?]. `title` is Text `/title` (style `title`), or with `/uri` a borderless Button around it (`title_text`) whose action calls `openRecord { uri: /uri }` |
   | `stat` | `root` Card → `body` Column [`heading` Text (the artifact's title, style `title`), `value`, `label` Text caption `/label`, `hint`? Text caption `/hint`, `actions`?]. `value` is Text (style `value`): `formatCurrency { value: /value, currency: /currency or "EUR" }` for money, `formatPercent { value: /value }` for percent, `formatNumber { value: /value }` for a number, `/value` itself for a text |
   | `list` | `root` Card → `body` Column [`heading`, `items` List (template `/items` → `item` Row (spaceBetween) [`item_main` Column [`item_title`, `item_subtitle` Text caption `subtitle`], `item_status` Text `status` (style `status`)]), `actions`?]. With any item's `uri`, `item_title` is a borderless Button around `item_title_text` calling `openRecord { uri }` |
   | `chart` | `root` Card → `body` Column [`heading`, `chart` Chart (Clegra) `kind: /kind, points: /points, format: /format, currency: /currency`, `actions`?] |
   | a component | `root` Card → `body` Column [`heading`, `component` (the app's component, `@catalogId` the app's catalog, each prop bound to `/<prop>`), `actions`?] |

   | `record` | `root` Card → `body` Column [`head` Row (spaceBetween) [`title` borderless Button (child `title_text` Text `/title`, style `title`) calling `openRecord { uri: /uri }`, `status`? Text `/status` (style `status`)], `subtitle`? Text caption `/subtitle`, `fields` List (template `/fields` → `field` Row (spaceBetween) [`field_label` Text caption `label`, `field_value` Text `value`]), `actions`?] |

   **The record template.** Every record (`record` artifacts: an entity's
   record, `params { id }`) is one surface, written by the SDK from the
   entity's `record: { fields, actions? }` (the SDK: the entity's `record: {
   fields }` and its record actions marked `featured: true`, in the app's
   order of actions), declared once: 1–6 key fields of
   the entity (not `id`) and 0–3 of its record actions, in order (the first is
   the primary). Without it the key fields are the first four a list would
   show (fields with a role or a filter, not the title, subtitle or status) and
   there are no actions. Its data model is `{ title, subtitle?, status?, tone?,
   uri, fields: [{ name, label, value }] }`: the title, subtitle and status
   from the fields' roles (§3), `tone` the status value's tone, and each key
   field the caller may see as its label and its value **as a text in the
   caller's language** (a referenced record by its title, money in its
   currency, dates, numbers, enum labels, `✓`/`—`); a field with no value is
   left out. A host draws it in an answer, a document, on Home and anywhere
   else a record is shown, in place of its own drawing of the record.
5. **Actions.** An artifact's `actions` (§5, global actions the caller may
   use) are `actions` Row [`action_<n>` Button (the first `primary`) with child
   `action_<n>_label` Text (the action's title in the caller's language)],
   each with `action: { event: { name: <the action's tool>, context: {} } }`
   (a record's actions, rule 4: `context: { id: <the record's id> }`).
   The host never runs the tool from the event: it opens the action's form
   (§4, §5.2 rule 2), and a write goes through the confirmation (§7) as from
   any other place. An `action` message whose name is not one of the
   artifact's actions is dropped.
6. **The app's own components.** The manifest's `components` maps a name to
   `{ title, description?, view, props, actions? }`:
   - the name is an A2UI component name of the app: `[A-Z][A-Za-z0-9]{0,39}`
     (UAX #31), not one of the Basic Catalog's or Clegra's, unique in the app;
   - `view` is the component's page, an MCP Apps document of the app at
     `ui://<app>/components/<Name>` (§5), served like every view (§5.3);
   - `props` is the JSON Schema (an object) of the data it draws; an artifact
     with `component` returns data valid against it (the SDK checks, and an
     invalid answer is the artifact's error, never a half-drawn component);
   - `actions` names the app's tools the page may call (A2UI's
     `allowedTools`), each a declared action or a read the caller may use.

   The app's catalog (`a2ui://<app>/catalog.json`, rule 3) declares each one
   as an A2UI 1.0 catalog component: `component` its name as `const`, one
   property per prop (`common_types.json#/$defs/DynamicValue`), and
   `metadata.extensions.com_clegra_component: { view, props, actions }`. An
   A2UI host that doesn't know this extension MAY draw the component as the
   A2UI MCP catalog's `McpApp` with `htmlContent` the view's document
   (`resources/read`) and `allowedTools` its `actions`; one that can do neither
   draws the rest of the surface and reports the component as an error, never
   silently.
7. **Drawing a component (a workspace host).** The host frames the view at the
   app's own origin with a view ticket (§5.3: its CSP, `sandbox="allow-scripts
   allow-forms allow-same-origin"`, the app's origin never the host's), and
   speaks MCP Apps (`2026-01-26`) with it, as A2UI's `McpApp` does:
   - **Lazily.** A frame is opened (its ticket asked) only when its block
     comes near the viewport; until then, and until `ui/notifications/initialized`,
     the block keeps a placeholder of the component's last or minimum height.
     A host MAY draw several components of one app on one surface in one frame
     when they are adjacent; otherwise one frame per component.
   - **Context.** `ui/initialize` answers the host context: `theme`,
     `locale`, `timeZone`, the standard `styles.variables` and the app's accent
     in `_meta["clegra/ui"]` (§5.3 rule 5); `ui/notifications/host-context-changed`
     on every change.
   - **Data.** After `ui/notifications/initialized` the host sends
     `ui/notifications/tool-input` `{ arguments: <the artifact's params> }` and
     `ui/notifications/tool-result` `{ content: [], structuredContent: <the
     component's props, every binding resolved> }`, and again a tool-result
     whenever the surface's data model changes. The page draws from these and
     reads nothing else for the person.
   - **Size.** The page reports `ui/notifications/size-changed`; the block
     takes its width and that height, clamped to 100–2000 px, changes under
     5 px ignored, at most one redraw per 100 ms (A2UI `McpApp`).
   - **Actions.** A `tools/call` whose tool is not in the component's
     `actions` is a JSON-RPC error. Otherwise the host calls it as the person
     (a read at once; a write waits for the person's confirmation, §7) and
     answers the MCP result. `ui/open-link`: an `https` address, opened outside
     the host. `ui/message`, `ui/update-model-context`: accepted, kept nowhere.
     Any message over 64 KB, nested deeper than 10, or with a
     `__proto__`, `constructor` or `prototype` key is dropped (A2UI `McpApp`).
8. **Editing.** Surfaces are editable, and every edit is the app's: an
   input or an edited cell changes only the surface's local data model (A2UI
   two-way binding) until the person commits it; the commit is an A2UI
   `action` whose `name` is one of the artifact's actions, its `context` the
   edit. The host runs that action as the person, with the action's
   permission and confirmation (§7) and nothing else: a host never writes an
   app's data itself, and an edit the person may not make is never offered
   (the SDK leaves out what the action's permission doesn't allow; the app
   refuses it anyway). The result's `error.fields` are shown at the fields or
   cells they name, in the app's words.
   **Live.** A write's result names what it changed in `_meta.clegra.changed`
   (§7): artifact instance URIs of the app, or artifact types and entity names
   of it (every instance of that type). The SDK always names the record a write
   acted on and the record it answered with; the handler adds more with
   `ctx.changed(uri | type, …)` (a figure, a list the change moves). After such
   a result, through whichever host or client it came, the host tells everyone
   of the installation who may use the app, by ids only, over its live channel
   (server-sent events; never polling); each place that draws one of those
   surfaces (an answer, a document's app block, a Home widget, an open record)
   reads it again **as its own viewer** and applies it as an `updateDataModel`
   (path `/`) of the surface it has. The components stay; a person's
   uncommitted edit stays where it is and is told it is now out of date (rule
   9). Nothing is pushed on a timer and nothing of the data travels on the
   live channel.
9. **The spreadsheet.** Clegra's catalog has a native `Spreadsheet`
   component, drawn by the host (a grid, as a spreadsheet application's), for
   the SDK's template `sheet`:

   | Data (`dataModel`) | |
   |---|---|
   | `columns` | `[{ key, label, type: text\|number\|money\|percent\|date\|enum\|boolean, currency?, options?: [{ value, label }], editable?, required?, formula? }]`: `editable` (default false) as the caller may edit it; `formula: true`: computed by the app, never editable |
   | `rows` | `[{ id, version, cells: { <key>: value }, editable?, uri? }]`: `version` the row's revision as the app keeps it (an opaque string); `editable: false` locks the row for this caller |
   | `edit`, `add?`, `remove?` | The actions (their tools) that change a cell, add a row, remove rows |
   | `version?` | The sheet's revision, for a host that keeps the surface open |

   The component: typed cells formatted in the reader's locale, keyboard
   navigation (arrows, Tab, Enter to edit and commit, Escape to cancel), sort
   and filter by column (local to the person's view, never sent), copy and
   paste of a range as tab-separated text (a paste is one edit per changed
   cell, each its own `edit` action, applied in order), add and remove rows
   (with `add`, `remove`). The `Spreadsheet` component is
   `{ component: "Spreadsheet", columns, rows, edit?, add?, remove? }`, each
   bound to the data model of the same name.

   **The edit contract.** A cell commit sends `action` `{ name: <edit>,
   context: { row, column, value, version } }`; `add` sends `{ values }` (the
   new row's cells the person typed), `remove` `{ rows: [<id>…] }`. The app's
   `edit` action takes exactly that input and answers `{ ok: true, data: { row
   } }`, the row as it is now (formulas recomputed by the app), or an error:
   `invalid_input` with `error.fields: { <column>: message }` (shown at the
   cell, the person's value kept to fix), or `conflict` when `version` is not
   the row's current one, with the current row in `error.details.row`.
   The host draws a commit **optimistically**: the new value at once, marked
   pending; the answer's row replaces it, an error puts the cell back in
   editing with its message, a conflict shows the current value and says that
   someone else changed it (the person's value offered to apply again, now
   against the new `version`). A live update (rule 8) that changes a row being
   edited does the same as a conflict. Values are never computed by the
   host: sums, formulas and derived columns are the app's, returned in rows.
   An app that wants another grid brings its own component (rule 6).
10. **What it replaces.** A workspace host draws template and component
   artifacts only from `a2ui`. The template data's bare `template` and `data`
   in a resolved artifact remain only while the SDK's generated MCP Apps view
   (§5) draws them; they are removed in the release in which that view draws
   the surface itself. A host has one renderer for artifacts, the A2UI one: its
   former template drawing goes in the same change in which its apps run an
   SDK with this section.

### 5.5 Widgets: what an app offers on Home

A workspace host's Home is the person's dashboard of **widgets**. An app says
which of its artifact types are offered there, apart from the artifacts it
produces: the manifest's `widgets` is `[{ artifact, sizes, size }]`, in the
order the host's gallery lists them.

- `artifact` is a template or component artifact type of the app (§5) whose
  `params` have no required property: a widget is drawn with `{}`. A record
  type is never offered (a record is pinned from where it is shown), nor a
  view-only artifact (a host draws the surface, §5.4). Each type at most once;
  at most 12 widgets.
- `sizes` are the places it may take on the host's grid, of `small` (1×1),
  `medium` (2×1), `large` (2×2), `extraLarge` (4×2); `size` (one of them) is the
  one it is added at. Default (SDK): `medium` and `large`, the first.
- The host draws it from the artifact's surface (§5.4), read as the person
  with the artifact's permission, through the type's `show_<type>` tool or
  `clegra_resolve`; it is live like any surface (§5.4 rule 8). The artifact's
  `visibility: "app"` keeps a dashboard-only widget from every model.
- An artifact type the app does not list is never offered as a widget. Any
  artifact a person sees (a record, a figure in an answer) can still be pinned
  to Home from where it is shown: that is the person's choice, not the app's
  offer.

```ts
export const openJobs = defineArtifact({ name: "open_jobs", title: "Open jobs", description: "Jobs not done yet", params: z.object({}), template: "stat", widget: { sizes: ["small", "medium"] }, data })
// clegra/app.ts: the widgets are the artifacts with `widget`, in the order of `artifacts`
defineApp({ …, artifacts: [openJobs] })
```

## 6. The generated MCP server

Streamable HTTP at `mcp.url`. Tools, in this order of derivation:

| Tool | From | Kind |
|---|---|---|
| `<entity>_list`, `<entity>_get` | each entity (filters, `query`, `sort`, `dir`, `cursor`, `limit` ≤ 100, default 25) | read |
| `search`, `fetch` | entities with a `search` field; `search` takes an optional `kind` (an enum of the searchable entities' kinds) and each result carries `kind` when its entity has one; `fetch` carries it in `metadata` | read |
| `clegra_resolve` | always: `{ uris, want? }` → each URI's state `ok \| gone \| no-access \| not_found` and data, for hosts; hidden from models. `not_found`: a URI that is not this app's (a host MUST send an app only its own URIs); `gone`: this app's record or type that doesn't exist | read |
| `<entity>_<action>` or `<action>` | each action | read or write |
| `open_<page>` | each page except `record` pages (those are `<entity>_get`) | read |
| `show_<artifact>` | each non-record artifact | read |
| `clegra_later` | an action with `later` (§4.2) | write; only for the installation (§10) |
| `clegra_installation`, `clegra_export`, `clegra_delete` | `lifecycle` (§13) | write, read, write; only for the installation (§10) |

Rules:

1. Names match `[a-zA-Z0-9_.-]{1,64}`, are unique, and MAY be renamed by the developer; the manifest carries the actual names.
2. Names, titles and descriptions are in the app's `locale` and identical for every caller and every call. Data labels follow the caller's locale.
3. Reads carry `readOnlyHint: true`. Writes carry `readOnlyHint: false` and `destructiveHint: true` exactly when `confirm` is `always`.
4. A write is listed to plain MCP clients only when the developer opted in (`plain: true`). An entity, page or artifact MAY be hidden from them (`plain: false`).
5. A tool the caller lacks the permission for is not listed.
6. Tools with a view name it in `_meta.ui.resourceUri`; the data to draw is the result's `structuredContent`. Every tool a view calls (lists, records, actions, pages) carries `_meta.ui.visibility` with `"app"` (ChatGPT also reads `openai/widgetAccessible: true`); a host refuses a view's call to any other tool.
7. Hand-written tools, resources and views MAY be added to the same server; they are outside the manifest.
8. Entity tools (`<entity>_list`, `<entity>_get`) carry `_meta.clegra: { entity, kind? }`, `kind` as in the manifest. With a kind, their description ends with one fixed sentence: `Kind: person.`; with `{ by, map }`, the kinds in the map's order and the field: `Kind: organization or person (by type).`
9. A list filter on a field with `as` names the property in its description (`Company (worksFor): …`); a key filter says it is exact (`Email: exact email; a value or { in: [...] }`) and carries `format` where JSON Schema has one (`email`).
10. **Records are named by their title.** In the text a model reads, every record of a list, a get, `search` and `fetch` carries its `title` beside its `uri` (an outsider's title wrapped, §7). A tool of an action on a record takes `id` (required) and `record_title` (optional string, at most 300 characters): the record's title as the model read it, so a client that writes its own approval prompt from the arguments can name the record the person approves. Both descriptions tell the model to name the record by its title, never by its id. `record_title` is a display hint and never trusted: the app names the record from `id` in everything it shows or confirms, never passes the hint to the handler, and refuses the call with `invalid_input` (`fields.record_title`) when the hint names another record (compared without the untrusted wrapper, case, width, quotes and extra spaces). `record_title` is reserved: an action's `input` can't declare it.
11. **App-only items.** An entity, action or artifact with `visibility: "app"` is for views and the host's own UI, never for a model. Its tools (the entity's list and get, the action's, the artifact's show tool) carry `_meta.ui.visibility: ["app"]` (no `"model"`), `openai/visibility: "private"` and `openai/widgetAccessible: true`. `search` and `fetch` leave its records out (`fetch` answers `not_found`), and no agent of the app may use it (a definition error). A host MUST NOT give such a tool to any model, its own agents included; views and the host's UI still call it. App-only is not access control: a client that ignores `_meta.ui.visibility` lists the tool like any other, so what a client must not call stays behind a permission or `plain: false`.
12. **The installation's tools** (`clegra_later`, `clegra_installation`, `clegra_export`, `clegra_delete`) carry the same app-only `_meta` and are listed only to the installation-level caller (§10): never to a plain client, never to a person.

### 6.1 What plain MCP clients see

ChatGPT, Claude and any MCP client use the app as a plain MCP server. Of each
feature they see:

| Feature | A plain MCP client |
|---|---|
| Navigation, page actions, badges (§5.2) | The `open_<page>` tools as before. The generated view (MCP Apps hosts, ChatGPT included) draws the navigation, the badges and the page actions from the page's `view`, each action opening its form |
| `visibility: "app"` (§6 rule 11) | The tools are listed with `_meta.ui.visibility: ["app"]`: a host that follows MCP Apps keeps them from its model and lets views call them; `search` and `fetch` never return their records |
| Targets (§4.1) | Nothing: the action is its own tool, as without targets |
| `later` (§4.2) | An `always` write (elicitation, or the client's own approval guided by `destructiveHint`) answered «Scheduled for …»; it runs from the app's own cron (`app.runLater`) |
| Schedules (§11) | The scheduled action's tool, as any action. A call naming a schedule is refused |
| Notifications (§12) | Nothing: `_meta.clegra.notifications` is ignored |
| Lifecycle (§13), `clegra_later` | Nothing: the tools are never listed to them |
| A2UI surfaces (§5.4) | An A2UI host renders the `application/a2ui+json` resource of a `show_<type>` result (and reads the app's catalog, `a2ui://<app>/catalog.json`); any other client reads the result's text, as before |
| View tickets (§5.3) | Nothing: `clegra_view` is listed only to a person's Clegra app token; the views themselves are the same documents `resources/read` returns |

## 7. Enforcement

All of it happens in the server, on every surface (tools, `search`, `fetch`,
the resolver, dashboards, views), before any handler runs.

**Authorization is MCP's.** OAuth bearer tokens, protected-resource metadata
(RFC 9728), a `401` with `WWW-Authenticate`. There is no second sign-in, and
**an app never signs people in with someone else's accounts**: not Clegra's,
not a host's. Its callers are its own:

1. **Its sign-in module's** (`auth.signIn`, `@clegra/sdk/signin`, below «Your
   sign-in»): the delegations the app issues over its own login to any client
   (Clegra, ChatGPT, Claude: each person links their account of the app once,
   through the app's own consent), and the personal keys its people make.
2. **Its own authorization server's** (`auth.resolve`): an app whose auth
   library already is an OAuth server (better-auth, Clerk, Auth0, WorkOS)
   verifies its tokens itself and names the caller (below, «The app's own
   tokens»).
3. **The public caller** (`auth.public`, below).

A workspace host such as Clegra is one of those clients: it acts for a person
only with the delegation the app issued to it, revocable at the app, and
without one reaches only the app's public part. The app's own sign-in, pages
and hosting keep working without any host.

**Public operations.** Signing in is not mandatory for an app. With
`auth.public: { installation }` a call without a token is served as that
installation's public caller, in production too, and reaches only the actions
declared `public: true`:

1. A public action is global (no `entity`), needs no `permission`, and is for
   every client (never `plain: false` or `visibility: "app"`). The public
   caller sees no record, page or artifact: entities, `search`, `fetch` and
   the resolver answer as for a caller with no access.
2. A public write is always confirmed: its `confirm` is `always` (anything
   else is refused at definition), so it carries `destructiveHint: true` and
   the host asks the person before it runs (Clegra's company server, which
   calls such a server with no token, waits for «Conferma»; a plain client
   elicits or applies its own approval, below).
3. The manifest marks it `public: true`; a token, when one is sent, is
   verified as always and never falls back to the public caller.

`auth.anonymous` (a caller with chosen permissions, for local demos) stays
refused in production, and an app has one or the other.

**Your sign-in.** `createSignIn(app, { issuer, resource, login, permissionsOf,
store, keys, clientOrigins })` is an OAuth 2.1 authorization server on top of
the app's own login (`login.session(request)`, `login.signInUrl(returnTo)`), or
of the module's password login (`passwordLogin`) for an app that has none:

- authorization code with PKCE `S256`; clients known by their Client ID
  Metadata Document (public, or `private_key_jwt` with its keys); no dynamic
  registration; RFC 8414 metadata at the root, RFC 8707 `resource`, RFC 9207
  `iss`;
- the consent page in the person's language («Allow <client> to use <app> for
  you?»), the scopes being the app's permissions;
- access tokens `at+jwt` (RFC 9068), EdDSA, `jwks_uri`, `aud` exactly the
  app's MCP address, ten minutes, carrying the delegation's id (`sid`); bound
  to the client's key (`cnf.jkt`, RFC 9449 DPoP) when the token request
  carries a proof, Bearer otherwise;
- refresh tokens rotated on every use; a used one presented again ends the
  delegation for every holder; RFC 7009 revocation;
- `response_mode=web_message`: inside a workspace client's frame the answer
  `{ type: "authorization_response", response: { code, state, iss } }` is
  posted to the parent, only to the app's configured client origins;
- personal keys (`signIn.keys.create(person, { name, scopes })`): an opaque
  key (`cpk_…`) for background work, bound to one person and scopes, kept as a
  hash, listed without the key, revoked at once;
- what a token or key allows is read live on every call: the person's
  permissions now (`permissionsOf`; null for someone who left refuses
  everything of theirs), narrowed to the delegation's scopes; a removed
  delegation (`signIn.links.revoke`, `signIn.forget`) ends its access tokens
  at once.

Its session cookie (`frameCookie`) is `Secure; SameSite=None; Partitioned`
over https (and on a loopback address), so the app's own sign-in works inside
a workspace client's frame and stays in that frame's partition; over plain
http `SameSite=Lax`.

**CORS.** Clients may call an app from a browser, cross-origin. An app answers
any origin (an open MCP server, no cookies on its MCP routes): `Authorization`,
`DPoP` and `Content-Type` (and MCP's own headers) allowed, `DPoP-Nonce` and
`WWW-Authenticate` exposed, never `Access-Control-Allow-Credentials`.

**Views at the app's own origin.** A workspace client never draws an app's
view on a page of its own: it frames it from the app itself (§5.3), so the
app's origin is the view's isolation boundary. View tickets are for a signed-in
person (never the public caller) and one of the app's `clientOrigins`. An
app's own site (§5.1) is framed the same way, at its own origin, the person
signed in with the app's own sign-in inside the frame.

**The app's own tokens.** The app verifies each one (signature, expiry, and
`aud` = `auth.resource`, RFC 8707: a token issued for another resource is
refused) and maps it to a caller: `{ installation, person, permissions,
locale? }`. The SDK hook is `auth.resolve(token, request, { resource })`; it
returns null for a token that is not the app's (a `401` follows) or throws
with the reason.

- `installation` is the app's own tenant (an organization, a workspace, an
  account), taken from the verified token or the session behind it, never
  from a request parameter. It matches `[A-Za-z0-9._:-]{1,128}`: no `@`, so it
  can never equal a Clegra tenant `<company>@<issuer>`.
- `permissions` come from the app's own roles; ids the manifest does not
  declare are dropped. The caller is a plain host (`host: "plain"`).
- A token of the sign-in module or a development token (`devSignIn`) is never
  handed to `auth.resolve`.
- The protected-resource metadata names the app's authorization server
  (`auth.authorizationServers`). Paths the authorization server needs outside
  its own mount (RFC 8414 metadata under `/.well-known/`) MAY be answered by
  the same routes (`auth.serve`).
- `auth.resource` is required in production with `resolve` (with `signIn` it
  is the sign-in module's): without it every request but the manifest fails
  with a clear `500 misconfigured`, never with an address guessed from request
  headers.
- The protected-resource metadata names the app's own authorization server:
  the sign-in module, or `auth.authorizationServers` with `resolve`.

**Permissions and visibility**

- Entity, action, page, artifact and field permissions are checked on every call.
- A field the caller may not see is absent from rows, records, cards, filters
  and sorts, and text search looks only in the search fields the caller may
  see (handlers receive them as `textFields`).
- What is hidden from plain clients (`plain: false`) is hidden from them
  everywhere: its tools are not listed, and `fetch`, the resolver, reference
  titles, dashboards and record actions answer `no-access` for it.

**Confirmation** of a write whose `confirm` is `always` (a sensitive tool):

- a development workspace host (§10) shows the person the exact values, then sends a proof: a
  JWT (`typ: clegra-confirm+jwt`, 5 minutes at most) signed by the token's
  issuer for the same audience and subject, with `installation`, `tool`,
  `call` (the call id) and `args`: the base64url SHA-256 of the canonical
  JSON (keys sorted at every depth) of the arguments **as sent**, before any
  parsing or default; for an action with `later`, also `until` (§4.2).
  Without a valid proof the call fails with `confirmation_required` and
  `error.confirm` describes what to show (`{ tool, title, record?, input,
  later? }`);
- a plain client that supports MCP elicitation is asked to confirm, with the
  values as a person reads them (labels, titles of referenced records);
- a plain client that can't elicit: the client's own approval applies, guided
  by the tool's annotations (`destructiveHint`, the index's `effect:
  "irreversible"`); the server runs the call. A workspace host such as Clegra
  is such a client: it asks the person («Conferma») before it sends the call.
  (A confirmation the app can verify end to end, signed by the host's keys of
  `use: "confirm"` from its client metadata document, is planned.)

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

- Requests MAY carry `{ call, confirmation, confirmed, settings, schedule }`.
  `confirmation` and `confirmed` are a confirmation (above). `settings` are the
  installation's values (§2) and count only from a development workspace host;
  any other caller gets the defaults. `schedule` names the schedule this call
  is a run of (§11); it counts only from the installation-level caller (§10),
  and any other call carrying it is refused.
- Results MAY carry `{ notifications, untrusted, l10n, changed }`:
  - `changed`: what a write changed, for hosts to draw again where it is open
    (§5.4 rule 8): artifact instance URIs of this app, artifact types, entity
    names. Others' URIs are refused when the result is made.
  - `notifications`: `[{ type?, title, body?, uri?, to }]` (§12). `to` is
    either the ids of people (as the token named them; default the caller's
    person) or `"admins"`: the company's administrators (§12). A workspace
    host delivers them; a plain client ignores them.
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
`invalid_input`, `confirmation_required`, `conflict`, `rate_limited`,
`internal`. `rate_limited` (a handler's `ctx.rateLimit`, per person or per
tenant) carries `retryAfterSeconds`.
An action's `invalid_input` also carries `fields`: `{ <input key>: <what is
wrong> }`, in the caller's locale where the server has it; `message` names
the fields by their labels. It is a tool error, never a protocol error, so a
view and a model can both read it.

**Development** (SDK): `devSignIn(app, { issuer?, resource?, people?,
installation?, code?, clientOrigins? })` of `@clegra/sdk/signin` is the sign-in
module (below) over a login of test people, served as `auth: { signIn }`:

- **The dev login** (`/oauth/dev-login`): a page listing the test people
  (default one, «Test person», who may do everything) that asks for a one-time
  code printed when the app starts; five wrong codes close it until the app
  restarts. Real MCP clients link through the module's own OAuth flow, consent
  included, as in production. There is no dynamic registration. `issuer`
  defaults to `http://localhost:3000`, `resource` to `<issuer>/mcp`: the
  tokens' audience is the sign-in's, never the address a request reached.
- **Development tokens** (`served.dev.token({ person?, permissions?, host?,
  installation?, locale? })`): an access token naming any person, permissions,
  installation and language; its tenant is `<installation>@clegra-dev`. With
  `host: "workspace"` it stands in for a **development workspace host**: a
  token per request (60 seconds, a `jti` used once) whose host sends
  `settings`, confirms writes with a signed proof
  (`served.dev.confirmation({ tool, args, call, person?, installation?,
  until? })`, `clegra-confirm+jwt`, below) and, with no person, is the
  installation-level caller (§10).
- Refused when `NODE_ENV` is `production`; its development tokens and proofs
  count only from callers on a loopback address (checked on every request; a
  framework route that can't know the peer's address, such as a Next.js route
  handler, never accepts them); its keys live in memory.

### Client registration (the sign-in module)

The sign-in module knows a client by its **Client ID Metadata Document** (what
current MCP clients use, MCP authorization 2025-11-25): the `client_id` is the
https URL of a JSON document that describes the client. The server metadata
says `client_id_metadata_document_supported: true`. There is no dynamic
registration and no client id that is not such a URL.

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
  The resolver is the runtime's (`useHostLookup`, set by the adapters); on a
  runtime that gave none a host name is refused.
- A known limit: the addresses are checked, then the request resolves the
  name again, so DNS rebinding is not excluded. The connection is not pinned
  to the checked address.

### Production: an app with its own authorization server

An app whose auth library already is an OAuth authorization server
(better-auth's MCP plugin, Clerk, WorkOS, Auth0, …) uses it instead of the
sign-in module and verifies its tokens in `auth.resolve` (recipes,
non-normative: [auth.md](auth.md)). For MCP clients (ChatGPT, Claude, others)
to connect to it, that authorization server needs:

- OAuth 2.1 authorization code with PKCE `S256`.
- Metadata (RFC 8414, or OpenID Connect discovery) with
  `code_challenge_methods_supported`. Clients refuse a server that does not
  list it.
- Protected-resource metadata (RFC 9728). The SDK serves it;
  `auth.authorizationServers` names the authorization server.
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

### The index as OpenAPI

The app's index, its operations with their effects (and its pages), is also an
OpenAPI 3.1 document, a view of the same thing for tools that read OpenAPI:

- `GET <path>/openapi.json` (no authentication) answers the document. Its
  operations are every tool a plain client may call when it holds every
  permission: entity reads, `search`, `fetch`, page and artifact tools and
  actions; never the protocol's own `clegra_*` tools. Each is
  `POST <path>/operations/<tool>`, `operationId` the tool, its request body
  the tool's input JSON Schema, its 200 the tool's structured content, tagged by
  its entity (else the app). Extensions: `x-mcp-tool` (the tool),
  `x-clegra-effect` (`read`, `write`, `irreversible`, as the manifest's
  `effect`), on an action `x-clegra-confirm` and, on a record action,
  `x-clegra-entity`; on an entity read `x-clegra-entity` and `x-clegra-read`
  (`list` or `get`). The document's `x-clegra-pages` lists the pages
  (`{ name, kind, title, tool }`, no derived record pages) and
  `x-clegra-manifest` points at `/.well-known/clegra.json`.
- **Security**: with the sign-in module, an `oauth2` scheme (authorization
  code, its authorize and token endpoints, the app's permissions as scopes);
  with `auth.resolve`, an `http` bearer scheme; a public action has
  `security: []`.
- **A call**: `POST <path>/operations/<tool>` with the arguments as a JSON
  object, authenticated exactly as MCP (`Authorization: Bearer` or `DPoP`, a
  DPoP proof's `htu` being the operation's URL). It runs the same tool with the
  same caller, permissions, field stripping, idempotency and checks; a tool
  the caller may not use is `404`. A write's `Idempotency-Key` header (1–128
  visible ASCII characters) is its call id. The caller is a plain client: a
  `confirm: "always"` write runs on the caller's own approval, as for a plain
  MCP client that can't elicit.
- **Answers**: `200` with the structured result; an error as
  `{ error: { code, message, … } }` with the status of its code:
  `invalid_input` 400, `unauthorized` 401, `permission_denied` 403,
  `not_found` 404, `conflict` 409, `confirmation_required` 428,
  `rate_limited` 429, `internal` 500. A missing or refused token is answered as
  on MCP (`401` with `WWW-Authenticate`).

## 8. Conformance

[`spec`](../spec) checks any app from outside,
over HTTP, whatever it is built with:

```sh
npx @clegra/sdk check https://crm.example.com --token <a plain caller's bearer>
```

The token is one the app's own sign-in issued to a test person (a personal key
is the simplest: `signIn.keys.create`).

| Check | Passes when |
|---|---|
| `manifest.served` | `GET /.well-known/clegra.json` answers 200 with JSON |
| `manifest.schema` | the manifest validates against the JSON Schema |
| `manifest.references` | names refer to things the manifest declares; tool names are unique and valid, none reserved; the publisher is well-formed (§2); navigation, page actions, badges, app-only items, targets, `later`, schedules and notification types meet their rules (§4.1, §4.2, §5.2, §6 rule 11, §11, §12) |
| `auth.mcp` | without a token the endpoint answers 401 and points to protected-resource metadata, whose `resource` is the address the app was reached at (or the manifest's `auth.resource`) and which names an authorization server |
| `mcp.initialize` | `initialize` succeeds with no extension |
| `mcp.tools` | tools match the manifest: names, `readOnlyHint`, `destructiveHint`; nothing hidden is listed |
| `mcp.deterministic` | `tools/list` is the same on every call |
| `mcp.sort` | a list tool offers to sort only by fields the manifest declares sortable, and refuses any other key |
| `mcp.views` | every view a tool names is served as an MCP Apps document |
| `mcp.titles` | each row of a list's text carries its `uri` and `title`, and the record's text from its get tool the same title; every action tool on a record takes a required string `id` and an optional string `record_title` |
| `mcp.app-callable` | the tools a view calls (lists, records, actions, pages) don't leave `"app"` out of `_meta.ui.visibility` |
| `mcp.visibility` | the tools of app-only entities, actions and artifacts carry `_meta.ui.visibility: ["app"]`, without `"model"`; `search` finds no record of an app-only entity |
| `lifecycle.hidden` | `clegra_later`, `clegra_installation`, `clegra_export` and `clegra_delete` are not listed to a plain caller or a person |
| `mcp.manifest` | the manifest is one MCP resource, identical to the file |
| `kinds.known` | every unprefixed kind is in `kinds.json` for the `specVersion`; every dotted kind is well-formed |
| `kinds.properties` | every `as` belongs to the entity's kind (or is universal) with a matching type; single-valued properties appear once; required ones exist; keys are filters; `kinds` definitions are well-formed |
| `kinds.keys` | listing with a key value taken from a returned record, in another letter case where case doesn't count, returns that record and only records holding that value |
| `kinds.values` | sampled records: `email`, `vatID`, `gtin`, dates, `address` and numbers have the stated form |
| `kinds.tools` | entity tools carry the kind in the description and in `_meta.clegra`; `search` offers `kind`, keeps to it, and names each result's kind |
| `refs.cross` | a `ref: { kind }` field's values are record URIs; its text form is `{ uri, kind }`; no `refs` title is sent for it; such an action input is a string |
| `resolve.foreign` | the resolver answers `not_found` for another app's URI |
| `site.frame-ancestors` | (public) an app with a `site`: its start page, as a frame asks for it, says who may frame it (`frame-ancestors`), never any site (`*`, `https:`), and sends no `X-Frame-Options` |

The `kinds.*` checks are skipped, not failed, for an app that declares no
kinds (and `kinds.keys` when no listed record holds a key value to try);
`refs.cross` for an app without references to other apps; the `site.*`
checks for an app without a site; `mcp.visibility` for an app
without app-only items; `lifecycle.hidden` for an app without lifecycle tools
or later runs; for an app without
sensitive writes listed to the caller.

An app is conformant when every check passes with a token its own sign-in
issued to a test person. Without a token
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

## 10. The installation-level caller

Some calls are made by a workspace host for the installation itself, with
nobody at the screen: schedules (§11), later runs (§4.2) and the lifecycle
(§13). The **installation-level caller** is exactly:

1. **The token.** A development workspace host's token (the SDK's dev
   authority: `host: "workspace"`, one request, `jti`), whose `clegra` claim
   has **no `person`**, with `sub` = `installation:<installation>` and
   `permissions` = exactly the permission the called action declares (an
   empty list when it declares none, and for the reserved tools; never more).
   No host has a token without a person: outside development an app runs its
   own cron for its schedules and later runs, and its export and delete from
   its own administration (draft 1.0).
2. **What it may call.** (a) A schedule's tool, with `_meta.clegra.schedule`
   = that schedule's name; (b) `clegra_later`; (c) the lifecycle tools. The
   app refuses with `permission_denied` a `schedule` that names no schedule of
   the app, names a schedule of another tool, or comes from any other caller
   (a person, a plain client). A person-less workspace call to any other tool
   is not refused for being one: it has the permissions its token lists, as
   §7 says (a host uses that for its administrators' checks).
3. **No confirmation.** None is ever shown or proven: a scheduled action is
   never `confirm: "always"` (§11), an `optional` write runs, and a later run
   carries the proof made when the person confirmed it.
4. **What handlers see.** `ctx.person` is null (in a later run: the run's
   author), `ctx.schedule` the schedule's name (`clegra_later` in a later
   run; null in any other call), `ctx.permissions` as the token lists them,
   `ctx.settings` as the host sent them.
5. **Results.** Notifications in its results are delivered by the host as
   any (§12); each says `to`, since there is no person to default to.

Only a development workspace host can be this caller. An app
that signs its callers in itself (its own tokens, §7) is never called as the
installation: a host that connects to it as an OAuth client runs no
schedules and no lifecycle tools there, and the app runs its own cron.

## 11. Schedules

`schedules` lists `{ name, action?, tool, every, maxSeconds }`: actions the
workspace host runs as the installation (§10).

1. `name` is an identifier; at most 10 schedules besides the SDK's own
   `clegra_later` (§4.2), which has no `action`, `tool: "clegra_later"` and
   `every: 5`.
2. `action` is a global action whose input accepts `{}` (no required
   property), and `tool` is its tool. The action is a read, or a write whose
   `confirm` is `never` or `optional`. A write with `confirm: "always"` is
   never scheduled: nobody is there to confirm it. The only way to run a
   confirmed write afterwards is `later` (§4.2).
3. `every` is whole minutes, 5–1440; `maxSeconds` whole seconds, 1–300 (the
   SDK's default is 60).
4. A run is `tools/call` of `tool` with `{}` and `_meta.clegra.schedule` =
   `name`, by the installation-level caller (§10), with the installation's
   `settings`.

A host runs a schedule at most once every `every` minutes per installation
(claimed in its own database, so two of its processes never run it twice),
within `maxSeconds`, and only while the installation is enabled. It keeps a
log of the runs (ok or failed, with the message).

## 12. Notifications

A result's `_meta.clegra.notifications` (§7) asks the workspace host to tell
people of the installation something: `{ type?, title, body?, uri?, to }`,
`title` and `body` in the caller's language, `uri` a record of the app.

1. **Types.** `notifications` in the manifest lists the types an app sends:
   `{ type, label, description?, default, permission? }`. People turn a type
   off (or on) per app. `default: false` keeps it off for a person until they
   turn it on. With `permission` (a declared one) only its holders receive it:
   who holds what is the app's to know (its own roles), so the app names only
   them in `to`.
2. **Typed or untyped.** An app that declares types names one of them in
   every notification it sends (the SDK refuses any other: a programming
   error). An app that declares none sends untyped notifications, which the
   host files under one type of its own per app. The SDK's `clegra_later`
   (§4.2) does not count as a declared type: it never makes the app's other
   notifications typed.
3. **Recipients.** `to` is a list of person ids (as the token named them), or
   `"admins"`: the company's administrators. The host keeps none of the app's
   permissions, so «everyone who holds a permission» is a list of ids the app
   makes from its own roles (the SDK's `app.roles.list`). Without `to` the SDK sends the caller's person; a
   call without a person (§10) MUST say `to`.
4. **Reserved.** `clegra_later` is the SDK's type for later runs that did not
   run (`default: true`); an app declares it only through `later`.

## 13. The app lifecycle

An app MAY be told of its installation's changes and give or delete the
tenant's data, through three reserved app-only tools that it names in
`lifecycle` (`{ installation?: "clegra_installation", export?: "clegra_export",
delete?: "clegra_delete" }`, each optional). Only the installation-level
caller (§10) is given them (§6 rule 12).

- **`clegra_installation`** `{ state: "enabled" | "disabled" | "uninstalled" }`
  → `{ ok: true }`. The host calls it after an administrator enables,
  disables or uninstalls the app. A failure never blocks the administrator's
  change; the host shows it.
- **`clegra_export`** `{}` → the tenant's data as one file:
  `structuredContent` `{ name, contentType, bytes, sha256 }` (`sha256` the
  lowercase hex SHA-256 of the file's bytes; `name` matches
  `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`), and among its `content` one MCP
  embedded resource `{ type: "resource", resource: { uri:
  "clegra://<app>/export/<name>", mimeType, blob } }` holding the file
  (base64). `{ empty: true }` when the app keeps nothing for the tenant. At
  most 512 MiB; a host refuses more, and a file whose size or hash doesn't
  match.
- **`clegra_delete`** `{}` → `{ deleted: true, counts? }` (`counts`: what was
  deleted, by name; the SDK adds `later_runs`): everything the app keeps for
  the tenant, its later runs included. Idempotent: asking again is never an
  error and answers `deleted: true` again (`counts` then say what that call
  deleted).

`clegra_export` and `clegra_delete` MUST keep working after `uninstalled`:
that is when they are needed.

**Host guidance** (non-normative). On uninstall Clegra asks the administrator
to choose: «Export, then delete in 30 days» (the export is made now and kept
30 days for download; `clegra_delete` is called after 30 days) or «Delete
now» (`clegra_delete` now, no export). Without `clegra_export` the choice
reads «Delete in 30 days» or «Delete now»; without `clegra_delete` the host
offers the export only, and says the data stay on the app's server. A failed
export stops the uninstall; a failed delete is retried, with backoff, and
shown to the administrators. An app without any of these tools is
uninstalled, enabled and disabled on the host alone, and the host tells the
administrator in so many words that the app is not told and its data stay on
its server.
