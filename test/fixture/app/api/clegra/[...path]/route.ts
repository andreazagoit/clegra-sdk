import { toNextHandlers } from "@clegra/sdk/next"

import { app } from "../../../../clegra"

export const { GET, POST, DELETE, OPTIONS } = toNextHandlers(app, { signInPath: "/signin" })
