/** Shared fixtures/helpers for vision tests. Everything here is mock-mode only. */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AnalyzeCaptureInput } from '../src/analyze.js';
import type { ImageGeometry, MenuItem, ReferencePortion } from '../src/contracts.js';
import { createGeminiGateway, type GeminiGateway, type MockTransport } from '../src/gateway.js';
import type { ImageInput } from '../src/image.js';

const here = dirname(fileURLToPath(import.meta.url));

export const FIXTURES: Record<string, string> = JSON.parse(
  readFileSync(join(here, '..', '..', 'fixtures', 'responses.json'), 'utf8'),
);

export function fixtureTransport(name: string): MockTransport {
  const text = FIXTURES[name];
  if (text === undefined) throw new Error(`No fixture named ${name}`);
  return () => text;
}

export function fixtureGateway(name: string): GeminiGateway {
  return createGeminiGateway({ mockTransport: fixtureTransport(name), env: {}, sleep: async () => {} });
}

export const GEOMETRY: ImageGeometry = {
  widthPx: 1024,
  heightPx: 1024,
  coordinateSpace: 'topdown-normalized-v1',
  plateShape: 'round',
  plateDiameterPx: 900,
};

export const MENU_ITEMS: MenuItem[] = [
  {
    itemId: 'item_scrambled-eggs',
    menuId: 'menu_hall-main_2026-10-03',
    displayName: 'Scrambled Eggs',
    description: 'Plain scrambled eggs, standard scoop serving',
  },
  {
    itemId: 'item_hash-browns',
    menuId: 'menu_hall-main_2026-10-03',
    displayName: 'Hash Browns',
  },
  {
    itemId: 'item_fruit-cup',
    menuId: 'menu_hall-main_2026-10-03',
    displayName: 'Fruit Cup',
  },
];

export const MENU = { menuId: 'menu_hall-main_2026-10-03', menuVersion: 1, items: MENU_ITEMS };

export const BASELINES: ReferencePortion[] = [
  {
    baselineId: 'base_scrambled-eggs_v1',
    baselineVersion: 1,
    itemId: 'item_scrambled-eggs',
    expectedAreaPx: 48000,
    geometry: GEOMETRY,
    source: 'manual_area',
  },
  {
    baselineId: 'base_hash-browns_v1',
    baselineVersion: 1,
    itemId: 'item_hash-browns',
    expectedAreaPx: 30000,
    geometry: GEOMETRY,
    source: 'reference_photo',
  },
  // item_fruit-cup deliberately has no baseline.
];

/** Tiny fake JPEG bytes; mock mode never inspects image content. */
export const IMAGE: ImageInput = {
  kind: 'bytes',
  bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3]),
  mimeType: 'image/jpeg',
};

export const FIXED_NOW = () => new Date('2026-10-03T16:42:15Z');

export function baseInput(overrides: Partial<AnalyzeCaptureInput> = {}): AnalyzeCaptureInput {
  return {
    eventId: 'cap_test01',
    attemptId: 'att_test01',
    image: IMAGE,
    geometry: GEOMETRY,
    menu: MENU,
    baselines: BASELINES,
    now: FIXED_NOW,
    ...overrides,
  };
}
