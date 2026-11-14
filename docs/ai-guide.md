# AI guide: building a Model App Protocol (MAP) app

> For coding agents. This one file is enough to write a correct app.
> A MAP app is an app that is also an MCP server. SDK `@modelapp/server`; normative text in [spec.md](spec.md).

## The model

You write **one object** and `export default defineApp({ … })`. The SDK turns
it into (a) a JSON manifest at `/.well-known/modelapp.json` that workspace
hosts draw natively and (b) a plain MCP server at `/mcp` with tools and MCP
Apps views for ChatGPT, Claude and any MCP client. Permissions, field
visibility, confirmations and idempotency are enforced by the SDK before your
handlers run. There is no other authoring API.

## The whole shape

```ts
import { AppError, defineApp, ref } from "@modelapp/server"
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
  auth: { issuers: [{ issuer: "https://host.example.com" }] },   // or { dev: true } locally

  permissions: {                     // ids are "group.verb"
    "deals.view": { label: "See deals", default: true },
    "deals.edit": { label: "Change deals", default: true },
    "deals.values": { label: "See values", description: "…" },    // default false
  },

  settings: {                        // filled per installation; read as ctx.settings.<id>
    followUpDays: { label: "Follow-up (days)", type: "number", default: 7 },   // text | secret | number | boolean | choice (+ options)
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
        owner: z.string().meta({ role: "person", label: "Owner" }),
        note: z.string().optional().meta({ label: "Note", untrusted: true }),  // text written by outsiders
      }),
      permission: "deals.view",                                // optional: who sees the entity at all
      get: (id, ctx) => db.deal(ctx.installation, id),         // the row or null
      list: (query, ctx) => db.deals(ctx.installation, query), // { rows, next?, total? }
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
    site: { title: "Site", url: "https://app.example.com/embed" },                                 // your site, isolated frame; https only
  },

  agents: {
    sales: { title: "Sales assistant", description: "…", instructions: "…",
      uses: ["deal", "mark_won"],    // entity names (their reads), action names, or tool names
      tier: "fast",                  // fast | standard (default) | strong
      starters: ["Which deals close this month?"] },
  },

  mcp: (server, caller) => {},       // optional: the raw McpServer (official SDK) of each request; caller is null before sign-in
  store: myStore,                    // optional: shared idempotency store ({ get, set }) for multi-instance servers
})
```

Template data: `card { title, subtitle?, status?, fields: [{ label, value }], uri? }` ·
`stat { label, value, format?: number|money|percent, currency?, hint? }` ·
`list { items: [{ title, subtitle?, status?, uri? }] }` ·
`chart { kind: bar|line|pie, points: [{ label, value }], format?, currency? }`.

`query` given to `list`: `{ filters: { field: value | { in: [...] } | { gte?, lte? } }, text?, sort?: { field, dir }, cursor?, limit }`.

`ctx`: `app`, `installation`, `person` (`{ id, name }` or null), `permissions`,
`can(p)`, `locale`, `host` (`"workspace" | "plain"`), `settings`, `call`,
`t(label)`, `notify({ title, body?, uri?, to? })`, `uri(entity, id)`.

`AppError(code, message)` codes: `permission_denied`, `not_found`,
`invalid_input`, `confirmation_required`, `conflict`, `internal`, `unauthorized`.

What `defineApp` returns: `manifest()`, `fetch(request)` (Fetch API handler),
`listen({ port, host })`, `devToken()`, `devConfirmation()`, `uri()`.

## Generated tools

`<entity>_list`, `<entity>_get`, `search` and `fetch` (when a field has
`search: true`), `<entity>_<action>` / `<action>`, `open_<page>` (not for
record pages), `show_<fragment>`, `modelapp_resolve` (for hosts). Reads have
`readOnlyHint: true`; writes `destructiveHint: true` when `confirm` is always.

## Rules

1. Scope **every** read and write by `ctx.installation`. Never keep global data.
2. Never check permissions or strip fields yourself for what you declared: declare `permission` on the entity, field, action, page or fragment and the SDK enforces it. Use `ctx.can()` only for finer rules inside a handler.
3. Every entity schema has a string `id` and exactly one `role: "title"`; at most one field per role.
4. `input` and `params` are always present (`z.object({})`); omitting one breaks type inference for all entries.
5. Writes confirm by default. Don't set `confirm: false` on anything a person would want to see first.
6. Mark text that comes from outside (emails, customer notes) `untrusted: true`.
7. Return short `message`s in the caller's language: `ctx.t({ en: "…", it: "…" })`.
8. Names (`entities`, `actions`, `fragments`, `pages`, `agents` keys) are `[a-z][a-z0-9_]*`. Entities and fragments share one namespace. Don't name a filter/sort field `query`, `sort`, `dir`, `cursor` or `limit`.
9. A list page with `params` also needs `query: (params) => ({ filters, text, sort })`.
10. Dev auth (`auth: { dev: true }`) works only on a loopback address. In production trust issuers.

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

## Check your work

```ts
import { testClient } from "@modelapp/server/testing"
const c = await testClient(app, { permissions: ["deals.edit"] })      // or "all"; host: "workspace"; person; installation; locale
await c.listTools(); await c.call("deal_list", {}); await c.readResource("ui://crm/view")
await (await testClient(app, { host: "workspace", permissions: "all" })).confirmed("deal_mark_won", { id: "d1" })
```

`npm run modelapp:check -- <url> --token <bearer>` must end with `Conformant.`
A complete, tested app to copy from: [`examples/modelapp/crm/src/app.ts`](../../examples/modelapp/crm/src/app.ts).
