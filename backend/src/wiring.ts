/**
 * Composition root: builds the full dependency graph from config. Tests use
 * this too, overriding the analyzer with fixtures.
 */

import { loadConfig, type BackendConfig } from './config.js';
import { createGeminiGateway, type GeminiGateway } from '@scrap/vision';
import { JsonFileRepository } from './repo/jsonFileRepository.js';
import { SpacetimeRepository } from './repo/spacetimeRepository.js';
import { LocalDevStorage } from './storage/localDevStorage.js';
import { ImageService } from './services/imageService.js';
import { IngestionService } from './services/ingestionService.js';
import { SummaryService } from './services/summaryService.js';
import { DashboardService } from './services/dashboardService.js';
import { MockAnalyzer } from './analysis/mockAnalyzer.js';
import { GeminiAnalyzer } from './analysis/geminiAnalyzer.js';
import { createApp, type AppDeps } from './http/app.js';
import type { Analyzer } from './analysis/analyzer.js';
import type { Repository } from './repo/repository.js';

export interface BuildOptions {
  config?: BackendConfig;
  repo?: Repository;
  analyzer?: Analyzer;
  /** Gemini gateway; defaults to one built from env (live only with GEMINI_API_KEY). */
  gateway?: GeminiGateway;
  now?: () => number;
}

export function buildBackend(options: BuildOptions = {}): AppDeps & { app: ReturnType<typeof createApp> } {
  const config = options.config ?? loadConfig();
  if (config.objectStorage.provider !== 'local-dev') {
    // Real provider adapters (R2/S3/Supabase/Firebase) plug in here once the
    // provider decision lands (contracts/decisions.md).
    throw new Error(
      `Object storage provider '${config.objectStorage.provider}' is not implemented yet; use 'local-dev'.`,
    );
  }
  const now = options.now ?? (() => Date.now());
  // SpacetimeDB when configured (SPACETIMEDB_URI); otherwise the offline
  // in-memory/JSON repository used by tests and fixture-only machines.
  const repo =
    options.repo ??
    (config.spacetime ? new SpacetimeRepository(config.spacetime) : new JsonFileRepository(config.dataFile));
  const storage = new LocalDevStorage({ ...config.objectStorage, now });
  const images = new ImageService(repo, storage, now);
  // Live Gemini analysis when GEMINI_API_KEY is set; the deterministic mock
  // otherwise. Mock gateway text is never shown as an AI suggestion.
  const gateway = options.gateway ?? createGeminiGateway();
  const analyzer = options.analyzer ?? (gateway.mode === 'live' ? new GeminiAnalyzer(gateway) : new MockAnalyzer());
  const ingestion = new IngestionService(repo, images, analyzer, now);
  const summary = new SummaryService(repo, ingestion);
  const dashboard = new DashboardService(repo, ingestion, config, gateway.mode === 'live' ? gateway : undefined);
  const deps: AppDeps = { config, repo, storage, images, ingestion, summary, dashboard };
  return { ...deps, app: createApp(deps) };
}
