import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { DashboardPage } from './DashboardPage'
import * as api from '../data/api'
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

afterEach(() => vi.restoreAllMocks())

/** An estimate card shows a labeled amount or "not available", never a bare 0. */
const CARBON = /^Carbon emissions: (\d[\d,.]* (kg|g) CO2e|not available)$/
const WATER = /^Water: (\d[\d,.]* L|not available)$/
const FOOD = /^Food wasted: (\d[\d,.]* (kg|g)|not available)$/

describe('DashboardPage (mock data)', () => {
  it('opens on the last 30 days with the four headline cards and the carbon chart; no pixels, plates or recommendation', async () => {
    const daily = vi.spyOn(api, 'getDailyImpact')
    const totals = vi.spyOn(api, 'getImpactDashboard')
    const today = todayIso()
    const { container } = render(<DashboardPage />)

    expect(screen.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Last 30 days' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Last 7 days' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'Today' })).toHaveAttribute('aria-pressed', 'false')

    expect(await screen.findByLabelText(CARBON)).toBeInTheDocument()
    expect(screen.getByLabelText(WATER)).toBeInTheDocument()
    expect(screen.getByLabelText(FOOD)).toBeInTheDocument()
    expect(screen.getByLabelText(/^Plates scanned: [\d,]+ plates$/)).toBeInTheDocument()
    expect(totals).toHaveBeenCalledWith(addDays(today, -29), today)

    expect(await screen.findByRole('heading', { name: 'Carbon emissions by day' })).toBeInTheDocument()
    expect(daily).toHaveBeenLastCalledWith(addDays(today, -29), today)

    expect(screen.queryByRole('heading', { name: 'Plates' })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Recommendations' })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Foods to target' })).toBeNull()
    expect(container.textContent).not.toMatch(/pixels|points/i)
  })

  it('Last 7 days reloads the totals and charts the last 7 days', async () => {
    const daily = vi.spyOn(api, 'getDailyImpact')
    const totals = vi.spyOn(api, 'getImpactDashboard')
    const today = todayIso()
    render(<DashboardPage />)
    await screen.findByLabelText(CARBON)

    fireEvent.click(screen.getByRole('button', { name: 'Last 7 days' }))
    expect(screen.getByRole('button', { name: 'Last 7 days' })).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() => expect(totals).toHaveBeenLastCalledWith(addDays(today, -6), today))
    await waitFor(() => expect(daily).toHaveBeenLastCalledWith(addDays(today, -6), today))
    expect(await screen.findByLabelText(/^Plates scanned: [\d,]+ plates$/)).toBeInTheDocument()
  })

  it('Today shows one day of totals but still charts the last 7 days', async () => {
    const daily = vi.spyOn(api, 'getDailyImpact')
    const totals = vi.spyOn(api, 'getImpactDashboard')
    const today = todayIso()
    render(<DashboardPage />)
    await screen.findByLabelText(CARBON)

    fireEvent.click(screen.getByRole('button', { name: 'Today' }))
    await waitFor(() => expect(totals).toHaveBeenLastCalledWith(today, today))
    await waitFor(() => expect(daily).toHaveBeenLastCalledWith(addDays(today, -6), today))
  })

  it('shows a subtle notice when the demo view is cleared', async () => {
    vi.spyOn(api, 'getDemoStatus').mockResolvedValue({ hallId: 'hall-main', mode: 'cleared', sampleLoaded: false, sampleCaptures: 0, clearedAt: '2026-10-04T12:00:00Z' })
    render(<DashboardPage />)
    expect(await screen.findByText(/Showing scans since .* Restore the default view in Settings\./)).toBeInTheDocument()
  })
})
