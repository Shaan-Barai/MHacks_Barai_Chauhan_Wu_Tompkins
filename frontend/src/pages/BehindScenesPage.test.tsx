import { describe, expect, it } from 'vitest'
import { demoImageUrl, demoPlatesFor } from '../data/demoPlates'

describe('demo plate photos', () => {
  it('puts IMG_2697 at dinner on 2026-10-04 with the foods from its legend', () => {
    expect(demoPlatesFor('2026-10-04', 'lunch')).toEqual([])
    expect(demoPlatesFor('2026-10-03', 'dinner')).toEqual([])
    const [plate] = demoPlatesFor('2026-10-04', 'dinner')
    expect(plate.foods.map((f) => [f.name, f.pixelsWasted])).toEqual([
      ['Baked Sweet Potatoes', 113_812],
      ['Roasted Cauliflower', 110_329],
      ['Baked Boneless Ham', 35_024],
    ])
    expect(demoImageUrl(plate.imageObjectId)).toBe('/demo-plates/IMG_2697_segmentation.jpeg')
    expect(demoImageUrl('captures/real.jpg')).toBeNull()
  })
})
