// `npm pack` / `npm publish`, step 1 (the package's "prepack"). In the repository the package exports its TypeScript
// source (the workspaces, tsx and Next import it with no build step); the tarball gets the built one:
//   1. build dist/ (scripts/build.mjs) and copy the package changelog (docs/developers/CHANGELOG.md) in as CHANGELOG.md;
//   2. package.json becomes the published one until "postpack" puts the repository's back: every export to
//      { types, default } in dist, the bin to the built CLI, no scripts or devDependencies.
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
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

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
/** A source path of the repository's exports → where the build put it. */
function built(path) {
  const ts = /^\.\/((?:src|spec\/src)\/.+)\.ts$/.exec(path)
  if (ts) return { types: `./dist/${ts[1]}.d.ts`, default: `./dist/${ts[1]}.js` }
  if (path === "./package.json") return path
  if (/^\.\/spec\/.+\.json$/.test(path)) {
    const out = `./dist/${path.slice(2)}`
    if (!existsSync(join(pkgDir, out))) throw new Error(`prepack: ${out} is not in dist (scripts/build.mjs ASSETS)`)
    return out
  }
  throw new Error(`prepack: don't know where the build puts the export ${path}`)
}
const exports = Object.fromEntries(Object.entries(repo.exports).map(([key, path]) => [key, built(path)]))
const bin = Object.fromEntries(Object.entries(repo.bin).map(([name, path]) => [name, built(`./${path}`).default.slice(2)]))
for (const target of [...Object.values(exports).flatMap((e) => (typeof e === "string" ? [e] : [e.types, e.default])), ...Object.values(bin)]) {
  if (!existsSync(join(pkgDir, target))) throw new Error(`prepack: ${target} was not built`)
}
const published = { ...repo, main: exports["."].default, types: exports["."].types, exports, bin }
delete published.scripts
delete published.devDependencies
if (approved || (publishing && dryRun)) delete published.private

copyFileSync(file, saved)
writeFileSync(file, `${JSON.stringify(published, null, 2)}\n`)
