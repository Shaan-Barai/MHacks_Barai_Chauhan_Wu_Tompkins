/** Dates a repeating menu is saved on (Menu Schedule "Repeat:"). */
import type { IsoDate, MenuRepeat } from '../data/types'
import { addDays } from './dates'

const STEP_DAYS: Record<Exclude<MenuRepeat, 'never'>, number> = { daily: 1, weekly: 7, biweekly: 14 }

/** How far ahead a repeat may reach, so one save stays a reasonable upload. */
export const MAX_REPEAT_DAYS = 26 * 7

/** Default end of a repeat: eight weeks after the first date. */
export function defaultRepeatUntil(start: IsoDate): IsoDate {
  return addDays(start, 8 * 7 - 1)
}

/** The first date, then every step up to and including `until` (capped at MAX_REPEAT_DAYS). */
export function repeatDates(start: IsoDate, repeat: MenuRepeat, until: IsoDate): IsoDate[] {
  if (repeat === 'never' || until < start) return [start]
  const last = until < addDays(start, MAX_REPEAT_DAYS - 1) ? until : addDays(start, MAX_REPEAT_DAYS - 1)
  const dates: IsoDate[] = []
  for (let d = start; d <= last; d = addDays(d, STEP_DAYS[repeat])) dates.push(d)
  return dates
}
