import type { IsoDate } from '../data/types'

/** Local-calendar date helpers. All dates are YYYY-MM-DD strings. */

export function toIso(d: Date): IsoDate {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function fromIso(iso: IsoDate): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function todayIso(): IsoDate {
  return toIso(new Date())
}

export function addDays(iso: IsoDate, n: number): IsoDate {
  const d = fromIso(iso)
  d.setDate(d.getDate() + n)
  return toIso(d)
}

export function daysBetween(a: IsoDate, b: IsoDate): number {
  return Math.round((fromIso(b).getTime() - fromIso(a).getTime()) / 86_400_000)
}

/** Inclusive list of dates from start to end. */
export function eachDay(start: IsoDate, end: IsoDate): IsoDate[] {
  const out: IsoDate[] = []
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d)
  return out
}

/** Monday of the week containing iso. */
export function startOfWeek(iso: IsoDate): IsoDate {
  const dow = (fromIso(iso).getDay() + 6) % 7
  return addDays(iso, -dow)
}

export function startOfMonth(iso: IsoDate): IsoDate {
  return iso.slice(0, 8) + '01'
}

export function shiftMonths(iso: IsoDate, n: number): IsoDate {
  const d = fromIso(iso)
  const day = d.getDate()
  d.setDate(1)
  d.setMonth(d.getMonth() + n)
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
  d.setDate(Math.min(day, lastDay))
  return toIso(d)
}

export function formatLong(iso: IsoDate): string {
  return fromIso(iso).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
}

export function formatShort(iso: IsoDate): string {
  return fromIso(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function formatMonth(iso: IsoDate): string {
  return fromIso(iso).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}
