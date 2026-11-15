const money = new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" })
const number = new Intl.NumberFormat("en-IE")
const date = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/Rome" })
const dateTime = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Rome" })

export const formatMoney = (v: number) => money.format(v)
export const formatNumber = (v: number) => number.format(v)
/** A calendar day (`YYYY-MM-DD`) or an ISO moment. */
export const formatDate = (v: string) => date.format(new Date(v.length === 10 ? `${v}T12:00:00Z` : v))
export const formatDateTime = (v: string) => dateTime.format(new Date(v))
