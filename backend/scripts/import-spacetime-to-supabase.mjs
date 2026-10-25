/**
 * One-time (and safe to re-run) copy of SpacetimeDB rows and local-dev images
 * into Supabase. Nothing is deleted or changed at the source.
 *
 *   node scripts/import-spacetime-to-supabase.mjs [--dry-run] [--skip-files]
 *
 * Source (read-only):
 *   SPACETIMEDB_URI / SPACETIMEDB_MODULE / SPACETIMEDB_TOKEN   e.g. this Mac's local server, or the
 *                                                              offsite server's copy later
 *   OBJECT_STORAGE_LOCAL_DIR (default backend/.local-storage)  local-dev image files
 * Target:
 *   SUPABASE_URL (https://<ref>.supabase.co), SUPABASE_SERVICE_ROLE_KEY, OBJECT_STORAGE_CONTAINER
 *   (bucket, default scrap-images)
 *
 * Re-runnable: every row is an upsert on its primary key and every file an
 * upsert on its storage path, so a second run changes nothing and creates no
 * duplicates. Rows that would break a foreign key are reported and skipped,
 * never silently dropped. Image rows are re-pointed at Supabase Storage
 * (provider 'supabase', container = the bucket); their object keys are unchanged.
 *
 * Prints old vs. new counts per table and per image folder; exits 1 if any differ.
 */

import { parseArgs } from 'node:util';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const BACKEND = fileURLToPath(new URL('..', import.meta.url));
const envFile = path.join(BACKEND, '..', '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile); // values already set in the shell win

const { values: args } = parseArgs({ options: { 'dry-run': { type: 'boolean', default: false }, 'skip-files': { type: 'boolean', default: false } } });
const DRY = args['dry-run'];

const { SpacetimeRepository } = await import(path.join(BACKEND, 'dist/backend/src/repo/spacetimeRepository.js'));

function need(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`missing ${name} (see .env.example)`);
    process.exit(2);
  }
  return v;
}
const SUPABASE_URL = need('SUPABASE_URL');
if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(SUPABASE_URL)) {
  console.error('SUPABASE_URL must be the project API address, https://<project-ref>.supabase.co');
  process.exit(2);
}
const BUCKET = process.env.OBJECT_STORAGE_CONTAINER || 'scrap-images';
const LOCAL_DIR = path.resolve(BACKEND, process.env.OBJECT_STORAGE_LOCAL_DIR || '.local-storage');
const source = new SpacetimeRepository({ uri: need('SPACETIMEDB_URI'), module: process.env.SPACETIMEDB_MODULE || 'scrap', token: process.env.SPACETIMEDB_TOKEN || undefined });
const db = createClient(SUPABASE_URL, need('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });

// ---------------------------------------------------------------------------
// Row mapping: SpacetimeDB (camelCase, decoded) -> Postgres row (snake_case)
// ---------------------------------------------------------------------------

const snake = (k) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
function toRow(record) {
  const out = {};
  for (const [k, v] of Object.entries(record)) out[snake(k)] = v === undefined ? null : v;
  return out;
}
/** Drop undefined fields inside a nested object (stored as jsonb). */
const json = (v) => (v === undefined || v === null ? null : JSON.parse(JSON.stringify(v)));
/** SpacetimeDB StoredApiError -> contracts ApiError. */
const apiError = (e) => (e ? json({ code: e.code, message: e.message, details: e.detailsJson ? JSON.parse(e.detailsJson) : undefined, retryable: e.retryable === true }) : null);

/**
 * Old table -> [new table, primary key column, row mapper]. Listed parents
 * first so foreign keys hold. `hall` rows are created by the ensure_hall triggers.
 */
const TABLES = [
  ['meal_service', 'meal_service', 'service_id', toRow],
  ['menu_item', 'menu_item', 'item_id', toRow],
  ['menu_item_revision', 'menu_item_revision', 'revision_item_id', toRow],
  ['image_object', 'image_object', 'object_id', (r) => toRow({ ...r, provider: 'supabase', container: BUCKET })],
  ['reference_portion', 'reference_portion', 'baseline_id', (r) => toRow({ ...r, geometry: json(r.geometry) })],
  ['capture_event', 'capture_event', 'event_id', (r) => {
    const { geometry, ...rest } = r;
    return toRow({ ...rest, qualityFlags: r.qualityFlags ?? [], widthPx: geometry.widthPx, heightPx: geometry.heightPx, coordinateSpace: geometry.coordinateSpace, plateShape: geometry.plateShape, plateDiameterPx: geometry.plateDiameterPx });
  }],
  ['camera_calibration', 'camera_calibration', 'calibration_id', (r) => toRow({ ...r, intrinsics: json(r.intrinsics), depth: json(r.depth), error: apiError(r.error) })],
  ['analysis_attempt', 'analysis_attempt', 'attempt_id', (r) => toRow({
    ...r,
    baselineVersions: Object.fromEntries((r.baselineVersions ?? []).map((b) => [b.itemId, b.baselineVersion])),
    error: apiError(r.error),
  })],
  ['food_measurement', 'food_measurement', 'measurement_id', (r) => {
    const { maskCountJson, ...rest } = r;
    return toRow({ ...rest, maskCount: maskCountJson ? JSON.parse(maskCountJson) : undefined, physical: json(r.physical) });
  }],
  ['capture_count', 'capture_count', 'attempt_id', toRow],
  ['segmentation_region', 'segmentation_region', 'region_id', (r) => toRow({ ...r, error: apiError(r.error) })],
  ['attempt_calibration', 'attempt_calibration', 'attempt_id', (r) => toRow({ ...r, calibration: json(r.calibration) })],
  ['measurement_settings', 'measurement_settings', 'hall_id', toRow],
  // Renamed: the simulated per-service attendance (forecasting owns `attendance` now).
  ['attendance', 'simulated_attendance', 'service_id', toRow],
  ['portions_served', 'portions_served', 'record_id', toRow],
  ['insight', 'insight', 'insight_id', (r) => {
    const { metricsJson, ...rest } = r;
    return toRow({ ...rest, metrics: metricsJson ? JSON.parse(metricsJson) : {} });
  }],
  ['capture_visibility', 'capture_visibility', 'event_id', toRow],
  ['dashboard_view', 'dashboard_view', 'hall_id', toRow],
  ['scan_info', 'scan_info', 'event_id', (r) => toRow({ ...r, demo: r.demo === true })],
  ['demo_marker', 'demo_marker', 'marker_id', toRow],
];

/** Foreign keys checked before loading: [table, column, parent table, parent key]. */
const FOREIGN_KEYS = [
  ['capture_event', 'service_id', 'meal_service', 'service_id'],
  ['capture_event', 'image_object_id', 'image_object', 'object_id'],
  ['reference_portion', 'reference_image_object_id', 'image_object', 'object_id'],
  ['camera_calibration', 'image_object_id', 'image_object', 'object_id'],
  ['camera_calibration', 'overlay_object_id', 'image_object', 'object_id'],
  ['camera_calibration', 'reference_mask_object_id', 'image_object', 'object_id'],
  ['analysis_attempt', 'event_id', 'capture_event', 'event_id'],
  ['analysis_attempt', 'calibration_id', 'camera_calibration', 'calibration_id'],
  ['food_measurement', 'event_id', 'capture_event', 'event_id'],
  ['food_measurement', 'attempt_id', 'analysis_attempt', 'attempt_id'],
  ['capture_count', 'attempt_id', 'analysis_attempt', 'attempt_id'],
  ['capture_count', 'event_id', 'capture_event', 'event_id'],
  ['segmentation_region', 'attempt_id', 'analysis_attempt', 'attempt_id'],
  ['segmentation_region', 'event_id', 'capture_event', 'event_id'],
  ['segmentation_region', 'mask_object_id', 'image_object', 'object_id'],
  ['attempt_calibration', 'attempt_id', 'analysis_attempt', 'attempt_id'],
  ['attempt_calibration', 'event_id', 'capture_event', 'event_id'],
  ['attempt_calibration', 'overlay_object_id', 'image_object', 'object_id'],
  ['measurement_settings', 'active_calibration_id', 'camera_calibration', 'calibration_id'],
  ['simulated_attendance', 'service_id', 'meal_service', 'service_id'],
  ['portions_served', 'service_id', 'meal_service', 'service_id'],
  ['capture_visibility', 'event_id', 'capture_event', 'event_id'],
  ['scan_info', 'event_id', 'capture_event', 'event_id'],
  ['scan_info', 'original_image_object_id', 'image_object', 'object_id'],
];

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

const prepared = new Map(); // new table -> { pk, rows }
const oldCounts = {};
for (const [oldName, newName, pk, map] of TABLES) {
  let rows = [];
  try {
    rows = await source.dumpTable(oldName);
  } catch (err) {
    // A module published before an additive table existed simply has none of its rows.
    if (!/not found|no such table|doesn't exist|does not exist/i.test(String(err?.message))) throw err;
  }
  oldCounts[newName] = rows.length;
  prepared.set(newName, { pk, rows: rows.map(map) });
}

// Menu items keep their upload order: SpacetimeDB returns rows in insertion order.
{
  const next = new Map();
  for (const row of prepared.get('menu_item').rows) {
    const n = (next.get(row.menu_id) ?? 0) + 1;
    next.set(row.menu_id, n);
    row.position = n;
  }
}

// Orphans: a row whose parent is missing would fail its foreign key; skip and report it.
const skipped = [];
let changed = true;
while (changed) {
  changed = false; // repeat: skipping a parent can orphan its children
  for (const [table, col, parent, parentKey] of FOREIGN_KEYS) {
    const t = prepared.get(table);
    const keys = new Set(prepared.get(parent).rows.map((r) => r[parentKey]));
    const keep = [];
    for (const row of t.rows) {
      if (row[col] === null || row[col] === undefined || keys.has(row[col])) keep.push(row);
      else {
        skipped.push(`${table}.${t.pk}=${row[t.pk]}: ${col}=${row[col]} has no ${parent} row`);
        changed = true;
      }
    }
    t.rows = keep;
  }
}

console.log(`source: SpacetimeDB ${process.env.SPACETIMEDB_MODULE || 'scrap'} at ${process.env.SPACETIMEDB_URI}; target: ${new URL(SUPABASE_URL).host}${DRY ? ' (DRY RUN: nothing written)' : ''}`);
if (skipped.length) {
  console.log(`\n${skipped.length} row(s) skipped because a parent row is missing in the source:`);
  for (const s of skipped) console.log(`  - ${s}`);
}

if (!DRY) {
  for (const [table, { pk, rows }] of prepared) {
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await db.from(table).upsert(rows.slice(i, i + 500), { onConflict: pk });
      if (error) {
        console.error(`upsert ${table} failed: ${error.message}${error.details ? ` (${error.details})` : ''}`);
        process.exit(1);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Files: <OBJECT_STORAGE_LOCAL_DIR>/<container>/<objectKey> -> bucket/<objectKey>
// ---------------------------------------------------------------------------

const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
function walk(dir, base = dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? walk(p, base) : [path.relative(base, p).split(path.sep).join('/')];
  });
}
const localRoot = path.join(LOCAL_DIR, BUCKET);
const localFiles = walk(localRoot).filter((k) => !k.startsWith('.') && !k.includes('/.'));
const folderOf = (k) => k.split('/')[0];
const fileCounts = { old: {}, new: {} };
for (const k of localFiles) fileCounts.old[folderOf(k)] = (fileCounts.old[folderOf(k)] ?? 0) + 1;
const fileProblems = [];

if (!args['skip-files'] && !DRY) {
  const bucket = db.storage.from(BUCKET);
  for (const key of localFiles) {
    const bytes = readFileSync(path.join(localRoot, key));
    const contentType = MIME[key.split('.').pop()?.toLowerCase()] ?? 'application/octet-stream';
    const { error } = await bucket.upload(key, bytes, { contentType, upsert: true });
    if (error) {
      fileProblems.push(`${key}: upload failed (${error.message})`);
      continue;
    }
    const { data: info, error: infoErr } = await bucket.info(key);
    if (infoErr || info?.size !== bytes.length) fileProblems.push(`${key}: stored size ${info?.size ?? '?'} != local ${bytes.length}`);
  }
}

// Image rows whose file is missing locally (and files no row points to).
const keysWithRows = new Set(prepared.get('image_object').rows.map((r) => r.object_key));
const localSet = new Set(localFiles);
const rowsWithoutFile = [...keysWithRows].filter((k) => !localSet.has(k));
const filesWithoutRow = localFiles.filter((k) => !keysWithRows.has(k));

// ---------------------------------------------------------------------------
// Old vs. new counts
// ---------------------------------------------------------------------------

async function countTable(table) {
  const { count, error } = await db.from(table).select('*', { count: 'exact', head: true });
  if (error) throw new Error(`count ${table}: ${error.message}`);
  return count ?? 0;
}
async function listAll(prefix) {
  const keys = [];
  const bucket = db.storage.from(BUCKET);
  const walkRemote = async (folder) => {
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await bucket.list(folder, { limit: 1000, offset });
      if (error) throw error;
      for (const e of data) {
        const full = folder ? `${folder}/${e.name}` : e.name;
        if (e.id === null) await walkRemote(full);
        else keys.push(full);
      }
      if (data.length < 1000) break;
    }
  };
  await walkRemote(prefix);
  return keys;
}

let mismatch = false;
console.log('\nROWS            old (SpacetimeDB)   new (Supabase)');
for (const [, newName] of TABLES) {
  const n = await countTable(newName);
  const flag = n === oldCounts[newName] ? '' : '   <-- differs';
  if (flag) mismatch = true;
  console.log(`  ${newName.padEnd(22)} ${String(oldCounts[newName]).padStart(6)} ${String(n).padStart(16)}${flag}`);
}
const remote = await listAll('');
for (const k of remote) {
  if (!k.startsWith('test/')) fileCounts.new[folderOf(k)] = (fileCounts.new[folderOf(k)] ?? 0) + 1;
}
console.log(`\nFILES           old (${path.relative(path.join(BACKEND, '..'), localRoot)})   new (bucket ${BUCKET})`);
for (const folder of [...new Set([...Object.keys(fileCounts.old), ...Object.keys(fileCounts.new)])].sort()) {
  const o = fileCounts.old[folder] ?? 0;
  const n = fileCounts.new[folder] ?? 0;
  const flag = o === n ? '' : '   <-- differs';
  if (flag) mismatch = true;
  console.log(`  ${folder.padEnd(22)} ${String(o).padStart(6)} ${String(n).padStart(16)}${flag}`);
}
if (rowsWithoutFile.length) console.log(`\n${rowsWithoutFile.length} image row(s) have no local file: ${rowsWithoutFile.slice(0, 10).join(', ')}${rowsWithoutFile.length > 10 ? ', …' : ''}`);
if (filesWithoutRow.length) console.log(`${filesWithoutRow.length} local file(s) have no image row: ${filesWithoutRow.slice(0, 10).join(', ')}${filesWithoutRow.length > 10 ? ', …' : ''}`);
if (fileProblems.length) {
  mismatch = true;
  console.log(`\nfile problems:\n${fileProblems.map((p) => `  - ${p}`).join('\n')}`);
}
if (skipped.length) mismatch = true;
console.log(mismatch ? '\nRESULT: counts differ (see above)' : '\nRESULT: every count matches');
process.exit(mismatch && !DRY ? 1 : 0);
