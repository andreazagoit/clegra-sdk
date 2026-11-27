import { currentPerson } from "../../clegra"

export const metadata = { title: "Notes" }

export default async function Notes() {
  const person = await currentPerson()
  return <p data-notes>{person ? `notes for ${person.name}` : "signed out"}</p>
}
