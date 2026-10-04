import { render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { DashboardPage } from './DashboardPage'
import { HOW_MEASURED } from '../components/impactCopy'
import { addDays, todayIso } from '../lib/dates'

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
  it('renders pixel totals first, estimated CO2e and water with coverage, relative impact, the chart and plates', async () => {
    const today = todayIso()
    render(<DashboardPage range={{ start: addDays(today, -29), end: today }} onRangeChange={() => {}} />)

    expect(await screen.findByLabelText(/^Total waste: [\d,]+ pixels$/)).toBeInTheDocument()
    expect(screen.getByLabelText(/^Relative impact: [\d,.]+ points$/)).toBeInTheDocument()
    // IT_4: estimates only from calibrated plates (the mock calibrated 20 days ago); no method breakdown.
    expect(screen.getByLabelText(/^Estimated CO2e: [\d,.]+ kg CO2e$/)).toBeInTheDocument()
    expect(screen.getByLabelText(/^Estimated water: [\d,.]+ L$/)).toBeInTheDocument()
    expect(screen.getAllByText(/^From [\d,]+ of [\d,]+ plates \(calibrated\)$/)).toHaveLength(2)
    expect(screen.queryByText(/^Method:/)).toBeNull()

    expect(await screen.findByRole('heading', { name: 'Pixels wasted by day' })).toBeInTheDocument()
    expect(await screen.findByText('Foods to target')).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Plates' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /Nutrition lost/ })).toBeInTheDocument()
    expect(screen.getByText(HOW_MEASURED)).toBeInTheDocument()
    expect(HOW_MEASURED).toMatch(/plate being scanned/)
    expect(HOW_MEASURED).toMatch(/relative/)
    // food rows carry estimated chips, labeled est.
    expect(screen.getAllByText('est.').length).toBeGreaterThan(0)
  })

  it('has no estimates for days before the camera was calibrated', async () => {
    const today = todayIso()
    render(<DashboardPage range={{ start: addDays(today, -89), end: addDays(today, -60) }} onRangeChange={() => {}} />)
    expect(await screen.findByLabelText(/^Total waste: [\d,]+ pixels$/)).toBeInTheDocument()
    expect(screen.getAllByText(/No plates in these days were scanned with a calibrated camera/)).toHaveLength(2)
    expect(screen.queryByText('est.')).toBeNull()
    expect(screen.queryByText(/\d kg CO2e/)).toBeNull()
  })
})
