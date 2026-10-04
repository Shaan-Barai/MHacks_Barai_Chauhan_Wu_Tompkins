import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SummaryCardsRow } from './SummaryCards'
import type { SummaryCards } from '../data/types'

const data: SummaryCards = {
  today: { start: '2026-10-03', end: '2026-10-03', pixelsWasted: 1200, previousPixelsWasted: 1000, averagePlateWastePercent: 32.4, platesCounted: 5 },
  thisWeek: { start: '2026-09-28', end: '2026-10-03', pixelsWasted: 8000, previousPixelsWasted: 10000, averagePlateWastePercent: 0, platesCounted: 1 },
  thisMonth: { start: '2026-10-01', end: '2026-10-03', pixelsWasted: 3000, previousPixelsWasted: null, averagePlateWastePercent: null, platesCounted: 0 },
}

describe('SummaryCardsRow', () => {
  it('shows each period with its plate percent and change in plain words', () => {
    render(<SummaryCardsRow data={data} />)
    expect(screen.getByText('Today')).toBeInTheDocument()
    expect(screen.getByText('This week')).toBeInTheDocument()
    expect(screen.getByText('This month')).toBeInTheDocument()

    expect(screen.getByText(/32% left per plate/)).toBeInTheDocument()
    expect(screen.getByText(/0% left per plate/)).toBeInTheDocument()
    expect(screen.getByText(/No plates scanned/)).toBeInTheDocument()
    expect(screen.getByText('Average of 5 plates')).toBeInTheDocument()

    expect(screen.getByText('Up 20%').closest('p')).toHaveTextContent('Up 20% from the day before')
    expect(screen.getByText('Down 20%').closest('p')).toHaveTextContent('from the same days last week')
    expect(screen.getByText('Nothing to compare with the same days last month yet')).toBeInTheDocument()
  })

  it('shows the waste score with its explanation and plates scanned', () => {
    const plates = { ...data.today, averagePlateWastePercent: null, platesCounted: 1234 }
    render(<SummaryCardsRow data={{ today: plates, thisWeek: plates, thisMonth: plates }} unit="score" />)
    expect(screen.getAllByText('Waste score')).toHaveLength(3)
    expect(screen.getAllByText('1,234 plates scanned')).toHaveLength(3)
    expect(screen.getAllByRole('tooltip')[0]).toHaveTextContent(/hidden cost of food left on plates/)
    expect(screen.queryByText('Pixels wasted')).toBeNull()
  })
})
