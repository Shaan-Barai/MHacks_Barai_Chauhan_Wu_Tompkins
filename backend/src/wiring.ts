/**
 * Composition root: builds the full dependency graph from config. Tests use
 * this too, overriding the analyzer with fixtures.
 */

import { loadConfig, type BackendConfig } from './config.js';
import { JsonFileRepository } from './repo/jsonFileRepository.js';
import { LocalDevStorage } from './storage/localDevStorage.js';
import { ImageService } from './services/imageService.js';
import { IngestionService } from './services/ingestionService.js';
import { SummaryService } from './services/summaryService.js';
import { MockAnalyzer } from './analysis/mockAnalyzer.js';
import { createApp, type AppDeps } from './http/app.js';
import type { Analyzer } from './analysis/analyzer.js';
import type { Repository } from './repo/repository.js';

export interface BuildOptions {
  config?: BackendConfig;
  repo?: Repository;
  analyzer?: Analyzer;
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
  const repo = options.repo ?? new JsonFileRepository(config.dataFile);
  const storage = new LocalDevStorage({ ...config.objectStorage, now });
  const images = new ImageService(repo, storage, now);
  // Default analyzer is the deterministic mock until Agent 4's Gemini module
  // lands; swap via BuildOptions.analyzer.
  const analyzer = options.analyzer ?? new MockAnalyzer();
  const ingestion = new IngestionService(repo, images, analyzer, now);
  const summary = new SummaryService(repo, ingestion);
  const deps: AppDeps = { config, repo, storage, images, ingestion, summary };
  return { ...deps, app: createApp(deps) };
}
