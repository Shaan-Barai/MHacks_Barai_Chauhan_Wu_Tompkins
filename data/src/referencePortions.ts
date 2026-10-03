/**
 * Uneaten-serving reference portions (AGENTS.md 2.3, 2.5, §7).
 *
 * A ReferencePortion is the expected visible pixel area of ONE uneaten
 * serving of a menu item, in the shared normalized coordinate space. The
 * three sources stay distinguishable end to end:
 *   - 'reference_photo'  : measured from a photographed uneaten serving
 *                          (referenceImageObjectId required)
 *   - 'manual_area'      : staff-entered area
 *   - 'gemini_estimate'  : AI-estimated baseline; downstream measurements
 *                          must carry the 'gemini_estimated_baseline' flag
 *
 * A missing reference is an explicit absence (found: false + reason +
 * 'missing_baseline'), never a zero area — §7 rule 1.
 */

import { invalid } from './errors.js';
import { makeBaselineId } from './ids.js';
import type { ImageGeometry, ReferencePortion, ReferenceSource } from './types.js';

export const COORDINATE_SPACE = 'topdown-normalized-v1' as const;
export const REFERENCE_SOURCES: readonly ReferenceSource[] = [
  'reference_photo',
  'manual_area',
  'gemini_estimate',
];

/** Relative tolerance for plate-diameter compatibility (±5%). */
export const DEFAULT_DIAMETER_TOLERANCE = 0.05;

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

export function validateImageGeometry(input: unknown): ImageGeometry {
  const geo = input as Partial<ImageGeometry> | undefined;
  if (!geo || typeof geo !== 'object') {
    invalid('INVALID_GEOMETRY', 'Image geometry is required.');
  }
  if (geo.coordinateSpace !== COORDINATE_SPACE) {
    invalid(
      'INVALID_GEOMETRY',
      `Pixel areas are only comparable inside "${COORDINATE_SPACE}".`,
      { coordinateSpace: geo.coordinateSpace },
    );
  }
  if (!isPositiveInt(geo.widthPx) || !isPositiveInt(geo.heightPx)) {
    invalid('INVALID_GEOMETRY', 'Image width and height must be positive whole pixel counts.', {
      widthPx: geo.widthPx,
      heightPx: geo.heightPx,
    });
  }
  if (geo.plateShape !== undefined && !['round', 'tray', 'other'].includes(geo.plateShape)) {
    invalid('INVALID_GEOMETRY', 'Plate shape must be round, tray, or other.', {
      plateShape: geo.plateShape,
    });
  }
  if (geo.plateDiameterPx !== undefined) {
    if (
      typeof geo.plateDiameterPx !== 'number' ||
      !Number.isFinite(geo.plateDiameterPx) ||
      geo.plateDiameterPx <= 0 ||
      geo.plateDiameterPx > Math.max(geo.widthPx, geo.heightPx)
    ) {
      invalid('INVALID_GEOMETRY', 'Plate diameter must be a positive pixel length that fits the image.', {
        plateDiameterPx: geo.plateDiameterPx,
      });
    }
  }
  return geo as ImageGeometry;
}

/** Validates a contract-exact ReferencePortion record. */
export function validateReferencePortion(input: unknown): ReferencePortion {
  const ref = input as Partial<ReferencePortion> | undefined;
  if (!ref || typeof ref !== 'object') {
    invalid('INVALID_REFERENCE', 'A reference portion record is required.');
  }
  if (typeof ref.baselineId !== 'string' || ref.baselineId === '') {
    invalid('INVALID_REFERENCE', 'Reference portions need a baselineId.');
  }
  if (!isPositiveInt(ref.baselineVersion)) {
    invalid('INVALID_REFERENCE', 'baselineVersion must be a positive whole number.', {
      baselineVersion: ref.baselineVersion,
    });
  }
  if (typeof ref.itemId !== 'string' || ref.itemId === '') {
    invalid('INVALID_REFERENCE', 'Reference portions must point at a menu itemId.');
  }
  if (
    typeof ref.expectedAreaPx !== 'number' ||
    !Number.isFinite(ref.expectedAreaPx) ||
    ref.expectedAreaPx <= 0
  ) {
    // §7 rule 1: the baseline denominator must be finite and > 0.
    invalid('INVALID_REFERENCE', 'Expected uneaten area must be a finite pixel area greater than zero.', {
      itemId: ref.itemId,
      expectedAreaPx: ref.expectedAreaPx,
    });
  }
  const geometry = validateImageGeometry(ref.geometry);
  if (ref.expectedAreaPx > geometry.widthPx * geometry.heightPx) {
    invalid('INVALID_REFERENCE', 'Expected area cannot exceed the image area.', {
      itemId: ref.itemId,
      expectedAreaPx: ref.expectedAreaPx,
    });
  }
  if (!REFERENCE_SOURCES.includes(ref.source as ReferenceSource)) {
    invalid(
      'INVALID_REFERENCE',
      'Reference source must be reference_photo, manual_area, or gemini_estimate — the three must stay distinguishable.',
      { source: ref.source },
    );
  }
  if (ref.source === 'reference_photo' && typeof ref.referenceImageObjectId !== 'string') {
    invalid('INVALID_REFERENCE', 'A reference_photo baseline must reference its photo (referenceImageObjectId).', {
      baselineId: ref.baselineId,
    });
  }
  if (ref.referenceImageObjectId !== undefined && typeof ref.referenceImageObjectId !== 'string') {
    invalid('INVALID_REFERENCE', 'referenceImageObjectId must be an image object ID string.');
  }
  return ref as ReferencePortion;
}

/** Input for creating a new baseline; ID/version are derived, never supplied. */
export interface ReferencePortionInput {
  itemId: string;
  expectedAreaPx: number;
  geometry: ImageGeometry;
  source: ReferenceSource;
  referenceImageObjectId?: string;
}

/**
 * Creates a reference portion as a NEW baseline version (AGENTS.md 2.5):
 * version = latest existing version for the item + 1, with a fresh
 * baselineId. Existing baselines are never mutated — analyses that froze an
 * older baselineVersion keep resolving it.
 */
export function createReferencePortion(
  existingForItem: readonly ReferencePortion[],
  input: ReferencePortionInput,
): ReferencePortion {
  const wrongItem = existingForItem.find((ref) => ref.itemId !== input.itemId);
  if (wrongItem) {
    invalid('INVALID_REFERENCE', 'Existing baselines passed for the wrong menu item.', {
      expected: input.itemId,
      got: wrongItem.itemId,
    });
  }
  const latest = existingForItem.reduce((max, ref) => Math.max(max, ref.baselineVersion), 0);
  const baselineVersion = latest + 1;
  return validateReferencePortion({
    baselineId: makeBaselineId(input.itemId, baselineVersion),
    baselineVersion,
    itemId: input.itemId,
    expectedAreaPx: input.expectedAreaPx,
    geometry: input.geometry,
    source: input.source,
    ...(input.referenceImageObjectId !== undefined
      ? { referenceImageObjectId: input.referenceImageObjectId }
      : {}),
  });
}

export type ReferenceLookup =
  | { found: true; reference: ReferencePortion }
  | {
      found: false;
      itemId: string;
      /** Attach to the measurement; a missing baseline is never zero waste. */
      qualityFlag: 'missing_baseline';
      reason: string;
    };

/**
 * Resolves the latest baseline version for an item. Missing references are
 * explicit: the caller stores an unavailable percentage with this reason
 * (never a guessed zero) per §7 rule 1.
 */
export function resolveReferencePortion(
  references: readonly ReferencePortion[],
  itemId: string,
): ReferenceLookup {
  const candidates = references.filter((ref) => ref.itemId === itemId);
  if (candidates.length === 0) {
    return {
      found: false,
      itemId,
      qualityFlag: 'missing_baseline',
      reason: `No uneaten reference portion exists for ${itemId}; percentage unavailable until one is added.`,
    };
  }
  const reference = candidates.reduce((best, ref) =>
    ref.baselineVersion > best.baselineVersion ? ref : best,
  );
  return { found: true, reference };
}

export interface GeometryCompatibility {
  compatible: boolean;
  /** Plain-language reasons when incompatible; empty when compatible. */
  reasons: string[];
}

/**
 * §7 rule 3: observation and reference areas are comparable only with the
 * same coordinate space, the same normalized dimensions, and matching plate
 * geometry. Incompatible pairs must be flagged ('incompatible_geometry') and
 * grouped separately — never pooled.
 *
 * Unlike validateImageGeometry this never throws on a foreign coordinate
 * space: an unexpected space is exactly the incompatibility this check must
 * REPORT so the measurement gets flagged instead of crashing ingestion.
 */
export function checkGeometryCompatibility(
  observation: ImageGeometry,
  reference: ImageGeometry,
  options?: { diameterTolerance?: number },
): GeometryCompatibility {
  const tolerance = options?.diameterTolerance ?? DEFAULT_DIAMETER_TOLERANCE;
  const reasons: string[] = [];
  const a = observation;
  const b = reference;

  if (!isPositiveInt(a.widthPx) || !isPositiveInt(a.heightPx)) {
    reasons.push('Observation geometry has invalid pixel dimensions.');
  }
  if (!isPositiveInt(b.widthPx) || !isPositiveInt(b.heightPx)) {
    reasons.push('Reference geometry has invalid pixel dimensions.');
  }
  if (a.coordinateSpace !== COORDINATE_SPACE) {
    reasons.push(`Observation uses coordinate space "${a.coordinateSpace}" instead of "${COORDINATE_SPACE}".`);
  }
  if (a.coordinateSpace !== b.coordinateSpace) {
    reasons.push(`Different coordinate spaces (${a.coordinateSpace} vs ${b.coordinateSpace}).`);
  }
  if (a.widthPx !== b.widthPx || a.heightPx !== b.heightPx) {
    reasons.push(
      `Different normalized image sizes (${a.widthPx}x${a.heightPx} vs ${b.widthPx}x${b.heightPx}); raw pixels from differently scaled images are not comparable.`,
    );
  }
  if (a.plateShape !== undefined && b.plateShape !== undefined && a.plateShape !== b.plateShape) {
    reasons.push(`Different plate shapes (${a.plateShape} vs ${b.plateShape}).`);
  }
  if (a.plateDiameterPx !== undefined && b.plateDiameterPx !== undefined) {
    const larger = Math.max(a.plateDiameterPx, b.plateDiameterPx);
    const delta = Math.abs(a.plateDiameterPx - b.plateDiameterPx);
    if (delta / larger > tolerance) {
      reasons.push(
        `Plate diameters differ by more than ${Math.round(tolerance * 100)}% (${a.plateDiameterPx}px vs ${b.plateDiameterPx}px).`,
      );
    }
  }
  return { compatible: reasons.length === 0, reasons };
}
