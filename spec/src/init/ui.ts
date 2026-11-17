import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"

import type { Project } from "./project"

/**
 * `clegra init --ui`: clegra/ui added to the app. The UI libraries are optional peer dependencies of clegra (a
 * Node-only app installs none of them), so the web ones go into the app's package.json `dependencies`, at the ranges
 * clegra declares, and the app's global stylesheet gets clegra/ui's after Tailwind 4. Nothing already there is changed.
 */

/** Peer dependencies of clegra that are not the web UI's: the server's, React itself (a Next app has it), React Native's, Tailwind (the app's choice). */
const NOT_WEB_UI = new Set(["zod", "next", "react", "react-dom", "react-native", "react-native-svg", "lucide-react-native", "@expo/ui", "tailwindcss"])

/** clegra's peer dependencies (its own package.json, resolved by name: the same in the repository and installed). */
export function clegraPeers(): Record<string, string> {
  const pkg = createRequire(import.meta.url)("clegra/package.json") as { peerDependencies?: Record<string, string> }
  return pkg.peerDependencies ?? {}
}

/** The libraries clegra/ui's web components import, with clegra's ranges. */
export function webUiPeers(peers: Record<string, string> = clegraPeers()): Record<string, string> {
  return Object.fromEntries(Object.entries(peers).filter(([name]) => !NOT_WEB_UI.has(name)))
}

export const UI_IMPORT = '@import "clegra/ui/styles.css";'

export type UiStep = { verb: "edit" | "skip" | "by hand"; path: string; note?: string; how?: string }

export function initUi(project: Project, write: boolean, peers: Record<string, string> = webUiPeers()): { steps: UiStep[]; warnings: string[]; install: boolean } {
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
    steps.push({ verb: "edit", path: "package.json", note: `added clegra/ui's web libraries to dependencies: ${add.map(([n]) => n).join(", ")}` })
  } else steps.push({ verb: "skip", path: "package.json", note: "clegra/ui's web libraries are already there" })

  // 2. The stylesheet: clegra/ui's after Tailwind 4 in the global stylesheet.
  const tailwind = has.tailwindcss
  if (tailwind && !/(^|[\^~>=\s])4(\.|$)|^latest$/.test(tailwind)) warnings.push(`tailwindcss ${tailwind} is in package.json: clegra/ui/styles.css needs Tailwind 4 (or use clegra/ui/prebuilt.css)`)
  const css = [`${project.appDir}/globals.css`, "styles/globals.css", "src/styles/globals.css"].find((p) => existsSync(join(root, p))) ?? null
  const byHand = `Tailwind 4: after @import "tailwindcss"; in your global stylesheet add ${UI_IMPORT}\nNo Tailwind: import "clegra/ui/prebuilt.css" in ${project.appDir}/layout.${project.ts ? "tsx" : "js"}`
  if (!css) steps.push({ verb: "by hand", path: `${project.appDir}/globals.css`, note: "no global stylesheet found", how: byHand })
  else {
    const sheet = readFileSync(join(root, css), "utf8")
    const tw = /^@import\s+["']tailwindcss["'][^;\n]*;[^\n]*$/m.exec(sheet)
    if (sheet.includes("clegra/ui/styles.css") || sheet.includes("clegra/ui/prebuilt.css")) steps.push({ verb: "skip", path: css, note: "already imports clegra/ui's stylesheet" })
    else if (!tw) steps.push({ verb: "by hand", path: css, note: 'no @import "tailwindcss" in it', how: byHand })
    else {
      const at = tw.index + tw[0].length
      if (write) writeFileSync(join(root, css), `${sheet.slice(0, at)}\n${UI_IMPORT}${sheet.slice(at)}`)
      steps.push({ verb: "edit", path: css, note: "clegra/ui's stylesheet after Tailwind (the theme, light and dark; it lets Tailwind see the components' classes)" })
    }
  }
  return { steps, warnings, install: add.length > 0 }
}
