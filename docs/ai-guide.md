# AI guide: building a Clegra app with `@clegra/sdk` 0.4

For coding agents. A Clegra app is a web app with a plain MCP server (revision `2026-07-28`) plus the extensions in
[extensions](extensions/README.md). Agents use MCP tools; pages are for people; records live at their own web URLs;
the person signs in once on the app's own page. Full reference: [spec.md](spec.md).

## Rules that matter

- Annotations are truthful: `{ readOnly: true }` for reads; writes say `destructive` (deleting for good is `true`;
  sending or creating is `false`) and `openWorld: true` when they reach outside the app.
- A tool that sends, pays, shares, publishes, exports, changes permissions or recipients, or deletes for good gets
  `confirm: { message, values }`. `message` comes from the app's own data; `values` are what the approval is bound to.
- A tool on one record: `entity`, `on: "record"`, input `id` (or `recordArg`) takes the record's **URL** (a bare id
  also works when the path has one variable). The handler gets the record as its third argument.
- Return records as `records: [{ entity, record }]` so results link to them; mark counters with `ctx.changed(badge)`.
- Every variable of a tool's `page` must be an input or a variable of its record's path.
- A tool that receives shared content (`accepts`, `plugins`) has `z.strictObject` input.
- `get` returns null for what this person may not see. Scope every query by `ctx.person` (and `ctx.person.tenant`).
- Never put tokens in URLs; never fetch another app's record URL; never poll (use `ctx.changed`, events).

## Imports

```ts
import { AppError, defineAgent, defineApp, defineBadge, defineEntity, definePage, defineTool, defineWidget, serve, MemoryStore, SqlStore } from "@clegra/sdk"
import { createSignIn, devSignIn, passwordLogin, SqlSignInStore, newSignInKey } from "@clegra/sdk/signin"
import { listen, toNodeHandler } from "@clegra/sdk/node"
import { clegraMiddleware } from "@clegra/sdk/express"
import { toNextHandlers, withClegra, recordProxy } from "@clegra/sdk/next"
import { testClient, confirmOnPage } from "@clegra/sdk/testing"
```

## Shapes

```ts
defineEntity({ name, title, plural?, description?, path: "/jobs/{id}", schema: z.object({...}), card: { title, subtitle?, status?, amount?, date? }, get(vars, ctx), list?(query, ctx), shareAs?: [{ type, fields: { field: "/pointer" } }], ttlMs? })
defineTool({ name, title, description, input: z.object({...}), output?, annotations, entity?, on?: "record" | "collection", recordArg?, page?, confirm?: { message(i, ctx, r), values?(i, ctx, r) }, accepts?, plugins?, visibility?: "app", allow?(ctx), run(input, ctx, record) → { data?, text?, records?, links? } | void })
definePage({ name, title, path: "/jobs{?status}", role: "list" | "record" | "create" | "dashboard" | "settings" | "other", entity?, nav?: { section?, order }, tools?: string[], badge?, frame?, allow?(ctx) })
defineBadge({ name, title?, value(ctx) → number, allow? })
defineWidget({ name, title, description?, sizes: ["small" | "medium" | "large"], data(ctx) → { title, value?, unit?, trend?, rows?, url? }, allow? })
defineAgent({ name: "kebab-name", description, instructions, tools: [handles], tier?: "fast" | "standard" | "strong", maxSteps?, approval?: { change: "ask" | "always" }, starters?, schedules?: [{ name, title?, cron: "0 8 * * 1", timezone?, starter: 0 }] })
defineApp({ name, title, description, version, locale?, icons?, instructions?, entities, tools, pages, badges, widgets, agents, notifications?: { type: { title } }, sessionTransfer?: { link: true } })
serve(app, { origin?, mcpPath?, auth: { signIn } | { verify, authorizationServers, sessions?, revoke? }, store?, audit?, auditReads?, auditDays?, clientOrigins?, confirmWaitMs?, pages?: "generated", events?, bus?, mcp? })
```

`ctx`: `person`, `grant`, `locale`, `t(label)`, `has(scope)`, `origin`, `url(entity, record)`, `changed(...)`,
`notify({ type, title, url, … })`, `activity({ id, type, title, state, … })`, `source`.

Errors: `throw new AppError("not_found" | "invalid_input" | "permission_denied" | "conflict" | "rate_limited" | "<yours>", message, details?)`.

## A minimal app

```ts
const job = defineEntity({ name: "job", title: "Job", path: "/jobs/{id}", schema: z.object({ id: z.string(), title: z.string(), status: z.string() }), card: { title: "title", status: "status" }, get: ({ id }, ctx) => db.job(ctx.person, id!) })
const jobPage = definePage({ name: "job", title: "Job", path: "/jobs/{id}", role: "record", entity: job })
const complete = defineTool({ name: "job.complete", title: "Complete job", description: "Closes a job", input: z.object({ id: z.string() }), annotations: { readOnly: false, destructive: false, idempotent: true }, entity: job, on: "record", page: jobPage, run: async (_i, ctx, r) => ({ records: [{ entity: job, record: await db.complete(ctx.person, r) }] }) })
export const app = defineApp({ name: "jobs", title: "Jobs", description: "Job requests", version: "1.0.0", entities: [job], tools: [complete], pages: [jobPage] })
export const served = serve(app, { auth: { signIn: devSignIn(app) }, pages: "generated" })
await listen(served, { port: 3000 })
```

## Testing

```ts
const signIn = devSignIn(app, { issuer: "http://localhost:3000", people: [{ id: "ada", name: "Ada" }] })
const served = serve(app, { origin: "http://localhost:3000", auth: { signIn }, confirmWaitMs: 0 })
const c = testClient(served, { token: await signIn.dev.token({ person: "ada" }) })   // elicitation: false → the fallback
await c.listTools(); await c.call("job.complete", { id: "http://localhost:3000/jobs/1" }); await c.readJson("webmap://pages")
```

A confirmed tool answers `resultType: "input_required"` (URL elicitation) or the error `confirmation_required` with
`url`; `confirmOnPage(served, url, cookie)` confirms as the person (cookie from `POST /oauth/dev-login` with `person`,
`code`, `return`); then repeat the call (with `requestState` and `inputResponses: { confirm: { action: "accept" } }`
in the elicitation flow).

## Check

`npx @clegra/sdk check <url> --token <token>` prints the level the app reaches (A, B1, B2, C). A URL that is http on
a loopback name (`localhost`, `<name>.localhost`, `127.0.0.1`, `[::1]`) is a local stack: the report says «local http»
and same-origin http URLs count where the web map wants https; any other address stays https only.
