import { toNextHandlers } from "@modelapp/next"

import { app } from "../../../../modelapp"

export const { GET, POST, DELETE, OPTIONS } = toNextHandlers(app)
