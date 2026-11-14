# Example: a CRM

> Non-normative. The code is runnable: [`examples/mcp-workspaces/crm`](../../../examples/mcp-workspaces/crm)
> (`src/app.ts`, tests in `src/app.test.ts`). Invented data.

A small sales team's CRM: **companies**, **contacts** and **deals**, in
memory, one copy per installation. It shows every v1 piece once.

## What it declares

| Piece | In the CRM |
|---|---|
| Permissions | `deals.view` (default), `deals.edit` (default), `deals.values` (not default: only managers see money), `contacts.edit` (default) |
| Setting | `followUpDays` (number, default 7) |
| Entities | `company` (name, city, industry), `contact` (name, email, `ref("company")`, last call, last note — **untrusted**), `deal` (name, company, stage as `status` with labels and tones, value as `amount` in EUR behind `deals.values`, close date, owner as `person`) |
| Actions | `deal_mark_won` (confirm `always`, notifies), `deal_set_stage` (confirm `optional`), `contact_log_call` (`always`), `create_deal` (global, `always`) |
| Pages | `deals`, `companies`, `contacts` (lists), `deal` (record with two sections; `company` and `contact` record pages are derived), `pipeline` (dashboard, param `days`), `forecast` (custom MCP Apps view, behind `deals.values`) |
| Fragments | `pipeline_total` (stat, behind `deals.values`), `deals_by_stage` (chart), `closing_soon` (list with params `days`, the «New deal» action inside); plus a record card per entity |
| Agent | `sales_assistant` (tier `fast`): the three entities' reads, set stage, mark won, log call |

## The parts worth reading

**Field meaning.** One line per field says how every host draws it:

```ts
stage: z.enum(STAGES).meta({ role: "status", label: { en: "Stage", it: "Fase" }, filter: true,
  labels: stageLabels, tones: { won: "success", lost: "danger", proposal: "warning" } }),
value: z.number().meta({ role: "amount", currency: "EUR", label: { en: "Value", it: "Valore" },
  sort: true, permission: "deals.values" }),
```

Bruno (no `deals.values`) never receives `value`: not in lists, records,
cards, nor as a filter or sort; the `pipeline_total` fragment and the
`forecast` page are not even listed for him.

**Installation scoping.** All data go through `dataOf(ctx)`, keyed by
`ctx.installation`. On a database the same rule is a column:

```sql
CREATE TABLE deals (installation_id text NOT NULL, id text NOT NULL, …, PRIMARY KEY (installation_id, id));
-- every query: WHERE installation_id = $1   (ctx.installation)
```

Never take the installation from arguments, only from `ctx`.

**A confirmed write.**

```ts
app.registerAction("mark_won", { entity: DealEntity, title: { en: "Mark as won", it: "Segna come vinta" },
  input: z.object({ note: z.string().max(500).optional() }), confirm: "always", permission: canEditDeals },
  (input, ctx, deal) => {
    if (deal.stage === "won" || deal.stage === "lost") throw new WorkspaceError("conflict", "Already closed.")
    dataOf(ctx).deals.set(deal.id, { ...deal, stage: "won" })
    ctx.notify({ title: { en: `Deal won: ${deal.name}`, it: `Trattativa vinta: ${deal.name}` }, uri: ctx.uri("deal", deal.id) })
    return { message: `${deal.name} marked as won.`, record: deal.id }
  })
```

From Clegra: the person sees «Segna come vinta», the deal and every input
value, presses «Conferma», and the call carries the proof; without it the SDK
answers `confirmation_required`. From ChatGPT: the tool is marked
destructive and ChatGPT asks its own approval.

**A custom page.** `forecast` is an MCP Apps view (plain HTML in
`src/forecast-view.ts`) with sliders for the win probability per stage. It
reads open deals with `tools/call deal_list` through the host, so the host's
permissions apply; it has no network of its own.

## Run it

```sh
cd examples/mcp-workspaces/crm
MCPW_DEV_CODE=CRM2026 npm start                      # dev sign-in: Ada or Bruno, code CRM2026
MCPW_ISSUERS="http://localhost:3003|http://localhost:3003/.well-known/jwks.json" npm start   # also trust a Clegra node
npm test
```
