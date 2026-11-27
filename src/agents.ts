import { memorySkillFiles, SkillCatalog } from "@modelcontextprotocol/server/ext/skills"

import type { App } from "./app"
import { canonicalJson } from "./auth"
import type { AgentHandle } from "./define"

/**
 * APP AGENTS (profile): each agent is a skill of the app's MCP server (the Skills extension): its `SKILL.md` holds the
 * instructions and `allowed-tools`, and `agent.json` beside it the bounded proposal (tier, steps, approvals, starters,
 * schedules). The Skills extension serves both with their SHA-256 digests; a client approves the agent by content.
 */

export const AGENT_META = "com.clegra/agent"

/** `agent.json` of an agent (the profile's appendix schema). */
export function agentJson(agent: AgentHandle): Record<string, unknown> {
  const c = agent.config
  return {
    tier: c.tier ?? "standard",
    maxSteps: c.maxSteps ?? 30,
    ...(c.approval ? { approval: c.approval } : {}),
    ...(c.starters?.length ? { starters: c.starters } : {}),
    ...(c.schedules?.length ? { schedules: c.schedules.map((s) => ({ name: s.name, ...(s.title ? { title: s.title } : {}), cron: s.cron, timezone: s.timezone ?? "person", starter: s.starter })) } : {}),
  }
}

const yamlString = (value: string) => JSON.stringify(value)

/** `SKILL.md` of an agent: frontmatter (name, description, allowed-tools, the agent.json pointer) and the instructions. */
export function skillMarkdown(agent: AgentHandle): string {
  const c = agent.config
  return `---\nname: ${c.name}\ndescription: ${yamlString(c.description)}\nallowed-tools: ${c.tools.map((t) => t.name).join(" ")}\nmetadata:\n  ${AGENT_META}: agent.json\n---\n${c.instructions.trim()}\n`
}

/** Every file of every agent, as the skill folders hold them. */
export function agentFiles(app: App): Record<string, string> {
  const files: Record<string, string> = {}
  for (const a of app.agents.values()) {
    files[`${a.name}/SKILL.md`] = skillMarkdown(a)
    files[`${a.name}/agent.json`] = `${JSON.stringify(agentJson(a), null, 2)}\n`
  }
  return files
}

/** The skills catalog, loaded once (digests computed then). */
export function agentCatalog(app: App): Promise<SkillCatalog> | null {
  if (!app.agents.size) return null
  return SkillCatalog.load(memorySkillFiles(agentFiles(app)), { strict: true })
}

/**
 * The approval digest of AGT-4, as a client computes it: SHA-256 over the ordered `{ uri, digest }` of every file of
 * the skill and, for each allowed tool, its `name`, `description`, `inputSchema` and `annotations` as `tools/list`
 * gives them. Hex.
 */
export async function agentDigest(files: { uri: string; digest: string }[], tools: { name: string; description?: string; inputSchema?: unknown; annotations?: unknown }[]): Promise<string> {
  const body = canonicalJson({
    files: files.map((f) => ({ uri: f.uri, digest: f.digest })),
    tools: tools.map((t) => ({ name: t.name, description: t.description ?? null, inputSchema: t.inputSchema ?? null, annotations: t.annotations ?? null })),
  })
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)))
  return [...hash].map((b) => b.toString(16).padStart(2, "0")).join("")
}
