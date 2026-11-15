// Who may call the CRM's MCP server, besides its own users.
import type { AuthOptions } from "@modelapp/server"

/**
 * Workspace hosts (e.g. a Clegra node) from the environment. Their tokens carry the `modelapp` claim; the
 * tenant is `<installation>@<issuer>`, an installation of that host, not an organization here.
 * - MODELAPP_ISSUERS: the hosts whose tokens it trusts (`issuer|jwksUri`, comma-separated);
 * - MODELAPP_RESOURCE: this server's public MCP address (`https://…/mcp`), required with issuers: the only
 *   audience their tokens are accepted for, and the address a host must install the app from.
 *
 * The CRM's own users come next to these (phase 2: the better-auth bridge, `{ ...bridge, ...authFromEnv() }`).
 * There is no dev sign-in: the app has a real one, and dev test people would land in a tenant that is no
 * organization of theirs. Tests sign their callers with `app.devToken` on an app made with `dev`.
 */
export function authFromEnv(env: Record<string, string | undefined> = process.env): Pick<AuthOptions, "issuers" | "resource"> {
  const issuers = (env.MODELAPP_ISSUERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [issuer, jwksUri] = entry.split("|").map((s) => s.trim())
      if (!issuer) throw new Error(`MODELAPP_ISSUERS: "${entry}" has no issuer`)
      return { issuer, ...(jwksUri ? { jwksUri } : {}) }
    })
  const resource = env.MODELAPP_RESOURCE?.trim()
  return { issuers, ...(resource ? { resource } : {}) }
}
