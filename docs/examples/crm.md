# The reference app: a CRM

> Non-normative. Runnable code: [`examples/mcp-workspaces/crm`](../../../examples/mcp-workspaces/crm)
> (`src/app.ts`, tests in `src/app.test.ts`). Invented data.

A small sales team's CRM: **companies**, **contacts** and **deals**, in
memory, one copy per installation. The whole app is the one object at the
bottom of `app.ts`: `export const app = defineApp({ … })`.

## What it declares

| Key | In the CRM |
|---|---|
| `permissions` | `deals.view`, `deals.edit`, `contacts.edit` (default), `deals.values` (not default: only managers see money) |
| `settings` | `followUpDays` (number, default 7) |
| `entities` | `company` (name, city, industry), `contact` (name, email, `ref("company")`, last call, last note — **untrusted**), `deal` (name, company, stage as `status` with labels and tones, value as `amount` in EUR behind `deals.values`, close date, owner as `person`) |
| `actions` | `mark_won` (on `deal`, confirm always, notifies), `set_stage` (on `deal`, `"optional"`), `log_call` (on `contact`), `create_deal` (global). All four `expose: { plain: true }` |
| `pages` | `deals`, `companies`, `contacts` (lists), `deal` (record with two sections; the `company` and `contact` record pages are derived), `pipeline` (dashboard, param `days`), `forecast` (a custom view, behind `deals.values`) |
| `fragments` | `pipeline_total` (stat, behind `deals.values`), `deals_by_stage` (chart), `closing_soon` (list, param `days`, the `create_deal` action inside); plus a record card per entity |
| `agents` | `sales_assistant` (tier `fast`): `uses` the three entities, `set_stage`, `mark_won`, `log_call` |

## The parts worth reading

**Field meaning.** One line per field says how every host draws it:

```ts
stage: z.enum(STAGES).meta({ role: "status", label: { en: "Stage", it: "Fase" }, filter: true, labels: stageLabels,
  tones: { lead: "neutral", qualified: "info", proposal: "warning", won: "success", lost: "danger" } }),
value: z.number().meta({ role: "amount", currency: "EUR", label: { en: "Value", it: "Valore" }, sort: true, permission: "deals.values" }),
```

Bruno (no `deals.values`) never receives `value`: not in lists, records or
cards, not as a sort; `show_pipeline_total` and `open_forecast` are not even
listed for him. The app wrote no check for this.

**A record action.** `on: "deal"` types the third argument and adds `id` to the tool:

```ts
mark_won: {
  on: "deal",
  title: { en: "Mark as won", it: "Segna come vinta" },
  input: z.object({ note: z.string().max(500).optional() }),
  confirm: true,
  permission: "deals.edit",
  expose: { plain: true },
  run: (_input, ctx, deal) => {
    if (deal.stage === "won" || deal.stage === "lost") throw new AppError("conflict", ctx.t({ en: `${deal.name} is already closed.`, it: `${deal.name} è già chiusa.` }))
    dataOf(ctx).deals.set(deal.id, { ...deal, stage: "won", closeDate: new Date().toISOString().slice(0, 10) })
    ctx.notify({ title: { en: `Deal won: ${deal.name}`, it: `Trattativa vinta: ${deal.name}` }, uri: ctx.uri("deal", deal.id) })
    return { message: ctx.t({ en: `${deal.name} marked as won.`, it: `${deal.name} segnata come vinta.` }), record: deal.id }
  },
},
```

In a workspace host the person sees «Mark as won» with the values and
confirms; the host sends the proof. In ChatGPT the tool carries
`destructiveHint: true`, so ChatGPT asks before calling it.

**Installation scoping.** All data go through `dataOf(ctx)`, keyed by
`ctx.installation`. On a database the same rule is a column:

```sql
CREATE TABLE deals (installation_id text NOT NULL, id text NOT NULL, …, PRIMARY KEY (installation_id, id));
```

**A dashboard and a custom page.**

```ts
pipeline: {
  title: { en: "Pipeline", it: "Pipeline" },
  permission: "deals.view",
  params: z.object({ days: z.number().int().min(1).max(365).optional() }),
  dashboard: (p: { days?: number }) => [
    { type: "pipeline_total", params: {}, size: "small" },
    { type: "deals_by_stage", params: {}, size: "medium" },
    { type: "closing_soon", params: { days: p.days ?? 60 }, size: "medium" },
  ],
},
forecast: { title: { en: "Forecast", it: "Previsione" }, permission: "deals.values", view: { html: () => import("./forecast-view").then((m) => m.forecastHtml) } },
```

The dashboard is drawn by the generated view (or natively by a host); the
forecast is the app's own MCP Apps document (`src/forecast-view.ts`), which
reads deals through the host with `tools/call` and has no network access.

## Run and check it

```sh
npm run mcpw:crm                      # http://127.0.0.1:3920 — MCP at /mcp, manifest at /.well-known/app-manifest.json
MCPW_DEV_CODE=CRM2026 npm run mcpw:crm   # a fixed dev sign-in code instead of a random one
npm run mcpw:test                     # SDK tests + the CRM's tests
npm run mcpw:conformance -- http://127.0.0.1:3920 --token <bearer>
```

Dev sign-in offers two invented people: Ada (manager, every permission) and
Bruno (sales rep, no `deals.values`). `MCPW_ISSUERS="<issuer>|<jwks url>"`
adds a trusted workspace host; `MCPW_DEV=0` turns the dev sign-in off.

`src/mcp.snapshot.json` is what MCP clients see (tools, annotations, views,
manifest). A change to it is a change for every client, so it is reviewed as
a diff; `UPDATE_SNAPSHOTS=1` rewrites it.
