/**
 * Strict validation of Gemini classification output (AGENTS.md 4.5, rule 3.9).
 *
 * The model response is untrusted: structured output narrows the shape but
 * guarantees nothing. Everything is re-checked here. Invalid responses become
 * explicit failures ('failed') or review results ('needs_review') — never
 * silent zero waste.
 */

import type { ApiError, ImageGeometry } from './contracts.js';
import { makeApiError } from './errors.js';

export interface ClassifiedItem {
  itemId: string;
  remainingAreaPx: number;
  confidence: number;
  estimatedUneatenAreaPx?: number;
}

export interface UnknownFood {
  label: string;
  remainingAreaPx: number;
}

export interface ClassificationResult {
  plateEmpty: boolean;
  ambiguous: boolean;
  notes?: string;
  items: ClassifiedItem[];
  unknown: UnknownFood[];
}

export type ValidationOutcome =
  | { ok: true; value: ClassificationResult }
  | {
      ok: false;
      /** 'failed' = unusable response; 'needs_review' = parseable but untrustworthy. */
      severity: 'failed' | 'needs_review';
      error: ApiError;
    };

function isFiniteNonNegative(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

function invalid(severity: 'failed' | 'needs_review', reason: string, details?: Record<string, unknown>): ValidationOutcome {
  return {
    ok: false,
    severity,
    error: makeApiError(
      'GEMINI_INVALID_RESPONSE',
      'The image analysis gave an unusable answer for this dish. The capture needs another look.',
      false,
      { reason, ...details },
    ),
  };
}

/** Max area a plate can plausibly cover: whole image, or plate disc when known. */
export function maxPlausibleAreaPx(geometry: ImageGeometry): number {
  const imageArea = geometry.widthPx * geometry.heightPx;
  if (geometry.plateDiameterPx !== undefined && Number.isFinite(geometry.plateDiameterPx)) {
    return Math.min(imageArea, Math.PI * (geometry.plateDiameterPx / 2) ** 2);
  }
  return imageArea;
}

/**
 * Parse + validate raw model text against the allowed menu-item IDs and image
 * geometry. Checks: JSON shape, required fields, allowed itemIds, finite
 * non-negative areas, duplicate item assignment, and total-area plausibility
 * (overlapping double-assignment cannot exceed the plate/image area).
 */
export function validateClassificationText(
  rawText: string,
  allowedItemIds: ReadonlySet<string>,
  geometry: ImageGeometry,
): ValidationOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return invalid('failed', 'response_not_json', { rawTextPrefix: rawText.slice(0, 200) });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return invalid('failed', 'response_not_object');
  }
  const obj = parsed as Record<string, unknown>;

  if (typeof obj['plateEmpty'] !== 'boolean') return invalid('failed', 'missing_or_invalid_field:plateEmpty');
  if (typeof obj['ambiguous'] !== 'boolean') return invalid('failed', 'missing_or_invalid_field:ambiguous');
  if (!Array.isArray(obj['items'])) return invalid('failed', 'missing_or_invalid_field:items');
  if (!Array.isArray(obj['unknown'])) return invalid('failed', 'missing_or_invalid_field:unknown');
  const notes = typeof obj['notes'] === 'string' ? obj['notes'].slice(0, 500) : undefined;

  const items: ClassifiedItem[] = [];
  const seenItemIds = new Set<string>();
  for (const [index, entry] of (obj['items'] as unknown[]).entries()) {
    if (typeof entry !== 'object' || entry === null) return invalid('failed', `items[${index}]_not_object`);
    const e = entry as Record<string, unknown>;
    const itemId = e['itemId'];
    if (typeof itemId !== 'string' || itemId === '') return invalid('failed', `items[${index}]_missing_itemId`);
    if (!allowedItemIds.has(itemId)) {
      // The model invented or echoed an ID outside the supplied menu.
      return invalid('needs_review', 'unknown_item_id_in_response', { itemId });
    }
    if (seenItemIds.has(itemId)) {
      // Same menu item assigned twice => overlapping / double-counted area.
      return invalid('needs_review', 'duplicate_item_assignment', { itemId });
    }
    seenItemIds.add(itemId);
    if (!isFiniteNonNegative(e['remainingAreaPx'])) {
      return invalid('needs_review', 'invalid_remaining_area', { itemId, remainingAreaPx: e['remainingAreaPx'] });
    }
    const confidence = e['confidence'];
    if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      return invalid('needs_review', 'invalid_confidence', { itemId, confidence });
    }
    let estimatedUneatenAreaPx: number | undefined;
    if (e['estimatedUneatenAreaPx'] !== undefined && e['estimatedUneatenAreaPx'] !== null) {
      if (!isFiniteNonNegative(e['estimatedUneatenAreaPx']) || e['estimatedUneatenAreaPx'] === 0) {
        return invalid('needs_review', 'invalid_estimated_baseline', { itemId });
      }
      estimatedUneatenAreaPx = e['estimatedUneatenAreaPx'];
    }
    items.push({
      itemId,
      remainingAreaPx: e['remainingAreaPx'],
      confidence,
      ...(estimatedUneatenAreaPx !== undefined ? { estimatedUneatenAreaPx } : {}),
    });
  }

  const unknown: UnknownFood[] = [];
  for (const [index, entry] of (obj['unknown'] as unknown[]).entries()) {
    if (typeof entry !== 'object' || entry === null) return invalid('failed', `unknown[${index}]_not_object`);
    const e = entry as Record<string, unknown>;
    const label = typeof e['label'] === 'string' && e['label'].trim() !== '' ? e['label'].trim().slice(0, 120) : undefined;
    if (label === undefined) return invalid('failed', `unknown[${index}]_missing_label`);
    if (!isFiniteNonNegative(e['remainingAreaPx'])) {
      return invalid('needs_review', 'invalid_unknown_area', { label });
    }
    unknown.push({ label, remainingAreaPx: e['remainingAreaPx'] });
  }

  // Each pixel belongs to at most one category (§7.4): the total claimed food
  // area can never exceed the plausible plate/image area.
  const totalClaimed =
    items.reduce((sum, i) => sum + i.remainingAreaPx, 0) + unknown.reduce((sum, u) => sum + u.remainingAreaPx, 0);
  const maxArea = maxPlausibleAreaPx(geometry);
  if (totalClaimed > maxArea) {
    return invalid('needs_review', 'total_area_exceeds_plate', { totalClaimed, maxPlausibleAreaPx: maxArea });
  }

  // An "empty" plate that still reports leftover food contradicts itself.
  if ((obj['plateEmpty'] as boolean) && totalClaimed > 0) {
    return invalid('needs_review', 'empty_plate_with_nonzero_area', { totalClaimed });
  }

  return {
    ok: true,
    value: {
      plateEmpty: obj['plateEmpty'] as boolean,
      ambiguous: obj['ambiguous'] as boolean,
      ...(notes !== undefined ? { notes } : {}),
      items,
      unknown,
    },
  };
}
