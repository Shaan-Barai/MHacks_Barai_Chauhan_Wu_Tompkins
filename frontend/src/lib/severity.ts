/**
 * UI.md severity bands, based on an item's share of its meal's total waste:
 *   Low (<10%) Sage · Medium (10–25%) Squash · High (>25%) Tomato
 */
export type Severity = 'low' | 'medium' | 'high'

export function severityFor(shareOfMealWastePercent: number): Severity {
  if (shareOfMealWastePercent > 25) return 'high'
  if (shareOfMealWastePercent >= 10) return 'medium'
  return 'low'
}

export const SEVERITY_LABEL: Record<Severity, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
}

/** Tailwind classes for the severity dot (Kitchen Garden tokens). */
export const SEVERITY_DOT_CLASS: Record<Severity, string> = {
  low: 'bg-sage',
  medium: 'bg-squash',
  high: 'bg-tomato',
}
