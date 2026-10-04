import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ESTIMATE_EXPLANATION, PhysicalChips, physicalReasonText } from './PhysicalChips'
import { formatAmount, formatGrams, formatKgCo2e, formatLitres, formatMass } from '../lib/format'

describe('estimate formatting', () => {
  it('rounds like the label example: 38 g · 1.1 kg CO2e · 18 L', () => {
    // food labels match the analytics overlay legend (formatPhysicalLabel)
    expect(formatGrams(38.4)).toBe('38 g')
    expect(formatGrams(1_234.4)).toBe('1,234 g')
    expect(formatKgCo2e(1.12)).toBe('1.1 kg CO2e')
    expect(formatKgCo2e(131.69)).toBe('130 kg CO2e')
    expect(formatKgCo2e(0.0342)).toBe('34 g CO2e')
    expect(formatLitres(18.2)).toBe('18 L')
    expect(formatLitres(0.523)).toBe('0.52 L')
    expect(formatLitres(1_234)).toBe('1,200 L')
    // totals and per-portion amounts
    expect(formatMass(4.25)).toBe('4.3 g')
    expect(formatMass(12_345)).toBe('12 kg')
    expect(formatAmount(1234.5)).toBe('1,235')
    expect(formatAmount(0)).toBe('0')
  })
})

describe('PhysicalChips', () => {
  it('shows grams, CO2e with a cloud and water with a droplet, with no est. mark, and a screen-reader sentence', () => {
    const { container } = render(<PhysicalChips amounts={{ grams: 38, kgCo2e: 1.1, waterLitres: 18 }} />)
    expect(screen.getByText('Estimated: 38 g, 1.1 kg CO2e, 18 L water.')).toHaveClass('sr-only')
    expect(screen.getByText('38 g')).toBeInTheDocument()
    expect(screen.getByText('1.1 kg CO2e')).toBeInTheDocument()
    expect(screen.getByText('18 L water')).toBeInTheDocument()
    expect(screen.queryByText('est.')).toBeNull()
    // two inline SVG icons, hidden from screen readers; no icon font or CDN
    const svgs = container.querySelectorAll('svg')
    expect(svgs).toHaveLength(2)
    svgs.forEach((s) => expect(s).toHaveAttribute('aria-hidden', 'true'))
    // no hover tooltip; the screen-reader sentence carries the estimate
    expect(container.firstElementChild).not.toHaveAttribute('title')
  })

  it('never shows 0 for a missing estimate: a muted reason, or nothing', () => {
    const { rerender, container } = render(<PhysicalChips amounts={{ grams: null, kgCo2e: null, waterLitres: null, physicalUnavailableReason: 'no_calibration' }} />)
    expect(screen.getByText('not calibrated')).toHaveClass('italic')
    rerender(<PhysicalChips amounts={{ grams: null, kgCo2e: null, waterLitres: null, physicalUnavailableReason: 'incompatible_geometry' }} />)
    expect(screen.getByText('photo size differs from the calibration')).toBeInTheDocument()
    rerender(<PhysicalChips amounts={{ grams: null, kgCo2e: null, waterLitres: null, physicalUnavailableReason: 'unknown_item' }} />)
    expect(container.textContent).toBe('')
    rerender(<PhysicalChips amounts={{}} showReason={false} />)
    expect(container.textContent).toBe('')
    expect(container.textContent).not.toMatch(/\b0\b/)
  })

  it('a real zero (a measured clean plate) is shown, and partial amounts show only what exists', () => {
    render(<PhysicalChips amounts={{ grams: 0, kgCo2e: null, waterLitres: null }} />)
    expect(screen.getByText('0 g')).toBeInTheDocument()
    expect(screen.queryByText(/CO2e/)).toBeNull()
  })

  it('the explainer says area comes from the camera calibration and grams from typical weight per cm²', () => {
    expect(ESTIMATE_EXPLANATION).toMatch(/area comes from the camera calibration \(a reference object of known area/)
    expect(ESTIMATE_EXPLANATION).toMatch(/grams from the food’s typical weight per cm²/)
    expect(ESTIMATE_EXPLANATION).not.toMatch(/density|depth|volume/i)
  })

  it('has plain words for every reason', () => {
    expect(physicalReasonText('no_factor')).toBe('no estimate for this food')
    expect(physicalReasonText('incompatible_geometry')).toBe('photo size differs from the calibration')
    // A reason from an older backend (the removed depth trial) says nothing rather than guessing.
    expect(physicalReasonText('no_density' as unknown as Parameters<typeof physicalReasonText>[0])).toBeNull()
    expect(physicalReasonText(undefined)).toBe('not calibrated')
    expect(physicalReasonText('unknown_item')).toBeNull()
  })
})
