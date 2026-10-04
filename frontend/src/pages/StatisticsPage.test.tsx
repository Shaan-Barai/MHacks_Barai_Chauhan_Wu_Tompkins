import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { StatisticsPage } from './StatisticsPage'
import * as api from '../data/api'
import { addDays, todayIso } from '../lib/dates'

beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
})

afterEach(() => vi.restoreAllMocks())

describe('StatisticsPage (mock data)', () => {
  it('opens on the last 30 days with totals, the carbon chart, recommendations and the food rankings', async () => {
    const today = todayIso()
    const totals = vi.spyOn(api, 'getImpactDashboard')
    render(<StatisticsPage />)

    expect(screen.getByRole('heading', { name: 'Statistics', level: 1 })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Last 30 days' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Last 90 days' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByRole('button', { name: 'Today' })).toBeNull()

    // the mock calibrated the camera 20 days ago, so the last 30 days have estimates
    expect(await screen.findByLabelText(/^Carbon emissions: \d[\d,.]* (kg|g) CO2e$/)).toBeInTheDocument()
    expect(screen.getAllByText('est.').length).toBeGreaterThan(0)
    expect(screen.getByLabelText(/^Plates scanned: [\d,]+ plates$/)).toBeInTheDocument()
    expect(totals).toHaveBeenCalledWith(addDays(today, -29), today)

    expect(screen.getByRole('heading', { name: 'Carbon emissions by day' })).toBeInTheDocument()
    const recHeading = await screen.findByRole('heading', { name: 'Recommendations' })
    expect(within(recHeading.closest('div')!.parentElement!).getByRole('button', { name: 'Ask again' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Foods to target' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Most wasted foods' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Nutrition lost' })).toBeInTheDocument()
  })

  it('switches to the last 90 days and reloads', async () => {
    const today = todayIso()
    const totals = vi.spyOn(api, 'getImpactDashboard')
    const rec = vi.spyOn(api, 'getRecommendation')
    render(<StatisticsPage />)
    await screen.findByRole('heading', { name: 'Recommendations' })

    fireEvent.click(screen.getByRole('button', { name: 'Last 90 days' }))
    expect(screen.getByRole('button', { name: 'Last 90 days' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Last 30 days' })).toHaveAttribute('aria-pressed', 'false')
    await waitFor(() => expect(totals).toHaveBeenLastCalledWith(addDays(today, -89), today))
    await waitFor(() => expect(rec).toHaveBeenLastCalledWith(addDays(today, -89), today))
    expect(await screen.findByRole('heading', { name: 'Recommendations' })).toBeInTheDocument()
  })
})
