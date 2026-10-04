/**
 * Portions forecasted: how many portions of each food the staff plan to serve
 * at a meal, entered ahead of time (UMich dining staff forecast before each
 * meal). Saved in this browser until the backend stores forecasts.
 */
import type { IsoDate, MealLabel } from '../data/types'

const FORECASTS_KEY = 'scrap.portionForecasts.v1'

type Store = Record<string, Record<string, number>>

const key = (hallId: string, date: IsoDate, meal: MealLabel) => `${hallId}|${date}|${meal}`

function read(): Store {
  try {
    return JSON.parse(localStorage.getItem(FORECASTS_KEY) ?? '{}') as Store
  } catch {
    return {}
  }
}

/** itemId → forecast portions for one meal (empty when none saved). */
export function loadForecast(hallId: string, date: IsoDate, meal: MealLabel): Record<string, number> {
  return read()[key(hallId, date, meal)] ?? {}
}

/** Replace one meal's forecast; blank entries are dropped. */
export function saveForecast(hallId: string, date: IsoDate, meal: MealLabel, counts: Record<string, number>): void {
  const all = read()
  if (Object.keys(counts).length === 0) delete all[key(hallId, date, meal)]
  else all[key(hallId, date, meal)] = counts
  try {
    localStorage.setItem(FORECASTS_KEY, JSON.stringify(all))
  } catch {
    // Storage full or blocked: the form keeps the numbers on screen.
  }
}
