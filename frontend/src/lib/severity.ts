/**
 * UI.md severity bands, based on an item's share of its meal's total waste:
 *   Low (<10%) white · Medium (10–25%) grey · High (>25%) black
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

/** Tailwind classes for the severity dot (monochrome tokens; outlined so white shows). */
export const SEVERITY_DOT_CLASS: Record<Severity, string> = {
  low: 'border border-ink bg-sage',
  medium: 'border border-ink bg-squash',
  high: 'border border-ink bg-tomato',
}
