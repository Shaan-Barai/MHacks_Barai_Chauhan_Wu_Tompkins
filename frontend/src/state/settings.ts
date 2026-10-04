/** Hall settings, persisted to localStorage (setup is shown once per browser). */
import { useCallback, useState } from 'react'
import type { HallSettings, IsoDate, MealHours, MealLabel, MealTimeSet, Weekday } from '../data/types'
import { WEEKDAYS } from '../data/types'
import { fromIso } from '../lib/dates'

const SETTINGS_KEY = 'scrap.hallSettings.v1'

const WEEKDAY_MEALS: Record<MealLabel, MealHours> = {
  breakfast: { start: '07:00', end: '10:30' },
  lunch: { start: '11:00', end: '14:30' },
  dinner: { start: '17:00', end: '20:30' },
}

export const DEFAULT_SETTINGS: HallSettings = {
  hallId: 'hall-main',
  name: '',
  timeSets: [
    { id: 'weekdays', name: 'Weekdays', days: ['mon', 'tue', 'wed', 'thu', 'fri'], meals: WEEKDAY_MEALS },
    {
      id: 'weekends',
      name: 'Weekends',
      days: ['sat', 'sun'],
      meals: {
        breakfast: { start: '08:00', end: '10:30' },
        lunch: { start: '11:30', end: '14:00' },
        dinner: { start: '17:00', end: '19:30' },
      },
    },
  ],
  events: [],
}

/** Settings saved before time sets existed had one `mealTimes` for every day. */
function migrate(raw: Partial<HallSettings> & { mealTimes?: Record<MealLabel, MealHours> }): HallSettings {
  const timeSets =
    raw.timeSets ??
    (raw.mealTimes
      ? [{ id: 'every-day', name: 'Every day', days: [...WEEKDAYS], meals: raw.mealTimes }]
      : DEFAULT_SETTINGS.timeSets)
  return { hallId: raw.hallId ?? 'hall-main', name: raw.name ?? '', timeSets, events: raw.events ?? [] }
}

export function loadSettings(): HallSettings | null {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    return raw ? migrate(JSON.parse(raw)) : null
  } catch {
    return null
  }
}

export function saveSettings(settings: HallSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
}

export function weekdayOf(date: IsoDate): Weekday {
  return WEEKDAYS[(fromIso(date).getDay() + 6) % 7]
}

/** The meal-time set that covers a date (first match wins), if any. */
export function timeSetFor(settings: HallSettings, date: IsoDate): MealTimeSet | undefined {
  const day = weekdayOf(date)
  return settings.timeSets.find((t) => t.days.includes(day))
}

export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

/** null until setup finishes; setup saves and flips the app to the dashboard. */
export function useHallSettings() {
  const [settings, setSettings] = useState<HallSettings | null>(loadSettings)
  const update = useCallback((next: HallSettings) => {
    saveSettings(next)
    setSettings(next)
  }, [])
  return { settings, update }
}
