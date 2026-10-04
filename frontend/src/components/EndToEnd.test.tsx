/**
 * End-to-end pipeline additions: Take photo, regenerating the recommendation,
 * the raw photo + enlarge in the gallery, and sample data left out of it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import * as api from '../data/api'
import { PlatesGallery } from './PlatesGallery'
import { RecommendationCard } from './RecommendationCard'
import { TakePhotoButton } from './TakePhotoButton'
import type { CaptureImages, CaptureListItem, Recommendation } from '../data/types'

afterEach(() => vi.restoreAllMocks())

const future = () => new Date(Date.now() + 10 * 60_000).toISOString()

describe('TakePhotoButton', () => {
  it('is disabled with a hint when no camera is set up', async () => {
    render(<TakePhotoButton onTaken={() => {}} />)
    expect(await screen.findByText('No camera set up.')).toBeInTheDocument()
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
    expect(screen.getByRole('heading', { name: 'Recommendations' })).toBeInTheDocument()
    // each bullet keeps the number it rests on
    expect(screen.getByText('Baked Sweet Potatoes: 1,234 pixels wasted per portion')).toBeInTheDocument()
    expect(screen.getByText('12 of 12 plates analyzed')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Ask again' }))
    await waitFor(() => expect(regenerate).toHaveBeenCalledTimes(1))
    expect(await screen.findByRole('button', { name: 'Ask again' })).toBeEnabled()
  })

  it('shows the error and stays usable when asking again fails', async () => {
    const regenerate = vi.fn(async () => {
      throw new Error('The AI is unavailable right now.')
    })
    render(<RecommendationCard rec={REC} onRegenerate={regenerate} />)
    fireEvent.click(screen.getByRole('button', { name: 'Ask again' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The AI is unavailable right now.')
    expect(screen.getByRole('button', { name: 'Ask again' })).toBeEnabled()
    expect(screen.getByText(REC.text)).toBeInTheDocument()
  })

  it('labels the last saved recommendation when the AI is unavailable', () => {
    const { rerender } = render(<RecommendationCard rec={REC} />)
    expect(screen.queryByText('saved earlier')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Ask again' })).toBeNull()
    rerender(<RecommendationCard rec={{ ...REC, stale: true }} />)
    expect(screen.getByText('saved earlier')).toBeInTheDocument()
    expect(screen.getByText('AI')).toBeInTheDocument()
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
    // only the real scan is listed; sample scans have no photos
    expect(screen.getAllByRole('button', { name: /^Plate at / })).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: /^Plate at .*: 5,000 pixels$/ }))
    expect(await screen.findByAltText(/Photo of the plate/)).toHaveAttribute('src', 'https://img.test/real/raw.jpg')
    expect(screen.getByText('Original')).toBeInTheDocument()
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
    expect(screen.getByText('Photo', { selector: 'figcaption' })).toBeInTheDocument()
    expect(screen.queryByText('Original')).toBeNull()
  })
})
