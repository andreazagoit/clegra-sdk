import { siteProxy } from "@clegra/sdk/next"

import { app } from "./clegra"

// The app's own site in a workspace client (spec §5.1): every page framable by the app's client origins only.
export const proxy = siteProxy(app)
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico|probe).*)"] }
