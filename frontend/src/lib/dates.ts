/** Local-date helpers. All dashboard dates are local YYYY-MM-DD strings. */

export type IsoDate = string // YYYY-MM-DD

export function toIso(d: Date): IsoDate {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function fromIso(date: IsoDate): Date {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function todayIso(): IsoDate {
  return toIso(new Date())
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const d = fromIso(date)
  d.setDate(d.getDate() + days)
  return toIso(d)
}

/** Inclusive list of dates from start to end. */
export function eachDay(start: IsoDate, end: IsoDate): IsoDate[] {
  const out: IsoDate[] = []
  let cur = start
  while (cur <= end) {
    out.push(cur)
    cur = addDays(cur, 1)
  }
  return out
}

export function diffDays(start: IsoDate, end: IsoDate): number {
  return Math.round((fromIso(end).getTime() - fromIso(start).getTime()) / 86_400_000)
}

/** Monday of the week containing `date`. */
export function startOfWeek(date: IsoDate): IsoDate {
  const d = fromIso(date)
  const dow = (d.getDay() + 6) % 7 // Mon=0
  return addDays(date, -dow)
}

export function startOfMonth(date: IsoDate): IsoDate {
  return date.slice(0, 8) + '01'
}

export function daysInMonth(year: number, month1: number): number {
  return new Date(year, month1, 0).getDate()
}

const LONG: Intl.DateTimeFormatOptions = { weekday: 'long', month: 'long', day: 'numeric' }

/** "Tuesday, March 3" style label. */
export function formatLong(date: IsoDate): string {
  return fromIso(date).toLocaleDateString(undefined, LONG)
}

/** "Mar 3" style label. */
export function formatShort(date: IsoDate): string {
  return fromIso(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** "Mar 3, 2026" style label. */
export function formatMedium(date: IsoDate): string {
  return fromIso(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

/** "March 2026" style label. */
export function formatMonth(date: IsoDate): string {
  return fromIso(date).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}
