/**
 * Camera access without the board: SSH is replaced by a fake CommandRunner
 * that answers like the Uno Q (v4l2-ctl listing, laptop_capture.py saving a
 * verified capture), so take-photo's logic runs end to end offline.
 */

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import {
  CameraConfigError,
  type CommandRunner,
  explainSshFailure,
  findCameraDevice,
  loadCameraConfig,
  parseV4l2Devices,
  pickCameraNode,
  sshArgs,
  takePhoto,
} from '../src/camera.js';
import { localDateTime, parseMealWindows, resolveServiceAt } from '../src/mealService.js';
import { makeFixtureDir, makeJpeg } from './helpers.js';

const ENV = { CAMERA_HOST: '35.1.88.76', CAMERA_USER: 'arduino', CAMERA_SSH_KEY: '/keys/scrap_unoq' };

// Real layout of `v4l2-ctl --list-devices` on the Uno Q with a C920 attached.
const V4L2_LIST = `qcom-venus (platform:qcom-venus):
\t/dev/video32
\t/dev/video33

HD Pro Webcam C920 (usb-xhci-hcd.1.auto-1.2):
\t/dev/video0
\t/dev/video1
\t/dev/media0
`;

const ok = (stdout: string) => ({ code: 0, stdout: Buffer.from(stdout), stderr: '', timedOut: false });

test('config comes from .env; missing host or user is named', () => {
  const config = loadCameraConfig(ENV);
  assert.equal(config.host, '35.1.88.76');
  assert.equal(config.keyPath, '/keys/scrap_unoq');
  assert.equal(config.deviceName, 'C920');
  assert.equal(config.widthPx, 1920);
  assert.throws(() => loadCameraConfig({ CAMERA_USER: 'arduino' }), (e: unknown) => e instanceof CameraConfigError && /CAMERA_HOST/.test(e.message));
  assert.throws(() => loadCameraConfig({ ...ENV, CAMERA_HOST: 'host; rm -rf /' }), CameraConfigError);
});

test('SSH is key-only and never prompts', () => {
  const args = sshArgs(loadCameraConfig(ENV), 'true');
  const opts = args.join(' ');
  for (const o of ['BatchMode=yes', 'IdentitiesOnly=yes', 'PasswordAuthentication=no', 'KbdInteractiveAuthentication=no', 'ConnectTimeout=5']) {
    assert.ok(opts.includes(o), o);
  }
  assert.deepEqual(args.slice(-2), ['arduino@35.1.88.76', 'true']);
  assert.ok(args.includes('/keys/scrap_unoq'));
});

test('the C920 capture node is picked by name, not by number', async () => {
  const devices = parseV4l2Devices(V4L2_LIST);
  assert.deepEqual(devices.map((d) => d.name), ['qcom-venus (platform:qcom-venus)', 'HD Pro Webcam C920 (usb-xhci-hcd.1.auto-1.2)']);
  assert.equal(pickCameraNode(devices, 'C920'), '/dev/video0');
  assert.equal(pickCameraNode(devices, 'c920'), '/dev/video0');
  assert.equal(pickCameraNode(devices, 'Brio'), undefined);

  const run: CommandRunner = async (cmd, args) => {
    assert.equal(cmd, 'ssh');
    assert.equal(args.at(-1), 'v4l2-ctl --list-devices');
    return ok(V4L2_LIST.replace('/dev/video0\n\t/dev/video1', '/dev/video2\n\t/dev/video3'));
  };
  assert.equal(await findCameraDevice(run, loadCameraConfig(ENV)), '/dev/video2');
  // An explicit CAMERA_DEVICE skips detection entirely.
  assert.equal(await findCameraDevice(async () => assert.fail('no ssh'), loadCameraConfig({ ...ENV, CAMERA_DEVICE: '/dev/video4' })), '/dev/video4');
});

test('a missing camera and a refused key give actionable errors', async () => {
  const config = loadCameraConfig(ENV);
  await assert.rejects(findCameraDevice(async () => ok('qcom-venus (platform:x):\n\t/dev/video32\n'), config), /No camera named "C920".*powered USB-C hub/);
  const denied = { code: 255, stdout: Buffer.alloc(0), stderr: 'arduino@35.1.88.76: Permission denied (publickey,password).', timedOut: false };
  await assert.rejects(findCameraDevice(async () => denied, config), /ssh-copy-id -i \/keys\/scrap_unoq\.pub arduino@35\.1\.88\.76/);
  assert.match(explainSshFailure({ ...denied, stderr: 'ssh: connect to host 35.1.88.76 port 22: Operation timed out' }, config), /Cannot reach 35\.1\.88\.76/);
  assert.match(explainSshFailure({ ...denied, timedOut: true }, config), /timed out/);
});

/** Fake board: v4l2 listing, then laptop_capture.py "saves" a capture like the real one. */
function fakeBoard(photo: Buffer, options: { tamper?: boolean } = {}): { run: CommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: CommandRunner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'ssh') return ok(V4L2_LIST);
    const out = args[args.indexOf('--out') + 1]!;
    const captureId = randomUUID();
    const dir = path.join(out, captureId);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'photo.jpg'), options.tamper ? Buffer.concat([photo, Buffer.from([0])]) : photo);
    await writeFile(
      path.join(dir, 'metadata.json'),
      JSON.stringify({
        protocolVersion: 1,
        captureId,
        capturedAt: '2020-01-01T00:00:00Z', // a wrong board clock must not leak into the scan time
        widthPx: 1920,
        heightPx: 1080,
        byteLength: photo.byteLength,
        sha256: createHash('sha256').update(photo).digest('hex'),
      }),
    );
    return ok(`Requesting ${captureId} ...\nSaved: ${path.join(dir, 'photo.jpg')}\n`);
  };
  return { run, calls };
}

test('takePhoto: key-only capture on the detected node, verified, stamped with this computer\'s clock', async () => {
  const dir = await makeFixtureDir();
  const photo = await readFile(await makeJpeg(dir, 'board.jpg', 1920, 1080));
  const { run, calls } = fakeBoard(photo);
  const times = ['2026-10-04T16:00:00.000Z', '2026-10-04T16:00:03.000Z'];
  const taken = await takePhoto({
    config: loadCameraConfig(ENV),
    outDir: path.join(dir, 'out'),
    laptopCaptureScript: 'capture/uno-q/laptop_capture.py',
    run,
    clock: () => new Date(times.shift()!),
  });
  assert.equal(taken.device, '/dev/video0');
  assert.equal(taken.triggeredAt, '2026-10-04T16:00:00.000Z');
  assert.equal(taken.receivedAt, '2026-10-04T16:00:03.000Z');
  assert.equal(taken.boardCapturedAt, '2020-01-01T00:00:00Z');
  assert.equal(taken.sha256, createHash('sha256').update(photo).digest('hex'));
  const capture = calls[1]!;
  assert.equal(capture[0], 'python3');
  for (const [flag, value] of [['--identity', '/keys/scrap_unoq'], ['--device', '/dev/video0'], ['--target', 'arduino@35.1.88.76'], ['--width', '1920']]) {
    assert.equal(capture[capture.indexOf(flag!) + 1], value, flag);
  }
  assert.ok(capture.includes('--once') && !capture.includes('--password'));
});

test('takePhoto: a photo that does not match the board\'s SHA-256 is rejected', async () => {
  const dir = await makeFixtureDir();
  const photo = await readFile(await makeJpeg(dir, 'board.jpg'));
  const { run } = fakeBoard(photo, { tamper: true });
  await assert.rejects(
    takePhoto({ config: loadCameraConfig(ENV), outDir: path.join(dir, 'out'), laptopCaptureScript: 'x.py', run }),
    /does not match the SHA-256/,
  );
});

test('meal service from the computer\'s clock in the hall\'s timezone', () => {
  const windows = parseMealWindows();
  const svc = (meal: string, date = '2026-10-04') => ({
    serviceId: `svc_hall-main_${date}_${meal}`, hallId: 'hall-main', hallTimezone: 'America/Detroit', serviceDate: date, mealLabel: meal,
  });
  const services = [svc('breakfast'), svc('lunch'), svc('dinner'), svc('dinner', '2026-10-03')];
  // 17:30 UTC = 13:30 in Detroit (EDT): lunch.
  const lunch = resolveServiceAt(services, new Date('2026-10-04T17:30:00Z'), { hallId: 'hall-main', windows });
  assert.ok(lunch.ok && lunch.service.serviceId === 'svc_hall-main_2026-10-04_lunch');
  // 02:00 UTC on the 4th = 22:00 on the 3rd in Detroit: the 3rd's dinner.
  const dinner = resolveServiceAt(services, new Date('2026-10-04T02:00:00Z'), { hallId: 'hall-main', windows });
  assert.ok(dinner.ok && dinner.service.serviceId === 'svc_hall-main_2026-10-03_dinner');
  const night = resolveServiceAt(services, new Date('2026-10-04T07:30:00Z'), { hallId: 'hall-main', windows });
  assert.ok(!night.ok && /pass --service/.test(night.reason));
  assert.deepEqual(localDateTime(new Date('2026-10-04T03:59:00Z'), 'America/Detroit'), { date: '2026-10-03', time: '23:59' });
  assert.throws(() => parseMealWindows('lunch=12:00-11:00'), /ends before/);
  assert.throws(() => parseMealWindows('brunch=10:00-11:00'), /must look like/);
});
