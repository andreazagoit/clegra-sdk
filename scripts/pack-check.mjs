// THE PACK CHECK: @clegra/sdk as a stranger gets it from npm, outside this repository. Slow (npm installs, a Next.js
// dev run and two production builds), so not in `npm test`:
//   npm run pack:check -- [--dir <empty folder outside the repo>] [--port 3946] [--ui <@clegra/ui tarball>] [--keep]
// 1. `npm pack` (prepack builds dist/): the tarball's files, its package.json (@clegra/sdk, publishConfig public, every
//    export and the bin built, no devDependencies, workspaces or overrides, only the "postpublish" script, no UI entry
//    or UI peer), every relative import in dist resolving inside the tarball, the hygiene check (the private one of the repository
//    this package is developed in, when present),
//    and the publish guard (dry runs: a prerelease without a dist-tag is refused, `--tag next` passes; nothing is
//    uploaded), the repository's package.json back.
// 2. A Node-only app (no React anywhere): the tarball and zod installed, no React or React DOM in its tree,
//    `@clegra/sdk` and `@clegra/sdk/node` imported and run.
// 3. A fresh Next.js App Router app (the repository's Next, React and TypeScript versions) with the tarball installed:
//    `npx @clegra/sdk init`; `next dev`: the Server Card, the AI Catalog, the protected-resource metadata and the 401
//    challenge through the rewrites, and `npx @clegra/sdk check` run from the tarball's CLI (a token of the
//    development sign-in needs an OAuth client, so the check runs with a refused token: the public checks pass, the
//    rest fail as they must); then `next build` + `next start`: the development sign-in is refused in production.
// 4. A plain Node ESM script importing @clegra/sdk, /node, /express, /signin, /testing, /check, /next, running an app
//    served with the development sign-in through testClient and a development token.
// 5. tsc on TypeScript files importing every entry, with `moduleResolution` bundler and node16.
// 6. BOTH packages: a fresh Next.js app with Tailwind 4, the @clegra/sdk tarball and the @clegra/ui one (--ui, default
//    the one tarball in vendor/: `npm pack --pack-destination <this repo>/vendor` in the clegra-ui repository, or
//    `npm pack @clegra/ui@next --pack-destination vendor` once it is published): init --ui's libraries are the
//    @clegra/ui tarball's web peers; `npx @clegra/sdk init --ui` + `npm install`, a page with Button, Card and the
//    Sidebar, `next build` + `next start`: the page renders them and the stylesheet has the theme.
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
const { values } = parseArgs({ options: { dir: { type: "string" }, port: { type: "string", default: "3946" }, ui: { type: "string" }, keep: { type: "boolean", default: false } } })
const port = Number(values.port)
if (!Number.isInteger(port) || port < 1024) throw new Error(`pack-check: --port ${values.port} is not a port`)
const npm = process.platform === "win32" ? "npm.cmd" : "npm"
const npx = process.platform === "win32" ? "npx.cmd" : "npx"

let failures = 0
let passed = 0
const ok = (what) => {
  passed++
  console.log(`ok   ${what}`)
}
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

// ------------------------------------------------------------ the @clegra/ui tarball (section 6), found first
const vendor = join(pkgDir, "vendor")
const uiCandidates = existsSync(vendor) ? readdirSync(vendor).filter((f) => /^clegra-ui-.+\.tgz$/.test(f)) : []
const uiTarball = values.ui ? resolve(values.ui) : uiCandidates.length === 1 ? join(vendor, uiCandidates[0]) : null
if (!uiTarball || !existsSync(uiTarball))
  throw new Error(`pack-check: no @clegra/ui tarball (${values.ui ? `--ui ${values.ui} does not exist` : `vendor/ holds ${uiCandidates.length} clegra-ui-*.tgz`}): put exactly one in vendor/ (in the clegra-ui repository: npm pack --pack-destination ${vendor}; once published: npm pack @clegra/ui@next --pack-destination vendor) or pass --ui <file>`)

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
expect(manifest.name === "@clegra/sdk" && !("private" in manifest) && manifest.version === repoManifest.version && /-/.test(manifest.version), `tarball package.json: @clegra/sdk, publishable, the repository's version ${repoManifest.version} (a prerelease)`)
expect(manifest.publishConfig?.access === "public", "tarball package.json: publishConfig.access public (a scoped package)")
expect(manifest.bin && Object.keys(manifest.bin).join() === "clegra", "tarball package.json: the CLI's bin is named clegra")
expect(JSON.stringify(manifest.scripts) === JSON.stringify({ postpublish: repoManifest.scripts.postpublish }) && !manifest.devDependencies && !manifest.workspaces && !manifest.overrides, "tarball package.json: no devDependencies, workspaces or overrides; of the scripts only postpublish")
expect(repoManifest.exports["."] === "./src/index.ts" && !existsSync(join(pkgDir, ".package.repo.json")), "after npm pack the repository's package.json is back (exports the TypeScript source)")
for (const f of ["README.md", "LICENSE", "NOTICE.md", "CHANGELOG.md", "package.json", "docs/spec.md", "docs/start-javascript.md", "docs/start-next.md", "docs/accents.svg", "docs/extensions/README.md", "docs/extensions/web-map.md", "dist/src/cli/index.js"]) expect(files.has(f), `tarball has ${f}`)
expect(![...files].some((f) => /^docs\//.test(f) && !/^docs\/extensions\/([a-z-]+|README)\.md$/.test(f) && !["docs/spec.md", "docs/start-javascript.md", "docs/start-next.md", "docs/accents.svg"].includes(f)), "tarball has docs/spec.md, docs/start-javascript.md, docs/start-next.md, the palette (docs/accents.svg) and docs/extensions/*.md only of the docs")
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
expect(!Object.keys(manifest.exports).some((k) => k.startsWith("./ui")) && ![...files].some((f) => f.startsWith("dist/ui/")), "no UI entry or file: the design system is the separate @clegra/ui")
const peers = Object.keys(manifest.peerDependencies ?? {})
expect(peers.includes("zod") && peers.includes("next") && peers.every((p) => ["next", "react", "zod"].includes(p)) && manifest.peerDependenciesMeta?.next?.optional === true && (!peers.includes("react") || manifest.peerDependenciesMeta?.react?.optional === true) && !Object.keys(manifest.dependencies ?? {}).some((d) => /react|base-ui|lucide|tailwind|@clegra\/ui/.test(d)), `peers: zod and (optional) next${peers.includes("react") ? " and (optional) react" : ""} only; no UI library and no @clegra/ui among the dependencies`)
const dist = join(pkgDir, "dist")
let unresolved = []
// init's templates are code as text: their imports belong to the files `clegra init` writes, not to the package.
const TEXT_ONLY = new Set(["dist/src/cli/init/templates.js", "dist/src/cli/init/templates.d.ts"])
for (const f of [...files].filter((f) => /\.(js|d\.ts)$/.test(f) && !TEXT_ONLY.has(f))) {
  const text = readFileSync(join(pkgDir, f), "utf8")
  for (const m of text.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) {
    const target = relative(pkgDir, resolve(dirname(join(pkgDir, f)), m[1].replace(/\.js$/, f.endsWith(".d.ts") ? ".d.ts" : ".js")))
    if (!files.has(target)) unresolved.push(`${f} → ${m[1]}`)
  }
}
expect(unresolved.length === 0, `every relative import in dist resolves inside the tarball${unresolved.length ? `: ${unresolved.slice(0, 5).join(", ")}` : ""}`)
expect(existsSync(dist), "dist/ was built")
// The hygiene list names what must never ship, so it is private: it lives in the repository this package is developed
// in, not in the package (and not in its public mirror, where this step is skipped).
const hygiene = resolve(pkgDir, "../../scripts/hygiene/hygiene.mjs")
if (existsSync(hygiene)) {
  const { checkTarball } = await import(hygiene)
  const findings = checkTarball("sdk", tarball)
  expect(findings.length === 0, `hygiene check (nothing internal ships)${findings.length ? `:\n       ${findings.join("\n       ")}` : ""}`)
} else console.log("  (hygiene check skipped: the private list is not in this checkout)")
// The guard, on dry runs only (nothing is uploaded): a prerelease without a dist-tag is refused (by prepack, before
// any build; npm too), with --tag next the whole publish runs; package.json is the repository's after each.
const untagged = run(npm, ["publish", "--dry-run"], { cwd: pkgDir })
expect(untagged.status !== 0 && /prerelease/.test(untagged.stdout + untagged.stderr), `npm publish --dry-run without --tag is refused (a prerelease)${untagged.status !== 0 ? "" : `: ${tail(untagged)}`}`)
const dry = run(npm, ["publish", "--dry-run", "--tag", "next"], { cwd: pkgDir })
expect(dry.status === 0 && /with tag next/.test(dry.stdout + dry.stderr) && /\(dry-run\)/.test(dry.stdout + dry.stderr) && /public access/.test(dry.stdout + dry.stderr), `npm publish --dry-run --tag next runs, public access (uploads nothing)${dry.status === 0 ? "" : `: ${tail(dry)}`}`)
expect(JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).exports["."] === "./src/index.ts" && !existsSync(join(pkgDir, ".package.repo.json")), "after the dry-run publishes the repository's package.json is back")

/**
 * The installed version of a package, found as Node finds it: the nearest node_modules from this package up (read by
 * path: not every package exports its package.json; a workspace's dependencies may be hoisted above it).
 */
const version = (name) => {
  for (let d = pkgDir; ; d = dirname(d)) {
    const file = join(d, "node_modules", ...name.split("/"), "package.json")
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")).version
    if (dirname(d) === d) throw new Error(`pack-check: ${name} is not installed`)
  }
}

// ------------------------------------------------------------ 2. a Node-only app: no React
const nodeOnly = join(work, "node-only")
mkdirSync(nodeOnly, { recursive: true })
writeFileSync(join(nodeOnly, "package.json"), `${JSON.stringify({ name: "pack-check-node", private: true, type: "module", dependencies: { "@clegra/sdk": `file:../${packed.filename}`, zod: version("zod") } }, null, 2)}\n`)
const nodeInstall = run(npm, ["install", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: nodeOnly, stdio: ["ignore", "pipe", "pipe"] })
if (nodeInstall.status !== 0) throw new Error(`pack-check: npm install (node-only) failed:\n${nodeInstall.stderr}`)
const uiLibraries = ["react", "react-dom", "react-native", "@base-ui/react", "lucide-react", "@clegra/ui", "next"]
const present = uiLibraries.filter((name) => existsSync(join(nodeOnly, "node_modules", ...name.split("/"))))
expect(present.length === 0, `Node-only install: no React, Next or UI library in node_modules${present.length ? `: ${present.join(", ")}` : ""}`)
const lock = JSON.parse(readFileSync(join(nodeOnly, "package-lock.json"), "utf8"))
const reactInTree = Object.keys(lock.packages ?? {}).filter((p) => /node_modules\/(react|react-dom|react-native)$/.test(p))
expect(reactInTree.length === 0, `Node-only install: react, react-dom, react-native are nowhere in the lockfile's tree${reactInTree.length ? `: ${reactInTree.join(", ")}` : ""}`)
writeFileSync(
  join(nodeOnly, "server.mjs"),
  `import { defineApp, defineEntity, MemoryStore, serve } from "@clegra/sdk"
import { listen } from "@clegra/sdk/node"
import { z } from "zod"
const note = defineEntity({ name: "note", title: "Note", path: "/notes/{id}", schema: z.object({ id: z.string(), title: z.string() }), card: { title: "title" }, get: () => null })
const app = serve(defineApp({ name: "probe", title: "Probe", description: "Probe", version: "1.0.0", entities: [note] }), { origin: "http://localhost:3000", auth: { verify: async () => null, authorizationServers: [] } })
const card = await (await app.fetch(new Request("http://localhost:3000/mcp/server-card"))).json()
console.log(JSON.stringify({ name: card.name, listen: typeof listen, store: typeof MemoryStore }))
`,
)
const nodeRun = run(process.execPath, [join(nodeOnly, "server.mjs")], { cwd: nodeOnly })
expect(nodeRun.status === 0 && /"name":"localhost\/probe".*"listen":"function"/.test(nodeRun.stdout), `Node-only app imports @clegra/sdk and @clegra/sdk/node and serves its Server Card${nodeRun.status !== 0 ? `:\n${nodeRun.stdout}${nodeRun.stderr}` : ""}`)
if (!values.keep) rmSync(join(nodeOnly, "node_modules"), { recursive: true, force: true })

// ------------------------------------------------------------ 3. a fresh Next.js app with @clegra/sdk
/** Writes a fresh App Router app as create-next-app does (with Tailwind 4 when `tailwind`), its page `page`. */
function nextApp(dir, dependencies, page, tailwind) {
  mkdirSync(join(dir, "app"), { recursive: true })
  const devDependencies = { typescript: version("typescript"), "@types/node": version("@types/node"), "@types/react": version("@types/react"), "@types/react-dom": version("@types/react-dom"), ...(tailwind ? { tailwindcss: version("tailwindcss"), "@tailwindcss/postcss": version("@tailwindcss/postcss") } : {}) }
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: `pack-check-${dir.split(sep).pop()}`, private: true, scripts: { dev: "next dev", build: "next build", start: "next start" }, dependencies: { next: version("next"), react: version("react"), "react-dom": version("react-dom"), zod: version("zod"), ...dependencies }, devDependencies }, null, 2)}\n`)
  writeFileSync(join(dir, ".gitignore"), "node_modules\n.next\n.env*.local\n")
  writeFileSync(join(dir, "next.config.ts"), 'import type { NextConfig } from "next"\n\nconst nextConfig: NextConfig = {}\n\nexport default nextConfig\n')
  const compilerOptions = { target: "ES2022", lib: ["dom", "dom.iterable", "esnext"], allowJs: false, skipLibCheck: true, strict: true, noEmit: true, esModuleInterop: true, module: "esnext", moduleResolution: "bundler", resolveJsonModule: true, isolatedModules: true, jsx: "react-jsx", incremental: false, plugins: [{ name: "next" }], paths: { "@/*": ["./*"] } }
  writeFileSync(join(dir, "tsconfig.json"), `${JSON.stringify({ compilerOptions, include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"], exclude: ["node_modules", "check"] }, null, 2)}\n`)
  if (tailwind) {
    writeFileSync(join(dir, "postcss.config.mjs"), 'const config = { plugins: { "@tailwindcss/postcss": {} } }\n\nexport default config\n')
    writeFileSync(join(dir, "app", "globals.css"), '@import "tailwindcss";\n')
  }
  writeFileSync(join(dir, "app", "layout.tsx"), `${tailwind ? 'import "./globals.css"\n\n' : ""}export default function RootLayout({ children }: { children: React.ReactNode }) {\n  return (\n    <html lang="en">\n      <body>{children}</body>\n    </html>\n  )\n}\n`)
  writeFileSync(join(dir, "app", "page.tsx"), page)
  const install = run(npm, ["install", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] })
  if (install.status !== 0) throw new Error(`pack-check: npm install failed in ${dir}:\n${install.stderr}`)
}

const app = join(work, "next-app")
nextApp(app, { "@clegra/sdk": `file:../${packed.filename}` }, 'export default function Home() {\n  return <main>Orders</main>\n}\n', false)
ok("fresh Next.js app installed with the tarball")
const installed = join(app, "node_modules", "@clegra", "sdk")
expect(existsSync(join(installed, "dist/src/cli/index.js")) && !existsSync(join(installed, "src")) && existsSync(join(installed, "docs/spec.md")) && existsSync(join(installed, "docs/start-javascript.md")) && existsSync(join(installed, "docs/start-next.md")) && existsSync(join(installed, "docs/extensions/README.md")), "node_modules/@clegra/sdk holds the built package only, with docs/spec.md, the guides and docs/extensions")
expect(!existsSync(join(app, "node_modules", "@clegra", "ui")) && !existsSync(join(app, "node_modules", "@base-ui")), "the app has no @clegra/ui and no UI library (the SDK needs none)")

const init = run(npx, ["@clegra/sdk", "init"], { cwd: app })
expect(init.status === 0 && /create\s+clegra\/app\.ts/.test(init.stdout) && /create\s+clegra\/index\.ts/.test(init.stdout) && /edit\s+next\.config\.ts/.test(init.stdout) && !/edit\s+package\.json/.test(init.stdout), `npx @clegra/sdk init (the CLI from the tarball): clegra/, the route, next.config, .env.local; package.json untouched${init.status !== 0 ? `:\n${init.stdout}${init.stderr}` : ""}`)
const routeText = readFileSync(join(app, "app/api/clegra/[...path]/route.ts"), "utf8")
expect(/from "@clegra\/sdk\/next"/.test(routeText) && /from "@clegra\/sdk"/.test(readFileSync(join(app, "clegra/index.ts"), "utf8")) && /from "@clegra\/sdk\/next"/.test(readFileSync(join(app, "next.config.ts"), "utf8")), "init's files import @clegra/sdk and @clegra/sdk/next")
const devCode = /^CLEGRA_DEV_CODE=(.+)$/m.exec(readFileSync(join(app, ".env.local"), "utf8"))?.[1]?.trim()
expect(Boolean(devCode), ".env.local has the development sign-in's code")

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
/** Until the server's process has exited: `next dev` writes into .next/dev while it shuts down. */
const exited = (child) => (child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise((resolve) => child.once("exit", resolve)))
/** Next.js stops a command once to show a security advisory for its own version and lets the same command through when run again. */
const ADVISORY = /affected by a known security vulnerability|SecurityFatalError/
const advisoryNoted = new Set()
const noteAdvisory = (what) => {
  if (!advisoryNoted.has(what)) console.log(`note Next.js ${version("next")} stopped \`next ${what}\` once to report a security advisory for itself (upgrade Next separately); run again`)
  advisoryNoted.add(what)
}
async function serve(dir, mode, p, retried = false) {
  const base = `http://localhost:${p}`
  const nextBin = join(dir, "node_modules", "next", "dist", "bin", "next")
  let output = ""
  const child = spawn(process.execPath, [nextBin, mode, "-p", String(p)], { cwd: dir, detached: true, env: { ...cleanEnv, CLEGRA_PUBLIC_URL: base, NEXT_TELEMETRY_DISABLED: "1", NODE_ENV: mode === "dev" ? "development" : "production" }, stdio: ["ignore", "pipe", "pipe"] })
  running.add(child)
  child.stdout.on("data", (d) => (output += d))
  child.stderr.on("data", (d) => (output += d))
  const deadline = Date.now() + 120_000
  for (;;) {
    if (child.exitCode !== null) {
      if (!retried && ADVISORY.test(output)) {
        noteAdvisory(mode)
        running.delete(child)
        return serve(dir, mode, p, true)
      }
      throw new Error(`pack-check: next ${mode} exited:\n${output}`)
    }
    try {
      const answer = await fetch(`${base}/mcp/server-card`)
      if (answer.ok || answer.status === 500) break
    } catch {}
    if (Date.now() > deadline) throw new Error(`pack-check: next ${mode} did not answer:\n${output}`)
    await new Promise((r) => setTimeout(r, 400))
  }
  return { base, child, log: () => output }
}
function nextBuild(dir, p) {
  const nextBin = join(dir, "node_modules", "next", "dist", "bin", "next")
  const once = () => run(process.execPath, [nextBin, "build"], { cwd: dir, env: { NEXT_TELEMETRY_DISABLED: "1", CLEGRA_PUBLIC_URL: `http://localhost:${p}` } })
  let build = once()
  if (build.status !== 0 && ADVISORY.test(build.stdout + build.stderr)) {
    noteAdvisory("build")
    build = once()
  }
  return build
}
/** `npx @clegra/sdk check --json` with a token the app refuses: the report's checks by id. */
function check(dir, base) {
  const r = run(npx, ["@clegra/sdk", "check", base, "--token", "not-a-token-of-this-app", "--json"], { cwd: dir, env: { CLEGRA_TOKEN: "", CLEGRA_READ_TOKEN: "" } })
  let report = null
  try {
    report = JSON.parse(r.stdout)
  } catch {}
  const byId = Object.fromEntries((report?.checks ?? []).map((c) => [c.id, c.ok]))
  return { status: r.status, out: r.stdout + r.stderr, byId }
}
/** The public part of a fresh app: what a client reads before signing in. */
async function publicSide(base) {
  const card = await fetch(`${base}/mcp/server-card`)
  const catalog = await fetch(`${base}/.well-known/ai-catalog.json`)
  const prm = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)
  const denied = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
  return card.headers.get("content-type") === "application/mcp-server-card+json" && catalog.ok && prm.ok && denied.status === 401 && /resource_metadata=/.test(denied.headers.get("www-authenticate") ?? "")
}

const devServer = await serve(app, "dev", port)
expect(await publicSide(devServer.base), "next dev: the Server Card, the AI Catalog, the protected-resource metadata and the 401 challenge through withClegra's rewrites")
const devCheck = check(app, devServer.base)
expect(devCheck.status === 1 && devCheck.byId["A.server-card"] === true && devCheck.byId["A.unauthenticated"] === true && devCheck.byId["A.protected-resource"] === true, `next dev: npx @clegra/sdk check (the tarball's CLI) passes the public checks; a refused token fails the rest${devCheck.status === 1 ? "" : `:\n${devCheck.out}\n${devServer.log().slice(-3000)}`}`)
stop(devServer.child)
await exited(devServer.child)
rmSync(join(app, ".next"), { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })

const build = nextBuild(app, port + 1)
expect(build.status === 0, "next build (next.config imports @clegra/sdk/next from node_modules)")
if (build.status !== 0) console.log(build.stdout + build.stderr)
else {
  const startServer = await serve(app, "start", port + 1)
  const refused = await fetch(`${startServer.base}/mcp/server-card`)
  expect(refused.status === 500 && /devSignIn is for development/.test(startServer.log()), `next start: the development sign-in is refused in production (the route answers 500, the log says why)${refused.status === 500 ? "" : `: ${refused.status}`}`)
  stop(startServer.child)
}

// ------------------------------------------------------------ 4. plain Node ESM
const probe = join(app, "check")
mkdirSync(probe, { recursive: true })
writeFileSync(
  join(probe, "esm.mjs"),
  `import { defineApp, defineEntity, defineTool, MemoryStore, serve } from "@clegra/sdk"
import { listen } from "@clegra/sdk/node"
import { clegraMiddleware } from "@clegra/sdk/express"
import { devSignIn } from "@clegra/sdk/signin"
import { testClient } from "@clegra/sdk/testing"
import { checkApp, formatReport } from "@clegra/sdk/check"
import { withClegra, toNextHandlers, recordProxy } from "@clegra/sdk/next"
import { z } from "zod"
const note = defineEntity({ name: "note", title: "Note", path: "/notes/{id}", schema: z.object({ id: z.string(), title: z.string() }), card: { title: "title" }, get: ({ id }) => ({ id, title: "Hello" }) })
const list = defineTool({ name: "notes.list", title: "Notes", description: "Notes", input: z.object({}), annotations: { readOnly: true }, entity: note, run: () => ({ records: [{ entity: note, record: { id: "n1", title: "Hello" } }] }) })
const definition = defineApp({ name: "probe", title: "Probe", description: "Probe", version: "1.0.0", entities: [note], tools: [list] })
const signIn = devSignIn(definition)
const app = serve(definition, { origin: "http://localhost:3000", auth: { signIn }, store: new MemoryStore() })
const client = testClient(app, { token: await signIn.dev.token() })
const tools = await client.listTools()
const record = await client.readJson("http://localhost:3000/notes/n1")
const out = { store: typeof MemoryStore, listen: typeof listen, express: typeof clegraMiddleware, checkApp: typeof checkApp, formatReport: typeof formatReport, next: typeof withClegra + typeof toNextHandlers + typeof recordProxy, record: record.title, tools: tools.map((t) => t.name).sort() }
console.log(JSON.stringify(out))
`,
)
const esm = run(process.execPath, [join(probe, "esm.mjs")], { cwd: probe })
let esmOut = null
try {
  esmOut = JSON.parse(esm.stdout.trim().split("\n").pop())
} catch {}
expect(esm.status === 0 && esmOut?.tools?.includes("notes.list") && esmOut.tools.includes("create_bound_browser_session") && esmOut.record === "Hello" && esmOut.checkApp === "function" && esmOut.listen === "function" && esmOut.express === "function" && esmOut.next === "functionfunctionfunction", `plain Node ESM imports every entry and runs an app${esm.status !== 0 || !esmOut ? `:\n${esm.stdout}${esm.stderr}` : ""}`)

// ------------------------------------------------------------ 5. TypeScript consumers
// next.ts: every entry, as an app's code imports them (skipLibCheck on, as in every Next app: Next's own .d.ts
// files need the DOM and react-dom types). core.ts: the entries that don't import next, with skipLibCheck OFF and
// no DOM lib, so @clegra/sdk's own .d.ts files are type-checked too.
const core = `import { defineApp, serve, type App, type Grant, type ServedApp } from "@clegra/sdk"
import { listen } from "@clegra/sdk/node"
import { clegraMiddleware } from "@clegra/sdk/express"
import { devSignIn, type SignIn } from "@clegra/sdk/signin"
import { testClient } from "@clegra/sdk/testing"
import { checkApp, type Report } from "@clegra/sdk/check"
import { z } from "zod"
export const definition: App = defineApp({ name: "probe", title: "Probe", description: "Probe", version: "1.0.0" })
export const app: ServedApp = serve(definition, { origin: "http://localhost:3000", auth: { verify: async (): Promise<Grant | null> => null, authorizationServers: [] } })
export const dev: SignIn = devSignIn(definition)
export const fns = [listen, clegraMiddleware, testClient, checkApp] as const
export type CheckReport = Report
export const s = z.string()
`
writeFileSync(join(probe, "core.ts"), core)
writeFileSync(join(probe, "next.ts"), `${core}import { recordProxy, toNextHandlers, withClegra, type NextHandlers } from "@clegra/sdk/next"
export const handlers: NextHandlers = toNextHandlers(app)
export const config = withClegra({})
export const proxy = recordProxy()
`)
const tsc = join(app, "node_modules", "typescript", "bin", "tsc")
for (const [mode, module] of [["bundler", "esnext"], ["node16", "node16"]]) {
  if (mode === "node16") writeFileSync(join(probe, "package.json"), '{ "type": "module" }\n')
  for (const [file, strictLibs] of [["core.ts", true], ["next.ts", false]]) {
    const config = join(probe, `tsconfig.${mode}.${file}.json`)
    const lib = strictLibs ? ["ES2023"] : ["ES2023", "DOM", "DOM.Iterable"]
    writeFileSync(config, `${JSON.stringify({ compilerOptions: { target: "ES2022", lib, types: ["node"], module, moduleResolution: mode, jsx: "react-jsx", strict: true, noEmit: true, skipLibCheck: !strictLibs }, files: [file] }, null, 2)}\n`)
    const r = run(process.execPath, [tsc, "-p", config], { cwd: probe })
    expect(r.status === 0, `tsc, moduleResolution ${mode}: ${file}${strictLibs ? " (skipLibCheck off, no DOM: @clegra/sdk's .d.ts type-check)" : " (@clegra/sdk/next too)"}${r.status !== 0 ? `:\n${r.stdout}${r.stderr}` : ""}`)
  }
}

// ------------------------------------------------------------ 6. both packages: @clegra/sdk + @clegra/ui, init --ui
const both = join(work, "next-ui")
const uiManifest = JSON.parse(execFileSync("tar", ["-xzOf", uiTarball, "package/package.json"], { encoding: "utf8" }))
// init --ui's list, from the source (pack:check runs under tsx).
const { UI_WEB_LIBRARIES, UI_RANGE } = await import("../src/cli/init/ui.ts")
const NOT_WEB = new Set(["react", "react-dom", "react-native", "react-native-svg", "lucide-react-native", "@expo/ui", "tailwindcss"])
const uiWeb = Object.fromEntries(Object.entries(uiManifest.peerDependencies ?? {}).filter(([n]) => !NOT_WEB.has(n)))
expect(uiManifest.name === "@clegra/ui" && JSON.stringify(Object.entries(uiWeb).sort()) === JSON.stringify(Object.entries(UI_WEB_LIBRARIES).sort()), `init --ui's libraries are the @clegra/ui tarball's web peers, at its ranges (${uiManifest.name}@${uiManifest.version}, ${Object.keys(uiWeb).length} libraries)`)
expect(new RegExp(`^\\^${UI_RANGE.slice(1).replace(/[.]/g, "\\.")}$`).test(UI_RANGE) && uiManifest.version === UI_RANGE.slice(1), `init --ui's range ${UI_RANGE} names the @clegra/ui version checked here (${uiManifest.version})`)
const uiFile = join(work, uiTarball.split(sep).pop())
writeFileSync(uiFile, readFileSync(uiTarball))
nextApp(
  both,
  { "@clegra/sdk": `file:../${packed.filename}`, "@clegra/ui": `file:../${uiFile.split(sep).pop()}` },
  `import { Button } from "@clegra/ui/components/button"
import { Card, CardContent, CardHeader, CardTitle } from "@clegra/ui/components/card"
import { Sidebar, SidebarContent, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarInset } from "@clegra/ui/components/sidebar"

export default function Home() {
  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton>Orders</SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarContent>
      </Sidebar>
      <SidebarInset>
        <Card>
          <CardHeader>
            <CardTitle>Pack check</CardTitle>
          </CardHeader>
          <CardContent>
            <Button>Save the order</Button>
          </CardContent>
        </Card>
      </SidebarInset>
    </SidebarProvider>
  )
}
`,
  true,
)
ok("fresh Next.js app (Tailwind 4) installed with both tarballs")
const initUi = run(npx, ["@clegra/sdk", "init", "--ui"], { cwd: both })
expect(initUi.status === 0 && /create\s+clegra\/app\.ts/.test(initUi.stdout) && /edit\s+package\.json/.test(initUi.stdout) && /edit\s+app\/globals\.css/.test(initUi.stdout), `npx @clegra/sdk init --ui: clegra/, the route, next.config, .env.local, the web libraries in package.json, the stylesheet${initUi.status !== 0 ? `:\n${initUi.stdout}${initUi.stderr}` : ""}`)
const bothPkg = JSON.parse(readFileSync(join(both, "package.json"), "utf8"))
expect(bothPkg.dependencies["@clegra/ui"].startsWith("file:") && Object.keys(UI_WEB_LIBRARIES).every((n) => bothPkg.dependencies[n] === UI_WEB_LIBRARIES[n]), "init --ui kept the installed @clegra/ui and added its web libraries at its ranges")
expect(readFileSync(join(both, "app", "globals.css"), "utf8") === '@import "tailwindcss";\n@import "@clegra/ui/styles.css";\n', 'init --ui: app/globals.css imports "@clegra/ui/styles.css" after Tailwind')
const bothInstall = run(npm, ["install", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: both, stdio: ["ignore", "pipe", "pipe"] })
expect(bothInstall.status === 0 && existsSync(join(both, "node_modules", "@base-ui", "react")) && existsSync(join(both, "node_modules", "@clegra", "ui", "dist", "components", "sidebar.js")), `npm install after init --ui: the UI libraries and @clegra/ui installed${bothInstall.status !== 0 ? `:\n${bothInstall.stderr}` : ""}`)
const bothBuild = nextBuild(both, port + 2)
expect(bothBuild.status === 0, "next build with both packages (a page with Button, Card and the Sidebar; the clegra route)")
if (bothBuild.status !== 0) console.log(bothBuild.stdout + bothBuild.stderr)
else {
  const server = await serve(both, "start", port + 2)
  const page = await (await fetch(`${server.base}/`)).text()
  expect(/data-slot="button"[^>]*>Save the order</.test(page) && /data-slot="card"/.test(page) && /data-sidebar="menu-button"/.test(page), "next start: the page renders @clegra/ui's Button, Card and Sidebar")
  const sheets = [...page.matchAll(/<link[^>]+href="([^"]+\.css)"/g)].map((m) => m[1])
  const css = (await Promise.all(sheets.map(async (href) => (await fetch(new URL(href, server.base))).text()))).join("\n")
  expect(/--primary:/.test(css) && /\.bg-primary\b/.test(css) && /\.bg-sidebar\b/.test(css), `next start: the stylesheet has the theme and the components' classes (Tailwind saw @clegra/ui)${sheets.length ? "" : ": no stylesheet linked"}`)
  stop(server.child)
}

// ------------------------------------------------------------ done
if (!values.keep) {
  for (const dir of [app, both]) {
    rmSync(join(dir, "node_modules"), { recursive: true, force: true })
    rmSync(join(dir, ".next"), { recursive: true, force: true })
  }
}
console.log(failures ? `\npack-check: ${failures} FAILED, ${passed} passed (${work})` : `\npack-check: all ${passed} passed (${work}${values.keep ? ", kept" : ", node_modules and .next deleted"})`)
process.exit(failures ? 1 : 0)
