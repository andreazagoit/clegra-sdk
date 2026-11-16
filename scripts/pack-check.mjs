// THE PACK CHECK: the package as a stranger gets it from npm, outside this repository. Slow (one npm install, a
// Next.js dev run and a production build), so not in `npm test`:
//   npm run pack:check -- [--dir <empty folder outside the repo>] [--port 3946] [--keep]
// 1. `npm pack` (prepack builds dist/): the tarball's files, its package.json (private kept, every export and the
//    bin built), every relative import in dist resolving inside the tarball, the hygiene check of the public
//    packages, and the publish guard (an unapproved tarball is refused as private; `npm publish` is refused here).
// 2. A fresh Next.js App Router app (the repository's Next, React and TypeScript versions) with the tarball
//    installed: `npx modelapp init`, `next dev` + `npx modelapp check --token <the local bearer>`, then
//    `next build` + `next start` + `npx modelapp check` without a token (the local bearer is refused in
//    production). A fresh app fails exactly one check, `auth.mcp` (no authorization server yet: the quickstart).
// 3. A plain Node ESM script importing modelapp, modelapp/node, modelapp/testing, modelapp/spec (and the JSON
//    exports), running an app through testClient.
// 4. tsc on a TypeScript file importing every entry, with `moduleResolution` bundler and node16.
// The folder must have no node_modules or package.json above it (nothing of the repository may be picked up). The
// servers are stopped by PID; node_modules and .next are deleted at the end unless --keep.
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = resolve(pkgDir, "../..")
const { values } = parseArgs({ options: { dir: { type: "string" }, port: { type: "string", default: "3946" }, keep: { type: "boolean", default: false } } })
const port = Number(values.port)
if (!Number.isInteger(port) || port < 1024) throw new Error(`pack-check: --port ${values.port} is not a port`)
const npm = process.platform === "win32" ? "npm.cmd" : "npm"
const npx = process.platform === "win32" ? "npx.cmd" : "npx"

let failures = 0
const ok = (what) => console.log(`ok   ${what}`)
const fail = (what) => {
  failures++
  console.log(`FAIL ${what}`)
}
const expect = (cond, what) => (cond ? ok(what) : fail(what))
// Child npm runs as a stranger's would: without the npm_* settings an `npm run pack:check` passes down (they would
// make a nested `npm publish` act on this package's run, e.g. as a workspace).
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_/i.test(k)))
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts, env: { ...cleanEnv, ...(opts.env ?? {}) } })
const tail = (r) => `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n").slice(-4).join(" | ")

// ------------------------------------------------------------ the folder
const work = resolve(values.dir ?? mkdtempSync(join(tmpdir(), "modelapp-pack-check-")))
if (`${work}${sep}`.startsWith(`${repoRoot}${sep}`)) throw new Error(`pack-check: ${work} is inside the repository; use a folder outside it`)
for (let d = dirname(work); ; d = dirname(d)) {
  for (const f of ["node_modules", "package.json"]) if (existsSync(join(d, f))) throw new Error(`pack-check: ${join(d, f)} is above ${work}: Node and npm would pick it up; use another folder (--dir)`)
  if (dirname(d) === d) break
}
mkdirSync(work, { recursive: true })
if (readdirSync(work).length) throw new Error(`pack-check: ${work} is not empty`)
console.log(`pack-check in ${work}`)

// ------------------------------------------------------------ 1. the tarball
const packed = JSON.parse(execFileSync(npm, ["pack", "--json", "--pack-destination", work], { cwd: pkgDir, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }))[0]
const tarball = join(work, packed.filename)
const files = new Set(packed.files.map((f) => f.path))
console.log(`     ${packed.filename}: ${packed.entryCount} files, ${(packed.size / 1024).toFixed(1)} kB packed, ${(packed.unpackedSize / 1024).toFixed(1)} kB unpacked`)
const manifest = JSON.parse(execFileSync("tar", ["-xzOf", tarball, "package/package.json"], { encoding: "utf8" }))
expect(manifest.private === true, "tarball package.json keeps \"private\": true (not an approved release)")
expect(!manifest.scripts && !manifest.devDependencies, "tarball package.json has no scripts or devDependencies")
for (const f of ["README.md", "LICENSE", "CHANGELOG.md", "package.json", "dist/spec/schema/modelapp.schema.json", "dist/spec/kinds.json"]) expect(files.has(f), `tarball has ${f}`)
expect(![...files].some((f) => /\.ts$/.test(f) && !f.endsWith(".d.ts")), "tarball has no TypeScript source")
expect(![...files].some((f) => /\.test\.|^test\/|^scripts\//.test(f)), "tarball has no tests or scripts")
const targets = [...Object.values(manifest.exports).flatMap((e) => (typeof e === "string" ? [e] : [e.types, e.default])), ...Object.values(manifest.bin)].map((p) => p.replace(/^\.\//, ""))
for (const t of targets) expect(files.has(t), `export/bin target ${t} is in the tarball`)
expect(Object.values(manifest.exports).every((e) => typeof e === "string" || Object.keys(e).join() === "types,default"), "every code export has types then default")
const dist = join(pkgDir, "dist")
let unresolved = []
for (const f of [...files].filter((f) => /\.(js|d\.ts)$/.test(f))) {
  const text = readFileSync(join(pkgDir, f), "utf8")
  for (const m of text.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) {
    const target = relative(pkgDir, resolve(dirname(join(pkgDir, f)), m[1].replace(/\.js$/, f.endsWith(".d.ts") ? ".d.ts" : ".js")))
    if (!files.has(target)) unresolved.push(`${f} → ${m[1]}`)
  }
}
expect(unresolved.length === 0, `every relative import in dist resolves inside the tarball${unresolved.length ? `: ${unresolved.slice(0, 5).join(", ")}` : ""}`)
expect(existsSync(dist), "dist/ was built")
const { checkTarball } = await import(join(repoRoot, "scripts/packages/hygiene.mjs"))
const findings = checkTarball(tarball)
expect(findings.length === 0, `hygiene check (nothing internal ships)${findings.length ? `:\n       ${findings.join("\n       ")}` : ""}`)
// The guard. A registry on a closed local port with a dummy token: nothing can be uploaded anywhere.
const registry = `http://127.0.0.1:${port + 2}/`
const fake = run(npm, ["publish", tarball, "--registry", registry, `--//127.0.0.1:${port + 2}/:_authToken=not-a-token`, "--force"], { cwd: work })
expect(fake.status !== 0 && /EPRIVATE/.test(fake.stdout + fake.stderr), `npm publish of an unapproved tarball is refused (EPRIVATE)${/EPRIVATE/.test(fake.stdout + fake.stderr) ? "" : `: ${tail(fake)}`}`)
const refused = run(process.execPath, [join(pkgDir, "scripts/prepack.mjs")], { cwd: pkgDir, env: { npm_command: "publish", npm_config_dry_run: "" } })
expect(refused.status === 1 && /not published/.test(refused.stderr), "npm publish from the package folder is refused by prepack")
const dry = run(npm, ["publish", "--dry-run", tarball], { cwd: work })
expect(dry.status === 0 && /\(dry-run\)/.test(dry.stdout + dry.stderr), `npm publish --dry-run of the tarball runs (uploads nothing)${dry.status === 0 ? "" : `: ${tail(dry)}`}`)

// ------------------------------------------------------------ 2. a fresh Next.js app
const version = (name) => createRequire(join(repoRoot, "package.json"))(`${name}/package.json`).version
const app = join(work, "next-app")
mkdirSync(join(app, "app"), { recursive: true })
writeFileSync(
  join(app, "package.json"),
  `${JSON.stringify(
    {
      name: "pack-check-app",
      private: true,
      scripts: { dev: "next dev", build: "next build", start: "next start" },
      dependencies: { modelapp: `file:../${packed.filename}`, next: version("next"), react: version("react"), "react-dom": version("react-dom"), zod: version("zod") },
      devDependencies: { typescript: version("typescript"), "@types/node": version("@types/node"), "@types/react": version("@types/react") },
    },
    null,
    2,
  )}\n`,
)
writeFileSync(join(app, ".gitignore"), "node_modules\n.next\n.env*.local\n")
writeFileSync(join(app, "next.config.ts"), 'import type { NextConfig } from "next"\n\nconst nextConfig: NextConfig = {}\n\nexport default nextConfig\n')
writeFileSync(
  join(app, "tsconfig.json"),
  `${JSON.stringify(
    {
      compilerOptions: { target: "ES2022", lib: ["dom", "dom.iterable", "esnext"], allowJs: false, skipLibCheck: true, strict: true, noEmit: true, esModuleInterop: true, module: "esnext", moduleResolution: "bundler", resolveJsonModule: true, isolatedModules: true, jsx: "react-jsx", incremental: false, plugins: [{ name: "next" }], paths: { "@/*": ["./*"] } },
      include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
      exclude: ["node_modules", "check"],
    },
    null,
    2,
  )}\n`,
)
writeFileSync(join(app, "app", "layout.tsx"), 'export default function RootLayout({ children }: { children: React.ReactNode }) {\n  return (\n    <html lang="en">\n      <body>{children}</body>\n    </html>\n  )\n}\n')
writeFileSync(join(app, "app", "page.tsx"), "export default function Home() {\n  return <main>Hello</main>\n}\n")
const install = run(npm, ["install", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: app, stdio: ["ignore", "pipe", "pipe"] })
if (install.status !== 0) throw new Error(`pack-check: npm install failed:\n${install.stderr}`)
ok("fresh Next.js app installed with the tarball")
const installed = join(app, "node_modules", "modelapp")
expect(existsSync(join(installed, "dist/spec/src/cli.js")) && !existsSync(join(installed, "src")), "node_modules/modelapp holds the built package only")

const init = run(npx, ["modelapp", "init"], { cwd: app })
expect(init.status === 0 && /create\s+modelapp\.ts/.test(init.stdout) && /edit\s+next\.config\.ts/.test(init.stdout), "npx modelapp init (the CLI from the tarball): modelapp.ts, the route, next.config, .env.local")
if (init.status !== 0) console.log(init.stdout + init.stderr)
const token = /^MODELAPP_LOCAL_TOKEN=(.+)$/m.exec(readFileSync(join(app, ".env.local"), "utf8"))?.[1]?.trim()
expect(Boolean(token), ".env.local has the local bearer")

const running = new Set()
const stop = (child) => {
  if (child.pid && child.exitCode === null) {
    try {
      process.kill(-child.pid, "SIGTERM")
    } catch {}
  }
  running.delete(child)
}
process.on("exit", () => running.forEach(stop))
const nextBin = join(app, "node_modules", "next", "dist", "bin", "next")
async function serve(mode, p) {
  const base = `http://localhost:${p}`
  let output = ""
  const child = spawn(process.execPath, [nextBin, mode, "-p", String(p)], { cwd: app, detached: true, env: { ...process.env, MODELAPP_PUBLIC_URL: base, NEXT_TELEMETRY_DISABLED: "1", NODE_ENV: mode === "dev" ? "development" : "production" }, stdio: ["ignore", "pipe", "pipe"] })
  running.add(child)
  child.stdout.on("data", (d) => (output += d))
  child.stderr.on("data", (d) => (output += d))
  const deadline = Date.now() + 120_000
  for (;;) {
    if (child.exitCode !== null) throw new Error(`pack-check: next ${mode} exited:\n${output}`)
    try {
      if ((await fetch(`${base}/.well-known/modelapp.json`)).ok) break
    } catch {}
    if (Date.now() > deadline) throw new Error(`pack-check: next ${mode} did not answer:\n${output}`)
    await new Promise((r) => setTimeout(r, 400))
  }
  return { base, child, log: () => output }
}
/** `npx modelapp check`: the failed check ids. */
function check(base, withToken) {
  const r = run(npx, ["modelapp", "check", base, ...(withToken ? ["--token", token] : [])], { cwd: app, env: { MODELAPP_TOKEN: "" } })
  return { status: r.status, out: r.stdout + r.stderr, failed: r.stdout.split("\n").filter((l) => l.startsWith("FAIL ")) }
}

const devServer = await serve("dev", port)
const devCheck = check(devServer.base, true)
expect(devCheck.status === 1 && /auth\.mcp/.test(devCheck.out) && /NOT conformant|not conformant/i.test(devCheck.out), "next dev: npx modelapp check --token runs every check; the fresh app fails auth.mcp (no authorization server yet)")
const devFailed = devCheck.failed
expect(devFailed.length === 1 && /auth\.mcp/.test(devFailed[0] ?? ""), `next dev: auth.mcp is the only failed check${devFailed.length !== 1 ? `:\n${devCheck.out}` : ""}`)
stop(devServer.child)
rmSync(join(app, ".next"), { recursive: true, force: true })

const build = run(process.execPath, [nextBin, "build"], { cwd: app, env: { NEXT_TELEMETRY_DISABLED: "1", MODELAPP_PUBLIC_URL: `http://localhost:${port + 1}` } })
expect(build.status === 0, "next build (next.config imports modelapp/next from node_modules)")
if (build.status !== 0) console.log(build.stdout + build.stderr)
else {
  const startServer = await serve("start", port + 1)
  const startCheck = check(startServer.base, false)
  const startFailed = startCheck.failed
  expect(startCheck.status === 1 && startFailed.length === 1 && /auth\.mcp/.test(startFailed[0] ?? ""), `next start: npx modelapp check (no token: the local bearer is refused in production) fails auth.mcp only${startFailed.length !== 1 ? `:\n${startCheck.out}` : ""}`)
  const refusedToken = await fetch(`${startServer.base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })
  expect(refusedToken.status === 401, "next start: the local bearer is refused (401)")
  stop(startServer.child)
}

// ------------------------------------------------------------ 3. plain Node ESM
const probe = join(app, "check")
mkdirSync(probe, { recursive: true })
writeFileSync(
  join(probe, "esm.mjs"),
  `import { defineApp, MemoryStore, SPEC_VERSION, KINDS } from "modelapp"
import { listen } from "modelapp/node"
import { testClient } from "modelapp/testing"
import { checkApp, formatReport } from "modelapp/spec"
import { withModelApp, toNextHandlers } from "modelapp/next"
import { createRequire } from "node:module"
import { z } from "zod"
const require = createRequire(import.meta.url)
const schema = require("modelapp/modelapp.schema.json")
const kinds = require("modelapp/kinds.json")
const app = defineApp({
  name: "probe", title: "Probe", version: "1.0.0",
  auth: { dev: { keyFile: new URL("./dev-key.json", import.meta.url).pathname } },
  entities: { note: { label: "Note", schema: z.object({ id: z.string(), title: z.string().meta({ role: "title" }) }), get: () => ({ id: "n1", title: "Hello" }), list: () => ({ rows: [{ id: "n1", title: "Hello" }] }) } },
})
const client = await testClient(app)
const tools = await client.listTools()
const out = { spec: SPEC_VERSION, kinds: Object.keys(KINDS).length > 0, store: typeof MemoryStore, listen: typeof listen, checkApp: typeof checkApp, formatReport: typeof formatReport, next: typeof withModelApp + typeof toNextHandlers, schema: typeof schema.$schema, kindsJson: typeof kinds, tools: tools.map((t) => t.name).sort() }
console.log(JSON.stringify(out))
`,
)
const esm = run(process.execPath, [join(probe, "esm.mjs")], { cwd: probe })
let esmOut = null
try {
  esmOut = JSON.parse(esm.stdout.trim().split("\n").pop())
} catch {}
expect(esm.status === 0 && esmOut?.tools?.includes("note_list") && esmOut.checkApp === "function" && esmOut.listen === "function" && esmOut.schema === "string", `plain Node ESM imports every entry and runs an app${esm.status !== 0 || !esmOut ? `:\n${esm.stdout}${esm.stderr}` : ""}`)

// ------------------------------------------------------------ 4. TypeScript consumers
// next.ts: every entry, as an app's code imports them (skipLibCheck on, as in every Next app: Next's own .d.ts
// files need the DOM and react-dom types). core.ts: the entries that don't import next, with skipLibCheck OFF and
// no DOM lib, so modelapp's own .d.ts files are type-checked too.
const core = `import { defineApp, type App, type ResolvedCaller, type Manifest } from "modelapp"
import { listen } from "modelapp/node"
import { testClient } from "modelapp/testing"
import { checkApp, type Report } from "modelapp/spec"
import { z } from "zod"
export const app: App = defineApp({ name: "probe", title: "Probe", version: "1.0.0", auth: { resolve: async (): Promise<ResolvedCaller | null> => null }, entities: {} })
export const manifest: Manifest = app.manifest()
export const fns = [listen, testClient, checkApp] as const
export type CheckReport = Report
export const s = z.string()
`
writeFileSync(join(probe, "core.ts"), core)
writeFileSync(join(probe, "next.ts"), `${core}import { toNextHandlers, withModelApp, type NextHandlers } from "modelapp/next"
export const handlers: NextHandlers = toNextHandlers(app)
export const config = withModelApp({})
`)
const tsc = join(app, "node_modules", "typescript", "bin", "tsc")
for (const [mode, module] of [["bundler", "esnext"], ["node16", "node16"]]) {
  if (mode === "node16") writeFileSync(join(probe, "package.json"), '{ "type": "module" }\n')
  for (const [file, strictLibs] of [["core.ts", true], ["next.ts", false]]) {
    const config = join(probe, `tsconfig.${mode}.${file}.json`)
    const lib = strictLibs ? ["ES2023"] : ["ES2023", "DOM", "DOM.Iterable"]
    writeFileSync(config, `${JSON.stringify({ compilerOptions: { target: "ES2022", lib, types: ["node"], module, moduleResolution: mode, strict: true, noEmit: true, skipLibCheck: !strictLibs }, files: [file] }, null, 2)}\n`)
    const r = run(process.execPath, [tsc, "-p", config], { cwd: probe })
    expect(r.status === 0, `tsc, moduleResolution ${mode}: ${file}${strictLibs ? " (skipLibCheck off, no DOM: modelapp's .d.ts type-check)" : " (modelapp/next too)"}${r.status !== 0 ? `:\n${r.stdout}${r.stderr}` : ""}`)
  }
}

// ------------------------------------------------------------ done
if (!values.keep) {
  rmSync(join(app, "node_modules"), { recursive: true, force: true })
  rmSync(join(app, ".next"), { recursive: true, force: true })
}
console.log(failures ? `\npack-check: ${failures} FAILED (${work})` : `\npack-check: all passed (${work}${values.keep ? ", kept" : ", node_modules and .next deleted"})`)
process.exit(failures ? 1 : 0)
