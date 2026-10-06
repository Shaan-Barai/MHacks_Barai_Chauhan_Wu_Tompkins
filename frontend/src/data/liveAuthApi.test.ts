/** Live API: staff sign-in, 401 handling, calibration upload flow, settings (IT_4 §3 HTTP API). */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createCalibration,
  getCalibrationImages,
  getCalibrations,
  getMeasurementSettings,
  getSession,
  login,
  saveMeasurementSettings,
  savePortions,
} from './liveApi'
import { AUTH_REQUIRED_EVENT, AuthRequiredError } from './authEvents'

// jsdom has no canvas: stand in for the 1024 x 1024 centre-square normalization.
vi.mock('../lib/normalizePhoto', () => ({
  normalizePhoto: vi.fn(async () => ({
    file: new File([new Uint8Array([9, 9, 9, 9])], 'card-1024.jpg', { type: 'image/jpeg' }),
    widthPx: 1024,
    heightPx: 1024,
    sourceWidthPx: 1920,
    sourceHeightPx: 1080,
  })),
}))

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sign-in', () => {
  it('reads the session from /api/auth/me (200 signed in, 401 signed out, 404 = no sign-in on this backend)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { authenticated: true, expiresAt: '2026-10-04T23:00:00Z' })))
    expect(await getSession()).toEqual({ signedIn: true, authAvailable: true, expiresAt: '2026-10-04T23:00:00Z' })
    // the backend's own shape: { admin, authRequired }
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { admin: false, authRequired: true })))
    expect(await getSession()).toEqual({ signedIn: false, authAvailable: true })
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { admin: true, authRequired: false })))
    expect(await getSession()).toEqual({ signedIn: true, authAvailable: false })
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { authenticated: false })))
    expect(await getSession()).toEqual({ signedIn: false, authAvailable: true })
    vi.stubGlobal('fetch', vi.fn(async () => json(401, { error: { code: 'UNAUTHENTICATED', message: 'x' } })))
    expect(await getSession()).toEqual({ signedIn: false, authAvailable: true })
    vi.stubGlobal('fetch', vi.fn(async () => json(404, { error: { code: 'ROUTE_NOT_FOUND', message: 'x' } })))
    expect(await getSession()).toEqual({ signedIn: true, authAvailable: false })
  })

  it('reads readOnly from /api/auth/me (absent = false) and from a READ_ONLY refusal', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { admin: false, authRequired: true, readOnly: true })))
    expect(await getSession()).toEqual({ signedIn: false, authAvailable: true, readOnly: true })
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { admin: false, authRequired: true, readOnly: false })))
    expect((await getSession()).readOnly).toBeFalsy()
    vi.stubGlobal('fetch', vi.fn(async () => json(403, { error: { code: 'READ_ONLY', message: 'This site is read-only.', retryable: false } })))
    expect(await getSession()).toEqual({ signedIn: false, authAvailable: true, readOnly: true })
  })

  it('a READ_ONLY refusal surfaces its message and never asks for the passcode', async () => {
    const heard = vi.fn()
    window.addEventListener(AUTH_REQUIRED_EVENT, heard)
    vi.stubGlobal('fetch', vi.fn(async () => json(403, { error: { code: 'READ_ONLY', message: 'This site is read-only.', retryable: false } })))
    await expect(
      savePortions({ serviceId: 'svc', menuVersion: 1, items: [], portions: [] }, [{ itemId: 'rice', count: 1 }]),
    ).rejects.toThrow('This site is read-only.')
    window.removeEventListener(AUTH_REQUIRED_EVENT, heard)
    expect(heard).not.toHaveBeenCalled()
  })

  it('posts the passcode and explains a wrong one or too many tries, without firing the sign-in event', async () => {
    const fetchMock = vi.fn(async () => json(200, { authenticated: true }))
    vi.stubGlobal('fetch', fetchMock)
    await login('secret')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/auth/login')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ passcode: 'secret' })

    const heard = vi.fn()
    window.addEventListener(AUTH_REQUIRED_EVENT, heard)
    vi.stubGlobal('fetch', vi.fn(async () => json(401, { error: { code: 'BAD_PASSCODE', message: 'x' } })))
    await expect(login('nope')).rejects.toThrow("That passcode didn't work.")
    vi.stubGlobal('fetch', vi.fn(async () => json(429, { error: { code: 'RATE_LIMITED', message: 'x' } })))
    await expect(login('nope')).rejects.toThrow('Too many tries')
    expect(heard).not.toHaveBeenCalled()
    window.removeEventListener(AUTH_REQUIRED_EVENT, heard)
  })

  it('a 401 on any change fires the sign-in event and throws "Sign in to change this."', async () => {
    const heard = vi.fn()
    window.addEventListener(AUTH_REQUIRED_EVENT, heard)
    vi.stubGlobal('fetch', vi.fn(async () => json(401, { error: { code: 'UNAUTHENTICATED', message: 'Sign in' } })))
    const err = await savePortions({ serviceId: 's', menuVersion: 1, items: [], portions: [] }, []).catch((e) => e)
    expect(err).toBeInstanceOf(AuthRequiredError)
    expect(err.message).toBe('Sign in to change this.')
    expect(heard).toHaveBeenCalledOnce()
    // reads stay public: a 401 on a GET is just an error, no dialog
    await expect(getCalibrations()).rejects.toThrow()
    expect(heard).toHaveBeenCalledOnce()
    window.removeEventListener(AUTH_REQUIRED_EVENT, heard)
  })
})

describe('calibration + settings', () => {
  it('normalizes the photo to 1024 x 1024, uploads it under a new calibration id (request -> PUT -> finalize), then posts the calibration', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init })
        if (url === '/api/images/uploads') {
          return json(201, { objectId: 'img_1', uploadUrl: 'https://r2.test/put?sig=x', uploadHeaders: { 'Content-Type': 'image/jpeg' }, expiresAt: 'x' })
        }
        if (url.startsWith('https://r2.test/')) return new Response(null, { status: 200 })
        if (url === '/api/images/img_1/finalize') return json(200, { imageObject: { objectId: 'img_1' } })
        if (url === '/api/calibrations') return json(201, { calibration: { calibrationId: 'cal_1', status: 'succeeded' } })
        return json(404, {})
      }),
    )
    const photo = new File([new Uint8Array([1, 2, 3])], 'card.jpg', { type: 'image/jpeg' })
    const cal = await createCalibration({ cameraId: 'uno-q-c920s-1', knownAreaCm2: 46.21, referenceLabel: 'credit card', photo })
    expect(cal.calibrationId).toBe('cal_1')
    expect(calls.map((c) => c.url)).toEqual(['/api/images/uploads', 'https://r2.test/put?sig=x', '/api/images/img_1/finalize', '/api/calibrations'])
    const upload = JSON.parse(calls[0].init!.body as string)
    expect(upload).toMatchObject({ associationKind: 'calibration', mimeType: 'image/jpeg', sizeBytes: 4, widthPx: 1024, heightPx: 1024 })
    expect(upload.associationId).toMatch(/^cal_[a-z0-9]+$/)
    expect(calls[1].init).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'image/jpeg' } })
    expect((calls[1].init!.body as File).name).toBe('card-1024.jpg')
    expect(JSON.parse(calls[3].init!.body as string)).toEqual({
      hallId: 'hall-main',
      cameraId: 'uno-q-c920s-1',
      imageObjectId: 'img_1',
      knownAreaCm2: 46.21,
      referenceLabel: 'credit card',
    })
  })

  it('stops with a plain message when the photo upload fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === '/api/images/uploads' ? json(201, { objectId: 'img_1', uploadUrl: 'https://r2.test/put' }) : new Response(null, { status: 403 }),
      ),
    )
    const photo = new File([new Uint8Array([1])], 'card.jpg', { type: 'image/jpeg' })
    await expect(createCalibration({ cameraId: 'c', knownAreaCm2: 46.21, referenceLabel: 'card', photo })).rejects.toThrow("The photo didn't upload")
  })

  it('reads lists and settings bare or wrapped, and PUTs the full setting', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { calibrations: [{ calibrationId: 'a' }] })))
    expect(await getCalibrations()).toEqual([{ calibrationId: 'a' }])
    vi.stubGlobal('fetch', vi.fn(async () => json(200, [{ calibrationId: 'b' }])))
    expect(await getCalibrations()).toEqual([{ calibrationId: 'b' }])
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { settings: { hallId: 'hall-main', activeCalibrationId: 'a' } })))
    expect(await getMeasurementSettings()).toMatchObject({ activeCalibrationId: 'a' })

    const fetchMock = vi.fn(async () => json(200, { hallId: 'hall-main', activeCalibrationId: 'a', updatedAt: 'x' }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await saveMeasurementSettings({ activeCalibrationId: 'a' })).toMatchObject({ activeCalibrationId: 'a' })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/settings/measurement')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body as string)).toEqual({ hallId: 'hall-main', activeCalibrationId: 'a' })
  })

  it('maps calibration image links from either naming', async () => {
    const img = { objectId: 'o', url: 'https://img.test/o.jpg', expiresAt: 'x' }
    // An older backend may still send a legacy preview link; it is ignored.
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { original: img, overlay: img, depth: null })))
    expect(await getCalibrationImages('cal_1')).toEqual({ calibrationId: 'cal_1', photo: img, outline: img })
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { photo: img, outline: null })))
    expect(await getCalibrationImages('cal_1')).toEqual({ calibrationId: 'cal_1', photo: img, outline: null })
  })
})
