import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { EstimatedPounds } from './EstimatedPounds'
import type { EstimatedWeight } from '../data/types'

const base: EstimatedWeight = {
  available: true,
  isEstimate: true,
  method: 'plate-scale-v1',
  note: 'Estimate: assumes every plate is the configured diameter.',
  items: [],
  totals: { pixels: 150000, estimatedLb: 0.198, captures: 2, capturesWithScale: 1 },
}

describe('EstimatedPounds', () => {
  it('labels pounds as an estimate, with assumptions and coverage', () => {
    render(<EstimatedPounds data={base} />)
    expect(screen.getByText('Food left on plates (estimate)')).toBeTruthy()
    expect(screen.getByLabelText('Estimated food left on plates: 0.2 lb')).toBeTruthy()
    const tip = screen.getByRole('tooltip')
    expect(tip.textContent).toMatch(/Estimate: assumes every plate/)
    expect(tip.textContent).toMatch(/Covers 1 of 2 plates/)
    expect(screen.getByText(/150,000 pixels wasted measured/)).toBeTruthy()
  })

  it('shows a dash, never 0, without a plate scale', () => {
    render(<EstimatedPounds data={{ ...base, totals: { ...base.totals, estimatedLb: null, capturesWithScale: 0 } }} />)
    expect(screen.getByLabelText('Estimated food left on plates: not available')).toBeTruthy()
  })
})
