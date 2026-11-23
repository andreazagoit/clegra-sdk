import { siteProxy } from "@clegra/sdk/next"

import { app } from "./clegra"

// The app's own site in a Clegra client (spec §5.1): who may frame each page, the signed-out page of a Clegra frame.
export const proxy = siteProxy(app)
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico|probe).*)"] }
