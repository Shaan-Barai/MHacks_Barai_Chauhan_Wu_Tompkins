import { describe, expect, it } from 'vitest'
import { getCaptureImages, getCaptures, getDailyWaste, getImpactDashboard, getRecommendation } from './api'
import { CARBON_USD_PER_KG, MOCK_DINNER_FOODS, WATER_USD_PER_M3 } from './mockData'
import { addDays, todayIso } from '../lib/dates'

const today = todayIso()
const start = addDays(today, -29)

describe('mock impact dashboard (BIG-PLAN D1-D6)', () => {
  it('uses the 23 dinner foods, ranks targets by grams per portion and most wasted by grams', async () => {
    expect(MOCK_DINNER_FOODS).toHaveLength(23)
    const d = await getImpactDashboard(start, today)
    expect(d.labels).toEqual({ estimate: true, demoPortions: true })

    const ranked = d.targets.filter((r) => r.perPortion?.grams != null)
    const grams = ranked.map((r) => r.perPortion!.grams!)
    expect(grams).toEqual([...grams].sort((a, b) => b - a))
    // unavailable rates come last
    const firstUnranked = d.targets.findIndex((r) => r.perPortion?.grams == null)
    expect(d.targets.slice(firstUnranked).every((r) => r.perPortion?.grams == null)).toBe(true)

    const mw = d.mostWasted.filter((r) => r.impact.grams !== null).map((r) => r.impact.grams!)
    expect(mw).toEqual([...mw].sort((a, b) => b - a))
  })

  it('totals add up and the impact score excludes nutrition (0.19 C + 1.50 W)', async () => {
    const d = await getImpactDashboard(start, today)
    const t = d.totals
    expect(t.pixels).toBe(d.mostWasted.reduce((s, r) => s + r.impact.pixels, 0))
    expect(t.impactUsd!).toBeCloseTo(CARBON_USD_PER_KG * t.kgCo2e! + WATER_USD_PER_M3 * t.waterM3!, 6)
    expect(t.nutrientDaysLost).not.toBeNull()
    expect(t.analyzedCaptures + t.excludedCaptures).toBe(t.captures)
    // a plausible scale: a few kg to tens of kg per dinner of scanned plates
    expect(t.grams! / 30).toBeGreaterThan(1_000)
    expect(t.grams! / 30).toBeLessThan(60_000)
  })

  it('has explained unavailable rows: unknown food, missing portions', async () => {
    const d = await getImpactDashboard(start, today)
    const unknown = d.mostWasted.find((r) => r.itemId === null)
    expect(unknown?.impact.unavailableReason).toBe('unknown_item')
    expect(unknown?.impact.grams).toBeNull()
    const farro = d.targets.find((r) => r.displayName === 'Farro')
    expect(farro?.portionsServed).toBeNull()
    expect(farro?.perPortion).toBeNull()
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

describe('mock recommendation and daily grams', () => {
  it('is a labeled fallback citing numbers', async () => {
    const rec = await getRecommendation(start, today)
    expect(rec.source).toBe('fallback')
    expect(rec.bullets.length).toBeGreaterThan(0)
    expect(rec.bullets[0].metric).toMatch(/g per portion/)
  })

  it('daily points carry grams on days with plates', async () => {
    const pts = await getDailyWaste(addDays(today, -6), today)
    for (const p of pts) {
      if (p.pixelsWasted === null) expect(p.grams).toBeNull()
    }
  })
})
