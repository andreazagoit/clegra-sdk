/**
 * LABELS (spec §3): a string in the app's locale, or a map per locale.
 * The card carries the maps; `localize` picks one for a caller.
 */
export type Label = string | Readonly<Record<string, string>>

/** The label in `locale` (exact, then its language), else the app's `fallback` locale, else the first entry. */
export function localize(label: Label | undefined, locale: string | undefined, fallback: string): string {
  if (label === undefined) return ""
  if (typeof label === "string") return label
  const tries = [locale, locale?.split("-")[0], fallback, fallback.split("-")[0]].filter((l): l is string => Boolean(l))
  for (const l of tries) if (typeof label[l] === "string") return label[l]
  return Object.values(label)[0] ?? ""
}

/** A label as the card carries it: always a map, so a host never guesses the language of a bare string. */
export function labelMap(label: Label | undefined, fallback: string): Record<string, string> | undefined {
  if (label === undefined) return undefined
  return typeof label === "string" ? { [fallback]: label } : { ...label }
}

export function isLabel(value: unknown): value is Label {
  return typeof value === "string" || (typeof value === "object" && value !== null && !Array.isArray(value) && Object.values(value).every((v) => typeof v === "string"))
}
