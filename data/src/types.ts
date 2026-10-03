/**
 * Types used by the data package (Agent 2).
 *
 * Entity shapes come VERBATIM from contracts/types.ts — this file only
 * re-exports them and adds the upload-input shapes that menu parsing accepts.
 */

import type { MealService, MenuItem } from '../../contracts/types.js';

export type {
  MealLabel,
  MealService,
  MenuItem,
  ReferenceSource,
  ImageGeometry,
  ReferencePortion,
  ApiError,
} from '../../contracts/types.js';

/**
 * A daily per-meal menu as stored and served: the service plus its items.
 * Matches the backend's `MenuBundle` (backend/src/types.ts) so parsed menus
 * can be POSTed to /api/menus unchanged.
 */
export interface MenuBundle {
  service: MealService;
  items: MenuItem[];
}

/** One item in a typed menu upload: a plain name or a detailed object. */
export type MenuUploadItem =
  | string
  | {
      name: string;
      category?: string;
      description?: string;
    };

/** One day in a typed menu upload. At least one meal must be present. */
export interface MenuUploadDay {
  /** Local calendar date in the hall's timezone, YYYY-MM-DD. */
  date: string;
  breakfast?: MenuUploadItem[];
  lunch?: MenuUploadItem[];
  dinner?: MenuUploadItem[];
}

/**
 * Typed/JSON menu upload ("Upload menus myself" in UI.md): pick dates, add
 * items under Breakfast / Lunch / Dinner, several days at once.
 */
export interface MenuUpload {
  hallId: string;
  /** IANA timezone name, e.g. "America/Detroit". */
  hallTimezone: string;
  days: MenuUploadDay[];
}

/** Options required when the upload format (CSV) does not carry hall info. */
export interface HallContext {
  hallId: string;
  hallTimezone: string;
}
