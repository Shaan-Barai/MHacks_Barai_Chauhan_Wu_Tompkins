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

// ---------------------------------------------------------------------------
// Relative impact points (BIG-PLAN v2). Unitless: they only compare foods
// with each other. Callers label them "relative points" next to the number.
// ---------------------------------------------------------------------------

/**
 * 23,412 / 95.7 / 4.3 / 0.052: whole numbers from 100 up, one decimal from 1,
 * two significant digits below 1 so small per-portion values still rank.
 */
export function formatPoints(points: number): string {
  const abs = Math.abs(points)
  if (abs >= 100) return formatNumber(points)
  if (abs >= 1) return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(points)
  if (abs === 0) return '0'
  return String(Number(points.toPrecision(2)))
}

// ---------------------------------------------------------------------------
// IT_4 estimated physical amounts (labeled "est." wherever they appear).
// ---------------------------------------------------------------------------

/** 1,234 / 38 / 4.2 / 0.042: whole numbers from 10 up, one decimal from 1, two significant digits below 1. */
export function formatAmount(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 10) return formatNumber(n)
  if (abs >= 1) return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(n)
  if (abs === 0) return '0'
  return String(Number(n.toPrecision(2)))
}

/** Totals and per-portion amounts: 38 g, 0.27 g, or 1.2 kg from 1,000 g up. */
export function formatMass(grams: number): string {
  return Math.abs(grams) >= 1000 ? `${formatAmount(grams / 1000)} kg` : `${formatAmount(grams)} g`
}

// Food labels match the overlay legend written by analytics (formatPhysicalLabel):
// whole grams, CO2e and water to 2 significant digits, CO2e in g below 0.1 kg.

function sig2(n: number): string {
  if (n === 0) return '0'
  return Number(n.toPrecision(2)).toLocaleString('en-US', { maximumFractionDigits: 20 })
}

/** Whole grams: "38 g", "1,234 g". */
export function formatGrams(grams: number): string {
  return `${Math.round(grams).toLocaleString('en-US')} g`
}

/** "1.1 kg CO2e", "310 kg CO2e", "34 g CO2e" (below 0.1 kg). */
export function formatKgCo2e(kg: number): string {
  return kg >= 0.1 ? `${sig2(kg)} kg CO2e` : `${sig2(kg * 1000)} g CO2e`
}

/** "18 L", "0.52 L", "1,200 L". */
export function formatLitres(litres: number): string {
  return `${sig2(litres)} L`
}
