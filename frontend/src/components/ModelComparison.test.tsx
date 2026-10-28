import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { ModelComparison } from './ModelComparison'
import { getForecastModels } from '../data/api'

describe('ModelComparison', () => {
  it('labels a simulated comparison everywhere and shows every row', async () => {
    const data = await getForecastModels()
    if (!data.available) throw new Error('mock comparison should be available')
    render(<ModelComparison data={data} />)
    expect(screen.getByText('Model comparison (simulated)')).toBeTruthy()
    expect(screen.getByRole('note').textContent).toMatch(/Simulated data/i)
    const rows = within(screen.getByRole('table')).getAllByRole('row')
    expect(rows).toHaveLength(1 + data.rows.length)
    expect(screen.getByText('Simulated FSS (assumed +25% over-prep)')).toBeTruthy()
    expect(screen.getAllByText('Matched stockouts').length).toBeGreaterThan(0)
  })

  it('shows a dash for an unknown value, never 0', () => {
    render(
      <ModelComparison
        data={{ available: true, hallId: 'h', runId: 'r', window: { start: '2026-09-26', end: '2026-10-23' }, generatedAt: '2026-10-28T00:00:00Z', simulated: false, comparisonLabel: 'FSS',
          rows: [{ runId: 'r', windowStart: '2026-09-26', windowEnd: '2026-10-23', modelVersion: 'fss', mode: 'as_given', meals: 10, censoredMeals: 1, wape: 0.3, bias: 0.1, stockouts: 2,
            leftoverLb: 12, leftoverUsd: 50, intervalCoverage: null, meanQ: null, comparisonLabel: 'FSS', isSimulated: false, generatedAt: '2026-10-28T00:00:00Z' }] }}
      />,
    )
    expect(screen.queryByRole('note')).toBeNull() // real data: no banner
    expect(screen.getAllByText('—').length).toBe(2)
  })
})
