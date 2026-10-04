import { afterEach, describe, expect, it, vi } from 'vitest'
import { getCaptureImages, getCaptures, getDailyWaste, getImpactDashboard, getRecommendation } from './liveApi'

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
    const item = { eventId: 'e1', capturedAt: '2026-10-03T23:00:00Z', serviceId: 's', source: 'camera', state: 'succeeded', pixelsWasted: 5, items: [], hasOverlay: true }
    vi.stubGlobal('fetch', respond(200, [item]))
    expect(await getCaptures('2026-10-03', '2026-10-03')).toEqual([item])
    vi.stubGlobal('fetch', respond(200, { captures: [item] }))
    expect(await getCaptures('2026-10-03', '2026-10-03')).toEqual([item])
  })

  it('keeps only pixels on daily points, ignoring any other field', async () => {
    vi.stubGlobal('fetch', respond(200, { days: [{ date: '2026-10-03', pixelsWasted: 100, grams: 12.5 }] }))
    expect(await getDailyWaste('2026-10-03', '2026-10-03')).toEqual([{ date: '2026-10-03', pixelsWasted: 100 }])
  })

  it('surfaces image-link errors (e.g. missing object) with the server message', async () => {
    vi.stubGlobal('fetch', respond(404, { error: { code: 'OBJECT_NOT_FOUND', message: 'Image not found', retryable: false } }))
    await expect(getCaptureImages('e1')).rejects.toThrow('Image not found')
  })
})
