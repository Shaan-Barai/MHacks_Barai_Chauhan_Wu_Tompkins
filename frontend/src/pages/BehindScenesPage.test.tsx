import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { BehindScenesPage } from './BehindScenesPage'

describe('BehindScenesPage', () => {
  it('shows the plate pictures (moved from the dashboard) above the per-plate food tables', async () => {
    render(<BehindScenesPage />)
    const pictures = await screen.findByRole('heading', { name: 'Plates' })
    const foods = screen.getByRole('heading', { name: 'Foods found on each plate' })
    expect(pictures.compareDocumentPosition(foods) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
