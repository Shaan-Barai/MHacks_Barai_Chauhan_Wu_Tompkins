/**
 * Hand-built fixtures for the waste-impact component tests (not used by the
 * app). Points follow BIG-PLAN v2: pixels/1000 x weight_g_per_cm2 x factor,
 * impact = 0.19 x co2 + 1.50 x water, using menu_waste_factors.csv values.
 */
import type { ImpactDashboard, ItemImpactRow, WasteImpact } from '../data/types'

export function impact(over: Partial<WasteImpact> = {}): WasteImpact {
  return {
    pixels: 10_000,
    co2Points: 160.6,
    waterPoints: 19.4,
    impactPoints: 0.19 * 160.6 + 1.5 * 19.4,
    nutritionPoints: 6.9,
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
    perPortion: { pixels: 100, impactPoints: 0.6 },
    ...over,
  }
}

// weight 1.2, C 131.69, W 1.925, O 1.05
export const steak = row({
  displayName: 'Ancho Flank Steak',
  impact: impact({ pixels: 400_000, co2Points: 63_211.2, waterPoints: 924, impactPoints: 13_396.13, nutritionPoints: 504 }),
  portionsServed: 140,
  perPortion: { pixels: 2857.14, impactPoints: 95.69 },
})

// weight 1.0, C 16.06, W 1.94, O 0.69
export const pizza = row({
  displayName: 'Pepperoni Pizza',
  impact: impact({ pixels: 900_000, co2Points: 14_454, waterPoints: 1_746, impactPoints: 5_365.26, nutritionPoints: 621 }),
  portionsServed: 620,
  perPortion: { pixels: 1451.6, impactPoints: 8.654 },
})

// weight 1.1, C 0.75, W 0.311, O 0.61
export const farro = row({
  displayName: 'Farro',
  impact: impact({ pixels: 50_000, co2Points: 41.25, waterPoints: 17.105, impactPoints: 33.495, nutritionPoints: 33.55 }),
  portionsServed: null,
  portionsSource: null,
  perPortion: null,
})

export const soup = row({
  displayName: "Chef's Soup of the Day",
  factorKey: null,
  impact: impact({ pixels: 70_000, co2Points: null, waterPoints: null, impactPoints: null, nutritionPoints: null, unavailableReason: 'no_factor' }),
  portionsServed: 50,
  perPortion: { pixels: 1400, impactPoints: null },
})

export const unknownFood = row({
  displayName: 'Food not on the menu',
  itemId: null,
  factorKey: null,
  impact: impact({ pixels: 30_000, co2Points: null, waterPoints: null, impactPoints: null, nutritionPoints: null, unavailableReason: 'unknown_item' }),
  portionsServed: null,
  portionsSource: null,
  perPortion: null,
})

export function dashboard(over: Partial<ImpactDashboard> = {}): ImpactDashboard {
  return {
    window: { start: '2026-09-04', end: '2026-10-03', hallId: 'hall-main' },
    totals: {
      ...impact({ pixels: 1_450_000, co2Points: 77_706.45, waterPoints: 2_687.105, impactPoints: 18_794.885, nutritionPoints: 1_158.55 }),
      captures: 130,
      analyzedCaptures: 124,
      excludedCaptures: 6,
    },
    targets: [steak, pizza, soup, farro, unknownFood],
    mostWasted: [pizza, steak, soup, farro, unknownFood],
    coverage: { itemsWithFactor: 3, itemsWithoutFactor: 1, itemsWithPortions: 3, capturesWithNeighborFoodExcluded: 2 },
    labels: { relativeImpact: true, demoPortions: true },
    ...over,
  }
}
