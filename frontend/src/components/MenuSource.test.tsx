import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MenuSource, repeatDates } from './MenuSource'
import { saveUserMenuDays } from '../data/api'

vi.mock('../data/api', () => ({ saveUserMenu: vi.fn(), saveUserMenuDays: vi.fn(), HALL_TIMEZONE: 'America/Detroit' }))
const halls = [{ id: 'hall-main', name: 'South Quad' }, { id: 'hall-b', name: 'Bursley' }]

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(saveUserMenuDays).mockResolvedValue(undefined)
})

describe('repeatDates', () => {
  it('steps by a day, a week or two weeks through the end date', () => {
    expect(repeatDates('2026-10-05', 'never', '2026-12-01')).toEqual(['2026-10-05'])
    expect(repeatDates('2026-10-05', 'daily', '2026-10-07')).toEqual(['2026-10-05', '2026-10-06', '2026-10-07'])
    expect(repeatDates('2026-10-05', 'weekly', '2026-10-19')).toEqual(['2026-10-05', '2026-10-12', '2026-10-19'])
    expect(repeatDates('2026-10-05', 'biweekly', '2026-11-01')).toEqual(['2026-10-05', '2026-10-19'])
    expect(repeatDates('2026-10-05', 'weekly', '2026-10-01')).toEqual(['2026-10-05'])
  })
})

describe('Add a menu', () => {
  it('saves a weekly menu on every repeat date', async () => {
    render(<MenuSource initialDate="2026-10-05" locations={halls} />)
    fireEvent.change(screen.getByLabelText('Repeat:'), { target: { value: 'weekly' } })
    fireEvent.change(screen.getByLabelText('Until'), { target: { value: '2026-10-19' } })
    fireEvent.change(screen.getByLabelText('Lunch item 1'), { target: { value: 'Tomato Soup' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save this day' }))
    await waitFor(() => expect(saveUserMenuDays).toHaveBeenCalled())
    const [dates, meals] = vi.mocked(saveUserMenuDays).mock.calls[0]
    expect(dates).toEqual(['2026-10-05', '2026-10-12', '2026-10-19'])
    expect(meals.lunch.map((i) => i.displayName)).toEqual(['Tomato Soup'])
    expect(await screen.findByText(/Saved: 2026-10-05, 2026-10-12, 2026-10-19\./)).toBeInTheDocument()
  })

  it('has no end date when the menu does not repeat', () => {
    render(<MenuSource initialDate="2026-10-05" locations={halls} />)
    expect(screen.getByLabelText('Repeat:')).toHaveValue('never')
    expect(screen.queryByLabelText('Until')).toBeNull()
  })

  it('shows the API option with an explanation and every dining hall code', () => {
    render(<MenuSource locations={halls} />)
    expect(screen.getByRole('tooltip')).toHaveTextContent(/menu software send menus to ScrapSaver/)
    fireEvent.click(screen.getByRole('button', { name: 'API' }))
    expect(screen.getByRole('heading', { name: 'Send menus by API' })).toBeInTheDocument()
    expect(screen.getByText(/\/api\/menus\/upload$/)).toBeInTheDocument()
    expect(screen.getByText('hall-b')).toBeInTheDocument()
    expect(screen.queryByLabelText('Menu date')).toBeNull()
  })
})
