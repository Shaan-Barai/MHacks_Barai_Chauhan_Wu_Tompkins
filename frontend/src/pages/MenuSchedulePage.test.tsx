import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MenuSchedulePage } from './MenuSchedulePage'
import { DEFAULT_SETTINGS } from '../state/settings'
import { addDays, formatLong, todayIso } from '../lib/dates'

const settings = { ...DEFAULT_SETTINGS, locations: [{ id: 'hall-main', name: 'South Quad' }] }

describe('Menu Schedule', () => {
  it('puts adding a menu (with the API option) above the schedule', () => {
    render(<MenuSchedulePage settings={settings} dataRevision={0} />)
    expect(screen.getByRole('heading', { level: 1, name: 'Menu Schedule' })).toBeInTheDocument()
    const add = screen.getByRole('region', { name: 'Add a menu' })
    const schedule = screen.getByRole('region', { name: 'Schedule' })
    expect(add.compareDocumentPosition(schedule) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(add).getByRole('button', { name: 'API' })).toBeInTheDocument()
    expect(within(schedule).getByRole('tablist', { name: 'Meal' })).toBeInTheDocument()
  })

  it('loads the picked day into the add-a-menu form', () => {
    render(<MenuSchedulePage settings={settings} dataRevision={0} />)
    const day = addDays(todayIso(), todayIso().endsWith('-01') ? 1 : -1)
    const schedule = screen.getByRole('region', { name: 'Schedule' })
    fireEvent.click(within(schedule).getByRole('button', { name: new RegExp(`^${formatLong(day)}(,|$)`) }))
    expect(screen.getByLabelText('Menu date')).toHaveValue(todayIso())
    fireEvent.click(screen.getByRole('button', { name: "Add or replace this day's menu" }))
    expect(screen.getByLabelText('Menu date')).toHaveValue(day)
  })
})
