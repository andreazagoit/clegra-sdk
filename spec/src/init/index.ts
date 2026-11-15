import { randomBytes } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

import { configWarnings, wrapNextConfig } from "./next-config"
import { detectProject, importPathFor, InitError, modelappPath, routePath, type Project } from "./project"
import { envLines, LOCAL_TOKEN_ENV, modelappFile, nextConfigFile, routeFile } from "./templates"

/**
 * `modelapp init`: MAP added to an existing Next.js App Router app. It writes `modelapp.ts`, the route
 * `app/api/modelapp/[...path]/route.ts`, wraps next.config with `withModelApp`, and puts a local bearer in
 * `.env.local`. It never overwrites a file: what exists is left as it is, and what it can't do safely it prints
 * for you to do by hand. `dryRun` prints the same and writes nothing.
 */

export { InitError }

export type InitStep = { verb: "create" | "edit" | "skip" | "by hand"; path: string; note?: string; how?: string }

export type InitResult = { project: Project; steps: InitStep[]; warnings: string[]; next: string[]; token: string | null }

export type InitOptions = { cwd: string; dryRun?: boolean }

export function runInit(options: InitOptions): InitResult {
  const root = resolve(options.cwd)
  const project = detectProject(root)
  const write = !options.dryRun
  const steps: InitStep[] = []
  const warnings: string[] = []
  const at = (path: string) => join(root, path)
  const create = (path: string, text: string, note?: string) => {
    if (write) {
      mkdirSync(dirname(at(path)), { recursive: true })
      writeFileSync(at(path), text, { flag: "wx" })
    }
    steps.push({ verb: "create", path, ...(note ? { note } : {}) })
  }

  // 1. modelapp.ts (any modelapp.* there counts: it is the developer's).
  const appFile = modelappPath(project)
  const existingApp = ["ts", "tsx", "js", "mjs"].map((e) => appFile.replace(/\.(ts|js)$/, `.${e}`)).find((p) => existsSync(at(p)))
  if (existingApp) steps.push({ verb: "skip", path: existingApp, note: "exists, left as it is (the route imports `app` from it)" })
  else create(appFile, modelappFile({ name: project.appName, title: project.appTitle, ts: project.ts }), `app "${project.appName}": sample tasks, one action, one page; TODOs for your data and sign-in`)

  // 2. The route.
  const route = routePath(project)
  const routeDir = dirname(route)
  const existingRoute = ["ts", "js", "mjs", "tsx", "jsx"].map((e) => `${routeDir}/route.${e}`).find((p) => existsSync(at(p)))
  if (existingRoute) steps.push({ verb: "skip", path: existingRoute, note: "exists, left as it is" })
  else create(route, routeFile({ importPath: importPathFor(project) }), `imports { app } from "${importPathFor(project)}"`)
  for (const shadow of ["mcp", ".well-known"]) {
    if (existsSync(join(root, project.appDir, shadow))) warnings.push(`${project.appDir}/${shadow} exists: withModelApp's rewrites run before it (beforeFiles), so it no longer answers ${shadow === "mcp" ? "/mcp" : "the MAP and OAuth paths"}`)
  }

  // 3. next.config.
  if (!project.nextConfig) {
    const file = project.ts ? "next.config.ts" : "next.config.mjs"
    create(file, nextConfigFile(project.ts), "withModelApp({})")
  } else {
    const text = readFileSync(at(project.nextConfig), "utf8")
    warnings.push(...configWarnings(text))
    const edit = wrapNextConfig(text)
    if (edit.kind === "already") steps.push({ verb: "skip", path: project.nextConfig, note: edit.why })
    else if (edit.kind === "manual") steps.push({ verb: "by hand", path: project.nextConfig, note: `not edited: ${edit.why}. Wrap the exported config yourself`, how: edit.how })
    else {
      if (write) writeFileSync(at(project.nextConfig), edit.text)
      steps.push({ verb: "edit", path: project.nextConfig, note: "wrapped the exported config with withModelApp" })
    }
  }

  // 4. The local bearer in .env.local (appended, never replaced).
  const envPath = ".env.local"
  const envText = existsSync(at(envPath)) ? readFileSync(at(envPath), "utf8") : null
  const existingToken = envText ? new RegExp(`^${LOCAL_TOKEN_ENV}=(.+)$`, "m").exec(envText)?.[1]?.trim() ?? null : null
  let token: string | null = existingToken
  if (existingToken) steps.push({ verb: "skip", path: envPath, note: `${LOCAL_TOKEN_ENV} is already set` })
  else {
    token = randomBytes(32).toString("base64url")
    const lines = envLines(token)
    if (envText === null) create(envPath, lines, `${LOCAL_TOKEN_ENV}: a random local bearer, refused in production`)
    else {
      if (write) appendFileSync(at(envPath), `${envText.endsWith("\n") || envText === "" ? "" : "\n"}\n${lines}`)
      steps.push({ verb: "edit", path: envPath, note: `appended ${LOCAL_TOKEN_ENV}: a random local bearer, refused in production` })
    }
  }
  if (!project.envIgnored) warnings.push(".gitignore does not keep .env.local out of git: add `.env*.local` to it")

  if (project.oldZod) warnings.push(`zod ${project.oldZod} is installed: modelapp needs zod 4 (npm i zod@4)`)
  if (project.proxy) warnings.push(`${project.proxy} runs before every route: let /mcp, /.well-known/* and /api/modelapp/* through without a session (MCP clients send a bearer token, never your cookies)`)

  const base = `http://localhost:${project.port}`
  const shown = write ? token : "<generated on a real run>"
  const next = [
    ...(project.missing.length ? [`npm i ${project.missing.join(" ")}`] : []),
    `npm run dev   (then ${base}/.well-known/modelapp.json is the manifest, ${base}/mcp the MCP server)`,
    `npx modelapp check ${base} --token ${shown}`,
    `MCP Inspector: npx @modelcontextprotocol/inspector, Streamable HTTP, ${base}/mcp, header Authorization: Bearer ${shown}`,
    `A day to ship: your data in get/list/run, your sign-in in auth.resolve and authorizationServers, MODELAPP_PUBLIC_URL in production (the TODOs in ${existingApp ?? appFile}; docs: quickstart.md and auth.md)`,
  ]
  return { project, steps, warnings, next, token: write ? token : null }
}

/** The report init prints. */
export function formatInit(result: InitResult, dryRun: boolean): string {
  const p = result.project
  const out = [
    `modelapp init${dryRun ? " --dry-run (nothing written)" : ""}: Next.js ${p.nextVersion}, App Router in ${p.appDir}/, ${p.ts ? "TypeScript" : "JavaScript"}${p.alias ? `, alias ${p.alias}*` : ""}${p.nextConfig ? `, ${p.nextConfig}` : ""}`,
    "",
  ]
  const width = Math.max(...result.steps.map((s) => s.verb.length))
  for (const s of result.steps) {
    out.push(`  ${s.verb.padEnd(width)}  ${s.path}${s.note ? `  (${s.note})` : ""}`)
    if (s.how) out.push(...s.how.split("\n").map((l) => `  ${" ".repeat(width)}    ${l}`))
  }
  if (result.warnings.length) out.push("", ...result.warnings.map((w) => `  ! ${w}`))
  out.push("", "Next:", ...result.next.map((n, i) => `  ${i + 1}. ${n}`))
  return out.join("\n")
}

export function initMain(args: string[]): number {
  const dryRun = args.includes("--dry-run")
  const unknown = args.filter((a) => a.startsWith("--") && a !== "--dry-run")
  const dirs = args.filter((a) => !a.startsWith("--"))
  if (unknown.length || dirs.length > 1) {
    console.error("usage: modelapp init [dir] [--dry-run]")
    return 2
  }
  try {
    console.log(formatInit(runInit({ cwd: dirs[0] ?? process.cwd(), dryRun }), dryRun))
    return 0
  } catch (error) {
    if (error instanceof InitError) {
      console.error(`modelapp init: ${error.message}`)
      return 1
    }
    throw error
  }
}
