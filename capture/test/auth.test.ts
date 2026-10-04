/**
 * Remote backend + ingest token (IT_4 I11): SCRAP_API_URL resolution, the
 * Authorization header on backend requests (never on a presigned storage PUT
 * to another origin), and a plain-language 401. Local HTTP servers only.
 */

import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';

import { authHeaders, defaultTokenFiles, describeBackend, readEnvFile, resolveBackend } from '../src/backendConfig.js';
import { BackendRequestError, HttpCalibrationClient, HttpIngestionSink, HttpUploader } from '../src/http.js';
import type { CaptureEvent } from '../src/contract-types.js';

const TOKEN = 'tok_secret_value_123';

interface Seen {
  method: string;
  url: string;
  authorization: string | undefined;
  body: string;
}

async function listen(handler: (req: IncomingMessage, body: string) => { status: number; json?: unknown }) {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, authorization: req.headers.authorization, body });
      const out = handler(req, body);
      res.writeHead(out.status, { 'Content-Type': 'application/json' });
      res.end(out.json === undefined ? '' : JSON.stringify(out.json));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('resolveBackend: SCRAP_API_URL wins over API_URL, default localhost:8787', () => {
  assert.equal(resolveBackend({}).apiUrl, 'http://localhost:8787');
  assert.equal(resolveBackend({ API_URL: 'http://old:1/' }).apiUrl, 'http://old:1');
  assert.equal(resolveBackend({ API_URL: 'http://old:1', SCRAP_API_URL: 'https://scrap.example/' }).apiUrl, 'https://scrap.example');
  assert.throws(() => resolveBackend({ SCRAP_API_URL: 'ftp://x' }), /http\(s\)/);
  assert.throws(() => resolveBackend({ SCRAP_API_URL: 'not a url' }), /not a URL/);
});

test('resolveBackend: token from SCRAP_INGEST_TOKEN or --token-env, with warnings', () => {
  assert.equal(resolveBackend({ SCRAP_INGEST_TOKEN: TOKEN }).token, TOKEN);
  assert.equal(resolveBackend({ MY_TOKEN: TOKEN }, 'MY_TOKEN').token, TOKEN);
  assert.equal(resolveBackend({ SCRAP_INGEST_TOKEN: '  ' }).token, undefined);
  assert.throws(() => resolveBackend({}, 'bad name'), /--token-env/);
  // Remote https without a token: warn that uploads will be refused.
  assert.match(resolveBackend({ SCRAP_API_URL: 'https://scrap.example' }).warnings.join(), /401/);
  // Token over plain http to a remote host: warn.
  assert.match(
    resolveBackend({ SCRAP_API_URL: 'http://scrap.example', SCRAP_INGEST_TOKEN: TOKEN }).warnings.join(),
    /unencrypted/,
  );
  assert.deepEqual(resolveBackend({ SCRAP_INGEST_TOKEN: TOKEN }).warnings, []);
});

test('token falls back to .env, then deploy/.run/local-secrets.env; the environment wins', async () => {
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const repo = await mkdtemp(path.join(tmpdir(), 'scrap-token-'));
  await mkdir(path.join(repo, 'deploy', '.run'), { recursive: true });
  const files = defaultTokenFiles(repo);
  await writeFile(files[1]!, `SCRAP_INGEST_TOKEN=from_secrets\n`);
  let config = resolveBackend({}, undefined, files);
  assert.equal(config.token, 'from_secrets');
  assert.match(describeBackend(config), /deploy\/\.run\/local-secrets\.env/);
  await writeFile(files[0]!, `# comment\nOTHER=1\nexport SCRAP_INGEST_TOKEN="from_dotenv"\n`);
  config = resolveBackend({}, undefined, files);
  assert.equal(config.token, 'from_dotenv');
  assert.doesNotMatch(describeBackend(config), /from_dotenv/);
  assert.equal(resolveBackend({ SCRAP_INGEST_TOKEN: 'from_env' }, undefined, files).token, 'from_env');
  assert.equal(readEnvFile(path.join(repo, 'missing.env'), 'X'), undefined);
});

test('describeBackend and warnings never contain the token', () => {
  const config = resolveBackend({ SCRAP_API_URL: 'http://scrap.example', SCRAP_INGEST_TOKEN: TOKEN });
  assert.doesNotMatch(describeBackend(config), new RegExp(TOKEN));
  assert.match(describeBackend(config), /token from SCRAP_INGEST_TOKEN/);
  assert.doesNotMatch(config.warnings.join(), new RegExp(TOKEN));
  assert.deepEqual(authHeaders(undefined), {});
  assert.deepEqual(authHeaders(TOKEN), { Authorization: `Bearer ${TOKEN}` });
});

test('uploader + sink send the bearer token to the backend, never to presigned storage on another origin', async () => {
  const storage = await listen(() => ({ status: 200 }));
  const backend = await listen((req) => {
    if (req.url === '/api/images/uploads') {
      const n = backend.seen.filter((s) => s.url === '/api/images/uploads').length;
      // First upload goes to "R2" (another origin), the second to the local-dev route.
      return n === 1
        ? { status: 201, json: { objectId: 'img_r2', uploadUrl: `${storage.url}/bucket/key?X-Amz-Signature=abc` } }
        : { status: 201, json: { objectId: 'img_local', uploadUrl: '/api/images/img_local/content' } };
    }
    if (req.url?.startsWith('/api/images/')) return { status: 200, json: {} };
    if (req.url === '/api/captures') return { status: 201, json: { event: { state: 'pending' } } };
    return { status: 404, json: { error: { code: 'ROUTE_NOT_FOUND', message: 'no', retryable: false } } };
  });
  try {
    const uploader = new HttpUploader(backend.url, { token: TOKEN });
    const request = { mimeType: 'image/jpeg', sizeBytes: 3, widthPx: 1024, heightPx: 1024, association: { kind: 'capture' as const, id: 'cap_1' } };
    for (let i = 0; i < 2; i++) {
      const auth = await uploader.authorizeUpload(request);
      await uploader.uploadBytes(auth, new Uint8Array([1, 2, 3]));
      await uploader.finalizeUpload(auth);
    }
    await new HttpIngestionSink(backend.url, { token: TOKEN }).submitCaptureEvent({ eventId: 'cap_1' } as CaptureEvent);

    for (const s of backend.seen) assert.equal(s.authorization, `Bearer ${TOKEN}`, `${s.method} ${s.url}`);
    assert.ok(backend.seen.some((s) => s.method === 'PUT' && s.url === '/api/images/img_local/content'));
    assert.equal(storage.seen.length, 1);
    assert.equal(storage.seen[0]!.method, 'PUT');
    assert.equal(storage.seen[0]!.authorization, undefined, 'token must not reach object storage');
  } finally {
    await storage.close();
    await backend.close();
  }
});

test('without a token no Authorization header is sent', async () => {
  const backend = await listen(() => ({ status: 201, json: { event: { state: 'pending' } } }));
  try {
    await new HttpIngestionSink(backend.url).submitCaptureEvent({ eventId: 'cap_1' } as CaptureEvent);
    assert.equal(backend.seen[0]!.authorization, undefined);
  } finally {
    await backend.close();
  }
});

test('401 becomes a plain-language error that names SCRAP_INGEST_TOKEN, not the token', async () => {
  const backend = await listen(() => ({
    status: 401,
    json: { error: { code: 'UNAUTHORIZED', message: 'Sign in first.', retryable: false } },
  }));
  try {
    const sink = new HttpIngestionSink(backend.url, { token: TOKEN });
    await assert.rejects(sink.submitCaptureEvent({ eventId: 'cap_1' } as CaptureEvent), (err: unknown) => {
      assert.ok(err instanceof BackendRequestError);
      assert.equal(err.status, 401);
      assert.ok(err.unauthorized);
      assert.match(err.message, /SCRAP_INGEST_TOKEN/);
      assert.doesNotMatch(err.message, new RegExp(TOKEN));
      return true;
    });
    const calibrations = new HttpCalibrationClient(backend.url, { token: TOKEN });
    await assert.rejects(calibrations.getCalibration('cal_1'), /needs an ingest token/);
  } finally {
    await backend.close();
  }
});

test('calibration client: POST body, wrapped or bare responses, settings 404 vs missing route', async () => {
  const backend = await listen((req) => {
    if (req.method === 'POST' && req.url === '/api/calibrations') {
      return { status: 201, json: { calibration: { calibrationId: 'cal_1', status: 'succeeded' } } };
    }
    if (req.url === '/api/calibrations/cal_1') return { status: 200, json: { calibrationId: 'cal_1', status: 'succeeded' } };
    if (req.url === '/api/settings/measurement?hallId=hall-new') {
      return { status: 404, json: { error: { code: 'SETTINGS_NOT_FOUND', message: 'none', retryable: false } } };
    }
    return { status: 404, json: { error: { code: 'ROUTE_NOT_FOUND', message: 'no', retryable: false } } };
  });
  try {
    const client = new HttpCalibrationClient(backend.url, { token: TOKEN });
    const body = { hallId: 'hall-main', cameraId: 'uno-q-c920s-1', imageObjectId: 'img_1', knownAreaCm2: 46.21, referenceLabel: 'credit card' };
    assert.equal((await client.createCalibration(body)).calibrationId, 'cal_1');
    assert.deepEqual(JSON.parse(backend.seen[0]!.body), body);
    assert.equal((await client.getCalibration('cal_1')).status, 'succeeded');
    assert.equal(await client.getSettings('hall-new'), null);
    await assert.rejects(client.getSettings('hall-main'), /404/);
  } finally {
    await backend.close();
  }
});
