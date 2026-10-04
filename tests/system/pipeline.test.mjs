/**
 * Integration (no board, no Gemini, no SAM, no network): the real backend,
 * ingest path, storage and repository code, with Gemini and SAM replaced by
 * offline fakes and the camera reached through a fake `ssh`.
 *
 *   cd tests && npm run test:integration
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DATE,
  HALL,
  REPO,
  SERVICE,
  backend,
  boxFillerSam,
  demoPortions,
  dinnerMenu,
  fakeGemini,
  httpAdapter,
  startBackend,
  sumScanRows,
  test2Photos,
} from '../support/stack.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');

async function offlineStack() {
  const gemini = fakeGemini();
  const sam = boxFillerSam();
  const s = await startBackend({ analyzer: new backend.maskAnalyzer.MaskAnalyzer(gemini.gateway, sam) });
  const menu = dinnerMenu();
  await s.repo.upsertMenu(menu);
  await s.repo.replacePortionsServed(SERVICE, 1, demoPortions(menu));
  return { s, menu, gemini, sam };
}

describe('simulated device: every test2/ photo through the real ingest function', () => {
  let ctx;
  let photos;
  let results;
  before(async () => {
    ctx = await offlineStack();
    photos = await test2Photos();
    const { adapter } = httpAdapter(ctx.s.baseUrl);
    results = [];
    for (const photo of photos) {
      results.push(
        await adapter.ingestPhoto({
          photoPath: photo,
          captureKey: `it:${path.basename(photo)}`,
          capturedAt: new Date().toISOString(),
          timestampBasis: 'laptop_ingest',
          hallId: HALL,
          serviceId: SERVICE,
          source: 'replay',
          deviceId: 'simulated:test2',
          sourceName: path.basename(photo),
        }),
      );
    }
  });
  after(() => ctx?.s.close());

  it('each photo becomes one completed scan with raw original, normalized image, overlay and scan row', async () => {
    assert.ok(photos.length >= 13, `test2/ has ${photos.length} photos`);
    const failures = results.filter((r) => !r.ok).map((r) => `${r.entryId}: ${r.error.code} ${r.error.message}`);
    assert.deepEqual(failures, []);
    for (const [i, r] of results.entries()) {
      const event = await ctx.s.repo.getCaptureEvent(r.event.eventId);
      assert.equal(event.state, 'succeeded', path.basename(photos[i]));
      assert.equal(event.source, 'replay');
      const scan = await ctx.s.repo.getScanInfo(r.event.eventId);
      assert.equal(scan.deviceId, 'simulated:test2');
      assert.equal(scan.sourceName, path.basename(photos[i]));
      assert.equal(scan.originalSha256, sha(readFileSync(photos[i])));
      // The raw original in storage is byte-for-byte the photo.
      const original = await ctx.s.repo.getImageObject(scan.originalImageObjectId);
      assert.equal(original.association.kind, 'original');
      const { bytes } = await ctx.s.storage.getObjectBytes(original.objectKey);
      assert.equal(sha(bytes), scan.originalSha256);
      const images = await ctx.s.api('GET', `/api/captures/${r.event.eventId}/images`);
      assert.ok(images.json.raw && images.json.original && images.json.overlay, 'raw, normalized and overlay are signed');
      assert.ok(images.json.masks.length >= 1);
      const measurements = await ctx.s.repo.listMeasurementsByEvent(r.event.eventId);
      assert.ok(measurements.length >= 1 && measurements.every((m) => m.method === 'mask_pixel_count' && m.remainingAreaPx > 0));
    }
  });

  it('re-sending the same photo with the same retry key adds no scan and uploads nothing', async () => {
    // The retry key lives in the caller's state file (take-photo/bridge keep one).
    const { adapter } = httpAdapter(ctx.s.baseUrl, path.join(mkdtempSync(path.join(tmpdir(), 'state-')), 's.json'));
    const input = { photoPath: photos[0], captureKey: 'it:retry', capturedAt: new Date().toISOString(), timestampBasis: 'laptop_ingest', hallId: HALL, serviceId: SERVICE, source: 'replay', deviceId: 'simulated:test2' };
    const first = await adapter.ingestPhoto(input);
    const scans = (await ctx.s.repo.listCaptureEvents({ serviceId: SERVICE })).length;
    const objects = (await ctx.s.repo.listImageObjects()).length;
    const retry = await adapter.ingestPhoto(input);
    assert.ok(first.ok && retry.ok && retry.alreadyIngested);
    assert.equal(retry.event.eventId, first.event.eventId);
    assert.equal((await ctx.s.repo.listCaptureEvents({ serviceId: SERVICE })).length, scans);
    assert.equal((await ctx.s.repo.listImageObjects()).length, objects);
  });

  it('dashboard endpoints: totals equal the sum of the scan rows', async () => {
    const rows = await sumScanRows(ctx.s.repo, { hallId: HALL, start: DATE, end: DATE });
    const impact = await ctx.s.api('GET', `/api/dashboard/impact?hallId=${HALL}&start=${DATE}&end=${DATE}`);
    assert.equal(impact.status, 200);
    assert.equal(impact.json.totals.pixels, rows.pixels);
    assert.equal(impact.json.totals.analyzedCaptures, rows.plates);
    const itemSum = impact.json.mostWasted.reduce((s, r) => s + r.impact.pixels, 0);
    assert.equal(itemSum, rows.pixels, 'per-food rows add up to the total');
    for (const r of impact.json.mostWasted) {
      if (r.impact.impactPoints === null) continue;
      // Waste Impact points = 0.19 x CO2 points + 1.50 x water points; nutrition is never in it.
      const expected = 0.19 * r.impact.co2Points + 1.5 * r.impact.waterPoints;
      assert.ok(Math.abs(r.impact.impactPoints - expected) <= Math.max(0.02, expected * 0.002), `${r.displayName}: ${r.impact.impactPoints} vs ${expected}`);
    }
    const totals = await ctx.s.api('GET', `/api/dashboard/totals?hallId=${HALL}&today=${DATE}`);
    assert.equal(totals.json.today.pixels, rows.pixels);
    const daily = await ctx.s.api('GET', `/api/dashboard/daily?hallId=${HALL}&start=${DATE}&end=${DATE}`);
    assert.equal(daily.json.days[0].pixelsWasted, rows.pixels);
    const list = await ctx.s.api('GET', `/api/captures?hallId=${HALL}&start=${DATE}&end=${DATE}&limit=200`);
    const listed = (Array.isArray(list.json) ? list.json : list.json.captures).filter((c) => c.state === 'succeeded');
    assert.equal(listed.reduce((s, c) => s + c.pixelsWasted, 0), rows.pixels);
  });
});

// --- mocked SSH: the real take-photo script, laptop_capture.py and board script; only ssh + ffmpeg are fakes ---

const FAKE_SSH = `#!/usr/bin/env python3
import json, os, shlex, subprocess, sys
args = sys.argv[1:]
with open(os.environ["FAKE_SSH_LOG"], "a") as log:
    log.write(json.dumps(args) + "\\n")
assert "BatchMode=yes" in args, "SSH must run with BatchMode=yes"
i = 0
while args[i].startswith("-"):
    i += 2 if args[i] in ("-i", "-o") else 1
remote = args[i + 1]
if remote == "v4l2-ctl --list-devices":
    print("qcom-venus (platform:qcom-venus):\\n\\t/dev/video32\\n\\nHD Pro Webcam C920 (usb-xhci-hcd.1.auto-1.2):\\n\\t/dev/video2\\n\\t/dev/video3\\n\\t/dev/media0\\n")
    sys.exit(0)
words = shlex.split(remote)
prefix = ["timeout", "--signal=TERM", "--kill-after=2s", "20s", "/usr/bin/python3"]
if words[:5] != prefix:
    sys.exit("fake ssh: unexpected remote command " + remote)
home = os.environ["FAKE_BOARD_HOME"]
result = subprocess.run([sys.executable] + words[5:], cwd=home, env=dict(os.environ, HOME=home), stdout=subprocess.PIPE)
sys.stdout.buffer.write(result.stdout)
sys.exit(result.returncode)
`;

const FAKE_FFMPEG = `#!/usr/bin/env python3
import json, os, signal, sys, time
with open(os.environ["FAKE_FFMPEG_LOG"], "a") as log:
    log.write(json.dumps(sys.argv[1:]) + "\\n")
signal.signal(signal.SIGPIPE, signal.SIG_DFL)
photo = open(os.environ["FAKE_CAMERA_JPEG"], "rb").read()
headers = b"--ffmpeg\\r\\nContent-type: image/jpeg\\r\\nContent-length: " + str(len(photo)).encode() + b"\\r\\n\\r\\n"
while True:
    sys.stdout.buffer.write(headers + photo + b"\\r\\n")
    sys.stdout.buffer.flush()
    time.sleep(0.02)
`;

function runNode(script, args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('mocked SSH capture: take-photo against a fake board (no board needed)', () => {
  let ctx;
  let rig;
  before(async () => {
    ctx = await offlineStack();
    const root = mkdtempSync(path.join(tmpdir(), 'fake-board-'));
    const bin = path.join(root, 'bin');
    const home = path.join(root, 'board-home');
    mkdirSync(bin);
    mkdirSync(path.join(home, 'scrap-camera'), { recursive: true });
    copyFileSync(path.join(REPO, 'capture/uno-q/uno_q_camera.py'), path.join(home, 'scrap-camera/uno_q_camera.py'));
    writeFileSync(path.join(bin, 'ssh'), FAKE_SSH);
    writeFileSync(path.join(bin, 'ffmpeg'), FAKE_FFMPEG);
    chmodSync(path.join(bin, 'ssh'), 0o755);
    chmodSync(path.join(bin, 'ffmpeg'), 0o755);
    // A 1920x1080 "camera frame" made from a test2 photo.
    const { default: sharp } = await import(path.join(REPO, 'capture/node_modules/sharp/lib/index.js'));
    const [photo] = await test2Photos(1);
    const frame = path.join(root, 'frame.jpg');
    writeFileSync(frame, await sharp(photo).rotate().resize(1920, 1080, { fit: 'cover' }).jpeg({ quality: 85 }).toBuffer());
    const key = path.join(root, 'id_test');
    writeFileSync(key, 'not a real key');
    rig = { root, bin, home, frame, key, sshLog: path.join(root, 'ssh.log'), ffmpegLog: path.join(root, 'ffmpeg.log') };
  });
  after(() => ctx?.s.close());

  it('one command: SSH trigger on the C920 node, verified transfer, laptop-clock scan, full analysis', async () => {
    const t0 = Date.now();
    const env = {
      ...process.env,
      PATH: `${rig.bin}:${process.env.PATH}`,
      API_URL: ctx.s.baseUrl,
      CAMERA_HOST: '192.0.2.10',
      CAMERA_USER: 'arduino',
      CAMERA_SSH_KEY: rig.key,
      CAMERA_DEVICE: '',
      FAKE_SSH_LOG: rig.sshLog,
      FAKE_FFMPEG_LOG: rig.ffmpegLog,
      FAKE_BOARD_HOME: rig.home,
      FAKE_CAMERA_JPEG: rig.frame,
    };
    const out = await runNode(path.join(REPO, 'capture/scripts/take-photo.mjs'), [
      '--json', '--service', SERVICE, '--hall', HALL,
      '--out', path.join(rig.root, 'photos'), '--state', path.join(rig.root, 'state.json'),
    ], env);
    const line = out.stdout.trim().split('\n').at(-1);
    const result = JSON.parse(line || '{}');
    assert.equal(result.ok, true, `${out.stdout}\n${out.stderr}`);
    assert.equal(result.state, 'succeeded');
    assert.equal(result.device, '/dev/video2', 'C920 capture node picked by name');
    assert.ok(Date.parse(result.triggeredAt) >= t0 - 1000, 'scan time is this computer\'s clock');

    const ssh = readFileSync(rig.sshLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(ssh.length >= 2 && ssh.every((a) => a.includes('BatchMode=yes') && a.includes(rig.key)), 'every SSH call is key-only');
    assert.match(readFileSync(rig.ffmpegLog, 'utf8'), /\/dev\/video2/);

    const event = await ctx.s.repo.getCaptureEvent(result.eventId);
    assert.equal(event.source, 'camera');
    assert.equal(event.capturedAt, result.triggeredAt);
    const scan = await ctx.s.repo.getScanInfo(result.eventId);
    assert.equal(scan.timestampBasis, 'laptop_trigger');
    assert.equal(scan.deviceId, 'uno-q-c920');
    assert.equal(scan.originalSha256, sha(readFileSync(rig.frame)));
    const original = await ctx.s.repo.getImageObject(scan.originalImageObjectId);
    assert.deepEqual([original.widthPx, original.heightPx], [1920, 1080]);
  });

  it('a refused key fails fast with the ssh-copy-id command, nothing ingested', async () => {
    const denyBin = path.join(rig.root, 'deny');
    mkdirSync(denyBin, { recursive: true });
    writeFileSync(path.join(denyBin, 'ssh'), '#!/bin/sh\necho "arduino@192.0.2.10: Permission denied (publickey,password)." >&2\nexit 255\n');
    chmodSync(path.join(denyBin, 'ssh'), 0o755);
    const before = (await ctx.s.repo.listCaptureEvents({ serviceId: SERVICE })).length;
    const out = await runNode(path.join(REPO, 'capture/scripts/take-photo.mjs'), ['--json', '--service', SERVICE, '--hall', HALL, '--out', path.join(rig.root, 'p2'), '--state', path.join(rig.root, 's2.json')], {
      ...process.env,
      PATH: `${denyBin}:${process.env.PATH}`,
      API_URL: ctx.s.baseUrl,
      CAMERA_HOST: '192.0.2.10',
      CAMERA_USER: 'arduino',
      CAMERA_SSH_KEY: rig.key,
      CAMERA_DEVICE: '',
    });
    const result = JSON.parse(out.stdout.trim().split('\n').at(-1));
    assert.equal(result.ok, false);
    assert.match(result.error, /ssh-copy-id -i .*id_test\.pub arduino@192\.0\.2\.10/);
    assert.equal((await ctx.s.repo.listCaptureEvents({ serviceId: SERVICE })).length, before);
  });
});
