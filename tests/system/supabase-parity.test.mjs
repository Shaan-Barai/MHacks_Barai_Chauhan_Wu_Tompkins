/**
 * Parity: after the import, every Repository read returns the same records on
 * Supabase as on the SpacetimeDB data they came from. The dashboard's numbers
 * are computed by unchanged code (backend services + analytics/) from exactly
 * these reads, so equal reads mean equal totals, charts and images.
 *
 * Read-only on both sides. Allowed differences, and only these:
 *  - timestamps are compared as instants ('…:33Z' and '…:33.000Z' are equal);
 *  - image rows point at Supabase Storage now (provider 'supabase', container = bucket);
 *  - non-integer numbers are compared to 12 significant digits. Postgres stores
 *    them exactly, but Supabase's server config (extra_float_digits = 0) prints
 *    15 digits, so e.g. 2.436357642577195 reads back as 2.4363576425772. Pixel
 *    counts are integers and must match exactly.
 * A table the source's (older) SpacetimeDB schema does not have counts as "no
 * rows", which is what the import copied for it.
 *
 * Opt-in (needs the source SpacetimeDB running and the import done):
 *   PARITY_SPACETIMEDB_URI=http://127.0.0.1:3901 node --env-file=../.env --test system/supabase-parity.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { REPO, supabaseAvailable } from '../support/stack.mjs';

const SOURCE = process.env.PARITY_SPACETIMEDB_URI;
const skip = !SOURCE ? 'opt-in: set PARITY_SPACETIMEDB_URI to the SpacetimeDB the data was imported from' : supabaseAvailable() ? false : 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set';
const BUCKET = process.env.OBJECT_STORAGE_CONTAINER || 'scrap-images';

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:?\d\d)$/;
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value instanceof Set) return [...value].sort();
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = normalize(value[k]);
    if (out.association && 'objectKey' in out) {
      out.provider = 'supabase';
      out.container = BUCKET;
    }
    return out;
  }
  if (typeof value === 'string' && ISO.test(value)) return new Date(value).toISOString();
  if (typeof value === 'number' && !Number.isInteger(value)) return Number(value.toPrecision(12));
  return value;
}

describe('repository parity: SpacetimeDB source vs Supabase', { skip }, () => {
  it('every read returns the same records', { timeout: 600_000 }, async () => {
    const { SpacetimeRepository } = await import(path.join(REPO, 'backend/dist/backend/src/repo/spacetimeRepository.js'));
    const { SupabaseRepository } = await import(path.join(REPO, 'backend/dist/backend/src/repo/supabaseRepository.js'));
    const old = new SpacetimeRepository({ uri: SOURCE, module: process.env.SPACETIMEDB_MODULE || 'scrap', token: process.env.SPACETIMEDB_TOKEN });
    // Older module: a table it never had simply has no rows.
    const sql = old.sql.bind(old);
    const missing = new Set();
    old.sql = async (q) => {
      try {
        return await sql(q);
      } catch (err) {
        const m = /no such table: `?([a-z_]+)`?/.exec(String(err?.message));
        if (!m) throw err;
        missing.add(m[1]);
        return [];
      }
    };
    const neu = new SupabaseRepository({ url: process.env.SUPABASE_URL, serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY });

    const diffs = [];
    let compared = 0;
    const same = async (label, call) => {
      compared += 1;
      const [a, b] = await Promise.all([call(old), call(neu)]);
      try {
        assert.deepStrictEqual(normalize(b), normalize(a));
      } catch {
        diffs.push(`${label}\n  spacetime: ${JSON.stringify(normalize(a)).slice(0, 600)}\n  supabase:  ${JSON.stringify(normalize(b)).slice(0, 600)}`);
      }
    };

    const services = await old.listServices();
    const halls = [...new Set(services.map((s) => s.hallId))].sort();
    await same('listServices()', (r) => r.listServices().then((x) => x.sort((p, q) => p.serviceId.localeCompare(q.serviceId))));
    for (const s of services) {
      await same(`getMenuByService(${s.serviceId})`, (r) => r.getMenuByService(s.serviceId));
      await same(`findMenus(${s.hallId}, ${s.serviceDate}, ${s.mealLabel})`, (r) => r.findMenus(s.hallId, s.serviceDate, s.mealLabel));
      await same(`listPortionsServed(${s.serviceId})`, (r) => r.listPortionsServed(s.serviceId, s.menuVersion));
      await same(`getAttendance(${s.serviceId})`, (r) => r.getAttendance(s.serviceId));
      for (const item of (await old.getMenuByService(s.serviceId))?.items ?? []) {
        await same(`getMenuItem(${item.itemId})`, (r) => r.getMenuItem(item.itemId));
      }
    }
    const byId = (key) => (x) => x.sort((p, q) => String(p[key]).localeCompare(String(q[key])));
    await same('listReferencePortions()', (r) => r.listReferencePortions().then(byId('baselineId')));
    await same('listImageObjects()', (r) => r.listImageObjects().then(byId('objectId')));
    for (const img of await old.listImageObjects()) {
      await same(`getImageObject(${img.objectId})`, (r) => r.getImageObject(img.objectId));
      await same(`findImageObjectsByAssociation(${img.association.kind}, ${img.association.id})`, (r) => r.findImageObjectsByAssociation(img.association.kind, img.association.id).then(byId('objectId')));
    }
    await same('listCaptureEvents(includeHidden)', (r) => r.listCaptureEvents({ includeHidden: true }).then(byId('eventId')));
    await same('listHiddenCaptureIds()', (r) => r.listHiddenCaptureIds());
    for (const hallId of halls) {
      await same(`listCaptureEvents(${hallId})`, (r) => r.listCaptureEvents({ hallId }).then(byId('eventId')));
      await same(`listInsights(${hallId})`, (r) => r.listInsights(hallId).then(byId('insightId')));
      await same(`listCameraCalibrations(${hallId})`, (r) => r.listCameraCalibrations(hallId));
      await same(`getMeasurementSettings(${hallId})`, (r) => r.getMeasurementSettings(hallId));
      await same(`getDashboardView(${hallId})`, (r) => r.getDashboardView(hallId));
    }
    for (const e of await old.listCaptureEvents({ includeHidden: true })) {
      await same(`getCaptureEvent(${e.eventId})`, (r) => r.getCaptureEvent(e.eventId));
      await same(`getScanInfo(${e.eventId})`, (r) => r.getScanInfo(e.eventId));
      await same(`listAnalysisAttempts(${e.eventId})`, (r) => r.listAnalysisAttempts(e.eventId));
      await same(`listMeasurementsByEvent(${e.eventId})`, (r) => r.listMeasurementsByEvent(e.eventId).then(byId('measurementId')));
      for (const a of await old.listAnalysisAttempts(e.eventId)) {
        await same(`listMeasurementsByAttempt(${a.attemptId})`, (r) => r.listMeasurementsByAttempt(a.attemptId).then(byId('measurementId')));
      }
    }

    console.log(`[parity] ${compared} reads compared across ${halls.length} hall(s), ${services.length} services; ${diffs.length} differ. Tables absent from the source schema (no rows): ${[...missing].sort().join(', ') || 'none'}`);
    assert.deepEqual(diffs, [], diffs.join('\n'));
  });
});
