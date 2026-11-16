import { toNextHandlers } from "clegra/next"

import { app } from "../../../../clegra"

export const { GET, POST, DELETE, OPTIONS } = toNextHandlers(app)
