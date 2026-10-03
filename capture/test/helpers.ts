/** Shared test helpers: temp fixture images and manifests built at runtime. */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

import type { ReplayManifest } from '../src/manifest.js';

export async function makeFixtureDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'scrap-capture-test-'));
}

/** Write a small solid-color JPEG (default 300x200) and return its path. */
export async function makeJpeg(
  dir: string,
  name: string,
  width = 300,
  height = 200,
  rgb: [number, number, number] = [200, 80, 40],
): Promise<string> {
  const file = path.join(dir, name);
  await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: rgb[0], g: rgb[1], b: rgb[2] },
    },
  })
    .jpeg({ quality: 90 })
    .toFile(file);
  return file;
}

/** Write arbitrary bytes to a file and return its path. */
export async function makeFile(dir: string, name: string, bytes: Uint8Array | string): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, bytes);
  return file;
}

/** Write a manifest JSON next to the images and return its path. */
export async function writeManifest(dir: string, manifest: ReplayManifest): Promise<string> {
  const file = path.join(dir, 'manifest.json');
  await writeFile(file, JSON.stringify(manifest, null, 2));
  return file;
}

export const HALL = 'hall-main';
export const SERVICE = 'svc_hall-main_2026-10-03_lunch';
