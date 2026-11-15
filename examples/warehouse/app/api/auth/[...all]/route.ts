import { getAuth } from "@/lib/auth"

// better-auth's endpoints (sign-in, sign-out, session, organization) at /api/auth/*.
async function handle(request: Request): Promise<Response> {
  return (await getAuth()).handler(request)
}

export { handle as DELETE, handle as GET, handle as PATCH, handle as POST, handle as PUT }
