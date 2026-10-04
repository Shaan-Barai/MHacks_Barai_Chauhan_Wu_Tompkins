import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DemoDataCard, ClearedNotice } from './DemoDataCard'
import { AuthRequiredError } from '../data/authEvents'
import * as api from '../data/api'
import type { DemoStatus } from '../data/types'

vi.mock('../data/api', () => ({ getDemoStatus: vi.fn(), loadDemoData: vi.fn(), clearDemoData: vi.fn(), restoreDemoData: vi.fn() }))

const st = (over: Partial<DemoStatus>): DemoStatus => ({ hallId: 'hall-main', mode: 'default', sampleLoaded: false, sampleCaptures: 0, clearedAt: null, ...over })

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.getDemoStatus).mockResolvedValue(st({}))
})

describe('DemoDataCard', () => {
  it('describes each mode and hides Restore in default', async () => {
    const { unmount } = render(<DemoDataCard />)
    expect(await screen.findByText('Showing the real scans.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Restore default' })).toBeNull()
    unmount()

    vi.mocked(api.getDemoStatus).mockResolvedValue(st({ mode: 'sample', sampleLoaded: true, sampleCaptures: 42 }))
    const r2 = render(<DemoDataCard />)
    expect(await screen.findByText(/42 labeled sample scans over the last 14 days. They are not real./)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Restore default' })).toBeInTheDocument()
    r2.unmount()

    vi.mocked(api.getDemoStatus).mockResolvedValue(st({ mode: 'cleared', clearedAt: '2026-10-04T12:00:00Z' }))
    render(<DemoDataCard />)
    expect(await screen.findByText(/^Cleared at .*Nothing was deleted\.$/)).toBeInTheDocument()
  })

  it('Load calls the API and bumps the data revision', async () => {
    vi.mocked(api.loadDemoData).mockResolvedValue(st({ mode: 'sample', sampleLoaded: true, sampleCaptures: 42 }))
    const onDataChanged = vi.fn()
    render(<DemoDataCard onDataChanged={onDataChanged} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Load dummy data' }))
    await waitFor(() => expect(onDataChanged).toHaveBeenCalledTimes(1))
    expect(await screen.findByText(/Sample data is loaded/)).toBeInTheDocument()
  })

  it('Clear asks for confirmation first', async () => {
    vi.mocked(api.clearDemoData).mockResolvedValue(st({ mode: 'cleared', clearedAt: '2026-10-04T12:00:00Z' }))
    const onDataChanged = vi.fn()
    render(<DemoDataCard onDataChanged={onDataChanged} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Clear data' }))
    expect(api.clearDemoData).not.toHaveBeenCalled()
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Yes, clear data' }))
    await waitFor(() => expect(onDataChanged).toHaveBeenCalled())
    expect(api.clearDemoData).toHaveBeenCalledTimes(1)
  })

  it('shows a sign-in prompt on 401 and an error message otherwise', async () => {
    vi.mocked(api.loadDemoData).mockRejectedValueOnce(new AuthRequiredError())
    render(<DemoDataCard />)
    fireEvent.click(await screen.findByRole('button', { name: 'Load dummy data' }))
    expect(await screen.findByText('Sign in as staff to change demo data')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()

    vi.mocked(api.loadDemoData).mockRejectedValueOnce(new Error('Backend broke'))
    fireEvent.click(screen.getByRole('button', { name: 'Load dummy data' }))
    expect(await screen.findByText('Backend broke')).toBeInTheDocument()
    expect(screen.queryByText('Sign in as staff to change demo data')).toBeNull()
  })
})

describe('ClearedNotice', () => {
  it('shows only for cleared mode', () => {
    const { rerender } = render(<ClearedNotice status={st({ mode: 'cleared', clearedAt: '2026-10-04T12:00:00Z' })} />)
    expect(screen.getByText(/Showing scans since .* Restore the default view in Settings\./)).toBeInTheDocument()
    rerender(<ClearedNotice status={st({ mode: 'sample' })} />)
    expect(screen.queryByRole('note')).toBeNull()
  })
})
