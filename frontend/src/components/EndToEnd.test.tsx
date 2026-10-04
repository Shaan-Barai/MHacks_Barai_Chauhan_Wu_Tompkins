/**
 * End-to-end pipeline additions: period totals, Take photo, regenerating the
 * recommendation, the raw photo + enlarge in the gallery, and sample data.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import * as api from '../data/api'
import { PeriodTotals } from './PeriodTotals'
import { PlatesGallery } from './PlatesGallery'
import { RecommendationCard } from './RecommendationCard'
import { TakePhotoButton } from './TakePhotoButton'
import type { CaptureImages, CaptureListItem, Recommendation, WasteTotal } from '../data/types'

afterEach(() => vi.restoreAllMocks())

const future = () => new Date(Date.now() + 10 * 60_000).toISOString()

function total(over: Partial<WasteTotal> = {}): WasteTotal {
  return { start: '2026-10-04', end: '2026-10-04', pixels: 0, impactPoints: null, captures: 0, analyzedCaptures: 0, sampleCaptures: 0, ...over }
}

describe('PeriodTotals', () => {
  it('shows today, this week and this month in pixels, labeling sample data', () => {
    render(
      <PeriodTotals
        totals={{
          today: total({ pixels: 12_345, analyzedCaptures: 3, captures: 3, impactPoints: 10.5 }),
          week: total({ pixels: 98_765, analyzedCaptures: 20, captures: 21, sampleCaptures: 15 }),
          month: total(),
        }}
      />,
    )
    expect(screen.getByLabelText('Today: 12,345 pixels wasted')).toBeInTheDocument()
    expect(screen.getByLabelText('This week: 98,765 pixels wasted')).toBeInTheDocument()
    expect(screen.getByLabelText('This month: 0 pixels wasted')).toBeInTheDocument()
    expect(screen.getByText('includes sample data')).toBeInTheDocument()
    expect(screen.getByText('No plates counted yet')).toBeInTheDocument()
    expect(screen.getByText(/From 3 plates · 10.5 impact points/)).toBeInTheDocument()
  })
})

describe('TakePhotoButton', () => {
  it('is disabled with a hint when no camera is set up', async () => {
    render(<TakePhotoButton onTaken={() => {}} />)
    expect(await screen.findByText(/No camera set up/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Take photo' })).toBeDisabled()
  })

  it('takes a photo, reports the result and refreshes the dashboard', async () => {
    vi.spyOn(api, 'getCameraStatus').mockResolvedValue({ configured: true, host: '35.1.88.76', busy: false })
    const take = vi.spyOn(api, 'takePhoto').mockResolvedValue({
      ok: true, eventId: 'cap_1', serviceId: 'svc_1', state: 'succeeded', triggeredAt: 't0', receivedAt: 't1',
    })
    const onTaken = vi.fn()
    render(<TakePhotoButton onTaken={onTaken} />)
    const button = await screen.findByRole('button', { name: 'Take photo' })
    await waitFor(() => expect(button).toBeEnabled())
    fireEvent.click(button)
    expect(await screen.findByText('Photo taken and checked.')).toBeInTheDocument()
    expect(take).toHaveBeenCalledTimes(1)
    expect(onTaken).toHaveBeenCalledTimes(1)
  })

  it('shows the camera error in plain words', async () => {
    vi.spyOn(api, 'getCameraStatus').mockResolvedValue({ configured: true, busy: false })
    vi.spyOn(api, 'takePhoto').mockRejectedValue(new Error('Key login to arduino@35.1.88.76 was refused.'))
    render(<TakePhotoButton onTaken={() => {}} />)
    const button = await screen.findByRole('button', { name: 'Take photo' })
    await waitFor(() => expect(button).toBeEnabled())
    fireEvent.click(button)
    expect(await screen.findByText('Key login to arduino@35.1.88.76 was refused.')).toBeInTheDocument()
  })
})

const REC: Recommendation = {
  text: 'Baked Sweet Potatoes had the most food left per portion.',
  bullets: [
    { text: 'Try a smaller Baked Sweet Potatoes portion.', metric: 'Baked Sweet Potatoes: 1,234 pixels wasted per portion' },
    { text: 'Keep scanning.', metric: '12 of 12 plates analyzed' },
  ],
  source: 'gemini',
  generatedAt: '2026-10-04T12:00:00.000Z',
  inputVersion: 'impact-rec-v3|waste-factors-v2|abcd1234',
  window: { start: '2026-09-21', end: '2026-10-04' },
}

describe('RecommendationCard', () => {
  it('asks again on demand', async () => {
    const regenerate = vi.fn(async () => {})
    render(<RecommendationCard rec={REC} onRegenerate={regenerate} />)
    expect(screen.getAllByText('Based on:', { exact: false })).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Ask again' }))
    await waitFor(() => expect(regenerate).toHaveBeenCalledTimes(1))
    expect(await screen.findByRole('button', { name: 'Ask again' })).toBeEnabled()
  })

  it('labels the last saved recommendation when the AI is unavailable', () => {
    render(<RecommendationCard rec={{ ...REC, stale: true }} />)
    expect(screen.getByText('saved earlier')).toBeInTheDocument()
    expect(screen.getByRole('note')).toHaveTextContent(/last saved recommendation \(for Sep 21 to Oct 4\)/)
  })
})

function capture(over: Partial<CaptureListItem> & { eventId: string }): CaptureListItem {
  return {
    capturedAt: '2026-10-04T16:00:00.000Z',
    serviceId: 'svc_1',
    source: 'camera',
    state: 'succeeded',
    pixelsWasted: 5_000,
    items: [{ itemId: 'item_farro', displayName: 'Farro', pixels: 5_000 }],
    hasOverlay: true,
    ...over,
  }
}

function images(eventId: string, withRaw: boolean): CaptureImages {
  return {
    eventId,
    original: { objectId: `o_${eventId}`, url: `https://img.test/${eventId}/normalized.jpg`, expiresAt: future() },
    ...(withRaw ? { raw: { objectId: `r_${eventId}`, url: `https://img.test/${eventId}/raw.jpg`, expiresAt: future() } } : {}),
    overlay: { objectId: `v_${eventId}`, url: `https://img.test/${eventId}/overlay.jpg`, expiresAt: future() },
    masks: [],
  }
}

describe('PlatesGallery (end-to-end additions)', () => {
  it('shows the raw original next to the overlay, enlarges on click, and leaves sample scans out', async () => {
    const load = vi.fn(async (id: string) => images(id, true))
    render(
      <PlatesGallery
        captures={[capture({ eventId: 'real' }), capture({ eventId: 'sample1', source: 'demo' }), capture({ eventId: 'sample2', source: 'demo' })]}
        loadImages={load}
      />,
    )
    expect(screen.getByText('1 recent plate')).toBeInTheDocument()
    expect(screen.getByText(/2 sample scans are counted in the totals but not shown here/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Plate at .*5,000 pixels wasted/ }))
    expect(await screen.findByAltText(/Photo of the plate/)).toHaveAttribute('src', 'https://img.test/real/raw.jpg')
    expect(screen.getByText('Original photo, as the camera took it')).toBeInTheDocument()
    expect(screen.getByAltText(/leftover food the AI outlined/)).toHaveAttribute('src', 'https://img.test/real/overlay.jpg')

    fireEvent.click(screen.getByRole('button', { name: /Enlarge: The same plate with the leftover food/ }))
    const dialog = screen.getByRole('dialog')
    expect(dialog.querySelector('img')).toHaveAttribute('src', 'https://img.test/real/overlay.jpg')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(load).not.toHaveBeenCalledWith('sample1')
  })

  it('falls back to the analyzed photo for scans without a raw original', async () => {
    render(<PlatesGallery captures={[capture({ eventId: 'old' })]} loadImages={async (id) => images(id, false)} />)
    fireEvent.click(screen.getByRole('button', { name: /Plate at/ }))
    expect(await screen.findByAltText(/Photo of the plate/)).toHaveAttribute('src', 'https://img.test/old/normalized.jpg')
    expect(screen.getByText('Photo the AI checked')).toBeInTheDocument()
  })
})
