/**
 * Grounded suggestions from Pixels wasted (AGENTS.md 6.4-6.6,
 * contracts/measurement.md "Baselines and recommendations"). Cites measured
 * per-food pixel totals and capture coverage; never percentages of food
 * served. Gemini via Agent 4's gateway, or a labeled rule-based fallback.
 */

import type { Insight, MenuItem } from './contracts.js';
import { computePixelDataVersion, type PixelServiceSummary } from './pixels.js';
import { sanitizeModelText, type TextGateway } from './suggestions.js';

export const PIXEL_SUGGESTION_PROMPT_VERSION = 'suggest-pixels-v1';

const SYSTEM_INSTRUCTION = [
  'You write short, beginner-friendly recommendations for dining hall staff.',
  'Ground every claim in the supplied metrics only. Never invent causes; say the pattern is observed, not proven.',
  '"Pixels wasted" counts visible leftover-food pixels in AI-generated segmentation masks; it is not grams, servings, or percent of food served.',
  'Mention limited coverage when few plates were counted. Attendance is simulated.',
  'Keep it to 1-3 sentences. No markdown.',
].join(' ');

export function buildPixelInsightMetrics(s: PixelServiceSummary): Record<string, number | string> {
  const top = s.items[0];
  const metrics: Record<string, number | string> = {
    mealLabel: s.mealLabel ?? 'unknown',
    serviceDate: s.serviceDate,
    pixelsWasted: s.pixelsWasted,
    countedPlates: s.countedCaptureCount,
    emptyPlates: s.emptyPlateCount,
    excludedPlates: s.excludedCaptureCount,
    unclassifiedPixels: s.unclassifiedPixels,
  };
  if (s.attendance) metrics['simulatedAttendance'] = s.attendance.count;
  if (top) {
    metrics['topItemId'] = top.itemId;
    metrics['topItemName'] = top.displayName ?? top.itemId;
    metrics['topItemPixelsWasted'] = top.pixelsWasted;
    if (top.shareOfMealPixelsPercent !== null) {
      metrics['topItemShareOfPixelsPercent'] = Math.round(top.shareOfMealPixelsPercent * 10) / 10;
    }
  }
  return metrics;
}

export function buildPixelFallback(s: PixelServiceSummary, metrics: Record<string, number | string>): string {
  const meal = s.mealLabel ?? 'service';
  const plates = s.countedCaptureCount;
  const coverage =
    plates < 10
      ? `This is based on only ${plates} counted plate(s)` + (s.excludedCaptureCount > 0 ? `, with ${s.excludedCaptureCount} left out` : '') + ' — coverage is limited.'
      : `Based on ${plates} counted plates.`;
  const name = metrics['topItemName'];
  const share = metrics['topItemShareOfPixelsPercent'];
  if (typeof name === 'string' && typeof share === 'number') {
    return (
      `${name} made up ${share}% of ${meal}'s wasted pixels (${Number(metrics['topItemPixelsWasted']).toLocaleString('en-US')} of ${s.pixelsWasted.toLocaleString('en-US')}). ` +
      `${coverage} Consider reviewing the serving scoop or batch size for ${name}; this is an observed pattern, not proof of the cause.`
    );
  }
  return `No food pixels were attributed to a menu item for ${meal} yet. ${coverage}`;
}

export interface PixelSuggestionRequest {
  hallId: string;
  windowStart: string;
  windowEnd: string;
  summary: PixelServiceSummary;
  menuItems?: MenuItem[];
  dataVersion?: string;
  now?: () => Date;
  idFactory?: () => string;
}

export async function generatePixelInsight(
  req: PixelSuggestionRequest,
  opts: { gateway?: TextGateway; maxOutputTokens?: number } = {},
): Promise<Insight> {
  const now = req.now ?? (() => new Date());
  const id = (req.idFactory ?? (() => `ins_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`))();
  const metrics = buildPixelInsightMetrics(req.summary);
  const base = {
    insightId: id,
    hallId: req.hallId,
    windowStart: req.windowStart,
    windowEnd: req.windowEnd,
    metrics,
    dataVersion: req.dataVersion ?? computePixelDataVersion(req.summary),
    generatedAt: now().toISOString(),
  };
  if (opts.gateway) {
    try {
      const raw = await opts.gateway.generateText(
        ['Write one dining-hall recommendation from these measured metrics:', JSON.stringify(metrics, null, 2), '', 'If a top item is present, suggest reviewing its portion or batch size.'].join('\n'),
        { systemInstruction: SYSTEM_INSTRUCTION, temperature: 0.3, maxOutputTokens: opts.maxOutputTokens ?? 512 },
      );
      return { ...base, recommendation: sanitizeModelText(raw), source: 'gemini' };
    } catch {
      // Labeled rule-based fallback below (AGENTS.md 6.5).
    }
  }
  return { ...base, recommendation: buildPixelFallback(req.summary, metrics), source: 'fallback_rules' };
}
