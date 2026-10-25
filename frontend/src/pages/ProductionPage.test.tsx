import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { ProductionPage } from './ProductionPage'
import { AuthProvider } from '../state/auth'
import { resetMockProduction, setApiLatency } from '../data/api'

function renderPage(status: 'signedIn' | 'readOnly' = 'signedIn') {
  return render(
    <AuthProvider initialStatus={status === 'readOnly' ? 'signedIn' : status} {...(status === 'readOnly' ? { initialReadOnly: true } : {})}>
      <ProductionPage />
    </AuthProvider>,
  )
}

beforeEach(() => {
  resetMockProduction()
  setApiLatency(0)
})

async function readSheet() {
  const file = new File([new Uint8Array([0xff, 0xd8, 0xff])], 'sheet.jpg', { type: 'image/jpeg' })
  fireEvent.change(screen.getByLabelText('Sheet photo'), { target: { files: [file] } })
  fireEvent.click(screen.getByRole('button', { name: 'Read sheet' }))
  expect(await screen.findByText(/Read 2 rows/)).toBeInTheDocument()
}

describe('Production sheets', () => {
  it('reads a sheet into rows to review; flagged values are outlined with the reason', async () => {
    renderPage()
    await screen.findByText('Nothing to review.')
    await readSheet()
    const flagged = await screen.findByRole('region', { name: 'Sheet row: Stiky rice?' })
    expect(within(flagged).getByText(/Not one of the hall’s dishes/)).toBeInTheDocument()
    expect(within(flagged).getByText(/More left in the pan than was prepared/)).toBeInTheDocument()
    expect(within(flagged).getByText(/not sure it read this correctly\. \(60% sure\)/)).toBeInTheDocument()
    expect(within(flagged).getByRole('button', { name: 'Confirm row' })).toBeDisabled()
    expect(within(flagged).getByText('Fix the outlined values to confirm.')).toBeInTheDocument()
  })

  it('fix, save, then confirm with a name; the row moves to Recently confirmed', async () => {
    renderPage()
    await screen.findByText('Nothing to review.')
    await readSheet()
    const flagged = await screen.findByRole('region', { name: 'Sheet row: Stiky rice?' })
    fireEvent.change(within(flagged).getByLabelText('Dish'), { target: { value: 'sticky-rice' } })
    fireEvent.change(within(flagged).getByLabelText('Pan leftover (lb)'), { target: { value: '1.5' } })
    expect(within(flagged).getByRole('button', { name: 'Confirm row' })).toBeDisabled()
    fireEvent.click(within(flagged).getByRole('button', { name: 'Save changes' }))

    const row = () => screen.getByRole('region', { name: 'Sheet row: Stiky rice?' })
    await waitFor(() => expect(within(row()).queryByText(/Not one of the hall’s dishes/)).toBeNull())
    const fixed = row()
    expect(within(fixed).getByText('Enter your name above to confirm.')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/Your name/), { target: { value: 'Chef Ana' } })
    fireEvent.click(within(fixed).getByRole('button', { name: 'Confirm row' }))

    await waitFor(() => expect(screen.queryByRole('region', { name: 'Sheet row: Stiky rice?' })).toBeNull())
    const table = screen.getByRole('table')
    expect(within(table).getByText('Sticky Rice')).toBeInTheDocument()
    expect(within(table).getByText('Chef Ana')).toBeInTheDocument()
  })

  it('reject keeps a row out of the log', async () => {
    renderPage()
    await screen.findByText('Nothing to review.')
    await readSheet()
    const clean = await screen.findByRole('region', { name: 'Sheet row: Mac and Cheese' })
    fireEvent.click(within(clean).getByRole('button', { name: 'Reject' }))
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Sheet row: Mac and Cheese' })).toBeNull())
    expect(screen.getByText('No confirmed rows yet.')).toBeInTheDocument()
  })
})
