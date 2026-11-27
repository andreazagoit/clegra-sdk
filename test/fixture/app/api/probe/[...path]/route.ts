import { toNextHandlers } from "@clegra/sdk/next"
import type { ServedApp } from "@clegra/sdk"
import type { NextRequest } from "next/server"

// Test-only probes: what a route handler sees of a (rewritten) request, and an SSE stream through toNextHandlers.
const streaming = {
  devMode: false,
  manifest: () => ({ mcp: { url: "/mcp" } }),
  fetch: async (request: Request) => {
    const url = new URL(request.url)
    if (url.pathname === "/stream") {
      const encoder = new TextEncoder()
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (let i = 0; i < 3; i++) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ i, at: Date.now() })}\n\n`))
            await new Promise((r) => setTimeout(r, 400))
          }
          controller.close()
        },
      })
      return new Response(body, { headers: { "content-type": "text/event-stream" } })
    }
    return Response.json({ adapterUrl: request.url, host: request.headers.get("host"), forwardedHost: request.headers.get("x-forwarded-host"), forwardedProto: request.headers.get("x-forwarded-proto") })
  },
} as unknown as ServedApp
const adapted = toNextHandlers(streaming, { mount: "/api/probe" })

export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  if (url.pathname.endsWith("/raw")) {
    return Response.json({ url: request.url, nextUrl: request.nextUrl.href, forwardedFor: request.headers.get("x-forwarded-for"), forwardedHost: request.headers.get("x-forwarded-host"), host: request.headers.get("host") })
  }
  // The same stream straight from a route handler, without the adapter's headers (compare with /stream).
  if (url.pathname.endsWith("/bare-stream")) return streaming.fetch(new Request(new URL("/stream", url)))
  return adapted.GET(request)
}
