import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PortionsPage as Page } from './PortionsPage'
import { AuthProvider } from '../state/auth'
import { getPortionService, getPortionBenchmark, savePortions } from '../data/api'

vi.mock('../data/api', () => ({ getPortionService: vi.fn(), getPortionBenchmark: vi.fn(), savePortions: vi.fn(), importPortionsCsv: vi.fn(), USE_MOCK: false }))
const service = { serviceId: 'svc', menuVersion: 1, items: [{ itemId: 'rice', displayName: 'Rice' }, { itemId: 'soup', displayName: 'Soup' }], portions: [{ itemId: 'rice', count: 400, source: 'manual' as const }] }
/** Signed-in staff (IT_4 I11): the counts form is only for staff. */
function PortionsPage(props: { onSaved: () => void }) {
  return <AuthProvider initialStatus="signedIn"><Page {...props} /></AuthProvider>
}

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
    expect(await screen.findByRole('table')).toHaveTextContent('Waste per portion')
    expect(screen.getByText(/Based on 3 of 4 scanned plates/)).toBeInTheDocument()
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

describe('Portions served on the read-only site', () => {
  it('lists the saved counts as text, with no inputs, save or upload', async () => {
    render(<AuthProvider initialStatus="signedOut" initialReadOnly><Page onSaved={vi.fn()} /></AuthProvider>)
    expect(await screen.findByText('400')).toBeInTheDocument()
    expect(screen.getByText('Unknown')).toBeInTheDocument()
    expect(screen.queryByRole('spinbutton')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save portions served' })).toBeNull()
    expect(screen.queryByLabelText('Upload filled portions sheet')).toBeNull()
    expect(await screen.findByRole('table')).toHaveTextContent('Waste per portion')
    expect(savePortions).not.toHaveBeenCalled()
  })
})
