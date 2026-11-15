import { NextResponse } from "next/server"

/**
 * Who may frame the embeddable pages (/embed/*): EMBED_FRAME_ANCESTORS, origins separated by spaces or commas
 * (e.g. `https://chatgpt.com https://claude.ai`); default the CRM itself. Read at run time. Every other page may
 * not be framed at all (next.config.ts), so sign-in and consent can't be clickjacked.
 */
function frameAncestors(): string {
  const listed = (process.env.EMBED_FRAME_ANCESTORS ?? "").split(/[\s,]+/).filter(Boolean)
  for (const origin of listed) {
    if (origin === "'self'") continue
    const url = URL.canParse(origin) ? new URL(origin) : null
    if (!url || url.origin !== origin || (url.protocol !== "https:" && url.hostname !== "localhost")) throw new Error(`EMBED_FRAME_ANCESTORS: "${origin}" is not an https origin`)
  }
  return ["'self'", ...listed.filter((o) => o !== "'self'")].join(" ")
}

export function proxy() {
  const response = NextResponse.next()
  response.headers.set("content-security-policy", `frame-ancestors ${frameAncestors()}`)
  return response
}

export const config = { matcher: "/embed/:path*" }
