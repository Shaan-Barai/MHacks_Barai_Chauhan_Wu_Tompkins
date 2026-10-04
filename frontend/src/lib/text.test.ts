import { describe, expect, it } from 'vitest'
import { plainText } from './text'

describe('plainText', () => {
  it('replaces dashes with commas and drops emoji', () => {
    expect(plainText('Rice was left \u2014 try a smaller scoop 🍚.')).toBe('Rice was left, try a smaller scoop.')
    expect(plainText('Lunch\u2013dinner')).toBe('Lunch, dinner')
  })
})
