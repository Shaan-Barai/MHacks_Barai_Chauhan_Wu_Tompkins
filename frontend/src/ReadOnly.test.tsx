/** Read-only public site (backend READ_ONLY=1): recorded data only, no write, AI or camera controls (mock data). */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import App from './App'
import * as api from './data/api'
import { AUTH_REQUIRED_EVENT } from './data/authEvents'

const NOTICE = 'Read-only view: this site shows recorded data. Uploads and edits are turned off.'

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
  vi.restoreAllMocks()
  window.history.pushState(null, '', '/')
})

function open(path: string) {
  window.history.pushState(null, '', path)
  return render(<App />)
}

describe('read-only site', () => {
  beforeEach(() => api.setMockReadOnly(true))

  it('shows the notice above the page', async () => {
    open('/dashboard')
    expect(await screen.findByText(NOTICE)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeInTheDocument()
  })

  it('keeps the landing page working', () => {
    open('/')
    expect(screen.getByRole('link', { name: 'Get started' })).toBeInTheDocument()
    expect(screen.queryByText(NOTICE)).toBeNull()
  })

  it('Menus shows the saved menu with no editor or spreadsheet upload', async () => {
    open('/menus')
    expect(await screen.findByText(NOTICE)).toBeInTheDocument()
    expect(await screen.findByText(/^(Menu for|No menu for) /)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save this day' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Upload a spreadsheet instead' })).toBeNull()
    expect(screen.queryByLabelText('Upload a menu spreadsheet (.csv)')).toBeNull()
  })

  it('Portions served shows the counts as text, with no save or upload', async () => {
    open('/portions')
    // PortionsPage.test.tsx checks the counts themselves; here, whichever the demo meal shows has no inputs.
    expect(await screen.findByText(/^(Counts for this meal|No menu for this meal\.)$/)).toBeInTheDocument()
    expect(screen.queryByRole('spinbutton')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save portions served' })).toBeNull()
    expect(screen.queryByLabelText('Upload filled portions sheet')).toBeNull()
  })

  it('Statistics shows the recommendation without "Ask again"', async () => {
    const regenerate = vi.spyOn(api, 'regenerateRecommendation')
    open('/statistics')
    expect(await screen.findByRole('heading', { name: 'Recommendations' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Ask again' })).toBeNull()
    expect(regenerate).not.toHaveBeenCalled()
  })

  it('Behind the scenes has no Try an Image tab, and its address shows the plates without calling it', async () => {
    const status = vi.spyOn(api, 'getTryImageStatus')
    open('/behind-the-scenes/try-an-image')
    expect(await screen.findByText(NOTICE)).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'This week' })).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Try an Image' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Upload a photo' })).toBeNull()
    expect(status).not.toHaveBeenCalled()
  })

  it('Settings keeps the browser-only hall settings but drops the demo data buttons', async () => {
    open('/settings')
    expect(await screen.findByText('Showing the real scans.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save settings' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Load dummy data' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Clear data' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Restore default' })).toBeNull()
  })

  it('Admin says it is not available, with no passcode form', async () => {
    const admin = vi.spyOn(api, 'getAdminCaptures')
    open('/admin')
    expect(await screen.findByText('Admin is not available on the public site.')).toBeInTheDocument()
    expect(screen.queryByLabelText('Passcode')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Unlock' })).toBeNull()
    expect(admin).not.toHaveBeenCalled()
  })

  it('a stray 401 never opens the passcode prompt', async () => {
    open('/dashboard')
    await screen.findByText(NOTICE)
    window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT))
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('normal site (not read-only)', () => {
  it('has no notice and keeps every editor', async () => {
    open('/statistics')
    expect(await screen.findByRole('button', { name: 'Ask again' })).toBeInTheDocument()
    expect(screen.queryByText(NOTICE)).toBeNull()
  })

  it('keeps the Try an Image tab, the menu editor and the demo data buttons', async () => {
    const { unmount } = open('/behind-the-scenes')
    expect(screen.getByRole('tab', { name: 'Try an Image' })).toBeInTheDocument()
    unmount()
    const menus = open('/menus')
    expect(await screen.findByRole('button', { name: 'Save this day' })).toBeInTheDocument()
    menus.unmount()
    open('/settings')
    const card = (await screen.findByRole('heading', { name: 'Demo data' })).parentElement!
    expect(within(card).getByRole('button', { name: 'Load dummy data' })).toBeInTheDocument()
  })
})
