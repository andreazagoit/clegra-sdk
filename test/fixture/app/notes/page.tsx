import { notes } from "../../clegra/note"
import { currentSession } from "../../clegra"

// The notes, for people: the app's own sign-in, or a transferred session.
export default async function Notes() {
  const { session, banner } = await currentSession("/notes")
  if (!session) return <p data-signin>Sign in to see your notes.</p>
  return (
    <main>
      <div dangerouslySetInnerHTML={{ __html: banner }} />
      <p data-person>{session.person.name}</p>
      <ul>{[...notes.values()].map((n) => <li key={n.id}><a href={`/notes/${n.id}`}>{n.title}</a></li>)}</ul>
    </main>
  )
}
