import { recordProxy } from "@clegra/sdk/next"

// A record's URL is also its page: a GET with a bearer token goes to the clegra route (web-map REC-1).
export const proxy = recordProxy()
export const config = { matcher: ["/notes/:id"] }
