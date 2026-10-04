/**
 * Calibration photos must have the same geometry as plate captures
 * (`topdown-normalized-v1`, capture/src/normalize.ts): auto-orient, crop the
 * largest centred square, resize to exactly 1024 x 1024, JPEG quality 90.
 * Otherwise every capture would be "incompatible_geometry" for the estimates.
 * The browser resamples with its high-quality smoothing instead of Lanczos3;
 * the crop and size, which set cm² per pixel, are identical.
 */
export const NORMALIZED_SIZE_PX = 1024

export interface NormalizedPhoto {
  file: File
  widthPx: number
  heightPx: number
  sourceWidthPx: number
  sourceHeightPx: number
}

export async function normalizePhoto(photo: File): Promise<NormalizedPhoto> {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') {
    throw new Error("This browser can't prepare the photo. Try a current Chrome, Edge, Firefox or Safari.")
  }
  let bmp: ImageBitmap
  try {
    bmp = await createImageBitmap(photo, { imageOrientation: 'from-image' })
  } catch {
    throw new Error("That file couldn't be read as a photo. Use a JPEG, PNG or WebP.")
  }
  const { width, height } = bmp
  if (!(width > 0 && height > 0)) throw new Error("That photo has no size. Use another one.")
  const side = Math.min(width, height)
  const left = Math.floor((width - side) / 2)
  const top = Math.floor((height - side) / 2)
  const canvas = document.createElement('canvas')
  canvas.width = NORMALIZED_SIZE_PX
  canvas.height = NORMALIZED_SIZE_PX
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error("This browser can't prepare the photo.")
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bmp, left, top, side, side, 0, 0, NORMALIZED_SIZE_PX, NORMALIZED_SIZE_PX)
  bmp.close?.()
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9))
  if (!blob) throw new Error("This browser can't prepare the photo.")
  const name = photo.name.replace(/\.[^.]+$/, '') + '-1024.jpg'
  return {
    file: new File([blob], name, { type: 'image/jpeg' }),
    widthPx: NORMALIZED_SIZE_PX,
    heightPx: NORMALIZED_SIZE_PX,
    sourceWidthPx: width,
    sourceHeightPx: height,
  }
}
