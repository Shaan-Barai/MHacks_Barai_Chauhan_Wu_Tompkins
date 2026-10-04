/** Hand-built fixtures for the waste-impact component tests (not used by the app). */
import type { ImpactDashboard, ItemImpactRow, WasteImpact } from '../data/types'

export function impact(over: Partial<WasteImpact> = {}): WasteImpact {
  return {
    pixels: 10_000,
    cm2: 20,
    grams: 20,
    kgCo2e: 0.32,
    waterM3: 0.039,
    impactUsd: 0.19 * 0.32 + 1.5 * 0.039,
    nutrientDaysLost: 0.014,
    wasteFactorsVersion: 'waste-factors-v2',
    ...over,
  }
}

export function row(over: Partial<ItemImpactRow> & { displayName: string }): ItemImpactRow {
  return {
    itemId: `item_${over.displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    factorKey: over.displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    impact: impact(),
    portionsServed: 100,
    portionsSource: 'demo',
    perPortion: { grams: 0.2, pixels: 100, impactUsd: 0.001 },
    ...over,
  }
}

export const steak = row({
  displayName: 'Ancho Flank Steak',
  impact: impact({ pixels: 400_000, grams: 4_200, kgCo2e: 553.1, waterM3: 8.09, impactUsd: 117.22, nutrientDaysLost: 4.41 }),
  portionsServed: 140,
  perPortion: { grams: 30, pixels: 2857, impactUsd: 0.84 },
})

export const pizza = row({
  displayName: 'Pepperoni Pizza',
  impact: impact({ pixels: 900_000, grams: 12_400, kgCo2e: 199.1, waterM3: 24.06, impactUsd: 73.92, nutrientDaysLost: 8.56 }),
  portionsServed: 620,
  perPortion: { grams: 20, pixels: 1452, impactUsd: 0.12 },
})

export const farro = row({
  displayName: 'Farro',
  impact: impact({ pixels: 50_000, grams: 600, kgCo2e: 0.45, waterM3: 0.19, impactUsd: 0.37, nutrientDaysLost: 0.37 }),
  portionsServed: null,
  portionsSource: null,
  perPortion: null,
})

export const soup = row({
  displayName: "Chef's Soup of the Day",
  factorKey: null,
  impact: impact({ pixels: 70_000, grams: null, kgCo2e: null, waterM3: null, impactUsd: null, nutrientDaysLost: null, unavailableReason: 'no_factor' }),
  portionsServed: 50,
  perPortion: { grams: null, pixels: 1400, impactUsd: null },
})

export const unknownFood = row({
  displayName: 'Food not on the menu',
  itemId: null,
  factorKey: null,
  impact: impact({ pixels: 30_000, grams: null, kgCo2e: null, waterM3: null, impactUsd: null, nutrientDaysLost: null, unavailableReason: 'unknown_item' }),
  portionsServed: null,
  portionsSource: null,
  perPortion: null,
})

export function dashboard(over: Partial<ImpactDashboard> = {}): ImpactDashboard {
  return {
    window: { start: '2026-09-04', end: '2026-10-03', hallId: 'hall-main' },
    totals: {
      ...impact({ pixels: 1_450_000, grams: 17_200, kgCo2e: 1_620.4, waterM3: 32.5, impactUsd: 356.63, nutrientDaysLost: 13.34 }),
      captures: 130,
      analyzedCaptures: 124,
      excludedCaptures: 6,
    },
    targets: [steak, pizza, soup, farro, unknownFood],
    mostWasted: [pizza, steak, farro, soup, unknownFood],
    coverage: { itemsWithFactor: 3, itemsWithoutFactor: 1, itemsWithPortions: 3, capturesWithDefaultCalibration: 2 },
    labels: { estimate: true, demoPortions: true },
    ...over,
  }
}
