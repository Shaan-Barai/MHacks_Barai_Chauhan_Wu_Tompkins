/** Hall settings, persisted to localStorage (setup is shown once per browser). */
import { useCallback, useState } from 'react'
import type { HallRef, HallSettings, IsoDate, MealHours, MealLabel, MealTimeSet, Weekday } from '../data/types'
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
  halls: [],
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

/** The first hall keeps the original ID so data saved before multiple halls stays attached. */
const PRIMARY_HALL_ID = 'hall-main'

function slug(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Stable IDs for hall names: halls that already have an ID keep it, the first
 * new hall is `hall-main` if free, the rest `hall-<name>` (made unique).
 */
export function assignHallIds(halls: { hallId?: string; name: string }[]): HallRef[] {
  const taken = new Set(halls.map((h) => h.hallId).filter((id): id is string => Boolean(id)))
  return halls.map((h) => {
    if (h.hallId) return { hallId: h.hallId, name: h.name.trim() }
    let id = taken.has(PRIMARY_HALL_ID) ? `hall-${slug(h.name) || 'location'}` : PRIMARY_HALL_ID
    for (let n = 2; taken.has(id); n++) id = `hall-${slug(h.name) || 'location'}-${n}`
    taken.add(id)
    return { hallId: id, name: h.name.trim() }
  })
}

/** Keep `hallId`/`name` equal to the first hall. */
export function withHalls(settings: HallSettings, halls: HallRef[]): HallSettings {
  const first = halls[0] ?? { hallId: PRIMARY_HALL_ID, name: '' }
  return { ...settings, halls, hallId: first.hallId, name: first.name }
}

/**
 * Settings saved before time sets existed had one `mealTimes` for every day;
 * settings saved before multiple halls had a single hallId/name.
 */
function migrate(raw: Partial<HallSettings> & { mealTimes?: Record<MealLabel, MealHours> }): HallSettings {
  const timeSets =
    raw.timeSets ??
    (raw.mealTimes
      ? [{ id: 'every-day', name: 'Every day', days: [...WEEKDAYS], meals: raw.mealTimes }]
      : DEFAULT_SETTINGS.timeSets)
  const halls = raw.halls?.length ? raw.halls : [{ hallId: raw.hallId ?? PRIMARY_HALL_ID, name: raw.name ?? '' }]
  return withHalls({ ...DEFAULT_SETTINGS, timeSets, events: raw.events ?? [] }, halls)
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
