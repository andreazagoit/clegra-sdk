// THE PACK CHECK: the package as a stranger gets it from npm, outside this repository. Slow (one npm install, a
// Next.js dev run and a production build), so not in `npm test`:
//   npm run pack:check -- [--dir <empty folder outside the repo>] [--port 3946] [--keep]
// 1. `npm pack` (prepack builds dist/): the tarball's files, its package.json (every export and the bin built, no
//    devDependencies, workspaces or overrides, only the "postpublish" script), every relative import in dist resolving
//    inside the tarball, the hygiene check (scripts/hygiene.mjs), and the publish guard (dry runs: a prerelease
//    without a dist-tag is refused, `--tag next` passes; nothing is uploaded), the repository's package.json back.
//    clegra/ui: dist/ui's files, the reserved components closed and absent, the repository-only entries absent.
// 2. A Node-only app (no React anywhere): the tarball and zod installed, no React, React DOM or UI library in its
//    tree (clegra/ui's libraries are optional peers), `clegra` and `clegra/node` imported and run.
// 3. A fresh Next.js App Router app with Tailwind 4 (the repository's Next, React, TypeScript and Tailwind versions)
//    with the tarball installed: `npx clegra init --ui` (+ `npm install` of the UI libraries it adds), a page drawn
//    with clegra/ui's Button and Card; `next dev` + `npx clegra check --token <the local bearer>`, then
//    `next build` + `next start`: the page renders the components and its stylesheet has their classes and the
//    theme; `npx clegra check` without a token (the local bearer is refused in production). A fresh app fails
//    exactly one check, `auth.mcp` (no authorization server yet: the quickstart).
// 4. A plain Node ESM script importing clegra, clegra/node, clegra/testing, clegra/spec (and the JSON
//    exports), running an app through testClient.
// 5. tsc on TypeScript files importing every entry (clegra/ui's too), with `moduleResolution` bundler and node16.
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
const repoRoot = pkgDir
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
const work = resolve(values.dir ?? mkdtempSync(join(tmpdir(), "clegra-pack-check-")))
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
const repoManifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"))
expect(!("private" in manifest) && manifest.version === repoManifest.version && /-/.test(manifest.version), `tarball package.json: publishable, the repository's version ${repoManifest.version} (a prerelease)`)
expect(JSON.stringify(manifest.scripts) === JSON.stringify({ postpublish: repoManifest.scripts.postpublish }) && !manifest.devDependencies && !manifest.workspaces && !manifest.overrides, "tarball package.json: no devDependencies, workspaces or overrides; of the scripts only postpublish")
expect(repoManifest.exports["."] === "./src/index.ts" && !existsSync(join(pkgDir, ".package.repo.json")), "after npm pack the repository's package.json is back (exports the TypeScript source)")
for (const f of ["README.md", "LICENSE", "NOTICE.md", "CHANGELOG.md", "package.json", "docs/spec.md", "docs/quickstart.md", "dist/spec/schema/clegra.schema.json", "dist/spec/kinds.json"]) expect(files.has(f), `tarball has ${f}`)
expect(![...files].some((f) => /^docs\//.test(f) && !["docs/spec.md", "docs/quickstart.md"].includes(f)) && ![...files].some((f) => /^examples\//.test(f)), "tarball has docs/spec.md and docs/quickstart.md only of the docs, and no example")
expect(![...files].some((f) => /\.ts$/.test(f) && !f.endsWith(".d.ts")), "tarball has no TypeScript source")
expect(![...files].some((f) => /\.test\.|^test\/|^scripts\//.test(f)), "tarball has no tests or scripts")
const leaves = (e) => (e === null ? [] : typeof e === "string" ? [e] : Object.values(e).flatMap(leaves))
const targets = [...Object.values(manifest.exports).flatMap(leaves), ...Object.values(manifest.bin)].map((p) => p.replace(/^\.\//, ""))
const matches = (t) => {
  if (!t.includes("*")) return files.has(t)
  const [before, after] = t.split("*")
  return [...files].some((f) => f.startsWith(before) && f.endsWith(after) && !f.slice(before.length, f.length - after.length).includes("/"))
}
const missingTargets = targets.filter((t) => !matches(t))
expect(missingTargets.length === 0, `every export/bin target (${targets.length}, patterns included) is in the tarball${missingTargets.length ? `: ${missingTargets.slice(0, 5).join(", ")}` : ""}`)
/** Every condition object: "default" last, "types" before it (a platform's nested object may come first). */
const shaped = (e) => {
  if (e === null || typeof e === "string") return true
  const keys = Object.keys(e)
  return keys.at(-1) === "default" && (!keys.includes("types") || keys.indexOf("types") === keys.length - 2 || keys.indexOf("types") < keys.indexOf("default")) && Object.values(e).every(shaped)
}
expect(Object.values(manifest.exports).every(shaped), "every condition object of the exports has types before default, default last")
// clegra/ui
const { RESERVED_COMPONENTS } = await import("./ui.mjs")
expect(["dist/ui/styles.css", "dist/ui/theme.css", "dist/ui/shadcn.css", "dist/ui/brand/theme.css", "dist/ui/brand/colors.css", "dist/ui/prebuilt.css", "dist/ui/metro.cjs", "dist/ui/components/button.js", "dist/ui/components/button.d.ts", "dist/ui/components/button.native.js", "dist/ui/frame/index.js", "dist/ui/tokens.js"].every((f) => files.has(f)), "clegra/ui: the stylesheets, the brand's palette, prebuilt.css, metro.cjs, components (web and native), frame, tokens")
expect(/^"use client";/.test(execFileSync("tar", ["-xzOf", tarball, "package/dist/ui/components/dialog.js"], { encoding: "utf8" })), "clegra/ui: the client components keep their \"use client\" directive")
expect(RESERVED_COMPONENTS.every((n) => manifest.exports[`./ui/components/${n}`] === null) && ![...files].some((f) => RESERVED_COMPONENTS.some((n) => new RegExp(`^dist/ui/components/${n}(\\.native|\\.ios)?\\.(js|d\\.ts)$`).test(f))), "clegra/ui: the components reserved for Clegra are closed and not shipped")
expect(!Object.keys(manifest.exports).some((k) => k.startsWith("./ui/drawn/")) && !("./ui/native/toast" in manifest.exports), "clegra/ui: no repository-only entry (drawn versions, native plumbing) is exported")
expect(Object.entries(manifest.peerDependencies ?? {}).every(([name]) => name === "zod" || manifest.peerDependenciesMeta?.[name]?.optional === true) && !Object.keys(manifest.dependencies ?? {}).some((d) => /react|base-ui|lucide|tailwind/.test(d)), "every UI library is an optional peer dependency (none is a dependency)")
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
const { checkTarball } = await import("./hygiene.mjs")
const findings = checkTarball(tarball)
expect(findings.length === 0, `hygiene check (nothing internal ships)${findings.length ? `:\n       ${findings.join("\n       ")}` : ""}`)
// The guard, on dry runs only (nothing is uploaded): a prerelease without a dist-tag is refused (by prepack, before
// any build; npm too), with --tag next the whole publish runs; package.json is the repository's after each.
const untagged = run(npm, ["publish", "--dry-run"], { cwd: pkgDir })
expect(untagged.status !== 0 && /prerelease/.test(untagged.stdout + untagged.stderr), `npm publish --dry-run without --tag is refused (a prerelease)${untagged.status !== 0 ? "" : `: ${tail(untagged)}`}`)
const dry = run(npm, ["publish", "--dry-run", "--tag", "next"], { cwd: pkgDir })
expect(dry.status === 0 && /with tag next/.test(dry.stdout + dry.stderr) && /\(dry-run\)/.test(dry.stdout + dry.stderr), `npm publish --dry-run --tag next runs (uploads nothing)${dry.status === 0 ? "" : `: ${tail(dry)}`}`)
expect(JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).exports["."] === "./src/index.ts" && !existsSync(join(pkgDir, ".package.repo.json")), "after the dry-run publishes the repository's package.json is back")

/** The repository's installed version of a package (read by path: not every package exports its package.json). */
const version = (name) => JSON.parse(readFileSync(join(repoRoot, "node_modules", ...name.split("/"), "package.json"), "utf8")).version

// ------------------------------------------------------------ 2. a Node-only app: no React
const nodeOnly = join(work, "node-only")
mkdirSync(nodeOnly, { recursive: true })
writeFileSync(join(nodeOnly, "package.json"), `${JSON.stringify({ name: "pack-check-node", private: true, type: "module", dependencies: { clegra: `file:../${packed.filename}`, zod: version("zod") } }, null, 2)}\n`)
const nodeInstall = run(npm, ["install", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: nodeOnly, stdio: ["ignore", "pipe", "pipe"] })
if (nodeInstall.status !== 0) throw new Error(`pack-check: npm install (node-only) failed:\n${nodeInstall.stderr}`)
const uiLibraries = Object.keys(manifest.peerDependencies ?? {}).filter((name) => !["zod", "next"].includes(name))
const present = uiLibraries.filter((name) => existsSync(join(nodeOnly, "node_modules", ...name.split("/"))))
expect(present.length === 0, `Node-only install: no React and no UI library in node_modules (${uiLibraries.length} optional peers left out)${present.length ? `: ${present.join(", ")}` : ""}`)
const lock = JSON.parse(readFileSync(join(nodeOnly, "package-lock.json"), "utf8"))
const reactInTree = Object.keys(lock.packages ?? {}).filter((p) => /node_modules\/(react|react-dom|react-native)$/.test(p))
expect(reactInTree.length === 0, `Node-only install: react, react-dom, react-native are nowhere in the lockfile's tree${reactInTree.length ? `: ${reactInTree.join(", ")}` : ""}`)
writeFileSync(
  join(nodeOnly, "server.mjs"),
  `import { defineApp, MemoryStore } from "clegra"
import { listen } from "clegra/node"
import { z } from "zod"
const app = defineApp({ name: "probe", title: "Probe", version: "1.0.0", auth: { resolve: async () => null }, entities: { note: { label: "Note", schema: z.object({ id: z.string(), title: z.string().meta({ role: "title" }) }), get: () => null, list: () => ({ rows: [] }) } } })
console.log(JSON.stringify({ name: app.manifest().name, listen: typeof listen, store: typeof MemoryStore }))
`,
)
const nodeRun = run(process.execPath, [join(nodeOnly, "server.mjs")], { cwd: nodeOnly })
expect(nodeRun.status === 0 && /"name":"probe".*"listen":"function"/.test(nodeRun.stdout), `Node-only app imports clegra and clegra/node and builds a manifest${nodeRun.status !== 0 ? `:\n${nodeRun.stdout}${nodeRun.stderr}` : ""}`)
if (!values.keep) rmSync(join(nodeOnly, "node_modules"), { recursive: true, force: true })

// ------------------------------------------------------------ 3. a fresh Next.js app with Tailwind 4
const app = join(work, "next-app")
mkdirSync(join(app, "app"), { recursive: true })
writeFileSync(
  join(app, "package.json"),
  `${JSON.stringify(
    {
      name: "pack-check-app",
      private: true,
      scripts: { dev: "next dev", build: "next build", start: "next start" },
      dependencies: { clegra: `file:../${packed.filename}`, next: version("next"), react: version("react"), "react-dom": version("react-dom"), zod: version("zod") },
      devDependencies: { typescript: version("typescript"), "@types/node": version("@types/node"), "@types/react": version("@types/react"), tailwindcss: version("tailwindcss"), "@tailwindcss/postcss": version("@tailwindcss/postcss") },
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
// As create-next-app writes it with Tailwind: postcss.config.mjs, app/globals.css, imported by the layout.
writeFileSync(join(app, "postcss.config.mjs"), 'const config = { plugins: { "@tailwindcss/postcss": {} } }\n\nexport default config\n')
writeFileSync(join(app, "app", "globals.css"), '@import "tailwindcss";\n')
writeFileSync(join(app, "app", "layout.tsx"), 'import "./globals.css"\n\nexport default function RootLayout({ children }: { children: React.ReactNode }) {\n  return (\n    <html lang="en">\n      <body>{children}</body>\n    </html>\n  )\n}\n')
// A page drawn with clegra/ui (a server component using client components).
writeFileSync(
  join(app, "app", "page.tsx"),
  'import { Button } from "clegra/ui/components/button"\nimport { Card, CardContent, CardHeader, CardTitle } from "clegra/ui/components/card"\n\nexport default function Home() {\n  return (\n    <main className="p-6">\n      <Card>\n        <CardHeader>\n          <CardTitle>Pack check</CardTitle>\n        </CardHeader>\n        <CardContent>\n          <Button>Save the order</Button>\n        </CardContent>\n      </Card>\n    </main>\n  )\n}\n',
)
const install = run(npm, ["install", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: app, stdio: ["ignore", "pipe", "pipe"] })
if (install.status !== 0) throw new Error(`pack-check: npm install failed:\n${install.stderr}`)
ok("fresh Next.js app (Tailwind 4) installed with the tarball")
const installed = join(app, "node_modules", "clegra")
expect(existsSync(join(installed, "dist/spec/src/cli.js")) && !existsSync(join(installed, "src")), "node_modules/clegra holds the built package only")

const init = run(npx, ["clegra", "init", "--ui"], { cwd: app })
expect(init.status === 0 && /create\s+clegra\.ts/.test(init.stdout) && /edit\s+next\.config\.ts/.test(init.stdout), "npx clegra init --ui (the CLI from the tarball): clegra.ts, the route, next.config, .env.local")
expect(/edit\s+package\.json/.test(init.stdout) && /edit\s+app\/globals\.css/.test(init.stdout) && readFileSync(join(app, "app", "globals.css"), "utf8").includes('@import "clegra/ui/styles.css";'), "npx clegra init --ui: clegra/ui's libraries in package.json, its stylesheet after Tailwind in app/globals.css")
if (init.status !== 0) console.log(init.stdout + init.stderr)
const uiInstall = run(npm, ["install", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: app, stdio: ["ignore", "pipe", "pipe"] })
expect(uiInstall.status === 0 && existsSync(join(app, "node_modules", "@base-ui", "react")), `npm install after init --ui: the UI libraries installed${uiInstall.status !== 0 ? `:\n${uiInstall.stderr}` : ""}`)
const token = /^CLEGRA_LOCAL_TOKEN=(.+)$/m.exec(readFileSync(join(app, ".env.local"), "utf8"))?.[1]?.trim()
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
/** Next.js stops a command once to show a security advisory for its own version and lets the same command through when run again. */
const ADVISORY = /affected by a known security vulnerability|SecurityFatalError/
const advisoryNoted = new Set()
const noteAdvisory = (what) => {
  if (!advisoryNoted.has(what)) console.log(`note Next.js ${version("next")} stopped \`next ${what}\` once to report a security advisory for itself (upgrade Next separately); run again`)
  advisoryNoted.add(what)
}
async function serve(mode, p, retried = false) {
  const base = `http://localhost:${p}`
  let output = ""
  const child = spawn(process.execPath, [nextBin, mode, "-p", String(p)], { cwd: app, detached: true, env: { ...process.env, CLEGRA_PUBLIC_URL: base, NEXT_TELEMETRY_DISABLED: "1", NODE_ENV: mode === "dev" ? "development" : "production" }, stdio: ["ignore", "pipe", "pipe"] })
  running.add(child)
  child.stdout.on("data", (d) => (output += d))
  child.stderr.on("data", (d) => (output += d))
  const deadline = Date.now() + 120_000
  for (;;) {
    if (child.exitCode !== null) {
      if (!retried && ADVISORY.test(output)) {
        noteAdvisory(mode)
        running.delete(child)
        return serve(mode, p, true)
      }
      throw new Error(`pack-check: next ${mode} exited:\n${output}`)
    }
    try {
      if ((await fetch(`${base}/.well-known/clegra.json`)).ok) break
    } catch {}
    if (Date.now() > deadline) throw new Error(`pack-check: next ${mode} did not answer:\n${output}`)
    await new Promise((r) => setTimeout(r, 400))
  }
  return { base, child, log: () => output }
}
/** `npx clegra check`: the failed check ids. */
function check(base, withToken) {
  const r = run(npx, ["clegra", "check", base, ...(withToken ? ["--token", token] : [])], { cwd: app, env: { CLEGRA_TOKEN: "" } })
  return { status: r.status, out: r.stdout + r.stderr, failed: r.stdout.split("\n").filter((l) => l.startsWith("FAIL ")) }
}

const devServer = await serve("dev", port)
const devCheck = check(devServer.base, true)
expect(devCheck.status === 1 && /auth\.mcp/.test(devCheck.out) && /NOT conformant|not conformant/i.test(devCheck.out), `next dev: npx clegra check --token runs every check; the fresh app fails auth.mcp (no authorization server yet)${devCheck.status !== 1 ? `:\n${devCheck.out}\n${devServer.log().slice(-3000)}` : ""}`)
const devFailed = devCheck.failed
expect(devFailed.length === 1 && /auth\.mcp/.test(devFailed[0] ?? ""), `next dev: auth.mcp is the only failed check${devFailed.length !== 1 ? `:\n${devCheck.out}` : ""}`)
stop(devServer.child)
rmSync(join(app, ".next"), { recursive: true, force: true })

const nextBuild = () => run(process.execPath, [nextBin, "build"], { cwd: app, env: { NEXT_TELEMETRY_DISABLED: "1", CLEGRA_PUBLIC_URL: `http://localhost:${port + 1}` } })
let build = nextBuild()
if (build.status !== 0 && ADVISORY.test(build.stdout + build.stderr)) {
  noteAdvisory("build")
  build = nextBuild()
}
expect(build.status === 0, "next build (next.config imports clegra/next from node_modules)")
if (build.status !== 0) console.log(build.stdout + build.stderr)
else {
  const startServer = await serve("start", port + 1)
  const startCheck = check(startServer.base, false)
  const startFailed = startCheck.failed
  expect(startCheck.status === 1 && startFailed.length === 1 && /auth\.mcp/.test(startFailed[0] ?? ""), `next start: npx clegra check (no token: the local bearer is refused in production) fails auth.mcp only${startFailed.length !== 1 ? `:\n${startCheck.out}` : ""}`)
  const page = await (await fetch(`${startServer.base}/`)).text()
  expect(/data-slot="button"[^>]*>Save the order</.test(page) && /data-slot="card"/.test(page), "next start: the page renders clegra/ui's Button and Card")
  const sheets = [...page.matchAll(/<link[^>]+href="([^"]+\.css)"/g)].map((m) => m[1])
  const css = (await Promise.all(sheets.map(async (href) => (await fetch(new URL(href, startServer.base))).text()))).join("\n")
  expect(/--primary:/.test(css) && /\.bg-primary\b/.test(css) && /\.rounded-xl\b|\.ring-1\b|\.shadow-xs\b/.test(css), `next start: the page's stylesheet has the theme (--primary) and the components' classes (Tailwind saw clegra/ui)${sheets.length ? "" : ": no stylesheet linked"}`)
  const refusedToken = await fetch(`${startServer.base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })
  expect(refusedToken.status === 401, "next start: the local bearer is refused (401)")
  stop(startServer.child)
}

// ------------------------------------------------------------ 4. plain Node ESM
const probe = join(app, "check")
mkdirSync(probe, { recursive: true })
writeFileSync(
  join(probe, "esm.mjs"),
  `import { defineApp, MemoryStore, SPEC_VERSION, KINDS } from "clegra"
import { listen } from "clegra/node"
import { testClient } from "clegra/testing"
import { checkApp, formatReport } from "clegra/spec"
import { withClegra, toNextHandlers } from "clegra/next"
import { createRequire } from "node:module"
import { z } from "zod"
const require = createRequire(import.meta.url)
const schema = require("clegra/clegra.schema.json")
const kinds = require("clegra/kinds.json")
const app = defineApp({
  name: "probe", title: "Probe", version: "1.0.0",
  auth: { dev: { keyFile: new URL("./dev-key.json", import.meta.url).pathname } },
  entities: { note: { label: "Note", schema: z.object({ id: z.string(), title: z.string().meta({ role: "title" }) }), get: () => ({ id: "n1", title: "Hello" }), list: () => ({ rows: [{ id: "n1", title: "Hello" }] }) } },
})
const client = await testClient(app)
const tools = await client.listTools()
const out = { spec: SPEC_VERSION, kinds: Object.keys(KINDS).length > 0, store: typeof MemoryStore, listen: typeof listen, checkApp: typeof checkApp, formatReport: typeof formatReport, next: typeof withClegra + typeof toNextHandlers, schema: typeof schema.$schema, kindsJson: typeof kinds, tools: tools.map((t) => t.name).sort() }
console.log(JSON.stringify(out))
`,
)
const esm = run(process.execPath, [join(probe, "esm.mjs")], { cwd: probe })
let esmOut = null
try {
  esmOut = JSON.parse(esm.stdout.trim().split("\n").pop())
} catch {}
expect(esm.status === 0 && esmOut?.tools?.includes("note_list") && esmOut.checkApp === "function" && esmOut.listen === "function" && esmOut.schema === "string", `plain Node ESM imports every entry and runs an app${esm.status !== 0 || !esmOut ? `:\n${esm.stdout}${esm.stderr}` : ""}`)

// ------------------------------------------------------------ 5. TypeScript consumers
// next.ts: every entry, as an app's code imports them (skipLibCheck on, as in every Next app: Next's own .d.ts
// files need the DOM and react-dom types). core.ts: the entries that don't import next, with skipLibCheck OFF and
// no DOM lib, so clegra's own .d.ts files are type-checked too.
const core = `import { defineApp, type App, type ResolvedCaller, type Manifest } from "clegra"
import { listen } from "clegra/node"
import { testClient } from "clegra/testing"
import { checkApp, type Report } from "clegra/spec"
import { z } from "zod"
export const app: App = defineApp({ name: "probe", title: "Probe", version: "1.0.0", auth: { resolve: async (): Promise<ResolvedCaller | null> => null }, entities: {} })
export const manifest: Manifest = app.manifest()
export const fns = [listen, testClient, checkApp] as const
export type CheckReport = Report
export const s = z.string()
`
writeFileSync(join(probe, "core.ts"), core)
writeFileSync(join(probe, "next.ts"), `${core}import { toNextHandlers, withClegra, type NextHandlers } from "clegra/next"
export const handlers: NextHandlers = toNextHandlers(app)
export const config = withClegra({})
`)
// ui.tsx: clegra/ui's web entries as a view's code imports them (the UI libraries installed by init --ui).
writeFileSync(
  join(probe, "ui.tsx"),
  `import { Button, buttonVariants } from "clegra/ui/components/button"
import { Card, CardContent } from "clegra/ui/react/components/card"
import { useIsMobile } from "clegra/ui/hooks/use-mobile"
import { ClegraProvider, hostContextFor } from "clegra/ui/frame"
import { colorsFor } from "clegra/ui/tokens"
export function View() {
  const mobile: boolean = useIsMobile()
  return (
    <ClegraProvider appInfo={{ name: "probe", version: "1.0.0" }}>
      <Card><CardContent><Button variant="outline" className={buttonVariants({ size: "sm" })}>{mobile ? "a" : "b"}</Button></CardContent></Card>
    </ClegraProvider>
  )
}
export const primary: string = colorsFor("light").primary
export const host = hostContextFor
`,
)
const tsc = join(app, "node_modules", "typescript", "bin", "tsc")
for (const [mode, module] of [["bundler", "esnext"], ["node16", "node16"]]) {
  if (mode === "node16") writeFileSync(join(probe, "package.json"), '{ "type": "module" }\n')
  for (const [file, strictLibs] of [["core.ts", true], ["next.ts", false], ["ui.tsx", false]]) {
    const config = join(probe, `tsconfig.${mode}.${file}.json`)
    const lib = strictLibs ? ["ES2023"] : ["ES2023", "DOM", "DOM.Iterable"]
    writeFileSync(config, `${JSON.stringify({ compilerOptions: { target: "ES2022", lib, types: ["node"], module, moduleResolution: mode, jsx: "react-jsx", strict: true, noEmit: true, skipLibCheck: !strictLibs }, files: [file] }, null, 2)}\n`)
    const r = run(process.execPath, [tsc, "-p", config], { cwd: probe })
    expect(r.status === 0, `tsc, moduleResolution ${mode}: ${file}${strictLibs ? " (skipLibCheck off, no DOM: clegra's .d.ts type-check)" : file === "ui.tsx" ? " (clegra/ui's components, frame, tokens, hooks)" : " (clegra/next too)"}${r.status !== 0 ? `:\n${r.stdout}${r.stderr}` : ""}`)
  }
}

// ------------------------------------------------------------ done
if (!values.keep) {
  rmSync(join(app, "node_modules"), { recursive: true, force: true })
  rmSync(join(app, ".next"), { recursive: true, force: true })
}
console.log(failures ? `\npack-check: ${failures} FAILED (${work})` : `\npack-check: all passed (${work}${values.keep ? ", kept" : ", node_modules and .next deleted"})`)
process.exit(failures ? 1 : 0)
