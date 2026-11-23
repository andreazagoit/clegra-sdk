import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import type { Project } from "./project"

/**
 * `clegra init --ui`: @clegra/ui added to the app. It is its own package (its repository, its version); its libraries
 * are its optional peer dependencies, so the web ones go into the app's package.json `dependencies` beside it, at the
 * ranges @clegra/ui declares, and the app's global stylesheet gets @clegra/ui's after Tailwind 4. Nothing already
 * there is changed. @clegra/sdk does not depend on @clegra/ui: the generated MCP Apps view is plain HTML.
 */

/** The package and the range init adds: the @clegra/ui this SDK is checked with (`npm run pack:check`). */
export const UI_PACKAGE = "@clegra/ui"
export const UI_RANGE = "^0.1.0-next.5"

/**
 * The libraries @clegra/ui's web components import, at @clegra/ui's ranges: its peer dependencies without React
 * itself (a Next app has it), React Native's and Tailwind (the app's choice). The pack check compares this list with
 * the peer dependencies of the @clegra/ui tarball it installs.
 */
export const UI_WEB_LIBRARIES: Readonly<Record<string, string>> = {
  "@base-ui/react": "^1.9.0",
  "@dnd-kit/core": "^6.3.1",
  "@dnd-kit/sortable": "^10.0.0",
  "@dnd-kit/utilities": "^3.2.2",
  "@shadcn/react": "^0.3.1",
  "class-variance-authority": "^0.7.1",
  cmdk: "^1.1.1",
  cn: "^0.5.0",
  "date-fns": "^4.4.0",
  "embla-carousel-react": "^8.6.0",
  "input-otp": "^1.5.0",
  "lucide-react": "^1.60.0",
  "next-themes": "^0.4.6",
  "react-day-picker": "^10.0.2",
  "react-resizable-panels": "^4.16.1",
  recharts: "^3.10.1",
  sonner: "^2.0.8",
  "tw-animate-css": "^1.4.0",
}

/** What `--ui` puts in dependencies: @clegra/ui and its web libraries. */
export function uiDependencies(): Record<string, string> {
  return { [UI_PACKAGE]: UI_RANGE, ...UI_WEB_LIBRARIES }
}

export const UI_IMPORT = '@import "@clegra/ui/styles.css";'

export type UiStep = { verb: "edit" | "skip" | "by hand"; path: string; note?: string; how?: string }

export function initUi(project: Project, write: boolean, peers: Record<string, string> = uiDependencies()): { steps: UiStep[]; warnings: string[]; install: boolean } {
  const steps: UiStep[] = []
  const warnings: string[] = []
  const root = project.root

  // 1. The web UI's libraries in package.json.
  const pkgPath = join(root, "package.json")
  const text = readFileSync(pkgPath, "utf8")
  const pkg = JSON.parse(text) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
  const has = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
  const add = Object.entries(peers).filter(([name]) => !has[name])
  if (add.length) {
    pkg.dependencies = Object.fromEntries(Object.entries({ ...(pkg.dependencies ?? {}), ...Object.fromEntries(add) }).sort(([a], [b]) => a.localeCompare(b)))
    const indent = /^\{\n(\s+)"/.exec(text)?.[1] ?? "  "
    if (write) writeFileSync(pkgPath, `${JSON.stringify(pkg, null, indent)}\n`)
    steps.push({ verb: "edit", path: "package.json", note: `added @clegra/ui and its web libraries to dependencies: ${add.map(([n]) => n).join(", ")}` })
  } else steps.push({ verb: "skip", path: "package.json", note: "@clegra/ui and its web libraries are already there" })

  // 2. The stylesheet: @clegra/ui's after Tailwind 4 in the global stylesheet.
  const tailwind = has.tailwindcss
  if (tailwind && !/(^|[\^~>=\s])4(\.|$)|^latest$/.test(tailwind)) warnings.push(`tailwindcss ${tailwind} is in package.json: @clegra/ui/styles.css needs Tailwind 4 (or use @clegra/ui/prebuilt.css)`)
  const css = [`${project.appDir}/globals.css`, "styles/globals.css", "src/styles/globals.css"].find((p) => existsSync(join(root, p))) ?? null
  const byHand = `Tailwind 4: after @import "tailwindcss"; in your global stylesheet add ${UI_IMPORT}\nNo Tailwind: import "@clegra/ui/prebuilt.css" in ${project.appDir}/layout.${project.ts ? "tsx" : "js"}`
  if (!css) steps.push({ verb: "by hand", path: `${project.appDir}/globals.css`, note: "no global stylesheet found", how: byHand })
  else {
    const sheet = readFileSync(join(root, css), "utf8")
    const tw = /^@import\s+["']tailwindcss["'][^;\n]*;[^\n]*$/m.exec(sheet)
    if (sheet.includes("@clegra/ui/styles.css") || sheet.includes("@clegra/ui/prebuilt.css")) steps.push({ verb: "skip", path: css, note: "already imports @clegra/ui's stylesheet" })
    else if (!tw) steps.push({ verb: "by hand", path: css, note: 'no @import "tailwindcss" in it', how: byHand })
    else {
      const at = tw.index + tw[0].length
      if (write) writeFileSync(join(root, css), `${sheet.slice(0, at)}\n${UI_IMPORT}${sheet.slice(at)}`)
      steps.push({ verb: "edit", path: css, note: "@clegra/ui's stylesheet after Tailwind (the theme, light and dark; it lets Tailwind see the components' classes)" })
    }
  }
  return { steps, warnings, install: add.length > 0 }
}
