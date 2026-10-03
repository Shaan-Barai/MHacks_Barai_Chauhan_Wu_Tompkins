/**
 * Blind live test of the countable/uncountable leftover mode on images/.
 *
 *   cd vision && npm run build && node --env-file=../.env scripts/leftover-eval.mjs [runs]
 *
 * Blindness: each image is re-encoded to a plain JPEG (all EXIF/metadata
 * dropped — some source files carry captions like "bitten hamburger"),
 * shuffled, and sent under an anonymous id with only the labels
 * ["burger", "fries"]. File names are used afterwards, for comparison only.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { assessLeftovers, createGeminiGateway } from '../dist/src/index.js';

// sharp is the capture package's image library; borrow it rather than adding a dependency here.
const sharp = createRequire(fileURLToPath(new URL('../../capture/package.json', import.meta.url)))('sharp');

const dir = fileURLToPath(new URL('../../images/', import.meta.url));
const runs = Number(process.argv[2] ?? 3);
const LABELS = ['burger', 'fries'];

const files = readdirSync(dir).filter((f) => /\.(jpe?g|png|webp)$/i.test(f));
const images = [];
for (const file of files) {
  const bytes = await sharp(readFileSync(path.join(dir, file))).jpeg({ quality: 90 }).toBuffer(); // no metadata
  images.push({ file, bytes });
}
// Shuffle so neither name nor order reaches the model; anonymous ids only.
images.sort(() => Math.random() - 0.5);
images.forEach((img, i) => (img.id = `image-${i + 1}`));

const gateway = createGeminiGateway();
if (gateway.mode !== 'live') throw new Error('GEMINI_API_KEY is not set: this script makes live calls.');
console.log(`model ${gateway.model}, ${images.length} images x ${runs} runs, labels ${JSON.stringify(LABELS)}\n`);

const rows = [];
for (const img of images) {
  const answers = [];
  for (let r = 0; r < runs; r++) {
    const res = await assessLeftovers(gateway, {
      image: { kind: 'bytes', bytes: img.bytes, mimeType: 'image/jpeg' },
      labels: LABELS,
    });
    answers.push(
      res.ok
        ? res.items
            .map((i) => (i.countable ? `${i.label}: countable, ${i.count} left` : `${i.label}: uncountable, ${i.percentRemaining}% left`))
            .join('; ') || '(nothing found)'
        : `ERROR ${res.error.code}`,
    );
  }
  rows.push({ id: img.id, file: img.file, answers });
  console.log(`${img.id}  →  ${answers.join('  |  ')}`);
}

console.log('\nUnblinded (file names were never sent):');
for (const row of rows.sort((a, b) => a.file.localeCompare(b.file))) {
  console.log(`  ${row.file.padEnd(16)} ${row.id.padEnd(9)} ${row.answers.join('  |  ')}`);
}
