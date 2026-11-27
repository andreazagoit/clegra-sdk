import { toNextHandlers } from "@clegra/sdk/next"

import { served } from "../../../../clegra"

export const { GET, POST, DELETE, OPTIONS } = toNextHandlers(served, { signInPath: "/signin" })
