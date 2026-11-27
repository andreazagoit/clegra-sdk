/**
 * URI Templates (RFC 6570), the subset web-map uses: simple `{var}` expressions in the path and form-style query
 * expressions `{?a,b}` / `{&a}` at the end. Expanding fills a template from values; matching reads the path variables
 * back out of a URL (web-map MAP-3).
 */

const EXPRESSION = /\{([?&]?)([A-Za-z0-9_.,]+)\}/g

/** Every variable a template names, in order (path and query). */
export function templateVars(template: string): string[] {
  const out: string[] = []
  for (const m of template.matchAll(EXPRESSION)) for (const v of m[2]!.split(",")) if (!out.includes(v)) out.push(v)
  return out
}

/** The variables of the path part only (`{var}`, not `{?q}`): those a URL must carry to match. */
export function pathVars(template: string): string[] {
  const out: string[] = []
  for (const m of template.matchAll(EXPRESSION)) if (!m[1]) for (const v of m[2]!.split(",")) out.push(v)
  return out
}

const enc = (value: unknown) => encodeURIComponent(String(value))

/** The template filled in; an undefined path variable is an error, an undefined query variable is left out. */
export function expand(template: string, values: Readonly<Record<string, unknown>>): string {
  return template.replace(EXPRESSION, (_all, op: string, names: string) => {
    const vars = names.split(",")
    if (!op) {
      return vars
        .map((v) => {
          const value = values[v]
          if (value === undefined || value === null || value === "") throw new Error(`template ${template}: no value for {${v}}`)
          return enc(value)
        })
        .join(",")
    }
    const pairs = vars.filter((v) => values[v] !== undefined && values[v] !== null && values[v] !== "").map((v) => `${v}=${enc(values[v])}`)
    if (!pairs.length) return ""
    return `${op}${pairs.join("&")}`
  })
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * The path variables of `url` read against `template` (both absolute, same origin), or null when it does not match.
 * Query expressions are ignored; a path variable matches one segment.
 */
export function match(template: string, url: string): Record<string, string> | null {
  let t: URL
  let u: URL
  try {
    const base = template.replace(/\{[?&][^}]*\}/g, "")
    t = new URL(base.replace(EXPRESSION, (_a, _op, names: string) => names.split(",").map((n) => `__${n}__`).join(",")))
    u = new URL(url)
  } catch {
    return null
  }
  if (t.origin !== u.origin) return null
  const names: string[] = []
  const source = escapeRegex(t.pathname).replace(/__([A-Za-z0-9_.]+)__/g, (_a, n: string) => {
    names.push(n)
    return "([^/]+)"
  })
  const m = new RegExp(`^${source}$`).exec(u.pathname)
  if (!m) return null
  const out: Record<string, string> = {}
  names.forEach((n, i) => {
    out[n] = decodeURIComponent(m[i + 1]!)
  })
  return out
}

/** Whether `template` is a well-formed template of this subset (balanced braces, query expressions last). */
export function templateProblem(template: string): string | null {
  const stripped = template.replace(EXPRESSION, "")
  if (/[{}]/.test(stripped)) return "unbalanced or unsupported expression (only {var}, {?a,b} and {&a})"
  const firstQuery = template.search(/\{[?&]/)
  if (firstQuery >= 0 && template.slice(firstQuery).replace(/\{[?&][^}]*\}/g, "").length) return "query expressions ({?a}) must come last"
  return null
}
