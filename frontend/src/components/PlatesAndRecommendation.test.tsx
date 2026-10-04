import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PlatesGallery } from './PlatesGallery'
import { RecommendationCard } from './RecommendationCard'
import type { CaptureImages, CaptureListItem, Recommendation } from '../data/types'

const future = () => new Date(Date.now() + 10 * 60_000).toISOString()

function capture(over: Partial<CaptureListItem> & { eventId: string }): CaptureListItem {
  return {
    capturedAt: '2026-10-02T23:30:00.000Z',
    serviceId: 'svc_1',
    source: 'camera',
    state: 'succeeded',
    pixelsWasted: 30_000,
    items: [
      { itemId: 'item_pepperoni-pizza', displayName: 'Pepperoni Pizza', pixels: 20_000 },
      { itemId: null, displayName: 'Unknown food', pixels: 10_000 },
    ],
    hasOverlay: true,
    ...over,
  }
}

function images(eventId: string, n = 1, overlay = true): CaptureImages {
  return {
    eventId,
    original: { objectId: `o_${eventId}`, url: `https://img.test/${eventId}/photo-${n}.jpg`, expiresAt: future() },
    overlay: overlay ? { objectId: `v_${eventId}`, url: `https://img.test/${eventId}/overlay-${n}.jpg`, expiresAt: future() } : null,
    masks: [],
  }
}

describe('PlatesGallery', () => {
  it('opens a plate with photo and AI outlines side by side, toggles views, and lists foods with pixels only', async () => {
    const load = vi.fn(async (id: string) => images(id))
    render(<PlatesGallery captures={[capture({ eventId: 'a' })]} loadImages={load} />)
    expect(screen.getByText('30,000 pixels wasted')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Plate at .*30,000 pixels wasted/ }))
    expect(await screen.findByAltText(/Photo of the plate/)).toHaveAttribute('src', 'https://img.test/a/photo-1.jpg')
    expect(screen.getByAltText(/leftover food the AI outlined/)).toHaveAttribute('src', 'https://img.test/a/overlay-1.jpg')

    fireEvent.click(screen.getByRole('button', { name: 'AI outlines' }))
    expect(screen.queryByAltText(/Photo of the plate/)).toBeNull()
    expect(screen.getByAltText(/leftover food the AI outlined/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'AI outlines' })).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(screen.getByRole('button', { name: 'Photo' }))
    expect(screen.getByAltText(/Photo of the plate/)).toBeInTheDocument()
    expect(screen.queryByAltText(/leftover food the AI outlined/)).toBeNull()

    const table = screen.getByRole('table')
    expect(table.querySelectorAll('thead th')).toHaveLength(2)
    expect(table).toHaveTextContent('FoodPixels wasted')
    expect(table).toHaveTextContent('Pepperoni Pizza20,000')
    expect(table).toHaveTextContent('Unknown food (not on the menu)10,000')
    expect(table).not.toHaveTextContent(/weight|estimate|\d g\b/i)
    // one request per plate, shared by the thumbnail and the viewer
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('renews a broken image link once, then shows the photo as unavailable', async () => {
    let n = 0
    const load = vi.fn(async (id: string) => images(id, ++n))
    render(<PlatesGallery captures={[capture({ eventId: 'b' })]} loadImages={load} />)
    fireEvent.click(screen.getByRole('button', { name: /Plate at/ }))
    const photo = await screen.findByAltText(/Photo of the plate/)
    fireEvent.error(photo)
    await waitFor(() => expect(screen.getByAltText(/Photo of the plate/)).toHaveAttribute('src', 'https://img.test/b/photo-2.jpg'))
    expect(load).toHaveBeenCalledTimes(2)

    fireEvent.error(screen.getByAltText(/Photo of the plate/))
    await waitFor(() => expect(screen.getAllByText('Photo unavailable').length).toBeGreaterThan(0))
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('shows AI outlines on tiles, lists analyzed plates first, and opens the newest analyzed plate', async () => {
    const load = vi.fn(async (id: string) => images(id, 1, id === 'new'))
    render(
      <PlatesGallery
        captures={[
          capture({ eventId: 'failed1', state: 'failed', pixelsWasted: null, items: [], hasOverlay: false }),
          capture({ eventId: 'new', pixelsWasted: 30_000 }),
          capture({ eventId: 'bare', pixelsWasted: 5_000, items: [] }),
        ]}
        loadImages={load}
      />,
    )
    const tiles = screen.getAllByRole('button', { name: /Plate at/ })
    expect(tiles.map((t) => t.getAttribute('aria-label'))).toEqual([
      expect.stringMatching(/30,000 pixels wasted/),
      expect.stringMatching(/5,000 pixels wasted/),
      expect.stringMatching(/Check failed/),
    ])
    await waitFor(() => expect(screen.getAllByText('AI outline')).toHaveLength(1))
    expect(tiles[0].querySelector('img')).toHaveAttribute('src', 'https://img.test/new/overlay-1.jpg')
    expect(tiles[1].querySelector('img')).toHaveAttribute('src', 'https://img.test/bare/photo-1.jpg')
    // The newest analyzed plate is open side by side without a click.
    expect(await screen.findByAltText(/Photo of the plate/)).toHaveAttribute('src', 'https://img.test/new/photo-1.jpg')
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByAltText(/Photo of the plate/)).toBeNull()
  })

  it('refetches links that have already expired when a plate is opened', async () => {
    let n = 0
    const load = vi.fn(async (id: string) => {
      n++
      const img = images(id, n)
      if (n === 1) img.original!.expiresAt = new Date(Date.now() - 1000).toISOString()
      return img
    })
    render(<PlatesGallery captures={[capture({ eventId: 'e' })]} loadImages={load} />)
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: /Plate at/ }))
    await waitFor(() => expect(screen.getByAltText(/Photo of the plate/)).toHaveAttribute('src', 'https://img.test/e/photo-2.jpg'))
  })

  it('explains failed, clean and still-checking plates, and the empty state', async () => {
    const load = vi.fn(async (id: string) => images(id, 1, id !== 'f'))
    const { unmount } = render(
      <PlatesGallery
        captures={[
          capture({ eventId: 'f', state: 'failed', pixelsWasted: null, items: [], hasOverlay: false }),
          capture({ eventId: 'c', pixelsWasted: 0, items: [] }),
          capture({ eventId: 'p', state: 'processing', pixelsWasted: null, items: [], hasOverlay: false }),
        ]}
        loadImages={load}
      />,
    )
    expect(screen.getByText('Check failed. Not in the totals.')).toBeInTheDocument()
    expect(screen.getByText('Clean plate')).toBeInTheDocument()
    expect(screen.getByText('Being checked')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Check failed/ }))
    expect(await screen.findByText(/couldn't check this plate, so it is not in the totals/)).toBeInTheDocument()
    expect(await screen.findByText('No AI outlines: the check failed')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Clean plate/ }))
    expect(await screen.findByText('Clean plate. No food left.')).toBeInTheDocument()
    unmount()

    render(<PlatesGallery captures={[]} loadImages={load} />)
    expect(screen.getByText('No plates were scanned in these days.')).toBeInTheDocument()
  })

  it('notes when food on neighboring plates was left out, and stays quiet when none was', () => {
    const load = vi.fn(async (id: string) => images(id))
    const { unmount } = render(<PlatesGallery captures={[capture({ eventId: 'n' })]} neighborExcluded={3} loadImages={load} />)
    expect(screen.getByText(/Food on neighboring plates was left out of 3 plates\./)).toBeInTheDocument()
    expect(screen.getByText(/outlined as "Other dish \(not counted\)"/)).toBeInTheDocument()
    unmount()
    render(<PlatesGallery captures={[capture({ eventId: 'n' })]} neighborExcluded={1} loadImages={load} />)
    expect(screen.getByText(/left out of 1 plate\./)).toBeInTheDocument()
  })

  it('shows no neighbor note by default', () => {
    render(<PlatesGallery captures={[capture({ eventId: 'z' })]} loadImages={vi.fn(async (id: string) => images(id))} />)
    expect(screen.queryByText(/neighboring plates/)).toBeNull()
  })
})

const rec: Recommendation = {
  text: 'Ancho Flank Steak had the most food left per portion — try a smaller serving.',
  bullets: [{ text: 'Serve a smaller steak portion.', metric: '2,857 pixels wasted per portion over 140 portions' }],
  source: 'gemini',
  generatedAt: '2026-10-03T22:15:00.000Z',
  inputVersion: 'v1',
}

describe('RecommendationCard', () => {
  it('labels AI text, shows each bullet with its supporting number, and strips dashes', () => {
    render(<RecommendationCard rec={rec} />)
    expect(screen.getByText('AI')).toBeInTheDocument()
    expect(screen.getByText('Ancho Flank Steak had the most food left per portion, try a smaller serving.')).toBeInTheDocument()
    expect(screen.getByText('Serve a smaller steak portion.')).toBeInTheDocument()
    expect(screen.getByText('2,857 pixels wasted per portion over 140 portions').closest('p')).toHaveTextContent(
      'Based on: 2,857 pixels wasted per portion over 140 portions',
    )
    expect(screen.getByText(/^Written by AI on/)).toBeInTheDocument()
  })

  it('labels the rule-based fallback', () => {
    render(<RecommendationCard rec={{ ...rec, source: 'fallback' }} />)
    expect(screen.getByText('Rule-based fallback')).toBeInTheDocument()
    expect(screen.getByText(/^Basic rule, AI unavailable on/)).toBeInTheDocument()
    expect(screen.queryByText('AI')).toBeNull()
  })
})
