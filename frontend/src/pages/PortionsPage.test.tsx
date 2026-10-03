import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PortionsPage } from './PortionsPage'
import { getPortionService, getPortionBenchmark, savePortions } from '../data/api'

vi.mock('../data/api', () => ({ getPortionService: vi.fn(), getPortionBenchmark: vi.fn(), savePortions: vi.fn(), importPortionsCsv: vi.fn(), USE_MOCK: false }))
const service = { serviceId: 'svc', menuVersion: 1, items: [{ itemId: 'rice', displayName: 'Rice' }, { itemId: 'soup', displayName: 'Soup' }], portions: [{ itemId: 'rice', count: 400, source: 'manual' as const }] }
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getPortionService).mockResolvedValue(service)
  vi.mocked(getPortionBenchmark).mockResolvedValue({ hallId: 'hall', serviceId: 'svc', serviceDate: '2026-10-03', menuVersion: 1,
    items: [{ itemId: 'rice', displayName: 'Rice', portionsServed: 400, portionsSource: 'manual', pixelsWasted: 20000, pixelsWastedPerPortion: 50, measuredCaptures: 3, unavailableReason: null }],
    capturedDishes: 4, measuredDishes: 3, excludedMeasurements: 1, label: 'Pixels wasted per portion', unit: 'pixels/portion', coverageNote: '3 of 4 captured dishes measured. Coverage is limited.' })
  vi.mocked(savePortions).mockResolvedValue(undefined)
})

describe('Portions served', () => {
  it('saves explicit zero versus unknown, preserves stable IDs and displays the benchmark', async () => {
    const onSaved = vi.fn()
    render(<PortionsPage onSaved={onSaved} />)
    const rice = await screen.findByRole('spinbutton', { name: 'Rice' })
    expect(rice).toHaveValue(400)
    const soup = screen.getByRole('spinbutton', { name: 'Soup' })
    expect(soup).toHaveValue(null)
    fireEvent.change(rice, { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save portions served' }))
    await waitFor(() => expect(savePortions).toHaveBeenCalledWith(service, [{ itemId: 'rice', count: 0 }, { itemId: 'soup', count: null }]))
    expect(onSaved).toHaveBeenCalledOnce()
    expect(await screen.findByRole('status')).toHaveTextContent('Counts saved')
    expect(await screen.findByRole('table')).toHaveTextContent('Pixels/portion')
    expect(screen.getByText(/Coverage is limited/)).toBeInTheDocument()
  })

  it('provides a missing-menu action and reports failed saves', async () => {
    vi.mocked(savePortions).mockRejectedValue(new Error('The menu changed. Reload it.'))
    const view = render(<PortionsPage onSaved={vi.fn()} />)
    await screen.findByRole('spinbutton', { name: 'Rice' })
    fireEvent.click(screen.getByRole('button', { name: 'Save portions served' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The menu changed')
    view.unmount()
    vi.mocked(getPortionService).mockResolvedValue(null)
    render(<PortionsPage onSaved={vi.fn()} />)
    expect(await screen.findByText('Add this meal’s menu first.')).toBeInTheDocument()
  })
})
