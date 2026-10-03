/**
 * AI-powered suggestions grounded in aggregate facts (AGENTS.md 6.4–6.6).
 *
 * Uses Agent 4's Gemini text gateway when provided. On provider failure or
 * when no gateway is configured, returns a clearly labeled rule-based fallback.
 * Does not own Gemini transport — only prompt + business logic.
 */

import type { Insight, MenuItem, MealLabel } from './contracts.js';
import type { ServiceSummary } from './aggregates.js';
import { computeDataVersion } from './aggregates.js';

export const SUGGESTION_PROMPT_VERSION = 'suggest-v1';

/** Duck-typed subset of Agent 4's GeminiGateway.generateText. */
export interface TextGateway {
  generateText(
    prompt: string,
    opts?: {
      systemInstruction?: string;
      temperature?: number;
      maxOutputTokens?: number;
    },
  ): Promise<string>;
}

export interface SuggestionRequest {
  hallId: string;
  windowStart: string;
  windowEnd: string;
  summary: ServiceSummary;
  menuItems?: MenuItem[];
  /** Override data version; defaults to computeDataVersion(summary). */
  dataVersion?: string;
  /** Injectable clock for tests. */
  now?: () => Date;
  /** Injectable id factory for tests. */
  idFactory?: () => string;
}

export interface SuggestionOptions {
  /** Agent 4 gateway (or a test double). Omit to force fallback. */
  gateway?: TextGateway;
  temperature?: number;
  maxOutputTokens?: number;
}

const SYSTEM_INSTRUCTION = [
  'You write short, beginner-friendly recommendations for dining hall staff.',
  'Ground every claim in the supplied metrics only.',
  'Never invent causes. Say the pattern is observed, not proven.',
  'Mention that leftover areas are AI estimates and attendance is simulated.',
  'Mention limited plate coverage when analyzedCaptures is small.',
  'Keep the answer to 1–3 sentences. No markdown headings or bullet lists.',
].join(' ');

function defaultId(): string {
  return `ins_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function itemName(itemId: string, menuItems: MenuItem[] | undefined): string {
  return menuItems?.find((m) => m.itemId === itemId)?.displayName ?? itemId;
}

function mealWord(label: MealLabel | undefined): string {
  return label ?? 'service';
}

/** Facts passed into the prompt and stored on the Insight. */
export function buildInsightMetrics(
  summary: ServiceSummary,
  menuItems?: MenuItem[],
): Record<string, number | string> {
  const top = summary.items[0];
  const metrics: Record<string, number | string> = {
    mealLabel: summary.mealLabel ?? 'unknown',
    serviceDate: summary.serviceDate,
    analyzedCaptures: summary.succeededCaptureCount,
    excludedCaptures: summary.excludedCaptureCount,
    eligibleMeasurements: summary.eligibleMeasurementCount,
    excludedMeasurements: summary.excludedMeasurementCount,
    observedRemainingAreaPx: summary.observedRemainingAreaPx,
  };
  if (summary.overallWastePercent !== null) {
    metrics['overallWastePercent'] = summary.overallWastePercent;
  }
  if (summary.leftoverAreaPerSimulatedAttendee !== null) {
    metrics['leftoverAreaPerSimulatedAttendee'] = Math.round(summary.leftoverAreaPerSimulatedAttendee * 100) / 100;
  }
  if (summary.attendance !== null) {
    metrics['simulatedAttendance'] = summary.attendance.count;
  }
  if (top !== undefined) {
    metrics['topItemId'] = top.itemId;
    metrics['topItemName'] = itemName(top.itemId, menuItems);
    metrics['topItemWastePercent'] = top.wastePercent;
    if (top.shareOfMealWastePercent !== null) {
      metrics['topItemShareOfMealWastePercent'] = top.shareOfMealWastePercent;
    }
  }
  return metrics;
}

export function buildSuggestionPrompt(
  summary: ServiceSummary,
  metrics: Record<string, number | string>,
): string {
  return [
    'Write one dining-hall recommendation from these observed metrics:',
    JSON.stringify(metrics, null, 2),
    '',
    'Metric labels:',
    `- remaining area: ${summary.labels.remainingArea}`,
    `- per attendee: ${summary.labels.perAttendee}`,
    `- attendance: ${summary.labels.attendanceSource}`,
    `- measurements: ${summary.labels.measurementMethod}`,
    '',
    'If a top waste item is present, suggest reviewing portion size or batch size for that item.',
    'If coverage is thin (few analyzed plates), say the sample is limited.',
  ].join('\n');
}

/**
 * Rule-based fallback used when Gemini is unavailable or fails.
 * Always labeled `fallback_rules`.
 */
export function buildFallbackRecommendation(
  summary: ServiceSummary,
  metrics: Record<string, number | string>,
): string {
  const meal = mealWord(summary.mealLabel);
  const analyzed = summary.succeededCaptureCount;
  const excluded = summary.excludedCaptureCount + summary.excludedMeasurementCount;
  const coverageNote =
    analyzed === 0
      ? 'No plates were successfully analyzed for this service yet, so treat any guidance as unavailable until captures succeed.'
      : analyzed < 10
        ? `This is based on only ${analyzed} analyzed plate(s) (AI estimates)` +
          (excluded > 0 ? `, with ${excluded} excluded` : '') +
          ' — coverage is limited.'
        : `Based on ${analyzed} analyzed plate(s) (AI estimates)` +
          (excluded > 0 ? `; ${excluded} observation(s) excluded` : '') +
          '.';

  const topId = metrics['topItemId'];
  const topName = typeof metrics['topItemName'] === 'string' ? metrics['topItemName'] : undefined;
  const share = metrics['topItemShareOfMealWastePercent'];
  const wastePct = metrics['topItemWastePercent'];

  if (typeof topId === 'string' && topName !== undefined && typeof share === 'number') {
    return (
      `${topName} accounted for ${share}% of observed ${meal} leftover area` +
      (typeof wastePct === 'number' ? ` (about ${wastePct}% of its uneaten-serving baseline)` : '') +
      `. ${coverageNote} Consider testing a smaller batch or scoop for ${topName}; ` +
      `this is an observed pattern, not proof of the cause. Attendance is simulated.`
    );
  }

  if (summary.overallWastePercent !== null) {
    return (
      `Observed ${meal} leftover area is about ${summary.overallWastePercent}% of assessed uneaten-serving baselines. ` +
      `${coverageNote} Review the highest leftover items once more plates are analyzed. Attendance is simulated.`
    );
  }

  return (
    `Not enough eligible measurements to score ${meal} waste yet. ${coverageNote} ` +
    `Add menu baselines and successful analyses before acting on suggestions.`
  );
}

export function sanitizeModelText(text: string): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (trimmed.length === 0) {
    throw new Error('Empty suggestion text from gateway.');
  }
  // Soft cap so a runaway response does not flood the dashboard.
  return trimmed.length > 600 ? `${trimmed.slice(0, 597)}...` : trimmed;
}

/**
 * Generate (or fall back to) a grounded Insight for the reporting window.
 * Caller should cache by dataVersion and regenerate only when inputs change.
 */
export async function generateInsight(
  req: SuggestionRequest,
  opts: SuggestionOptions = {},
): Promise<Insight> {
  const now = req.now ?? (() => new Date());
  const idFactory = req.idFactory ?? defaultId;
  const dataVersion = req.dataVersion ?? computeDataVersion(req.summary);
  const metrics = buildInsightMetrics(req.summary, req.menuItems);
  const generatedAt = now().toISOString();

  if (opts.gateway !== undefined) {
    try {
      const prompt = buildSuggestionPrompt(req.summary, metrics);
      const raw = await opts.gateway.generateText(prompt, {
        systemInstruction: SYSTEM_INSTRUCTION,
        temperature: opts.temperature ?? 0.3,
        maxOutputTokens: opts.maxOutputTokens ?? 512,
      });
      return {
        insightId: idFactory(),
        hallId: req.hallId,
        windowStart: req.windowStart,
        windowEnd: req.windowEnd,
        metrics,
        dataVersion,
        recommendation: sanitizeModelText(raw),
        source: 'gemini',
        generatedAt,
      };
    } catch {
      // Fall through to rule-based fallback (AGENTS.md 6.5).
    }
  }

  return {
    insightId: idFactory(),
    hallId: req.hallId,
    windowStart: req.windowStart,
    windowEnd: req.windowEnd,
    metrics,
    dataVersion,
    recommendation: buildFallbackRecommendation(req.summary, metrics),
    source: 'fallback_rules',
    generatedAt,
  };
}

/**
 * Simple in-process suggestion cache keyed by dataVersion.
 * Agent 5 should prefer durable storage; this helps demos and tests.
 */
export class InsightCache {
  private readonly store = new Map<string, Insight>();

  get(dataVersion: string): Insight | undefined {
    return this.store.get(dataVersion);
  }

  put(insight: Insight): void {
    this.store.set(insight.dataVersion, insight);
  }

  /** Return cached insight when dataVersion matches; otherwise generate. */
  async getOrGenerate(req: SuggestionRequest, opts: SuggestionOptions = {}): Promise<Insight> {
    const dataVersion = req.dataVersion ?? computeDataVersion(req.summary);
    const existing = this.store.get(dataVersion);
    if (existing !== undefined) return existing;
    const created = await generateInsight({ ...req, dataVersion }, opts);
    this.store.set(dataVersion, created);
    return created;
  }

  clear(): void {
    this.store.clear();
  }
}
