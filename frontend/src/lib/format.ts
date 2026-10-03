const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })
const full = new Intl.NumberFormat('en-US')

/** Waste units are pixel areas; large, so show them compactly (e.g. 4.3M). */
export function formatUnits(n: number): string {
  return compact.format(n)
}

export function formatNumber(n: number): string {
  return full.format(Math.round(n))
}

export function formatPercent(n: number): string {
  return `${Math.round(n)}%`
}

/** Percent change vs previous; null when there is nothing to compare with. */
export function percentChange(current: number, previous: number | null): number | null {
  if (previous === null || previous <= 0) return null
  return ((current - previous) / previous) * 100
}

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
