/**
 * Build the SYNTHETIC calibration fixture (docs/fixture-provenance.md).
 *
 *   node capture/scripts/make-calibration-fixture.mjs
 *
 * No real photo of a credit card under the C920s exists yet, so this composites
 * a credit-card-sized rounded rectangle of known pixel area onto an empty patch
 * of table from test2/IMG_2704.jpeg (the dark table below the plate), at the
 * C920s native 1920×1080. The card is drawn as the C920s would see an ID-1
 * card (85.60 × 53.98 mm) from DESIGN_HEIGHT_CM with nominal intrinsics
 * (IT_4 I3: 78° diagonal FOV ⇒ f ≈ 1360 px at 1920 wide). It is labeled
 * "SAMPLE CARD · SYNTHETIC FIXTURE" in the image itself.
 *
 * Writes capture/fixtures/calibration/credit-card-synthetic.{jpg,json}. The
 * JSON holds the exact drawn geometry and the numbers a correct calibration
 * should land near, both in the raw frame and after the capture normalization
 * (center square crop → 1024×1024), which is what the backend measures.
 * Deterministic: rerunning produces the same pixels for the same sharp version.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = fileURLToPath(new URL('../..', import.meta.url));
const OUT_DIR = path.join(root, 'capture', 'fixtures', 'calibration');
const BACKGROUND = path.join(root, 'test2', 'IMG_2704.jpeg');

const FRAME_W = 1920;
const FRAME_H = 1080;
const NORMALIZED = 1024;
const DESIGN_HEIGHT_CM = 45;
const CARD_MM = { w: 85.6, h: 53.98, r: 3.18 };
const KNOWN_AREA_CM2 = 46.21;

// C920s nominal intrinsics at the native width (IT_4 I3).
const fNative = Math.hypot(FRAME_W, FRAME_H) / 2 / Math.tan((39 * Math.PI) / 180);
const px = (mm) => Math.round((fNative * mm) / (DESIGN_HEIGHT_CM * 10));
const card = { w: px(CARD_MM.w), h: px(CARD_MM.h), r: px(CARD_MM.r) };
// Lower middle of the frame, inside the central square that normalization keeps.
const left = Math.round(FRAME_W / 2 - card.w / 2);
const top = 720;

const cardSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${card.w}" height="${card.h}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#9fd3ea"/><stop offset="1" stop-color="#2a8fb8"/></linearGradient></defs>
  <rect x="0" y="0" width="${card.w}" height="${card.h}" rx="${card.r}" ry="${card.r}" fill="url(#g)"/>
  <rect x="${Math.round(card.w * 0.1)}" y="${Math.round(card.h * 0.33)}" width="${Math.round(card.w * 0.15)}"
        height="${Math.round(card.h * 0.2)}" rx="4" fill="#d9b44a"/>
  <text x="${Math.round(card.w * 0.1)}" y="${Math.round(card.h * 0.22)}" font-family="Helvetica, Arial, sans-serif"
        font-weight="700" font-size="${Math.round(card.h * 0.11)}" fill="#ffffff">SAMPLE CARD</text>
  <text x="${Math.round(card.w * 0.1)}" y="${Math.round(card.h * 0.72)}" font-family="Courier, monospace"
        font-size="${Math.round(card.h * 0.1)}" fill="#ffffff">0000 0000 0000 0000</text>
  <text x="${Math.round(card.w * 0.1)}" y="${Math.round(card.h * 0.9)}" font-family="Helvetica, Arial, sans-serif"
        font-size="${Math.round(card.h * 0.07)}" fill="#e8f4fa">SYNTHETIC FIXTURE</text>
</svg>`;

const portrait = await sharp(BACKGROUND).rotate().toBuffer();
const meta = await sharp(portrait).metadata();
// Empty table below the plate: bottom band, left part, cropped to 16:9.
const bandH = 1212;
const region = { left: 0, top: meta.height - bandH, width: Math.round((bandH * 16) / 9), height: bandH };
const background = await sharp(portrait).extract(region).resize(FRAME_W, FRAME_H).toBuffer();

const jpeg = await sharp(background)
  .composite([{ input: Buffer.from(cardSvg), left, top }])
  .jpeg({ quality: 92 })
  .toBuffer();

// Exact rounded-rectangle area in raw frame pixels.
const areaRaw = card.w * card.h - (4 - Math.PI) * card.r * card.r;
const side = Math.min(FRAME_W, FRAME_H);
const scale = NORMALIZED / side;
const areaNormalized = areaRaw * scale * scale;
const k = KNOWN_AREA_CM2 / areaNormalized;
const fNormalized = fNative * scale; // center crop keeps the principal point and focal length, resize scales them

const sidecar = {
  synthetic: true,
  description:
    'SYNTHETIC calibration fixture: a drawn credit-card-sized rectangle on an empty table patch from test2/IMG_2704.jpeg. Not a camera photo.',
  generator: 'capture/scripts/make-calibration-fixture.mjs',
  background: { file: 'test2/IMG_2704.jpeg', exifRotated: true, region, resizedTo: [FRAME_W, FRAME_H] },
  frame: { widthPx: FRAME_W, heightPx: FRAME_H },
  reference: {
    label: 'credit card',
    knownAreaCm2: KNOWN_AREA_CM2,
    physicalMm: CARD_MM,
    drawnPx: { left, top, width: card.w, height: card.h, cornerRadius: card.r },
    areaRawPx: Number(areaRaw.toFixed(1)),
  },
  design: { cameraHeightCm: DESIGN_HEIGHT_CM, fxNativePx: Number(fNative.toFixed(2)), intrinsicsSource: 'nominal-fov' },
  normalized: {
    coordinateSpace: 'topdown-normalized-v1',
    widthPx: NORMALIZED,
    heightPx: NORMALIZED,
    cropLeftPx: Math.floor((FRAME_W - side) / 2),
    scale: Number(scale.toFixed(6)),
    expectedReferencePixels: Math.round(areaNormalized),
    expectedCm2PerPx: Number(k.toPrecision(6)),
    fxPx: Number(fNormalized.toFixed(2)),
    expectedCameraHeightCmGeometric: Number((fNormalized * Math.sqrt(k)).toFixed(2)),
    note:
      'Expected values assume SAM segments the drawn card exactly; JPEG edges and segmentation move N_ref by a few percent. ' +
      'If intrinsics are scaled by width alone (1360 × 1024/1920) instead of the crop-aware 1360 × 1024/1080, the geometric height comes out ≈ 0.56× too low.',
  },
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(path.join(OUT_DIR, 'credit-card-synthetic.jpg'), jpeg);
writeFileSync(path.join(OUT_DIR, 'credit-card-synthetic.json'), `${JSON.stringify(sidecar, null, 2)}\n`);
console.log(
  `Wrote capture/fixtures/calibration/credit-card-synthetic.jpg (${(jpeg.byteLength / 1024).toFixed(0)} KB): card ${card.w}×${card.h} px r${card.r}, ` +
    `N_ref ≈ ${Math.round(areaNormalized)} px at 1024², k ≈ ${k.toPrecision(4)} cm²/px, height ≈ ${(fNormalized * Math.sqrt(k)).toFixed(1)} cm`,
);
