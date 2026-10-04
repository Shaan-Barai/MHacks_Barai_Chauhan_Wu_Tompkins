import { execFileSync } from 'node:child_process';
import { WASTE_FACTORS_VERSION } from 'scrap-data';

/**
 * What this process is running: the commit it started from, when it started,
 * and the waste-factor table it loaded. Captured once at startup so a stale
 * process is visible (`deploy/local.sh status` compares the commit with the
 * checkout's HEAD).
 */
export interface BuildInfo {
  commit: string;
  startedAt: string;
  factorsVersion: string;
}

export function readBuildInfo(env: NodeJS.ProcessEnv = process.env, now: () => Date = () => new Date()): BuildInfo {
  let commit = env.GIT_COMMIT?.trim() || '';
  if (!commit) {
    try {
      commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      commit = 'unknown';
    }
  }
  return { commit, startedAt: now().toISOString(), factorsVersion: WASTE_FACTORS_VERSION };
}
