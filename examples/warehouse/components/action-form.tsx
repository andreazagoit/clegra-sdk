"use client"

import { useActionState, useEffect, useRef } from "react"

/** What a server action of the app answers: a line for the person, good or bad. */
export type ActionState = { ok?: string; error?: string; /** What was typed, given back with a refusal so the person can correct it (never a password). */ values?: Record<string, string> } | null

/** A form posting to a server action, showing what it answered. Works before hydration too (progressive enhancement). */
export function ActionForm({ action, children, className, submit, quiet }: { action: (state: ActionState, form: FormData) => Promise<ActionState>; children?: React.ReactNode; className?: string; submit: string; quiet?: boolean }) {
  const [state, formAction, pending] = useActionState(action, null)
  const form = useRef<HTMLFormElement>(null)
  // React resets a form after its action: after a refusal, put back what the person typed.
  useEffect(() => {
    if (!state?.error || !state.values || !form.current) return
    for (const [name, value] of Object.entries(state.values)) {
      const field = form.current.elements.namedItem(name)
      if ((field instanceof HTMLInputElement && field.type !== "password" && field.type !== "hidden") || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement) field.value = value
    }
  }, [state])
  return (
    <form ref={form} action={formAction} className={className}>
      {children}
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className={quiet ? "btn-quiet" : "btn"} disabled={pending}>
          {pending ? "Working…" : submit}
        </button>
        {state?.ok ? <p className="text-sm text-teal-700" role="status">{state.ok}</p> : null}
        {state?.error ? <p className="text-sm text-red-700" role="alert">{state.error}</p> : null}
      </div>
    </form>
  )
}
