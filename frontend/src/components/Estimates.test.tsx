/**
 * IT_4 I8: estimated grams / kg CO2e / litres of water on the headline cards,
 * the food rows and the plate viewer. No "est." labels (2026-10-04); missing
 * estimates are never 0.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { FoodsToTarget } from './FoodsToTarget'
import { HeadlineCards } from './HeadlineCards'
import { MostWasted } from './MostWasted'
import { PlatesGallery } from './PlatesGallery'
import { dashboard, farro, impact, pizza, row, soup, steak, unknownFood } from './impactFixtures'
import type { CaptureImages, CaptureListItem, ImpactDashboard, ItemImpactRow } from '../data/types'

function calibrated(over: Partial<ImpactDashboard['totals']> = {}): ImpactDashboard {
  const d = dashboard()
  d.totals = {
    ...d.totals,
    grams: 42_300,
    kgCo2e: 312.4,
    waterLitres: 18_650,
    physicalMethod: 'area-calibrated-v1',
    physicalCoverage: { calibratedCaptures: 12, analyzedCaptures: 14 },
    ...over,
  }
  return d
}

describe('HeadlineCards with estimates', () => {
  it('shows carbon, water and food wasted with no est. label, and plates scanned as a count', () => {
    render(<HeadlineCards data={calibrated()} />)
    const titles = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)
    expect(titles).toEqual(['Carbon emissions', 'Water', 'Food wasted', 'Plates scanned'])
    expect(screen.getByLabelText('Carbon emissions: 310 kg CO2e')).toBeInTheDocument()
    expect(screen.getByLabelText('Water: 19,000 L')).toBeInTheDocument()
    expect(screen.getByLabelText('Food wasted: 42 kg')).toBeInTheDocument()
    expect(screen.getByLabelText(/^Plates scanned: [\d,]+ plates$/)).toBeInTheDocument()
    // no est. labels anywhere (product owner, 2026-10-04)
    expect(screen.queryByText('est.')).toBeNull()
    // no method breakdown: area from the calibration is the only method
    expect(screen.queryByText(/depth|volume|mixed/i)).toBeNull()
  })

  it('calibrated plates without footprint data show a dash, never 0, and no est. badge', () => {
    render(<HeadlineCards data={calibrated({ kgCo2e: null, waterLitres: null, grams: null })} />)
    expect(screen.getByLabelText('Carbon emissions: not available')).toHaveTextContent('—')
    expect(screen.getByLabelText('Water: not available')).toHaveTextContent('—')
    expect(screen.getByLabelText('Food wasted: not available')).toHaveTextContent('—')
    expect(screen.queryByText('est.')).toBeNull()
    expect(screen.queryByText(/^0 (kg|g|L)\b/)).toBeNull()
  })

  it('an older backend without physical fields shows dashes for the estimates', () => {
    const d = dashboard()
    render(<HeadlineCards data={d} />)
    expect(screen.getByLabelText('Carbon emissions: not available')).toBeInTheDocument()
    expect(screen.getByLabelText('Water: not available')).toBeInTheDocument()
    expect(screen.getByLabelText('Food wasted: not available')).toBeInTheDocument()
  })
})

const withPhysical = (r: ItemImpactRow, grams: number | null, kg: number | null, litres: number | null, reason?: ItemImpactRow['impact']['physicalUnavailableReason']): ItemImpactRow => ({
  ...r,
  impact: { ...r.impact, grams, kgCo2e: kg, waterLitres: litres, ...(reason ? { physicalUnavailableReason: reason } : {}) },
})

describe('food rows with estimates', () => {
  const rows = [
    withPhysical(pizza, 1_200, 19.3, 2_328),
    withPhysical(steak, 38, 1.1, 18),
    withPhysical(soup, null, null, null, 'no_factor'),
    withPhysical(farro, null, null, null, 'no_calibration'),
    withPhysical(unknownFood, null, null, null, 'unknown_item'),
  ]

  it('Most wasted puts the chips right after the food name, and explains missing ones without 0', () => {
    render(<MostWasted rows={rows} initialRank="pixels" />)
    const items = within(screen.getByRole('list', { name: 'Foods ranked by total pixels wasted' })).getAllByRole('listitem')
    expect(items[0]).toHaveTextContent('Pepperoni Pizza')
    expect(items[0]).toHaveTextContent('1,200 g19 kg CO2e2,300 L water')
    expect(items[1]).toHaveTextContent('Estimated: 38 g, 1.1 kg CO2e, 18 L water.')
    expect(items[2]).toHaveTextContent('no estimate for this food')
    expect(items[3]).toHaveTextContent('not calibrated')
    expect(items[4]).not.toHaveTextContent(/est\.|not calibrated|\b0 g/)
  })

  it('Foods to target shows grams per portion as an estimate, without per-row chips', () => {
    const ranked = [{ ...withPhysical(steak, 38, 1.1, 18), perPortion: { pixels: 2857.14, impactPoints: 95.69, grams: 0.27 } }, withPhysical(pizza, 1_200, 19.3, 2_328)]
    render(<FoodsToTarget rows={ranked} demoPortions />)
    const body = within(screen.getByRole('table')).getAllByRole('row').slice(1)
    expect(body[0]).toHaveTextContent('Ancho Flank Steak')
    expect(body[0]).toHaveTextContent('2,857 pixels')
    expect(body[0]).toHaveTextContent('about 0.27 g')
    // the food's total estimate chips stay in Most wasted, not here
    expect(body[0]).not.toHaveTextContent('38 g')
    expect(body[0]).not.toHaveTextContent('kg CO2e')
    // no per-portion grams: nothing, not 0
    expect(body[1]).not.toHaveTextContent('about')
  })

  it('rows without any estimate (uncalibrated window) show no chips at all', () => {
    render(<MostWasted rows={[pizza, steak]} />)
    expect(screen.queryByText('est.')).toBeNull()
    expect(screen.queryByText('not calibrated')).toBeNull()
  })
})

const future = () => new Date(Date.now() + 10 * 60_000).toISOString()
const images = (eventId: string): CaptureImages => ({
  eventId,
  original: { objectId: 'o', url: `https://img.test/${eventId}.jpg`, expiresAt: future() },
  overlay: null,
  masks: [],
})

function plate(over: Partial<CaptureListItem>): CaptureListItem {
  return {
    eventId: 'p1',
    capturedAt: '2026-10-02T23:30:00.000Z',
    serviceId: 'svc_1',
    source: 'camera',
    state: 'succeeded',
    pixelsWasted: 30_000,
    items: [],
    hasOverlay: false,
    ...over,
  }
}

describe('plate viewer with estimates', () => {
  it('adds an Estimate column with labeled chips, and the reason when a food has none', async () => {
    const c = plate({
      physicalMethod: 'area-calibrated-v1',
      calibrationId: 'cal_1',
      items: [
        { itemId: 'item_steak', displayName: 'Ancho Flank Steak', pixels: 20_000, grams: 38, kgCo2e: 1.1, waterLitres: 18, areaCm2: 27 },
        { itemId: 'item_soup', displayName: "Chef's Soup", pixels: 10_000, grams: null, kgCo2e: null, waterLitres: null, physicalUnavailableReason: 'no_factor' },
      ],
    })
    render(<PlatesGallery captures={[c]} loadImages={vi.fn(async (id: string) => images(id))} />)
    const table = await screen.findByRole('table')
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent?.split('?')[0].trim())).toEqual([
      'Food',
      'Pixels wasted',
      'Estimate',
    ])
    const rowsEl = within(table).getAllByRole('row').slice(1)
    expect(rowsEl[0]).toHaveTextContent('Ancho Flank Steak20,000')
    expect(rowsEl[0]).toHaveTextContent('38 g1.1 kg CO2e18 L water')
    expect(rowsEl[1]).toHaveTextContent('no estimate for this food')
    expect(rowsEl[1]).not.toHaveTextContent(/\b0 g/)
  })

  it('an uncalibrated plate keeps two columns and shows no amounts', async () => {
    const c = plate({ items: [{ itemId: 'x', displayName: 'Rice', pixels: 5_000, grams: null, kgCo2e: null, waterLitres: null }] })
    render(<PlatesGallery captures={[c]} loadImages={vi.fn(async (id: string) => images(id))} />)
    const table = await screen.findByRole('table')
    expect(within(table).getAllByRole('columnheader')).toHaveLength(2)
    expect(table).toHaveTextContent('Rice5,000')
    expect(screen.queryByText('est.')).toBeNull()
    expect(table).not.toHaveTextContent(/\d g\b/)
  })

  it('a food at another picture size says so next to it', async () => {
    const c = plate({
      source: 'replay',
      items: [
        { itemId: 'item_steak', displayName: 'Ancho Flank Steak', pixels: 20_000, grams: 38, kgCo2e: 1.1, waterLitres: 18 },
        { itemId: 'x', displayName: 'Rice', pixels: 5_000, grams: null, physicalUnavailableReason: 'incompatible_geometry' },
      ],
    })
    render(<PlatesGallery captures={[c]} loadImages={vi.fn(async (id: string) => images(id))} />)
    const table = await screen.findByRole('table')
    expect(within(table).getAllByRole('row')[2]).toHaveTextContent('photo size differs from the calibration')
  })
})

// keep the fixture helpers referenced so a rename shows up here
void impact
void row
