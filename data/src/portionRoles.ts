/**
 * Portion roles for the factor foods (pure, no I/O). A role sets the DUMMY
 * portions-served range used for demo data: a portion is one slice for
 * pizza and one serving otherwise. Real swipe/POS counts replace these.
 */

/** Portion role per factor food; drives the reference area and the demo count range. */
export type PortionRole = 'pizza' | 'entree' | 'side' | 'soup' | 'dessert';
const PIZZA_KEYS = new Set(['pepperoni-pizza', 'cheese-pizza', 'chicken-broccoli-alfredo-pizza']);
const ENTREE_KEYS = new Set([
  'baked-boneless-ham',
  'ancho-flank-steak',
  'vegetable-cannelloni',
  'michigan-farmers-4-bean-stew',
]);

export function portionRole(factorKey: string, station: string): PortionRole {
  if (station === 'MBakery') return 'dessert';
  if (station === 'Soup') return 'soup';
  if (PIZZA_KEYS.has(factorKey)) return 'pizza';
  return ENTREE_KEYS.has(factorKey) ? 'entree' : 'side';
}

/**
 * DUMMY portions-served range per role (a portion = one slice for pizza, one
 * serving otherwise). Reasonable guesses for one dinner, not real data: they
 * are stored with source 'demo' so real swipe/POS counts can replace them.
 */
export const DEMO_PORTION_RANGES: Record<PortionRole, readonly [number, number]> = {
  pizza: [200, 400],
  entree: [80, 200],
  side: [60, 150],
  soup: [60, 150],
  dessert: [50, 150],
};

