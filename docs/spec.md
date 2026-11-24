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
clients see of each one is in §6.1.

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
| `events?` | `{ url }`: where Clegra's core posts its signed events, on the app's own origin (§7, «Events»). Present with `auth.clegra` |
| `rolesTool?` | The read-only «who has what» tool, `clegra_roles` (§7, «Roles»). Present with `auth.clegra` |

**Labels** are always maps per locale (`{ "en": "Deal", "it": "Trattativa" }`);
a host picks the person's locale, then `locale`, then the first entry.
Identifiers are never translated. **Tool refs** are `{ name, plain }`: the MCP
tool, and whether it is listed to plain MCP clients.
**Agents** are `{ name, title, description, instructions, tools, tier:
fast|standard|strong, starters? }`: the host's model runs them with those tools.
**Reserved names**: the tools `clegra_later`, `clegra_installation`,
`clegra_export` and `clegra_delete` are the installation's (§10), `clegra_roles`
the app administrators' (§7); no entity, action, page or artifact tool takes them. The schedule and notification type
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

**Creatable types.** `create: { action, title }` makes an artifact type one
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
**as that site** in a Clegra client: the client frames the app's real pages,
the person signed in without a word, and draws nothing around them. The
generated views (§5, §5.3) stay for an app without a site and for every other
host (ChatGPT, Claude: MCP Apps). The site lives at the app's own origin, the
origin of its MCP address (`auth.resource`).

1. **Declared.** The manifest's `site` is `{ start, tool }`: `start` the path
   the app opens at (default `/`), `tool` the ticket tool (`clegra_site`, not
   listed to plain callers). It needs `auth.clegra` and a signing secret
   (`CLEGRA_SITE_SECRET`, 32+ characters; or `site.secret`).
2. **Asked for.** The client, holding the person's own app token (no `act`:
   an agent never opens a site), calls `clegra_site { path?, origin, theme?,
   locale?, renew? }`. `path` is a path on the app's own origin (`/`, then
   anything but `//`, `\` or spaces; a query and a fragment allowed; at most
   2048 characters; never under `/clegra/`), default `start`; `origin` the
   origin of the document that frames the site, exactly one of the app's client
   origins (`clientOrigins`, `CLEGRA_CLIENT_ORIGINS`; the desktop app's `app://client` included); `theme` `light` or
   `dark` and `locale` the client's now. `renew: true` asks for a ticket that
   only renews the session (step 7). It answers `{ path, action, field, ticket,
   expiresAt, sessionSeconds }`: `action` is `<app origin>/clegra/site`,
   `field` is `ticket`.
3. **The ticket** is a JWT (`typ: clegra-site+jwt`, HMAC with a key only the
   app holds), `iss` and `aud` the app's origin, `path`, `origin`, `jti`, `iat`,
   `exp` at most 60 seconds after `iat`, and the caller as the token named it
   (`clegra: { installation, person, email?, permissions, admin, locale?,
   theme? }`), nothing more.
4. **Posted, never in a URL.** The framing document submits a form with
   `method="post"`, `action`, `target` = the frame, the ticket in `field`. So
   the ticket is never in an address bar, the history, a server's log or a
   `Referer`, and the browser itself states the poster's `Origin`.
5. **Exchanged once.** The app MUST refuse (a 4xx page, no cookie) a request
   that is not a POST, whose `Sec-Fetch-Dest` is not `iframe`, whose `Origin`
   is not the ticket's or no longer a client origin, and a ticket that is
   tampered, of another app, expired, issued more than 5 seconds in the
   future, living longer than 60 seconds, or already used (its `jti` kept,
   atomically, until it expires: shared by every instance). Otherwise it
   answers `303` to `<app origin><path>` (absolute, from the ticket: never
   from the request) with `Referrer-Policy: no-referrer`, `Cache-Control:
   no-store` and two cookies, both `Secure; HttpOnly; SameSite=None;
   Partitioned` (CHIPS: kept under the client's top-level site only),
   `Path=/`, no `Domain`: the **session** (`__Secure-clegra-site`), holding
   the ticket's caller and origin signed with another key than tickets, a
   short `Max-Age` (default 10 minutes, at most an hour); and a **marker**
   (`__Secure-clegra-site-origin`, 12 hours, the framing origin), which says
   that this partition is a Clegra client's.
6. **Read by the site.** Any page, server function or route handler of the
   site asks who is calling (`getClegraCaller`): the session's caller, its
   tenant (`installation`, exactly as a handler's `ctx`), person, permissions
   (the app's own roles, §7), locale and theme; null without a valid session,
   for a top-level navigation (`Sec-Fetch-Dest: document`), and for a person
   removed (or an app uninstalled, a company suspended) since it was issued.
   The app treats that caller as a member of the tenant with exactly those
   permissions, beside its own sign-in.
7. **Framing.** Every page of the site answers, in front of the app:
   - with a valid session: `Content-Security-Policy: frame-ancestors 'self'
     <the session's origin>` (no `X-Frame-Options`);
   - without one, in a frame (`Sec-Fetch-Dest: iframe`) of a partition with
     the marker: a short page framable by the marker's origin that posts
     `{ type: "clegra/signed-out" }` to it (the client says so and opens the
     site again with a new ticket);
   - otherwise: the app's own policy (`frame-ancestors 'none'` for our apps).
   So the site's own sign-in, consent and settings pages are never framed by
   anyone outside a Clegra session.
8. **The bridge.** A page of the site loads the SDK's bridge
   (`<script src="/clegra/site/bridge.js" async>`; `<ClegraSite />` in Next).
   Outside a frame, or without a session (`GET /clegra/site/session` answers
   `204`), it does nothing. In a session it speaks with `window.parent` only,
   posting with `targetOrigin` the session's origin and taking a message only
   when its `source` is `window.parent` and its `origin` that origin:
   - `{ type: "clegra/location", path, title }` (frame → client) at load and
     after every navigation (the History API, `popstate`, the title's
     changes): `path` is the path, query and fragment. The client checks the
     frame and the app's origin and shows `/<app><path>` in its own address
     (the History API); a reload, «Back» or a link open the site again at that
     path, with a new ticket.
   - `{ type: "clegra/context", theme, locale }` (client → frame): after the
     first message and on every change. The bridge sets the document's theme
     (`data-theme` and the `dark` class on `<html>`, `color-scheme`) at once;
     when theme or locale differ from the session's it keeps them in the
     session (`POST /clegra/site/context`, same origin), and a new locale
     reloads the page, drawn in it. The site's server reads both from the
     caller (no flash: `<html>` gets them while rendering).
   - `{ type: "clegra/renew" }` (frame → client), 90 seconds before the
     session ends. The client asks a ticket with `renew: true` and posts it
     into a hidden frame of the same sandbox; its exchange sets a new session
     in the same partition and lands on `/clegra/site/renewed`, which posts
     `{ type: "clegra/renewed", expiresAt }` to the client; the client passes
     it on to the site's frame. A renewal that fails leaves the session to end:
     the next request in the frame is step 7's signed-out page.
9. **The frame.** The client frames the site with `sandbox="allow-scripts
   allow-forms allow-same-origin allow-downloads allow-popups"`, never
   `allow-top-navigation` or `allow-popups-to-escape-sandbox`, never at an
   origin of its own; its `frame-src` lists exactly the company's app origins.

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
shared with other apps. With `auth.clegra`:

1. **Asked for.** The client, holding the person's app token, calls
   `clegra_view { view, origin }`: `view` one of the app's view URIs
   (`ui://<app>/…`), `origin` the origin of the document that will frame the
   view and post the ticket. The tool is app-only (`_meta.ui.visibility:
   ["app"]`) and listed only to a person's own app token (no `act`: an agent
   never opens a view). It refuses a view the app doesn't have and an origin
   that is not exactly one of the app's client origins (`clientOrigins`,
   `CLEGRA_CLIENT_ORIGINS`; the desktop app's `app://client` included). It
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
   entity's `record: { fields, actions? }`, declared once: 1–6 key fields of
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
defineApp({
  artifacts: { open_jobs: { title: "Open jobs", params: z.object({}), template: "stat", data } },
  widgets: { open_jobs: { sizes: ["small", "medium"] } },
})
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
(RFC 9728), a `401` with `WWW-Authenticate`. There is no second sign-in. An
app accepts two kinds of token:

1. **Its own** (an app with its own users): issued by the app's own
   authorization server to an MCP client (ChatGPT, Claude, any client connect
   the same way, as OAuth clients; each person links their account of the app
   once). The app verifies them itself and names the caller (below, «The
   app's own tokens»).
2. **Clegra's core's** (the trusted-issuer mode, `auth.clegra`): Clegra is a
   platform of integrated apps, its core the one issuer an app trusts for
   Clegra's people. Below, «Clegra tokens».

An app may accept both (a CRM with its own users that Clegra companies also
use); the two never meet: a core token is recognised by its `iss` and its
`DPoP` scheme and is never handed to `auth.resolve`.

**Clegra tokens.** Clegra's core mints, for exactly one app, tokens signed with
its keys of `use: "app"`, published at `<issuer>/.well-known/clegra-keys.json`
(fetched once and kept; refreshed every 10 minutes and on an unknown `kid`, at
most once a minute):

| Token | `typ` | Claims beyond `iss`, `aud`, `sub`, `iat`, `exp`, `jti` | Lives |
|---|---|---|---|
| app token: a person from a Clegra client | `clegra-app+jwt` | `company`, `company_role` (`admin`/`member`), `email`, `name`, `locale` (the person's language, BCP 47), `cnf.jkt` (the device's key) | ≤ 10 minutes |
| delegated token: Clegra's agent for the person | `clegra-app+jwt` | as above, `act: { sub: "server:<id>" }`, `cnf.jkt` the server's key, `person_jkt` the person's device key | ≤ 60 s, one call |
| automation run token | `clegra-app+jwt` | as the delegated token, `grant` (the person's consent) and `tools` (the tools consented to) | ≤ 60 s, one call |
| device-agent token: an agent on the person's device | `clegra-app+jwt` | as the app token, `act: { sub: "device-agent:<jkt>" }` | ≤ 10 minutes |

- **Audience.** `aud` is the app's own resource, `auth.resource`, exactly, as
  a string (an array is refused, even one holding the resource). A token for
  another app is useless here.
- **Tenant.** `<company>@<issuer>`, from the token only, never from anything a
  client sends. `company` matches `[A-Za-z0-9._:-]{1,128}`.
- **Subject.** `sub` is **pairwise**: the core gives the same person a
  different id in every app. It is `ctx.person.id`; the name is the token's.
- **Language.** `locale` is the person's language, in every Clegra token
  (the agent's delegated and automation tokens too), so the app's answers to
  them read in it, whoever calls. It is the caller's `locale`: `ctx.locale`
  and `ctx.t`, the data labels, titles, figures and errors (§6 rule 2). A
  token without it answers in the app's own `locale`. A change of language
  reaches the app with the next token.
- **Allowed companies.** A private app is configured with the companies that
  may use it (`allowedCompanies`), a public one with `"any"`; a token of
  another company is refused. **In production an app without
  `registrationId` and `allowedCompanies` fails closed**: every request answers
  `500 misconfigured`, except the two public documents registering needs (the
  manifest and the registration document, below).
- **Proof of possession (DPoP, RFC 9449).** Every Clegra token is sent as
  `Authorization: DPoP <token>` with a `DPoP` proof: `typ: dpop+jwt`, a public
  `jwk` whose thumbprint is the token's `cnf.jkt`, `htm` the request's method,
  `htu` **the app's configured resource** (query and fragment ignored; never
  compared with the request's own URL or `Host`, which a proxy or a tunnel
  changes), `ath` the base64url SHA-256 of the token, `iat` within 60 seconds,
  `jti` used once (kept in the store). A proof whose `iat` is off, or whose
  `nonce` is unknown, gets `401` with `WWW-Authenticate: DPoP
  error="use_dpop_nonce"` and a `DPoP-Nonce` header; a proof carrying a nonce
  the app gave (good for 5 minutes) is accepted whatever its clock. A Clegra
  token sent as a bearer is refused.
- **Single use.** A token with a `server:` actor is accepted once.
- **Revocation.** The core's events (below) make the app refuse what was
  issued before them: to a removed person, for an unassigned or uninstalled
  app, for a suspended company.
- **Settings.** A Clegra caller never says them: `_meta.clegra.settings` from
  it is ignored and handlers get the defaults (an app's settings live in the
  app).

**CORS.** Clegra's clients call an app from a browser, cross-origin (nothing
assumes the client and the app share an origin). With `auth.clegra` an app
answers only its configured client origins (`clientOrigins`, exact):
`Access-Control-Allow-Origin` that origin, `Authorization`, `DPoP` and
`Content-Type` (and MCP's own headers) allowed, `DPoP-Nonce` and
`WWW-Authenticate` exposed, never `Access-Control-Allow-Credentials`; a
preflight is answered `204`. Any other origin gets no allow header. Without
`auth.clegra` an app answers any origin (an open MCP server).

**Views at the app's own origin.** Clegra never draws an app's view on a page
of its own: a Clegra client frames it from the app itself (§5.3), so the app's
origin is the view's isolation boundary. The view never shares an origin,
cookies or storage with the client, holds no token, and its tool calls are
proxied by the client. An app's own site (§5.1) is framed the same way, at its
own origin, the person signed in with a site ticket.

**Roles: the app's own permissions.** Who may do what inside an app is the
app's: for a Clegra caller the SDK keeps a grant per person (`sub`) per tenant
in the store (`roles`). A company administrator (`company_role: "admin"`) is an
app administrator, with every declared permission, unless the app says
`companyAdmin: "member"`; anyone else has what an app administrator assigned,
or the declared defaults (`default: true`) until then. `ctx.admin` says whether
the caller is an app administrator. The read-only tool `clegra_roles` («who has
what», named in the manifest's `rolesTool`) lists, for an app administrator,
every person the app knows in the tenant with their company role, whether they
administer the app, their permissions and where those come from
(`company-admin`, `assigned`, `default`).

**Events.** The core tells an app what changed by posting a signed event to the
endpoint its manifest declares (`events: { url }`, on the app's own origin; the
SDK serves `<path>/clegra/events`): `POST`, `content-type: application/jwt`, one
JWS with `typ: clegra-event+jwt`, signed with an `app` key, `aud` the app's
resource, `exp` at most 5 minutes after `iat`, `jti` the event's id, and
`event: { kind, at, company, sub?, installation? }`. The app takes each `jti`
once (a retry of a handled one answers `204` again; a handler's failure
answers `500`, so the core retries).

| `kind` | What the SDK does | The lifecycle hook (§13) |
|---|---|---|
| `member.removed` (`sub`) | drops the person's roles in the tenant; refuses tokens, view tickets and site sessions issued to them before | — |
| `app.unassigned` | drops the tenant's roles; refuses what was issued for it before | `disabled` |
| `app.uninstalled` | the same | `uninstalled` |
| `company.suspended` | refuses what was issued for the tenant before | — |
| `app.installed` | — | `enabled` |

Then the app's own handler for that kind runs (`auth.clegra.events`).

**Registration.** The core proves an app's URL is the app's before it trusts
it: it gives a registration id and a challenge, and reads back
`GET /.well-known/clegra-app.json` = `{ registration_id, challenge, resource,
issuer }`, which the SDK serves from `registrationId` and `challenge`.
Registering is what gives the app its registration id, so these two public
documents are served before the production configuration is checked, whatever
it lacks: the manifest (`GET /.well-known/clegra.json`, read first) and the
registration document (`404 not_configured` until `registrationId` and
`challenge` are set). Neither carries or accepts a token. Everything else (MCP,
events, views, the site's exchange, `health`, the OAuth metadata) answers `500
misconfigured` until the app is configured. The order is: deploy with
`auth.clegra` (issuer, resource), add the app by its URL at the core, set the
registration id, challenge and allowed companies it hands out, redeploy, and
let the core read the registration document back.

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
- A token of Clegra's core (or of the development authority) is never handed
  to `auth.resolve`.
- The protected-resource metadata names the app's authorization server
  (`auth.authorizationServers`). Paths the authorization server needs outside
  its own mount (RFC 8414 metadata under `/.well-known/`) MAY be answered by
  the same routes (`auth.serve`).
- `auth.resource` is required with `clegra`, and in production with
  `resolve`: without it every request but the manifest and the registration
  document fails with a clear `500 misconfigured`,
  never with an address guessed from request headers.
- The protected-resource metadata keeps naming the app's own authorization
  server with `auth.clegra` too: Clegra's core is never one (its tokens come
  from Clegra, not by OAuth).

**Permissions and visibility**

- Entity, action, page, artifact and field permissions are checked on every call.
- A field the caller may not see is absent from rows, records, cards, filters
  and sorts, and text search looks only in the search fields the caller may
  see (handlers receive them as `textFields`).
- What is hidden from plain clients (`plain: false`) is hidden from them
  everywhere: its tools are not listed, and `fetch`, the resolver, reference
  titles, dashboards and record actions answer `no-access` for it.

**Confirmation** of a write whose `confirm` is `always` (a sensitive tool):

- **an agent with a Clegra token** (`act`: delegated, automation, device
  agent) carries, in `_meta.clegra.confirmation`, `{ token, proof }`:
  - `token`: the core's confirmation token, minted for the person's device
    (which asked the core with its own account token): `typ:
    clegra-confirmation+jwt`, signed with an `app` key, `aud` the app's
    resource, `sub` the caller's pairwise `sub`, `company` the caller's,
    `tool`, `args_sha256` (the base64url SHA-256 of the canonical JSON of the
    arguments as sent, as below), `cnf.jkt` the device's key, `jti` used once,
    10 minutes at most;
  - `proof`: signed by that device key: `typ:
    clegra-confirmation-proof+jwt`, its public `jwk` in the header (its
    thumbprint the token's `cnf.jkt`), claims `{ cth, iat, jti }`, `cth` the
    base64url SHA-256 of the confirmation token, `iat` within 60 seconds, `jti`
    used once;
  - the device must be the caller's person's: a delegated token's
    `person_jkt`, a device agent's own key. Without both, or with another
    tool, other arguments, another app, person or company, a used one, or a
    proof by another key, the call fails with `confirmation_required`. A
    server can't make one: it has neither the person's account token nor
    their device key;
- **the person from a Clegra client** (a Clegra token without `act`): the UI
  that sends the call asks the person first (the app's own view, or the client
  drawing the app's form from the manifest) and sends
  `_meta.clegra.confirmed: true`. Without it the call fails with
  `confirmation_required` and `error.confirm` (below), for the UI to ask and
  send again. The call is bound to the person's device key (DPoP), which no
  agent holds;
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

A Clegra token, in the trusted-issuer mode, is verified as «Clegra tokens»
says (above). Clocks may differ by 30 seconds. Opaque tokens are not accepted
in this mode.

## 8. Conformance

[`spec`](../spec) checks any app from outside,
over HTTP, whatever it is built with:

```sh
npx @clegra/sdk check https://crm.example.com --token <a plain caller's bearer>
```

An app in the trusted-issuer mode (§7, «Clegra tokens») is checked as a
Clegra caller instead, from code: `checkApp({ url, clegra: { token, proof,
confirmation? } })`, the token of Clegra's core sent as `Authorization: DPoP`
with a proof per request (`htu` the app's resource, once more with the app's
`DPoP-Nonce`). `@clegra/sdk/testing`'s `testCore` and `deviceKey` make one for
tests; Clegra's store review signs its own. A Clegra caller sees what is hidden
from plain clients (`plain: false`), so `mcp.tools` doesn't count those as
leaks.

| Check | Passes when |
|---|---|
| `manifest.served` | `GET /.well-known/clegra.json` answers 200 with JSON |
| `manifest.schema` | the manifest validates against the JSON Schema |
| `manifest.references` | names refer to things the manifest declares; tool names are unique and valid, none reserved; the publisher is well-formed (§2); navigation, page actions, badges, app-only items, targets, `later`, schedules and notification types meet their rules (§4.1, §4.2, §5.2, §6 rule 11, §11, §12) |
| `auth.mcp` | without a token the endpoint answers 401 and points to protected-resource metadata, whose `resource` is the address the app was reached at (or the manifest's `auth.resource`) and which names an authorization server; an app that trusts only Clegra's core (it declares `events` and no `auth.authorizationServers`) may name none |
| `mcp.initialize` | `initialize` succeeds with no extension |
| `mcp.tools` | tools match the manifest: names, `readOnlyHint`, `destructiveHint`; nothing hidden is listed |
| `mcp.deterministic` | `tools/list` is the same on every call |
| `mcp.sort` | a list tool offers to sort only by fields the manifest declares sortable, and refuses any other key |
| `mcp.views` | every view a tool names is served as an MCP Apps document |
| `mcp.titles` | each row of a list's text carries its `uri` and `title`, and the record's text from its get tool the same title; every action tool on a record takes a required string `id` and an optional string `record_title` |
| `mcp.app-callable` | the tools a view calls (lists, records, actions, pages) don't leave `"app"` out of `_meta.ui.visibility` |
| `mcp.visibility` | the tools of app-only entities, actions and artifacts carry `_meta.ui.visibility: ["app"]`, without `"model"`; `search` finds no record of an app-only entity |
| `lifecycle.hidden` | `clegra_later`, `clegra_installation`, `clegra_export` and `clegra_delete` are not listed to a plain caller or a person |
| `mcp.confirm` | (a Clegra caller) a `confirm: "always"` write called without a confirmation answers `confirmation_required` and runs nothing; with an agent's caller that can get the core's confirmations (`confirmation`), one of other arguments is refused too and one of the call's own arguments, with the device's proof, is taken (the write runs once: check a test installation). Called with sample arguments (each required input from its schema, an action on a record with the first listed record); a write they don't fit is not counted |
| `mcp.manifest` | the manifest is one MCP resource, identical to the file |
| `kinds.known` | every unprefixed kind is in `kinds.json` for the `specVersion`; every dotted kind is well-formed |
| `kinds.properties` | every `as` belongs to the entity's kind (or is universal) with a matching type; single-valued properties appear once; required ones exist; keys are filters; `kinds` definitions are well-formed |
| `kinds.keys` | listing with a key value taken from a returned record, in another letter case where case doesn't count, returns that record and only records holding that value |
| `kinds.values` | sampled records: `email`, `vatID`, `gtin`, dates, `address` and numbers have the stated form |
| `kinds.tools` | entity tools carry the kind in the description and in `_meta.clegra`; `search` offers `kind`, keeps to it, and names each result's kind |
| `refs.cross` | a `ref: { kind }` field's values are record URIs; its text form is `{ uri, kind }`; no `refs` title is sent for it; such an action input is a string |
| `resolve.foreign` | the resolver answers `not_found` for another app's URI |
| `site.frame-ancestors` | (public) an app with a `site`: `GET /clegra/site` is refused (a ticket is only ever posted) with `frame-ancestors 'none'`, no cookie, no `X-Frame-Options` |
| `site.ticket` | (a person's Clegra app token and one of the app's client origins, `clegra.clientOrigin`) a ticket is a ≤ 60 s JWT with a `jti` naming the framing origin, for the site's start by default; another origin or a path off the site gets none; posted from another `Origin`, a second time, or by a top-level page it is refused; posted right it answers 303 to the path with `Referrer-Policy: no-referrer` and the session and marker cookies, each `Secure; HttpOnly; SameSite=None; Partitioned; Path=/`, no `Domain` |

The `kinds.*` checks are skipped, not failed, for an app that declares no
kinds (and `kinds.keys` when no listed record holds a key value to try);
`refs.cross` for an app without references to other apps; the `site.*`
checks for an app without a site (`site.ticket` also without a Clegra caller and its client origin); `mcp.visibility` for an app
without app-only items; `lifecycle.hidden` for an app without lifecycle tools
or later runs; `mcp.confirm` for a plain caller and for an app without
sensitive writes listed to the caller.

An app is conformant when every check passes with a token (a plain caller's,
or a Clegra caller's for an app that trusts only Clegra's core). Without a token
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
   Clegra's core issues no token without a person: with Clegra the lifecycle
   reaches an app as signed events (§7, «Events»), and an app runs its own
   cron (draft 1.0: how a Clegra deployment runs an app's schedules, later
   runs and its export or delete through the core is still open).
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
