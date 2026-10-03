import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const TESTS_ROOT = join(__dirname, '../..');
export const FIXTURES_ROOT = join(TESTS_ROOT, 'fixtures');
export const REPO_ROOT = join(TESTS_ROOT, '..');

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function loadManifest() {
  return readJson(join(FIXTURES_ROOT, 'manifest.json'));
}

export function loadScenario(fileRel) {
  return readJson(join(FIXTURES_ROOT, fileRel));
}

export function loadAllScenarios() {
  const manifest = loadManifest();
  return manifest.scenarios.map((entry) => ({
    ...entry,
    data: loadScenario(entry.file),
  }));
}

export function loadContractSamples() {
  return readJson(join(REPO_ROOT, 'contracts/samples.json'));
}

export function collectForbiddenByteFields(obj, forbidden, path = '$', hits = []) {
  if (obj == null || typeof obj !== 'object') return hits;
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => collectForbiddenByteFields(v, forbidden, `${path}[${i}]`, hits));
    return hits;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (forbidden.includes(k)) hits.push(`${path}.${k}`);
    collectForbiddenByteFields(v, forbidden, `${path}.${k}`, hits);
  }
  return hits;
}

export function listScenarioFiles() {
  return readdirSync(join(FIXTURES_ROOT, 'scenarios'))
    .filter((f) => f.endsWith('.json'))
    .sort();
}
