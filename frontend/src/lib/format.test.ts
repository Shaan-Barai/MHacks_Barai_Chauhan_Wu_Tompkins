import { describe, expect, it } from 'vitest'
import { formatGrams, formatKgCo2e, formatLitres, formatUsd, formatWater } from './format'

describe('impact formatting', () => {
  it('grams switch to kg at 1,000 g', () => {
    expect(formatGrams(0)).toBe('0 g')
    expect(formatGrams(4.25)).toBe('4.3 g')
    expect(formatGrams(850)).toBe('850 g')
    expect(formatGrams(12_400)).toBe('12.4 kg')
    expect(formatGrams(1_240_000)).toBe('1,240 kg')
  })

  it('CO2e, water and dollars carry their units', () => {
    expect(formatKgCo2e(0.42)).toBe('0.42 kg CO₂e')
    expect(formatKgCo2e(8.62)).toBe('8.6 kg CO₂e')
    expect(formatKgCo2e(1620.4)).toBe('1,620 kg CO₂e')
    expect(formatWater(0.85)).toBe('850 L')
    expect(formatWater(24.53)).toBe('24.5 m³')
    expect(formatLitres(24.5)).toBe('24,500 litres')
    expect(formatUsd(342.4)).toBe('$342')
    expect(formatUsd(12.4)).toBe('$12.40')
    expect(formatUsd(0.055)).toBe('$0.06')
  })
})
