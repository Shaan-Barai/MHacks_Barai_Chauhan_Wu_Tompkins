import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SetupWizard } from './SetupWizard'

describe('SetupWizard', () => {
  it('adds several dining halls, then offers repeat and the API on the menu step', async () => {
    const onComplete = vi.fn()
    render(<SetupWizard onComplete={onComplete} />)
    fireEvent.change(screen.getByLabelText('Dining hall name'), { target: { value: 'South Quad' } })
    fireEvent.click(screen.getByRole('button', { name: '+ Add another location' }))
    fireEvent.change(screen.getByLabelText('Location 2'), { target: { value: 'Bursley' } })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))

    expect(screen.getByLabelText('Dining hall')).toHaveDisplayValue('South Quad')
    expect(screen.getByLabelText('Repeat:')).toHaveDisplayValue('Never')
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(
      expect.arrayContaining(['Never', 'Every day', 'Every week', 'Every other week']),
    )
    fireEvent.change(screen.getByLabelText('Repeat:'), { target: { value: 'weekly' } })
    expect(screen.getByLabelText('Until')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Save \d+ days/ })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Send menus through the API' }))
    expect(screen.getByText(/^POST .*\/api\/menus\/upload$/)).toBeInTheDocument()
    expect(screen.getByText('hall-main', { selector: 'code' })).toBeInTheDocument()
    expect(screen.getByRole('tooltip').textContent).toMatch(/another program/)

    fireEvent.click(screen.getByRole('button', { name: 'Go to the dashboard' }))
    expect(onComplete.mock.calls[0][0].halls).toEqual([
      { hallId: 'hall-main', name: 'South Quad' },
      { hallId: 'hall-bursley', name: 'Bursley' },
    ])
  })
})
