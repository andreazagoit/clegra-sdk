import { app } from "./app"

// Loopback only. With MODELAPP_DEV=1 the dev sign-in answers callers on this
// machine (a tunnel, cloudflared, forwards a public https address to this
// port); a host (MODELAPP_ISSUERS) reaches the app at MODELAPP_RESOURCE.
await app.listen({ port: Number(process.env.PORT ?? 3920), host: "127.0.0.1" })
