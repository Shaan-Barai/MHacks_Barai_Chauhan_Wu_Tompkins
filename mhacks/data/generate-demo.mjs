import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const geometryId = 'plate-topdown-1024-v1';
const catalogs = {
  breakfast: [['Scrambled eggs', 48000], ['Breakfast potatoes', 56000], ['Pancakes', 62000], ['Fresh fruit', 36000], ['Oatmeal', 44000]],
  lunch: [['Roasted vegetables', 55000], ['Grilled chicken', 48000], ['Brown rice', 52000], ['Garden salad', 65000], ['Tomato soup', 46000]],
  dinner: [['Pasta primavera', 68000], ['Roasted broccoli', 43000], ['Baked salmon', 51000], ['Mashed potatoes', 55000], ['Dinner roll', 30000]],
};

function randomFrom(seed) {
  let state = 2166136261;
  for (const character of seed) state = Math.imul(state ^ character.charCodeAt(0), 16777619) >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

export function generateDemo({ end = '2026-10-03', seed = 'scrap-seven-days-v1', attendanceMin = 300, attendanceMax = 1200 } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(end) || !Number.isFinite(Date.parse(`${end}T12:00:00Z`))) throw new Error('Expected an ISO end date.');
  if (!Number.isInteger(attendanceMin) || !Number.isInteger(attendanceMax) || attendanceMin < 1 || attendanceMax < attendanceMin) throw new Error('Invalid attendance range.');
  const services = [];
  const dates = Array.from({ length: 7 }, (_, index) => new Date(Date.parse(`${end}T12:00:00Z`) - (6 - index) * 86400000).toISOString().slice(0, 10));
  for (const [dayIndex, localDate] of dates.entries()) {
    for (const [meal, catalog] of Object.entries(catalogs)) {
      const id = `demo-hall:${localDate}:${meal}`;
      const random = randomFrom(`${seed}:${id}`);
      const items = catalog.map(([name, baselineAreaPx], index) => ({ id: `${meal}-${index + 1}`, name, baselineId: `${meal}-${index + 1}:baseline-v1`, baselineAreaPx }));
      const attendance = { count: attendanceMin + Math.floor(random() * (attendanceMax - attendanceMin + 1)), source: 'simulated', min: attendanceMin, max: attendanceMax, seed, generatorVersion: 'mulberry32-v1' };
      const captureCount = 76 + Math.floor(random() * 33);
      const captures = [];
      for (let captureIndex = 0; captureIndex < captureCount; captureIndex++) {
        const status = captureIndex % 29 === 0 ? 'failed' : captureIndex % 23 === 0 ? 'needs_review' : 'succeeded';
        const emptyPlate = status === 'succeeded' && captureIndex % 19 === 0;
        const measurements = [];
        if (status === 'needs_review') {
          const aboveBaseline = captureIndex % 46 === 0;
          measurements.push({ itemId: aboveBaseline ? items[0].id : null, remainingAreaPx: aboveBaseline ? Math.round(items[0].baselineAreaPx * 1.18) : 8200, baselineAreaPx: aboveBaseline ? items[0].baselineAreaPx : null, baselineId: aboveBaseline ? items[0].baselineId : null, geometryId, qualityFlags: [aboveBaseline ? 'above_baseline' : 'unknown_food'], method: 'demo_ai_estimate', isDemo: true });
        } else if (status === 'succeeded' && !emptyPlate) {
          const foodCount = 1 + Math.floor(random() * 3);
          const available = [...items];
          for (let foodIndex = 0; foodIndex < foodCount; foodIndex++) {
            const [item] = available.splice(Math.floor(random() * available.length), 1);
            const fraction = captureIndex % 27 === 0 ? 0 : Math.max(0.025, 0.11 + random() * 0.28 + (item.id.endsWith('-1') ? 0.18 : 0) - dayIndex * 0.015);
            measurements.push({ itemId: item.id, remainingAreaPx: Math.round(item.baselineAreaPx * fraction), baselineAreaPx: item.baselineAreaPx, baselineId: item.baselineId, geometryId, qualityFlags: [], method: 'demo_ai_estimate', isDemo: true });
          }
        }
        // America/Detroit is UTC-04:00 throughout this fixture's date range.
        const hour = { breakfast: 8, lunch: 12, dinner: 18 }[meal];
        const capturedAt = new Date(Date.parse(`${localDate}T${String(hour).padStart(2, '0')}:00:00-04:00`) + captureIndex * 18000).toISOString();
        captures.push({ id: `${id}:capture-${captureIndex + 1}`, capturedAt, source: 'demo_replay', status, emptyPlate, measurements, isDemo: true });
      }
      services.push({ id, hallId: 'demo-hall', localDate, meal, menuId: `${id}:menu`, menuVersion: 1, geometryId, items, attendance, captures, isDemo: true });
    }
  }
  return { schemaVersion: 1, source: 'synthetic_ui_fixture', isDemo: true, hall: { id: 'demo-hall', name: 'Demo Dining Hall', timezone: 'America/Detroit' }, window: { start: dates[0], end, days: 7 }, seed, geometry: { id: geometryId, width: 1024, height: 1024, description: 'Compatible normalized top-down plate geometry; synthetic examples, no image masks.' }, services };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const dataset = generateDemo({ end: process.env.DEMO_END_DATE || '2026-10-03', seed: process.env.ATTENDANCE_SEED || 'scrap-seven-days-v1', attendanceMin: Number(process.env.ATTENDANCE_MIN || 300), attendanceMax: Number(process.env.ATTENDANCE_MAX || 1200) });
  const output = resolve(projectRoot, 'frontend/demo-data.json');
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(dataset, null, 2)}\n`);
  console.log(`Generated ${dataset.services.length} demo services and ${dataset.services.reduce((count, service) => count + service.captures.length, 0)} synthetic captures for ${dataset.window.start} through ${dataset.window.end}.`);
}
