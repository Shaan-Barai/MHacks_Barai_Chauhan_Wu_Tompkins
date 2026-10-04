import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDailyWaste, getMealDetail, saveUserMenu } from './liveApi'

function respond(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('liveApi', () => {
  it('passes Pixels wasted through unscaled and keeps no-data days null', async () => {
    vi.stubGlobal(
      'fetch',
      respond(200, {
        days: [
          { date: '2026-10-02', pixelsWasted: 21300, capturedDishes: 1, countedDishes: 1 },
          { date: '2026-10-03', pixelsWasted: null, capturedDishes: 0, countedDishes: 0 },
        ],
      }),
    )
    expect(await getDailyWaste('2026-10-02', '2026-10-03')).toEqual([
      { date: '2026-10-02', pixelsWasted: 21300 },
      { date: '2026-10-03', pixelsWasted: null },
    ])
  })

  it('turns a missing menu (404) into the friendly empty state', async () => {
    vi.stubGlobal('fetch', respond(404, { error: { code: 'MENU_NOT_FOUND', message: 'No menu', retryable: false } }))
    expect(await getMealDetail('2026-10-03', 'dinner')).toBeNull()
  })

  it('surfaces server errors instead of hiding them as empty data', async () => {
    vi.stubGlobal('fetch', respond(500, { error: { code: 'INTERNAL_ERROR', message: 'Database offline', retryable: true } }))
    await expect(getMealDetail('2026-10-03', 'dinner')).rejects.toThrow('Database offline')
  })

  it('maps a meal summary: pixels, coverage, unclassified food, simulated swipes, tip source', async () => {
    vi.stubGlobal(
      'fetch',
      respond(200, {
        serviceId: 'svc_hall-main_2026-10-03_dinner',
        summary: {
          captureCount: 3,
          countedCaptureCount: 2,
          emptyPlateCount: 1,
          excludedCaptureCount: 1,
          pixelsWasted: 46050,
          unclassifiedPixels: 1200,
          items: [
            { itemId: 'zucchini', displayName: 'Roasted Zucchini', pixelsWasted: 24500, captures: 1, shareOfMealPixelsPercent: 53.2 },
            { itemId: 'salmon', displayName: 'Teriyaki Salmon', pixelsWasted: 20350, captures: 1, shareOfMealPixelsPercent: 44.2 },
          ],
        },
        attendance: { count: 748, source: 'simulated' },
        insight: { recommendation: 'Try smaller zucchini batches.', source: 'fallback_rules' },
      }),
    )
    const d = await getMealDetail('2026-10-03', 'dinner')
    expect(d).toMatchObject({
      pixelsWasted: 46050,
      unclassifiedPixels: 1200,
      platesScanned: 3,
      coverage: { platesCounted: 2, emptyPlates: 1, platesLeftOut: 1 },
      mealSwipes: { count: 748, source: 'simulated' },
      tip: { source: 'fallback_rules' },
    })
    // No estimates in this payload: null, never 0 (IT_4 I1).
    expect(d?.items[0]).toEqual({
      itemId: 'zucchini',
      displayName: 'Roasted Zucchini',
      pixelsWasted: 24500,
      shareOfMealPixelsPercent: 53.2,
      grams: null,
      kgCo2e: null,
      waterLitres: null,
    })
  })

  it('keeps a scanned meal visible when no plate could be counted (never zero waste)', async () => {
    vi.stubGlobal(
      'fetch',
      respond(200, {
        serviceId: 'svc_hall-main_2026-10-02_lunch',
        summary: {
          captureCount: 1,
          countedCaptureCount: 0,
          emptyPlateCount: 0,
          excludedCaptureCount: 1,
          pixelsWasted: 0,
          unclassifiedPixels: 0,
          items: [],
        },
        attendance: { count: 512, source: 'simulated' },
        insight: null,
      }),
    )
    const d = await getMealDetail('2026-10-02', 'lunch')
    expect(d).toMatchObject({ platesScanned: 1, items: [], tip: null, coverage: { platesCounted: 0, platesLeftOut: 1 } })
  })

  it('uploads typed menus by item name through the validated upload endpoint', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes('/upload')
        ? new Response('{"results":[]}', { status: 201 })
        : new Response('{"error":{"code":"MENU_NOT_FOUND","message":"x"}}', { status: 404 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await saveUserMenu('2026-10-04', {
      breakfast: [],
      lunch: [{ itemId: 'x', displayName: 'Tomato Soup' }],
      dinner: [],
    })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/menus/upload')
    expect(JSON.parse(init.body as string)).toEqual({
      hallId: 'hall-main',
      hallTimezone: 'America/Detroit',
      days: [{ date: '2026-10-04', lunch: ['Tomato Soup'] }],
    })
  })
})
