import { embedProxy } from "clegra/next"

import { app } from "./clegra"

// The embedded pages: the ticket exchange (POST /embed/_ticket) and frame-ancestors on every /embed response.
export const proxy = embedProxy(app)
export const config = { matcher: "/embed/:path*" }
