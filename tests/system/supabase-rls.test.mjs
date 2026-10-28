/**
 * Integration: Row Level Security on the live Supabase project, with the
 * publishable (anon) key the dashboard ships. Every table refuses inserts,
 * updates and deletes; every write function refuses to run; private tables
 * are unreadable; dashboard tables are readable; the private bucket refuses
 * direct reads and writes. Nothing is written (every attempt must fail).
 * Skipped (with a message) when SUPABASE_URL / SUPABASE_ANON_KEY are not in ../.env.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { REPO } from '../support/stack.mjs';

const { createClient } = createRequire(`${REPO}backend/package.json`)('@supabase/supabase-js');
const skip =
  /^https:\/\/[a-z0-9]+\.supabase\.co\/?$/.test(process.env.SUPABASE_URL ?? '') && process.env.SUPABASE_ANON_KEY
    ? false
    : 'SUPABASE_URL (https://<ref>.supabase.co) and SUPABASE_ANON_KEY are not set in .env';

const DASHBOARD_TABLES = [
  'hall', 'dish', 'meal_service', 'menu_item', 'menu_item_revision', 'reference_portion', 'capture_event', 'food_measurement',
  'simulated_attendance', 'portions_served', 'insight', 'camera_calibration', 'measurement_settings',
  'menu_cycle', 'attendance', 'context_day', 'forecast', 'forecast_outcome',
];
const PRIVATE_TABLES = [
  'image_object', 'analysis_attempt', 'capture_count', 'segmentation_region', 'attempt_calibration',
  'capture_visibility', 'dashboard_view', 'scan_info', 'demo_marker',
  'production_log', // private since 20261028000013: reviewer names and sheet photo paths
  'plate_scale_estimate', // 20261028000015
];
/** A real column of each table, so every refusal is a permission refusal (not "no such column"). */
const KEY_COLUMN = {
  hall: 'hall_id', dish: 'dish_id', meal_service: 'service_id', menu_item: 'item_id', menu_item_revision: 'revision_item_id',
  reference_portion: 'baseline_id', capture_event: 'event_id', food_measurement: 'measurement_id', simulated_attendance: 'service_id',
  portions_served: 'record_id', insight: 'insight_id', camera_calibration: 'calibration_id', measurement_settings: 'hall_id',
  menu_cycle: 'hall_id', production_log: 'hall_id', attendance: 'hall_id', context_day: 'hall_id', forecast: 'hall_id',
  forecast_outcome: 'error_lb', image_object: 'object_id', analysis_attempt: 'attempt_id', capture_count: 'attempt_id',
  segmentation_region: 'region_id', attempt_calibration: 'attempt_id', capture_visibility: 'event_id', dashboard_view: 'hall_id',
  scan_info: 'event_id', demo_marker: 'marker_id', plate_scale_estimate: 'attempt_id',
};
const WRITE_FUNCTIONS = {
  upsert_menu: { p_menu: {} },
  record_analysis: { p_attempt: {}, p_measurements: [] },
  replace_portions_served: { p_snapshot: {} },
  set_capture_visibility: { p_event_ids: ['x'], p_hidden: true, p_updated_at: '2026-10-24T00:00:00Z' },
  upsert_camera_calibration: { p_calibration: {} },
  upsert_measurement_settings: { p_settings: {} },
  clear_demo_data: {},
};

describe('RLS with the publishable key', { skip }, () => {
  const anon = skip ? null : createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });

  it('the key really is the publishable one, never the secret key', () => {
    assert.ok(!process.env.SUPABASE_ANON_KEY.startsWith('sb_secret_'));
    assert.notEqual(process.env.SUPABASE_ANON_KEY, process.env.SUPABASE_SERVICE_ROLE_KEY);
  });

  it('every table refuses insert, update and delete', async () => {
    const allowed = [];
    for (const table of [...DASHBOARD_TABLES, ...PRIVATE_TABLES]) {
      const col = KEY_COLUMN[table];
      const value = col === 'error_lb' ? 1 : 'rls-probe';
      const ins = await anon.from(table).insert({ [col]: value });
      // A filter that matches nothing: even a "successful" update/delete would be a policy hole.
      const upd = await anon.from(table).update({ [col]: value }).eq(col, col === 'error_lb' ? -999 : '__rls_probe_none__').select();
      const del = await anon.from(table).delete().eq(col, col === 'error_lb' ? -999 : '__rls_probe_none__').select();
      for (const [op, res] of [['insert', ins], ['update', upd], ['delete', del]]) {
        if (!res.error) allowed.push(`${table}: ${op}`);
        else assert.match(`${res.error.code} ${res.error.message}`, /42501|permission denied|row-level security/, `${table} ${op}: ${res.error.code} ${res.error.message}`);
      }
    }
    assert.deepEqual(allowed, []);
  });

  it('every write function refuses to run', async () => {
    const ran = [];
    for (const [fn, args] of Object.entries(WRITE_FUNCTIONS)) {
      const { error } = await anon.rpc(fn, args);
      if (!error) ran.push(fn);
      else assert.match(`${error.code} ${error.message}`, /42501|permission denied/, `${fn}: ${error.message}`);
    }
    assert.deepEqual(ran, []);
  });

  it('private tables are unreadable; dashboard tables are readable', async () => {
    assert.deepEqual(Object.keys(KEY_COLUMN).sort(), [...DASHBOARD_TABLES, ...PRIVATE_TABLES].sort(), 'every table is covered');
    for (const table of PRIVATE_TABLES) {
      const { error } = await anon.from(table).select('*').limit(1);
      assert.ok(error, `${table} must not be readable`);
      assert.match(`${error.code} ${error.message}`, /42501|permission denied/);
    }
    for (const table of DASHBOARD_TABLES) {
      const { error } = await anon.from(table).select('*').limit(1);
      assert.equal(error, null, `${table}: ${error?.message}`);
    }
  });

  it('the image bucket is private to the publishable key', async () => {
    const bucket = anon.storage.from('scrap-images');
    const { data: list } = await bucket.list('captures', { limit: 5 });
    assert.deepEqual(list ?? [], [], 'cannot list objects');
    const { error: up } = await bucket.upload(`rls-probe/${Date.now()}.jpg`, Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { contentType: 'image/jpeg' });
    assert.ok(up, 'cannot upload');
    const { error: signed } = await bucket.createSignedUrl('captures/anything.jpg', 60);
    assert.ok(signed, 'cannot mint signed URLs');
  });
});
