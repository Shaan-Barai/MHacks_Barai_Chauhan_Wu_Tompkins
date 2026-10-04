import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MenuSchedulePage } from './MenuSchedulePage'
import { DEFAULT_SETTINGS, withHalls } from '../state/settings'
import { loadForecast } from '../state/forecasts'
import { todayIso } from '../lib/dates'

const settings = withHalls(DEFAULT_SETTINGS, [{ hallId: 'hall-main', name: 'South Quad' }])

describe('MenuSchedulePage', () => {
  it('shows add a menu (with a meal-times row) then portions forecasted, with no calendar or per-meal results box', async () => {
    render(<MenuSchedulePage settings={settings} onSettingsChange={() => {}} />)
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
    const order = ['Add a menu', 'Portions forecasted'].map((t) => headings.findIndex((h) => h?.startsWith(t)))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(screen.queryByText(/No plates were scanned/)).toBeNull()
    expect(screen.queryByRole('button', { name: /Previous month/ })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Meal times' })).toBeNull()
    expect(screen.getByRole('group', { name: 'Breakfast times' })).toBeInTheDocument()
  })

  it('changes when a meal runs from the row under the meal boxes, for the menu date’s days', () => {
    const onSettingsChange = vi.fn()
    render(<MenuSchedulePage settings={settings} onSettingsChange={onSettingsChange} />)
    fireEvent.change(screen.getByLabelText('Lunch end time'), { target: { value: '15:00' } })
    const next = onSettingsChange.mock.calls[0][0]
    const changed = next.timeSets.find((t: { meals: { lunch: { end: string } } }) => t.meals.lunch.end === '15:00')
    expect(changed).toBeDefined()
    expect(next.timeSets).toHaveLength(settings.timeSets.length)
  })

  it('forecasts portions for each food on the day’s menu', async () => {
    render(<MenuSchedulePage settings={settings} onSettingsChange={() => {}} />)
    const forecast = screen.getByRole('heading', { name: /Portions forecasted/ }).closest('div')!
    const inputs = await within(forecast).findAllByLabelText(/^Portions forecasted: /)
    fireEvent.change(inputs[0], { target: { value: '120' } })
    fireEvent.click(within(forecast).getByRole('button', { name: 'Save forecast' }))
    expect(within(forecast).getByRole('status')).toHaveTextContent('Forecast saved.')
    expect(Object.values(loadForecast('hall-main', todayIso(), 'lunch'))).toEqual([120])
  })
})
