// `npm pack` / `npm publish`, step 1 (the package's "prepack"). In the repository the package exports its TypeScript
// source (the workspaces, tsx and Next import it with no build step); the tarball gets the built one:
//   1. build dist/ (scripts/build.mjs) and copy the package changelog (docs/developers/CHANGELOG.md) in as CHANGELOG.md;
//   2. package.json becomes the published one until "postpack" puts the repository's back: every export to
//      { types, default } in dist (clegra/ui's with their react-native / ios conditions, each mapped), the bin to the
//      built CLI, no scripts or devDependencies; clegra/ui's repository-only entries out, prebuilt.css in, the
//      components reserved for Clegra closed (scripts/ui.mjs).
//
// THE PUBLISH GUARD (the owner has not approved publishing to npm yet). The repository's package.json is and stays
// "private": true. npm checks "private" when it really publishes, on the manifest it uploads, so:
//   - `npm publish` from this folder is refused here, with the way to release (npm would refuse it anyway, its
//     message would only say to remove "private");
//   - a tarball made by plain `npm pack` keeps "private": true: `npm publish clegra-x.tgz` refuses it, and it
//     installs as any other package (the pack check, docs/developers/RELEASE.md);
//   - only `CLEGRA_PUBLISH=approved npm pack` makes a tarball without "private": the one the owner publishes.
//   `npm publish --dry-run` (here, or on any tarball) runs everything and uploads nothing.
import { execFileSync } from "node:child_process"
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { GENERATED_EXPORTS, isPublished, RESERVED_COMPONENTS } from "./ui.mjs"

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = resolve(pkgDir, "../..")
const file = join(pkgDir, "package.json")
const saved = join(pkgDir, ".package.repo.json")

const publishing = process.env.npm_command === "publish"
const dryRun = process.env.npm_config_dry_run === "true"
if (publishing && !dryRun) {
  console.error(
    "clegra: not published. The package is published from an approved tarball, after the owner's yes: " +
      "`CLEGRA_PUBLISH=approved npm pack`, then `npm publish <tarball>` (docs/developers/RELEASE.md). Keep \"private\": true here.",
  )
  process.exit(1)
}
const approved = process.env.CLEGRA_PUBLISH === "approved"
if (existsSync(saved)) throw new Error(`prepack: ${saved} exists (a previous pack was interrupted): move it back to package.json first`)

execFileSync(process.execPath, [join(pkgDir, "scripts/build.mjs")], { stdio: ["ignore", 2, 2] })
copyFileSync(join(repoRoot, "docs/developers/CHANGELOG.md"), join(pkgDir, "CHANGELOG.md"))

const repo = JSON.parse(readFileSync(file, "utf8"))
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
const published = { ...repo, main: exports["."].default, types: exports["."].types, exports, bin }
delete published.scripts
delete published.devDependencies
if (approved || (publishing && dryRun)) delete published.private

copyFileSync(file, saved)
writeFileSync(file, `${JSON.stringify(published, null, 2)}\n`)
