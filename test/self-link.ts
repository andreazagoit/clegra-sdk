import { lstatSync, mkdirSync, symlinkSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * `@clegra/sdk` resolvable by name from anything under this package (test/fixture's next.config.ts, the projects
 * `clegra init` writes in src/cli/init's tests): node_modules/@clegra/sdk linked to this package's root, its
 * TypeScript source, as an app that installs it would see it. Made when missing; node_modules is git-ignored.
 */
export function linkSelf(): void {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..")
  const link = join(root, "node_modules", "@clegra", "sdk")
  try {
    lstatSync(link)
    return
  } catch {}
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync("../..", link, "dir")
}
