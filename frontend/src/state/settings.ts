/** First-time-setup state, persisted to localStorage (shown once per browser). */
import { useCallback, useState } from 'react'
import type { HallSettings } from '../data/types'

const SETTINGS_KEY = 'scrap.hallSettings.v1'

export const DEFAULT_SETTINGS: HallSettings = {
  hallId: 'hall-main',
  name: '',
  mealTimes: {
    breakfast: { start: '07:00', end: '10:30' },
    lunch: { start: '11:00', end: '14:30' },
    dinner: { start: '17:00', end: '20:30' },
  },
}

export function loadSettings(): HallSettings | null {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    return raw ? (JSON.parse(raw) as HallSettings) : null
  } catch {
    return null
  }
}

export function saveSettings(settings: HallSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
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
