import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { HeadlineCards } from './HeadlineCards'
import { FoodsToTarget } from './FoodsToTarget'
import { MostWasted } from './MostWasted'
import { NutritionLost } from './NutritionLost'
import { dashboard, impact, row } from './impactFixtures'

/** Uncalibrated data (these fixtures) shows no grams, kilograms, litres, cubic meters or dollars (IT_4 I1). */
const PHYSICAL_UNITS = /\d\s?(g|kg|L|m³)(?!\w)|litres|CO₂e|\$/

describe('HeadlineCards', () => {
  it('shows Total waste in pixels and Relative impact in points with greenhouse-gas and water points', () => {
    const { container } = render(<HeadlineCards data={dashboard()} />)
    expect(screen.getByLabelText('Total waste: 1,450,000 pixels')).toBeInTheDocument()
    expect(screen.getByText('From 124 of 130 plates scanned')).toBeInTheDocument()
    expect(screen.getByText(/6 plates not counted/)).toBeInTheDocument()

    expect(screen.getByLabelText('Relative impact: 18,795 points')).toBeInTheDocument()
    expect(screen.getByText('Greenhouse gases:').nextSibling).toHaveTextContent('77,706 points')
    expect(screen.getByText('Water:').nextSibling).toHaveTextContent('2,687 points')
    expect(screen.getByText('relative points')).toBeInTheDocument()
    expect(screen.getByText('Relative points: they compare foods with each other, not kg or litres.')).toBeInTheDocument()
    // the "?" tip explains how points are made and the impact weights
    expect(screen.getByText(/pixels ÷ 1,000 × the food’s typical weight per cm² × a footprint factor/)).toBeInTheDocument()
    expect(screen.getByText(/0\.19 × greenhouse-gas points \+ 1\.50 × water points/)).toBeInTheDocument()
    expect(screen.getByText(/1 food has no impact data/)).toBeInTheDocument()
    // Uncalibrated: the estimate cards say so instead of showing 0.
    expect(screen.getAllByText('estimate')).toHaveLength(2)
    expect(screen.getAllByText('Not available')).toHaveLength(2)
    expect(screen.getAllByText(/No plates in these days were scanned with a calibrated camera/)).toHaveLength(2)

    // Only the explanatory "not kg or litres" sentence may name a physical unit.
    const text = (container.textContent ?? '').replace(/not kg or litres|not kilograms, litres, or dollars/g, '')
    expect(text).not.toMatch(PHYSICAL_UNITS)
  })

  it('says Not available instead of zero when there are no impact points', () => {
    const d = dashboard()
    d.totals = { ...d.totals, co2Points: null, waterPoints: null, impactPoints: null }
    d.coverage = { ...d.coverage, itemsWithoutFactor: 0 }
    render(<HeadlineCards data={d} />)
    expect(screen.getAllByText('Not available')).toHaveLength(3)
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
  const names = () =>
    within(screen.getByRole('list', { name: /^Foods ranked by/ }))
      .getAllByRole('listitem')
      .map((li) => li.querySelector('span')?.textContent)

  it('ranks by pixels per portion by default; foods without a rate follow with the reason', () => {
    render(<MostWasted rows={dashboard().mostWasted} />)
    expect(screen.getByRole('heading', { name: 'Ancho Flank Steak had the most food left per portion.' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Per portion', pressed: true })).toBeInTheDocument()
    expect(names()).toEqual(['Ancho Flank Steak', 'Pepperoni Pizza', "Chef's Soup of the Day", 'Farro', 'Food not on the menu'])
    const items = within(screen.getByRole('list', { name: /^Foods ranked by/ })).getAllByRole('listitem')
    expect(items[0]).toHaveTextContent('2,857 pixels per portion')
    expect(items[0]).toHaveTextContent('400,000 pixels in total')
    expect(items[3]).toHaveTextContent('No portions entered')
    expect(items[4]).toHaveTextContent('Not on the menu, so it has no portions')
    expect(document.body.textContent).not.toMatch(PHYSICAL_UNITS)
  })

  it('toggles to total pixels and to impact points', () => {
    render(<MostWasted rows={dashboard().mostWasted} />)
    fireEvent.click(screen.getByRole('button', { name: 'Total pixels' }))
    expect(screen.getByRole('heading', { name: 'Pepperoni Pizza had the most food left in total.' })).toBeInTheDocument()
    expect(names()).toEqual(['Pepperoni Pizza', 'Ancho Flank Steak', "Chef's Soup of the Day", 'Farro', 'Food not on the menu'])
    const items = within(screen.getByRole('list', { name: /^Foods ranked by/ })).getAllByRole('listitem')
    expect(items[0]).toHaveTextContent('900,000 pixels')
    expect(items[0]).toHaveTextContent('5,365 impact points')

    fireEvent.click(screen.getByRole('button', { name: 'Impact points' }))
    expect(screen.getByText('points are relative')).toBeInTheDocument()
    expect(names()).toEqual(['Ancho Flank Steak', 'Pepperoni Pizza', 'Farro', "Chef's Soup of the Day", 'Food not on the menu'])
    const impactItems = within(screen.getByRole('list', { name: /^Foods ranked by/ })).getAllByRole('listitem')
    expect(impactItems[0]).toHaveTextContent('13,396 impact points')
    expect(impactItems[1]).toHaveTextContent('greenhouse gases 14,454, water 1,746')
    expect(impactItems[3]).toHaveTextContent('No impact data for this food')
    expect(document.body.textContent).not.toMatch(PHYSICAL_UNITS)
  })
})

describe('factor source note', () => {
  it('labels foods whose factors come from the 500 common foods table, and only those', () => {
    const rows = [
      row({ displayName: 'Scrambled Eggs', factorTable: 'common-500' }),
      row({ displayName: 'Ancho Flank Steak', factorTable: 'east-quad' }),
    ]
    render(<MostWasted rows={rows} initialRank="pixels" />)
    const items = within(screen.getByRole('list', { name: 'Foods ranked by total pixels wasted' })).getAllByRole('listitem')
    const item = (name: string) => items.find((li) => li.textContent?.includes(name))!
    expect(item('Scrambled Eggs')).toHaveTextContent('factors: common foods table')
    expect(item('Ancho Flank Steak')).not.toHaveTextContent('common foods table')
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
