import { beforeEach, expect, it } from 'vitest'
import { getPortionService, getPortionBenchmark, importPortionsCsv, savePortions, saveUserMenu, setApiLatency } from './api'

beforeEach(() => { localStorage.clear(); setApiLatency(0) })

it('mock portion counts persist, replace on re-import and never reinterpret estimates as pixels', async () => {
  await saveUserMenu('2026-10-03', { breakfast: [], lunch: [{ itemId: 'rice', displayName: 'Rice' }], dinner: [] })
  const service = (await getPortionService('2026-10-03', 'lunch'))!
  await savePortions(service, [{ itemId: 'rice', count: 400 }])
  await savePortions(service, [{ itemId: 'rice', count: 400 }])
  expect((await getPortionService('2026-10-03', 'lunch'))!.portions).toEqual([{ itemId: 'rice', count: 400, source: 'demo' }])
  const csv = `service_id,menu_version,item_id,portions_served\n${service.serviceId},1,rice,200\n`
  await importPortionsCsv(service, csv)
  const benchmark = await getPortionBenchmark(service.serviceId)
  expect(benchmark.items[0]).toMatchObject({ portionsServed: 200, pixelsWasted: null, pixelsWastedPerPortion: null, portionsSource: 'demo' })
  await expect(importPortionsCsv(service, csv.replace(',200', ',-2'))).rejects.toThrow()
  expect((await getPortionService('2026-10-03', 'lunch'))!.portions[0].count).toBe(200)
})
