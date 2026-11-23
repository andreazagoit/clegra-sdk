// For the browser test: a cookie WITHOUT Partitioned, set and read back from inside the cross-site frame. Where the
// browser blocks third-party cookies it never comes back; the site session (Partitioned) does.
export function GET(request: Request) {
  const has = /(?:^|;\s*)probe=1/.test(request.headers.get("cookie") ?? "")
  return new Response(`<p data-probe>${has ? "unpartitioned cookie sent" : "no unpartitioned cookie"}</p>`, {
    headers: { "content-type": "text/html", "set-cookie": "probe=1; Path=/probe; Secure; SameSite=None; HttpOnly" },
  })
}
