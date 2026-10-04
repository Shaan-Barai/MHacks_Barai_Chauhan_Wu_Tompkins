import { afterEach, describe, expect, it, vi } from 'vitest'
import { getCaptureImages, getCaptures, getDailyWaste, getImpactDashboard, getRecommendation, getSummaryCards } from './liveApi'

function respond(status: number, body: unknown) {
  return vi.fn(async (_url: string) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('liveApi waste-impact endpoints', () => {
  it('calls the BIG-PLAN endpoints with the window and hall', async () => {
    const f = respond(200, { ok: true })
    vi.stubGlobal('fetch', f)
    await getImpactDashboard('2026-09-04', '2026-10-03')
    await getRecommendation('2026-09-04', '2026-10-03')
    await getCaptureImages('cap/1')
    const urls = f.mock.calls.map((c) => String(c[0]))
    expect(urls[0]).toBe('/api/dashboard/impact?hallId=hall-main&start=2026-09-04&end=2026-10-03')
    expect(urls[1]).toBe('/api/recommendation?hallId=hall-main&start=2026-09-04&end=2026-10-03')
    expect(urls[2]).toBe('/api/captures/cap%2F1/images')
  })

  it('accepts the capture list as an array or wrapped', async () => {
    const item = { eventId: 'e1', capturedAt: '2026-10-03T23:00:00Z', serviceId: 's', source: 'camera', state: 'succeeded', pixelsWasted: 5, grams: 1, items: [], hasOverlay: true }
    vi.stubGlobal('fetch', respond(200, [item]))
    expect(await getCaptures('2026-10-03', '2026-10-03')).toEqual([item])
    vi.stubGlobal('fetch', respond(200, { captures: [item] }))
    expect(await getCaptures('2026-10-03', '2026-10-03')).toEqual([item])
  })

  it('keeps grams on daily points only when the backend sends them', async () => {
    vi.stubGlobal('fetch', respond(200, { days: [{ date: '2026-10-03', pixelsWasted: 100, grams: 12.5 }] }))
    expect(await getDailyWaste('2026-10-03', '2026-10-03')).toEqual([{ date: '2026-10-03', pixelsWasted: 100, grams: 12.5 }])
  })

  it('shows one hall by hallId and every hall by leaving hallId out', async () => {
    const f = respond(200, { ok: true })
    vi.stubGlobal('fetch', f)
    await getImpactDashboard('2026-09-04', '2026-10-03', ['hall-b'])
    await getImpactDashboard('2026-09-04', '2026-10-03', ['hall-main', 'hall-b'])
    await getCaptures('2026-09-04', '2026-10-03', ['hall-main', 'hall-b'])
    await getRecommendation('2026-09-04', '2026-10-03', ['hall-main', 'hall-b'])
    const urls = f.mock.calls.map((c) => String(c[0]))
    expect(urls[0]).toBe('/api/dashboard/impact?hallId=hall-b&start=2026-09-04&end=2026-10-03')
    expect(urls[1]).toBe('/api/dashboard/impact?start=2026-09-04&end=2026-10-03')
    expect(urls[2]).toBe('/api/captures?start=2026-09-04&end=2026-10-03')
    expect(urls[3]).toBe('/api/recommendation?start=2026-09-04&end=2026-10-03')
  })

  it('adds up daily waste across halls by date, keeping no-data days empty', async () => {
    const byHall: Record<string, unknown> = {
      'hall-main': { days: [{ date: '2026-10-02', pixelsWasted: 100 }, { date: '2026-10-03', pixelsWasted: null }, { date: '2026-10-04', pixelsWasted: null }] },
      'hall-b': { days: [{ date: '2026-10-02', pixelsWasted: 50 }, { date: '2026-10-03', pixelsWasted: 20 }, { date: '2026-10-04', pixelsWasted: null }] },
    }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(byHall[new URL(url, 'http://x').searchParams.get('hallId')!]), { status: 200 })))
    expect(await getDailyWaste('2026-10-02', '2026-10-04', ['hall-main', 'hall-b'])).toEqual([
      { date: '2026-10-02', pixelsWasted: 150 },
      { date: '2026-10-03', pixelsWasted: 20 },
      { date: '2026-10-04', pixelsWasted: null },
    ])
  })

  it('combines summary cards across halls, averaging plate percent over all plates', async () => {
    const period = (px: number, prev: number | null, pct: number | null, plates: number) => ({ start: '2026-10-04', end: '2026-10-04', pixelsWasted: px, previousPixelsWasted: prev, averagePlateWastePercent: pct, platesCounted: plates })
    const cards = (p: ReturnType<typeof period>) => ({ today: p, thisWeek: p, thisMonth: p })
    const byHall: Record<string, unknown> = { 'hall-main': cards(period(100, 50, 30, 3)), 'hall-b': cards(period(40, null, 10, 1)) }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(byHall[new URL(url, 'http://x').searchParams.get('hallId')!]), { status: 200 })))
    const { today } = await getSummaryCards(['hall-main', 'hall-b'])
    expect(today).toEqual({ start: '2026-10-04', end: '2026-10-04', pixelsWasted: 140, previousPixelsWasted: 50, averagePlateWastePercent: 25, platesCounted: 4 })
  })

  it('surfaces image-link errors (e.g. missing object) with the server message', async () => {
    vi.stubGlobal('fetch', respond(404, { error: { code: 'OBJECT_NOT_FOUND', message: 'Image not found', retryable: false } }))
    await expect(getCaptureImages('e1')).rejects.toThrow('Image not found')
  })
})
