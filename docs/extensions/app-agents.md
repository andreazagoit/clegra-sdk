# Profile: agents shipped by an app, as Skills

| | |
|---|---|
| **Kind** | Profile on the Skills extension (`io.modelcontextprotocol/skills`, SEP-2640, Beta) and Tasks (SEP-2663). No capability |
| **Status** | Draft 0.2 |
| **Builds on** | A skill (`SKILL.md` with `allowed-tools`) served over MCP with a digest per file; Tasks for runs with nobody present |
| **Adds only** | Model tier, approvals, schedules, approval locked to content, an isolated context |
| **Offered to** | MCP Agents interest group, and the Skills maintainers |

MUST, SHOULD and MAY (RFC 2119) say what an app or client that follows this profile does. Terms and the family:
[the index](README.md).

## 1. What it is

An app MAY ship ready-made agents: an accounting app, a «collections assistant»; a job-requests app, a
«triage helper». An agent is a **skill** of the
app's MCP server: its `SKILL.md` is the instructions, its `allowed-tools` are the only tools it may call, and one
more file in the skill folder, `agent.json`, carries a bounded proposal. The client's own model runs it; whoever
governs the account approves it; the app is called only through its tools. A client without the profile sees an
ordinary skill.

## 2. The skill

The accounting app's collections agent:

```markdown
---
name: collections
description: Follows up overdue invoices and drafts reminders.
allowed-tools: invoice.list invoice.get reminder.draft reminder.send
metadata:
  com.clegra/agent: agent.json
---
Review overdue invoices oldest first. Draft a reminder for each customer…
```

```json
{
  "tier": "standard", "maxSteps": 30,
  "approval": { "change": "ask" },
  "starters": ["Which invoices are overdue by more than 30 days?"],
  "schedules": [{ "name": "weekly-review", "title": "Every Monday at 8", "cron": "0 8 * * 1", "timezone": "person", "starter": 0 }]
}
```

| Member | Meaning |
|---|---|
| `tier` | `fast`, `standard` or `strong`: how capable a model it needs. Never a vendor or a model name. |
| `maxSteps` | Most tool calls in one run. The client stops the run there. |
| `approval.change` | `ask` or `always` for tools that change data: a request to be stricter than the client's default. |
| `starters` | Opening requests offered to the person. |
| `schedules` | Proposed timed runs: `cron` (five fields, no more often than once an hour), `timezone` (an IANA name, or `person` for the person's own), `starter` (index into `starters`: what the run is asked). |

Serving it needs nothing beyond the Skills extension: the server lists the skill in `skills/list` with every file
of its folder in `resources` (`skill://collections/SKILL.md`, `skill://collections/agent.json`), each with its
SHA-256 digest, and answers `resources/read` for those URIs with the file's bytes. In practice: one folder in the
repository, and a handler that walks it at start-up and computes the digests.

## 3. Rules

- **AGT-1 A ceiling, never a grant.** The agent acts under the person's token and scopes. `allowed-tools` names
  tools of this server only and only narrows. Whoever approves may narrow further, never widen.
- **AGT-2 It can only restrict.** A proposal can make the client's defaults stricter, never looser: there is no
  way to ask for automatic approval. The default for a tool that changes data is `ask`. A tool the app confirms
  ([confirmation](confirmation.md)) is confirmed by the person on the app's page whatever the proposal says.
- **AGT-3 Who approves.** An agent is off until it is approved: by an administrator where the account belongs to
  an organization, by the person themselves where it does not. Either is shown the same screen: instructions,
  tools with their descriptions, starters, schedules.
- **AGT-4 Approved by content.** The approval is bound to a SHA-256 digest over (a) the ordered list of
  `{ uri, digest }` of **every** file the Skills extension lists for the skill, and (b) for each tool in
  `allowed-tools`, its `name`, `description`, `inputSchema` and `annotations` as `tools/list` gives them. The
  client recomputes it before every run; if anything changed, the agent is off again until the difference is
  approved. A skill whose files are listed as dynamic (no digests) cannot be an agent.
- **AGT-5 Third-party words.** Instructions, starters and schedule titles are a third party's text: placed below
  the client's and the approver's rules, and all inside the approved digest.
- **AGT-6 Isolated context.** An app's agent runs in a context that holds only its instructions, the person's
  request for that run and the results of this server's tools. No record, result or message of another app or of
  the main conversation enters without the person's explicit gesture. What it returns to the main assistant is
  untrusted data.
- **AGT-7 Unattended runs.** A scheduled or background run needs the `offline_access` scope ([access](access.md))
  and may call only the tools the approver ticked for unattended use, one by one, on the approval screen; nothing
  is allowed by category. A tool the app confirms never runs unattended: it becomes a task that waits for the
  person (guide, CNF-9).
- **AGT-8 Schedules are proposals** the client runs on its own scheduler when someone enables them, no more often
  than once an hour. The app is never called on a timer to find work.
- **AGT-9 What the app sees.** Tool calls, and nothing else: not what the person asked, not what the model
  answered.

## In `@clegra/sdk`

From 0.4.0, `defineAgent({ name, description, instructions, tools, tier, maxSteps, approval, starters, schedules })`
is written as the skill folder above, in memory: `SKILL.md` (with `allowed-tools` from the tool handles) and
`agent.json`, served through the official Skills extension with a SHA-256 digest per file. `defineApp` refuses a
schedule more often than hourly and a tool that is not the app's own.

## 4. Security

The risks are a changed skill or a changed tool definition after approval (AGT-4: a description rewritten to steer
the model, or `readOnlyHint` flipped to enter unattended runs), data of other apps flowing into this app's tool
arguments (AGT-6), and an app proposing its own unattended writes driven by text in its records (AGT-2, AGT-7).
Said openly: arguments are written by a model from the run's context, so the app sees what that run was asked
insofar as it lands in arguments; AGT-6 keeps the rest out.

## 5. Checks

1. A changed instruction, file, starter, schedule, or a changed description, schema or annotation of an allowed
   tool, turns the agent off (AGT-4).
2. A call to a tool outside `allowed-tools` is refused by the client (AGT-1).
3. A run does not see the main conversation or another app's results (AGT-6).
4. An unattended run calls only ticked tools, never without `offline_access`; a confirmed tool waits for the
   person (AGT-7).
5. A schedule more frequent than hourly is refused (AGT-8).

## 6. Open points

1. `allowed-tools` is experimental in the Agent Skills format.
2. How a client proves isolation (AGT-6) to an auditor.
3. Frontmatter `metadata` holds strings only, hence the separate `agent.json`; a native place may come from the
   Agents interest group.
4. The exact member names of `skills/list` were taken from a reviewer's reading of SEP-2640, not re-read here.

## Appendix. JSON Schema of `agent.json`

```json
{
  "$id": "https://example.org/app-agents/agent/0.2", "type": "object", "additionalProperties": false, "properties": {
    "tier": { "enum": ["fast", "standard", "strong"], "default": "standard" },
    "maxSteps": { "type": "integer", "minimum": 1, "maximum": 200, "default": 30 },
    "approval": { "type": "object", "additionalProperties": false, "properties": { "change": { "enum": ["ask", "always"] } } },
    "starters": { "type": "array", "maxItems": 6, "items": { "type": "string", "maxLength": 200 } },
    "schedules": { "type": "array", "items": { "type": "object", "required": ["name", "cron", "starter"], "properties": {
      "name": { "type": "string" }, "title": { "type": "string", "maxLength": 80 }, "cron": { "type": "string" },
      "timezone": { "type": "string", "default": "person" }, "starter": { "type": "integer", "minimum": 0 } } } } }
}
```

References: Skills extension (SEP-2640, Final; extension in Beta); Agent Skills specification
(https://agentskills.io/specification); Tasks (SEP-2663, Final); MCP Agents interest group.
