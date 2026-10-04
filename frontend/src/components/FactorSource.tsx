import type { ItemImpactRow } from '../data/types'

export const COMMON_FACTORS_EXPLANATION =
  "This food isn't in the dining hall's own factor table, so its CO2 and water factors come from a table of 500 common dining-hall foods (matched by name)."

/** Small note when a food's factors came from the 500-common-foods fallback table. */
export function FactorSource({ row }: { row: Pick<ItemImpactRow, 'factorTable'> }) {
  if (row.factorTable !== 'common-500') return null
  return (
    <span className="text-xs font-normal italic" title={COMMON_FACTORS_EXPLANATION}>
      factors: common foods table
    </span>
  )
}
