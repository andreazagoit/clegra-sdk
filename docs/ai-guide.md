# Building an MCP Workspaces app with an AI coding agent

> Non-normative. Give this file and [spec.md](spec.md) to your agent.

## Rules the agent must follow

1. **One server**: `new McpWorkspacesServer({ name, title, version, description, icons, locale, auth })`,
   then only `register…` calls, then `app.listen()` in `src/main.ts`. Export
   `app` from `src/app.ts` so tests import it without a port.
2. **Entities are Zod objects** with a required string `id` and exactly one
   `role: "title"` field. Meaning goes in `.meta()`: `role`, `label`, `ref`,
   `permission`, `filter`, `sort`, `search`, `labels`, `tones`, `currency`,
   `untrusted`. Use `ref("entity")` for a field holding another record's id.
3. **Scope every read and write by `ctx.installation`.** In SQL:
   `WHERE installation_id = $ctx.installation` on every query; a unique key
   always includes it.
4. **`list` honours the query it gets**: `filters` (value, `{ in }`, `{ gte, lte }`),
   `text`, `sort`, `cursor`, `limit`. Return `{ rows, next?, total? }`. Never
   return more than `limit` rows.
5. **Writes**: `registerAction` without `readOnly`. Leave `confirm` at its
   default (`always`) for anything hard to undo or reaching outside; use
   `optional` for small reversible edits. Throw `WorkspaceError(code, message)`
   for expected failures (`conflict`, `invalid_input`, `not_found`).
6. **Never** check confirmations, permissions or field visibility yourself:
   the SDK does it from the token before your handler runs.
7. **Labels** can be strings or `{ en, it }` maps. Write messages with
   `ctx.t({ en, it })`.
8. **Pages**: `list` (entity + columns), `record` (sections; one exists by
   default per entity), `dashboard` (fragment instances), `custom` (an MCP
   Apps `view` or a `url`). Prefer native pages.
9. **Fragments**: templates `card`, `stat`, `list`, `chart` with typed data;
   a `view` only when no template fits.
10. **Tests** with `testClient(app, { permissions, host })` from
    `@mcpw/server/testing`: one test per permission boundary, one for the
    confirmation of each `always` action, one for installation scoping.

## Checklist before shipping

- [ ] `app.card()` builds (it throws on unknown permissions, refs, columns).
- [ ] Every money field has `role: "amount"`, `currency`, and a `permission` if not everyone may see it.
- [ ] Text from outsiders (emails, notes, web) is `untrusted: true`.
- [ ] `auth.dev` is off in production; production lists real `issuers`.
- [ ] Tests pass: `node --import tsx --test`.
