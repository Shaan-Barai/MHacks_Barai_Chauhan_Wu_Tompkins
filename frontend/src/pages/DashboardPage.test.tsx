import { render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { DashboardPage } from './DashboardPage'
import { HOW_MEASURED } from '../components/impactCopy'
import { addDays, todayIso } from '../lib/dates'

/** BIG-PLAN v2: pixels and relative points only. */
const PHYSICAL_UNITS = /\d\s?(g|kg|L|m³)(?!\w)|litres|CO₂e|CO2e|\$|nutrient-days|estimated grams/

beforeAll(() => {
  // jsdom has no ResizeObserver (the chart measures its width with one).
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
})

describe('DashboardPage (mock data)', () => {
  it('renders the v2 dashboard: pixel totals, relative impact, pixel chart, and no physical units', async () => {
    const today = todayIso()
    const { container } = render(<DashboardPage range={{ start: addDays(today, -29), end: today }} onRangeChange={() => {}} />)

    expect(await screen.findByLabelText(/^Total waste: [\d,]+ pixels$/)).toBeInTheDocument()
    expect(screen.getByLabelText(/^Relative impact: [\d,.]+ points$/)).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Pixels wasted by day' })).toBeInTheDocument()
    expect(await screen.findByText('Foods to target')).toBeInTheDocument()
    // Plate photos moved to Behind the scenes; the daily chart sits above "What to try next".
    expect(screen.queryByRole('heading', { name: 'Plates' })).toBeNull()
    const chart = screen.getByRole('heading', { name: 'Pixels wasted by day' })
    const next = await screen.findByRole('heading', { name: 'What to try next' })
    expect(chart.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByRole('heading', { name: /Nutrition lost/ })).toBeInTheDocument()
    expect(screen.getByText(HOW_MEASURED)).toBeInTheDocument()
    expect(HOW_MEASURED).toMatch(/plate being scanned/)
    expect(HOW_MEASURED).toMatch(/relative/)

    const text = (container.textContent ?? '').replace(/not kg or litres|not kilograms, litres, or dollars/g, '')
    expect(text).not.toMatch(PHYSICAL_UNITS)
    expect(screen.queryByText('estimate')).toBeNull()
  })
})
