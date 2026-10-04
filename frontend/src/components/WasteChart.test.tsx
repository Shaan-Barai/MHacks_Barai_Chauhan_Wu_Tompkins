import { render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { WasteChart } from './WasteChart'

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
})

const bucket = (key: string, value: number | null) => ({ key, label: key, tooltipLabel: key, value })

describe('WasteChart', () => {
  it('is a line graph in waste units: one dot per day with data, a gap (not zero) for missing days', () => {
    const { container } = render(<WasteChart buckets={[bucket('a', 12_500), bucket('b', null), bucket('c', 3_000), bucket('d', 4_000)]} />)
    expect(screen.getByRole('img', { name: /Line graph of waste units per day/ })).toBeInTheDocument()
    expect(container.querySelectorAll('circle')).toHaveLength(3)
    const d = container.querySelector('path')!.getAttribute('d')!
    expect(d.match(/M/g)).toHaveLength(2) // the missing day lifts the pen
    expect(screen.getByRole('img', { name: 'a: 12.5 waste units' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'b: no data' })).toBeInTheDocument()
  })
})
