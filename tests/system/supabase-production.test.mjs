/**
 * Integration: the production_log store on live Supabase (the table, its
 * review constraints and the confirmed-row uniqueness). Uses a per-run hall
 * and dish; everything it creates is deleted afterwards. No Gemini call.
 * Skipped (with a message) when SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not in ../.env.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { REPO, supabaseAvailable } from '../support/stack.mjs';

const skip = supabaseAvailable() ? false : 'SUPABASE_URL (https://<ref>.supabase.co) and SUPABASE_SERVICE_ROLE_KEY are not set in .env';
const RUN = `pl${Date.now().toString(36)}`;
const HALL = `hall-${RUN}`;
const DISH = `dish-${RUN}`;

describe('production_log on Supabase', { skip }, () => {
  let store;
  let db;
  before(async () => {
    const { SupabaseProductionStore } = await import(path.join(REPO, 'backend/dist/backend/src/repo/productionStore.js'));
    store = new SupabaseProductionStore({ url: process.env.SUPABASE_URL, serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY });
    const { createClient } = createRequire(`${REPO}backend/package.json`)('@supabase/supabase-js');
    db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    assert.equal((await db.from('dish').insert({ dish_id: DISH, display_name: `Test dish ${RUN}`, service_style: 'entree' })).error, null);
  });
  after(async () => {
    if (skip) return;
    await db.from('production_log').delete().eq('hall_id', HALL);
    await db.from('dish').delete().eq('dish_id', DISH);
    await db.from('hall').delete().eq('hall_id', HALL);
  });

  it('unconfirmed rows round-trip; confirm enforces leftover <= prepped and one confirmed row per dish x station x meal', async () => {
    const base = {
      hallId: HALL, serviceDate: '2026-10-20', mealLabel: 'lunch', dishId: null, dishNameRaw: 'Tst dsh?', station: 'Grill',
      preppedLb: 10.25, preppedPortions: 40, panLeftoverLb: 12, ranOutAt: '2026-10-20T16:40:00.000Z', source: 'sheet_photo', status: 'unconfirmed',
      fieldConfidence: { dish: 0.4, preppedLb: 0.9 }, reviewFlags: ['unknown_dish', 'leftover_exceeds_prepped'],
      sheetImageObjectId: null, sheetPhotoPath: 'production-sheets/2026-10-20/sheet_x.jpg', extractionModel: 'test|production-sheet-v1',
    };
    const [a, b] = await store.insert([base, { ...base, dishNameRaw: 'Test dish again' }]);
    assert.equal(a.status, 'unconfirmed');
    assert.equal(a.preppedLb, 10.25, 'numeric comes back as a number');
    assert.equal(a.ranOutAt, '2026-10-20T16:40:00.000Z');
    assert.deepEqual(a.reviewFlags, ['unknown_dish', 'leftover_exceeds_prepped']);
    assert.equal((await store.list({ hallId: HALL, status: 'unconfirmed' })).length, 2);

    // The database itself refuses a confirmed row without a dish or with leftover > prepped.
    await assert.rejects(store.update(a.productionLogId, { status: 'confirmed', confirmedBy: 'x' }), /production_log_confirmed_dish|23514/);
    await assert.rejects(store.update(a.productionLogId, { status: 'confirmed', confirmedBy: 'x', dishId: DISH }), /leftover_le_prepped|23514/);
    const ok = await store.update(a.productionLogId, { status: 'confirmed', confirmedBy: 'Chef', confirmedAt: new Date().toISOString(), dishId: DISH, panLeftoverLb: 1 });
    assert.equal(ok.status, 'confirmed');
    await assert.rejects(
      store.update(b.productionLogId, { status: 'confirmed', confirmedBy: 'Chef', dishId: DISH, panLeftoverLb: 1 }),
      (e) => e?.apiError?.code === 'PRODUCTION_ROW_EXISTS',
    );
    assert.ok((await store.listDishes()).some((d) => d.dishId === DISH));
  });
});
