/**
 * The Supabase migrations (supabase/migrations/*.sql) applied to an in-memory
 * Postgres (PGlite), offline: write functions keep the reducers' rules and
 * transactions, and RLS lets the anon/signed-in roles read dashboard tables
 * only and write nothing. Supabase's built-in roles, storage.buckets and the
 * Realtime publication are minimal stand-ins here; the live project is checked
 * by system/supabase-rls.test.mjs.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { REPO } from '../support/stack.mjs';

const DIR = path.join(REPO, 'supabase', 'migrations');

describe('Supabase migrations on an in-memory Postgres', () => {
  it('apply in order; write functions and RLS behave', { timeout: 120_000 }, async () => {
    const db = new PGlite();
    await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  grant usage on schema public to anon, authenticated, service_role;
  grant all on all tables in schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  create schema storage; create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  create publication supabase_realtime;`);
    for (const f of readdirSync(DIR).filter((n) => n.endsWith('.sql')).sort()) await db.exec(readFileSync(path.join(DIR, f), 'utf8'));
    const ok = (name, cond) => assert.ok(cond, name);
    const throws = async (name, sql, re) => { await assert.rejects(db.exec(sql), re ?? /./, name); };
    const q = async (sql, p) => (await db.query(sql, p)).rows;
    await db.exec('set role service_role');
    const menu = (v, items) => ({ service: { serviceId: 'svc_h1_2026-10-24_lunch', hallId: 'h1', hallTimezone: 'America/Detroit', serviceDate: '2026-10-24', mealLabel: 'lunch', menuId: 'menu_h1_lunch', menuVersion: v }, items: items.map(i => ({ itemId: i, menuId: 'menu_h1_lunch', displayName: i })) });
    await q('select upsert_menu($1)', [menu(1, ['item_a', 'item_b'])]);
    ok('hall auto-created with timezone', (await q("select timezone from hall where hall_id='h1'"))[0]?.timezone === 'America/Detroit');
    await q('select upsert_menu($1)', [menu(2, ['item_a', 'item_c'])]);
    ok('revision archived v1 items', (await q('select count(*)::int n from menu_item_revision'))[0].n === 2);
    ok('live items replaced', (await q('select array_agg(item_id order by item_id) a from menu_item'))[0].a.join() === 'item_a,item_c');
    await db.exec("insert into dish values ('rice-dish','Rice')"); await db.exec("update menu_item set dish_id='rice-dish' where item_id='item_a'");
    await q('select upsert_menu($1)', [menu(3, ['item_z', 'item_a', 'item_m'])]);
    ok('upload order kept', (await q("select array_agg(item_id order by position) a from menu_item where menu_id='menu_h1_lunch'"))[0].a.join() === 'item_z,item_a,item_m');
    ok('dish link kept across a revision', (await q("select dish_id from menu_item where item_id='item_a'"))[0]?.dish_id === 'rice-dish');
    ok('first upload of a new menu still inserts', (await q("select count(*)::int n from meal_service"))[0].n === 1);
    await throws('older menu version rejected', `select upsert_menu('${JSON.stringify(menu(1, ['x']))}')`, /is older than the stored version/);
    await db.exec(`insert into image_object values ('img1','supabase','scrap-images','captures/2026-10-24/ev1.jpg',null,'image/jpeg',1000,640,480,now(),'capture','ev1','finalized');
      insert into image_object values ('ov1','supabase','scrap-images','overlays/2026-10-24/ev1_at1.jpg',null,'image/jpeg',500,640,480,now(),'overlay','ev1','finalized');
      insert into capture_event values ('ev1','h1','svc_h1_2026-10-24_lunch',now(),'img1',640,480,'topdown-normalized-v1',null,null,'camera','{}','succeeded');`);
    const attempt = { attemptId: 'at1', eventId: 'ev1', menuId: 'menu_h1_lunch', menuVersion: 3, baselineVersions: {}, model: 'gemini', promptVersion: 'p1', status: 'succeeded', qualityFlags: [], createdAt: '2026-10-24T17:00:00.000Z', overlayObjectId: 'ov1',
      segmentation: { widthPx: 640, heightPx: 480, status: 'succeeded', countStatus: 'complete', capturePixelsWasted: 300, model: 'sam2.1', checkpoint: 'small', codeRevision: 'abc', promptSource: 'gemini_box', settingsVersion: 'sam2-box-v1', countingRuleVersion: 'smallest-first-v1',
        regions: [{ regionId: 'r1', attemptId: 'at1', itemId: 'item_a', visualLabel: 'rice', box: { gemini: [0, 0, 10, 10], pixelXyxy: [0, 0, 5, 5], convention: 'x' }, segmentationStatus: 'succeeded', maskPixels: 200 }] } };
    const meas = [{ measurementId: 'm1', eventId: 'ev1', attemptId: 'at1', itemId: 'item_a', remainingAreaPx: 200, method: 'mask_pixel_count', qualityFlags: [] },
                  { measurementId: 'm2', eventId: 'ev1', attemptId: 'at1', remainingAreaPx: 100, method: 'mask_pixel_count', qualityFlags: [] }];
    await throws('union != sum rejected', `select record_analysis('${JSON.stringify({ ...attempt, segmentation: { ...attempt.segmentation, capturePixelsWasted: 299 } })}','${JSON.stringify(meas)}')`, /capture union 299 != sum of measured pixels 300/);
    ok('failed record_analysis left nothing behind', (await q('select count(*)::int n from analysis_attempt'))[0].n === 0);
    await q('select record_analysis($1,$2)', [attempt, meas]);
    ok('attempt + 2 measurements + count + region + overlay', JSON.stringify(await q(`select (select count(*)::int from analysis_attempt) a,(select count(*)::int from food_measurement) m,(select capture_pixels_wasted from capture_count) c,(select count(*)::int from segmentation_region) r,(select overlay_object_id from attempt_calibration) o`)) === '[{"a":1,"m":2,"c":300,"r":1,"o":"ov1"}]');
    await throws('duplicate attempt rejected', `select record_analysis('${JSON.stringify(attempt)}','[]')`, /already recorded/);
    const portions = { serviceId: 'svc_h1_2026-10-24_lunch', menuVersion: 3, portions: [{ serviceId: 'svc_h1_2026-10-24_lunch', menuVersion: 3, hallId: 'h1', serviceDate: '2026-10-24', menuId: 'menu_h1_lunch', itemId: 'item_a', count: 40, source: 'manual', updatedAt: '2026-10-24T18:00:00Z' }] };
    await q('select replace_portions_served($1)', [portions]); await q('select replace_portions_served($1)', [portions]);
    ok('portions snapshot replaced, not added', (await q('select count(*)::int n, sum(count)::int s from portions_served'))[0].s === 40);
    await throws('stale portions menu', `select replace_portions_served('${JSON.stringify({ ...portions, menuVersion: 2 })}')`, /The menu changed/);
    await q("select set_capture_visibility(array['ev1'], true, now())");
    await throws('visibility unknown event', "select set_capture_visibility(array['nope'], true, now())", /capture event nope does not exist/);
    await throws('interval must be 15-min aligned', "insert into attendance values ('h1','2026-10-24 12:07:00+00','2026-10-24','lunch',5)", /check constraint/);
    await db.exec("insert into dish values ('mac-cheese','Mac and cheese')");
    await db.exec("insert into forecast (hall_id,service_date,meal_label,dish_id,low_lb,high_lb,model_version) values ('h1','2026-10-25','lunch','mac-cheese',10,20,'v0')");
    await db.exec("insert into forecast_outcome (forecast_id,error_lb,fss_error_lb) select forecast_id, 2, -5 from forecast");
    ok('ours_better generated', (await q('select ours_better from forecast_outcome'))[0].ours_better === true);
    // demo clear
    await db.exec(`insert into image_object values ('img2','supabase','scrap-images','captures/x/ev2.jpg',null,'image/jpeg',1,1,1,now(),'capture','ev2','finalized');
      select upsert_menu('${JSON.stringify({ service: { serviceId: 'svc_demo', hallId: 'h1', hallTimezone: 'America/Detroit', serviceDate: '2026-10-01', mealLabel: 'dinner', menuId: 'menu_demo', menuVersion: 1 }, items: [{ itemId: 'item_demo', menuId: 'menu_demo', displayName: 'Demo' }] })}');
      insert into capture_event values ('ev2','h1','svc_demo',now(),'img2',640,480,'topdown-normalized-v1',null,null,'demo','{}','succeeded');
      insert into simulated_attendance values ('svc_demo','h1','2026-10-01',500,'simulated',300,1200,'s','g1');
      insert into demo_marker values ('meal_service:svc_demo','meal_service','svc_demo'),('menu_item:item_demo','menu_item','item_demo'),('capture_event:ev2','capture_event','ev2');`);
    ok('clear_demo_data returns marker count', (await q('select clear_demo_data() n'))[0].n === 3);
    ok('demo rows gone, real rows kept', JSON.stringify(await q(`select (select count(*)::int from capture_event) e,(select count(*)::int from meal_service) s,(select count(*)::int from simulated_attendance) a`)) === '[{"e":1,"s":1,"a":0}]');
    // RLS as anon
    await db.exec('reset role; set role anon');
    ok('anon reads capture_event', (await q('select count(*)::int n from capture_event'))[0].n === 1);
    ok('anon reads forecast', (await q('select count(*)::int n from forecast'))[0].n === 1);
    await throws('anon cannot read image_object', 'select * from image_object', /permission denied/);
    await throws('anon cannot insert', "insert into dish values ('x','x')", /permission denied|row-level security/);
    await throws('anon cannot update', "update capture_event set state='failed'", /permission denied|row-level security/);
    await throws('anon cannot delete', 'delete from meal_service', /permission denied|row-level security/);
    await throws('anon cannot call write functions', 'select clear_demo_data()', /permission denied/);
    await db.exec('reset role; set role authenticated');
    await throws('authenticated cannot insert', "insert into hall values ('h9')", /permission denied|row-level security/);
    await db.exec('reset role');
    ok('RLS enabled on every public table', (await q("select count(*)::int n from pg_tables where schemaname='public' and not rowsecurity"))[0].n === 0);
    await db.close();
  });
});
