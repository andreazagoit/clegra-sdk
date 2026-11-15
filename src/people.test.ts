import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, test } from "node:test"

import { z } from "zod"

import { defineApp, type AuthOptions, type PeopleResolver } from "./index"
import { testClient } from "./testing"
import { viewHtml } from "./view"

/**
 * People and languages in plain hosts (spec §3 «People», §7 `l10n`): a person
 * field reaches a view and a model as a name, never as a bare id; a view
 * draws the app's labels in the reader's language, whatever the token said.
 */

const keyFile = join(tmpdir(), `modelapp-test-key-${randomUUID()}.json`)
after(() => rmSync(keyFile, { force: true }))

type Ticket = { id: string; title: string; owner: string; status: "open" | "closed" }
const tickets: Ticket[] = [
  { id: "t1", title: "Printer", owner: "u-ada", status: "open" },
  { id: "t2", title: "Network", owner: "u-gone", status: "closed" },
  { id: "t3", title: "Badge", owner: "u-me", status: "open" },
]

function makeApp(people?: PeopleResolver, dev: AuthOptions["dev"] | false = { keyFile, code: "TEST1", people: [{ id: "u-me", name: "Test caller", permissions: "all" }] }) {
  return defineApp({
    name: "desk",
    title: { en: "Help desk", it: "Assistenza" },
    version: "1.0.0",
    locale: "en",
    auth: dev ? { dev } : { anonymous: { installation: "x", person: { id: "u-me", name: "Me" }, permissions: "all" } },
    ...(people ? { people } : {}),
    entities: {
      ticket: {
        label: { en: "Ticket", it: "Richiesta" },
        plural: { en: "Tickets", it: "Richieste" },
        schema: z.object({
          id: z.string(),
          title: z.string().meta({ role: "title", label: { en: "Title", it: "Titolo" } }),
          owner: z.string().meta({ role: "person", label: { en: "Owner", it: "Responsabile" } }),
          status: z.enum(["open", "closed"]).meta({ role: "status", label: { en: "Status", it: "Stato" }, labels: { open: { en: "Open", it: "Aperta" }, closed: { en: "Closed", it: "Chiusa" } } }),
        }),
        get: (id) => tickets.find((t) => t.id === id) ?? null,
        list: () => ({ rows: tickets }),
      },
    },
    actions: {
      close: { on: "ticket", title: { en: "Close", it: "Chiudi" }, input: z.object({}), confirm: "optional", expose: { plain: true }, run: (_i, ctx, t) => ({ message: ctx.t({ en: `${t.title} closed.`, it: `${t.title} chiusa.` }) }) },
    },
  })
}

describe("people", () => {
  test("a person field is named: the caller from the token, then the app's people; an id nobody names is left out", async () => {
    let asked: string[] = []
    const app = makeApp((ids) => {
      asked = ids
      return { "u-ada": "Ada Rossi" }
    })
    const c = await testClient(app, { person: "u-me" })
    const r = await c.call("ticket_list", {})
    const s = r.structuredContent as { rows: Ticket[]; refs: Record<string, Record<string, string>> }
    assert.deepEqual(s.refs.owner, { "u-ada": "Ada Rossi", "u-me": "Test caller" })
    assert.deepEqual(asked.sort(), ["u-ada", "u-gone"], "the app is asked only for the ids the token doesn't name")
    assert.equal(s.rows[0]!.owner, "u-ada", "structuredContent keeps the bare id, the name is beside it")
    const forModel = JSON.parse(r.content![0]!.text!) as { rows: { owner: unknown }[] }
    assert.deepEqual(forModel.rows[0]!.owner, { id: "u-ada", name: "Ada Rossi" })
    assert.equal(forModel.rows[1]!.owner, "u-gone")
    const one = await c.call("ticket_get", { id: "t3" })
    assert.deepEqual((one.structuredContent as { refs: unknown }).refs, { owner: { "u-me": "Test caller" } })
  })

  test("a failing resolver names nobody but breaks nothing", async () => {
    const c = await testClient(
      makeApp(() => {
        throw new Error("directory down")
      }),
      { person: "u-me" },
    )
    const r = await c.call("ticket_list", {})
    assert.ok(!r.isError)
    assert.deepEqual((r.structuredContent as { refs: unknown }).refs, { owner: { "u-me": "Test caller" } })
  })

  test("an app that can't name people sends no names: its person fields hold the names themselves", async () => {
    const c = await testClient(makeApp(undefined, false), { token: null })
    const r = await c.call("ticket_list", {})
    assert.ok(!r.isError, JSON.stringify(r))
    assert.deepEqual((r.structuredContent as { refs: unknown }).refs, {})
  })

  test("the view shows a person by name, an unnamed one as an unknown person, never the id", () => {
    const html = viewHtml("Desk")
    assert.match(html, /col\.role === "person"/)
    assert.match(html, /unknownPerson: "Unknown person"/)
    assert.match(html, /unknownPerson: "Persona sconosciuta"/)
  })
})

describe("labels in the reader's language", () => {
  test("a call's result carries its labels' other locales for its view (_meta.modelapp.l10n), never for the model", async () => {
    const c = await testClient(makeApp(), { person: "u-me" })
    const r = await c.call("ticket_list", {})
    const view = (r.structuredContent as { view: { title: string; columns: { name: string; label: string }[] } }).view
    assert.equal(view.title, "Tickets", "the token said no language: the app's own")
    const l10n = (r._meta?.modelapp as { l10n: Record<string, Record<string, string>> }).l10n
    assert.equal(l10n.it!.Tickets, "Richieste")
    assert.equal(l10n.it!.Owner, "Responsabile")
    assert.equal(l10n.it!.Open, "Aperta")
    assert.ok(!r.content![0]!.text!.includes("Richieste"), "the model's text is unchanged")
    const done = await c.call("ticket_close", { id: "t1" })
    assert.equal((done._meta?.modelapp as { l10n: Record<string, Record<string, string>> }).l10n.it!["Printer closed."], "Printer chiusa.")
  })

  test("an Italian caller's labels map back to English, the fallback of a reader whose language the app lacks", async () => {
    const c = await testClient(makeApp(), { person: "u-me", locale: "it" })
    const r = await c.call("ticket_list", {})
    assert.equal((r.structuredContent as { view: { title: string } }).view.title, "Richieste")
    assert.equal((r._meta?.modelapp as { l10n: Record<string, Record<string, string>> }).l10n.en!.Richieste, "Tickets")
  })

  test("the view follows hostContext.locale, then English", () => {
    const html = viewHtml("Desk")
    assert.match(html, /l10n\[locale\] \|\| l10n\[lang\] \|\| l10n\.en/)
    assert.match(html, /ctx\.locale\) locale = ctx\.locale/)
    assert.match(html, /"modelapp"\]/, "it reads the labels from the result's _meta.modelapp")
  })
})
