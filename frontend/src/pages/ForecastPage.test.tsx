import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ForecastPage } from './ForecastPage'
import { getForecastSummary } from '../data/api'
import type { ForecastSummary } from '../data/types'

vi.mock('../data/api', () => ({ getForecastSummary: vi.fn(), getForecastModels: vi.fn(async () => ({ available: false, hallId: 'hall-main', rows: [] })), USE_MOCK: false }))

const totals = {
  meals: 10, ranOutMeals: 2, ourWape: 0.18, fssWape: 0.41, ourStockouts: 3, fssStockouts: 2, ourWouldLeaveLb: 12.5,
  panLeftoverLb: 40, panLeftoverUsd: 203.2, trayWasteLb: null, trayWasteUsd: null, trayWasteSources: [], simulated: false,
}
const real: ForecastSummary = {
  available: true, hallId: 'hall-main', window: { start: '2026-10-01', end: '2026-10-23' }, model: 'baseline-v1', comparisonLabel: 'FSS', simulated: false,
  totals,
  dishes: [{ ...totals, dishId: 'rice', displayName: 'Sticky Rice', serviceStyle: 'side', avgRecommendedPrepLb: 38, avgFssLb: null, avgConsumedLb: 36.1 }],
  upcoming: [{ serviceDate: '2026-10-25', mealLabel: 'lunch', dishId: 'rice', displayName: 'Sticky Rice', recommendedPrepLb: 38.5, lowLb: 29, highLb: 44, fssForecastLb: null, expectedDiners: 690, why: 'Sticky Rice: 36 lb expected.', simulated: false }],
}

beforeEach(() => vi.clearAllMocks())

describe('Forecast', () => {
  it('shows ours vs. FSS, per-dish actuals and the coming week; unknown values are dashes, not 0', async () => {
    vi.mocked(getForecastSummary).mockResolvedValue(real)
    render(<ForecastPage />)
    expect(await screen.findByLabelText('Forecast error: ours vs. FSS: 18% vs. 41%')).toBeInTheDocument()
    expect(screen.getByLabelText('Stockouts: ours vs. FSS: 3 vs. 2')).toBeInTheDocument()
    expect(screen.getByLabelText('Tray waste: —')).toBeInTheDocument()
    expect(screen.getByText(/needs calibrated scans/)).toBeInTheDocument()
    const table = screen.getByRole('table')
    expect(within(table).getByText('Sticky Rice')).toBeInTheDocument()
    expect(within(table).getAllByText('—').length).toBeGreaterThan(0)
    expect(screen.getByRole('region', { name: '2026-10-25 lunch' })).toHaveTextContent('38.5 lb')
    expect(screen.queryByRole('note')).toBeNull()
  })

  it('shows the SIMULATED DATA banner whenever simulated rows are shown', async () => {
    vi.mocked(getForecastSummary).mockResolvedValue({ ...real, comparisonLabel: 'Simulated FSS (assumed +25% over-prep)', simulated: true, totals: { ...totals, simulated: true, trayWasteLb: 5, trayWasteUsd: 25, trayWasteSources: ['simulated'] } })
    render(<ForecastPage />)
    expect(await screen.findByRole('note')).toHaveTextContent(/Simulated data/i)
    // The simulated comparison is never called plain "FSS".
    expect(screen.getByLabelText('Forecast error: ours vs. Simulated FSS (assumed +25% over-prep): 18% vs. 41%')).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Simulated FSS (assumed +25% over-prep)' })).toBeInTheDocument()
    expect(screen.getByText(/it is not real FSS data/)).toBeInTheDocument()
    expect(screen.getByText(/· simulated/)).toBeInTheDocument()
  })

  it('explains when forecasts are not available', async () => {
    vi.mocked(getForecastSummary).mockResolvedValue({ available: false, hallId: 'hall-main', window: { start: 'a', end: 'b' }, model: 'baseline-v1' })
    render(<ForecastPage />)
    expect(await screen.findByText('Forecasts are not set up on this server.')).toBeInTheDocument()
  })
})
