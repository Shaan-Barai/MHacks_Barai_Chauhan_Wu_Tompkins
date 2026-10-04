/**
 * Composition root: builds the full dependency graph from config. Tests use
 * this too, overriding the analyzer with fixtures.
 */

import { loadConfig, type BackendConfig } from './config.js';
import {
  createGeminiGateway,
  createSamWorkerClient,
  type GeminiGateway,
  type Segmenter,
} from '@scrap/vision';
import { VisionCalibrationRunner } from './analysis/visionCalibrationRunner.js';
import { computePhysicalAmounts, formatPhysicalLabel } from '@scrap/analytics';
import { findWasteFactor } from 'scrap-data';
import type { LabelSuffixFactory } from './services/ingestionService.js';
import { JsonFileRepository } from './repo/jsonFileRepository.js';
import { SpacetimeRepository } from './repo/spacetimeRepository.js';
import { LocalDevStorage } from './storage/localDevStorage.js';
import { R2Storage } from './storage/r2Storage.js';
import type { ObjectStorageAdapter } from './storage/objectStorage.js';
import { ImageService } from './services/imageService.js';
import { IngestionService } from './services/ingestionService.js';
import { SummaryService } from './services/summaryService.js';
import { DashboardService } from './services/dashboardService.js';
import { DishMatchService } from './services/dishMatchService.js';
import { CameraService } from './services/cameraService.js';
import { DemoService } from './services/demoService.js';
import { CaptureService } from './services/captureService.js';
import { ImpactService } from './services/impactService.js';
import { MockAnalyzer } from './analysis/mockAnalyzer.js';
import { MaskAnalyzer } from './analysis/maskAnalyzer.js';
import { createApp, type AppDeps } from './http/app.js';
import { assertSecurity } from './http/security.js';
import { ReadinessService } from './services/readinessService.js';
import { CalibrationService } from './services/calibrationService.js';
import type { CalibrationRunner } from './analysis/calibrationRunner.js';
import type { Analyzer } from './analysis/analyzer.js';
import type { Repository } from './repo/repository.js';

export interface BuildOptions {
  config?: BackendConfig;
  repo?: Repository;
  analyzer?: Analyzer;
  storage?: ObjectStorageAdapter;
  /** Gemini gateway; defaults to one built from env (live only with GEMINI_API_KEY). */
  gateway?: GeminiGateway;
  /** SAM segmenter; defaults to the worker at config.samWorkerUrl. */
  segmenter?: Segmenter;
  /** Calibration runner; defaults to vision's runCalibration when live. */
  calibrationRunner?: CalibrationRunner;
  now?: () => number;
}

/** Cloudflare R2 when OBJECT_STORAGE_PROVIDER=r2, else the offline local-dev filesystem. */
function createStorage(config: BackendConfig, now: () => number): ObjectStorageAdapter {
  const os = config.objectStorage;
  if (os.provider === 'r2') {
    if (!os.r2) {
      throw new Error('OBJECT_STORAGE_PROVIDER=r2 needs R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY.');
    }
    return new R2Storage({ ...os, ...os.r2, bucket: os.container, now });
  }
  if (os.provider !== 'local-dev') {
    throw new Error(`Object storage provider '${os.provider}' is not implemented; use 'r2' or 'local-dev'.`);
  }
  return new LocalDevStorage({ ...os, now });
}

/**
 * IT_4 I8: overlay legend text after each food, e.g. "38 g · 1.1 kg CO2e ·
 * 18 L water (est.)", from analytics' formulas and the factor table. Nothing
 * (never "0 g") when the food has no calibrated estimate or no factor.
 */
export const physicalLabelSuffix: LabelSuffixFactory = (menu) => {
  const names = new Map(menu.items.map((i) => [i.itemId, i.displayName]));
  return (bucket) => {
    if (bucket.itemId === null || !bucket.physical) return null;
    const name = names.get(bucket.itemId);
    if (!name) return null;
    return formatPhysicalLabel(computePhysicalAmounts({ physical: bucket.physical, factor: findWasteFactor(name) }));
  };
};

/** Origins the browser reaches directly for presigned R2 reads/uploads (CSP). */
function storageOrigins(config: BackendConfig): string[] {
  const r2 = config.objectStorage.provider === 'r2' ? config.objectStorage.r2 : undefined;
  if (!r2) return [];
  try {
    const endpoint = new URL(r2.endpoint ?? `https://${r2.accountId}.r2.cloudflarestorage.com`);
    // Presigned URLs may be virtual-hosted (<bucket>.<endpoint host>) or path-style.
    return [endpoint.origin, `${endpoint.protocol}//*.${endpoint.host}`];
  } catch {
    return [];
  }
}

export function buildBackend(options: BuildOptions = {}): AppDeps & { app: ReturnType<typeof createApp> } {
  const config = options.config ?? loadConfig();
  // IT_4 I11: production refuses to start without its auth secrets.
  const security = assertSecurity(config.security);
  const now = options.now ?? (() => Date.now());
  // SpacetimeDB when configured (SPACETIMEDB_URI); otherwise the offline
  // in-memory/JSON repository used by tests and fixture-only machines.
  const repo =
    options.repo ??
    (config.spacetime ? new SpacetimeRepository(config.spacetime) : new JsonFileRepository(config.dataFile));
  const storage = options.storage ?? createStorage(config, now);
  const images = new ImageService(repo, storage, now, config.objectStorage.keyPrefix ?? '');
  // Live: Gemini classification + boxes -> SAM 2.1 masks -> counted pixels
  // (contracts/measurement.md). If the SAM worker is down, captures fail
  // retryably; there is no fallback to Gemini-guessed areas. Without a key
  // the deterministic mock runs. Mock gateway text is never a suggestion.
  const gateway = options.gateway ?? createGeminiGateway();
  // The SAM worker gets the shared X-Worker-Token when WORKER_TOKEN is set (IT_4 I10).
  const segmenter = options.segmenter ?? createSamWorkerClient(config.samWorkerUrl, undefined, config.workerToken ?? '');
  const analyzer = options.analyzer ?? (gateway.mode === 'live' ? new MaskAnalyzer(gateway, segmenter) : new MockAnalyzer());
  const ingestion = new IngestionService(repo, images, analyzer, now, physicalLabelSuffix);
  const summary = new SummaryService(repo, ingestion);
  const dashboard = new DashboardService(repo, ingestion, config, gateway.mode === 'live' ? gateway : undefined);
  // Same-dish checks for the camera bridge never run on mock text (BRIDGE.md §4.4).
  const dishMatch = new DishMatchService(gateway.mode === 'live' ? gateway : undefined);
  const captures = new CaptureService(repo, images, ingestion);
  // Recommendations use live Gemini only; mock text is never shown (labeled fallback instead).
  const impact = new ImpactService(repo, ingestion, gateway.mode === 'live' ? gateway : undefined, now);
  const camera = new CameraService(`http://127.0.0.1:${config.port}`);
  const demo = new DemoService(repo, now);
  const readiness = new ReadinessService({
    repo,
    storage,
    samWorkerUrl: config.samWorkerUrl,
    workerToken: config.workerToken,
    samRequired: analyzer instanceof MaskAnalyzer,
    providerStatus: ingestion.providerStatus,
  });
  // Calibration needs live Gemini + SAM (no mock: a fake k would be worse than none).
  const calibrationRunner =
    options.calibrationRunner ?? (gateway.mode === 'live' ? new VisionCalibrationRunner(gateway, segmenter) : undefined);
  const calibration = new CalibrationService(repo, images, calibrationRunner, now);
  const deps: AppDeps = {
    config,
    repo,
    storage,
    images,
    ingestion,
    summary,
    dashboard,
    dishMatch,
    captures,
    impact,
    security,
    readiness,
    calibration,
    now,
    storageOrigins: storageOrigins(config),
    camera,
    demo,
  };
  return { ...deps, app: createApp(deps) };
}
