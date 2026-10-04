/** Settings -> Camera calibration against the mock layer (VITE_USE_MOCK data). */
import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { CameraCalibrationPanel, flagText } from './CameraCalibration'
import { getMeasurementSettings, login, MOCK_PASSCODE } from '../data/api'
import { MOCK_CARD_PIXELS, mockCalibration } from '../data/mockData'
import { AuthProvider } from '../state/auth'

function renderPanel(status: 'signedIn' | 'signedOut') {
  return render(
    <AuthProvider initialStatus={status}>
      <CameraCalibrationPanel />
    </AuthProvider>,
  )
}

const photo = () => new File([new Uint8Array([0xff, 0xd8, 0xff])], 'card.jpg', { type: 'image/jpeg' })

beforeEach(() => localStorage.clear())

describe('CameraCalibrationPanel without a session', () => {
  it('shows the active calibration with its scale and camera height, history, and the write controls (no sign-in gate)', async () => {
    renderPanel('signedOut')
    expect(screen.getByRole('heading', { name: 'Camera calibration' })).toBeInTheDocument()
    expect(screen.queryByText(/sign in/i)).toBeNull()
    // editors are always shown; the backend decides whether a save needs the passcode
    expect(screen.getByRole('form', { name: 'New calibration' })).toBeInTheDocument()

    // Depth Anything V2 is gone: no toggle, no plate thickness, no second height.
    expect(screen.queryByRole('switch')).toBeNull()
    expect(screen.queryByText(/Depth Anything|depth|volume|thickness/i)).toBeNull()

    // the active calibration is shown first
    const result = await screen.findByRole('region', { name: /Calibration from/ })
    expect(within(result).getAllByText('Active').length).toBeGreaterThan(0)
    expect(within(result).getByText('credit card, 46.21 cm²')).toBeInTheDocument()
    expect(within(result).getByText('30,730 pixels')).toBeInTheDocument()
    // k = 46.21 / 30,730 = 0.0015037 cm²/px (3 significant digits: 0.00150)
    expect(within(result).getByText('0.0015 cm² per pixel')).toBeInTheDocument()
    // height = 1289.7 px × √0.0015037 = 50.01 cm
    expect(within(result).getByText('50.0 cm')).toBeInTheDocument()
    expect(within(result).getByText('1024 × 1024 pixels')).toBeInTheDocument()
    expect(await within(result).findByAltText(/credit card outlined by the AI/)).toBeInTheDocument()

    // the active calibration has nothing to activate
    expect(within(result).queryByRole('button', { name: 'Activate' })).toBeNull()

    // history: four entries, the active one marked
    const history = screen.getByText('Past calibrations').parentElement!
    expect(within(history).getAllByRole('listitem')).toHaveLength(4)
    expect(within(history).getAllByText('Active')).toHaveLength(1)
  })

  it('explains flags in plain words when an older calibration is picked', async () => {
    renderPanel('signedOut')
    const buttons = await screen.findAllByRole('button', { name: /Show the calibration from/ })
    fireEvent.click(buttons[1])
    // k = 46.21 / 31,570 = 0.00146; height = 1289.7 × √k = 49.3 cm; no flags
    expect(await screen.findByText('49.3 cm')).toBeInTheDocument()
    expect(screen.queryByText('Check this')).toBeNull()
    fireEvent.click(buttons[2])
    expect(await screen.findByText(/index card touches the edge of the photo/)).toBeInTheDocument()
    // k = 93.5 / 63,290 = 0.00148; height = 49.6 cm
    expect(screen.getByText('49.6 cm')).toBeInTheDocument()
    fireEvent.click(buttons[3])
    expect(await screen.findByText(/This calibration didn't work: The card was not found in the photo/)).toBeInTheDocument()
    expect(screen.getByText(/credit card was not found in the photo/)).toBeInTheDocument()
  })
})

describe('CameraCalibrationPanel with a session', () => {
  it('uses the credit-card preset, uploads a photo, shows the result, and activates it', async () => {
    await login(MOCK_PASSCODE)
    renderPanel('signedIn')
    const form = await screen.findByRole('form', { name: 'New calibration' })
    const area = within(form).getByLabelText('Known area (cm²)')
    fireEvent.change(area, { target: { value: '12' } })
    const preset = within(form).getByRole('button', { name: 'Credit card (46.21 cm²)' })
    expect(preset).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(preset)
    expect(area).toHaveValue(46.21)
    expect(preset).toHaveAttribute('aria-pressed', 'true')

    // no photo yet
    fireEvent.click(within(form).getByRole('button', { name: 'Calibrate' }))
    expect(await within(form).findByRole('alert')).toHaveTextContent('Choose the calibration photo.')

    fireEvent.change(within(form).getByLabelText('Calibration photo'), { target: { files: [photo()] } })
    fireEvent.click(within(form).getByRole('button', { name: 'Calibrate' }))

    const activate = await screen.findByRole('button', { name: 'Activate' })
    const result = screen.getByRole('region', { name: /Calibration from/ })
    expect(within(result).getByText('Ready')).toBeInTheDocument()
    expect(within(result).queryByText('Active')).toBeNull()
    fireEvent.click(activate)
    await waitFor(() => expect(within(screen.getByRole('region', { name: /Calibration from/ })).getAllByText('Active').length).toBeGreaterThan(0))
    expect(screen.getByRole('status')).toHaveTextContent('This calibration is now active for new plates.')
    const settings = await getMeasurementSettings()
    expect(settings.activeCalibrationId).toMatch(/^cal_demo_new_/)
    expect(screen.getByText('Past calibrations').parentElement!.querySelectorAll('li')).toHaveLength(5)
  })

  it('rejects a non-positive area', async () => {
    await login(MOCK_PASSCODE)
    renderPanel('signedIn')
    const form = await screen.findByRole('form', { name: 'New calibration' })
    fireEvent.change(within(form).getByLabelText('Known area (cm²)'), { target: { value: '0' } })
    fireEvent.change(within(form).getByLabelText('Calibration photo'), { target: { files: [photo()] } })
    fireEvent.click(within(form).getByRole('button', { name: 'Calibrate' }))
    expect(await within(form).findByRole('alert')).toHaveTextContent('more than 0')
    const settings = await getMeasurementSettings()
    expect(Object.keys(settings).sort()).toEqual(['activeCalibrationId', 'hallId', 'updatedAt'])
  })

  it('a refused change (401) opens the passcode prompt; after unlocking, the same change saves', async () => {
    // No session: the editors are shown, but the save comes back 401.
    renderPanel('signedOut')
    const buttons = await screen.findAllByRole('button', { name: /Show the calibration from/ })
    fireEvent.click(buttons[1])
    fireEvent.click(await screen.findByRole('button', { name: 'Activate' }))
    const dialog = await screen.findByRole('dialog', { name: 'Passcode' })
    expect(dialog).not.toHaveTextContent(/sign in/i)
    const input = within(dialog).getByLabelText('Passcode')
    expect(input).toHaveFocus()
    // the refused change was not saved, and the editors stay visible
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.getByRole('form', { name: 'New calibration' })).toBeInTheDocument()
    const before = await getMeasurementSettings()

    fireEvent.change(input, { target: { value: MOCK_PASSCODE } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unlock' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    fireEvent.click(screen.getByRole('button', { name: 'Activate' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('This calibration is now active for new plates.'))
    const after = await getMeasurementSettings()
    expect(after.activeCalibrationId).not.toBe(before.activeCalibrationId)
  })
})

describe('calibration helpers', () => {
  it('k = known area / reference pixels and height = f × √k with the C920s f = 1289.7 px for the 1024² crop', () => {
    const cal = mockCalibration({ calibrationId: 'c', createdAt: '2026-10-04T13:00:00Z', knownAreaCm2: 46.21, referenceLabel: 'credit card', referencePixels: MOCK_CARD_PIXELS })
    expect(cal.cm2PerPx).toBeCloseTo(46.21 / 30_730, 10) // 0.0015037
    expect(cal.cameraHeightCmGeometric).toBeCloseTo(50.01, 2) // 1289.7 × 0.038778
    expect([cal.widthPx, cal.heightPx]).toEqual([1024, 1024])
    expect(cal.flags).toEqual([])
    expect('depth' in cal).toBe(false)
  })

  it('says each reference flag in plain words, and nothing for flags it does not know', () => {
    const cal = mockCalibration({ calibrationId: 'c', createdAt: '2026-10-04T13:00:00Z', knownAreaCm2: 46.21, referenceLabel: 'credit card', referencePixels: MOCK_CARD_PIXELS })
    expect(flagText('reference_not_found', cal)).toMatch(/credit card was not found in the photo/)
    expect(flagText('reference_low_confidence', cal)).toMatch(/unsure of the credit card's outline/)
    expect(flagText('reference_touches_edge', cal)).toMatch(/credit card touches the edge/)
    // a flag stored by an older backend during the removed depth trial
    expect(flagText('depth_unavailable' as unknown as Parameters<typeof flagText>[0], cal)).toBeNull()
  })
})
