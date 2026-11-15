import { NextResponse } from "next/server"

/**
 * Who may frame the embeddable pages (/embed/*): `Content-Security-Policy: frame-ancestors` from
 * EMBED_FRAME_ANCESTORS (space-separated origins, e.g. "https://chatgpt.com https://claude.ai"), read per request.
 * Default 'self'. Every other page may not be framed at all.
 */
const SOURCE = /^(?:'self'|'none'|https:\/\/[A-Za-z0-9.*-]+(?::\d+)?|http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?)$/

export function proxy(request: Request) {
  let ancestors = "'none'"
  if (new URL(request.url).pathname.startsWith("/embed/")) {
    const listed = (process.env.EMBED_FRAME_ANCESTORS ?? "").split(/\s+/).filter(Boolean)
    const wrong = listed.filter((s) => !SOURCE.test(s))
    // A wrong entry is a configuration error, said as one (never guessed around).
    if (wrong.length) return new Response(`EMBED_FRAME_ANCESTORS is misconfigured: not origins: ${wrong.join(" ")}`, { status: 500 })
    ancestors = listed.length ? listed.join(" ") : "'self'"
  }
  const response = NextResponse.next()
  response.headers.set("content-security-policy", `frame-ancestors ${ancestors}`)
  return response
}

export const config = {
  // Pages only: not the API (MCP, better-auth), not Next's assets.
  matcher: ["/((?!api/|mcp|\\.well-known/|_next/|favicon.ico).*)"],
}
