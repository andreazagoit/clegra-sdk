# AI guide: building a Clegra app

> For coding agents. This one file is enough to write a correct app.
> A Clegra app is an app that Clegra draws natively and that is also a plain MCP server for ChatGPT, Claude and any
> MCP client. One package, `@clegra/sdk` (and, for an app's own UI, `@clegra/ui`); normative text in [spec.md](spec.md).

## The model

You write the app **one thing per file**: each `defineEntity`, `defineAction`, `defineArtifact`, `defineComponent`,
`definePage` and `defineAgent` returns a handle, and one thing names another by its imported handle (`on: deal`,
`list: deal`, `actions: [markWon]`), never by a string. `defineApp({ … })` in `clegra/app.ts` assembles the handles:
pure, checked at once, nothing served. `serve(app, { auth, store, … })` in `clegra/index.ts` runs it. The SDK turns it
into (a) a JSON manifest at `/.well-known/clegra.json` that Clegra (the workspace host) draws natively, (b) a plain
MCP server at `/mcp` with tools and MCP Apps views for ChatGPT, Claude and any MCP client, and (c) an OpenAPI 3.1
index at `/openapi.json` whose operations are callable as `POST /operations/<tool>`. Permissions, field visibility,
confirmations and idempotency are enforced by the SDK before your handlers run. There is no other authoring API.

## The package

| Import | What |
|---|---|
| `@clegra/sdk` | `defineEntity`, `defineAction`, `defineArtifact`, `defineComponent`, `definePage`, `defineAgent`, `defineApp`, `serve`, `AppError`, `AuthError`, `ref`, `SqlStore`, `MemoryStore`, types. Web APIs only: `served.fetch(request)` runs anywhere |
| `@clegra/sdk/signin` | `createSignIn` (the app's own OAuth server on its login), `passwordLogin`, `SqlSignInStore`, `newSignInKey`; `devSignIn` for local work and tests |
| `@clegra/sdk/next` | `toNextHandlers(served)` (the route), `withClegra(config)` (next.config), `siteProxy(served)`, `<ClegraSite />` |
| `@clegra/sdk/node` | `listen(served, { port })`: Node's own HTTP server; `toNodeHandler(served)` |
| `@clegra/sdk/express` | `clegraMiddleware(served)`: `app.use(…)` in an Express app |
| `@clegra/sdk/testing` | `testClient(served, …)`; `installationClient(served, …)` (schedules, later runs, lifecycle) |
| `@clegra/sdk/spec` | `checkApp`, `formatReport`: the conformance checks |
| CLI | `npx @clegra/sdk init` (makes a Next.js app a Clegra app), `npx @clegra/sdk check <url> --token <bearer>` |

## The files

```text
clegra/
  entities/deal.ts       export const deal = defineEntity({ name: "deal", … })
  actions/mark-won.ts    export const markWon = defineAction({ name: "mark_won", on: deal, … })
  artifacts/total.ts     export const pipelineTotal = defineArtifact({ name: "pipeline_total", … })
  pages/deals.ts         export const dealsPage = definePage({ name: "deals", list: deal, … })
  agents/sales.ts        export const sales = defineAgent({ name: "sales", uses: [deal, markWon], … })
  app.ts                 export const app = defineApp({ …, entities: [deal], actions: [markWon], … })
  index.ts               export const served = serve(app, { auth, store, people, site, clientOrigins })
```

In a Next.js app (App Router) `npx @clegra/sdk init` writes them (a sample entity, action and page); the route and
next.config are:

```ts
// app/api/clegra/[...path]/route.ts
import { toNextHandlers } from "@clegra/sdk/next"
import { served } from "@/clegra"
export const { GET, POST, DELETE, OPTIONS } = toNextHandlers(served)

// next.config.ts: rewrites /mcp, /.well-known/clegra.json, /openapi.json, /operations/…, /oauth/… and the OAuth metadata paths to that route
import { withClegra } from "@clegra/sdk/next"
export default withClegra(nextConfig)
```

- Under Next: never serve's `path` (the mount does that job); `basePath` and `trailingSlash: true` are refused too.
  The development sign-in's login works there, but its development tokens never count (no peer address).
- Locally, before the sign-in is wired: init's `resolve` accepts the bearer in `.env.local` (`CLEGRA_LOCAL_TOKEN`)
  only when `NODE_ENV !== "production"`.
- In production: `CLEGRA_PUBLIC_URL` (an origin) and `auth.resource = ${CLEGRA_PUBLIC_URL}/mcp` (with `resolve`; the
  sign-in module's `resource` otherwise), or every request but the manifest answers `500 misconfigured`. Serve with
  `store: new SqlStore(query)` on serverless.
- The app's handlers call the same functions its pages use. Data access is yours (any DB or ORM), and so is auth:
  the sign-in module over your login, or `auth.resolve` for your own OAuth server's tokens ([auth.md](auth.md)).

## The whole shape

```ts
// clegra/entities/deal.ts
import { defineEntity, ref } from "@clegra/sdk"
import { z } from "zod"

export const deal = defineEntity({
  name: "deal",                      // [a-z][a-z0-9_]*: tools deal_list, deal_get
  label: "Deal", plural: "Deals", description: "…", icon: "briefcase",    // any label: a string, or { en: "…", it: "…" }; icon: a lucide name
  schema: z.object({
    id: z.string(),                                                        // required
    name: z.string().meta({ role: "title", label: "Name", search: true }), // exactly one role: "title"
    company: ref("company").meta({ label: "Company", filter: true }),      // id of a record of this app's entity "company" (by name)
    stage: z.enum(["open", "won", "lost"]).meta({ role: "status", label: "Stage", filter: true,
      labels: { open: "Open", won: "Won", lost: "Lost" }, tones: { won: "success", lost: "danger" } }),
    value: z.number().meta({ role: "amount", currency: "EUR", label: "Value", sort: true, permission: "deals.values" }),
    closeDate: z.string().meta({ role: "date", label: "Close date", sort: true, filter: true }),
    owner: z.string().meta({ role: "person", label: "Owner" }),     // a person id: name it with serve's `people`
    note: z.string().optional().meta({ label: "Note", untrusted: true }),  // text written by outsiders
  }),
  permission: "deals.view",                                // optional: who sees the entity at all
  get: (id, ctx) => db.deal(ctx.installation, id),         // the row or null
  list: (query, ctx) => db.deals(ctx.installation, query), // { rows, next?, total? }; search query.text only in query.textFields
  record: { fields: ["stage", "value", "closeDate"] },     // optional: the record template's key fields (1–6)
  expose: { plain: true, list: "deal_list", get: "deal_get" },   // optional
  view: { html: "<!doctype html>…" },                      // optional: your own record view
})
```

```ts
// clegra/actions/mark-won.ts
import { AppError, defineAction } from "@clegra/sdk"
import { z } from "zod"
import { deal } from "../entities/deal"

export const markWon = defineAction({
  name: "mark_won",
  on: deal,                          // record action: tool deal_mark_won takes { id, …input }
  featured: true,                    // optional: on the record template (needs the entity's `record`), up to 3
  title: "Mark as won", description: "…", icon: "trophy",
  input: z.object({ note: z.string().optional() }),        // REQUIRED key; z.object({}) for none; never declare `id`
  confirm: true,                     // true|"always" (default for writes) | "optional" | false|"never"
  permission: "deals.edit",
  expose: { tool: "deal_mark_won" },                       // optional; plain: false keeps a write for your own views
  run: (input, ctx, record) => {     // record is typed from deal's schema
    if (record.stage !== "open") throw new AppError("conflict", "Already closed.")
    return { message: "Marked as won.", record: record.id }  // all optional: message, record (id or URI), data
  },
})

// clegra/actions/create-deal.ts: no `on`: global; run gets (input, ctx)
export const createDeal = defineAction({
  name: "create_deal",
  title: "New deal",
  input: z.object({ name: z.string(), company: ref("company") }),
  run: (input, ctx) => ({ record: ctx.uri(deal, db.create(ctx.installation, input)) }),
})
// «+ Nuovo»: a global write with no required input and confirm: false, marked creates: deal (or { of: deal, title })
export const stats = defineAction({ name: "stats", title: "Stats", input: z.object({}), readOnly: true, run: () => ({ data: { n: 1 } }) })   // a read: no confirmation
```

```ts
// clegra/components/stage-funnel.ts: your own A2UI component (spec §5.4): a page of yours (MCP Apps HTML) drawing
// props the host sends. Name: [A-Z][A-Za-z0-9]*, never a Basic Catalog name (Card, Text, List…) or Chart.
export const stageFunnel = defineComponent({ name: "StageFunnel", title: "Stage funnel", props: z.object({ stages: z.array(z.object({ label: z.string(), count: z.number() })) }), view: { html: funnelHtml } })

// clegra/artifacts/pipeline-total.ts
export const pipelineTotal = defineArtifact({
  name: "pipeline_total",            // tool show_pipeline_total
  title: "Open pipeline", description: "Total value of open deals", icon: "sigma",
  params: z.object({}),              // REQUIRED key
  permission: "deals.values",
  template: "stat",                  // card | stat | list | chart  (or component: stageFunnel, or no template and `view`)
  data: (params, ctx) => ({ label: "open", value: 36500, format: "money", currency: "EUR" }),   // or null: not available
  actions: [createDeal],             // optional: global actions shown inside, by handle
  size: "small",                     // small | medium | large
  widget: true,                      // optional: offered as a Home widget ({ sizes, size } to choose)
  // view: { html }                  // optional: your own view instead of the generated one
})
```

```ts
// clegra/pages/*.ts: each page is ONE of: list, record, dashboard, view
export const dealsPage = definePage({ name: "deals", title: "Deals", icon: "briefcase", list: deal, columns: ["name", "stage", "value"], actions: [createDeal], badge: openDeals })
export const dealPage = definePage({ name: "deal", record: deal, sections: [{ title: "Deal", fields: ["name", "stage", "value"] }] })   // optional: every entity has a default record page
export const pipelinePage = definePage({ name: "pipeline", title: "Pipeline", dashboard: [{ artifact: pipelineTotal, size: "small" }, { artifact: deal, params: { id: "d1" } }] })   // an entity: its record card
export const forecastPage = definePage({ name: "forecast", title: "Forecast", permission: "deals.values", view: { html: () => loadHtml() } })   // your MCP Apps document

// clegra/agents/sales.ts
export const sales = defineAgent({ name: "sales", title: "Sales assistant", description: "…", instructions: "…",
  uses: [deal, markWon, "search"],   // entities (their reads), actions, or tool names
  tier: "fast",                      // fast | standard (default) | strong
  starters: ["Which deals close this month?"] })
```

```ts
// clegra/app.ts: pure, checked at once
export const app = defineApp({
  name: "crm",                       // app id: [a-z][a-z0-9-]{1,39}
  title: "CRM",
  version: "1.0.0",
  description: "…",                  // optional
  icons: [{ src: "https://…/icon.png", sizes: ["128x128"], mimeType: "image/png" }], // optional
  publisher: { name: "Example Software Ltd", url: "https://example.com" }, // optional: a claim (https); a store may verify it by the domain
  accent: "teal",                    // optional: one name of the palette (APP_ACCENTS)
  locale: "en",                      // language of bare strings and of tool names/descriptions (default "en")
  instructions: "…",                 // optional: MCP instructions for models
  permissions: {                     // ids are "group.verb"
    "deals.view": { label: "See deals", default: true },
    "deals.edit": { label: "Change deals", default: true },
    "deals.values": { label: "See values", description: "…" },    // default false
  },
  settings: {                        // set per installation by an administrator; read as ctx.settings.<id>
    follow_up_days: { label: "Follow-up (days)", type: "number", default: 7 },   // text | number | boolean. Never secrets
  },
  entities: [deal /* , company: every ref("…") names an entity of this app */],
  actions: [markWon, createDeal, stats],
  components: [stageFunnel],
  artifacts: [pipelineTotal, openDeals],
  pages: [dealsPage, dealPage, pipelinePage, forecastPage],
  agents: [sales],
})
```

```ts
// clegra/index.ts: how it runs
export const served = serve(app, {
  auth: {
    signIn,                          // createSignIn(app, { … }) of @clegra/sdk/signin: the SDK's OAuth server on your login; or devSignIn(app) locally
    // or, for your own OAuth server's tokens:
    // resource: "https://crm.example.com/mcp", resolve: async (token, request, { resource }) => ({ installation, person, permissions }) | null,
    // authorizationServers: ["https://crm.example.com/api/auth"], serve: async (request) => null (its RFC 8414 metadata at the root)
    // public: { installation: "public" } → calls without a token reach the actions declared public: true
  },
  store: new SqlStore(query),        // optional: idempotency, one-time ids, later runs in your Postgres (serverless, several instances)
  people: (ids, ctx) => db.names(ctx.installation, ids),   // optional: { [id]: name } for role "person" fields
  site: { start: "/" }, clientOrigins: ["https://app.clegra.com"],   // optional: your own site in Clegra's frame (spec §5.1)
  path: "/api/clegra",               // optional, never under Next: where MCP lives (default /mcp at the root)
  mcp: (server, caller) => {},       // optional: the raw McpServer (official SDK) of each request; caller is null before sign-in
})
```

Template data: `card { title, subtitle?, status?, fields: [{ label, value }], uri? }` ·
`stat { label, value, format?: number|money|percent, currency?, hint? }` ·
`list { items: [{ title, subtitle?, status?, uri? }] }` ·
`chart { kind: bar|line|pie, points: [{ label, value }], format?, currency? }`.

`query` given to `list`: `{ filters: { field: value | { in: [...] } | { gte?, lte? } }, text?, sort?: { field, dir }, cursor?, limit }`.
`sort` is already checked (a `sort: true` field the caller may see): apply it, or the sortable headers do nothing.

An action's `input` is its form: `ref("entity")` becomes a picker, `.meta({ label, currency, labels })` the words,
required/min/max/date are checked before sending, and an input the schema refuses comes back per field
(`error.fields`). Views add no confirmation of their own: confirming is the host's (annotations, elicitation, its
own «Confirm» before it sends the call).

An action on a record (`on: deal`) is listed with `id` and an optional `record_title` that the SDK adds (don't
declare either in `input`): the model passes the record's title so a client's own approval prompt names it
(«Mark Hartley Engineering as won», not «d1»). Your handler never sees `record_title`; the SDK refuses a call whose
hint names another record, and every confirmation the SDK words names the record from its id. Name the record in
your `message` yourself (`${record.name} marked as won.`).

`people: (ids, ctx) => ({ [id]: name })` (optional, in `serve`): the names of the people `role: "person"` fields
hold. Hosts and models then see names (the caller's own comes from the token); an id it can't name shows as an
unknown person, never as the id. Without it a person field must hold the name itself.

Labels given as `{ en, it }` maps reach the generated view in every locale: it draws them in the reader's language
(`hostContext.locale`), else English. Give every label in each language you support.

`ctx`: `app`, `installation`, `person` (`{ id, name }` or null), `permissions`,
`can(p)`, `locale` (the caller's language), `host` (`"workspace" | "plain"`), `admin`, `settings`, `call`,
`schedule` (the schedule this call is a run of, else null), `later` (in a later run: `{ id, at, until, confirmedAt }`,
else null), `cancelLater(id)`, `rateLimit(name, { max, seconds, per? })`, `t(label)`, `notify({ type?, title, body?,
uri?, to? })` (`to`: person ids or `"admins"`), `uri(entity, id)` (an entity handle or name), `changed(...)`.

`AppError(code, message)` codes: `permission_denied`, `not_found`,
`invalid_input`, `confirmation_required`, `conflict`, `rate_limited`, `internal`, `unauthorized`.

What `defineApp` returns (`app`): `manifest()` (as defined: no auth, no site), `uri()`, `artifactUri()`,
`parseUri()`. What `serve` returns (`served`): `manifest()` (the one hosts read), `openapi()`, `fetch(request,
{ remoteAddress? })` (Fetch API handler), `start()`, `dev` (the development sign-in's tools, or null), `uri()`,
`runLater(tenant, { settings?, locale? })`, `site`. On Node alone: `listen(served, { port, host })` from
`@clegra/sdk/node`.

## Kinds: the same kind of thing across apps (optional)

Say what an entity is only when other apps may hold the same thing: people, companies, events, tasks,
documents, products, orders. Leave your own records (deals, tickets, quote lines) without a kind.

```ts
export const contact = defineEntity({
  name: "contact",
  label: "Contact",
  kind: "person",                 // person | organization | event | task | document | product | order | "com.example.thing"
  schema: z.object({
    id: z.string(),
    name: z.string().meta({ role: "title", search: true }),          // the title is the kind's name: no `as`
    email: z.string().meta({ as: "email", filter: true }),           // a KEY of person: needs filter: true
    phone: z.string().optional().meta({ as: "telephone" }),
    company: ref("company").meta({ as: "worksFor", filter: true }),
    erpAccount: ref.kind("organization").optional(),                 // a record of ANY app: its URI, clegra://erp/customer/42
    lastNote: z.string().optional(),                                 // your own field: no `as`
  }),
  get, list,
})
export const customer = defineEntity({ name: "customer", kind: { by: "type", map: { company: "organization", private: "person" } }, … })   // one kind per record: `type` a required enum
```

- Properties (schema.org names, verbatim): person `givenName familyName email† telephone† jobTitle worksFor address
  image`; organization `legalName email† telephone† url address vatID taxID`; event `startDate`(required) `endDate
  location attendee† organizer uid`; task `due startDate completed assignee`; document `url encodingFormat author
  contentSize`; product `sku gtin brand price`; order `orderNumber orderDate customer totalPrice`. † many: an array
  field, or several fields. Any entity may mark `url`, `dateCreated`, `dateModified`. Full list: `spec/kinds.json`.
- Types: dates are RFC 3339 strings; `price`/`totalPrice` need `currency` on the field; `vatID` is `GB123456789`
  (prefix, no spaces); `gtin` 8/12/13/14 digits; `address` a string or a PostalAddress object.
- **Keys** (`email`, `vatID`, `gtin`, `uid`) are exact filters. Your `list` gets the value already normalised
  (email lower-cased, vatID upper-cased without spaces, gtin digits): compare it with the normalised column
  (`lower(email) = $1`), never with `ILIKE` or a prefix. A row that doesn't hold the value fails the call.
- `ref.kind(kind)`: store the URI only, never a title; the host names it for each viewer. Any valid record URI is
  accepted; your app never calls the other app. Models read it as `{ uri, kind }`.
- `defineApp` throws on: an unknown kind, an `as` not in the kind, a wrong type, a single-valued property on two
  fields, a missing required property, a key without `filter`.
- Where kinds add nothing: a workspace with one app per kind, your own domain records, and creating records
  ("new contact" still needs a choice of app). Models already read `contact` as a person; the gain is the
  deterministic part — which field is the email, which filter is exact.

## Navigation, page actions, schedules, notifications, later runs, lifecycle (optional)

All optional; an app without them is unchanged. Handles are checked by TypeScript and again by `defineApp`.

```ts
// …entities (task, with a "project" field), permissions "tasks.view" and "tasks.edit"; each action in its file:
export const addTask = defineAction({   // a global action, offered on the tasks page (below)
  name: "add_task",
  title: "New task",
  input: z.object({ title: z.string(), project: z.string().optional() }),   // the page's param `project` prefills it
  permission: "tasks.edit",
  run: (input, ctx) => ({ record: ctx.uri(task, db.add(ctx.installation, input)) }),
})
export const taskFromEmail = defineAction({   // offered by the host on an email and on another app's organization
  name: "task_from_email",
  title: "Task from this",
  input: z.object({ title: z.string(), source: z.string() }),
  targets: [
    { target: "mail.message", needs: ["subject"], input: { title: "{subject}", source: "{uri}" } },
    { target: "record:organization", needs: ["vatID"], input: { title: "Call {title} ({vatID})", source: "{uri}" }, label: "New task" },
  ],
  run: (input, ctx) => ({ record: ctx.uri(task, db.add(ctx.installation, input)) }),
})
export const sendDigest = defineAction({   // run by a schedule: input accepts {}, not confirm "always"
  name: "send_digest",
  title: "Send the digest",
  input: z.object({}),
  confirm: "never",
  run: (_input, ctx) => {
    // ctx.person is null here (the installation runs it): say `to`
    ctx.notify({ type: "digest", title: "3 tasks are due today", to: "admins" })
    return { message: "Sent." }
  },
})
export const publish = defineAction({   // «approve now, act later»
  name: "publish",
  title: "Publish",
  input: z.object({ text: z.string(), when: z.iso.datetime() }),   // `at` names a required date-time input
  later: { at: "when", window: 60 },                               // a write with confirm "always" (the default); window 10–10080 minutes
  run: (input, ctx) => {
    // runs at `when` as the person who confirmed it: ctx.person, ctx.later = { id, at, until, confirmedAt }
    return { message: "Published." }
  },
})
export const reindex = defineAction({ name: "reindex", title: "Reindex", input: z.object({}), confirm: "never", visibility: "app", run: () => ({}) })  // views and the host's UI only, never a model
export const openCount = defineArtifact({ name: "open_count", title: "Open tasks", description: "How many are open", params: z.object({}), template: "stat",
  data: (_p, ctx) => ({ label: "open", value: db.openCount(ctx.installation) }) })   // a badge: stat, no required params
export const tasksPage = definePage({ name: "tasks", title: "Tasks", list: task, columns: ["title"], actions: [addTask], badge: openCount })   // first action = primary; at most 8
export const boardPage = definePage({ name: "board", title: "Board", dashboard: [{ artifact: openCount }] })

export const app = defineApp({
  // …name, permissions, entities: [task]…
  actions: [addTask, taskFromEmail, sendDigest, publish, reindex],
  artifacts: [openCount],
  pages: [tasksPage, boardPage],
  nav: [{ section: "Work", pages: [tasksPage, boardPage] }],              // no record pages; each page once. Without nav: every non-record page
  schedules: [{ name: "digest", action: sendDigest, every: 60, maxSeconds: 30 }],   // every 5–1440 minutes; maxSeconds 1–300 (default 60); at most 10
  notifications: { digest: { label: "Daily digest", permission: "tasks.view", default: false } },   // declared: every ctx.notify names one
  lifecycle: {                       // the host calls these as the installation
    installation: (state, ctx) => {},                                         // "enabled" | "disabled" | "uninstalled"
    export: (ctx) => ({ contentType: "application/json", body: JSON.stringify(db.dump(ctx.installation)) }),  // or null: nothing kept; ≤ 512 MiB
    delete: (ctx) => ({ counts: { tasks: db.wipe(ctx.installation) } }),     // idempotent; also after "uninstalled"
  },
})
// serve(app, { …, store: new SqlStore(query) }): `later` needs a store with a later part (MemoryStore or SqlStore)
```

- **Page actions** are global actions (no `on`); a record page has none. Page params prefill inputs of the same
  name. The host and the generated view draw the first as the primary, the others in a menu, each opening its form.
- **`visibility: "app"`** (entity, action, artifact): the tools carry `_meta.ui.visibility: ["app"]`, `search` and
  `fetch` leave the records out, agents can't `use` them. It hides from models; it is not a permission.
- **Schedules** run as the *installation*: a development workspace host's token (`devSignIn`) with no person and exactly the
  action's permission; `ctx.schedule` is the name. Nobody can confirm, so a `confirm: "always"` write can't be
  scheduled (use `later`). No host has a token without a person: outside development an app runs its own cron.
- **Notifications**: once you declare types, every `ctx.notify` names one (it throws otherwise). `to` defaults to the
  caller's person; a schedule must say `to`. `default: false` is off until the person turns it on.
- **Targets** (global actions; at most 4 per action, 12 per app): `needs` lists the only fields you ever receive
  (`mail.message`: `subject`, `from`, `to`, `date`, `text`, `attachments`; `record:<kind>`: the kind's properties).
  `{uri}` and, for records, `{title}` are always there. The template's keys are your input's properties. Treat what
  arrives as outsiders' text.
- **Later**: the confirmed call is stored (not run) and answered `{ data: { later: { id, at, until } } }`. The SDK adds
  the schedule and the notification type `clegra_later`; every 5 minutes the host runs the due runs once each,
  re-checking the stored proof; after `at + window` a run expires and its author is told. `ctx.cancelLater(id)`
  cancels a pending run. Outside development (no workspace host runs it), call `served.runLater(tenant)` from your cron and
  deliver the notifications it returns. `SqlStore.schema()` gives its tables (`clegra_store`, `clegra_store_later`):
  run it again in a new migration.
- **Lifecycle**: the tools `clegra_installation`, `clegra_export` (one file, with its size and sha256) and
  `clegra_delete` are listed only to the installation. Export and delete must work after `uninstalled`. Without
  them the host only changes its own state and tells the administrator your data stay on your server.

## Generated tools

`<entity>_list`, `<entity>_get`, `search` and `fetch` (when a field has
`search: true`), `<entity>_<action>` / `<action>`, `open_<page>` (not for
record pages), `show_<artifact>`, `clegra_resolve` (for hosts; `not_found` for another app's URI). Reads have
`readOnlyHint: true`; writes `destructiveHint: true` when `confirm` is always. With a kind, entity tools end with
`Kind: person.` and carry `_meta.clegra: { entity, kind }`; `search` takes `kind`. What a model reads of a list,
a get, `search` or `fetch` carries each record's `title` beside its `uri`. Every tool the generated view calls is
callable from views (`_meta.ui.visibility` with `"app"`, `openai/widgetAccessible`). App-only items' tools carry
`["app"]` alone. Only for the installation (a development workspace host's token with no person): `clegra_later`
(when an action has `later`) and the lifecycle tools. The same tools a plain client may call are the OpenAPI index's
operations (`/openapi.json`, `POST /operations/<tool>`; no `clegra_*` tool there).

The generated view (ChatGPT, Claude, any MCP Apps host): rows open their record, «‹ back» returns, a record's
actions run from it; progress, results and refusals appear in a status line at the top. It talks the MCP Apps bridge
(ChatGPT included) and tells the model about a change made in it (`ui/update-model-context`). A custom view you
write: finish `ui/initialize` before any `tools/call`, and draw the opening result once (hosts repeat
`ui/notifications/tool-result` for your own calls, and ChatGPT's `openai:set_globals` fires on every layout or theme
change).

## Rules

1. Scope **every** read and write by `ctx.installation`. Never keep global data.
2. Never check permissions or strip fields yourself for what you declared: declare `permission` on the entity, field, action, page or artifact and the SDK enforces it. Use `ctx.can()` only for finer rules inside a handler.
3. Every entity schema has a string `id` and exactly one `role: "title"`; at most one field per role.
4. `input` and `params` are always present (`z.object({})`); omitting one breaks type inference.
5. Writes confirm by default. Don't set `confirm: false` on anything a person would want to see first.
6. Mark text that comes from outside (names typed into a form, emails, customer notes) `untrusted: true`, on the field; on an artifact whose data carry such text, `untrusted: true` on the artifact.
7. Return short `message`s in the caller's language: `ctx.t({ en: "…", it: "…" })`.
8. Names (the `name` of each entity, action, artifact, page and agent) are `[a-z][a-z0-9_]*`; components' are `[A-Z][A-Za-z0-9]*`. Entities and artifacts share one namespace. Every handle you name must be in `defineApp`'s lists. Don't name a filter/sort field `query`, `sort`, `dir`, `cursor` or `limit`.
9. A list page with `params` also needs `query: (params) => ({ filters, text, sort })`.
10. The development sign-in (`auth: { signIn: devSignIn(app) }`) is for local work and tests only: refused when `NODE_ENV=production`; its development tokens and proofs count only from callers on a loopback address (never under Next). In production give `auth.resource`: your server's public MCP address, the only audience tokens are accepted for. In `resolve`, check signature, expiry, issuer and `aud === resource` (a single audience); return null or throw `AuthError` to refuse.
11. `ctx.installation` is the tenant: what `auth.resolve` said (your organization id), or the account's `installation` with the sign-in module. Use it as an opaque key; never take a tenant from a parameter. Permissions are what your sign-in says (`permissionsOf`, read live), narrowed to what the person consented to for that client; `ctx.admin` is your `resolve`'s `admin`.
12. In `list`, search `query.text` only in `query.textFields`; in an artifact's `data`, leave out values the caller may not see (`ctx.can`): template data are yours, the SDK only drops items whose `uri` is out of the caller's reach.
13. Your data access is yours (any DB/ORM). Your app's own website is shown in Clegra as it is (spec §5.1): `serve(app, { site: { start: "/" }, clientOrigins: [Clegra's client origins] })`, `proxy.ts` = `export const proxy = siteProxy(served); export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] }`, `<ClegraSite />` in the root layout. The person signs in with your own sign-in inside the frame: your session cookie must be `Secure; SameSite=None; Partitioned` over https (`frameCookie`).

## Common mistakes

| Mistake | Fix |
|---|---|
| Calling `registerEntity` / `new …Server` | They are not public. Only the `define*` functions, `defineApp` and `serve` |
| `on: "deal"`, `list: "deal"`, `actions: ["add"]`, `{ type: "x" }` in a dashboard | Handles: `on: deal`, `list: deal`, `actions: [add]`, `{ artifact: x }` |
| `entities: { deal: {…} }` in `defineApp` | Lists of handles: `entities: [deal]`; each thing in its own file with its `name` |
| `auth`, `store`, `people`, `site` in `defineApp` | They are how it runs: `serve(app, { auth, store, people, site, clientOrigins })` |
| An action without `input` | `input: z.object({})` |
| Declaring `id` in a record action's input | The SDK adds it |
| A record action `featured` on an entity without `record` | Give the entity `record: { fields }` |
| A permission used but not declared | Add it under `permissions`; `defineApp` throws at start otherwise |
| Translating tool names per caller | Tool names and descriptions are fixed in the app's `locale`; only data labels follow the caller |
| Putting custom keys in `_meta` | Don't. Everything hosts need is in the manifest |
| `kind` on every entity "for symmetry" | Only for things other apps hold too; a deal has none |
| `as: "email"` on a notes field, or a key filter with `ILIKE` | `as` only for the real value; keys compared exactly on the normalised value |
| Keeping another app's title next to a `ref.kind` URI | Keep the URI only |
| `path` in a Next.js app, or `testClient` against a Next route | Next: no `path` (the route's mount does it); test with `testClient(serve(app, { auth: { signIn: devSignIn(app) } }))` |
| `aud` checked with "includes", or not at all, in `resolve` | Exactly one audience, equal to `resource` |
| The tenant taken from a tool argument or a header | From the verified token (or the database row it points to) only |
| A schedule on a `confirm: "always"` write | Nobody is there to confirm: `confirm: "optional"`/`"never"` if it may run alone, else `later` |
| `ctx.notify({ title })` in a schedule | Say `to` (person ids or `"admins"`); with declared types, also `type` |
| `later.at` on an optional input or a plain `z.string()` | A required `z.iso.datetime()` |
| `targets` on an action with `on` | Targets are for global actions; the record action already has its record |
| `visibility: "app"` to keep something from a client | It only keeps it from models; use `permission` or `expose: { plain: false }` |
| Naming a tool `clegra_later`, `clegra_export`, … | Reserved for the installation's own tools |

## Check your work

```ts
import { serve } from "@clegra/sdk"
import { devSignIn } from "@clegra/sdk/signin"
import { installationClient, testClient } from "@clegra/sdk/testing"
const served = serve(app, { auth: { signIn: devSignIn(app) } })        // development tokens and proofs: served.dev
const c = await testClient(served, { permissions: ["deals.edit"] })   // or "all"; host: "workspace"; person; installation; locale
await c.listTools(); await c.call("deal_list", {}); await c.readResource("ui://crm/view")
await (await testClient(served, { host: "workspace", permissions: "all" })).confirmed("deal_mark_won", { id: "d1" })

const host = await installationClient(served, { permissions: ["tasks.view"] })   // the installation: no person
await host.schedule("digest")                    // the schedule's tool, with _meta.clegra.schedule
await host.runLater()                            // clegra_later: the due later runs
const { file } = await host.exportData()         // clegra_export, the file read back (null: nothing kept)
await host.call("clegra_delete")
```

`npx @clegra/sdk check <url> --token <bearer>` must end with `Conformant.`
Complete, tested apps to copy from, one file per thing: the CRM ([`examples/crm/clegra/`](../examples/crm/clegra/app.ts),
Drizzle), the warehouse ([`examples/warehouse/clegra/`](../examples/warehouse/clegra/app.ts), plain SQL) and shipments
([`examples/shipments/src/clegra/`](../examples/shipments/src/clegra/app.ts), Node).
