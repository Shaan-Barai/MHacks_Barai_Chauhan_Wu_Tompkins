import { afterEach, describe, expect, it, vi } from 'vitest'
import { getCaptures, getDailyWaste, getImpactDashboard, getMealDetail, getMenuDays, getRecommendation, saveUserMenuDays } from './liveApi'

function respond(body: unknown) {
  return vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('liveApi dining hall scope', () => {
  it('"All dining halls" (null) leaves hallId out so the backend adds every hall together', async () => {
    const f = respond({ days: [], captures: [] })
    vi.stubGlobal('fetch', f)
    await getImpactDashboard('2026-10-01', '2026-10-04', null)
    await getRecommendation('2026-10-01', '2026-10-04', null)
    await getCaptures('2026-10-01', '2026-10-04', null)
    await getDailyWaste('2026-10-01', '2026-10-04', null)
    const urls = f.mock.calls.map((c) => String(c[0]))
    expect(urls).toEqual([
      '/api/dashboard/impact?start=2026-10-01&end=2026-10-04',
      '/api/recommendation?start=2026-10-01&end=2026-10-04',
      '/api/captures?start=2026-10-01&end=2026-10-04',
      '/api/dashboard/daily?start=2026-10-01&end=2026-10-04',
    ])
  })

  it('a picked hall is sent as hallId; nothing picked uses the first hall', async () => {
    const f = respond({ dates: [], days: [] })
    vi.stubGlobal('fetch', f)
    await getDailyWaste('2026-10-04', '2026-10-04', 'hall-bursley')
    await getMenuDays('2026-10-04', '2026-10-04', 'hall-bursley')
    await getImpactDashboard('2026-10-04', '2026-10-04')
    const urls = f.mock.calls.map((c) => String(c[0]))
    expect(urls[0]).toBe('/api/dashboard/daily?hallId=hall-bursley&start=2026-10-04&end=2026-10-04')
    expect(urls[1]).toBe('/api/menus/days?hallId=hall-bursley&start=2026-10-04&end=2026-10-04')
    expect(urls[2]).toBe('/api/dashboard/impact?hallId=hall-main&start=2026-10-04&end=2026-10-04')
    vi.stubGlobal('fetch', respond({ summary: { captureCount: 0 } }))
    await getMealDetail('2026-10-04', 'lunch', 'hall-bursley')
  })

  it('a repeating menu is one upload with every date, for the chosen hall', async () => {
    const f = respond({ results: [] })
    vi.stubGlobal('fetch', f)
    await saveUserMenuDays(['2026-10-05', '2026-10-12'], { breakfast: [], lunch: [{ itemId: 'i', displayName: 'Halal Chicken' }], dinner: [] }, 'hall-bursley')
    expect(f).toHaveBeenCalledTimes(1)
    const [url, init] = f.mock.calls[0]
    expect(url).toBe('/api/menus/upload')
    expect(JSON.parse(String(init?.body))).toEqual({
      hallId: 'hall-bursley',
      hallTimezone: 'America/Detroit',
      days: [
        { date: '2026-10-05', lunch: ['Halal Chicken'] },
        { date: '2026-10-12', lunch: ['Halal Chicken'] },
      ],
    })
  })
})
