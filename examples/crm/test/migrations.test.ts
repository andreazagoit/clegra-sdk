import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

/**
 * drizzle-kit applies only the migrations whose `when` is newer than the last one a database recorded, and silently
 * skips one with an older `when`: the journal's entries must be strictly increasing (0005 once was not, and the
 * later-runs table never reached a database that had 0004).
 */
test("the migrations' journal is in order: idx and when strictly increasing", () => {
  const journal = JSON.parse(readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8")) as { entries: { idx: number; when: number; tag: string }[] }
  journal.entries.forEach((entry, i) => {
    assert.equal(entry.idx, i, entry.tag)
    if (i > 0) assert.ok(entry.when > journal.entries[i - 1]!.when, `${entry.tag} is older than ${journal.entries[i - 1]!.tag}`)
  })
})
