import { requireViewer } from "@/lib/session"

/**
 * Pages made to be framed (a workspace host, an MCP Apps view): no app chrome, a neutral background, compact.
 * For now they use the app's own session cookie; a signed embed ticket for third-party frames comes later.
 */
export default async function EmbedLayout({ children }: { children: React.ReactNode }) {
  await requireViewer()
  return <div className="min-h-screen bg-white p-3 text-sm">{children}</div>
}
