/**
 * Express app wiring every agreed endpoint (AGENTS.md 5.5). Every error —
 * validation, missing records, storage problems — is returned as the shared
 * ApiError envelope: { error: { code, message, details?, retryable } } with a
 * matching HTTP status. Temporary upload/read URLs appear only in responses,
 * never in logs.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { parseMenuCsv, parseMenuUpload, planMenuRevision, parsePortionsServed, parsePortionsCsv } from 'scrap-data';
import { HttpError, notFound, badRequest, toHttpError, apiError } from '../errors.js';
import type { BackendConfig } from '../config.js';
import type { Repository } from '../repo/repository.js';
import type { ObjectStorageAdapter } from '../storage/objectStorage.js';
import type { ImageService } from '../services/imageService.js';
import type { IngestionService } from '../services/ingestionService.js';
import type { SummaryService } from '../services/summaryService.js';
import type { DashboardService } from '../services/dashboardService.js';
import type { DishMatchService } from '../services/dishMatchService.js';
import type { CameraService } from '../services/cameraService.js';
import type { DemoService } from '../services/demoService.js';
import type { CaptureService } from '../services/captureService.js';
import { parseWindow, CAPTURE_LIST_DEFAULT_LIMIT, CAPTURE_LIST_MAX_LIMIT, type ImpactService } from '../services/impactService.js';
import type { MealLabel, MenuBundle } from '../types.js';
import type { ReadinessService } from '../services/readinessService.js';
import { validateCalibrationRequest, type CalibrationService } from '../services/calibrationService.js';
import { TryImageRejection, repoRoot, type TryImageService } from '../services/tryImageService.js';
import { log } from '../log.js';
import { readBuildInfo } from '../buildInfo.js';
import {
  authGate,
  issueSession,
  RateLimiter,
  rateLimit,
  readCookie,
  safeEqual,
  securityHeaders,
  sessionCookie,
  sessionNonce,
  SESSION_COOKIE,
  clientIp,
  type ResolvedSecurity,
} from './security.js';
import {
  validateAttendance,
  validateCaptureSubmission,
  validateInsight,
  validateMenuBundle,
  validateReferencePortion,
} from '../services/validation.js';

/** Routes READ_ONLY=1 refuses even for GET: they run Gemini/SAM or reach the camera. */
const READ_ONLY_BLOCKED = ['/api/try-image', '/api/camera'];

export interface AppDeps {
  config: BackendConfig;
  repo: Repository;
  storage: ObjectStorageAdapter;
  images: ImageService;
  ingestion: IngestionService;
  summary: SummaryService;
  dashboard: DashboardService;
  dishMatch: DishMatchService;
  captures: CaptureService;
  impact: ImpactService;
  /** IT_4 I11: resolved auth settings (buildBackend → assertSecurity). */
  security: ResolvedSecurity;
  readiness: ReadinessService;
  calibration: CalibrationService;
  now?: () => number;
  /** Origins the browser talks to directly (presigned object storage), for the CSP. */
  storageOrigins?: string[];
  /** Dashboard 'Take photo' (optional: tests and offline setups omit it). */
  camera?: CameraService;
  /** Sample history (DEMO_SEED); optional in tests. */
  demo?: DemoService;
  /** Public 'Try an Image' analyses (in memory only). */
  tryImage?: TryImageService;
}

export function createApp(deps: AppDeps): express.Express {
  const { config, repo, storage, images, ingestion, summary, dashboard, dishMatch, captures, impact, security, readiness, calibration } = deps;
  const now = deps.now ?? (() => Date.now());
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', security.trustProxy);
  app.use(securityHeaders({ production: security.production, storageOrigins: deps.storageOrigins ?? [] }));

  // Structured access log for API calls: path only (never the query string,
  // which can carry local-dev storage tokens), status, duration.
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api/')) return next();
    const start = Date.now();
    res.on('finish', () => {
      log.info('request', { method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - start });
    });
    next();
  });

  // READ_ONLY=1 (the public offsite site): reads only. Mutations, Try an Image
  // and the camera are refused before auth, so no token or session unlocks them.
  if (config.readOnly) {
    app.use((req, res, next) => {
      if (!req.path.startsWith('/api/')) return next();
      const write = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS';
      if (!write && !READ_ONLY_BLOCKED.some((prefix) => req.path === prefix || req.path.startsWith(`${prefix}/`))) return next();
      res.status(403).json({
        error: apiError('READ_ONLY', 'This site is read-only: it shows recorded data. Uploads and edits are turned off.', false),
      });
    });
  }

  // Every /api mutation needs the ingest token or an admin session (I11).
  const revoked = new Set<string>();
  app.use(authGate(security, now, revoked));
  app.use(express.json({ limit: security.jsonBodyLimit }));

  const limiter = new RateLimiter(now);
  // Gemini-cost endpoints: a modest per-IP cap; the trusted ingest token gets 10×.
  const geminiCap = rateLimit(
    limiter,
    'gemini',
    (_req, res) => (res.locals.principal === 'ingest' ? security.geminiRateLimit * 10 : security.geminiRateLimit),
    60_000,
  );
  const loginCap = rateLimit(limiter, 'login', () => security.loginRateLimit, 15 * 60_000);

  const wrap =
    (fn: (req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response, next: NextFunction) =>
      fn(req, res).catch(next);

  function param(req: Request, name: string): string {
    return req.params[name] ?? '';
  }

  /** The /api/storage routes exist only for the local-dev adapter; R2 uses presigned URLs. */
  function localDevOnly(path: string): HttpError {
    return notFound('ROUTE_NOT_FOUND', 'This API route does not exist.', { path });
  }

  function requireQuery(req: Request, name: string): string {
    const v = req.query[name];
    if (typeof v !== 'string' || v.length === 0) {
      throw badRequest('MISSING_PARAMETER', `Query parameter '${name}' is required.`, { name });
    }
    return v;
  }

  // ---- liveness / readiness ----
  const build = readBuildInfo();
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, provider: storage.provider, readOnly: Boolean(config.readOnly), ...build });
  });

  app.get(
    '/api/ready',
    wrap(async (_req, res) => {
      const report = await readiness.check();
      res.status(report.ready ? 200 : 503).json(report);
    }),
  );

  // ---- admin session (I11) ----
  app.post(
    '/api/auth/login',
    loginCap,
    wrap(async (req, res) => {
      if (!security.adminPasscode) {
        if (security.open) {
          res.json({ admin: true, authRequired: false });
          return;
        }
        throw new HttpError(503, apiError('AUTH_NOT_CONFIGURED', 'Admin sign-in is not set up on this server.', false));
      }
      const passcode = req.body?.passcode;
      if (typeof passcode !== 'string' || !safeEqual(passcode, security.adminPasscode)) {
        log.warn('admin login failed', { ip: clientIp(req) });
        throw new HttpError(401, apiError('INVALID_PASSCODE', 'That passcode is not correct.', false));
      }
      const session = issueSession(security, now());
      res.setHeader('Set-Cookie', sessionCookie(security, session.value, security.sessionTtlMs));
      res.json({ admin: true, authRequired: true, expiresAt: new Date(session.expiresAt).toISOString() });
    }),
  );

  app.post('/api/auth/logout', (req, res) => {
    const nonce = sessionNonce(readCookie(req, SESSION_COOKIE));
    if (nonce) revoked.add(nonce);
    res.setHeader('Set-Cookie', sessionCookie(security, '', 0));
    res.json({ admin: security.open, authRequired: !security.open });
  });

  app.get('/api/auth/me', (_req, res) => {
    const principal = res.locals.principal;
    res.json({ admin: principal === 'admin' || principal === 'open', authRequired: !security.open, readOnly: Boolean(config.readOnly) });
  });

  // ---- menus ----
  app.post(
    '/api/menus',
    wrap(async (req, res) => {
      const menu = validateMenuBundle(req.body);
      await repo.upsertMenu(menu);
      res.status(201).json({ menu });
    }),
  );

  app.get(
    '/api/menus',
    wrap(async (req, res) => {
      const hallId = requireQuery(req, 'hallId');
      const date = requireQuery(req, 'date');
      const meal = typeof req.query.meal === 'string' ? req.query.meal : undefined;
      const menus = await repo.findMenus(hallId, date, meal);
      if (menus.length === 0) {
        throw notFound('MENU_NOT_FOUND', 'No menu is saved for this hall and day yet. Add one in Menus.', {
          hallId,
          serviceDate: date,
          ...(meal ? { mealLabel: meal } : {}),
        });
      }
      res.json({ menus });
    }),
  );

  // Manager uploads (UI.md setup step 2): typed days or CSV, parsed by
  // Agent 2's helpers; re-uploads become numbered revisions (data/ planMenuRevision).
  async function saveParsedMenus(bundles: MenuBundle[]) {
    const results = [];
    for (const bundle of bundles) {
      const plan = planMenuRevision(await repo.getMenuByService(bundle.service.serviceId), bundle);
      if (plan.action !== 'unchanged') await repo.upsertMenu(plan.bundle);
      results.push({ action: plan.action, menu: plan.bundle });
    }
    return results;
  }

  app.post(
    '/api/menus/upload',
    wrap(async (req, res) => {
      res.status(201).json({ results: await saveParsedMenus(parseMenuUpload(req.body)) });
    }),
  );

  app.post(
    '/api/menus/csv',
    express.text({ type: ['text/csv', 'text/plain'], limit: '1mb' }),
    wrap(async (req, res) => {
      const hallId = requireQuery(req, 'hallId');
      const hallTimezone = requireQuery(req, 'hallTimezone');
      if (typeof req.body !== 'string') {
        throw badRequest('INVALID_CSV', 'Send the CSV file as text/csv.');
      }
      res.status(201).json({ results: await saveParsedMenus(parseMenuCsv(req.body, { hallId, hallTimezone })) });
    }),
  );

  /** Which local dates in [start, end] have at least one meal's menu (Menus calendar). */
  app.get(
    '/api/menus/days',
    wrap(async (req, res) => {
      const hallId = requireQuery(req, 'hallId');
      const start = requireQuery(req, 'start');
      const end = requireQuery(req, 'end');
      const dates = new Set(
        (await repo.listServices(hallId))
          .map((s) => s.serviceDate)
          .filter((d) => d >= start && d <= end),
      );
      res.json({ dates: [...dates].sort() });
    }),
  );

  app.get(
    '/api/menus/by-service/:serviceId',
    wrap(async (req, res) => {
      const menu = await repo.getMenuByService(param(req, 'serviceId'));
      if (!menu) {
        throw notFound('MENU_NOT_FOUND', 'No menu is saved for this service yet. Add one in Menus.', {
          serviceId: param(req, 'serviceId'),
        });
      }
      res.json({ menu });
    }),
  );

  app.get(
    '/api/services',
    wrap(async (req, res) => {
      const hallId = typeof req.query.hallId === 'string' ? req.query.hallId : undefined;
      res.json({ services: await repo.listServices(hallId) });
    }),
  );

  // ---- actual portions served (replacement snapshots) ----
  async function portionsMenu(req: Request): Promise<MenuBundle> {
    const serviceId = requireQuery(req, 'serviceId');
    const hallId = requireQuery(req, 'hallId');
    const menu = await repo.getMenuByService(serviceId);
    if (!menu || menu.service.hallId !== hallId) throw notFound('MENU_NOT_FOUND', 'No menu is saved for this hall and meal.');
    return menu;
  }

  app.get('/api/portions-served', wrap(async (req, res) => {
    const menu = await portionsMenu(req);
    res.json({ menu, portions: await repo.listPortionsServed(menu.service.serviceId, menu.service.menuVersion) });
  }));
  app.put('/api/portions-served', wrap(async (req, res) => {
    const menu = await portionsMenu(req);
    // `"source": "demo"` labels seeded dummy counts (BIG-PLAN D6, npm run seed);
    // anything else is a manager's manual entry.
    const source = req.body?.source === 'demo' ? 'demo' : 'manual';
    const portions = parsePortionsServed(req.body, menu, source, new Date().toISOString());
    await repo.replacePortionsServed(menu.service.serviceId, menu.service.menuVersion, portions);
    res.json({ portions });
  }));
  app.post('/api/portions-served/csv', express.text({ type: ['text/csv', 'text/plain'], limit: '1mb' }), wrap(async (req, res) => {
    const menu = await portionsMenu(req);
    if (typeof req.body !== 'string') throw badRequest('INVALID_PORTIONS_CSV', 'Send the file as text/csv.');
    const portions = parsePortionsCsv(req.body, menu, new Date().toISOString());
    await repo.replacePortionsServed(menu.service.serviceId, menu.service.menuVersion, portions);
    res.json({ portions });
  }));
  app.get('/api/portions-served/benchmark', wrap(async (req, res) => {
    const menu = await portionsMenu(req);
    res.json(await dashboard.portionBenchmark(menu));
  }));

  // ---- reference portions (CRUD-lite) ----
  app.post(
    '/api/reference-portions',
    wrap(async (req, res) => {
      const ref = validateReferencePortion(req.body);
      await repo.upsertReferencePortion(ref);
      res.status(201).json({ referencePortion: ref });
    }),
  );

  app.get(
    '/api/reference-portions',
    wrap(async (req, res) => {
      const itemId = typeof req.query.itemId === 'string' ? req.query.itemId : undefined;
      res.json({ referencePortions: await repo.listReferencePortions(itemId) });
    }),
  );

  app.get(
    '/api/reference-portions/:baselineId',
    wrap(async (req, res) => {
      const ref = await repo.getReferencePortion(param(req, 'baselineId'));
      if (!ref) {
        throw notFound('REFERENCE_PORTION_NOT_FOUND', 'No reference portion has this ID.', {
          baselineId: param(req, 'baselineId'),
        });
      }
      res.json({ referencePortion: ref });
    }),
  );

  app.delete(
    '/api/reference-portions/:baselineId',
    wrap(async (req, res) => {
      const deleted = await repo.deleteReferencePortion(param(req, 'baselineId'));
      if (!deleted) {
        throw notFound('REFERENCE_PORTION_NOT_FOUND', 'No reference portion has this ID.', {
          baselineId: param(req, 'baselineId'),
        });
      }
      res.status(204).end();
    }),
  );

  // ---- image uploads: two-step register + finalize (5.7/5.8) ----
  app.post(
    '/api/images/uploads',
    wrap(async (req, res) => {
      const { associationKind, associationId, mimeType, sizeBytes, widthPx, heightPx } = req.body ?? {};
      const result = await images.requestUpload({
        associationKind,
        associationId,
        mimeType,
        sizeBytes,
        widthPx,
        heightPx,
      });
      // 200 for an idempotent retry of an upload that already finished.
      res.status(result.alreadyFinalized ? 200 : 201).json(result);
    }),
  );

  // local-dev stand-in for a presigned PUT URL.
  app.put(
    '/api/storage/upload/:objectKey(*)',
    express.raw({ type: () => true, limit: config.objectStorage.maxUploadBytes }),
    wrap(async (req, res) => {
      if (!storage.putObject) throw localDevOnly(req.path);
      const token = typeof req.query.token === 'string' ? req.query.token : '';
      const mimeType = req.headers['content-type'] ?? '';
      await storage.putObject(
        decodeURIComponent(req.params.objectKey ?? ''),
        token,
        Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
        String(mimeType),
      );
      res.status(204).end();
    }),
  );

  app.post(
    '/api/images/:objectId/finalize',
    wrap(async (req, res) => {
      res.json({ imageObject: await images.finalize(param(req, 'objectId')) });
    }),
  );

  app.get(
    '/api/images/:objectId/access',
    wrap(async (req, res) => {
      res.json(await images.getReadAccess(param(req, 'objectId')));
    }),
  );

  // local-dev stand-in for a presigned GET URL.
  app.get(
    '/api/storage/read/:objectKey(*)',
    wrap(async (req, res) => {
      if (!storage.readObject) throw localDevOnly(req.path);
      const token = typeof req.query.token === 'string' ? req.query.token : '';
      const { bytes, mimeType } = await storage.readObject(
        decodeURIComponent(req.params.objectKey ?? ''),
        token,
      );
      res.setHeader('content-type', mimeType);
      res.send(bytes);
    }),
  );

  app.get(
    '/api/images/orphans',
    wrap(async (req, res) => {
      const maxAgeMs = maxAge(req, config.objectStorage.orphanMaxAgeMs);
      res.json({ orphans: await images.findOrphans(maxAgeMs) });
    }),
  );

  app.post(
    '/api/images/cleanup-orphans',
    wrap(async (req, res) => {
      const maxAgeMs =
        typeof req.body?.maxAgeSeconds === 'number'
          ? req.body.maxAgeSeconds * 1000
          : config.objectStorage.orphanMaxAgeMs;
      res.json(await images.cleanupOrphans(maxAgeMs));
    }),
  );

  function maxAge(req: Request, fallback: number): number {
    const raw = req.query.maxAgeSeconds;
    if (typeof raw !== 'string' || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      throw badRequest('INVALID_PARAMETER', 'maxAgeSeconds must be a non-negative number.');
    }
    return n * 1000;
  }

  // ---- Try an Image: public, in-memory, one analysis at a time (never stored) ----
  const tryImageSvc = (): TryImageService => {
    if (!deps.tryImage) throw new HttpError(503, apiError('UNAVAILABLE', 'Try an Image is not available on this server.', false));
    return deps.tryImage;
  };
  const asHttp = (e: unknown) => (e instanceof TryImageRejection ? new HttpError(e.status, e.body) : e);
  app.get('/api/try-image/status', (_req, res) => {
    res.set('Cache-Control', 'no-store').json(tryImageSvc().status());
  });
  app.get('/api/try-image/sample.jpg', (_req, res, next) => {
    res
      .type('image/jpeg')
      .sendFile(join(repoRoot(), 'demo_pictures', '0_input_photo.jpg'), (err) =>
        err && next(notFound('SAMPLE_NOT_FOUND', 'The sample photo is not available.')),
      );
  });
  app.get('/api/try-image/:id', (req, res) => {
    const job = tryImageSvc().get(param(req, 'id'));
    if (!job) throw notFound('RESULT_NOT_FOUND', 'This result is no longer available. Upload the photo again.');
    res.set('Cache-Control', 'no-store').json(job);
  });
  app.post(
    '/api/try-image',
    geminiCap,
    (req, _res, next) => {
      try {
        const svc = tryImageSvc();
        if (!/^image\//i.test(req.headers['content-type'] ?? '')) {
          throw new HttpError(415, apiError('NOT_AN_IMAGE', 'Upload a JPEG, PNG or WebP photo.', false));
        }
        svc.assertAccepting();
        next();
      } catch (e) {
        next(asHttp(e));
      }
    },
    express.raw({ type: 'image/*', limit: '20mb' }),
    (req, res, next) => {
      try {
        const bytes: unknown = req.body;
        if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw badRequest('EMPTY_UPLOAD', 'The upload was empty.');
        res.status(202).json(tryImageSvc().submit(bytes));
      } catch (e) {
        next(asHttp(e));
      }
    },
  );

  // ---- capture ingestion (idempotent by eventId) ----
  app.post(
    '/api/captures',
    geminiCap,
    wrap(async (req, res) => {
      const submission = validateCaptureSubmission(req.body);
      const result = await ingestion.submitCapture(submission);
      res.status(result.deduplicated ? 200 : 201).json(result);
    }),
  );

  // ---- sample history (DEMO_SEED): fill is opt-in, clearing is always allowed ----
  app.post(
    '/api/demo/seed',
    wrap(async (req, res) => {
      if (!deps.demo || !config.demoSeed) {
        throw new HttpError(403, apiError('DEMO_SEED_DISABLED', 'Set DEMO_SEED=1 in .env to add sample history.', false));
      }
      const { hallId, endDate, days } = req.body ?? {};
      res.status(201).json(
        await deps.demo.seedHistory({
          hallId: typeof hallId === 'string' && hallId ? hallId : 'hall-main',
          endDate: typeof endDate === 'string' ? endDate : new Date().toISOString().slice(0, 10),
          ...(typeof days === 'number' ? { days } : {}),
        }),
      );
    }),
  );
  app.post(
    '/api/demo/clear',
    wrap(async (_req, res) => {
      if (!deps.demo) throw new HttpError(503, apiError('DEMO_UNAVAILABLE', 'Sample data is not available on this server.', false));
      res.json(await deps.demo.clear());
    }),
  );

  // ---- dashboard demo-data controls: Load dummy data / Clear data / Restore default ----
  const demoOrThrow = () => {
    if (!deps.demo) throw new HttpError(503, apiError('DEMO_UNAVAILABLE', 'Sample data is not available on this server.', false));
    return deps.demo;
  };
  const demoHall = (v: unknown) => (typeof v === 'string' && v ? v : 'hall-main');
  app.get(
    '/api/demo/status',
    wrap(async (req, res) => {
      res.json(await demoOrThrow().status(demoHall(req.query.hallId)));
    }),
  );
  app.post('/api/demo/load', wrap(async (req, res) => void res.json(await demoOrThrow().load(demoHall(req.body?.hallId)))));
  app.post('/api/demo/clear-data', wrap(async (req, res) => void res.json(await demoOrThrow().clearData(demoHall(req.body?.hallId)))));
  app.post('/api/demo/restore', wrap(async (req, res) => void res.json(await demoOrThrow().restore(demoHall(req.body?.hallId)))));

  // ---- camera: the dashboard's Take photo button (same path as `npm run take-photo`) ----
  app.get('/api/camera/status', (_req, res) => {
    res.json(deps.camera ? deps.camera.status() : { configured: false, busy: false });
  });
  // A mutation (authGate: ingest token or admin session) that spends Gemini calls.
  app.post(
    '/api/camera/take-photo',
    geminiCap,
    wrap(async (req, res) => {
      if (!deps.camera) throw new HttpError(503, apiError('CAMERA_NOT_CONFIGURED', 'The camera is not available on this server.', false));
      res.status(201).json(await deps.camera.takePhoto(req.body ?? {}));
    }),
  );

  // Camera bridge: is this frame the same physical dish? (BRIDGE.md §4.3)
  // Thumbnails are transient — never stored or logged.
  app.post(
    '/api/dish-match',
    geminiCap,
    wrap(async (req, res) => {
      res.json(await dishMatch.match(req.body));
    }),
  );

  // ---- admin curation: choose which plates the dashboard shows ----
  // Admin session only (reads included: the list shows hidden plates). Hiding
  // never deletes a capture, its analyses or its R2 objects.
  const requireAdmin = (res: Response): void => {
    const principal = res.locals.principal;
    if (principal !== 'admin' && principal !== 'open') {
      throw new HttpError(401, apiError('AUTH_REQUIRED', 'Sign in as an admin to choose which plates are shown.', false));
    }
  };

  app.get(
    '/api/admin/captures',
    wrap(async (req, res) => {
      requireAdmin(res);
      const window = parseWindow(req.query);
      const [{ items, total }, hidden] = await Promise.all([
        impact.capturesPage(window, CAPTURE_LIST_MAX_LIMIT, { includeHidden: true }),
        repo.listHiddenCaptureIds(),
      ]);
      // `total` counts every plate in the window; `truncated` means only the newest
      // CAPTURE_LIST_MAX_LIMIT are listed and older ones need a narrower window.
      res.json({ captures: items.map((c) => ({ ...c, hidden: hidden.has(c.eventId) })), total, truncated: total > items.length });
    }),
  );

  app.put(
    '/api/admin/captures/visibility',
    wrap(async (req, res) => {
      requireAdmin(res);
      const { eventIds, hidden } = (req.body ?? {}) as { eventIds?: unknown; hidden?: unknown };
      if (!Array.isArray(eventIds) || eventIds.length === 0 || eventIds.length > CAPTURE_LIST_MAX_LIMIT ||
          eventIds.some((id) => typeof id !== 'string' || id.length === 0)) {
        throw badRequest('INVALID_PARAMETER', `'eventIds' must be 1 to ${CAPTURE_LIST_MAX_LIMIT} capture ids.`);
      }
      if (typeof hidden !== 'boolean') throw badRequest('INVALID_PARAMETER', "'hidden' must be true or false.");
      for (const id of eventIds as string[]) {
        if (!(await repo.getCaptureEvent(id))) throw notFound('CAPTURE_NOT_FOUND', 'No capture event has this ID.', { eventId: id });
      }
      await repo.setCaptureVisibility(eventIds as string[], hidden, new Date(now()).toISOString());
      res.json({ eventIds, hidden });
    }),
  );

  // D14: failed / needs_review plates INCLUDING hidden ones, for retry-failed.mjs.
  // Hiding is display-only and must not block a retry; the ingest token may call
  // this (it can already resubmit any capture) but it never lists healthy plates.
  app.get(
    '/api/captures/retryable',
    wrap(async (req, res) => {
      const principal = res.locals.principal;
      if (principal !== 'admin' && principal !== 'open' && principal !== 'ingest') {
        throw new HttpError(401, apiError('AUTH_REQUIRED', 'Sign in or use the ingest token to list plates that need a retry.', false));
      }
      const { items } = await impact.capturesPage(parseWindow(req.query), Number.MAX_SAFE_INTEGER, { includeHidden: true });
      const hidden = await repo.listHiddenCaptureIds();
      const captures = items
        .filter((c) => c.state === 'failed' || c.state === 'needs_review')
        .map((c) => ({ eventId: c.eventId, state: c.state, hidden: hidden.has(c.eventId) }));
      res.json({ captures });
    }),
  );

  // Recent plates for the dashboard gallery (contracts CaptureListItem), newest first.
  app.get(
    '/api/captures',
    wrap(async (req, res) => {
      const window = parseWindow(req.query);
      let limit = CAPTURE_LIST_DEFAULT_LIMIT;
      if (req.query.limit !== undefined) {
        limit = Number(req.query.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > CAPTURE_LIST_MAX_LIMIT) {
          throw badRequest('INVALID_PARAMETER', `'limit' must be a whole number from 1 to ${CAPTURE_LIST_MAX_LIMIT}.`);
        }
      }
      res.json(await impact.captures(window, limit));
    }),
  );

  // Plate gallery images (BIG-PLAN D7): short-lived read URLs, never logged.
  app.get(
    '/api/captures/:eventId/images',
    wrap(async (req, res) => {
      res.json(await captures.captureImages(param(req, 'eventId')));
    }),
  );

  app.get(
    '/api/captures/:eventId',
    wrap(async (req, res) => {
      const event = await repo.getCaptureEvent(param(req, 'eventId'));
      if (!event) {
        throw notFound('CAPTURE_NOT_FOUND', 'No capture event has this ID.', {
          eventId: param(req, 'eventId'),
        });
      }
      const attempts = await repo.listAnalysisAttempts(event.eventId);
      const counted = await ingestion.countedAttempt(event.eventId);
      res.json({
        event,
        attempts,
        countedAttemptId: counted?.attemptId ?? null,
        measurements: await ingestion.countedMeasurements(event),
      });
    }),
  );

  // ---- observations / measurements ----
  app.get(
    '/api/observations',
    wrap(async (req, res) => {
      const hallId = requireQuery(req, 'hallId');
      const serviceId = requireQuery(req, 'serviceId');
      const events = await repo.listCaptureEvents({ hallId, serviceId });
      const observations = [];
      for (const event of events) {
        observations.push({
          event,
          measurements: await ingestion.countedMeasurements(event),
        });
      }
      res.json({ observations });
    }),
  );

  // ---- attendance ----
  app.get(
    '/api/attendance',
    wrap(async (req, res) => {
      const serviceId = requireQuery(req, 'serviceId');
      const attendance = await repo.getAttendance(serviceId);
      if (!attendance) {
        throw notFound(
          'ATTENDANCE_NOT_FOUND',
          'No simulated attendance is stored for this service yet.',
          { serviceId },
        );
      }
      res.json({ attendance });
    }),
  );

  // Write path for Agent 6's generator (one stable value per service).
  app.put(
    '/api/attendance',
    wrap(async (req, res) => {
      const attendance = validateAttendance(req.body);
      const existing = await repo.getAttendance(attendance.serviceId);
      if (existing) {
        // Never regenerate per request (AGENTS.md 6.3): first write wins.
        res.json({ attendance: existing, created: false });
        return;
      }
      await repo.upsertAttendance(attendance);
      res.status(201).json({ attendance, created: true });
    }),
  );

  // ---- dashboard summary (§7) ----
  app.get(
    '/api/dashboard/summary',
    wrap(async (req, res) => {
      const hallId = requireQuery(req, 'hallId');
      const serviceId = requireQuery(req, 'serviceId');
      res.json(await summary.getSummary(hallId, serviceId));
    }),
  );

  // ---- dashboard read models for the UI (formulas from analytics/) ----
  app.get(
    '/api/dashboard/daily',
    wrap(async (req, res) => {
      const hallId = requireQuery(req, 'hallId');
      res.json({ days: await dashboard.daily(hallId, requireQuery(req, 'start'), requireQuery(req, 'end')) });
    }),
  );

  app.get(
    '/api/dashboard/cards',
    wrap(async (req, res) => {
      const hallId = requireQuery(req, 'hallId');
      res.json(await dashboard.cards(hallId, requireQuery(req, 'today')));
    }),
  );

  app.get(
    '/api/dashboard/meal',
    wrap(async (req, res) => {
      const hallId = requireQuery(req, 'hallId');
      const date = requireQuery(req, 'date');
      res.json(await dashboard.meal(hallId, date, requireQuery(req, 'meal') as MealLabel));
    }),
  );

  app.get(
    '/api/dashboard/plates',
    wrap(async (req, res) => {
      const hallId = requireQuery(req, 'hallId');
      const date = requireQuery(req, 'date');
      res.json(await dashboard.plates(hallId, date, requireQuery(req, 'meal') as MealLabel));
    }),
  );

  // ---- waste impact + AI recommendation (BIG-PLAN D2–D8; formulas in analytics/) ----
  app.get(
    '/api/dashboard/impact',
    wrap(async (req, res) => {
      res.json(await impact.dashboard(parseWindow(req.query)));
    }),
  );

  // Per-day series for the dashboard chart: pixels, estimated kg CO2e (null without a calibrated plate), CO2 points.
  app.get(
    '/api/dashboard/impact/daily',
    wrap(async (req, res) => {
      res.json({ days: await impact.daily(parseWindow(req.query)) });
    }),
  );

  app.get(
    '/api/recommendation',
    geminiCap,
    wrap(async (req, res) => {
      res.json(await impact.recommendation(parseWindow(req.query)));
    }),
  );

  // ---- IT_4: camera calibration + measurement settings ----
  app.post(
    '/api/calibrations',
    geminiCap,
    wrap(async (req, res) => {
      const result = await calibration.calibrate(validateCalibrationRequest(req.body));
      res.status(result.created ? 201 : 200).json(result.calibration);
    }),
  );

  app.get(
    '/api/calibrations',
    wrap(async (req, res) => {
      const hallId = typeof req.query.hallId === 'string' && req.query.hallId ? req.query.hallId : undefined;
      res.json({ calibrations: await calibration.list(hallId) });
    }),
  );

  app.get(
    '/api/calibrations/:calibrationId/images',
    wrap(async (req, res) => {
      res.json(await calibration.signedImages(param(req, 'calibrationId')));
    }),
  );

  app.get(
    '/api/calibrations/:calibrationId',
    wrap(async (req, res) => {
      res.json(await calibration.get(param(req, 'calibrationId')));
    }),
  );

  app.get(
    '/api/settings/measurement',
    wrap(async (req, res) => {
      res.json(await calibration.getSettings(requireQuery(req, 'hallId')));
    }),
  );

  app.put(
    '/api/settings/measurement',
    wrap(async (req, res) => {
      res.json(await calibration.putSettings(req.body));
    }),
  );

  // Headline totals: today, this week (Mon-today), this month (1st-today), in pixels.
  app.get(
    '/api/dashboard/totals',
    wrap(async (req, res) => {
      const hallId = typeof req.query.hallId === 'string' && req.query.hallId ? req.query.hallId : undefined;
      res.json(await impact.totals(hallId, requireQuery(req, 'today')));
    }),
  );

  // Regenerate on demand (dashboard button): always asks Gemini again and saves the result.
  app.post(
    '/api/recommendation/regenerate',
    geminiCap,
    wrap(async (req, res) => {
      res.json(await impact.recommendation(parseWindow(req.body ?? {}), { regenerate: true }));
    }),
  );

  // ---- suggestions (stored Insights; generation is Agent 6's) ----
  app.get(
    '/api/suggestions',
    wrap(async (req, res) => {
      const hallId = requireQuery(req, 'hallId');
      const insights = await repo.listInsights(hallId);
      if (insights.length === 0) {
        // Generation belongs to Agent 6 (6.4/6.5); until an Insight is
        // stored, suggestions are explicitly unavailable — never invented.
        throw new HttpError(
          404,
          apiError(
            'SUGGESTIONS_UNAVAILABLE',
            'No suggestions have been generated for this hall yet. They appear after the suggestion service runs.',
            true,
            { hallId },
          ),
        );
      }
      insights.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
      res.json({ insights });
    }),
  );

  // Write path for Agent 6's suggestion service.
  app.post(
    '/api/suggestions',
    wrap(async (req, res) => {
      const insight = validateInsight(req.body);
      await repo.upsertInsight(insight);
      res.status(201).json({ insight });
    }),
  );

  // ---- built dashboard (SERVE_FRONTEND=1) with SPA fallback ----
  if (config.frontendDist) {
    const dist = config.frontendDist;
    const index = join(dist, 'index.html');
    if (!existsSync(index)) log.warn('SERVE_FRONTEND=1 but the dashboard build is missing; run the frontend build.', { frontendDist: dist });
    app.use(
      express.static(dist, {
        index: false,
        setHeaders(res, path) {
          // Vite content-hashes everything under assets/: cache forever. Everything else revalidates.
          res.setHeader('Cache-Control', /[\\/]assets[\\/]/.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache');
        },
      }),
    );
    app.use((req, res, next) => {
      if ((req.method !== 'GET' && req.method !== 'HEAD') || req.path === '/api' || req.path.startsWith('/api/')) return next();
      if (!existsSync(index)) return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(index);
    });
  }

  // ---- shared error envelope ----
  app.use((req, res) => {
    res.status(404).json({
      error: apiError('ROUTE_NOT_FOUND', 'This API route does not exist.', false, { path: req.path }),
    });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    // Express body-parser errors (bad JSON, payload too large) -> envelope.
    if (err && typeof err === 'object' && 'type' in err && (err as { type?: string }).type === 'entity.too.large') {
      res.status(413).json({
        error: apiError('PAYLOAD_TOO_LARGE', 'The request body is larger than the allowed limit.', false),
      });
      return;
    }
    if (err instanceof SyntaxError && 'body' in err) {
      res.status(400).json({
        error: apiError('INVALID_JSON', 'The request body is not valid JSON.', false),
      });
      return;
    }
    const httpErr = toHttpError(err);
    if (httpErr.status >= 500) {
      // Log code/message only — never URLs, tokens, or payloads.
      log.error('request failed', { code: httpErr.apiError.code, message: httpErr.apiError.message });
    }
    res.status(httpErr.status).json({ error: httpErr.apiError });
  });

  return app;
}
