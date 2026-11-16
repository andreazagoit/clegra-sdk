import { embedProxy } from "modelapp/next"

import { app } from "./modelapp"

// The embedded pages: the ticket exchange (POST /embed/_ticket) and frame-ancestors on every /embed response.
export const proxy = embedProxy(app)
export const config = { matcher: "/embed/:path*" }
