import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, assignHallIds, loadSettings, withHalls } from './settings'

describe('dining hall settings', () => {
  it('the first new hall is hall-main; others get unique IDs from their names; existing IDs are kept', () => {
    expect(assignHallIds([{ name: 'South Quad' }, { name: 'Bursley' }, { name: 'Bursley' }])).toEqual([
      { hallId: 'hall-main', name: 'South Quad' },
      { hallId: 'hall-bursley', name: 'Bursley' },
      { hallId: 'hall-bursley-2', name: 'Bursley' },
    ])
    expect(assignHallIds([{ hallId: 'hall-main', name: 'South Quad ' }, { name: 'Mosher-Jordan' }])).toEqual([
      { hallId: 'hall-main', name: 'South Quad' },
      { hallId: 'hall-mosher-jordan', name: 'Mosher-Jordan' },
    ])
  })

  it('hallId and name always follow the first hall', () => {
    const s = withHalls(DEFAULT_SETTINGS, [{ hallId: 'hall-x', name: 'X' }, { hallId: 'hall-y', name: 'Y' }])
    expect([s.hallId, s.name]).toEqual(['hall-x', 'X'])
  })

  it('settings saved with a single hall load as a one-hall list', () => {
    localStorage.setItem('scrap.hallSettings.v1', JSON.stringify({ hallId: 'hall-main', name: 'South Quad', timeSets: DEFAULT_SETTINGS.timeSets, events: [] }))
    expect(loadSettings()?.halls).toEqual([{ hallId: 'hall-main', name: 'South Quad' }])
  })
})
