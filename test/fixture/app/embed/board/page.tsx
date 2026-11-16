import { getEmbedCaller } from "modelapp/next"

import { app } from "../../../modelapp"

// Who the ticket signed in, or "signed out" (no ticket, a top-level visit, an expired session).
export default async function Board() {
  const caller = await getEmbedCaller(app, "board")
  return <p data-caller>{caller ? `${caller.person?.name} · ${caller.installation} · ${caller.can("notes.view") ? "notes.view" : "-"}` : "signed out"}</p>
}
