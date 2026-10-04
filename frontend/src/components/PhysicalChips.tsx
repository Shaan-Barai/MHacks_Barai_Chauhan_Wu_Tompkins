/**
 * IT_4 I8: estimated grams, kg CO2e and litres of water next to a food's
 * name: "38 g · 1.1 kg CO2e · 18 L water", marked "est.". Pixels stay the
 * measurement. Missing values are never shown as 0: a food without an
 * estimate shows nothing, or a short muted reason ("not calibrated").
 */
import type { PhysicalAmounts, PhysicalUnavailableReason } from '../data/types'
import { formatGrams, formatKgCo2e, formatLitres } from '../lib/format'

export const ESTIMATE_EXPLANATION =
  'Estimated, not weighed. The area comes from the camera calibration (a reference object of known area gives the size of each pixel), and grams from the food’s typical weight per cm². CO2e and water come from each food’s footprint per kilogram. Pixels are the measurement.'

/** Plain words for why a food has no estimate. Null = say nothing. */
export function physicalReasonText(reason: PhysicalUnavailableReason | undefined): string | null {
  switch (reason) {
    case undefined:
    case 'no_calibration':
      return 'not calibrated'
    case 'incompatible_geometry':
      return 'photo size differs from the calibration'
    case 'no_factor':
      return 'no estimate for this food'
    case 'unknown_item':
      return null
    default:
      // A reason from an older backend: say nothing rather than guess.
      return null
  }
}

export function CloudIcon() {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 16 16" width="14" height="14" className="inline-block shrink-0">
      <path
        d="M4.5 13h7.25a3.25 3.25 0 0 0 .4-6.48A4.25 4.25 0 0 0 4.1 7.6 2.75 2.75 0 0 0 4.5 13Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function DropletIcon() {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 16 16" width="14" height="14" className="inline-block shrink-0">
      <path
        d="M8 1.8C6.2 4.6 3.8 7.3 3.8 9.9a4.2 4.2 0 0 0 8.4 0C12.2 7.3 9.8 4.6 8 1.8Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function hasValue(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n)
}

/** True when at least one estimated amount is present. */
export function hasPhysical(p: PhysicalAmounts): boolean {
  return hasValue(p.grams) || hasValue(p.kgCo2e) || hasValue(p.waterLitres)
}

const chip = 'inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-ink px-2 py-0.5'

export function PhysicalChips({
  amounts,
  showReason = true,
  className = '',
}: {
  amounts: PhysicalAmounts
  /** When nothing is available, show the muted reason (otherwise render nothing). */
  showReason?: boolean
  className?: string
}) {
  if (!hasPhysical(amounts)) {
    const reason = showReason ? physicalReasonText(amounts.physicalUnavailableReason) : null
    return reason ? <span className={`text-sm italic ${className}`}>{reason}</span> : null
  }
  const parts: string[] = []
  if (hasValue(amounts.grams)) parts.push(formatGrams(amounts.grams))
  if (hasValue(amounts.kgCo2e)) parts.push(formatKgCo2e(amounts.kgCo2e))
  if (hasValue(amounts.waterLitres)) parts.push(`${formatLitres(amounts.waterLitres)} water`)
  return (
    <span className={`inline-flex flex-wrap items-center gap-1.5 text-sm ${className}`}>
      <span className="sr-only">Estimated: {parts.join(', ')}.</span>
      {hasValue(amounts.grams) && (
        <span aria-hidden="true" className={chip}>
          {formatGrams(amounts.grams)}
        </span>
      )}
      {hasValue(amounts.kgCo2e) && (
        <span aria-hidden="true" className={chip}>
          <CloudIcon />
          {formatKgCo2e(amounts.kgCo2e)}
        </span>
      )}
      {hasValue(amounts.waterLitres) && (
        <span aria-hidden="true" className={chip}>
          <DropletIcon />
          {formatLitres(amounts.waterLitres)} water
        </span>
      )}
      <span aria-hidden="true" className="italic">
        est.
      </span>
    </span>
  )
}
