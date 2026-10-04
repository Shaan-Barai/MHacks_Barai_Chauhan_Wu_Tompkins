/**
 * IT_4 I8: estimated grams / kg CO2e / litres of water on the headline cards,
 * the food rows and the plate viewer. Pixels stay first; estimates are labeled;
 * missing estimates are never 0.
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { DayDetails } from './DayDetails'
import { FoodsToTarget } from './FoodsToTarget'
import { HeadlineCards } from './HeadlineCards'
import { MostWasted } from './MostWasted'
import { PlatesGallery } from './PlatesGallery'
import { dashboard, farro, impact, pizza, row, soup, steak, unknownFood } from './impactFixtures'
import type { CaptureImages, CaptureListItem, ImpactDashboard, ItemImpactRow } from '../data/types'
import { DEFAULT_SETTINGS } from '../state/settings'
import { todayIso } from '../lib/dates'

function calibrated(over: Partial<ImpactDashboard['totals']> = {}): ImpactDashboard {
  const d = dashboard()
  d.totals = {
    ...d.totals,
    grams: 42_300,
    kgCo2e: 312.4,
    waterLitres: 18_650,
    physicalMethod: 'area-calibrated-v1',
    physicalCoverage: { calibratedCaptures: 12, volumeCaptures: 0, analyzedCaptures: 14 },
    ...over,
  }
  return d
}

describe('HeadlineCards with estimates', () => {
  it('keeps Pixels wasted first and adds Estimated CO2e and water with coverage and the method', () => {
    render(<HeadlineCards data={calibrated()} />)
    const titles = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent?.split('?')[0].trim())
    expect(titles).toEqual(['Total waste', 'Estimated CO2e', 'Estimated water', 'Relative impact'])
    expect(screen.getByLabelText('Estimated CO2e: 310 kg CO2e')).toBeInTheDocument()
    expect(screen.getByLabelText('Estimated water: 19,000 L')).toBeInTheDocument()
    expect(screen.getAllByText('From 12 of 14 plates (calibrated)')).toHaveLength(2)
    expect(screen.getAllByText('Method: area')).toHaveLength(2)
    expect(screen.getByText(/about 42 kg of food/)).toBeInTheDocument()
    expect(screen.getAllByText('estimate')).toHaveLength(2)
    expect(screen.getAllByText(/An estimate, not a scale reading/)).toHaveLength(2)
  })

  it('names depth volume and mixed methods', () => {
    const { unmount } = render(
      <HeadlineCards data={calibrated({ physicalMethod: 'volume-dav2-v1', physicalCoverage: { calibratedCaptures: 5, volumeCaptures: 5, analyzedCaptures: 5 } })} />,
    )
    expect(screen.getAllByText('Method: depth volume')).toHaveLength(2)
    expect(screen.getAllByText('From 5 of 5 plates (calibrated)')).toHaveLength(2)
    unmount()
    render(<HeadlineCards data={calibrated({ physicalMethod: 'mixed', physicalCoverage: { calibratedCaptures: 12, volumeCaptures: 5, analyzedCaptures: 14 } })} />)
    expect(screen.getAllByText('Method: mixed (5 plates by depth volume, 7 by area)')).toHaveLength(2)
  })

  it('calibrated plates without footprint data say Not available, never 0', () => {
    render(<HeadlineCards data={calibrated({ kgCo2e: null, waterLitres: null, grams: null })} />)
    expect(screen.getAllByText('Not available')).toHaveLength(2)
    expect(screen.getAllByText('None of the foods on those plates has footprint data.')).toHaveLength(2)
    expect(screen.queryByText(/^0 kg/)).toBeNull()
  })

  it('an older backend without physical fields shows the uncalibrated state', () => {
    const d = dashboard()
    render(<HeadlineCards data={d} />)
    expect(screen.getAllByText(/Calibrate the camera in Settings/)).toHaveLength(2)
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
    render(<MostWasted rows={rows} />)
    const items = within(screen.getByRole('list', { name: 'Foods ranked by Pixels wasted' })).getAllByRole('listitem')
    expect(items[0]).toHaveTextContent('Pepperoni Pizza')
    expect(items[0]).toHaveTextContent('1,200 g19 kg CO2e2,300 L waterest.')
    expect(items[1]).toHaveTextContent('Estimated: 38 g, 1.1 kg CO2e, 18 L water.')
    expect(items[2]).toHaveTextContent('no estimate for this food')
    expect(items[3]).toHaveTextContent('not calibrated')
    expect(items[4]).not.toHaveTextContent(/est\.|not calibrated|\b0 g/)
    expect(screen.getByText(/Grams, CO2e and water are estimates \(est\.\)/)).toBeInTheDocument()
  })

  it('Foods to target shows chips under the name and grams per portion as an estimate', () => {
    const ranked = [{ ...withPhysical(steak, 38, 1.1, 18), perPortion: { pixels: 2857.14, impactPoints: 95.69, grams: 0.27 } }, withPhysical(pizza, 1_200, 19.3, 2_328)]
    render(<FoodsToTarget rows={ranked} demoPortions />)
    const body = within(screen.getByRole('table')).getAllByRole('row').slice(1)
    expect(body[0]).toHaveTextContent('Ancho Flank Steak')
    expect(body[0]).toHaveTextContent('38 g')
    expect(body[0]).toHaveTextContent('about 0.27 g est.')
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
  it('adds an Estimated amount column and names the method', async () => {
    const c = plate({
      physicalMethod: 'volume-dav2-v1',
      calibrationId: 'cal_1',
      items: [
        { itemId: 'item_steak', displayName: 'Ancho Flank Steak', pixels: 20_000, grams: 38, kgCo2e: 1.1, waterLitres: 18, volumeCm3: 40, areaCm2: 27 },
        { itemId: 'item_soup', displayName: "Chef's Soup", pixels: 10_000, grams: null, kgCo2e: null, waterLitres: null, physicalUnavailableReason: 'no_factor' },
      ],
    })
    render(<PlatesGallery captures={[c]} loadImages={vi.fn(async (id: string) => images(id))} />)
    const table = await screen.findByRole('table')
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent?.split('?')[0].trim())).toEqual([
      'Food',
      'Pixels wasted',
      'Estimated amount',
    ])
    const rowsEl = within(table).getAllByRole('row').slice(1)
    expect(rowsEl[0]).toHaveTextContent('Ancho Flank Steak20,000')
    expect(rowsEl[0]).toHaveTextContent('38 g1.1 kg CO2e18 L waterest.')
    expect(rowsEl[1]).toHaveTextContent('no estimate for this food')
    expect(screen.getByText('Estimated by depth volume from the camera calibration.')).toBeInTheDocument()
  })

  it('an uncalibrated plate keeps two columns and says why there are no estimates', async () => {
    const c = plate({ items: [{ itemId: 'x', displayName: 'Rice', pixels: 5_000, grams: null, kgCo2e: null, waterLitres: null }] })
    render(<PlatesGallery captures={[c]} loadImages={vi.fn(async (id: string) => images(id))} />)
    const table = await screen.findByRole('table')
    expect(within(table).getAllByRole('columnheader')).toHaveLength(2)
    expect(screen.getByText(/the camera was not calibrated when it was scanned/)).toBeInTheDocument()
    expect(table).not.toHaveTextContent(/\d g\b/)
  })

  it('a plate at another picture size says so', async () => {
    const c = plate({ source: 'replay', items: [{ itemId: 'x', displayName: 'Rice', pixels: 5_000, grams: null, physicalUnavailableReason: 'incompatible_geometry' }] })
    render(<PlatesGallery captures={[c]} loadImages={vi.fn(async (id: string) => images(id))} />)
    expect(await screen.findByText(/picture size differs from the camera calibration/)).toBeInTheDocument()
  })
})

describe('day details with estimates (mock data)', () => {
  it('shows chips next to each food for a calibrated day', async () => {
    render(<DayDetails date={todayIso()} settings={{ ...DEFAULT_SETTINGS, name: 'Test Hall' }} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Dinner' }))
    expect(await screen.findByText('Left on plates')).toBeInTheDocument()
    expect(screen.getAllByText('est.').length).toBeGreaterThan(0)
    expect(screen.getAllByText(/kg CO2e$/).length).toBeGreaterThan(0)
  })
})

// keep the fixture helpers referenced so a rename shows up here
void impact
void row
