/**
 * DEMO seed generator (Agent 2). Run with `npm run seed` from data/.
 *
 * Writes data/seed/demo-seed.json: 3 days x 3 meals of fictional but
 * plausible dining-hall menus for hall "hall-main" (America/Detroit), plus a
 * manual_area reference portion for every item in the shared 1024x1024
 * "topdown-normalized-v1" space (round plate, 900px diameter — matching
 * contracts/samples.json).
 *
 * Everything here is DEMO DATA: menus are invented and expected areas were
 * assigned by hand per category to look plausible next to the sample record
 * (scrambled eggs = 48,000 px). They are not measured portions.
 *
 * Output is fully deterministic (no timestamps, no randomness), so
 * regenerating produces a byte-identical file.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMenuUpload } from '../menuBundle.js';
import { createReferencePortion, validateReferencePortion } from '../referencePortions.js';
import { buildVocabulary } from '../vocabulary.js';
import type { ImageGeometry, MenuBundle, MenuUpload, ReferencePortion } from '../types.js';

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

type DemoItem = { name: string; category: keyof typeof CATEGORY_AREA_PX; description?: string };

const DEMO_DAYS: Array<{ date: string; breakfast: DemoItem[]; lunch: DemoItem[]; dinner: DemoItem[] }> = [
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
    dinner: [
      { name: 'Baked Ziti', category: 'entree', description: 'Ziti with marinara and mozzarella' },
      { name: 'Garlic Breadstick', category: 'bread', description: 'One herbed garlic breadstick' },
      { name: 'Steamed Broccoli', category: 'side', description: 'Steamed broccoli florets' },
      { name: 'Caesar Salad', category: 'salad', description: 'Romaine, croutons, caesar dressing' },
      { name: 'Vanilla Pudding', category: 'dessert', description: 'Single pudding cup serving' },
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
    dinner: [
      { name: 'Herb Roasted Chicken', category: 'entree', description: 'Quarter chicken with herb rub' },
      { name: 'Mashed Potatoes', category: 'side', description: 'Mashed potatoes with gravy, standard scoop' },
      { name: 'Green Beans', category: 'side', description: 'Sauteed green beans' },
      { name: 'Dinner Roll', category: 'bread', description: 'One buttered dinner roll' },
      { name: 'Apple Crisp', category: 'dessert', description: 'Baked apple crisp, single serving' },
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
    dinner: [
      { name: 'Teriyaki Salmon', category: 'entree', description: 'Glazed salmon fillet' },
      { name: 'Jasmine Rice', category: 'side', description: 'Steamed jasmine rice, standard scoop' },
      { name: 'Roasted Zucchini', category: 'side', description: 'Roasted zucchini and squash' },
      { name: 'Miso Soup', category: 'soup', description: 'Miso broth with tofu and scallion' },
      { name: 'Mango Sorbet', category: 'dessert', description: 'Single scoop of sorbet' },
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
  const upload: MenuUpload = {
    hallId: 'hall-main',
    hallTimezone: 'America/Detroit',
    days: DEMO_DAYS.map((day) => ({
      date: day.date,
      breakfast: day.breakfast,
      lunch: day.lunch,
      dinner: day.dinner,
    })),
  };
  const menus = parseMenuUpload(upload);

  const referencePortions: ReferencePortion[] = [];
  for (const bundle of menus) {
    const byName = new Map(
      DEMO_DAYS.flatMap((day) => [...day.breakfast, ...day.lunch, ...day.dinner]).map(
        (item) => [item.name, item] as const,
      ),
    );
    for (const item of bundle.items) {
      const demoItem = byName.get(item.displayName)!;
      referencePortions.push(
        createReferencePortion([], {
          itemId: item.itemId,
          expectedAreaPx: areaFor(demoItem.category, item.displayName),
          geometry: DEMO_GEOMETRY,
          source: 'manual_area',
        }),
      );
    }
  }

  // Self-check: every record passes this package's own validators and every
  // bundle produces a vocabulary.
  menus.forEach(buildVocabulary);
  referencePortions.forEach(validateReferencePortion);

  return {
    label:
      'DEMO DATA — fictional dining-hall menus with hand-assigned manual_area reference portions for the Scrap prototype. Not real hall data; not measured portions.',
    demo: true,
    provenance:
      'Generated deterministically by data/src/seed/generate.ts (scrap-data). Regenerate with `npm run seed` in data/.',
    hallId: upload.hallId,
    hallTimezone: upload.hallTimezone,
    coordinateSpace: DEMO_GEOMETRY.coordinateSpace,
    menus,
    referencePortions,
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
    `Wrote ${outPath}: ${seed.menus.length} menus, ${seed.referencePortions.length} reference portions.`,
  );
}
