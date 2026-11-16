// `npm pack` / `npm publish`, last step (the package's "postpack"): the repository's package.json back (prepack.mjs
// saved it) and the copied changelog away. dist/ stays (git-ignored) until the next build.
import { existsSync, renameSync, rmSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const saved = join(pkgDir, ".package.repo.json")
if (existsSync(saved)) renameSync(saved, join(pkgDir, "package.json"))
rmSync(join(pkgDir, "CHANGELOG.md"), { force: true })
