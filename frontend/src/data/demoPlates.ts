/**
 * Demo plate photos for Behind the scenes, shown with the demo numbers
 * (api.ts DEMO_METRICS). Images live in frontend/public/demo-plates/; the
 * foods and pixel counts are copied from each image's own legend.
 */
import type { IsoDate, MealLabel, PlateRecord } from './types'

const DEMO_IMAGE_PREFIX = 'demo:'

const DEMO_PLATES: { date: IsoDate; meal: MealLabel; plate: PlateRecord }[] = [
  {
    // IMG_2697.jpeg: plate 1139px across = 26.7 cm (cut off), total 203.0 g, $2.784.
    date: '2026-10-04',
    meal: 'dinner',
    plate: {
      eventId: 'demo-img-2697',
      capturedAt: '2026-10-04T18:30:00-04:00',
      source: 'replay',
      state: 'succeeded',
      imageObjectId: `${DEMO_IMAGE_PREFIX}IMG_2697_segmentation.jpeg`,
      plateWastePercent: null,
      foods: [
        { itemId: 'baked-sweet-potatoes', name: 'Baked Sweet Potatoes', pixelsWasted: 113_812, percentOfServing: null, flags: [] },
        { itemId: 'roasted-cauliflower', name: 'Roasted Cauliflower', pixelsWasted: 110_329, percentOfServing: null, flags: [] },
        { itemId: 'baked-boneless-ham', name: 'Baked Boneless Ham', pixelsWasted: 35_024, percentOfServing: null, flags: [] },
      ],
    },
  },
]

export function demoPlatesFor(date: IsoDate, meal: MealLabel): PlateRecord[] {
  return DEMO_PLATES.filter((p) => p.date === date && p.meal === meal).map((p) => p.plate)
}

/** Demo photos are plain files served by the app, so they need no signed link. */
export function demoImageUrl(objectId: string): string | null {
  return objectId.startsWith(DEMO_IMAGE_PREFIX)
    ? `${import.meta.env.BASE_URL}demo-plates/${objectId.slice(DEMO_IMAGE_PREFIX.length)}`
    : null
}
