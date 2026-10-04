/**
 * DEMO seed generator (Agent 2). Run with `npm run seed` from data/.
 *
 * Writes data/seed/demo-seed.json: 3 days x 3 meals of fictional but
 * plausible dining-hall menus for hall "hall-main" (America/Detroit), plus a
 * manual_area reference portion for every item in the shared 1024x1024
 * "topdown-normalized-v1" space (round plate, 900px diameter — matching
 * contracts/samples.json).
 *
 * Breakfast and lunch menus are invented. Every dinner (BIG-PLAN D6) is the
 * test dining hall's 26-food dinner menu from menu_waste_factors.csv: display
 * name = CSV `food`, category = station, description = Gemini's visible
 * components. Each dinner also gets DEMO portions-served counts (seeded,
 * plausible 40-260 per item, source 'demo').
 *
 * Everything here is DEMO DATA: expected areas were assigned by hand per
 * category to look plausible next to the sample record (scrambled eggs =
 * 48,000 px), and portion counts are dummy values. Neither is measured.
 *
 * Output is fully deterministic (seeded hash, fixed timestamps), so
 * regenerating produces a byte-identical file.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMenuUpload } from '../menuBundle.js';
import { createReferencePortion, validateReferencePortion } from '../referencePortions.js';
import { buildVocabulary } from '../vocabulary.js';
import { parsePortionsServed } from '../portionsServed.js';
import { WASTE_FACTOR_MENU_TEXT } from '../factors.js';
import { slugifyName } from '../ids.js';
import type { ImageGeometry, MenuBundle, MenuUpload, PortionsServed, ReferencePortion } from '../types.js';

export const DEMO_GEOMETRY: ImageGeometry = {
  widthPx: 1024,
  heightPx: 1024,
  coordinateSpace: 'topdown-normalized-v1',
  plateShape: 'round',
  plateDiameterPx: 900,
};

/**
 * Hand-assigned expected uneaten areas (pixels in DEMO_GEOMETRY) per
 * category, scaled to read plausibly against the contracts sample
 * (entree "Scrambled Eggs" = 48,000 px).
 */
const CATEGORY_AREA_PX: Record<string, number> = {
  entree: 52000,
  side: 26000,
  soup: 44000,
  salad: 38000,
  dessert: 16000,
  fruit: 20000,
  beverage: 15000,
  bread: 14000,
};

type DemoItem = {
  name: string;
  category: string;
  description?: string;
  /** CATEGORY_AREA_PX key for the reference area; defaults to `category`. */
  areaClass?: keyof typeof CATEGORY_AREA_PX;
};

const DEMO_DAYS: Array<{ date: string; breakfast: DemoItem[]; lunch: DemoItem[] }> = [
  {
    date: '2026-10-01',
    breakfast: [
      { name: 'Scrambled Eggs', category: 'entree', description: 'Plain scrambled eggs, standard scoop serving' },
      { name: 'Buttermilk Pancakes', category: 'entree', description: 'Two pancakes with syrup on the side' },
      { name: 'Hash Browns', category: 'side', description: 'Shredded potato hash browns' },
      { name: 'Turkey Sausage', category: 'side', description: 'Two turkey sausage links' },
      { name: 'Fresh Fruit Cup', category: 'fruit', description: 'Seasonal melon and berries' },
    ],
    lunch: [
      { name: 'Grilled Chicken Sandwich', category: 'entree', description: 'Grilled chicken breast on a brioche bun' },
      { name: 'Tomato Basil Soup', category: 'soup', description: 'Creamy tomato soup, bowl serving' },
      { name: 'French Fries', category: 'side', description: 'Crinkle-cut fries, standard basket' },
      { name: 'Garden Salad', category: 'salad', description: 'Mixed greens, cucumber, tomato' },
      { name: 'Fudge Brownie', category: 'dessert', description: 'Single square brownie' },
    ],
  },
  {
    date: '2026-10-02',
    breakfast: [
      { name: 'Veggie Omelet', category: 'entree', description: 'Three-egg omelet with peppers and onion' },
      { name: 'French Toast Sticks', category: 'entree', description: 'Five sticks with syrup on the side' },
      { name: 'Breakfast Potatoes', category: 'side', description: 'Roasted seasoned potato cubes' },
      { name: 'Bacon', category: 'side', description: 'Three strips of bacon' },
      { name: 'Greek Yogurt Parfait', category: 'fruit', description: 'Yogurt with granola and berries' },
    ],
    lunch: [
      { name: 'Beef Tacos', category: 'entree', description: 'Two seasoned ground beef tacos' },
      { name: 'Spanish Rice', category: 'side', description: 'Tomato rice, standard scoop' },
      { name: 'Black Beans', category: 'side', description: 'Seasoned black beans, standard ladle' },
      { name: 'Street Corn Salad', category: 'salad', description: 'Roasted corn, cotija, lime' },
      { name: 'Cinnamon Churro', category: 'dessert', description: 'One cinnamon sugar churro' },
    ],
  },
  {
    date: '2026-10-03',
    breakfast: [
      { name: 'Belgian Waffles', category: 'entree', description: 'One waffle with syrup on the side' },
      { name: 'Cheese Omelet', category: 'entree', description: 'Three-egg omelet with cheddar' },
      { name: 'Home Fries', category: 'side', description: 'Pan-fried potato wedges' },
      { name: 'Chicken Sausage Links', category: 'side', description: 'Two chicken sausage links' },
      { name: 'Oatmeal with Berries', category: 'fruit', description: 'Steel-cut oats with mixed berries' },
    ],
    lunch: [
      { name: 'Margherita Flatbread', category: 'entree', description: 'Personal flatbread, tomato and mozzarella' },
      { name: 'Chicken Caesar Wrap', category: 'entree', description: 'Grilled chicken caesar wrap, halved' },
      { name: 'Sweet Potato Fries', category: 'side', description: 'Sweet potato fries, standard basket' },
      { name: 'Minestrone Soup', category: 'soup', description: 'Vegetable minestrone, bowl serving' },
      { name: 'Chocolate Chip Cookie', category: 'dessert', description: 'One bakery cookie' },
    ],
  },
];

export interface DemoSeed {
  label: string;
  demo: true;
  provenance: string;
  hallId: string;
  hallTimezone: string;
  coordinateSpace: typeof DEMO_GEOMETRY.coordinateSpace;
  menus: MenuBundle[];
  referencePortions: ReferencePortion[];
  /** DEMO portions served per dinner item (source 'demo'); replacement snapshots per service. */
  portionsServed: PortionsServed[];
  portionsLabel: string;
}

/**
 * Baked Sweet Potatoes is not on the dining hall's label sheet, so Gemini wrote
 * no visible-components text for it. This short description is the earlier
 * hand-written (Claude) one from the factor-table experiment.
 */
const FALLBACK_VISIBLE_COMPONENTS: Record<string, string> = {
  'baked-sweet-potatoes': 'orange baked sweet potato flesh and skins',
  'halal-rice': 'loose, fluffy yellow-orange long-grain rice tinted with turmeric, separate grains, sometimes with flecks of spice or onion',
  tomatoes: 'diced or sliced raw red tomato pieces with glossy red flesh, pale seeds and juice',
  lettuce: 'shredded or chopped raw lettuce, crisp pale-green to green leaf ribbons and torn pieces',
};

/** Portion role per factor food; drives the reference area and the demo count range. */
type PortionRole = 'entree' | 'side' | 'soup' | 'dessert';
const ENTREE_KEYS = new Set([
  'baked-boneless-ham',
  'ancho-flank-steak',
  'vegetable-cannelloni',
  'michigan-farmers-4-bean-stew',
  'pepperoni-pizza',
  'cheese-pizza',
  'chicken-broccoli-alfredo-pizza',
]);

export function portionRole(factorKey: string, station: string): PortionRole {
  if (station === 'MBakery') return 'dessert';
  if (station === 'Soup') return 'soup';
  return ENTREE_KEYS.has(factorKey) ? 'entree' : 'side';
}

/** Demo portions-served range per role (all inside the agreed 40-260). */
export const DEMO_PORTION_RANGES: Record<PortionRole, readonly [number, number]> = {
  entree: [120, 260],
  side: [70, 170],
  soup: [60, 140],
  dessert: [40, 110],
};

export const DEMO_PORTIONS_SEED = 'demo-portions-v1';

/** The 26-food dinner menu (CSV order). */
export function factorDinnerItems(): DemoItem[] {
  return WASTE_FACTOR_MENU_TEXT.map((row) => {
    const description = row.visibleComponents ?? FALLBACK_VISIBLE_COMPONENTS[row.factorKey];
    return {
      name: row.food,
      category: row.station,
      ...(description !== undefined ? { description } : {}),
      areaClass: portionRole(row.factorKey, row.station),
    };
  });
}

/** FNV-1a 32-bit hash -> deterministic seed. */
function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Deterministic integer in [min, max] for (seed, key). */
function seededInt(key: string, min: number, max: number): number {
  const u = hash32(`${DEMO_PORTIONS_SEED}|${key}`) / 0x1_0000_0000;
  return min + Math.floor(u * (max - min + 1));
}

/** DEMO portions served for one dinner bundle, validated through parsePortionsServed. */
export function buildDemoPortions(bundle: MenuBundle): PortionsServed[] {
  const s = bundle.service;
  const entries = bundle.items.map((item) => {
    const key = slugifyName(item.displayName);
    const [min, max] = DEMO_PORTION_RANGES[portionRole(key, item.category ?? '')];
    return { itemId: item.itemId, count: seededInt(`${s.serviceId}|${key}`, min, max) };
  });
  // Fixed end-of-dinner timestamp (7:30 PM America/Detroit in October) keeps the file byte-stable.
  const updatedAt = `${s.serviceDate}T23:30:00.000Z`;
  return parsePortionsServed({ serviceId: s.serviceId, menuVersion: s.menuVersion, entries }, bundle, 'demo', updatedAt);
}

/** Small deterministic jitter so items in a category do not all share one area. */
function areaFor(category: keyof typeof CATEGORY_AREA_PX, name: string): number {
  const base = CATEGORY_AREA_PX[category]!;
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)!) % 997;
  const jitter = (hash / 997 - 0.5) * 0.2; // within ±10% of the category base
  return Math.round(base * (1 + jitter));
}

export function buildDemoSeed(): DemoSeed {
  const dinner = factorDinnerItems();
  const upload: MenuUpload = {
    hallId: 'hall-main',
    hallTimezone: 'America/Detroit',
    days: DEMO_DAYS.map((day) => ({
      date: day.date,
      breakfast: day.breakfast,
      lunch: day.lunch,
      dinner,
    })),
  };
  const menus = parseMenuUpload(upload);

  const byName = new Map(
    [...DEMO_DAYS.flatMap((day) => [...day.breakfast, ...day.lunch]), ...dinner].map(
      (item) => [item.name, item] as const,
    ),
  );
  const referencePortions: ReferencePortion[] = [];
  for (const bundle of menus) {
    for (const item of bundle.items) {
      const demoItem = byName.get(item.displayName)!;
      referencePortions.push(
        createReferencePortion([], {
          itemId: item.itemId,
          expectedAreaPx: areaFor(demoItem.areaClass ?? demoItem.category, item.displayName),
          geometry: DEMO_GEOMETRY,
          source: 'manual_area',
        }),
      );
    }
  }

  const portionsServed = menus
    .filter((bundle) => bundle.service.mealLabel === 'dinner')
    .flatMap(buildDemoPortions);

  // Self-check: every record passes this package's own validators and every
  // bundle produces a vocabulary.
  menus.forEach(buildVocabulary);
  referencePortions.forEach(validateReferencePortion);

  return {
    label:
      'DEMO DATA — fictional breakfast/lunch menus, the test hall\'s 26-food dinner menu, hand-assigned manual_area reference portions, and dummy demo portions-served counts for the Scrap prototype. Not real hall data; not measured portions or real serving counts.',
    demo: true,
    provenance:
      'Generated deterministically by data/src/seed/generate.ts (scrap-data). Regenerate with `npm run seed` in data/. Dinner items come from menu_waste_factors.csv (descriptions = gemini_visible_components; Baked Sweet Potatoes, Halal Rice, Tomatoes and Lettuce use hand-written fallbacks). portionsServed are DEMO counts from a seeded hash (seed "demo-portions-v1", 40-260 per item by role), source "demo".',
    hallId: upload.hallId,
    hallTimezone: upload.hallTimezone,
    coordinateSpace: DEMO_GEOMETRY.coordinateSpace,
    menus,
    referencePortions,
    portionsServed,
    portionsLabel: 'DEMO portions served: dummy counts for the prototype, not real serving data.',
  };
}

// When executed directly (npm run seed), write the JSON file.
const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const seed = buildDemoSeed();
  // dist/data/src/seed -> data/seed/demo-seed.json
  const here = dirname(fileURLToPath(import.meta.url));
  const outPath = join(here, '..', '..', '..', '..', '..', 'data', 'seed', 'demo-seed.json');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(seed, null, 2)}\n`, 'utf8');
  console.log(
    `Wrote ${outPath}: ${seed.menus.length} menus, ${seed.referencePortions.length} reference portions, ${seed.portionsServed.length} demo portions.`,
  );
}
