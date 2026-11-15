# CRM — a Next.js app that is also a MAP app

A small sales team's CRM (companies, contacts, deals, calls) with its own sign-in (better-auth, organizations)
and database (Drizzle; Postgres, or an embedded PGlite locally). `modelapp/app.ts` makes it a MAP app over the
same functions the pages use (`lib/crm.ts`). Invented data only. Walkthrough: [docs/map/examples/crm.md](../../../docs/map/examples/crm.md).

```sh
npm run setup   # .env.local (generated BETTER_AUTH_SECRET, DEMO_PASSWORD) if missing, then migrate + seed
npm run dev     # http://localhost:3920
npm test        # tests on in-memory PGlite
npm run typecheck
```

On `/sign-in`, «Enter as Ada Rossi (sales manager)», «Bruno Neri (sales rep)» or «Elena Conti (Kestrel Design)»
(with `DEMO_SIGNIN=1`; the password stays on the server). Or sign in with `ada@orbita.example` and `DEMO_PASSWORD`
from `.env.local`.

| Command | |
|---|---|
| `npm run db:migrate` / `npm run db:seed` | Apply `drizzle/` migrations / create the demo accounts and data (safe to repeat) |
| `npm run db:generate` | A new migration after changing `db/schema.ts` |
| `npm run auth:schema` | Regenerate `db/auth-schema.ts` after changing better-auth plugins in `lib/auth-options.ts` |

Environment: see `.env.example`. In production `DATABASE_URL`, `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL` are
required (a missing one is an error, never a fallback). `MODELAPP_ISSUERS` + `MODELAPP_RESOURCE` let a workspace
host (e.g. Clegra) call the MCP server; each of its installations gets its own copy of the demo data.
