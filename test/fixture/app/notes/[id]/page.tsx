import { notes } from "../../../clegra/note"
import { currentSession } from "../../../clegra"

// A note's page, at the note's own URL (its MCP resource URI): HTML for people, JSON for a bearer (proxy.ts).
export default async function NotePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { session, banner } = await currentSession(`/notes/${id}`)
  if (!session) return <p data-signin>Sign in to see this note.</p>
  const n = notes.get(id)
  return (
    <main>
      <div dangerouslySetInnerHTML={{ __html: banner }} />
      <p data-person>{session.person.name}{session.transferred ? " (transferred)" : ""}</p>
      <h1 data-note>{n ? n.title : "Not found"}</h1>
    </main>
  )
}
