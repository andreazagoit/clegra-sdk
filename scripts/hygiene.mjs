// THE HYGIENE CHECK: nothing private ships or is committed. This repository is meant to be public, and the tarball
// is published: no customer or private names, local paths, names of Clegra's private repository, or secrets.
//   node scripts/hygiene.mjs <file.tgz>...   every file of each tarball (`npm run pack:check` runs it on the tarball)
//   node scripts/hygiene.mjs --tree          every file git tracks here (`npm run hygiene`, CI)
// A finding prints `file:line: pattern «text»`; any finding fails.
import { execFileSync } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")

export const FORBIDDEN = [
  // Customers and the software they run (never named in public code), private names and places.
  /nuova[\s_-]*digi/i,
  /digiservice/i,
  /\bnds\b/i,
  /widegest/i,
  /\barca\b/i,
  /upcominghub/i,
  /andrea/i,
  /@gmail/i,
  /noxis/i,
  /company[-_ ]?brain/i,
  /@brain\//i,
  /@clegra-apps\//i,
  /\/Users\//,
  /\/private\/tmp/,
  /\bdgs\b/i,
  /brain_v4|brain_unit|brain_prova/i,
  // Paths of Clegra's private repository.
  /\bapps\/(client|core|node|site|mobile|desktop|lavori|staff)\b/,
  /\bpackages\/(plugin-spec|modules|platform|engine|ui|i18n|brand|clegra)\b/,
  /\bapps-store\//,
  // Secrets.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bnpm_[A-Za-z0-9]{30,}/,
  /AKIA[0-9A-Z]{16}/,
  /xox[abpr]-[A-Za-z0-9-]{10,}/,
  /postgres(ql)?:\/\/[^\s"'`]+:[^\s"'`]+@(?!localhost|127\.0\.0\.1|host)/i,
  /(api[_-]?key|secret|password)["']?\s*[:=]\s*["'][^"'\s]{12,}["']/i,
  /\bprj_[A-Za-z0-9]{20,}|\bteam_[A-Za-z0-9]{20,}/,
]

/**
 * The package names before the split into @clegra/sdk and @clegra/ui (npm refused the unscoped «clegra»): no import,
 * dependency or command may use them. The wire names stay (`clegra://`, `_meta.clegra`, the bin `clegra`, CLEGRA_*).
 * The changelogs (HISTORY) are exempt: their older entries keep the names of their time.
 */
export const OLD_NAMES = [
  /(?<![@\w/.-])clegra\/(ui|next|node|testing|spec)\b/,
  /\b(from|import|require\()\s*\(?\s*["']clegra["']/,
  /["']clegra["']\s*:\s*["'](file:|\^|~|\*|\d|latest|next)/,
  /\bnp[mx]\s+(i|install|add)?\s*clegra(@|\s|$)/,
  /\bnpx\s+clegra\b/,
]

/** Files whose older entries are history (checked against FORBIDDEN, not OLD_NAMES). */
const HISTORY = /(^|\/)CHANGELOG\.md$/

/**
 * What may appear although a FORBIDDEN pattern matches it: the licence's owner (NOTICE.md), the package's public repository and the invented secrets
 * of the tests. Only these exact strings are taken out of a line before it is checked.
 */
export const ALLOWED = [
  "Andrea Zago, ditta individuale",
  // The public GitHub repository of this package (package.json repository, homepage, bugs; README links).
  "github.com/andreazagoit/clegra-sdk",
  'const SECRET = "an-embed-secret-for-the-tests-only-0123456789"',
  'CLEGRA_OAUTH_PASSWORD: "not-the-password"',
  'secret: "a-test-secret-for-embedded-pages-0123456789"',
  'secret: "a-different-secret-for-another-app-0123456789"',
  // A wire name (the key under the MCP Apps host context's _meta that Clegra's look rides in), not a package path.
  '_meta["clegra/ui"]',
  'CLEGRA_UI_META_KEY = "clegra/ui"',
]

/** This file names the patterns it looks for: it is not checked against them. */
const SELF = ["scripts/hygiene.mjs"]

function checkFiles(base, names) {
  const findings = []
  for (const name of names) {
    if (SELF.includes(name)) continue
    for (const pattern of FORBIDDEN) if (pattern.test(name)) findings.push(`${name}: file name matches ${pattern}`)
    const buffer = readFileSync(join(base, name))
    if (buffer.includes(0)) continue // binary
    buffer
      .toString("utf8")
      .split("\n")
      .forEach((raw, i) => {
        const line = ALLOWED.reduce((l, allowed) => l.split(allowed).join(""), raw)
        for (const pattern of HISTORY.test(name) ? FORBIDDEN : [...FORBIDDEN, ...OLD_NAMES]) {
          const m = pattern.exec(line)
          if (m) findings.push(`${name}:${i + 1}: ${pattern} «${line.slice(Math.max(0, m.index - 30), m.index + m[0].length + 30).trim()}»`)
        }
      })
  }
  return findings
}

const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]))

/** The findings of one tarball. */
export function checkTarball(tarball) {
  const dir = mkdtempSync(join(tmpdir(), "clegra-hygiene-"))
  try {
    execFileSync("tar", ["-xzf", tarball, "-C", dir])
    return checkFiles(dir, walk(dir).map((f) => relative(dir, f)))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The findings of every file git tracks in this repository. */
export function checkTree() {
  const names = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean)
  return checkFiles(root, names)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let bad = 0
  const report = (what, findings) => {
    console.log(`${findings.length ? "FAIL" : "ok"} hygiene ${what}${findings.length ? `: ${findings.length} findings` : ""}`)
    for (const f of findings) console.log(`  ${f}`)
    bad += findings.length
  }
  const args = process.argv.slice(2)
  if (!args.length) throw new Error("usage: node scripts/hygiene.mjs --tree | <file.tgz>...")
  for (const arg of args) report(arg === "--tree" ? "of the repository tree" : arg, arg === "--tree" ? checkTree() : checkTarball(arg))
  process.exit(bad ? 1 : 0)
}
