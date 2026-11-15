/**
 * Wrapping an existing next.config with `withModelApp`, as a text edit that is made only when it is certainly
 * right: one `export default <expression>` (or `module.exports = <expression>`) on one line. Anything else
 * (a config written across lines after `export default`, two exports, …) is not edited: init prints the edit.
 */

export type ConfigEdit =
  | { kind: "edited"; text: string }
  | { kind: "already"; why: string }
  | { kind: "manual"; why: string; how: string }

/** Whether brackets and quotes are balanced on one line (so the expression ends there). */
function balanced(expression: string): boolean {
  let depth = 0
  let quote: string | null = null
  for (let i = 0; i < expression.length; i++) {
    const c = expression[i]!
    if (quote) {
      if (c === "\\") i++
      else if (c === quote) quote = null
    } else if (c === '"' || c === "'" || c === "`") quote = c
    else if ("([{".includes(c)) depth++
    else if (")]}".includes(c) && --depth < 0) return false
  }
  return depth === 0 && quote === null
}

function manualHow(cjs: boolean): string {
  return cjs
    ? 'const { withModelApp } = require("modelapp/next")\n…\nmodule.exports = withModelApp(<your config>)'
    : 'import { withModelApp } from "modelapp/next"\n…\nexport default withModelApp(<your config>)'
}

export function wrapNextConfig(text: string): ConfigEdit {
  if (/\bwithModelApp\b/.test(text)) return { kind: "already", why: "already uses withModelApp" }
  const lines = text.split("\n")
  const esm = lines.flatMap((l, i) => (/^export\s+default\b/.test(l) ? [i] : []))
  const cjs = lines.flatMap((l, i) => (/^module\.exports\s*=/.test(l) ? [i] : []))
  if (esm.length + cjs.length !== 1) {
    return { kind: "manual", why: esm.length + cjs.length === 0 ? "no top-level `export default` or `module.exports =` found" : "more than one default export", how: manualHow(cjs.length > 0) }
  }
  const isCjs = cjs.length === 1
  const at = isCjs ? cjs[0]! : esm[0]!
  const line = lines[at]!
  const m = (isCjs ? /^(module\.exports\s*=\s*)(.*?)(;?)\s*$/ : /^(export\s+default\s+)(.*?)(;?)\s*$/).exec(line)!
  const expression = m[2]!.trim()
  // A function or class declaration, or a config that goes on over several lines: not edited by text.
  if (!expression || /^(async\s+)?(function|class)\b/.test(expression) || !balanced(expression) || /=>\s*$/.test(expression)) {
    return { kind: "manual", why: "the exported config spans several lines", how: manualHow(isCjs) }
  }
  const semi = /;\s*$/.test(line) || lines.some((l) => /^import\s.*;\s*$/.test(l)) ? ";" : ""
  const q = (text.match(/'/g)?.length ?? 0) > (text.match(/"/g)?.length ?? 0) ? "'" : '"'
  lines[at] = `${m[1]}withModelApp(${expression})${m[3] || semi}`
  const statement = isCjs ? `const { withModelApp } = require(${q}modelapp/next${q})${semi}` : `import { withModelApp } from ${q}modelapp/next${q}${semi}`
  // After the last import (or require) line; without one, after the leading comment lines (`// @ts-check` stays first).
  const importLine = isCjs ? /^(const|let|var)\s.*=\s*require\(['"][^'"]+['"]\)/ : /^(import\s.*|\}\s*)from\s+['"][^'"]+['"]|^import\s+['"][^'"]+['"]/
  let insertAt = -1
  for (let i = 0; i < at; i++) if (importLine.test(lines[i]!)) insertAt = i + 1
  if (insertAt < 0) {
    insertAt = 0
    while (insertAt < at && (/^\s*\/\/|^\s*["']use strict["']/.test(lines[insertAt]!) || (insertAt === 0 && lines[0]!.startsWith("#!")))) insertAt++
  }
  lines.splice(insertAt, 0, statement)
  return { kind: "edited", text: lines.join("\n") }
}

/** Options in the config that withModelApp refuses at start: said by init now, not by next dev later. */
export function configWarnings(text: string): string[] {
  const out: string[] = []
  if (/\bbasePath\s*:/.test(text)) out.push("next.config sets basePath: withModelApp refuses it (/mcp and /.well-known/… must be at the root of the host)")
  if (/\btrailingSlash\s*:\s*true\b/.test(text)) out.push("next.config sets trailingSlash: true: withModelApp refuses it (it redirects /mcp to /mcp/)")
  return out
}
