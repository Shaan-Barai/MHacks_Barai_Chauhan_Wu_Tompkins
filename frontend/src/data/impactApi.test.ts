import { describe, expect, it } from 'vitest'
import { getCaptureImages, getCaptures, getDailyWaste, getImpactDashboard, getRecommendation } from './api'
import { CO2_WEIGHT, MOCK_DINNER_FOODS, WATER_WEIGHT } from './mockData'
import { addDays, todayIso } from '../lib/dates'

const today = todayIso()
const start = addDays(today, -29)

describe('mock impact dashboard (BIG-PLAN v2: pixels and relative points)', () => {
  it('uses the 23 dinner foods, ranks targets by pixels per portion and most wasted by pixels', async () => {
    expect(MOCK_DINNER_FOODS).toHaveLength(23)
    const d = await getImpactDashboard(start, today)
    expect(d.labels).toEqual({ relativeImpact: true, demoPortions: true })

    const ranked = d.targets.filter((r) => r.perPortion != null)
    const px = ranked.map((r) => r.perPortion!.pixels)
    expect(px).toEqual([...px].sort((a, b) => b - a))
    // unavailable rates come last
    const firstUnranked = d.targets.findIndex((r) => r.perPortion == null)
    expect(d.targets.slice(firstUnranked).every((r) => r.perPortion == null)).toBe(true)

    const mw = d.mostWasted.map((r) => r.impact.pixels)
    expect(mw).toEqual([...mw].sort((a, b) => b - a))
  })

  it('points follow pixels/1000 x weight x factor, totals add up, and the score excludes nutrition', async () => {
    const d = await getImpactDashboard(start, today)
    const t = d.totals
    expect(t.pixels).toBe(d.mostWasted.reduce((s, r) => s + r.impact.pixels, 0))
    expect(t.impactPoints!).toBeCloseTo(CO2_WEIGHT * t.co2Points! + WATER_WEIGHT * t.waterPoints!, 6)
    expect(t.nutritionPoints).not.toBeNull()
    expect(t.analyzedCaptures + t.excludedCaptures).toBe(t.captures)
    expect(d.coverage.capturesWithNeighborFoodExcluded).toBeGreaterThanOrEqual(0)

    const steak = d.mostWasted.find((r) => r.displayName === 'Ancho Flank Steak')
    if (steak) {
      const f = MOCK_DINNER_FOODS.find((x) => x.food === 'Ancho Flank Steak')!
      expect(steak.impact.co2Points!).toBeCloseTo((steak.impact.pixels / 1000) * f.weight * f.c, 6)
      expect(steak.impact.waterPoints!).toBeCloseTo((steak.impact.pixels / 1000) * f.weight * f.w, 6)
      expect(steak.impact.nutritionPoints!).toBeCloseTo((steak.impact.pixels / 1000) * f.weight * f.o, 6)
    }
    // per portion = summed pixels / summed portions
    for (const r of d.targets) {
      if (r.perPortion) expect(r.perPortion.pixels).toBeCloseTo(r.impact.pixels / r.portionsServed!, 6)
    }
    // factor-table internals never leak into the payload (estimates are tested in physicalMock.test.ts)
    expect(JSON.stringify(d)).not.toMatch(/waterM3|impactUsd|nutrientDays/)
  })

  it('has explained unavailable rows: unknown food, missing portions, no factor', async () => {
    const d = await getImpactDashboard(start, today)
    const unknown = d.mostWasted.find((r) => r.itemId === null)
    expect(unknown?.impact.unavailableReason).toBe('unknown_item')
    expect(unknown?.impact.impactPoints).toBeNull()
    const farro = d.targets.find((r) => r.displayName === 'Farro')
    if (farro) {
      expect(farro.portionsServed).toBeNull()
      expect(farro.perPortion).toBeNull()
    }
  })
})

describe('mock captures and images', () => {
  it('lists recent plates newest first with failed and clean plates, and images with expiry', async () => {
    const caps = await getCaptures(start, today)
    expect(caps.length).toBeGreaterThan(0)
    const times = caps.map((c) => c.capturedAt)
    expect(times).toEqual([...times].sort().reverse())
    expect(caps.some((c) => c.state === 'failed' && c.pixelsWasted === null)).toBe(true)
    expect(caps.some((c) => c.state === 'succeeded' && c.pixelsWasted === 0)).toBe(true)

    const withOverlay = caps.find((c) => c.hasOverlay && c.items.length > 0)!
    const imgs = await getCaptureImages(withOverlay.eventId)
    expect(imgs.original?.url).toMatch(/^data:image\/svg\+xml/)
    expect(imgs.overlay?.url).toMatch(/^data:image\/svg\+xml/)
    expect(imgs.masks).toHaveLength(withOverlay.items.length)
    expect(Date.parse(imgs.original!.expiresAt)).toBeGreaterThan(Date.now())

    const failed = caps.find((c) => c.state === 'failed')!
    expect((await getCaptureImages(failed.eventId)).overlay).toBeNull()
    await expect(getCaptureImages('nope')).rejects.toThrow()
  })
})

describe('mock recommendation and daily pixels', () => {
  it('is a labeled fallback citing pixel numbers', async () => {
    const rec = await getRecommendation(start, today)
    expect(rec.source).toBe('fallback')
    expect(rec.bullets.length).toBeGreaterThan(0)
    expect(rec.bullets[0].metric).toMatch(/pixels wasted per portion/)
    expect(JSON.stringify(rec)).not.toMatch(/\d g\b|kg|CO2e|litre|\$/)
  })

  it('daily points carry only pixels', async () => {
    const pts = await getDailyWaste(addDays(today, -6), today)
    expect(pts).toHaveLength(7)
    for (const p of pts) expect(Object.keys(p).sort()).toEqual(['date', 'pixelsWasted'])
  })
})
