import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SummaryCardsRow } from './SummaryCards'
import type { SummaryCards } from '../data/types'

const data: SummaryCards = {
  today: { start: '2026-10-03', end: '2026-10-03', pixelsWasted: 1200, previousPixelsWasted: 1000 },
  thisWeek: { start: '2026-09-28', end: '2026-10-03', pixelsWasted: 8000, previousPixelsWasted: 10000 },
  thisMonth: { start: '2026-10-01', end: '2026-10-03', pixelsWasted: 3000, previousPixelsWasted: null },
}

describe('SummaryCardsRow', () => {
  it('shows the three cards with deltas colored by direction (Tomato up, Basil down)', () => {
    render(<SummaryCardsRow data={data} />)
    expect(screen.getByText("Today's waste")).toBeInTheDocument()
    expect(screen.getByText("This week's waste")).toBeInTheDocument()
    expect(screen.getByText("This month's waste")).toBeInTheDocument()

    const up = screen.getByText('+20%').closest('p')!
    expect(up.className).toContain('text-tomato')
    const down = screen.getByText('−20%').closest('p')!
    expect(down.className).toContain('text-basil')
    expect(screen.getByText('No previous period to compare')).toBeInTheDocument()
  })
})
