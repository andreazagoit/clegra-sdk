import { randomBytes } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, posix, resolve } from "node:path"

import { configWarnings, wrapNextConfig } from "./next-config"
import { detectProject, importPathFor, InitError, clegraPath, routePath, type Project } from "./project"
import { clegraFiles, DEV_CODE_ENV, envLines, nextConfigFile, proxyFile, routeFile } from "./templates"
import { initUi } from "./ui"

/**
 * `clegra init`: @clegra/sdk added to an existing Next.js App Router app. It writes the `clegra/` folder (one file per
 * entity, tool and page, `app` assembling them, `index` serving them with the development sign-in), the route
 * `app/api/clegra/[...path]/route.ts`, wraps next.config with `withClegra`, writes `proxy.ts` (record URLs read with
 * a bearer token) and puts the development sign-in's code in `.env.local`. With `ui`, also @clegra/ui: its web libraries in package.json, its stylesheet after Tailwind (ui.ts).
 * It never overwrites a file: what exists is left as it is, and what it can't do safely it prints for you to do by
 * hand. `dryRun` prints the same and writes nothing.
 */

export { InitError }

export type InitStep = { verb: "create" | "edit" | "skip" | "by hand"; path: string; note?: string; how?: string }

export type InitResult = { project: Project; steps: InitStep[]; warnings: string[]; next: string[]; code: string | null }

export type InitOptions = { cwd: string; dryRun?: boolean; ui?: boolean }

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

  // 1. clegra/ (a clegra/ folder or any clegra.* file there counts: it is the developer's).
  const appDir = clegraPath(project)
  const existingApp = [appDir, ...["ts", "tsx", "js", "mjs"].map((e) => `${appDir}.${e}`)].find((p) => existsSync(at(p)))
  if (existingApp) steps.push({ verb: "skip", path: existingApp, note: "exists, left as it is (the route imports `served` from it)" })
  else {
    const notes: Record<string, string> = { task: "the entity, on sample data: TODO your data", "list-tasks": "a read tool", complete: "a write tool on one task", tasks: "a list page", app: `app "${project.appName}": defineApp assembles them`, index: "serve(app, { origin, auth }): TODO your sign-in" }
    for (const f of clegraFiles({ name: project.appName, title: project.appTitle, ts: project.ts })) create(posix.join(appDir, f.file), f.text, notes[f.file.replace(/\.(ts|js)$/, "")])
  }

  // 2. The route.
  const route = routePath(project)
  const routeDir = dirname(route)
  const existingRoute = ["ts", "js", "mjs", "tsx", "jsx"].map((e) => `${routeDir}/route.${e}`).find((p) => existsSync(at(p)))
  if (existingRoute) steps.push({ verb: "skip", path: existingRoute, note: "exists, left as it is" })
  else create(route, routeFile({ importPath: importPathFor(project) }), `imports { served } from "${importPathFor(project)}"`)
  for (const shadow of ["mcp", ".well-known"]) {
    if (existsSync(join(root, project.appDir, shadow))) warnings.push(`${project.appDir}/${shadow} exists: withClegra's rewrites run before it (beforeFiles), so it no longer answers ${shadow === "mcp" ? "/mcp" : "the Server Card, AI Catalog and OAuth paths"}`)
  }

  // 3. next.config.
  if (!project.nextConfig) {
    const file = project.ts ? "next.config.ts" : "next.config.mjs"
    create(file, nextConfigFile(project.ts), "withClegra({})")
  } else {
    const text = readFileSync(at(project.nextConfig), "utf8")
    warnings.push(...configWarnings(text))
    const edit = wrapNextConfig(text)
    if (edit.kind === "already") steps.push({ verb: "skip", path: project.nextConfig, note: edit.why })
    else if (edit.kind === "manual") steps.push({ verb: "by hand", path: project.nextConfig, note: `not edited: ${edit.why}. Wrap the exported config yourself`, how: edit.how })
    else {
      if (write) writeFileSync(at(project.nextConfig), edit.text)
      steps.push({ verb: "edit", path: project.nextConfig, note: "wrapped the exported config with withClegra" })
    }
  }

  // 4. proxy.ts: record URLs read with a bearer token go to the route (web-map REC-1).
  if (project.proxy && readFileSync(at(project.proxy), "utf8").includes("recordProxy")) {
    steps.push({ verb: "skip", path: project.proxy, note: "already uses recordProxy" })
  } else if (project.proxy) {
    steps.push({ verb: "by hand", path: project.proxy, note: "a proxy exists: not edited. Rewrite bearer GETs on record paths to the clegra route", how: 'import { recordProxy } from "@clegra/sdk/next"\nconst records = recordProxy()\n// in your proxy: if (/^(Bearer|DPoP) /i.test(request.headers.get("authorization") ?? "")) return records(request)\n// and add your entities\' paths (/tasks/:id) to its matcher' })
  } else {
    create(`${project.appDir === "src/app" ? "src/" : ""}proxy.${project.ts ? "ts" : "js"}`, proxyFile(), "recordProxy(): a record URL read with a bearer token gets its JSON")
  }

  // 5. The development sign-in's code in .env.local (appended, never replaced).
  const envPath = ".env.local"
  const envText = existsSync(at(envPath)) ? readFileSync(at(envPath), "utf8") : null
  const existingCode = envText ? new RegExp(`^${DEV_CODE_ENV}=(.+)$`, "m").exec(envText)?.[1]?.trim() ?? null : null
  let code: string | null = existingCode
  if (existingCode) steps.push({ verb: "skip", path: envPath, note: `${DEV_CODE_ENV} is already set` })
  else {
    code = randomBytes(6).toString("hex").toUpperCase()
    const lines = envLines(code)
    if (envText === null) create(envPath, lines, `${DEV_CODE_ENV}: the development sign-in's code, refused in production`)
    else {
      if (write) appendFileSync(at(envPath), `${envText.endsWith("\n") || envText === "" ? "" : "\n"}\n${lines}`)
      steps.push({ verb: "edit", path: envPath, note: `appended ${DEV_CODE_ENV}: the development sign-in's code, refused in production` })
    }
  }
  if (!project.envIgnored) warnings.push(".gitignore does not keep .env.local out of git: add `.env*.local` to it")

  // 6. @clegra/ui (--ui).
  let installUi = false
  if (options.ui) {
    const ui = initUi(project, write)
    steps.push(...ui.steps)
    warnings.push(...ui.warnings)
    installUi = ui.install
  }

  if (project.oldZod) warnings.push(`zod ${project.oldZod} is installed: @clegra/sdk needs zod 4 (npm i zod@4)`)
  if (project.proxy && !readFileSync(at(project.proxy), "utf8").includes("recordProxy")) warnings.push(`${project.proxy} runs before every route: let /mcp, /.well-known/*, /oauth/*, /confirm/*, /session-transfer/* and /api/clegra/* through without a session (MCP clients send a bearer token, never your cookies)`)

  const base = `http://localhost:${project.port}`
  const shown = write ? code : "<generated on a real run>"
  const next = [
    ...(project.missing.length ? [`npm i ${project.missing.join(" ")}`] : []),
    ...(installUi ? ["npm install   (@clegra/ui's libraries, added to package.json)"] : []),
    `npm run dev   (then ${base}/mcp is the MCP server, ${base}/mcp/server-card its Server Card)`,
    `MCP Inspector: npx @modelcontextprotocol/inspector, Streamable HTTP, ${base}/mcp: it signs in through the development login (code ${shown})`,
    `npx @clegra/sdk check ${base} --token <the access token the Inspector got>`,
    `A day to ship: your data in get/list/run, your pages at the paths the definitions name, your sign-in (createSignIn of @clegra/sdk/signin, or auth.verify), CLEGRA_PUBLIC_URL in production (the TODOs in ${existingApp ?? appDir}/; docs: start-next.md and auth.md)`,
  ]
  return { project, steps, warnings, next, code: write ? code : null }
}

/** The report init prints. */
export function formatInit(result: InitResult, dryRun: boolean): string {
  const p = result.project
  const out = [
    `clegra init${dryRun ? " --dry-run (nothing written)" : ""}: Next.js ${p.nextVersion}, App Router in ${p.appDir}/, ${p.ts ? "TypeScript" : "JavaScript"}${p.alias ? `, alias ${p.alias}*` : ""}${p.nextConfig ? `, ${p.nextConfig}` : ""}`,
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
  const ui = args.includes("--ui")
  const unknown = args.filter((a) => a.startsWith("--") && a !== "--dry-run" && a !== "--ui")
  const dirs = args.filter((a) => !a.startsWith("--"))
  if (unknown.length || dirs.length > 1) {
    console.error("usage: clegra init [dir] [--ui] [--dry-run]")
    return 2
  }
  try {
    console.log(formatInit(runInit({ cwd: dirs[0] ?? process.cwd(), dryRun, ui }), dryRun))
    return 0
  } catch (error) {
    if (error instanceof InitError) {
      console.error(`clegra init: ${error.message}`)
      return 1
    }
    throw error
  }
}
