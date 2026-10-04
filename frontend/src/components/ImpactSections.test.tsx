import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { HeadlineCards } from './HeadlineCards'
import { FoodsToTarget } from './FoodsToTarget'
import { MostWasted } from './MostWasted'
import { NutritionLost } from './NutritionLost'
import { dashboard, impact, row } from './impactFixtures'

/** BIG-PLAN v2: no grams, kilograms, litres, cubic meters, CO2e or dollars anywhere. */
const PHYSICAL_UNITS = /\d\s?(g|kg|L|m³)(?!\w)|litres|CO₂e|\$/

describe('HeadlineCards', () => {
  it('shows Total waste in waste units and Relative impact in points with greenhouse-gas and water points', () => {
    const { container } = render(<HeadlineCards data={dashboard()} />)
    expect(screen.getByLabelText('Total waste: 1,450 waste units')).toBeInTheDocument()
    expect(screen.getByText('From 124 of 130 plates scanned')).toBeInTheDocument()
    expect(screen.getByText(/6 plates not counted/)).toBeInTheDocument()

    expect(screen.getByLabelText('Relative impact: 18,795 points')).toBeInTheDocument()
    expect(screen.getByText('Greenhouse gases:').nextSibling).toHaveTextContent('77,706 points')
    expect(screen.getByText('Water:').nextSibling).toHaveTextContent('2,687 points')
    expect(screen.getByText('relative points')).toBeInTheDocument()
    expect(screen.getByText('Relative points: they compare foods with each other, not kg or litres.')).toBeInTheDocument()
    // the "?" tip explains how points are made and the impact weights
    expect(screen.getByText(/pixels ÷ 1,000 × the food’s typical density × a footprint factor/)).toBeInTheDocument()
    expect(screen.getByText(/0\.19 × greenhouse-gas points \+ 1\.50 × water points/)).toBeInTheDocument()
    expect(screen.getByText(/1 food has no impact data/)).toBeInTheDocument()
    expect(screen.queryByText('estimate')).toBeNull()

    // Only the explanatory "not kg or litres" sentence may name a physical unit.
    const text = (container.textContent ?? '').replace(/not kg or litres|not kilograms, litres, or dollars/g, '')
    expect(text).not.toMatch(PHYSICAL_UNITS)
  })

  it('says Not available instead of zero when there are no impact points', () => {
    const d = dashboard()
    d.totals = { ...d.totals, co2Points: null, waterPoints: null, impactPoints: null }
    d.coverage = { ...d.coverage, itemsWithoutFactor: 0 }
    render(<HeadlineCards data={d} />)
    expect(screen.getByText('Not available')).toBeInTheDocument()
    expect(screen.getByText('Greenhouse gases:').nextSibling).toHaveTextContent('not available')
    expect(screen.queryByText(/no impact data/)).toBeNull()
  })
})

describe('FoodsToTarget', () => {
  it('ranks by pixels per portion with impact points per portion, demo badge, and explains unranked foods', () => {
    const d = dashboard()
    render(<FoodsToTarget rows={d.targets} demoPortions />)
    expect(screen.getByRole('heading', { name: 'Ancho Flank Steak had the most food left per portion.' })).toBeInTheDocument()
    expect(screen.getByText(/Ranked by Pixels wasted per portion served/)).toBeInTheDocument()
    const table = screen.getByRole('table')
    expect(within(table).getAllByRole('columnheader')[2]).toHaveTextContent('Pixels wasted per portion')
    const bodyRows = within(table).getAllByRole('row').slice(1)
    expect(bodyRows).toHaveLength(3)
    expect(bodyRows[0]).toHaveTextContent('Ancho Flank Steak')
    expect(bodyRows[0]).toHaveTextContent('2,857 pixels')
    expect(bodyRows[0]).toHaveTextContent('95.7 points')
    expect(bodyRows[0]).toHaveTextContent('140')
    expect(bodyRows[1]).toHaveTextContent('Pepperoni Pizza')
    expect(bodyRows[1]).toHaveTextContent('8.7 points')
    // a food without impact factors still ranks by pixels
    expect(bodyRows[2]).toHaveTextContent("Chef's Soup of the Day")
    expect(bodyRows[2]).toHaveTextContent('1,400 pixels')
    expect(bodyRows[2]).toHaveTextContent('No impact data for this food')
    expect(within(table).getByText('demo numbers')).toBeInTheDocument()

    const unranked = screen.getByText("Can't rank yet").parentElement!
    expect(unranked).toHaveTextContent('Farro: No portions entered')
    expect(unranked).toHaveTextContent('Food not on the menu: Not on the menu, so it has no portions')
    expect(document.body.textContent).not.toMatch(PHYSICAL_UNITS)
  })

  it('hides the demo badge for real counts and collapses long lists', () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      row({ displayName: `Food ${i + 1}`, portionsSource: 'manual', perPortion: { pixels: 5000 - i, impactPoints: 0.1 } }),
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

  it('says no portions served when the count is zero', () => {
    render(<FoodsToTarget rows={[row({ displayName: 'Farro', portionsServed: 0, perPortion: null })]} demoPortions={false} />)
    expect(screen.getByText("Can't rank yet").parentElement).toHaveTextContent('Farro: No portions served')
  })
})

describe('MostWasted', () => {
  it('lists every food by pixels with relative impact points per row, or the reason it has none', () => {
    const d = dashboard()
    render(<MostWasted rows={d.mostWasted} />)
    expect(screen.getByRole('heading', { name: 'Pepperoni Pizza was the most wasted food.' })).toBeInTheDocument()
    expect(screen.getByText('points are relative')).toBeInTheDocument()
    const items = within(screen.getByRole('list', { name: 'Foods ranked by Pixels wasted' })).getAllByRole('listitem')
    expect(items.map((li) => li.querySelector('span')?.textContent)).toEqual([
      'Pepperoni Pizza',
      'Ancho Flank Steak',
      "Chef's Soup of the Day",
      'Farro',
      'Food not on the menu',
    ])
    expect(items[0]).toHaveTextContent('900,000 pixels')
    expect(items[0]).toHaveTextContent('5,365 impact points (greenhouse gases 14,454, water 1,746)')
    expect(items[1]).toHaveTextContent('13,396 impact points')
    expect(items[2]).toHaveTextContent('70,000 pixels')
    expect(items[2]).toHaveTextContent('No impact data for this food')
    expect(items[3]).toHaveTextContent('33.5 impact points (greenhouse gases 41.3, water 17.1)')
    expect(items[4]).toHaveTextContent('Not on the menu, so no impact points')
    expect(document.body.textContent).not.toMatch(PHYSICAL_UNITS)
  })
})

describe('NutritionLost', () => {
  it('shows relative nutrition points, separate from the impact score, with the top foods', () => {
    render(<NutritionLost data={dashboard()} />)
    expect(screen.getByText('not part of the impact score')).toBeInTheDocument()
    expect(screen.getByText('relative points')).toBeInTheDocument()
    expect(screen.getByText('1,159 nutrition points')).toBeInTheDocument()
    expect(screen.getByText(/Most from Pepperoni Pizza \(621\), Ancho Flank Steak \(504\), Farro \(33\.6\)/)).toBeInTheDocument()
    expect(screen.queryByText(/nutrient-days/)).toBeNull()
  })

  it('says not available when nutrition is missing', () => {
    const d = dashboard({ mostWasted: [row({ displayName: 'X', impact: impact({ nutritionPoints: null }) })] })
    d.totals = { ...d.totals, nutritionPoints: null }
    render(<NutritionLost data={d} />)
    expect(screen.getByText('Not available for these days.')).toBeInTheDocument()
  })
})
