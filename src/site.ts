import { PROTOCOL_ID, SITE_MESSAGES, SITE_PATH } from "../spec/src/protocol"

/**
 * THE APP'S OWN SITE (spec §5.1). A workspace client (Clegra's web and desktop clients) shows an app that has a website
 * as that website: it frames the app's real pages at the app's own origin. Who is signed in there is the app's own
 * session: the person signs in with the app's own sign-in inside the frame (its cookie partitioned, `frameCookie` of
 * `@clegra/sdk/signin`), and the client links the same sign-in for its assistant in the same frame
 * (`response_mode=web_message`). The client never signs anyone in to the app.
 *
 * What the SDK adds: the pages are framable by the app and its configured client origins only (`frame-ancestors`),
 * and a small bridge script tells the client where the site is and takes the client's theme and language.
 */

export type SiteOptions = {
  /** Where the site opens (default `/`). */
  start?: string
}

/** A path on the app's own origin: `/`, then no `//`, `\`, spaces or controls; a query and a fragment allowed. */
const PATH = /^\/(?!\/)[^\s\\\u0000-\u001f\u007f]*$/

/** Whether `path` may be a site path. */
export function isSitePath(path: unknown): path is string {
  if (typeof path !== "string" || path.length > 2048 || !PATH.test(path)) return false
  const pathname = path.split(/[?#]/)[0]!
  return pathname !== SITE_PATH && !pathname.startsWith(`${SITE_PATH}/`) && !pathname.startsWith(`/${PROTOCOL_ID}/`)
}

/** The site's start path, checked (default `/`). */
export function siteStart(start: string | undefined): string {
  const value = start ?? "/"
  if (!isSitePath(value)) throw new Error(`site.start "${value}": a path on the app's own site, like / or /dashboard`)
  return value
}

/** The policy in front of every page of the site: framable by the app itself and the client origins only. */
export function siteFraming(clientOrigins: readonly string[]): string {
  return `frame-ancestors 'self'${clientOrigins.map((o) => ` ${o}`).join("")}`
}

/**
 * The bridge, served at `/clegra/site/bridge.js`: inside a frame of one of the app's client origins it tells the
 * client where the site is (`clegra/location`), and applies the client's theme and language (`clegra/context`; the
 * page hears `clegra:context`). Outside such a frame: nothing.
 */
export function siteBridgeScript(clientOrigins: readonly string[]): string {
  return `(() => {
  "use strict";
  if (window.parent === window || window.__clegraSite) return;
  const allowed = ${JSON.stringify(clientOrigins)};
  const ancestors = location.ancestorOrigins ? Array.from(location.ancestorOrigins) : [];
  const origin = ancestors.length ? (allowed.includes(ancestors[0]) ? ancestors[0] : null) : null;
  const targets = origin ? [origin] : allowed;
  if (!targets.length || (ancestors.length && !origin)) return;
  window.__clegraSite = true;
  const M = ${JSON.stringify(SITE_MESSAGES)};
  const post = (m) => { for (const o of targets) window.parent.postMessage(m, o); };
  const root = document.documentElement;
  const apply = (t) => {
    if (t !== "light" && t !== "dark") return;
    if (root.dataset.theme !== t) root.dataset.theme = t;
    if (root.classList.contains("dark") !== (t === "dark")) root.classList.toggle("dark", t === "dark");
    if (root.style.colorScheme !== t) root.style.colorScheme = t;
  };
  let last = "";
  const report = () => {
    const path = location.pathname + location.search + location.hash;
    const title = document.title;
    const key = path + "\\n" + title;
    if (key === last) return;
    last = key;
    post({ type: M.location, path, title });
  };
  for (const k of ["pushState", "replaceState"]) {
    const f = history[k];
    history[k] = function (...a) {
      const r = f.apply(this, a);
      setTimeout(report, 0);
      return r;
    };
  }
  addEventListener("popstate", report);
  addEventListener("hashchange", report);
  new MutationObserver(report).observe(document.head, { subtree: true, childList: true, characterData: true });
  addEventListener("message", (e) => {
    if (e.source !== window.parent || !targets.includes(e.origin)) return;
    const d = e.data;
    if (!d || typeof d !== "object" || d.type !== M.context) return;
    apply(d.theme);
    dispatchEvent(new CustomEvent("clegra:context", { detail: { theme: d.theme === "light" || d.theme === "dark" ? d.theme : undefined, locale: typeof d.locale === "string" ? d.locale : undefined } }));
  });
  report();
})();
`
}
