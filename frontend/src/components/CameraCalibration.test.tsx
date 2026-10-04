/** Settings -> Camera calibration against the mock layer (VITE_USE_MOCK data). */
import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { CameraCalibrationPanel, flagText, heightDifference } from './CameraCalibration'
import { getMeasurementSettings, login, MOCK_PASSCODE } from '../data/api'
import { mockCalibration } from '../data/mockData'
import { AuthProvider } from '../state/auth'

function renderPanel(status: 'signedIn' | 'signedOut') {
  return render(
    <AuthProvider initialStatus={status}>
      <CameraCalibrationPanel />
    </AuthProvider>,
  )
}

const photo = () => new File([new Uint8Array([0xff, 0xd8, 0xff])], 'card.jpg', { type: 'image/jpeg' })

describe('CameraCalibrationPanel signed out', () => {
  it('shows the how-to, the active calibration with both heights, and history, but no write controls', async () => {
    renderPanel('signedOut')
    expect(screen.getByText(/Lock the camera in place/)).toBeInTheDocument()
    expect(screen.getByText(/Don't move the camera afterwards/)).toBeInTheDocument()
    expect(screen.getByText('Sign in to change this.')).toBeInTheDocument()

    const toggle = await screen.findByRole('switch', { name: /Depth Anything V2 on/ })
    expect(toggle).toBeChecked()
    expect(toggle).toBeDisabled()
    expect(screen.getByText(/On: estimates each food’s volume from a depth map/)).toBeInTheDocument()

    // the active calibration is shown first
    const result = await screen.findByRole('region', { name: /Calibration from/ })
    expect(within(result).getAllByText('Active').length).toBeGreaterThan(0)
    expect(within(result).getByText('credit card, 46.21 cm²')).toBeInTheDocument()
    expect(within(result).getByText('34,186 pixels')).toBeInTheDocument()
    expect(within(result).getByText('0.00135 cm² per pixel')).toBeInTheDocument()
    expect(within(result).getByText('50.0 cm')).toBeInTheDocument()
    expect(within(result).getByText('47.0 cm')).toBeInTheDocument()
    expect(within(result).getByText('6%')).toBeInTheDocument()
    expect(await within(result).findByAltText(/credit card outlined by the AI/)).toBeInTheDocument()

    expect(screen.queryByRole('form', { name: 'New calibration' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Activate' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save thickness' })).toBeNull()
    expect(screen.getByLabelText('Thickness (cm)')).toBeDisabled()

    // history: four entries, the active one marked
    const history = screen.getByText('Past calibrations').parentElement!
    expect(within(history).getAllByRole('listitem')).toHaveLength(4)
    expect(within(history).getAllByText('Active')).toHaveLength(1)
  })

  it('explains flags in plain words when an older calibration is picked', async () => {
    renderPanel('signedOut')
    const buttons = await screen.findAllByRole('button', { name: /Show the calibration from/ })
    fireEvent.click(buttons[1])
    expect(await screen.findByText(/The two height estimates disagree by more than 15%/)).toBeInTheDocument()
    fireEvent.click(buttons[2])
    expect(await screen.findByText(/index card touches the edge of the photo/)).toBeInTheDocument()
    expect(screen.getByText(/Depth Anything V2 was not available/)).toBeInTheDocument()
    expect(screen.getByText('Not measured')).toBeInTheDocument()
    fireEvent.click(buttons[3])
    expect(await screen.findByText(/This calibration didn't work: The card was not found in the photo/)).toBeInTheDocument()
    expect(screen.getByText(/credit card was not found in the photo/)).toBeInTheDocument()
  })
})

describe('CameraCalibrationPanel signed in', () => {
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

  it('rejects a non-positive area, then flips the depth toggle and saves the plate thickness', async () => {
    await login(MOCK_PASSCODE)
    renderPanel('signedIn')
    const form = await screen.findByRole('form', { name: 'New calibration' })
    fireEvent.change(within(form).getByLabelText('Known area (cm²)'), { target: { value: '0' } })
    fireEvent.change(within(form).getByLabelText('Calibration photo'), { target: { files: [photo()] } })
    fireEvent.click(within(form).getByRole('button', { name: 'Calibrate' }))
    expect(await within(form).findByRole('alert')).toHaveTextContent('more than 0')

    fireEvent.click(await screen.findByRole('switch', { name: /Depth Anything V2 on/ }))
    expect(await screen.findByRole('switch', { name: /Depth Anything V2 off/ })).not.toBeChecked()
    expect((await getMeasurementSettings()).depthEnabled).toBe(false)

    fireEvent.change(screen.getByLabelText('Thickness (cm)'), { target: { value: '2.5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save thickness' }))
    await waitFor(async () => expect((await getMeasurementSettings()).plateThicknessCm).toBe(2.5))
  })

  it('a refused change (401) opens the staff sign-in dialog', async () => {
    // The page thinks it is signed in, but the session has ended.
    renderPanel('signedIn')
    fireEvent.click(await screen.findByRole('switch', { name: /Depth Anything V2/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Staff sign-in' })
    expect(dialog).toHaveTextContent('Sign in to save this change.')
    expect(within(dialog).getByLabelText('Staff passcode')).toHaveFocus()
    // signed out now: write controls are hidden
    await waitFor(() => expect(screen.queryByRole('form', { name: 'New calibration' })).toBeNull())
  })
})

describe('calibration helpers', () => {
  it('flags the 15% height disagreement in plain words with both heights', () => {
    const cal = mockCalibration({ calibrationId: 'c', createdAt: '2026-10-04T13:00:00Z', knownAreaCm2: 46.21, referenceLabel: 'credit card', referencePixels: 34_186, rawDepthM: 0.6 })
    expect(cal.flags).toContain('depth_scale_disagrees')
    expect(heightDifference(cal)).toBeCloseTo(0.2, 2)
    expect(flagText('depth_scale_disagrees', cal)).toBe(
      'The two height estimates disagree by more than 15% (50.0 cm from the photo, 60.0 cm from Depth Anything V2). Area estimates still work; check the setup before relying on volume.',
    )
    // k = 46.21 / 34,186 and height = f x sqrt(k) with the C920s nominal f = 1360 px
    expect(cal.cm2PerPx).toBeCloseTo(0.0013517, 6)
    expect(cal.cameraHeightCmGeometric).toBeCloseTo(50.0, 1)
  })
})
