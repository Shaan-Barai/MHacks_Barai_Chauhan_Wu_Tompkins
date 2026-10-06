import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

const api = vi.hoisted(() => ({
  getTryImageStatus: vi.fn(),
  getTryImageSample: vi.fn(),
  submitTryImage: vi.fn(),
  getTryImageJob: vi.fn(),
}))

vi.mock('../data/api', async (orig) => ({ ...(await orig<typeof import('../data/api')>()), ...api }))

import App, { pageForPath } from '../App'
import { TRY_POLL_MS, TryImage } from './TryImage'

const OK = { available: true, waiting: 0, running: false, maxWaiting: 3, hourlyRemaining: 10 }
const PNG = 'data:image/png;base64,AAAA'
const DONE = {
  id: 'j1',
  status: 'done',
  summary: {
    capturePixelsWasted: 12345,
    foods: [
      { itemId: 'item_halal-rice', food: 'Halal Rice', pixelsWasted: 10000 },
      { itemId: 'item_halal-chicken', food: 'Halal Chicken', pixelsWasted: 2345 },
    ],
  },
  images: { original: PNG, boxes: PNG, masks: PNG, final: PNG },
}

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
})

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  Object.values(api).forEach((f) => f.mockReset())
  api.getTryImageStatus.mockResolvedValue(OK)
  localStorage.clear()
})

afterEach(() => {
  vi.useRealTimers()
  window.history.pushState(null, '', '/')
})

const pick = () => {
  const file = new File(['x'], 'plate.jpg', { type: 'image/jpeg' })
  fireEvent.change(screen.getByTestId('try-file'), { target: { files: [file] } })
}
const tick = () => act(async () => { await vi.advanceTimersByTimeAsync(TRY_POLL_MS + 10) })

describe('Try an Image', () => {
  it('uploads, shows queue then analysis, then the total, table and four pictures', async () => {
    api.submitTryImage.mockResolvedValue({ id: 'j1', status: 'queued', position: 2 })
    api.getTryImageJob.mockResolvedValueOnce({ id: 'j1', status: 'running' }).mockResolvedValue(DONE)
    render(<TryImage />)
    await waitFor(() => expect(api.getTryImageStatus).toHaveBeenCalled())
    pick()
    await screen.findByText(/Waiting in line/)
    expect(await screen.findByText('Waiting in line (position 2)')).toBeTruthy()
    await tick()
    expect(await screen.findByText(/Analyzing/)).toBeTruthy()
    await tick()
    expect((await screen.findByTestId('try-total')).textContent).toContain('12,345')
    expect(screen.getByText('Halal Rice')).toBeTruthy()
    expect(screen.getByText('10,000')).toBeTruthy()
    for (const c of ['Original photo', "Gemini's food boxes", 'SAM 2.1 masks', 'Counted result']) {
      expect(screen.getByAltText(c)).toBeTruthy()
    }
    fireEvent.click(screen.getByLabelText('Enlarge: SAM 2.1 masks'))
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByText('Try another photo'))
    expect(screen.getByText('Upload a photo')).toBeTruthy()
  })

  it('shows a dash, not zero, when the total is missing', async () => {
    api.submitTryImage.mockResolvedValue({ id: 'j1', status: 'queued', position: 1 })
    api.getTryImageJob.mockResolvedValue({ id: 'j1', status: 'done', summary: {} })
    render(<TryImage />)
    pick()
    await screen.findByText(/Waiting in line/)
    await tick()
    expect((await screen.findByTestId('try-total')).textContent).toContain('—')
  })

  it('shows a retry button when the job fails', async () => {
    api.submitTryImage.mockResolvedValue({ id: 'j1', status: 'queued', position: 1 })
    api.getTryImageJob.mockResolvedValue({ id: 'j1', status: 'failed', error: { code: 'X', message: 'No food found.' } })
    render(<TryImage />)
    pick()
    await screen.findByText(/Waiting in line/)
    await tick()
    expect(await screen.findByText('No food found.')).toBeTruthy()
    fireEvent.click(screen.getByText('Try again'))
    expect(screen.getByText('Upload a photo')).toBeTruthy()
  })

  it('shows the server message on a busy submit and the sample button posts a blob', async () => {
    api.getTryImageSample.mockResolvedValue(new Blob(['x'], { type: 'image/jpeg' }))
    api.submitTryImage.mockRejectedValue(new Error('Another photo is being checked. Try again soon.'))
    render(<TryImage />)
    fireEvent.click(screen.getByText('Use the sample photo'))
    expect(await screen.findByText(/Another photo is being checked/)).toBeTruthy()
    expect(api.submitTryImage).toHaveBeenCalledOnce()
  })

  it('disables the buttons with the reason when unavailable', async () => {
    api.getTryImageStatus.mockResolvedValue({ ...OK, available: false, reason: 'The analysis service is offline.' })
    render(<TryImage />)
    expect(await screen.findByText('The analysis service is offline.')).toBeTruthy()
    expect((screen.getByText('Upload a photo') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByText('Use the sample photo') as HTMLButtonElement).disabled).toBe(true)
  })

  it('stops polling on unmount', async () => {
    api.submitTryImage.mockResolvedValue({ id: 'j1', status: 'queued', position: 1 })
    api.getTryImageJob.mockResolvedValue({ id: 'j1', status: 'running' })
    const { unmount } = render(<TryImage />)
    pick()
    await screen.findByText(/Waiting in line/)
    await tick()
    const calls = api.getTryImageJob.mock.calls.length
    unmount()
    await tick()
    await tick()
    expect(api.getTryImageJob.mock.calls.length).toBe(calls)
  })
})

describe('Behind the scenes tabs', () => {
  it('maps the deep link to the behind page and keeps the nav item highlighted', () => {
    expect(pageForPath('/behind-the-scenes/try-an-image')).toBe('behind')
    expect(pageForPath('/behind-the-scenes/try-an-image/')).toBe('behind')
    window.history.pushState(null, '', '/behind-the-scenes/try-an-image')
    render(<App />)
    expect(screen.getByRole('tab', { name: 'Try an Image' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('link', { name: 'Behind the scenes' }).getAttribute('aria-current')).toBe('page')
  })

  it('switches tabs and updates the path', async () => {
    window.history.pushState(null, '', '/behind-the-scenes')
    render(<App />)
    expect(screen.getByRole('tab', { name: 'Scanned plates' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByRole('tab', { name: 'Try an Image' }))
    expect(window.location.pathname).toBe('/behind-the-scenes/try-an-image')
    expect(await screen.findByText('Use the sample photo')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'Scanned plates' }))
    expect(window.location.pathname).toBe('/behind-the-scenes')
  })
})
