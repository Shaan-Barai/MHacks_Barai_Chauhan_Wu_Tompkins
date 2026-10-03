/** UI.md severity bands, by an item's share of its meal's total waste. */
export type Severity = 'low' | 'medium' | 'high'

export function severityFor(sharePercent: number): Severity {
  if (sharePercent > 25) return 'high'
  if (sharePercent >= 10) return 'medium'
  return 'low'
}

export const SEVERITY_LABEL: Record<Severity, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
}

export const SEVERITY_DOT: Record<Severity, string> = {
  low: 'bg-low',
  medium: 'bg-medium',
  high: 'bg-high',
}
