import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { HeadlineCards } from './HeadlineCards'
import { FoodsToTarget } from './FoodsToTarget'
import { MostWasted } from './MostWasted'
import { NutritionLost } from './NutritionLost'
import { dashboard, impact, row } from './impactFixtures'

describe('HeadlineCards', () => {
  it('shows estimated grams with measured pixels, CO2e, water and impact $, each labeled estimate', () => {
    render(<HeadlineCards data={dashboard()} />)
    expect(screen.getByLabelText('Total waste: 17.2 kg')).toBeInTheDocument()
    expect(screen.getByText('1,450,000').closest('p')).toHaveTextContent('1,450,000 Pixels wasted')
    expect(screen.getByText('Measured from the photos')).toBeInTheDocument()
    expect(screen.getByLabelText('Greenhouse gases: 1,620 kg CO₂e')).toBeInTheDocument()
    expect(screen.getByLabelText('Freshwater: 32.5 m³')).toBeInTheDocument()
    expect(screen.getByText('32,500 litres')).toBeInTheDocument()
    expect(screen.getByLabelText('Waste impact: $357')).toBeInTheDocument()
    expect(screen.getAllByText('estimate')).toHaveLength(4)
    expect(screen.getByText('From 124 of 130 plates scanned')).toBeInTheDocument()
    expect(screen.getByText(/6 plates not counted/)).toBeInTheDocument()
    expect(screen.getByText(/1 food has no weight estimate/)).toBeInTheDocument()
    expect(screen.getByText(/2 plates used the standard plate size/)).toBeInTheDocument()
    // the impact formula is explained in its help text
    expect(screen.getByText(/0\.19 x CO₂e \+ 1\.50 x water/)).toBeInTheDocument()
  })

  it('says Not available instead of zero when there is no weight estimate, and uses litres for small water', () => {
    const d = dashboard()
    d.totals = { ...d.totals, grams: null, kgCo2e: null, impactUsd: null, waterM3: 0.42 }
    render(<HeadlineCards data={d} />)
    expect(screen.getAllByText('Not available')).toHaveLength(3)
    expect(screen.getByLabelText('Freshwater: 420 L')).toBeInTheDocument()
    expect(screen.getByText('No weight estimate yet for these plates.')).toBeInTheDocument()
  })
})

describe('FoodsToTarget', () => {
  it('ranks by grams per portion with pixels and $ per portion, demo badge, and explains unranked foods', () => {
    const d = dashboard()
    render(<FoodsToTarget rows={d.targets} demoPortions />)
    expect(screen.getByRole('heading', { name: 'Ancho Flank Steak had the most food left per portion.' })).toBeInTheDocument()
    const table = screen.getByRole('table')
    const bodyRows = within(table).getAllByRole('row').slice(1)
    expect(bodyRows).toHaveLength(2)
    expect(bodyRows[0]).toHaveTextContent('Ancho Flank Steak')
    expect(bodyRows[0]).toHaveTextContent('30 g')
    expect(bodyRows[0]).toHaveTextContent('2,857 pixels')
    expect(bodyRows[0]).toHaveTextContent('$0.84')
    expect(bodyRows[0]).toHaveTextContent('140')
    expect(bodyRows[1]).toHaveTextContent('Pepperoni Pizza')
    expect(within(table).getByText('demo numbers')).toBeInTheDocument()

    const unranked = screen.getByText("Can't rank yet").parentElement!
    expect(unranked).toHaveTextContent('Farro: No portions entered')
    expect(unranked).toHaveTextContent("Chef's Soup of the Day: No weight estimate for this food (1,400 pixels per portion)")
    expect(unranked).toHaveTextContent('Food not on the menu: Not on the menu, so it has no portions')
  })

  it('hides the demo badge for real counts and collapses long lists', () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      row({ displayName: `Food ${i + 1}`, portionsSource: 'manual', perPortion: { grams: 50 - i, pixels: 1000, impactUsd: 0.1 } }),
    )
    render(<FoodsToTarget rows={many} demoPortions={false} />)
    expect(screen.queryByText('demo numbers')).toBeNull()
    expect(screen.getAllByRole('row')).toHaveLength(1 + 8)
    fireEvent.click(screen.getByRole('button', { name: 'Show all 10 foods' }))
    expect(screen.getAllByRole('row')).toHaveLength(1 + 10)
  })

  it('says nothing can be ranked yet when no food has a rate', () => {
    render(<FoodsToTarget rows={[row({ displayName: 'Farro', portionsServed: null, perPortion: null })]} demoPortions />)
    expect(screen.getByRole('heading', { name: 'No food can be ranked per portion yet.' })).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
  })
})

describe('MostWasted', () => {
  it('lists foods by estimated weight with CO2e and water, then pixels-only foods with the reason', () => {
    const d = dashboard()
    render(<MostWasted rows={d.mostWasted} />)
    expect(screen.getByRole('heading', { name: 'Pepperoni Pizza was the most wasted food.' })).toBeInTheDocument()
    const items = within(screen.getByRole('list', { name: /ranked by estimated weight/ })).getAllByRole('listitem')
    expect(items.map((li) => li.querySelector('span')?.textContent)).toEqual(['Pepperoni Pizza', 'Ancho Flank Steak', 'Farro'])
    expect(items[0]).toHaveTextContent('12.4 kg')
    expect(items[0]).toHaveTextContent('199 kg CO₂e')
    expect(items[0]).toHaveTextContent('24.1 m³ water')
    expect(items[2]).toHaveTextContent('190 L water')
    const noWeight = screen.getByText('No weight estimate').parentElement!
    expect(noWeight).toHaveTextContent("Chef's Soup of the Day: 70,000 Pixels wasted. No weight estimate for this food.")
    expect(noWeight).toHaveTextContent('Food not on the menu: 30,000 Pixels wasted. Not on the menu, so there is no weight estimate.')
  })
})

describe('NutritionLost', () => {
  it('is separate from the impact score and lists the top foods', () => {
    render(<NutritionLost data={dashboard()} />)
    expect(screen.getByText('not part of the impact score')).toBeInTheDocument()
    expect(screen.getByText('13 nutrient-days')).toBeInTheDocument()
    expect(screen.getByText(/Most from Pepperoni Pizza \(8\.6\), Ancho Flank Steak \(4\.4\), Farro \(0\.4\)/)).toBeInTheDocument()
  })

  it('says not available when nutrition is missing', () => {
    const d = dashboard({ mostWasted: [row({ displayName: 'X', impact: impact({ nutrientDaysLost: null }) })] })
    d.totals = { ...d.totals, nutrientDaysLost: null }
    render(<NutritionLost data={d} />)
    expect(screen.getByText('Not available for these days.')).toBeInTheDocument()
  })
})

