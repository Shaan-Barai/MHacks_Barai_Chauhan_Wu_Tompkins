import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { LandingPage } from './LandingPage'

describe('LandingPage', () => {
  it('shows the name and Get started links to the dashboard', () => {
    const onStart = vi.fn()
    render(<LandingPage onStart={onStart} />)
    expect(screen.getByRole('heading', { name: 'ScrapSaver', level: 1 })).toBeInTheDocument()
    const link = screen.getByRole('link', { name: 'Get started' })
    expect(link).toHaveAttribute('href', '/dashboard')
    fireEvent.click(link)
    expect(onStart).toHaveBeenCalledTimes(1)
  })

  it('leaves modified clicks (new tab) to the browser', () => {
    const onStart = vi.fn()
    render(<LandingPage onStart={onStart} />)
    // Record whether the app cancelled the click, then stop jsdom from trying to navigate.
    let cancelledByApp: boolean | null = null
    const stop = (e: Event) => {
      cancelledByApp = e.defaultPrevented
      e.preventDefault()
    }
    document.addEventListener('click', stop)
    fireEvent.click(screen.getByRole('link', { name: 'Get started' }), { metaKey: true })
    document.removeEventListener('click', stop)
    expect(onStart).not.toHaveBeenCalled()
    expect(cancelledByApp).toBe(false)
  })
})
