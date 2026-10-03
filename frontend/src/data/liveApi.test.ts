import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDailyWaste, getMealDetail, saveUserMenu } from './liveApi'

function respond(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('liveApi', () => {
  it('converts pixel areas to waste units and keeps no-data days null', async () => {
    vi.stubGlobal(
      'fetch',
      respond(200, {
        days: [
          { date: '2026-10-02', observedRemainingAreaPx: 21300 },
          { date: '2026-10-03', observedRemainingAreaPx: null },
        ],
      }),
    )
    expect(await getDailyWaste('2026-10-02', '2026-10-03')).toEqual([
      { date: '2026-10-02', wasteUnits: 21.3 },
      { date: '2026-10-03', wasteUnits: null },
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

  it('maps a meal summary with coverage, simulated swipes, and the tip source', async () => {
    vi.stubGlobal(
      'fetch',
      respond(200, {
        serviceId: 'svc_hall-main_2026-10-03_dinner',
        summary: {
          captureCount: 3,
          succeededCaptureCount: 2,
          excludedCaptureCount: 1,
          excludedMeasurementCount: 1,
          observedRemainingAreaPx: 46050,
          items: [
            { itemId: 'zucchini', displayName: 'Roasted Zucchini', remainingAreaPx: 24500, shareOfMealWastePercent: 53.2 },
            { itemId: 'salmon', displayName: 'Teriyaki Salmon', remainingAreaPx: 21550, shareOfMealWastePercent: 46.8 },
          ],
        },
        attendance: { count: 748, source: 'simulated' },
        insight: { recommendation: 'Try smaller zucchini batches.', source: 'fallback_rules' },
      }),
    )
    const d = await getMealDetail('2026-10-03', 'dinner')
    expect(d).toMatchObject({
      totalWasteUnits: 46.1,
      platesScanned: 3,
      coverage: { platesAnalyzed: 2, platesLeftOut: 1, itemsLeftOut: 1 },
      mealSwipes: { count: 748, source: 'simulated' },
      tip: { source: 'fallback_rules' },
    })
    expect(d?.items[0]).toEqual({ itemId: 'zucchini', displayName: 'Roasted Zucchini', wasteUnits: 24.5, shareOfMealWastePercent: 53.2 })
  })

  it('keeps a scanned meal visible when every estimate was left out (never zero waste)', async () => {
    vi.stubGlobal(
      'fetch',
      respond(200, {
        serviceId: 'svc_hall-main_2026-10-02_lunch',
        summary: {
          captureCount: 1,
          succeededCaptureCount: 1,
          excludedCaptureCount: 0,
          excludedMeasurementCount: 3,
          observedRemainingAreaPx: 0,
          items: [],
        },
        attendance: { count: 512, source: 'simulated' },
        insight: null,
      }),
    )
    const d = await getMealDetail('2026-10-02', 'lunch')
    expect(d).toMatchObject({ platesScanned: 1, items: [], tip: null, coverage: { itemsLeftOut: 3 } })
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
