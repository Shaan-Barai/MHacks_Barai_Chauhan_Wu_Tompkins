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
  it('shows the four cards; uncalibrated estimates are dashes (never 0) and plates scanned counts analyzed plates', () => {
    const { container } = render(<HeadlineCards data={dashboard()} />)
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'Carbon emissions',
      'Water',
      'Food wasted',
      'Plates scanned',
    ])
    expect(screen.getByLabelText('Carbon emissions: not available')).toHaveTextContent('—')
    expect(screen.getByLabelText('Water: not available')).toHaveTextContent('—')
    expect(screen.getByLabelText('Food wasted: not available')).toHaveTextContent('—')
    expect(screen.getByLabelText('Plates scanned: 124 plates')).toBeInTheDocument()
    // no est. badge without a number
    expect(screen.queryByText('est.')).toBeNull()
    // the dashboard headline no longer shows pixels or points
    expect(container.textContent).not.toMatch(/pixels|points/)
    expect(container.textContent).not.toMatch(PHYSICAL_UNITS)
  })

  it('says not available instead of zero when there are no analyzed plates or estimates', () => {
    const d = dashboard()
    d.totals = { ...d.totals, captures: 0, analyzedCaptures: 0, pixels: 0, kgCo2e: null, waterLitres: null, grams: null }
    render(<HeadlineCards data={d} />)
    expect(screen.getByLabelText('Plates scanned: 0 plates')).toBeInTheDocument()
    expect(screen.getAllByLabelText(/: not available$/)).toHaveLength(3)
    // a counted zero is fine for plates; the estimates are dashes, never 0
    expect(screen.getAllByText('—')).toHaveLength(3)
    expect(screen.getAllByText('0')).toHaveLength(1)
  })
})

describe('FoodsToTarget', () => {
  it('ranks by pixels per portion with impact points per portion, demo badge, and explains unranked foods', () => {
    const d = dashboard()
    render(<FoodsToTarget rows={d.targets} demoPortions />)
    expect(screen.getByRole('heading', { name: 'Foods to target' })).toBeInTheDocument()
    const table = screen.getByRole('table', { name: 'Foods ranked by Pixels wasted per portion served' })
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
    expect(screen.getByText('Demo portions')).toBeInTheDocument()

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
    expect(screen.queryByText('Demo portions')).toBeNull()
    expect(screen.getAllByRole('row')).toHaveLength(1 + 8)
    fireEvent.click(screen.getByRole('button', { name: 'Show all 10 foods' }))
    expect(screen.getAllByRole('row')).toHaveLength(1 + 10)
  })

  it('says nothing can be ranked yet when no food has a rate', () => {
    render(<FoodsToTarget rows={[row({ displayName: 'Farro', portionsServed: null, perPortion: null })]} demoPortions />)
    expect(screen.getByText('Nothing to rank yet.')).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.getByText("Can't rank yet").parentElement).toHaveTextContent('Farro: No portions entered')
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
    expect(screen.getByRole('heading', { name: 'Most wasted foods' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Per portion', pressed: true })).toBeInTheDocument()
    expect(screen.queryByText('Nothing to rank yet.')).toBeNull()
    expect(names()).toEqual(['Ancho Flank Steak', 'Pepperoni Pizza', "Chef's Soup of the Day", 'Farro', 'Food not on the menu'])
    const items = within(screen.getByRole('list', { name: /^Foods ranked by/ })).getAllByRole('listitem')
    expect(items[0]).toHaveTextContent('2,857 pixels per portion')
    expect(items[1]).toHaveTextContent('1,452 pixels per portion')
    expect(items[2]).toHaveTextContent('1,400 pixels per portion')
    expect(items[3]).toHaveTextContent('No portions entered')
    expect(items[4]).toHaveTextContent('Not on the menu, so it has no portions')
    expect(document.body.textContent).not.toMatch(PHYSICAL_UNITS)
  })

  it('toggles to total pixels and to impact points', () => {
    render(<MostWasted rows={dashboard().mostWasted} />)
    fireEvent.click(screen.getByRole('button', { name: 'Total pixels' }))
    expect(screen.getByRole('button', { name: 'Total pixels', pressed: true })).toBeInTheDocument()
    expect(screen.queryByText('relative')).toBeNull()
    expect(names()).toEqual(['Pepperoni Pizza', 'Ancho Flank Steak', "Chef's Soup of the Day", 'Farro', 'Food not on the menu'])
    const items = within(screen.getByRole('list', { name: /^Foods ranked by/ })).getAllByRole('listitem')
    expect(items[0]).toHaveTextContent('900,000 pixels')
    expect(items[1]).toHaveTextContent('400,000 pixels')
    expect(items[4]).toHaveTextContent('30,000 pixels')

    fireEvent.click(screen.getByRole('button', { name: 'Impact points' }))
    expect(screen.getByText('relative')).toBeInTheDocument()
    expect(names()).toEqual(['Ancho Flank Steak', 'Pepperoni Pizza', 'Farro', "Chef's Soup of the Day", 'Food not on the menu'])
    const impactItems = within(screen.getByRole('list', { name: /^Foods ranked by/ })).getAllByRole('listitem')
    expect(impactItems[0]).toHaveTextContent('13,396 impact points')
    expect(impactItems[1]).toHaveTextContent('5,365 impact points')
    expect(impactItems[2]).toHaveTextContent('33.5 impact points')
    // foods without impact points follow with the reason, never 0
    expect(impactItems[3]).toHaveTextContent('No impact data for this food')
    expect(impactItems[4]).toHaveTextContent('Not on the menu, so no impact points')
    expect(impactItems[3]).not.toHaveTextContent(/\b0 impact points/)
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
  it('shows relative nutrition points with the top three foods, highest first', () => {
    render(<NutritionLost data={dashboard()} />)
    expect(screen.getByRole('heading', { name: 'Nutrition lost' })).toBeInTheDocument()
    expect(screen.getByText('relative points')).toBeInTheDocument()
    expect(screen.getByText('1,159').parentElement).toHaveTextContent('1,159points')
    const items = screen.getAllByRole('listitem').map((li) => li.textContent)
    expect(items).toEqual(['Pepperoni Pizza621', 'Ancho Flank Steak504', 'Farro33.6'])
    // it is its own number, not the impact score
    expect(screen.queryByText(/18,795/)).toBeNull()
    expect(screen.queryByText(/nutrient-days/)).toBeNull()
  })

  it('shows a dash, not 0, when nutrition is missing', () => {
    const d = dashboard({ mostWasted: [row({ displayName: 'X', impact: impact({ nutritionPoints: null }) })] })
    d.totals = { ...d.totals, nutritionPoints: null }
    render(<NutritionLost data={d} />)
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.queryByText(/^0$/)).toBeNull()
    expect(screen.queryByRole('listitem')).toBeNull()
  })
})
