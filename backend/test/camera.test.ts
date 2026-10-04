/**
 * Dashboard "Take photo" (POST /api/camera/take-photo) with the capture
 * script replaced by a fake runner: no board, no SSH.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpError } from '../src/errors.js';
import { CameraService, type ScriptRunner } from '../src/services/cameraService.js';

const ENV = { CAMERA_HOST: '35.1.88.76', CAMERA_USER: 'arduino' };
const OK = { ok: true, eventId: 'cap_1', serviceId: 'svc_1', state: 'succeeded', triggeredAt: 't0', receivedAt: 't1' };

function service(run: ScriptRunner, env: NodeJS.ProcessEnv = ENV) {
  return new CameraService('http://127.0.0.1:8787', env, run, () => true);
}

async function httpError(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof HttpError);
    return err;
  }
  assert.fail('expected an HttpError');
}

test('not configured: 503 with what to set; status says so', async () => {
  const cam = service(async () => assert.fail('must not run'), {});
  assert.deepEqual(cam.status(), { configured: false, busy: false });
  const err = await httpError(cam.takePhoto({}));
  assert.equal(err.status, 503);
  assert.equal(err.apiError.code, 'CAMERA_NOT_CONFIGURED');
});

test('runs the same take-photo script with --json and this server as API_URL', async () => {
  let seen: { args: string[]; env: NodeJS.ProcessEnv } | undefined;
  const cam = service(async (args, env) => {
    seen = { args, env };
    return { code: 0, stdout: `Taking…\n${JSON.stringify(OK)}\n`, stderr: '' };
  });
  assert.deepEqual(await cam.takePhoto({ serviceId: 'svc_1' }), OK);
  assert.deepEqual(seen!.args, ['--json', '--service', 'svc_1']);
  assert.equal(seen!.env.API_URL, 'http://127.0.0.1:8787');
  assert.equal(seen!.env.SCRAP_API_URL, 'http://127.0.0.1:8787');
  assert.equal(seen!.env.CAMERA_HOST, '35.1.88.76');
});

test('script failures become clear API errors by stage', async () => {
  const fail = (stage: string, error: string): ScriptRunner => async () => ({ code: 1, stdout: JSON.stringify({ ok: false, stage, error }), stderr: '' });
  const ssh = await httpError(service(fail('ssh', 'Key login was refused.')).takePhoto({}));
  assert.equal(ssh.status, 503);
  assert.equal(ssh.apiError.message, 'Key login was refused.');
  assert.deepEqual(ssh.apiError.details, { stage: 'ssh' });
  assert.equal((await httpError(service(fail('service', 'No meal now; pass --service.')).takePhoto({}))).status, 400);
  const garbage = await httpError(service(async () => ({ code: 1, stdout: '', stderr: 'boom' })).takePhoto({}));
  assert.equal(garbage.status, 502);
  assert.match(garbage.apiError.message, /boom/);
});

test('one capture at a time', async () => {
  let release!: () => void;
  const cam = service(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ code: 0, stdout: JSON.stringify(OK), stderr: '' });
      }),
  );
  const first = cam.takePhoto({});
  assert.equal(cam.status().busy, true);
  const second = await httpError(cam.takePhoto({}));
  assert.equal(second.status, 409);
  assert.equal(second.apiError.code, 'CAMERA_BUSY');
  release();
  await first;
  assert.equal(cam.status().busy, false);
});
