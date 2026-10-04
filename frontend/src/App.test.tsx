/** App shell: landing page, SPA routes, the 404 page, always-shown editors, and the passcode prompt on a 401 (mock data). */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import App, { pageForPath } from './App'
import { MOCK_PASSCODE, getSession } from './data/api'
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

beforeEach(() => localStorage.clear())

afterEach(() => {
  window.history.pushState(null, '', '/')
})

describe('routes', () => {
  it('maps paths to pages and unknown paths to the 404 page', () => {
    expect(pageForPath('/')).toBe('landing')
    expect(pageForPath('/index.html')).toBe('landing')
    expect(pageForPath('/dashboard')).toBe('dashboard')
    expect(pageForPath('/statistics')).toBe('statistics')
    expect(pageForPath('/schedule')).toBe('statistics')
    expect(pageForPath('/settings/')).toBe('settings')
    expect(pageForPath('/behind-the-scenes')).toBe('behind')
    expect(pageForPath('/admin')).toBe('admin')
    expect(pageForPath('/nope')).toBeNull()
  })

  it('the landing page shows the name and Get started opens the dashboard', async () => {
    render(<App />)
    expect(screen.getByRole('heading', { name: 'ScrapSaver', level: 1 })).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull()
    expect(document.title).toBe('ScrapSaver')
    const start = screen.getByRole('link', { name: 'Get started' })
    expect(start).toHaveAttribute('href', '/dashboard')
    fireEvent.click(start)
    expect(window.location.pathname).toBe('/dashboard')
    expect(await screen.findByRole('heading', { name: 'Dashboard', level: 1 })).toBeInTheDocument()
    expect(document.title).toBe('Dashboard · ScrapSaver')
  })

  it('shows a friendly 404 with a way back to the dashboard', async () => {
    window.history.pushState(null, '', '/no-such-page')
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toHaveFocus()
    expect(document.title).toBe('Page not found · ScrapSaver')
    fireEvent.click(screen.getByRole('button', { name: 'Dashboard' }))
    expect(await screen.findByRole('heading', { name: 'Dashboard', level: 1 })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/dashboard')
  })

  it('nav lists the pages in order (not Admin) as real links that change the address', async () => {
    window.history.pushState(null, '', '/dashboard')
    render(<App />)
    const nav = screen.getByRole('navigation', { name: 'Main' })
    const links = within(nav).getAllByRole('link')
    expect(links.map((l) => l.textContent)).toEqual([
      'ScrapSaver',
      'Dashboard',
      'Statistics',
      'Menus',
      'Portions served',
      'Behind the scenes',
      'Settings',
    ])
    expect(within(nav).queryByRole('link', { name: 'Admin' })).toBeNull()
    expect(within(nav).getByRole('link', { name: 'Dashboard' })).toHaveAttribute('aria-current', 'page')

    const link = within(nav).getByRole('link', { name: 'Menus' })
    expect(link).toHaveAttribute('href', '/menus')
    fireEvent.click(link)
    expect(window.location.pathname).toBe('/menus')
    expect(link).toHaveAttribute('aria-current', 'page')
    expect(await screen.findByRole('heading', { name: 'Menus', level: 1 })).toBeInTheDocument()

    fireEvent.click(within(nav).getByRole('link', { name: 'ScrapSaver' }))
    expect(window.location.pathname).toBe('/')
    expect(await screen.findByRole('link', { name: 'Get started' })).toBeInTheDocument()
  })

  it('the old /schedule address opens Statistics', async () => {
    window.history.pushState(null, '', '/schedule')
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Statistics', level: 1 })).toBeInTheDocument()
    expect(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', { name: 'Statistics' })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })
})

describe('owner access', () => {
  it('shows the editors without any sign-in, and no sign-in button or first-run setup', async () => {
    window.history.pushState(null, '', '/menus')
    render(<App />)
    expect(await screen.findByRole('button', { name: 'Save this day' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /sign.in/i })).toBeNull()
    expect(screen.queryByText(/sign in to change/i)).toBeNull()
    expect(screen.queryByText(/What is your dining hall called/)).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('a 401 from any change opens the passcode prompt; Escape closes it', async () => {
    window.history.pushState(null, '', '/dashboard')
    render(<App />)
    window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT))
    const dialog = await screen.findByRole('dialog', { name: 'Passcode' })
    expect(within(dialog).getByLabelText('Passcode')).toHaveFocus()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('the passcode prompt rejects an empty or wrong passcode and unlocks with the right one', async () => {
    window.history.pushState(null, '', '/dashboard')
    render(<App />)
    window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT))
    const dialog = await screen.findByRole('dialog', { name: 'Passcode' })
    const input = within(dialog).getByLabelText('Passcode')
    expect(input).toHaveAttribute('type', 'password')

    fireEvent.click(within(dialog).getByRole('button', { name: 'Unlock' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Enter the passcode.')
    fireEvent.change(input, { target: { value: 'wrong' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unlock' }))
    await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent("That passcode didn't work."))
    expect((await getSession()).signedIn).toBe(false)

    fireEvent.change(input, { target: { value: MOCK_PASSCODE } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unlock' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect((await getSession()).signedIn).toBe(true)
  })
})
