/**
 * Express app wiring every agreed endpoint (AGENTS.md 5.5). Every error —
 * validation, missing records, storage problems — is returned as the shared
 * ApiError envelope: { error: { code, message, details?, retryable } } with a
 * matching HTTP status. Temporary upload/read URLs appear only in responses,
 * never in logs.
 */

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
import type { MealLabel, MenuBundle } from '../types.js';
import {
  validateAttendance,
  validateCaptureSubmission,
  validateInsight,
  validateMenuBundle,
  validateReferencePortion,
} from '../services/validation.js';

export interface AppDeps {
  config: BackendConfig;
  repo: Repository;
  storage: ObjectStorageAdapter;
  images: ImageService;
  ingestion: IngestionService;
  summary: SummaryService;
  dashboard: DashboardService;
  dishMatch: DishMatchService;
}

export function createApp(deps: AppDeps): express.Express {
  const { config, repo, storage, images, ingestion, summary, dashboard, dishMatch } = deps;
  const app = express();
  app.use(express.json({ limit: '1mb' }));

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

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, provider: storage.provider });
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
    const portions = parsePortionsServed(req.body, menu, 'manual', new Date().toISOString());
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
      res.status(201).json(result);
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

  // ---- capture ingestion (idempotent by eventId) ----
  app.post(
    '/api/captures',
    wrap(async (req, res) => {
      const submission = validateCaptureSubmission(req.body);
      const result = await ingestion.submitCapture(submission);
      res.status(result.deduplicated ? 200 : 201).json(result);
    }),
  );

  // Camera bridge: is this frame the same physical dish? (BRIDGE.md §4.3)
  // Thumbnails are transient — never stored or logged.
  app.post(
    '/api/dish-match',
    wrap(async (req, res) => {
      res.json(await dishMatch.match(req.body));
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
      console.error(`[backend] ${httpErr.apiError.code}: ${httpErr.apiError.message}`);
    }
    res.status(httpErr.status).json({ error: httpErr.apiError });
  });

  return app;
}
