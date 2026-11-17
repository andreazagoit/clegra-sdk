// The CRM's Clegra app server, as the app serves it (app/api/clegra/[...path]/route.ts). Made on first use: its
// configuration is read from the environment at run time, never during a build.
import type { App } from "@clegra/sdk"

import { createCrmApp } from "./app"
import { crmAuth } from "./auth"

let app: App | undefined
export const crmApp = (): App => (app ??= createCrmApp({ auth: crmAuth() }))
