import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { DashboardPage } from './DashboardPage'
import * as api from '../data/api'
import { thisWeek } from '../components/DateRangePicker'
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
  it('opens on Today with the four headline cards and the carbon chart for the last 7 days; no pixels, plates or recommendation', async () => {
    const daily = vi.spyOn(api, 'getDailyImpact')
    const totals = vi.spyOn(api, 'getImpactDashboard')
    const today = todayIso()
    const { container } = render(<DashboardPage />)

    expect(screen.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Today' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'This week' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Last 30 days/ })).toBeNull()

    expect(await screen.findByLabelText(CARBON)).toBeInTheDocument()
    expect(screen.getByLabelText(WATER)).toBeInTheDocument()
    expect(screen.getByLabelText(FOOD)).toBeInTheDocument()
    expect(screen.getByLabelText(/^Plates scanned: [\d,]+ plates$/)).toBeInTheDocument()
    expect(totals).toHaveBeenCalledWith(today, today)

    // "Today" is one bar, so the chart covers the last 7 days
    expect(await screen.findByRole('heading', { name: 'Carbon emissions by day' })).toBeInTheDocument()
    expect(daily).toHaveBeenLastCalledWith(addDays(today, -6), today)

    expect(screen.queryByRole('heading', { name: 'Plates' })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Recommendations' })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Foods to target' })).toBeNull()
    expect(container.textContent).not.toMatch(/pixels|points/i)
  })

  it('This week reloads the totals and charts Monday to today', async () => {
    const daily = vi.spyOn(api, 'getDailyImpact')
    const totals = vi.spyOn(api, 'getImpactDashboard')
    render(<DashboardPage />)
    await screen.findByLabelText(CARBON)

    fireEvent.click(screen.getByRole('button', { name: 'This week' }))
    const week = thisWeek()
    expect(screen.getByRole('button', { name: 'This week' })).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() => expect(totals).toHaveBeenLastCalledWith(week.start, week.end))
    // a one-day week (Monday) still charts the last 7 days
    const chartStart = week.start === week.end ? addDays(week.end, -6) : week.start
    await waitFor(() => expect(daily).toHaveBeenLastCalledWith(chartStart, week.end))
    expect(await screen.findByLabelText(/^Plates scanned: [\d,]+ plates$/)).toBeInTheDocument()
  })
})
