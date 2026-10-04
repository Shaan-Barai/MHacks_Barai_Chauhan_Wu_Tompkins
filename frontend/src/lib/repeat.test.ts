import { describe, expect, it } from 'vitest'
import { MAX_REPEAT_DAYS, repeatDates } from './repeat'

describe('repeatDates', () => {
  it('never repeats: just the first date', () => {
    expect(repeatDates('2026-10-05', 'never', '2026-12-31')).toEqual(['2026-10-05'])
  })

  it('steps by a day, a week, or two weeks, including the end date', () => {
    expect(repeatDates('2026-10-05', 'daily', '2026-10-07')).toEqual(['2026-10-05', '2026-10-06', '2026-10-07'])
    expect(repeatDates('2026-10-05', 'weekly', '2026-10-19')).toEqual(['2026-10-05', '2026-10-12', '2026-10-19'])
    expect(repeatDates('2026-10-05', 'biweekly', '2026-11-01')).toEqual(['2026-10-05', '2026-10-19'])
  })

  it('crosses month ends and caps how far ahead it reaches', () => {
    expect(repeatDates('2026-10-30', 'daily', '2026-11-02')).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02'])
    expect(repeatDates('2026-10-05', 'daily', '2028-01-01')).toHaveLength(MAX_REPEAT_DAYS)
  })

  it('an end date before the start saves only the first date', () => {
    expect(repeatDates('2026-10-05', 'weekly', '2026-10-01')).toEqual(['2026-10-05'])
  })
})
