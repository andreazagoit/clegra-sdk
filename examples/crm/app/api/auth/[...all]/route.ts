import { toNextJsHandler } from "better-auth/next-js"

import { auth } from "@/lib/auth"

// better-auth's endpoints (sign-in, session, organizations) at /api/auth/*.
export const { GET, POST } = toNextJsHandler((request) => auth().handler(request))
