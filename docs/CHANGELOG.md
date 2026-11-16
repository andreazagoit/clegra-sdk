# Changelog

MAP 1.0 and the `modelapp` package (not published yet). Newest first. The larger earlier drafts keep their own
changelog in [future/CHANGELOG.md](future/CHANGELOG.md).

## Unreleased (1.0 draft)

### The generated view in hosts (spec §5)

- **Clicking a row in ChatGPT looked dead.** The view now finishes `ui/initialize` before any `tools/call`
  and calls over the MCP Apps bridge whenever the host answered it; `window.openai.callTool` is used only by a host
  that refused `ui/initialize`, and an answer without `structuredContent` is an error.
- The opening result is drawn once. Later `ui/notifications/tool-result` messages (sent for the view's own calls)
  and `openai:set_globals` events (sent for every layout, theme or state change) no longer replace the record the
  person opened or remove the way back. `toolResponseMetadata` is read as ChatGPT gives it (the MCP result
  envelope: `_meta` under `mcp_tool_result`).
- Every call from the view shows progress at once and its outcome where the person looks: a status line kept at
  the top of the view, with the host's own words when it refuses and a clear message after 30 seconds without an
  answer. Before, a refusal was written below the list, outside an inline frame.
- Rows are focusable and open with Enter or Space.
- A change made in the view is told to the model (`ui/update-model-context`, the result's text).

### Records named by their title (spec §6 rule 10, §7)

- The text a model reads of a list and of a get carries each record's `title` beside its `uri` (`search` and
  `fetch` already did).
- Every action tool on a record takes an optional `record_title` beside `id`, and both descriptions tell the model
  to name the record by its title. It is a display hint for a client's own approval prompt: never passed to the
  handler, never shown as the app's; a hint that names another record fails the call with `invalid_input`.
  `record_title` is reserved in an action's `input`.
- Conformance: new checks `mcp.titles` and `mcp.app-callable`.
