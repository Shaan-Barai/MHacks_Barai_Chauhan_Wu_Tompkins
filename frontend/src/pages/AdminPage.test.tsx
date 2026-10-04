/** Admin: choose which plates the dashboard shows (mock layer). */
import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AdminPage } from './AdminPage'
import { getCaptures, login, MOCK_PASSCODE } from '../data/api'
import { addDays, todayIso } from '../lib/dates'
import { AuthProvider } from '../state/auth'

function renderAdmin(status: 'signedIn' | 'signedOut') {
  return render(
    <AuthProvider initialStatus={status}>
      <AdminPage />
    </AuthProvider>,
  )
}

describe('AdminPage', () => {
  beforeEach(() => localStorage.clear())

  it('asks a signed-out visitor to sign in and lists nothing', () => {
    renderAdmin('signedOut')
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Hide the plate/ })).toBeNull()
  })

  it('hides a plate from the dashboard, filters by Shown/Hidden, and shows it again', async () => {
    await login(MOCK_PASSCODE)
    renderAdmin('signedIn')
    const toggles = await screen.findAllByRole('button', { name: /Hide the plate/ })
    const total = toggles.length
    expect(total).toBeGreaterThan(1)

    const range = { start: addDays(todayIso(), -89), end: todayIso() }
    const before = await getCaptures(range.start, range.end)
    fireEvent.click(toggles[0]!)
    await waitFor(() => expect(screen.getAllByRole('button', { name: /Show the plate/ })).toHaveLength(1))
    expect((await getCaptures(range.start, range.end)).length).toBe(before.length - 1)

    fireEvent.click(screen.getByRole('button', { name: /^Hidden \(1\)/ }))
    expect(screen.getAllByRole('button', { name: /the plate at/ })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Show all listed' }))
    await waitFor(() => expect(screen.getByRole('button', { name: /^Hidden \(0\)/ })).toBeInTheDocument())
    expect((await getCaptures(range.start, range.end)).length).toBe(before.length)
  })

  it('hides every listed plate at once', async () => {
    await login(MOCK_PASSCODE)
    renderAdmin('signedIn')
    const toggles = await screen.findAllByRole('button', { name: /Hide the plate/ })
    fireEvent.click(screen.getByRole('button', { name: 'Hide all listed' }))
    await waitFor(() => expect(screen.getAllByRole('button', { name: /Show the plate/ })).toHaveLength(toggles.length))
    expect(screen.getByRole('button', { name: /^Shown \(0\)/ })).toBeInTheDocument()
  })
})
