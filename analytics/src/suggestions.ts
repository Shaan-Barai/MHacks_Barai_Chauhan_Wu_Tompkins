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
import { readableItemName } from './names.js';

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
  'You write short suggestions for dining hall chefs and staff who are not technical.',
  'Use plain everyday words. Do not use technical terms such as pixels, area, baseline, mask, model, metric, or benchmark.',
  'Ground every claim in the supplied numbers only. Never invent causes; say it is a pattern, not proof.',
  'Say the amounts are estimates from plate photos, and mention when only a few plates were checked.',
  'If you mention meal swipes, say they are simulated.',
  'Do not use em dashes, emojis, markdown, or the words leverage, seamless, robust, unlock, or elevate.',
  'Write at most two short sentences.',
].join(' ');

function defaultId(): string {
  return `ins_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function itemName(itemId: string, menuItems: MenuItem[] | undefined): string {
  return menuItems?.find((m) => m.itemId === itemId)?.displayName ?? readableItemName(itemId);
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
  const plates = `${analyzed} plate${analyzed === 1 ? '' : 's'}`;
  const caveat =
    analyzed < 10
      ? `Only ${plates} checked so far, and amounts are an AI estimate from photos, not proof of why food was left.`
      : `Based on ${plates}. Amounts are an AI estimate from photos, not proof of why food was left.`;

  const topName = typeof metrics['topItemName'] === 'string' ? metrics['topItemName'] : undefined;
  const share = metrics['topItemShareOfMealWastePercent'];

  if (analyzed > 0 && topName !== undefined && typeof share === 'number') {
    return (
      `${topName} made up ${Math.round(share)}% of the food left on ${meal} plates. ` +
      `Try a smaller scoop or batch of ${topName} and see if that drops. ${caveat}`
    );
  }

  if (analyzed > 0 && summary.overallWastePercent !== null) {
    return (
      `About ${Math.round(summary.overallWastePercent)}% of each ${meal} serving came back on the plate. ${caveat} ` +
      `Check again once more plates are scanned.`
    );
  }

  return `Not enough ${meal} plates checked to make a suggestion yet. Scan more plates and make sure this meal has a menu.`;
}

function sanitizeModelText(text: string): string {
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
