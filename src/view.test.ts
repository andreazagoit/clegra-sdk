import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { chromium, type Browser, type FrameLocator, type Page } from "playwright"
import { z } from "zod"

import { defineAction, defineApp, defineArtifact, defineEntity, definePage, serve } from "./index"
import { devSignIn } from "./signin"
import { testClient, type ToolCallResult } from "./testing"
import { viewHtml } from "./view"

/**
 * THE GENERATED VIEW IN A REAL BROWSER (spec §5), inside a sandboxed iframe of a harness page that plays the host:
 *
 * - `mcp`: a host that speaks only the MCP Apps bridge (ui/initialize → initialized → tool-input/tool-result,
 *   tools/call refused before the handshake and for tools without "app" in `_meta.ui.visibility`, tool-result
 *   notified again for the view's own calls, as the interactive phase says).
 * - `chatgpt`: the same bridge plus a `window.openai` like ChatGPT's sandbox injects before the widget runs
 *   (toolOutput = structuredContent, toolResponseMetadata = the result envelope, callTool, openai:set_globals
 *   carrying only what changed).
 * - `openai`: a host that refuses ui/initialize and offers only `window.openai.callTool`.
 *
 * Every tool call goes to the app's real MCP endpoint (testClient). The frame is shorter than the list, like an
 * inline widget: what the view says after a click must be inside what the person sees.
 */

type Deal = { id: string; name: string; stage: "open" | "won"; value: number; openedAt: string }
const names = ["Hartley Engineering", "Acme Tools", "Birch Labs", "Cobalt Retail", "Delta Foods", "Ember Studio", "Fjord Logistics", "Granite Works", "Harbor Clinic", "Iris Media", "Juniper Farms", "Kestrel Air"]

function makeApp(deals: Deal[]) {
  const deal = defineEntity({
    name: "deal",
    label: "Deal",
    plural: { en: "Deals", it: "Trattative" },
    schema: z.object({
      id: z.string(),
      name: z.string().meta({ role: "title", label: "Deal", search: true, untrusted: true }),
      stage: z.enum(["open", "won"]).meta({ role: "status", label: "Stage", labels: { open: "Open", won: "Won" }, tones: { won: "success" } }),
      value: z.number().meta({ role: "amount", currency: "EUR", label: "Value" }),
      openedAt: z.iso.datetime().meta({ label: "Opened" }),
    }),
    get: (id) => deals.find((d) => d.id === id) ?? null,
    list: () => ({ rows: deals }),
  })
  const markWon = defineAction({
    name: "mark_won",
    on: deal,
    title: "Mark as won",
    input: z.object({ note: z.string().max(200).optional().meta({ label: "Note" }) }),
    confirm: true,
    expose: { plain: true },
    run: (input, _ctx, record) => {
      const d = deals.find((x) => x.id === record.id)!
      d.stage = "won"
      return { message: `${d.name} marked as won.${input.note ? ` (${input.note})` : ""}`, record: d.id }
    },
  })
  const addDeal = defineAction({
    name: "add_deal",
    title: "Add deal",
    input: z.object({ name: z.string().min(1).meta({ label: "Name" }), stage: z.enum(["open", "won"]).meta({ label: "Stage", labels: { open: "Open", won: "Won" } }) }),
    confirm: false,
    expose: { plain: true },
    run: (input) => {
      deals.push({ id: `d${deals.length + 1}`, name: input.name, stage: input.stage, value: 0, openedAt: "2026-03-15T08:00:00.000Z" })
      return { message: `${input.name} added.` }
    },
  })
  const openDeals = defineArtifact({ name: "open_deals", title: "Open deals", description: "How many deals are open", params: z.object({}), template: "stat", data: () => ({ label: "Open", value: deals.filter((d) => d.stage === "open").length }) })
  const pipeline = definePage({ name: "pipeline", title: "Pipeline", list: deal, columns: ["name", "stage"], params: z.object({ stage: z.enum(["open", "won"]).optional() }), query: () => ({}), actions: [addDeal], badge: openDeals })
  const summary = definePage({ name: "summary", title: "Summary", dashboard: [{ artifact: openDeals, params: {} }] })
  const app = defineApp({ name: "sales", title: "Sales", version: "1.0.0", locale: "en", entities: [deal], actions: [markWon, addDeal], artifacts: [openDeals], pages: [pipeline, summary], nav: [{ section: "Sales", pages: [pipeline, summary] }] })
  return serve(app, { auth: { signIn: devSignIn(app, { code: "VIEW1" }) } })
}

type Mode = "mcp" | "chatgpt" | "openai"
type HostOptions = { mode: Mode; refuse?: Record<string, string>; legacyCallTool?: boolean; open?: { tool: string; args: Record<string, unknown> } }
type Logged = { via: "mcp" | "openai"; method: string; name?: string; args?: Record<string, unknown>; initialized?: boolean; params?: unknown }

// The host page: it frames the view, answers the bridge, relays calls to the app (window.hostCall, from Node).
const HOST_SCRIPT = `
window.hostLog = [];
const cfg = window.__cfg; const frame = document.getElementById("v"); let initialized = false;
const send = (m) => frame.contentWindow.postMessage(m, "*");
const fail = (id, message) => send({ jsonrpc: "2.0", id, error: { code: -32000, message } });
addEventListener("message", async (e) => {
  if (e.source !== frame.contentWindow) return;
  const m = e.data;
  if (m && m.__openai === "callTool") {
    hostLog.push({ via: "openai", method: "callTool", name: m.name, args: m.args });
    if (cfg.refuse[m.name]) return send({ __openaiReply: m.id, error: cfg.refuse[m.name] });
    const r = await window.hostCall(m.name, m.args);
    return send({ __openaiReply: m.id, result: cfg.legacyCallTool ? { result: JSON.stringify(r.content) } : r });
  }
  if (!m || m.jsonrpc !== "2.0") return;
  if (m.method === "ui/initialize") {
    if (cfg.mode === "openai") return send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } });
    return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2026-01-26", hostInfo: { name: "harness", version: "1.0.0" }, hostCapabilities: { serverTools: {} }, hostContext: { theme: "light", locale: "en-US", displayMode: "inline", containerDimensions: { maxHeight: 260 } } } });
  }
  if (m.method === "ui/notifications/initialized") { initialized = true; window.hostInitialized = true; send({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: {} } }); send({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: cfg.initial }); return; }
  if (m.method === "ui/notifications/size-changed") { frame.style.height = Math.min(m.params.height, 260) + "px"; return; }
  if (m.method === "tools/call") {
    const name = m.params && m.params.name; const args = (m.params && m.params.arguments) || {};
    hostLog.push({ via: "mcp", method: "tools/call", name, args, initialized });
    if (!initialized) return fail(m.id, "not initialized");
    const tool = cfg.tools.find((t) => t.name === name);
    const visibility = (tool && tool._meta && tool._meta.ui && tool._meta.ui.visibility) || ["model", "app"];
    if (!tool || !visibility.includes("app")) return fail(m.id, "Tool not callable from the app: " + name);
    if (cfg.refuse[name]) return fail(m.id, cfg.refuse[name]);
    const r = await window.hostCall(name, args);
    send({ jsonrpc: "2.0", id: m.id, result: r });
    // The interactive phase: the host notifies the view's own call's result too.
    send({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: args } });
    send({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: r });
    return;
  }
  if (m.method === "ui/update-model-context") { hostLog.push({ via: "mcp", method: m.method, params: m.params }); return send({ jsonrpc: "2.0", id: m.id, result: {} }); }
  if (m.id !== undefined && m.method) send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } });
});
// What ChatGPT's sandbox does on a global change: window.openai updated, openai:set_globals with only those keys.
window.setGlobals = (globals) => { const w = frame.contentWindow; Object.assign(w.openai, globals); w.dispatchEvent(new w.CustomEvent("openai:set_globals", { detail: { globals } })); };
frame.srcdoc = cfg.html;
`

// ChatGPT's window.openai, set before the widget's own script runs.
const openaiShim = (initial: ToolCallResult) => `<script>(() => {
  let n = 0;
  window.openai = { toolInput: {}, toolOutput: ${JSON.stringify(initial.structuredContent ?? null).replace(/</g, "\\u003c")}, toolResponseMetadata: ${JSON.stringify({ status: "success", mcp_tool_result: initial }).replace(/</g, "\\u003c")}, locale: "en-US", theme: "light", maxHeight: 260, displayMode: "inline",
    callTool: (name, args) => new Promise((resolve, reject) => { const id = ++n; const h = (e) => { if (!e.data || e.data.__openaiReply !== id) return; removeEventListener("message", h); e.data.error ? reject(new Error(e.data.error)) : resolve(e.data.result); }; addEventListener("message", h); parent.postMessage({ __openai: "callTool", id, name, args }, "*"); }) };
})()</script>`

let browser: Browser
before(async () => {
  browser = await chromium.launch()
})
after(async () => {
  await browser?.close()
})

async function host(options: HostOptions): Promise<{ page: Page; view: FrameLocator; log: () => Promise<Logged[]>; deals: Deal[] }> {
  const deals: Deal[] = names.map((name, i) => ({ id: `d${i + 1}`, name, stage: "open", value: 1000 * (i + 1), openedAt: "2026-03-14T09:30:00.000Z" }))
  const app = makeApp(deals)
  const client = await testClient(app, { person: "alice", permissions: "all" })
  const tools = await client.listTools()
  const initial = await client.call(options.open?.tool ?? "deal_list", options.open?.args ?? {})
  const view = viewHtml("Sales")
  const html = options.mode === "mcp" ? view : view.replace("<head>", `<head>${openaiShim(initial)}`)
  const page = await browser.newPage()
  page.on("pageerror", (e) => assert.fail(`the host page or the view threw: ${e.message}`))
  await page.exposeFunction("hostCall", (name: string, args: Record<string, unknown>) => client.call(name, args))
  await page.setContent(`<!doctype html><html><body style="margin:0"><iframe id="v" sandbox="allow-scripts allow-same-origin" style="border:0;width:640px;height:200px"></iframe></body></html>`)
  await page.evaluate((cfg) => ((window as unknown as { __cfg: unknown }).__cfg = cfg), { ...options, refuse: options.refuse ?? {}, html, initial, tools })
  await page.addScriptTag({ content: HOST_SCRIPT })
  return { page, view: page.frameLocator("#v"), log: () => page.evaluate(() => (window as unknown as { hostLog: Logged[] }).hostLog), deals }
}

/** Whether the element is inside what the person sees of the frame (an inline widget shorter than its content). */
async function seen(view: FrameLocator, selector: string): Promise<boolean> {
  return view.locator(selector).evaluate((el) => {
    const r = el.getBoundingClientRect()
    return !(el as HTMLElement).hidden && r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight
  })
}

const rowOf = (view: FrameLocator, name: string) => view.locator("tr.link", { hasText: name })
const scrollToEnd = (view: FrameLocator) => view.locator("body").evaluate(() => window.scrollTo(0, document.body.scrollHeight))

for (const mode of ["mcp", "chatgpt", "openai"] as const) {
  describe(`the generated view in a ${mode === "mcp" ? "host that speaks only the MCP Apps bridge" : mode === "chatgpt" ? "ChatGPT-like host (MCP Apps bridge + window.openai)" : "host with only window.openai"}`, () => {
    test("a row opens its record, Back returns to the list, an action runs with the record's title as the hint", async () => {
      const { page, view, log, deals } = await host({ mode })
      await view.locator("h2", { hasText: "Deals" }).waitFor()
      await scrollToEnd(view)
      await rowOf(view, "Hartley Engineering").click()
      await view.locator("h2", { hasText: "Hartley Engineering" }).waitFor()
      // A date-time is written in the reader's locale with its hour, never as the raw ISO text.
      const opened = await view.locator("dt", { hasText: "Opened" }).locator("xpath=following-sibling::dd[1]").textContent()
      assert.ok(opened && !opened.includes("2026-03-14") && /2026/.test(opened) && /\d{1,2}[:.]\d{2}/.test(opened), `the opening date as the reader reads it: ${opened}`)
      const calls = (await log()).filter((l) => l.method === "tools/call" || l.method === "callTool")
      assert.deepEqual(calls.map((c) => [c.via, c.name, c.args]), [[mode === "openai" ? "openai" : "mcp", "deal_get", { id: "d1" }]], "one call, over the standard bridge when the host has it")
      if (mode !== "openai") assert.ok(calls.every((c) => c.initialized), "no tools/call before the handshake")
      if (mode === "chatgpt") {
        // ChatGPT changes globals (layout, theme, widget state) and may repeat the opening output: the record stays.
        await page.evaluate(() => (window as unknown as { setGlobals: (g: unknown) => void }).setGlobals({ maxHeight: 480 }))
        await page.evaluate(() => (window as unknown as { setGlobals: (g: unknown) => void }).setGlobals({ theme: "dark" }))
        await page.evaluate(() => { const h = window as unknown as { setGlobals: (g: unknown) => void; __cfg: { initial: { structuredContent: unknown } } }; h.setGlobals({ toolOutput: h.__cfg.initial.structuredContent }) })
        await view.locator("h2", { hasText: "Hartley Engineering" }).waitFor()
      }
      // The view's own call's tool-result notification (mcp, chatgpt) didn't wipe the way back.
      await view.locator("button.back").click()
      await view.locator("h2", { hasText: "Deals" }).waitFor()
      await rowOf(view, "Hartley Engineering").click()
      await view.locator("h2", { hasText: "Hartley Engineering" }).waitFor()
      await view.locator(".actions button", { hasText: "Mark as won" }).click()
      await view.locator("form.act input[name=note]").fill("signed today")
      await view.locator("form.act button.primary").click()
      await view.locator(".msg", { hasText: "Hartley Engineering marked as won." }).waitFor()
      assert.equal(deals[0]!.stage, "won")
      const write = (await log()).find((l) => l.name === "deal_mark_won")!
      assert.deepEqual(write.args, { id: "d1", record_title: "Hartley Engineering", note: "signed today" })
      // The record was drawn again from the app: now won.
      await view.locator(".badge", { hasText: "Won" }).waitFor()
      const context = (await log()).filter((l) => l.method === "ui/update-model-context")
      if (mode === "openai") assert.equal(context.length, 0, "no MCP Apps bridge: nothing to tell the model through")
      else {
        assert.equal(context.length, 1, "the model hears about a change made in the view (MCP Apps ui/update-model-context)")
        assert.match(JSON.stringify(context[0]!.params), /deal_mark_won.*marked as won/)
      }
      await page.close()
    })

    test("a host refusal is said where the person looks, at once and after: never a dead click", async () => {
      const { page, view } = await host({ mode, refuse: { deal_get: "MCP Resource not found", deal_mark_won: "Denied by the host" } })
      await view.locator("h2", { hasText: "Deals" }).waitFor()
      await scrollToEnd(view)
      await rowOf(view, "Kestrel Air").click()
      await view.locator("#status.error").waitFor()
      const said = await view.locator("#status").textContent()
      assert.match(said ?? "", /refused the call \(deal_get\).*MCP Resource not found/)
      assert.ok(await seen(view, "#status"), "the refusal is inside the visible part of the frame, not below the list")
      await view.locator("h2", { hasText: "Deals" }).waitFor()
      await page.close()
    })
  })
}

describe("the generated view: a page's actions and the app's navigation", () => {
  test("the primary page action opens its form prefilled from the page's params; the menu opens the other page; the badge counts", async () => {
    const { page, view, log, deals } = await host({ mode: "mcp", open: { tool: "open_pipeline", args: { stage: "won" } } })
    await view.locator("h2", { hasText: "Pipeline" }).waitFor()
    const nav = view.locator("nav.nav")
    await nav.locator(".navlabel", { hasText: "Sales" }).waitFor()
    assert.equal(await nav.locator("button[aria-current=page]").textContent().then((t) => t?.replace(/\d+$/, "")), "Pipeline")
    await nav.locator(".count", { hasText: "12" }).waitFor()
    await view.locator(".pageacts button.primary", { hasText: "Add deal" }).click()
    assert.equal(await view.locator("form.act select[name=stage]").inputValue(), "won", "prefilled from the page's params")
    await view.locator("form.act button.primary").click()
    await view.locator("form.act .ferr", { hasText: "Required" }).waitFor()
    await view.locator("form.act input[name=name]").fill("Lumen Labs")
    await view.locator("form.act button.primary").click()
    await view.locator(".msg", { hasText: "Lumen Labs added." }).waitFor()
    assert.deepEqual(deals.at(-1), { id: "d13", name: "Lumen Labs", stage: "won", value: 0, openedAt: "2026-03-15T08:00:00.000Z" })
    assert.deepEqual((await log()).find((l) => l.name === "add_deal")!.args, { name: "Lumen Labs", stage: "won" })
    await nav.locator("button", { hasText: "Summary" }).click()
    await view.locator("h2", { hasText: "Summary" }).waitFor()
    await view.locator("nav.nav button[aria-current=page]", { hasText: "Summary" }).waitFor()
    await page.close()
  })
})

describe("the generated view and ChatGPT's window.openai specifics", () => {
  test("a callTool answer without the result's structuredContent is said, not swallowed", async () => {
    const { page, view } = await host({ mode: "openai", legacyCallTool: true })
    await view.locator("h2", { hasText: "Deals" }).waitFor()
    await rowOf(view, "Acme Tools").click()
    await view.locator("#status.error", { hasText: "returned no data for the view (deal_get)" }).waitFor()
    await page.close()
  })

  test("labels come from toolResponseMetadata's envelope (mcp_tool_result._meta) and follow a new locale", async () => {
    const { page, view } = await host({ mode: "chatgpt" })
    await view.locator("h2", { hasText: "Deals" }).waitFor()
    await page.waitForFunction(() => (window as unknown as { hostInitialized?: boolean }).hostInitialized === true)
    // The bridge's own tool-result came after the first drawing and was not used: the Italian labels can only come from the envelope.
    await page.evaluate(() => (window as unknown as { setGlobals: (g: unknown) => void }).setGlobals({ locale: "it-IT" }))
    await view.locator("h2", { hasText: "Trattative" }).waitFor()
    await page.close()
  })
})
