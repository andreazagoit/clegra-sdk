import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { after, describe, test } from "node:test"
import { fileURLToPath } from "node:url"

import { checkApp } from "../check"
import { formatInit, InitError, runInit } from "./index"
import { wrapNextConfig } from "./next-config"
import { appNameOf, parseJsonc } from "./project"
import { linkSelf } from "../../../test/self-link"
import { UI_IMPORT, UI_RANGE, uiDependencies } from "./ui"

// clegra init on minimal fixture projects, each written into its own temp folder.

const made: string[] = []
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

function project(files: Record<string, string>, base = tmpdir()): string {
  const root = mkdtempSync(join(base, "clegra-init-"))
  made.push(root)
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

const read = (root: string, path: string) => readFileSync(join(root, path), "utf8")
const pkg = (extra: Record<string, unknown> = {}) => JSON.stringify({ name: "acme-tasks", private: true, scripts: { dev: "next dev" }, dependencies: { next: "16.4.6", react: "19.2.0", "@clegra/sdk": "^0.1.0", zod: "^4.0.0" }, ...extra })

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

describe("clegra init", () => {
  test("TypeScript, app/ at the root, next.config.ts: three files written, the config wrapped", () => {
    const root = project({ "package.json": pkg(), "tsconfig.json": TSCONFIG, "next.config.ts": NEXT_TS, "app/layout.tsx": LAYOUT, ".gitignore": "node_modules\n.env*\n" })
    const result = runInit({ cwd: root })
    assert.deepEqual(
      result.steps.map((s) => `${s.verb} ${s.path}`),
      ["create clegra/task.ts", "create clegra/list-tasks.ts", "create clegra/complete.ts", "create clegra/tasks.ts", "create clegra/app.ts", "create clegra/index.ts", "create app/api/clegra/[...path]/route.ts", "edit next.config.ts", "create proxy.ts", "create .env.local"],
    )
    assert.deepEqual(result.warnings, [])
    assert.match(read(root, "app/api/clegra/[...path]/route.ts"), /import \{ served \} from "@\/clegra"/)
    assert.match(read(root, "app/api/clegra/[...path]/route.ts"), /export const \{ GET, POST, DELETE, OPTIONS \} = toNextHandlers\(served\)/)
    assert.equal(
      read(root, "next.config.ts"),
      NEXT_TS.replace('from "next";\n', 'from "next";\nimport { withClegra } from "@clegra/sdk/next";\n').replace("export default nextConfig;", "export default withClegra(nextConfig);"),
    )
    const app = read(root, "clegra/app.ts")
    assert.match(app, /name: "acme-tasks"/)
    assert.match(app, /title: "Acme Tasks"/)
    assert.match(app, /entities: \[task\]/)
    assert.match(app, /tools: \[listTasks, complete\]/)
    assert.match(read(root, "clegra/task.ts"), /path: "\/tasks\/\{id\}"/)
    assert.match(read(root, "clegra/complete.ts"), /on: "record",/)
    assert.match(read(root, "proxy.ts"), /export const proxy = recordProxy\(\)/)
    assert.match(read(root, "clegra/index.ts"), /devSignIn\(app/)
    assert.match(read(root, "clegra/index.ts"), /createSignIn/)
    assert.match(read(root, "clegra/task.ts"), /TODO\(your data\)/)
    assert.match(read(root, "clegra/index.ts"), /TODO\(your sign-in\)/)
    assert.match(read(root, "clegra/index.ts"), /export function served\(\): ServedApp \{/)
    const code = /^CLEGRA_DEV_CODE=(.+)$/m.exec(read(root, ".env.local"))?.[1]
    assert.equal(code, result.code)
    assert.match(code!, /^[0-9A-F]{12}$/)
    const printed = formatInit(result, false)
    assert.match(printed, /Next\.js 16\.4\.6, App Router in app\/, TypeScript, alias @\/\*, next\.config\.ts/)
    assert.match(printed, new RegExp(`development login \\(code ${code}\\)`))
    assert.match(printed, /npx @clegra\/sdk check http:\/\/localhost:3000 --token/)
  })

  test("next.config.mjs and src/app with an alias to src/: clegra/ goes to src/", () => {
    const mjs = `/** @type {import('next').NextConfig} */\nconst nextConfig = {};\n\nexport default nextConfig;\n`
    const root = project({
      "package.json": pkg({ scripts: { dev: "next dev --turbopack -p 4100" } }),
      "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "~/*": ["./src/*"] } } }),
      "next.config.mjs": mjs,
      "src/app/page.tsx": "export default function Page() { return null }\n",
      ".gitignore": ".env*.local\n",
    })
    const result = runInit({ cwd: root })
    assert.deepEqual(result.steps.map((s) => `${s.verb} ${s.path}`), ["create src/clegra/task.ts", "create src/clegra/list-tasks.ts", "create src/clegra/complete.ts", "create src/clegra/tasks.ts", "create src/clegra/app.ts", "create src/clegra/index.ts", "create src/app/api/clegra/[...path]/route.ts", "edit next.config.mjs", "create src/proxy.ts", "create .env.local"])
    assert.match(read(root, "src/app/api/clegra/[...path]/route.ts"), /from "~\/clegra"/)
    // No import to follow: the import goes first; the file's own quotes and semicolons are kept.
    assert.equal(read(root, "next.config.mjs"), `import { withClegra } from '@clegra/sdk/next';\n${mjs.replace("export default nextConfig;", "export default withClegra(nextConfig);")}`)
    assert.match(formatInit(result, false), /http:\/\/localhost:4100\/mcp/)
  })

  test("src/app without an alias: a relative import", () => {
    const root = project({ "package.json": pkg(), "tsconfig.json": "{}", "src/app/page.tsx": "", ".gitignore": ".env.local\n" })
    const result = runInit({ cwd: root })
    assert.match(read(root, "src/app/api/clegra/[...path]/route.ts"), /from "\.\.\/\.\.\/\.\.\/\.\.\/clegra"/)
    // No next.config: one is created.
    assert.ok(result.steps.some((s) => s.verb === "create" && s.path === "next.config.ts"))
    assert.match(read(root, "next.config.ts"), /export default withClegra\(nextConfig\)/)
  })

  test("already initialized: nothing is overwritten, every step is a skip", () => {
    const root = project({ "package.json": pkg(), "tsconfig.json": TSCONFIG, "next.config.ts": NEXT_TS, "app/page.tsx": "", ".gitignore": ".env*\n" })
    const first = runInit({ cwd: root })
    writeFileSync(join(root, "clegra/app.ts"), "// mine\n")
    const before = Object.fromEntries(["clegra/app.ts", "app/api/clegra/[...path]/route.ts", "next.config.ts", "proxy.ts", ".env.local"].map((p) => [p, read(root, p)]))
    const second = runInit({ cwd: root })
    assert.deepEqual(second.steps.map((s) => s.verb), ["skip", "skip", "skip", "skip", "skip"])
    for (const [p, text] of Object.entries(before)) assert.equal(read(root, p), text, p)
    assert.equal(second.code, first.code)
  })

  test("an existing .env.local keeps its lines; the code is appended", () => {
    const root = project({ "package.json": pkg(), "tsconfig.json": TSCONFIG, "app/page.tsx": "", ".env.local": "DATABASE_URL=postgres://localhost/acme", ".gitignore": ".env*\n" })
    const result = runInit({ cwd: root })
    assert.ok(result.steps.some((s) => s.verb === "edit" && s.path === ".env.local"))
    assert.match(read(root, ".env.local"), /^DATABASE_URL=postgres:\/\/localhost\/acme\n\n# clegra: .*\nCLEGRA_DEV_CODE=/)
  })

  test("a config written across lines is not edited: the edit is printed", () => {
    const config = `import type { NextConfig } from "next"\n\nexport default {\n  reactStrictMode: true,\n} satisfies NextConfig\n`
    const root = project({ "package.json": pkg(), "tsconfig.json": TSCONFIG, "next.config.ts": config, "app/page.tsx": "", ".gitignore": ".env*\n" })
    const result = runInit({ cwd: root })
    const step = result.steps.find((s) => s.path === "next.config.ts")!
    assert.equal(step.verb, "by hand")
    assert.match(step.how!, /export default withClegra\(<your config>\)/)
    assert.equal(read(root, "next.config.ts"), config)
    assert.match(formatInit(result, false), /by hand {2}next\.config\.ts {2}\(not edited: the exported config spans several lines/)
  })

  test("JavaScript with a CommonJS next.config.js; warnings for a proxy, basePath and a missing .gitignore rule", () => {
    const cjs = `/** @type {import('next').NextConfig} */\nconst nextConfig = { basePath: "/docs" }\nmodule.exports = nextConfig\n`
    const root = project({ "package.json": pkg({ dependencies: { next: "^16.0.0" } }), "next.config.js": cjs, "app/page.jsx": "", "proxy.js": "export function proxy() {}\n" })
    const result = runInit({ cwd: root })
    assert.deepEqual(result.steps.map((s) => `${s.verb} ${s.path}`), ["create clegra/task.js", "create clegra/list-tasks.js", "create clegra/complete.js", "create clegra/tasks.js", "create clegra/app.js", "create clegra/index.js", "create app/api/clegra/[...path]/route.js", "edit next.config.js", "by hand proxy.js", "create .env.local"])
    assert.equal(read(root, "next.config.js"), `const { withClegra } = require("@clegra/sdk/next")\n${cjs.replace("module.exports = nextConfig", "module.exports = withClegra(nextConfig)")}`)
    for (const f of ["task", "list-tasks", "complete", "tasks", "app", "index"]) assert.doesNotMatch(read(root, `clegra/${f}.js`), /: string|type Task|as keyof/, f)
    assert.match(result.steps.find((s) => s.path === "proxy.js")!.how!, /recordProxy/)
    assert.match(read(root, "app/api/clegra/[...path]/route.js"), /from "\.\.\/\.\.\/\.\.\/\.\.\/clegra"/)
    assert.equal(result.warnings.length, 3)
    assert.match(result.warnings.join("\n"), /basePath/)
    assert.match(result.warnings.join("\n"), /\.gitignore/)
    assert.match(result.warnings.join("\n"), /proxy\.js runs before every route/)
    assert.match(result.next[0]!, /^npm i @clegra\/sdk zod$/)
  })

  test("--dry-run writes nothing", () => {
    const root = project({ "package.json": pkg(), "tsconfig.json": TSCONFIG, "next.config.ts": NEXT_TS, "app/page.tsx": "", ".gitignore": ".env*\n" })
    const result = runInit({ cwd: root, dryRun: true })
    assert.equal(result.steps.length, 10)
    for (const p of ["clegra", "app/api", "proxy.ts", ".env.local"]) assert.equal(existsSync(join(root, p)), false, p)
    assert.equal(read(root, "next.config.ts"), NEXT_TS)
    assert.match(formatInit(result, true), /--dry-run \(nothing written\)[\s\S]*code <generated on a real run>/)
  })

  test("not a Next.js App Router project: a clear error, nothing written", () => {
    assert.throws(() => runInit({ cwd: project({ "index.js": "" }) }), (e: unknown) => e instanceof InitError && /no package\.json/.test(e.message))
    assert.throws(() => runInit({ cwd: project({ "package.json": JSON.stringify({ name: "x", dependencies: { express: "5" } }) }) }), (e: unknown) => e instanceof InitError && /has no "next" dependency/.test(e.message))
    const pages = project({ "package.json": pkg(), "pages/index.tsx": "" })
    assert.throws(() => runInit({ cwd: pages }), (e: unknown) => e instanceof InitError && /needs the App Router/.test(e.message))
    assert.equal(existsSync(join(pages, "clegra")), false)
  })

  test("helpers: config edits only when certain, app ids, JSON with comments", () => {
    assert.equal(wrapNextConfig("export default withClegra({})\n").kind, "already")
    assert.equal(wrapNextConfig("export default async (phase) => {\n  return {}\n}\n").kind, "manual")
    assert.equal(wrapNextConfig("export default function config() {\n  return {}\n}\n").kind, "manual")
    assert.equal(wrapNextConfig("const a = {}\nexport default a\nexport default a\n").kind, "manual")
    const fn = wrapNextConfig("// @ts-check\nexport default (phase) => ({ reactStrictMode: phase !== 'x' })\n")
    assert.deepEqual(fn, { kind: "edited", text: "// @ts-check\nimport { withClegra } from '@clegra/sdk/next'\nexport default withClegra((phase) => ({ reactStrictMode: phase !== 'x' }))\n" })
    assert.equal(appNameOf("@acme/Billing_Portal"), "billing-portal")
    assert.equal(appNameOf("1"), "my-app")
    assert.deepEqual(parseJsonc('{ "a": "http://x//y", /* c */ "b": [1,], }'), { a: "http://x//y", b: [1] })
  })
})

describe("the generated clegra/", () => {
  // Written inside this package so that `@clegra/sdk` (test/self-link.ts) and `zod` resolve; removed afterwards.
  const here = dirname(fileURLToPath(import.meta.url))
  linkSelf()

  test("serves the web map: level A and C (one sign-in) on its sample data", async () => {
    const root = project({ "package.json": pkg(), "tsconfig.json": TSCONFIG, "next.config.ts": NEXT_TS, "app/page.tsx": "", ".gitignore": ".env*\n" }, here)
    runInit({ cwd: root })
    // The generated index (development sign-in) loads and serves its Server Card.
    const { served } = (await import(join(root, "clegra/index.ts"))) as { served: () => { fetch: (r: Request) => Promise<Response> } }
    assert.equal((await served().fetch(new Request("http://localhost:3000/mcp/server-card"))).status, 200)
    // The same app, served here with a development sign-in whose tokens the test can make.
    const { app } = (await import(join(root, "clegra/app.ts"))) as { app: import("../../app").App }
    const { serve } = await import("../../server")
    const { devSignIn } = await import("../../signin/dev")
    const signIn = devSignIn(app, { issuer: "http://localhost:3000" })
    const mine = serve(app, { origin: "http://localhost:3000", auth: { signIn } })
    const report = await checkApp({ url: "http://localhost:3000", token: await signIn.dev.token(), fetch: (input, init) => mine.fetch(new Request(input, init)) })
    assert.deepEqual(report.checks.filter((c) => c.ok === false), [])
    assert.deepEqual(report.levels, ["A", "C"])
    assert.equal(report.checks.find((c) => c.id === "A.record-round-trip")?.ok, true)
  })
})

describe("clegra init --ui", () => {
  const files = (extra: Record<string, string> = {}) => ({ "package.json": pkg({ devDependencies: { tailwindcss: "^4", "@tailwindcss/postcss": "^4" } }), "tsconfig.json": TSCONFIG, "next.config.ts": NEXT_TS, "app/layout.tsx": LAYOUT, ".gitignore": ".env*\n", ...extra })

  test("--ui adds @clegra/ui and its web libraries, without React Native's, React's, Tailwind's or the server's", () => {
    const deps = uiDependencies()
    assert.equal(deps["@clegra/ui"], UI_RANGE)
    for (const name of ["@base-ui/react", "lucide-react", "class-variance-authority", "cn"]) assert.ok(deps[name], name)
    for (const name of ["react", "react-dom", "react-native", "@expo/ui", "zod", "next", "tailwindcss", "@clegra/sdk"]) assert.equal(deps[name], undefined, name)
  })

  test("Tailwind 4 in globals.css: @clegra/ui's stylesheet after it, the libraries in dependencies, npm install next", () => {
    const root = project(files({ "app/globals.css": '@import "tailwindcss";\n\nbody { margin: 0 }\n' }))
    const result = runInit({ cwd: root, ui: true })
    assert.ok(result.steps.some((s) => s.verb === "edit" && s.path === "package.json"))
    assert.ok(result.steps.some((s) => s.verb === "edit" && s.path === "app/globals.css"))
    assert.equal(read(root, "app/globals.css"), `@import "tailwindcss";\n${UI_IMPORT}\n\nbody { margin: 0 }\n`)
    const deps = JSON.parse(read(root, "package.json")).dependencies as Record<string, string>
    for (const [name, range] of Object.entries(uiDependencies())) assert.equal(deps[name], range, name)
    assert.equal(deps.react, "19.2.0", "what was there stays")
    assert.ok(result.next.some((n) => n.startsWith("npm install")))
    // Run again: nothing more to do.
    const again = runInit({ cwd: root, ui: true })
    assert.deepEqual(again.steps.filter((s) => ["package.json", "app/globals.css"].includes(s.path)).map((s) => s.verb), ["skip", "skip"])
  })

  test("no Tailwind import, or no stylesheet: by hand, with both ways; --dry-run writes nothing", () => {
    const plain = project(files({ "app/globals.css": "body { margin: 0 }\n" }))
    const before = read(plain, "package.json")
    const dry = runInit({ cwd: plain, ui: true, dryRun: true })
    assert.equal(read(plain, "package.json"), before)
    const step = dry.steps.find((s) => s.path === "app/globals.css")
    assert.equal(step?.verb, "by hand")
    assert.match(step?.how ?? "", /@clegra\/ui\/styles\.css/)
    assert.match(step?.how ?? "", /@clegra\/ui\/prebuilt\.css/)
    const none = project(files())
    assert.equal(runInit({ cwd: none, ui: true }).steps.find((s) => s.path === "app/globals.css")?.verb, "by hand")
    assert.match(formatInit(dry, true), /by hand\s+app\/globals\.css/)
  })
})
