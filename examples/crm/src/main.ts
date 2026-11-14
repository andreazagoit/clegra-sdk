import { app } from "./app"

// Loopback only: the dev sign-in (spec §9) refuses anything else. A tunnel
// (cloudflared) forwards a public https address to this port.
await app.listen({ port: Number(process.env.PORT ?? 3920), host: "127.0.0.1" })
