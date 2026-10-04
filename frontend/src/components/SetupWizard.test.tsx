import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SetupWizard } from './SetupWizard'
import { loadSettings } from '../state/settings'

vi.mock('./MenuSource', () => ({ MenuSource: () => null }))

describe('Setup step 1', () => {
  it('adds, removes and saves several dining hall names, dropping empty boxes', () => {
    const onComplete = vi.fn()
    render(<SetupWizard onComplete={onComplete} />)
    const next = screen.getByRole('button', { name: 'Next' })
    expect(next).toBeDisabled()

    fireEvent.change(screen.getByLabelText('Dining hall name'), { target: { value: ' South Quad ' } })
    expect(next).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: 'Add another location' }))
    const second = screen.getByLabelText('Dining hall 2')
    expect(second).toHaveFocus()
    fireEvent.change(second, { target: { value: 'Bursley' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add another location' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add another location' }))
    fireEvent.change(screen.getByLabelText('Dining hall 4'), { target: { value: 'East Quad' } })
    fireEvent.click(screen.getByRole('button', { name: 'Remove dining hall 2' }))

    fireEvent.click(next)
    fireEvent.click(screen.getByRole('button', { name: 'Go to the dashboard' }))
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ locations: ['South Quad', 'East Quad'] }))
  })
})

describe('Saved settings', () => {
  it('turns a single saved hall name into one location', () => {
    localStorage.setItem('scrap.hallSettings.v1', JSON.stringify({ hallId: 'hall-main', name: 'South Quad' }))
    expect(loadSettings()?.locations).toEqual(['South Quad'])
  })
})
