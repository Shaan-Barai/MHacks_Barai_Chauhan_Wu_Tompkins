import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MenuSchedulePage } from './MenuSchedulePage'
import { DEFAULT_SETTINGS, withHalls } from '../state/settings'
import { loadForecast } from '../state/forecasts'
import { todayIso } from '../lib/dates'

const settings = withHalls(DEFAULT_SETTINGS, [{ hallId: 'hall-main', name: 'South Quad' }])

describe('MenuSchedulePage', () => {
  it('stacks add a menu, meal times, and portions forecasted above the calendar, with no per-meal results box', async () => {
    render(<MenuSchedulePage settings={settings} onSettingsChange={() => {}} />)
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
    const order = ['Add a menu', 'Meal times', 'Portions forecasted'].map((t) => headings.findIndex((h) => h?.startsWith(t)))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(screen.queryByText(/No plates were scanned/)).toBeNull()
    expect(await screen.findByRole('button', { name: /Previous month/ })).toBeInTheDocument()
  })

  it('saves meal times from the Menu Schedule page', () => {
    const onSettingsChange = vi.fn()
    render(<MenuSchedulePage settings={settings} onSettingsChange={onSettingsChange} />)
    fireEvent.change(screen.getAllByLabelText('Lunch end time')[0], { target: { value: '15:00' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save meal times' }))
    expect(onSettingsChange.mock.calls[0][0].timeSets[0].meals.lunch.end).toBe('15:00')
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
