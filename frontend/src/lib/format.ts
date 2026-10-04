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
// Estimated weight and impact (BIG-PLAN D2/D3). Every one of these is an
// estimate; callers label it as such next to the number.
// ---------------------------------------------------------------------------

function fixed(n: number, digits: number): string {
  return new Intl.NumberFormat(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n)
}

/** 850 g / 12.4 kg / 1,240 kg. */
export function formatGrams(grams: number): string {
  if (Math.abs(grams) < 1000) return `${fixed(grams, grams !== 0 && Math.abs(grams) < 10 ? 1 : 0)} g`
  const kg = grams / 1000
  return `${fixed(kg, Math.abs(kg) < 100 ? 1 : 0)} kg`
}

/** Greenhouse gases in kg CO2e: 0.42 / 8.6 / 1,620. */
export function formatKgCo2e(kg: number): string {
  const abs = Math.abs(kg)
  const digits = abs === 0 ? 0 : abs < 1 ? 2 : abs < 100 ? 1 : 0
  return `${fixed(kg, digits)} kg CO₂e`
}

/** Freshwater: litres under one cubic meter, cubic meters above. */
export function formatWater(m3: number): string {
  if (Math.abs(m3) < 1) return `${formatNumber(m3 * 1000)} L`
  return `${fixed(m3, Math.abs(m3) < 100 ? 1 : 0)} m³`
}

/** Always litres, e.g. "24,500 litres" (secondary line under m3). */
export function formatLitres(m3: number): string {
  return `${formatNumber(m3 * 1000)} litres`
}

/** $342 / $12.40 / $0.06; under a cent keeps 2 significant digits ($0.0012) so small per-portion values still rank. */
export function formatUsd(usd: number): string {
  if (Math.abs(usd) >= 100) return `$${formatNumber(usd)}`
  if (usd !== 0 && Math.abs(usd) < 0.01) return `$${Number(usd.toPrecision(2))}`
  return `$${fixed(usd, 2)}`
}
