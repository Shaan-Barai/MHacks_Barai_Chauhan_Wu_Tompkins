/** Client-side CSV export, generated from the data-access layer. */
import { getMealDetail } from '../data/api'
import { addDays, eachDay, todayIso } from '../lib/dates'
import type { IsoDate } from '../data/types'
import { MEALS } from '../data/types'

function escapeCell(value: string | number): string {
  const s = String(value)
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

/**
 * One row per item per meal per day. Pixels wasted are counted inside AI-drawn
 * leftover-food outlines; meal swipes are simulated, both labeled in the header.
 */
export async function buildWasteCsv(days = 30): Promise<string> {
  const today = todayIso()
  const dates: IsoDate[] = eachDay(addDays(today, -(days - 1)), today)
  const rows: string[] = [
    [
      'date',
      'meal',
      'item',
      'pixels_wasted_ai_mask_count',
      'share_of_meal_wasted_pixels_percent',
      'plates_scanned',
      'meal_swipes_simulated',
    ].join(','),
  ]
  for (const date of dates) {
    for (const meal of MEALS) {
      const detail = await getMealDetail(date, meal)
      if (!detail) continue
      for (const item of detail.items) {
        rows.push(
          [
            date,
            meal,
            escapeCell(item.displayName),
            item.pixelsWasted,
            item.shareOfMealPixelsPercent.toFixed(1),
            detail.platesScanned,
            detail.mealSwipes.count,
          ].join(','),
        )
      }
    }
  }
  return rows.join('\n') + '\n'
}

export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
