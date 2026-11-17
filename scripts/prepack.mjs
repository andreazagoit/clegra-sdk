// `npm pack` / `npm publish`, step 1 (the package's "prepack"). In the repository the package exports its TypeScript
// source (the examples, tsx and Next import it with no build step); the tarball gets the built one:
//   1. build dist/ (scripts/build.mjs);
//   2. package.json becomes the published one until scripts/postpack.mjs puts the repository's back: every export to
//      { types, default } in dist (clegra/ui's with their react-native / ios conditions, each mapped), the bin to the
//      built CLI, no devDependencies, workspaces or overrides, and of the scripts only "postpublish" (below); clegra/ui's
//      repository-only entries out, prebuilt.css in, the components reserved for Clegra closed (scripts/ui.mjs).
//
// Publishing is the owner's plain `npm publish --tag next` from the repository root (docs/RELEASE.md). npm re-reads
// package.json after packing and uploads THAT as the version's metadata, so during a real publish postpack leaves the
// published manifest in place and "postpublish" (the one script the published manifest keeps; it never runs on
// install) puts the repository's back. A dry run, a plain `npm pack` and a failed check restore it at postpack.
//
// THE GUARD: a prerelease version (0.1.0-next.0) is never published without a dist-tag, so it can't become "latest".
// npm itself refuses that ("You must specify a tag using --tag when publishing a prerelease version"), unless
// --force; this guard refuses it before anything is built, --force or not.
import { execFileSync } from "node:child_process"
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { GENERATED_EXPORTS, isPublished, RESERVED_COMPONENTS } from "./ui.mjs"

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const file = join(pkgDir, "package.json")
const saved = join(pkgDir, ".package.repo.json")

const publishing = process.env.npm_command === "publish"
const repo = JSON.parse(readFileSync(file, "utf8"))
if (publishing && /-/.test(repo.version) && !process.env.npm_config_tag) {
  console.error(`clegra: ${repo.version} is a prerelease: publish it with a dist-tag, e.g. \`npm publish --tag next\` (never as "latest").`)
  process.exit(1)
}
if (existsSync(saved)) throw new Error(`prepack: ${saved} exists (a previous pack or publish was interrupted): run \`node scripts/postpack.mjs\` to put the repository's package.json back first`)

execFileSync(process.execPath, [join(pkgDir, "scripts/build.mjs")], { stdio: ["ignore", 2, 2] })

/** A source path of the repository's exports → where the build put it (`types`: the declarations). */
function target(path, key) {
  const ts = /^\.\/((?:src|spec\/src|ui)\/.+)\.tsx?$/.exec(path)
  if (ts) return key === "types" ? `./dist/${ts[1]}.d.ts` : `./dist/${ts[1]}.js`
  if (path === "./package.json") return path
  if (/^\.\/spec\/.+\.json$/.test(path) || /^\.\/ui\/.+\.(css|cjs)$/.test(path)) return `./dist/${path.slice(2)}`
  throw new Error(`prepack: don't know where the build puts the export ${path}`)
}
/** An export's value with every condition mapped; a plain TypeScript path becomes { types, default }. */
function built(value) {
  if (typeof value !== "string") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, typeof v === "string" ? target(v, k) : built(v)]))
  return /\.tsx?$/.test(value) ? { types: target(value, "types"), default: target(value, "default") } : target(value, "default")
}
const exports = {}
for (const [key, value] of Object.entries(repo.exports)) {
  if (key === "./package.json") Object.assign(exports, GENERATED_EXPORTS)
  if (isPublished(key)) exports[key] = built(value)
}
// The components reserved for Clegra: their paths closed (the build left their files out).
for (const name of RESERVED_COMPONENTS) for (const area of ["", "react/", "react-native/"]) exports[`./ui/${area}components/${name}`] = null
const bin = Object.fromEntries(Object.entries(repo.bin).map(([name, path]) => [name, target(`./${path}`, "default").slice(2)]))
const targets = (value) => (value === null ? [] : typeof value === "string" ? [value] : Object.values(value).flatMap(targets))
for (const path of [...Object.values(exports).flatMap(targets), ...Object.values(bin)]) {
  if (path.includes("*")) {
    const [before, after] = path.split("*")
    const folder = join(pkgDir, dirname(`${before}x`))
    if (!existsSync(folder) || !readdirSync(folder).some((f) => join(folder, f).startsWith(join(pkgDir, before)) && f.endsWith(after))) throw new Error(`prepack: nothing in dist matches ${path}`)
  } else if (!existsSync(join(pkgDir, path))) throw new Error(`prepack: ${path} was not built`)
}
const published = { ...repo, main: exports["."].default, types: exports["."].types, exports, bin, scripts: { postpublish: repo.scripts.postpublish } }
delete published.devDependencies
delete published.workspaces
delete published.overrides

copyFileSync(file, saved)
writeFileSync(file, `${JSON.stringify(published, null, 2)}\n`)
