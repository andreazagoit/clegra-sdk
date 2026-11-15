import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { after, describe, test } from "node:test"
import { fileURLToPath } from "node:url"

import { checkApp } from "../conformance"
import { formatInit, InitError, runInit } from "./index"
import { wrapNextConfig } from "./next-config"
import { appNameOf, parseJsonc } from "./project"

// modelapp init on minimal fixture projects, each written into its own temp folder.

const made: string[] = []
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

function project(files: Record<string, string>, base = tmpdir()): string {
  const root = mkdtempSync(join(base, "modelapp-init-"))
  made.push(root)
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

const read = (root: string, path: string) => readFileSync(join(root, path), "utf8")
const pkg = (extra: Record<string, unknown> = {}) => JSON.stringify({ name: "acme-tasks", private: true, scripts: { dev: "next dev" }, dependencies: { next: "16.4.3", react: "19.2.0", modelapp: "^0.1.0", zod: "^4.0.0" }, ...extra })

// What create-next-app writes (TypeScript, App Router, no src/), tsconfig with a comment and a trailing comma.
const NEXT_TS = `import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
};

export default nextConfig;
`
const TSCONFIG = `{
  // what create-next-app writes, with a comment
  "compilerOptions": { "strict": true, "paths": { "@/*": ["./*"] }, },
}`
const LAYOUT = "export default function RootLayout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html> }\n"

describe("modelapp init", () => {
  test("TypeScript, app/ at the root, next.config.ts: three files written, the config wrapped", () => {
    const root = project({ "package.json": pkg(), "tsconfig.json": TSCONFIG, "next.config.ts": NEXT_TS, "app/layout.tsx": LAYOUT, ".gitignore": "node_modules\n.env*\n" })
    const result = runInit({ cwd: root })
    assert.deepEqual(
      result.steps.map((s) => `${s.verb} ${s.path}`),
      ["create modelapp.ts", "create app/api/modelapp/[...path]/route.ts", "edit next.config.ts", "create .env.local"],
    )
    assert.deepEqual(result.warnings, [])
    assert.match(read(root, "app/api/modelapp/[...path]/route.ts"), /import \{ app \} from "@\/modelapp"/)
    assert.match(read(root, "app/api/modelapp/[...path]/route.ts"), /export const \{ GET, POST, DELETE, OPTIONS \} = toNextHandlers\(app\)/)
    assert.equal(
      read(root, "next.config.ts"),
      NEXT_TS.replace('from "next";\n', 'from "next";\nimport { withModelApp } from "modelapp/next";\n').replace("export default nextConfig;", "export default withModelApp(nextConfig);"),
    )
    const app = read(root, "modelapp.ts")
    assert.match(app, /name: "acme-tasks"/)
    assert.match(app, /title: "Acme Tasks"/)
    assert.match(app, /TODO\(your data\)/)
    assert.match(app, /TODO\(your sign-in\)/)
    const token = /^MODELAPP_LOCAL_TOKEN=(.+)$/m.exec(read(root, ".env.local"))?.[1]
    assert.equal(token, result.token)
    assert.match(token!, /^[A-Za-z0-9_-]{43}$/)
    const printed = formatInit(result, false)
    assert.match(printed, /Next\.js 16\.4\.3, App Router in app\/, TypeScript, alias @\/\*, next\.config\.ts/)
    assert.match(printed, new RegExp(`npx modelapp check http://localhost:3000 --token ${token}`))
  })

  test("next.config.mjs and src/app with an alias to src/: modelapp.ts goes to src/", () => {
    const mjs = `/** @type {import('next').NextConfig} */\nconst nextConfig = {};\n\nexport default nextConfig;\n`
    const root = project({
      "package.json": pkg({ scripts: { dev: "next dev --turbopack -p 4100" } }),
      "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "~/*": ["./src/*"] } } }),
      "next.config.mjs": mjs,
      "src/app/page.tsx": "export default function Page() { return null }\n",
      ".gitignore": ".env*.local\n",
    })
    const result = runInit({ cwd: root })
    assert.deepEqual(result.steps.map((s) => `${s.verb} ${s.path}`), ["create src/modelapp.ts", "create src/app/api/modelapp/[...path]/route.ts", "edit next.config.mjs", "create .env.local"])
    assert.match(read(root, "src/app/api/modelapp/[...path]/route.ts"), /from "~\/modelapp"/)
    // No import to follow: the import goes first; the file's own quotes and semicolons are kept.
    assert.equal(read(root, "next.config.mjs"), `import { withModelApp } from 'modelapp/next';\n${mjs.replace("export default nextConfig;", "export default withModelApp(nextConfig);")}`)
    assert.match(formatInit(result, false), /http:\/\/localhost:4100\/mcp/)
  })

  test("src/app without an alias: a relative import", () => {
    const root = project({ "package.json": pkg(), "tsconfig.json": "{}", "src/app/page.tsx": "", ".gitignore": ".env.local\n" })
    const result = runInit({ cwd: root })
    assert.match(read(root, "src/app/api/modelapp/[...path]/route.ts"), /from "\.\.\/\.\.\/\.\.\/\.\.\/modelapp"/)
    // No next.config: one is created.
    assert.ok(result.steps.some((s) => s.verb === "create" && s.path === "next.config.ts"))
    assert.match(read(root, "next.config.ts"), /export default withModelApp\(nextConfig\)/)
  })

  test("already initialized: nothing is overwritten, every step is a skip", () => {
    const root = project({ "package.json": pkg(), "tsconfig.json": TSCONFIG, "next.config.ts": NEXT_TS, "app/page.tsx": "", ".gitignore": ".env*\n" })
    const first = runInit({ cwd: root })
    writeFileSync(join(root, "modelapp.ts"), "// mine\n")
    const before = Object.fromEntries(["modelapp.ts", "app/api/modelapp/[...path]/route.ts", "next.config.ts", ".env.local"].map((p) => [p, read(root, p)]))
    const second = runInit({ cwd: root })
    assert.deepEqual(second.steps.map((s) => s.verb), ["skip", "skip", "skip", "skip"])
    for (const [p, text] of Object.entries(before)) assert.equal(read(root, p), text, p)
    assert.equal(second.token, first.token)
  })

  test("an existing .env.local keeps its lines; the token is appended", () => {
    const root = project({ "package.json": pkg(), "tsconfig.json": TSCONFIG, "app/page.tsx": "", ".env.local": "DATABASE_URL=postgres://localhost/acme", ".gitignore": ".env*\n" })
    const result = runInit({ cwd: root })
    assert.ok(result.steps.some((s) => s.verb === "edit" && s.path === ".env.local"))
    assert.match(read(root, ".env.local"), /^DATABASE_URL=postgres:\/\/localhost\/acme\n\n# modelapp: .*\n.*\nMODELAPP_LOCAL_TOKEN=/)
  })

  test("a config written across lines is not edited: the edit is printed", () => {
    const config = `import type { NextConfig } from "next"\n\nexport default {\n  reactStrictMode: true,\n} satisfies NextConfig\n`
    const root = project({ "package.json": pkg(), "tsconfig.json": TSCONFIG, "next.config.ts": config, "app/page.tsx": "", ".gitignore": ".env*\n" })
    const result = runInit({ cwd: root })
    const step = result.steps.find((s) => s.path === "next.config.ts")!
    assert.equal(step.verb, "by hand")
    assert.match(step.how!, /export default withModelApp\(<your config>\)/)
    assert.equal(read(root, "next.config.ts"), config)
    assert.match(formatInit(result, false), /by hand {2}next\.config\.ts {2}\(not edited: the exported config spans several lines/)
  })

  test("JavaScript with a CommonJS next.config.js; warnings for a proxy, basePath and a missing .gitignore rule", () => {
    const cjs = `/** @type {import('next').NextConfig} */\nconst nextConfig = { basePath: "/docs" }\nmodule.exports = nextConfig\n`
    const root = project({ "package.json": pkg({ dependencies: { next: "^16.0.0" } }), "next.config.js": cjs, "app/page.jsx": "", "proxy.js": "export function proxy() {}\n" })
    const result = runInit({ cwd: root })
    assert.deepEqual(result.steps.map((s) => `${s.verb} ${s.path}`), ["create modelapp.js", "create app/api/modelapp/[...path]/route.js", "edit next.config.js", "create .env.local"])
    assert.equal(read(root, "next.config.js"), `const { withModelApp } = require("modelapp/next")\n${cjs.replace("module.exports = nextConfig", "module.exports = withModelApp(nextConfig)")}`)
    assert.doesNotMatch(read(root, "modelapp.js"), /: string|type Task|ResolvedCaller/)
    assert.match(read(root, "app/api/modelapp/[...path]/route.js"), /from "\.\.\/\.\.\/\.\.\/\.\.\/modelapp"/)
    assert.equal(result.warnings.length, 3)
    assert.match(result.warnings.join("\n"), /basePath/)
    assert.match(result.warnings.join("\n"), /\.gitignore/)
    assert.match(result.warnings.join("\n"), /proxy\.js runs before every route/)
    assert.match(result.next[0]!, /^npm i modelapp zod$/)
  })

  test("--dry-run writes nothing", () => {
    const root = project({ "package.json": pkg(), "tsconfig.json": TSCONFIG, "next.config.ts": NEXT_TS, "app/page.tsx": "", ".gitignore": ".env*\n" })
    const result = runInit({ cwd: root, dryRun: true })
    assert.equal(result.steps.length, 4)
    for (const p of ["modelapp.ts", "app/api", ".env.local"]) assert.equal(existsSync(join(root, p)), false, p)
    assert.equal(read(root, "next.config.ts"), NEXT_TS)
    assert.match(formatInit(result, true), /--dry-run \(nothing written\)[\s\S]*--token <generated on a real run>/)
  })

  test("not a Next.js App Router project: a clear error, nothing written", () => {
    assert.throws(() => runInit({ cwd: project({ "index.js": "" }) }), (e: unknown) => e instanceof InitError && /no package\.json/.test(e.message))
    assert.throws(() => runInit({ cwd: project({ "package.json": JSON.stringify({ name: "x", dependencies: { express: "5" } }) }) }), (e: unknown) => e instanceof InitError && /has no "next" dependency/.test(e.message))
    const pages = project({ "package.json": pkg(), "pages/index.tsx": "" })
    assert.throws(() => runInit({ cwd: pages }), (e: unknown) => e instanceof InitError && /needs the App Router/.test(e.message))
    assert.equal(existsSync(join(pages, "modelapp.ts")), false)
  })

  test("helpers: config edits only when certain, app ids, JSON with comments", () => {
    assert.equal(wrapNextConfig("export default withModelApp({})\n").kind, "already")
    assert.equal(wrapNextConfig("export default async (phase) => {\n  return {}\n}\n").kind, "manual")
    assert.equal(wrapNextConfig("export default function config() {\n  return {}\n}\n").kind, "manual")
    assert.equal(wrapNextConfig("const a = {}\nexport default a\nexport default a\n").kind, "manual")
    const fn = wrapNextConfig("// @ts-check\nexport default (phase) => ({ reactStrictMode: phase !== 'x' })\n")
    assert.deepEqual(fn, { kind: "edited", text: "// @ts-check\nimport { withModelApp } from 'modelapp/next'\nexport default withModelApp((phase) => ({ reactStrictMode: phase !== 'x' }))\n" })
    assert.equal(appNameOf("@acme/Billing_Portal"), "billing-portal")
    assert.equal(appNameOf("1"), "my-app")
    assert.deepEqual(parseJsonc('{ "a": "http://x//y", /* c */ "b": [1,], }'), { a: "http://x//y", b: [1] })
  })
})

describe("the generated modelapp.ts", () => {
  // Written inside this package so that `modelapp` and `zod` resolve; removed afterwards.
  const here = dirname(fileURLToPath(import.meta.url))
  // Writable here (Next's types make NODE_ENV read-only).
  const env = process.env as Record<string, string | undefined>
  const saved = { node: process.env.NODE_ENV, token: process.env.MODELAPP_LOCAL_TOKEN, site: process.env.MODELAPP_PUBLIC_URL }
  after(() => {
    for (const [key, value] of [["NODE_ENV", saved.node], ["MODELAPP_LOCAL_TOKEN", saved.token], ["MODELAPP_PUBLIC_URL", saved.site]] as const) {
      if (value === undefined) delete env[key]
      else env[key] = value
    }
  })

  test("serves its sample data to the local bearer, passes every check but the missing authorization server, and refuses the bearer in production", async () => {
    const root = project({ "package.json": pkg(), "tsconfig.json": TSCONFIG, "next.config.ts": NEXT_TS, "app/page.tsx": "", ".gitignore": ".env*\n" }, here)
    const { token } = runInit({ cwd: root })
    env.NODE_ENV = "development"
    process.env.MODELAPP_LOCAL_TOKEN = token!
    delete process.env.MODELAPP_PUBLIC_URL
    const { app } = (await import(join(root, "modelapp.ts"))) as { app: { fetch: (r: Request) => Promise<Response> } }
    const report = await checkApp({ url: "http://localhost:3000", token: token!, fetch: (r) => app.fetch(r) })
    const failed = report.checks.filter((c) => !c.ok)
    assert.deepEqual(failed.map((c) => c.id), ["auth.mcp"], JSON.stringify(failed))
    assert.match(failed[0]!.detail!, /names no authorization server/)
    assert.ok(report.checks.filter((c) => c.id.startsWith("mcp.")).every((c) => c.ok && !c.skipped))

    const call = (bearer: string, name: string, args: Record<string, unknown>) =>
      app.fetch(new Request("http://localhost:3000/mcp", { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }))
    const listed = await (await call(token!, "task_list", { status: "open" })).text()
    assert.match(listed, /Send the spring catalog to the printer/)
    assert.doesNotMatch(listed, /Archive last year/)
    assert.equal((await call("not-the-token", "task_list", {})).status, 401)

    // Production: without MODELAPP_PUBLIC_URL every request is a clear 500; with it, the local bearer is refused.
    env.NODE_ENV = "production"
    assert.equal((await call(token!, "task_list", {})).status, 500)
    process.env.MODELAPP_PUBLIC_URL = "https://tasks.example.test"
    // A second copy of the module: `resource` is read when the module loads.
    writeFileSync(join(root, "modelapp-production.ts"), read(root, "modelapp.ts"))
    const { app: prod } = (await import(join(root, "modelapp-production.ts"))) as { app: { fetch: (r: Request) => Promise<Response> } }
    const refused = await prod.fetch(new Request("https://tasks.example.test/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) }))
    assert.equal(refused.status, 401)
  })
})
