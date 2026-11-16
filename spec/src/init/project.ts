import { existsSync, readFileSync } from "node:fs"
import { dirname, join, posix, relative, resolve, sep } from "node:path"

/**
 * What `clegra init` needs to know of an existing Next.js project, read from its files: never guessed.
 * A project that isn't a Next.js App Router project is an `InitError` with what is missing.
 */

export class InitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InitError"
  }
}

export type Project = {
  root: string
  /** The version of `next` installed (node_modules), else the range in package.json. */
  nextVersion: string
  /** The App Router directory, relative to root: `app` or `src/app`. */
  appDir: "app" | "src/app"
  /** TypeScript (a tsconfig.json) or plain JavaScript. */
  ts: boolean
  /** The existing next.config file, relative to root, or null. */
  nextConfig: string | null
  /** The `paths` alias that points at the folder of clegra.ts (`@/*` → `@/`), or null: then imports are relative. */
  alias: string | null
  /** The package name, made a valid Clegra app id. */
  appName: string
  appTitle: string
  /** Dependencies the generated files import that package.json lacks. */
  missing: string[]
  /** The installed zod's major version when it is not 4 (clegra needs zod 4), else null. */
  oldZod: string | null
  /** The port `next dev` uses (from the dev script's -p/--port), default 3000. */
  port: number
  /** The proxy (or deprecated middleware) file, which may stand in front of /mcp. */
  proxy: string | null
  /** Whether .gitignore keeps .env.local out of git. */
  envIgnored: boolean
}

const CONFIG_FILES = ["next.config.ts", "next.config.mts", "next.config.mjs", "next.config.js"]

/** JSON with comments and trailing commas (tsconfig.json), read as JSON. */
export function parseJsonc(text: string): unknown {
  let out = ""
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (c === '"') {
      const start = i
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++
      out += text.slice(start, i + 1)
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++
      out += "\n"
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2)
      if (i < 0) break
      i++
    } else out += c
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"))
}

function readJson(path: string, jsonc = false): Record<string, unknown> | null {
  if (!existsSync(path)) return null
  const text = readFileSync(path, "utf8")
  try {
    return (jsonc ? parseJsonc(text) : JSON.parse(text)) as Record<string, unknown>
  } catch {
    throw new InitError(`${path} is not valid JSON${jsonc ? " (comments and trailing commas are fine)" : ""}`)
  }
}

/** A package name as a Clegra app id: `[a-z][a-z0-9-]{1,39}`. */
export function appNameOf(packageName: unknown): string {
  const base = typeof packageName === "string" ? packageName.replace(/^@[^/]+\//, "") : ""
  const name = base.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^[^a-z]+/, "").replace(/-+/g, "-").slice(0, 40).replace(/-+$/, "")
  return /^[a-z][a-z0-9-]{1,39}$/.test(name) ? name : "my-app"
}

export function titleOf(name: string): string {
  return name.split("-").filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ")
}

/** The alias in tsconfig/jsconfig `paths` whose target is `dir` (`"@/*": ["./src/*"]` for src/), or null. */
function aliasFor(root: string, dir: string, config: Record<string, unknown> | null): string | null {
  const options = (config?.compilerOptions ?? {}) as { baseUrl?: string; paths?: Record<string, string[]> }
  const base = resolve(root, options.baseUrl ?? ".")
  for (const [key, targets] of Object.entries(options.paths ?? {})) {
    if (!key.endsWith("/*") || !Array.isArray(targets)) continue
    const target = targets[0]
    if (typeof target !== "string" || !target.endsWith("*")) continue
    if (resolve(base, target.slice(0, -1)) === resolve(dir)) return key.slice(0, -1)
  }
  return null
}

function portOf(devScript: unknown): number {
  const m = typeof devScript === "string" ? /(?:^|\s)(?:-p|--port)[ =](\d{2,5})\b/.exec(devScript) : null
  return m ? Number(m[1]) : 3000
}

function ignoresEnvLocal(root: string): boolean {
  const path = join(root, ".gitignore")
  if (!existsSync(path)) return false
  const lines = readFileSync(path, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
  return lines.some((l) => [".env*", ".env.local", "/.env.local", ".env*.local", "*.local", ".env.*", "/.env*"].includes(l))
}

export function detectProject(root: string): Project {
  const pkg = readJson(join(root, "package.json"))
  if (!pkg) throw new InitError(`no package.json in ${root}: run clegra init in the folder of an existing Next.js app`)
  const deps = { ...((pkg.dependencies ?? {}) as Record<string, string>), ...((pkg.devDependencies ?? {}) as Record<string, string>) }
  if (!deps.next) throw new InitError(`${join(root, "package.json")} has no "next" dependency: clegra init adds the clegra package to an existing Next.js app (for another server, see listen() in clegra/node)`)
  const installed = readJson(join(root, "node_modules", "next", "package.json"))
  const nextVersion = typeof installed?.version === "string" ? installed.version : deps.next
  const appDir = existsSync(join(root, "app")) ? "app" : existsSync(join(root, "src", "app")) ? "src/app" : null
  if (!appDir) throw new InitError(`no app/ or src/app/ folder in ${root}: clegra init needs the App Router (a Pages Router app can mount app.fetch in an API route by hand)`)
  const ts = existsSync(join(root, "tsconfig.json"))
  const nextConfig = CONFIG_FILES.find((f) => existsSync(join(root, f))) ?? null
  const clegraDir = appDir === "src/app" ? join(root, "src") : root
  const alias = aliasFor(root, clegraDir, readJson(join(root, ts ? "tsconfig.json" : "jsconfig.json"), true))
  const appName = appNameOf(pkg.name)
  const missing = ["clegra", "zod"].filter((d) => !deps[d])
  const zod = readJson(join(root, "node_modules", "zod", "package.json"))
  const zodMajor = typeof zod?.version === "string" ? zod.version.split(".")[0]! : null
  const proxy = ["proxy", "middleware"].flatMap((n) => ["ts", "js", "mjs"].flatMap((e) => [`${n}.${e}`, `src/${n}.${e}`])).find((f) => existsSync(join(root, f))) ?? null
  return {
    root,
    nextVersion,
    appDir,
    ts,
    nextConfig,
    alias,
    appName,
    appTitle: titleOf(appName),
    missing,
    oldZod: zodMajor && zodMajor !== "4" ? zod!.version as string : null,
    port: portOf((pkg.scripts as Record<string, unknown> | undefined)?.dev),
    proxy,
    envIgnored: ignoresEnvLocal(root),
  }
}

/** Where clegra.ts goes (beside app/: the project root, or src/), relative to root. */
export function clegraPath(project: Project): string {
  return posix.join(project.appDir === "src/app" ? "src" : ".", `clegra.${project.ts ? "ts" : "js"}`).replace(/^\.\//, "")
}

export function routePath(project: Project): string {
  return `${project.appDir}/api/clegra/[...path]/route.${project.ts ? "ts" : "js"}`
}

/** How the route imports clegra.ts: through the alias, else a relative path. */
export function importPathFor(project: Project): string {
  if (project.alias) return `${project.alias}clegra`
  const from = dirname(join(project.root, routePath(project)))
  const to = join(project.root, clegraPath(project)).replace(/\.(ts|js)$/, "")
  const rel = relative(from, to).split(sep).join("/")
  return rel.startsWith(".") ? rel : `./${rel}`
}
