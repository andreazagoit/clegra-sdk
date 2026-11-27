import Link from "next/link"

import { currentPerson } from "../../clegra"

// Who the app's own sign-in signed in, or a link to it.
export const metadata = { title: "Board" }

export default async function Board() {
  const person = await currentPerson()
  if (!person) return <a href="/signin?return=/board" data-signin>Sign in</a>
  return (
    <>
      <p data-caller>{`${person.name} · ${person.installation}`}</p>
      <Link href="/notes?status=open" data-next>
        Notes
      </Link>
    </>
  )
}
