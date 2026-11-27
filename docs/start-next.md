# Getting started: Next.js

A Next.js App Router app is already a site for people. `@clegra/sdk` adds its MCP server for agents, on the same
origin, with the extensions: records at the URLs of your own pages, tools that name their page, one sign-in.
Reference: [spec.md](spec.md); the rules: [extensions](extensions/README.md).

## 5 minutes: `npx @clegra/sdk init`

```sh
npm i @clegra/sdk@next zod
npx @clegra/sdk init          # --dry-run writes nothing
npm run dev
```

In an existing App Router app it writes, never overwriting a file:

- `clegra/`: a `task` entity, its tools and its page, `app.ts` (the `defineApp`, pure) and `index.ts` (`serve` with
  the development sign-in);
- `app/api/clegra/[...path]/route.ts`: the route, over `toNextHandlers(served)`;
- `next.config.ts` wrapped in `withClegra` (or the lines to add, when it can't edit it safely);
- `proxy.ts` with `recordProxy()` and a matcher for the entity's path.

Then connect an MCP client to `http://localhost:3000/mcp`, and run
`npx @clegra/sdk check http://localhost:3000 --token <a development token>`.

## The three files

```ts
// next.config.ts
import { withClegra } from "@clegra/sdk/next"
export default withClegra({ /* your config: your rewrites, in any shape, are kept */ })
```

```ts
// app/api/clegra/[...path]/route.ts
import { toNextHandlers } from "@clegra/sdk/next"
import { served } from "@/clegra"
export const { GET, POST, DELETE, OPTIONS } = toNextHandlers(served)
```

```ts
// proxy.ts: a record URL read with a bearer token goes to the route; people get your page
import { recordProxy } from "@clegra/sdk/next"
export const proxy = recordProxy()
export const config = { matcher: ["/jobs/:id"] }
```

- `withClegra` adds `beforeFiles` rewrites to the route for `/mcp`, `/mcp/server-card`, `/.well-known/ai-catalog.json`,
  the OAuth metadata, `/oauth/*`, `/session-transfer/*`, `/confirm/*` and `/access/log`. It refuses `basePath` and
  `trailingSlash: true` (the well-known paths must be at the root, `/mcp` exact).
- `toNextHandlers` takes the mount off (`/api/clegra/mcp` → `/mcp`) and passes responses, streams included, through
  unbuffered. Options: `mount` (the same in `withClegra`), `publicUrl` (else `CLEGRA_PUBLIC_URL`).
- `recordProxy` exists because a page and a route handler cannot share a path: a `GET` with `Authorization: Bearer`
  on a record path is rewritten to the route (web-map REC-1); every other request reaches your page unchanged.

## The app

```ts
// clegra/app.ts
import { defineApp, defineEntity, definePage, defineTool } from "@clegra/sdk"
import { z } from "zod"
import { db } from "@/lib/db"

export const job = defineEntity({
  name: "job", title: "Job", path: "/jobs/{id}",                       // app/jobs/[id]/page.tsx is the page
  schema: z.object({ id: z.string(), title: z.string(), status: z.string(), customer: z.string() }),
  card: { title: "title", subtitle: "customer", status: "status" },
  get: ({ id }, ctx) => db.jobs.find(ctx.person.id, id!),
})
export const jobPage = definePage({ name: "job", title: "Job", path: "/jobs/{id}", role: "record", entity: job, frame: true })
export const getJob = defineTool({
  name: "job.get", title: "Get job", description: "One job", input: z.object({ id: z.string() }),
  annotations: { readOnly: true }, entity: job, on: "record", page: jobPage,
  run: (_i, _ctx, record) => ({ data: record, records: [{ entity: job, record }] }),
})
export const app = defineApp({ name: "jobs", title: "Jobs", description: "Job requests", version: "1.0.0", entities: [job], tools: [getJob], pages: [jobPage] })
```

```ts
// clegra/index.ts: how it runs
import { serve } from "@clegra/sdk"
import { devSignIn } from "@clegra/sdk/signin"
import { app } from "./app"

export const served = serve(app, { auth: { signIn: devSignIn(app) } })   // origin: CLEGRA_PUBLIC_URL, else the request's in development
```

## Your pages and the person

A page reads who is looking with the same session the SDK uses:

```tsx
// app/jobs/[id]/page.tsx
import { headers } from "next/headers"
import { served } from "@/clegra"

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const request = new Request(`${served.origin()}/jobs/${(await params).id}`, { headers: await headers() })
  const session = await served.session(request)     // the app's own session, or one transferred from a client
  if (!session) return <p>Sign in</p>
  // SES-6: with session.transferred, writes need "web.write" in session.transferred.scopes, and account settings a fresh sign-in.
  return <main dangerouslySetInnerHTML={{ __html: served.banner(session, request) }} />
}
```

Frames: a page with `frame: true` may be framed by the client origins you give `serve(app, { clientOrigins })`; send
`Content-Security-Policy: frame-ancestors <those origins>` on it yourself (other pages `'none'`).

## A day to ship

- **Sign-in.** Replace `devSignIn` with `createSignIn(app, { issuer, resource, login, active, store, keys })` over
  your login (or `passwordLogin`), or keep your auth library and give `auth: { verify, authorizationServers, sessions }`
  ([auth.md](auth.md)).
- **Origin.** `CLEGRA_PUBLIC_URL=https://jobs.example.com` per environment (Vercel previews have other hosts).
- **Store.** `SqlStore` over your Postgres (`SqlStore.schema()` in a migration): serverless functions share nothing
  in memory.
- **Confirm what you can't put back.** Tools that send, pay, share or delete get `confirm` (ACT-2).
- **Check.** `npx @clegra/sdk check https://jobs.example.com --token …` and read the level.
