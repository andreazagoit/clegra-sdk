// The published build: tsc → dist/ (ESM JavaScript, .d.ts, source maps with the sources inlined), the same layout
// as the package (dist/src, dist/spec/src), so every path a module resolves at run time relative to itself
// (`../schema/modelapp.schema.json`) holds in dist as in the repository. Then:
//   - relative imports get their ".js": the sources import "./define" for the bundlers and tsx; Node's ESM loader
//     and `moduleResolution: node16` need the extension (in the .js and in the .d.ts);
//   - the JSON assets (the manifest's JSON Schema, kinds.json) are copied next to the code that reads them;
//   - the CLI gets a node shebang and the executable bit.
// Run: npm run build (also the first step of `npm pack`, scripts/prepack.mjs). dist/ is git-ignored.
import { execFileSync } from "node:child_process"
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const dist = join(pkg, "dist")

/** Files copied as they are: read at run time by path relative to the built module, or exported as data. */
export const ASSETS = ["spec/schema/modelapp.schema.json", "spec/kinds.json"]
/** The CLI, built. */
export const CLI = "dist/spec/src/cli.js"

rmSync(dist, { recursive: true, force: true })
const tsc = createRequire(join(pkg, "package.json")).resolve("typescript/bin/tsc")
execFileSync(process.execPath, [tsc, "-p", join(pkg, "tsconfig.build.json")], { stdio: ["ignore", 2, 2] })

const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]))
// `from "./x"`, `import("./x")`, `import "./x"` and `export … from "./x"`, in .js and .d.ts.
const specifier = /((?:\bfrom|\bimport)\s*\(?\s*["'])(\.{1,2}\/[^"']+?)(["'])/g
for (const file of walk(dist)) {
  if (!/\.(js|d\.ts)$/.test(file)) continue
  const text = readFileSync(file, "utf8")
  const fixed = text.replace(specifier, (all, a, path, b) => {
    if (/\.(js|json|mjs|cjs)$/.test(path)) return all
    const base = resolve(dirname(file), path)
    const target = existsSync(`${base}.js`) || existsSync(`${base}.d.ts`) ? `${path}.js` : existsSync(join(base, "index.js")) ? `${path}/index.js` : null
    if (!target) throw new Error(`build: ${relative(pkg, file)} imports ${path}, which is not in dist`)
    return `${a}${target}${b}`
  })
  if (fixed !== text) writeFileSync(file, fixed)
}

for (const asset of ASSETS) {
  mkdirSync(dirname(join(dist, asset)), { recursive: true })
  copyFileSync(join(pkg, asset), join(dist, asset))
}

const cli = join(pkg, CLI)
const source = readFileSync(cli, "utf8").replace(/^#!.*\n/, "")
writeFileSync(cli, `#!/usr/bin/env node\n${source}`)
chmodSync(cli, 0o755)
console.error(`built ${relative(process.cwd(), dist) || "."}`)
