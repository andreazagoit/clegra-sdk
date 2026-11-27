// What the core needs from its runtime beyond Web APIs, given by the adapter it runs under (`@clegra/sdk/node`,
// `@clegra/sdk/next`, `@clegra/sdk/express`). The core imports no module of Node's own.

/** Every address a host name resolves to. */
export type HostLookup = (host: string) => Promise<string[]>

let lookup: HostLookup | null = null

/**
 * The runtime's DNS resolver, set by an adapter: the sign-in module resolves a client's host before it fetches its
 * metadata document, and refuses a host that resolves inside the network.
 */
export function useHostLookup(fn: HostLookup): void {
  lookup = fn
}

/** The resolver an adapter set, or null on a runtime that gave none. */
export const hostLookup = (): HostLookup | null => lookup
