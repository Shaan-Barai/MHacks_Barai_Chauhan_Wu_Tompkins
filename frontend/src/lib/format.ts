/** Number formatting for pixel counts and other counts. */

const full = new Intl.NumberFormat()

export function formatNumber(n: number): string {
  return full.format(Math.round(n))
}

/** Compact for big card numbers: 1,284 / 12.9k / 1.2M. */
export function formatCompact(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return trim(n / 1_000_000) + 'M'
  if (abs >= 10_000) return trim(n / 1_000) + 'k'
  return full.format(Math.round(n))
}

function trim(n: number): string {
  const s = n.toFixed(1)
  return s.endsWith('.0') ? s.slice(0, -2) : s
}

export function formatPercent(n: number): string {
  return `${Math.round(n)}%`
}

/** Signed delta vs the previous period, e.g. "+12%" / "−8%". */
export function formatDeltaPercent(current: number, previous: number): string | null {
  if (previous <= 0) return null
  const pct = ((current - previous) / previous) * 100
  const rounded = Math.round(pct)
  if (rounded === 0) return '0%'
  return rounded > 0 ? `+${rounded}%` : `−${Math.abs(rounded)}%`
}
