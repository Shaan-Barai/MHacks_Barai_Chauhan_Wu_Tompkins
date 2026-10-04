/** App shell: public reads, staff sign-in, gated write controls, SPA routes and the 404 page (mock data). */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import App, { pageForPath } from './App'
import { MOCK_PASSCODE } from './data/api'
import { AUTH_REQUIRED_EVENT } from './data/authEvents'

beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
})

afterEach(() => {
  window.history.pushState(null, '', '/')
})

describe('routes', () => {
  it('maps paths to pages and unknown paths to the 404 page', () => {
    expect(pageForPath('/')).toBe('dashboard')
    expect(pageForPath('/settings/')).toBe('settings')
    expect(pageForPath('/behind-the-scenes')).toBe('behind')
    expect(pageForPath('/nope')).toBeNull()
  })

  it('shows a friendly 404 with a way back to the dashboard', async () => {
    window.history.pushState(null, '', '/no-such-page')
    render(<App />)
    expect(await screen.findByRole('heading', { name: "We couldn't find that page." })).toHaveFocus()
    expect(document.title).toBe('Page not found · ScrapSaver')
    fireEvent.click(screen.getByRole('button', { name: 'Go to the dashboard' }))
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/')
  })

  it('nav links are real links that change the address', async () => {
    render(<App />)
    const nav = screen.getByRole('navigation', { name: 'Main' })
    const link = within(nav).getByRole('link', { name: 'Menus' })
    expect(link).toHaveAttribute('href', '/menus')
    fireEvent.click(link)
    expect(window.location.pathname).toBe('/menus')
    expect(link).toHaveAttribute('aria-current', 'page')
    expect(await screen.findByRole('heading', { name: 'Menus', level: 1 })).toBeInTheDocument()
  })
})

describe('staff sign-in', () => {
  it('visitors read the dashboard without setup; menus show a sign-in hint instead of the editor', async () => {
    window.history.pushState(null, '', '/menus')
    render(<App />)
    expect(await screen.findByText('Sign in to change this.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save this day' })).toBeNull()
    expect(screen.queryByText(/What is your dining hall called/)).toBeNull()
  })

  it('signs in with the passcode (wrong one first), unlocks the editors, and signs out', async () => {
    window.history.pushState(null, '', '/menus')
    render(<App />)
    fireEvent.click(await within(screen.getByRole('navigation', { name: 'Main' })).findByRole('button', { name: 'Staff sign-in' }))
    const dialog = screen.getByRole('dialog', { name: 'Staff sign-in' })
    const input = within(dialog).getByLabelText('Staff passcode')
    expect(input).toHaveFocus()
    expect(input).toHaveAttribute('type', 'password')

    fireEvent.click(within(dialog).getByRole('button', { name: 'Sign in' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Enter the staff passcode.')
    fireEvent.change(input, { target: { value: 'wrong' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent("That passcode didn't work."))

    fireEvent.change(input, { target: { value: MOCK_PASSCODE } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // staff without saved hall settings get first-time setup
    expect(await screen.findByText(/What is your dining hall called/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Dining hall name'), { target: { value: 'Test Hall' } })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByRole('button', { name: 'Go to the dashboard' }))

    expect(await screen.findByText('Signed in as staff')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save this day' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(await screen.findByText('Sign in to change this.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save this day' })).toBeNull()
  })

  it('Escape closes the dialog; a 401 from any change opens it with a reason', async () => {
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Staff sign-in' }))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()

    window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT))
    expect(await screen.findByRole('dialog')).toHaveTextContent('Sign in to save this change.')
  })
})
