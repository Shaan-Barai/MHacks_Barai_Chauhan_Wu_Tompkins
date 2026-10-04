/** IT_4 mock estimates: uncalibrated, calibrated and partly calibrated windows; null (never 0) when unavailable. */
import { describe, expect, it } from 'vitest'
import { getCaptures, getImpactDashboard } from './api'
import { MOCK_CM2_PER_PX, MOCK_DINNER_FOODS, mockPhysical, mockPhysicalMethodFor } from './mockData'
import { addDays, todayIso } from '../lib/dates'

const today = todayIso()

describe('mock calibration timeline', () => {
  it('calibrated area for the last 20 days, nothing before', () => {
    expect(mockPhysicalMethodFor(today, today)).toBe('area-calibrated-v1')
    expect(mockPhysicalMethodFor(addDays(today, -2), today)).toBe('area-calibrated-v1')
    expect(mockPhysicalMethodFor(addDays(today, -20), today)).toBe('area-calibrated-v1')
    expect(mockPhysicalMethodFor(addDays(today, -21), today)).toBeNull()
  })

  it('area = pixels x k (calibration only), grams = area x weight per cm², CO2e = kg x C, water = grams x W', () => {
    const f = MOCK_DINNER_FOODS.find((x) => x.food === 'Ancho Flank Steak')!
    const p = mockPhysical(10_000, f, 'area-calibrated-v1')
    // A credit card (46.21 cm²) covers 30,730 pixels: 10,000 px = 15.04 cm².
    expect(MOCK_CM2_PER_PX).toBeCloseTo(46.21 / 30_730, 12)
    expect(p.areaCm2).toBeCloseTo(10_000 * MOCK_CM2_PER_PX, 9)
    expect(p.areaCm2).toBeCloseTo(15.0374, 3)
    expect('volumeCm3' in p).toBe(false)
    expect(p.grams).toBeCloseTo(p.areaCm2! * f.weight, 9)
    expect(p.kgCo2e).toBeCloseTo((p.grams! / 1000) * f.c, 9)
    expect(p.waterLitres).toBeCloseTo(p.grams! * f.w, 9)
  })

  it('unknown, no-factor and uncalibrated foods are null with a reason', () => {
    const salad = MOCK_DINNER_FOODS.find((x) => x.food === 'Panzanella Salad')!
    expect(mockPhysical(5_000, salad, 'area-calibrated-v1').grams).toBeGreaterThan(0)
    expect(mockPhysical(5_000, null, 'area-calibrated-v1')).toMatchObject({ grams: null, physicalUnavailableReason: 'no_factor' })
    expect(mockPhysical(5_000, salad, null)).toMatchObject({ grams: null, physicalUnavailableReason: 'no_calibration' })
    expect(mockPhysical(5_000, null, 'area-calibrated-v1', true)).toMatchObject({ grams: null, physicalUnavailableReason: 'unknown_item' })
  })
})

describe('mock impact dashboard estimates', () => {
  it('today is fully calibrated (area)', async () => {
    const d = await getImpactDashboard(today, today)
    if (d.totals.captures === 0) return // no menu today in this seed
    expect(d.totals.physicalMethod).toBe('area-calibrated-v1')
    // fully calibrated: grams per portion where the food has an estimate
    expect(d.targets.some((r) => r.perPortion?.grams != null)).toBe(true)
    expect(d.totals.physicalCoverage).toEqual({
      calibratedCaptures: d.totals.analyzedCaptures,
      analyzedCaptures: d.totals.analyzedCaptures,
    })
  })

  it('the last 30 days are partly calibrated, cover only calibrated plates, and totals add up', async () => {
    const d = await getImpactDashboard(addDays(today, -29), today)
    const t = d.totals
    expect(t.physicalMethod).toBe('area-calibrated-v1')
    const cov = t.physicalCoverage!
    expect(cov.calibratedCaptures).toBeGreaterThan(0)
    expect(cov.calibratedCaptures).toBeLessThan(cov.analyzedCaptures)
    expect(Object.keys(cov).sort()).toEqual(['analyzedCaptures', 'calibratedCaptures'])
    const sum = (k: 'grams' | 'kgCo2e' | 'waterLitres') => d.mostWasted.reduce((s, r) => s + (r.impact[k] ?? 0), 0)
    expect(t.grams).toBeCloseTo(sum('grams'), 6)
    expect(t.kgCo2e).toBeCloseTo(sum('kgCo2e'), 6)
    expect(t.waterLitres).toBeCloseTo(sum('waterLitres'), 6)
    // unavailable is null with a reason, never 0
    for (const r of d.mostWasted) {
      if (r.impact.grams === null) {
        expect(r.impact.kgCo2e).toBeNull()
        expect(r.impact.physicalUnavailableReason).toBeDefined()
      } else {
        expect(r.impact.grams).toBeGreaterThan(0)
      }
    }
    expect(d.mostWasted.find((r) => r.itemId === null)?.impact.physicalUnavailableReason).toBe('unknown_item')
    const soup = d.mostWasted.find((r) => r.displayName === "Chef's Soup of the Day")
    if (soup) expect(soup.impact).toMatchObject({ grams: null, physicalUnavailableReason: 'no_factor' })
    // a window that is only partly calibrated has no grams per portion (analytics rule)
    for (const r of d.targets) if (r.perPortion) expect(r.perPortion.grams).toBeNull()
  })

  it('a window before the calibration has no estimates at all', async () => {
    const d = await getImpactDashboard(addDays(today, -89), addDays(today, -60))
    expect(d.totals).toMatchObject({ grams: null, kgCo2e: null, waterLitres: null, physicalMethod: null, physicalUnavailableReason: 'no_calibration' })
    expect(d.totals.physicalCoverage!.calibratedCaptures).toBe(0)
    expect(d.mostWasted.every((r) => r.impact.grams === null)).toBe(true)
  })

  it('recent plates carry estimates per food; the demo photo at another size does not', async () => {
    const captures = await getCaptures(addDays(today, -6), today)
    const ok = captures.find((c) => c.state === 'succeeded' && c.source === 'camera' && c.items.length > 0)!
    expect(ok.physicalMethod).not.toBeNull()
    expect(ok.items.some((i) => (i.grams ?? 0) > 0)).toBe(true)
    const replay = captures.find((c) => c.source === 'replay' && c.items.length > 0)
    if (replay) {
      expect(replay.physicalMethod).toBeNull()
      expect(replay.items.every((i) => i.grams === null && i.physicalUnavailableReason === 'incompatible_geometry')).toBe(true)
    }
  })
})
