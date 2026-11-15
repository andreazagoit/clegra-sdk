// The CRM's MAP server, as the app serves it (phase 2 mounts it in app/api/modelapp).
import { authFromEnv } from "./auth"
import { createCrmApp } from "./app"

export const app = createCrmApp({ auth: authFromEnv() })
