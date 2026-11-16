# AI guide: building a Clegra apps app

> For coding agents. This one file is enough to write a correct app.
> A Clegra app is an app that is also an MCP server. One package, `clegra`; normative text in [spec.md](spec.md).

## The model

You write **one object**, `defineApp({ … })` (exported by name, `app`, in a Next.js app). The SDK turns
it into (a) a JSON manifest at `/.well-known/clegra.json` that workspace
hosts draw natively and (b) a plain MCP server at `/mcp` with tools and MCP
Apps views for ChatGPT, Claude and any MCP client. Permissions, field
visibility, confirmations and idempotency are enforced by the SDK before your
handlers run. There is no other authoring API.

## The package

| Import | What |
|---|---|
| `clegra` | `defineApp`, `AppError`, `AuthError`, `ref`, `SqlStore`, `MemoryStore`, types. `app.fetch(request)` runs anywhere |
| `clegra/next` | `toNextHandlers(app)` (the route), `withClegra(config)` (next.config) |
| `clegra/node` | `listen(app, { port })`: Node's own HTTP server |
| `clegra/testing` | `testClient(app, …)` |
| `clegra/spec` | `checkApp`, `formatReport`: the conformance checks |
| CLI | `npx clegra init` (adds MAP to a Next.js app), `npx clegra check <url> --token <bearer>` |

## In a Next.js app (App Router)

`npx clegra init` writes these; by hand they are:

```ts
// clegra.ts (or src/clegra.ts): export the app by name
export const app = defineApp({ … })

// app/api/clegra/[...path]/route.ts
import { toNextHandlers } from "clegra/next"
import { app } from "@/clegra"
export const { GET, POST, DELETE, OPTIONS } = toNextHandlers(app)

// next.config.ts: rewrites /mcp, /.well-known/clegra.json and the OAuth metadata paths to that route
import { withClegra } from "clegra/next"
export default withClegra(nextConfig)
```

- Under Next: never `auth.dev` (`toNextHandlers` refuses it) and never defineApp's `path` (the mount does that job).
  `basePath` and `trailingSlash: true` are refused too.
- Locally, before the sign-in is wired: init's `resolve` accepts the bearer in `.env.local` (`CLEGRA_LOCAL_TOKEN`)
  only when `NODE_ENV !== "production"`.
- In production: `CLEGRA_PUBLIC_URL` (an origin) and `auth.resource = ${CLEGRA_PUBLIC_URL}/mcp`, or every request
  answers `500 misconfigured`. Use `store: new SqlStore(query)` on serverless.
- The app's handlers call the same functions its pages use. Data access is yours (any DB or ORM), and so is auth:
  `auth.resolve` verifies your own sign-in's tokens (recipes in [auth.md](auth.md)).

## The whole shape

```ts
import { AppError, defineApp, ref } from "clegra"
import { z } from "zod"

export default defineApp({
  name: "crm",                       // app id: [a-z][a-z0-9-]{1,39}
  title: "CRM",                      // any label: a string, or { en: "…", it: "…" }
  version: "1.0.0",
  description: "…",                  // optional
  icons: [{ src: "https://…/icon.png", sizes: ["128x128"], mimeType: "image/png" }], // optional
  locale: "en",                      // language of bare strings and of tool names/descriptions (default "en")
  instructions: "…",                 // optional: MCP instructions for models
  websiteUrl: "https://…",           // optional
  auth: {                            // or { dev: true } with listen() only (loopback callers, refused in production and under Next)
    resource: "https://crm.example.com/mcp",                 // this server's public MCP address: the only token audience; required in production
    resolve: async (token, request, { resource }) => ({ installation: "org_1", person: { id, name }, permissions: [...] }), // your own users' tokens: verify (signature, exp, aud === resource), map to a caller, or null
    authorizationServers: ["https://crm.example.com/api/auth"], // your auth library's OAuth server, named in the protected-resource metadata
    serve: async (request) => null,                          // optional: answer your authorization server's RFC 8414 metadata at the root; null otherwise
    issuers: [{ issuer: "https://host.example.com" }],       // optional: workspace hosts (tokens with the clegra claim)
  },
  path: "/api/clegra",             // optional, never under Next: where MCP lives with app.fetch elsewhere (default /mcp at the root)
  store: new SqlStore(query),        // optional: idempotency + one-time token ids in your Postgres (serverless, several instances)

  permissions: {                     // ids are "group.verb"
    "deals.view": { label: "See deals", default: true },
    "deals.edit": { label: "Change deals", default: true },
    "deals.values": { label: "See values", description: "…" },    // default false
  },

  settings: {                        // set per installation by an administrator, sent by the workspace host with every call; read as ctx.settings.<id>
    follow_up_days: { label: "Follow-up (days)", type: "number", default: 7 },   // text | number | boolean. Never secrets: keep those in your server's own configuration
  },

  entities: {
    deal: {
      label: "Deal", plural: "Deals", description: "…", icon: "briefcase",    // icon: a lucide name
      schema: z.object({
        id: z.string(),                                                        // required
        name: z.string().meta({ role: "title", label: "Name", search: true }), // exactly one role: "title"
        company: ref("company").meta({ label: "Company", filter: true }),      // id of another entity's record
        stage: z.enum(["open", "won", "lost"]).meta({ role: "status", label: "Stage", filter: true,
          labels: { open: "Open", won: "Won", lost: "Lost" }, tones: { won: "success", lost: "danger" } }),
        value: z.number().meta({ role: "amount", currency: "EUR", label: "Value", sort: true, permission: "deals.values" }),
        closeDate: z.string().meta({ role: "date", label: "Close date", sort: true, filter: true }),
        owner: z.string().meta({ role: "person", label: "Owner" }),     // a person id: name it with `people` (below)
        note: z.string().optional().meta({ label: "Note", untrusted: true }),  // text written by outsiders
      }),
      permission: "deals.view",                                // optional: who sees the entity at all
      get: (id, ctx) => db.deal(ctx.installation, id),         // the row or null
      list: (query, ctx) => db.deals(ctx.installation, query), // { rows, next?, total? }; search query.text only in query.textFields
      expose: { plain: true, list: "deal_list", get: "deal_get" },   // optional
      view: { html: "<!doctype html>…" },                      // optional: your own record view
    },
    // company: { … }                // every ref("…") names an entity of this app
  },

  actions: {
    mark_won: {
      on: "deal",                    // record action: tool deal_mark_won takes { id, …input }
      title: "Mark as won", description: "…", icon: "trophy",
      input: z.object({ note: z.string().optional() }),        // REQUIRED key; z.object({}) for none; never declare `id`
      confirm: true,                 // true|"always" (default for writes) | "optional" | false|"never"
      permission: "deals.edit",
      expose: { plain: true, tool: "deal_mark_won" },          // writes are hidden from plain MCP clients unless plain: true
      run: (input, ctx, deal) => {   // deal is typed from the entity's schema
        if (deal.stage !== "open") throw new AppError("conflict", "Already closed.")
        return { message: "Marked as won.", record: deal.id }  // all optional: message, record (id or URI), data
      },
    },
    create_deal: {                   // no `on`: global; run gets (input, ctx)
      title: "New deal",
      input: z.object({ name: z.string(), company: ref("company") }),
      run: (input, ctx) => ({ record: ctx.uri("deal", db.create(ctx.installation, input)) }),
    },
    stats: { title: "Stats", input: z.object({}), readOnly: true, run: () => ({ data: { n: 1 } }) },   // a read: no confirmation
  },

  fragments: {
    pipeline_total: {
      title: "Open pipeline", description: "Total value of open deals", icon: "sigma",
      params: z.object({}),          // REQUIRED key
      permission: "deals.values",
      template: "stat",              // card | stat | list | chart  (or no template and `view`)
      data: (params, ctx) => ({ label: "open", value: 36500, format: "money", currency: "EUR" }),   // or null: not available
      actions: ["create_deal"],      // optional: global actions shown inside, by name
      size: "small",                 // small | medium | large
      expose: { plain: true, tool: "show_pipeline_total" },
      // view: { html }              // optional: your own view instead of the generated one
    },
  },

  pages: {                           // each page is ONE of: list, record, dashboard, view, url
    deals: { title: "Deals", icon: "briefcase", list: "deal", columns: ["name", "stage", "value"] },
    deal: { record: "deal", sections: [{ title: "Deal", fields: ["name", "stage", "value"] }] },   // optional: every entity has a default record page
    pipeline: { title: "Pipeline", dashboard: [{ type: "pipeline_total", params: {}, size: "small" }, { type: "deal", params: { id: "d1" } }] },
    forecast: { title: "Forecast", permission: "deals.values", view: { html: () => loadHtml() } }, // your MCP Apps document
    site: { title: "Site", url: "https://app.example.com/embed" },                                 // another site, isolated frame; https only
    board: { title: "Board", url: "/embed/board", permission: "deals.view" },                      // a page of THIS app: needs `embed` (below)
  },

  agents: {
    sales: { title: "Sales assistant", description: "…", instructions: "…",
      uses: ["deal", "mark_won"],    // entity names (their reads), action names, or tool names
      tier: "fast",                  // fast | standard (default) | strong
      starters: ["Which deals close this month?"] },
  },

  mcp: (server, caller) => {},       // optional: the raw McpServer (official SDK) of each request; caller is null before sign-in
  store: myStore,                    // optional: a shared store ({ begin, finish, abandon, once }, each atomic) for multi-instance servers
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
(`error.fields`). Views add no confirmation of their own: confirming is the host's (annotations, elicitation, or a
workspace host's proof).

An action on a record (`on: "deal"`) is listed with `id` and an optional `record_title` that the SDK adds (don't
declare either in `input`): the model passes the record's title so a client's own approval prompt names it
(«Mark Hartley Engineering as won», not «d1»). Your handler never sees `record_title`; the SDK refuses a call whose
hint names another record, and every confirmation the SDK words names the record from its id. Name the record in
your `message` yourself (`${deal.name} marked as won.`).

`people: (ids, ctx) => ({ [id]: name })` (optional, beside `entities`): the names of the people `role: "person"`
fields hold. Hosts and models then see names (the caller's own comes from the token); an id it can't name shows as
an unknown person, never as the id. Without it a person field must hold the name itself.

Labels given as `{ en, it }` maps reach the generated view in every locale: it draws them in the reader's language
(`hostContext.locale`), else English. Give every label in each language you support.

`ctx`: `app`, `installation`, `person` (`{ id, name }` or null), `permissions`,
`can(p)`, `locale`, `host` (`"workspace" | "plain"`), `settings`, `call`,
`t(label)`, `notify({ title, body?, uri?, to? })`, `uri(entity, id)`.

`AppError(code, message)` codes: `permission_denied`, `not_found`,
`invalid_input`, `confirmation_required`, `conflict`, `internal`, `unauthorized`.

What `defineApp` returns: `manifest()`, `fetch(request)` (Fetch API handler),
`start()`, `devToken()`, `devConfirmation()`, `uri()`. On Node alone:
`listen(app, { port, host })` from `clegra/node`.

## Kinds: the same kind of thing across apps (optional)

Say what an entity is only when other apps may hold the same thing: people, companies, events, tasks,
documents, products, orders. Leave your own records (deals, tickets, quote lines) without a kind.

```ts
contact: {
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
},
customer: { kind: { by: "type", map: { company: "organization", private: "person" } }, … },   // one kind per record: `type` a required enum
```

- Properties (schema.org names, verbatim): person `givenName familyName email† telephone† jobTitle worksFor address
  image`; organization `legalName email† telephone† url address vatID taxID`; event `startDate`(required) `endDate
  location attendee† organizer uid`; task `due startDate completed assignee`; document `url encodingFormat author
  contentSize`; product `sku gtin brand price`; order `orderNumber orderDate customer totalPrice`. † many: an array
  field, or several fields. Any entity may mark `url`, `dateCreated`, `dateModified`. Full list: `packages/clegra/spec/kinds.json`.
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

## Generated tools

`<entity>_list`, `<entity>_get`, `search` and `fetch` (when a field has
`search: true`), `<entity>_<action>` / `<action>`, `open_<page>` (not for
record pages), `show_<fragment>`, `clegra_resolve` (for hosts; `not_found` for another app's URI). Reads have
`readOnlyHint: true`; writes `destructiveHint: true` when `confirm` is always. With a kind, entity tools end with
`Kind: person.` and carry `_meta.clegra: { entity, kind }`; `search` takes `kind`. What a model reads of a list,
a get, `search` or `fetch` carries each record's `title` beside its `uri`. Every tool the generated view calls is
callable from views (`_meta.ui.visibility` with `"app"`, `openai/widgetAccessible`).

The generated view (ChatGPT, Claude, any MCP Apps host): rows open their record, «‹ back» returns, a record's
actions run from it; progress, results and refusals appear in a status line at the top. It talks the MCP Apps bridge
(ChatGPT included) and tells the model about a change made in it (`ui/update-model-context`). A custom view you
write: finish `ui/initialize` before any `tools/call`, and draw the opening result once (hosts repeat
`ui/notifications/tool-result` for your own calls, and ChatGPT's `openai:set_globals` fires on every layout or theme
change).

## Rules

1. Scope **every** read and write by `ctx.installation`. Never keep global data.
2. Never check permissions or strip fields yourself for what you declared: declare `permission` on the entity, field, action, page or fragment and the SDK enforces it. Use `ctx.can()` only for finer rules inside a handler.
3. Every entity schema has a string `id` and exactly one `role: "title"`; at most one field per role.
4. `input` and `params` are always present (`z.object({})`); omitting one breaks type inference for all entries.
5. Writes confirm by default. Don't set `confirm: false` on anything a person would want to see first.
6. Mark text that comes from outside (names typed into a form, emails, customer notes) `untrusted: true`, on the field; on a fragment whose data carry such text, `untrusted: true` on the fragment.
7. Return short `message`s in the caller's language: `ctx.t({ en: "…", it: "…" })`.
8. Names (`entities`, `actions`, `fragments`, `pages`, `agents` keys) are `[a-z][a-z0-9_]*`. Entities and fragments share one namespace. Don't name a filter/sort field `query`, `sort`, `dir`, `cursor` or `limit`.
9. A list page with `params` also needs `query: (params) => ({ filters, text, sort })`.
10. Dev auth (`auth: { dev: true }`) is for `listen()` and tests only: off unless you set it, refused when `NODE_ENV=production`, answers only callers on a loopback address, refused by `toNextHandlers`. In production give `auth.resource`: your server's public MCP address, the only audience tokens are accepted for. In `resolve`, check signature, expiry, issuer and `aud === resource` (a single audience); return null or throw `AuthError` to refuse.
11. `ctx.installation` is the tenant: what `auth.resolve` said (your organization id), or a host's installation bound to that host (`<installation>@<issuer>`). Use it as an opaque key; never take a tenant from a parameter.
12. In `list`, search `query.text` only in `query.textFields`; in a fragment's `data`, leave out values the caller may not see (`ctx.can`): template data are yours, the SDK only drops items whose `uri` is out of the caller's reach.
13. Your data access is yours (any DB/ORM). Pages with `url` may be same-site paths (`/embed/pipeline`): then `defineApp({ embed: { frameAncestors: [the host origins], secret } })` (secret default `CLEGRA_EMBED_SECRET`), `proxy.ts` = `export const proxy = embedProxy(app); export const config = { matcher: "/embed/:path*" }`, and in the page `const caller = await getEmbedCaller(app, "<page name>")` (null → "open it from the app"; scope by `caller.installation`). Never read your own session cookie there: the host's frame is cross-site (spec §5.1).

## Common mistakes

| Mistake | Fix |
|---|---|
| Calling `registerEntity` / `new …Server` | They are not public. Only `defineApp` |
| `entity: "deal"` on an action, `tools: [...]` on an agent, `kind: "list"` on a page | `on: "deal"`, `uses: [...]`, `list: "deal"` |
| An action without `input` | `input: z.object({})` |
| Declaring `id` in a record action's input | The SDK adds it |
| A write invisible in ChatGPT | `expose: { plain: true }` |
| A permission used but not declared | Add it under `permissions`; `defineApp` throws at start otherwise |
| Translating tool names per caller | Tool names and descriptions are fixed in the app's `locale`; only data labels follow the caller |
| Putting custom keys in `_meta` | Don't. Everything hosts need is in the manifest |
| `kind` on every entity "for symmetry" | Only for things other apps hold too; a deal has none |
| `as: "email"` on a notes field, or a key filter with `ILIKE` | `as` only for the real value; keys compared exactly on the normalised value |
| Keeping another app's title next to a `ref.kind` URI | Keep the URI only |
| `auth: { dev: true }` or `path` in a Next.js app | Next: your own `auth.resolve` (locally init's `CLEGRA_LOCAL_TOKEN`), no `path`; the route's mount does it |
| `aud` checked with "includes", or not at all, in `resolve` | Exactly one audience, equal to `resource` |
| The tenant taken from a tool argument or a header | From the verified token (or the database row it points to) only |

## Check your work

```ts
import { testClient } from "clegra/testing"
const c = await testClient(app, { permissions: ["deals.edit"] })      // or "all"; host: "workspace"; person; installation; locale
await c.listTools(); await c.call("deal_list", {}); await c.readResource("ui://crm/view")
await (await testClient(app, { host: "workspace", permissions: "all" })).confirmed("deal_mark_won", { id: "d1" })
```

`npx clegra check <url> --token <bearer>` must end with `Conformant.`
Complete, tested apps to copy from: the CRM ([`examples/apps/crm/clegra/app.ts`](../../examples/apps/crm/clegra/app.ts), Drizzle) and the
warehouse ([`examples/apps/warehouse/lib/clegra.ts`](../../examples/apps/warehouse/lib/clegra.ts), plain SQL).
