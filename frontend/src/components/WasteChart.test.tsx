import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { WasteChart } from './WasteChart'

vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
const bucket = (key: string, value: number | null) => ({ key, label: key, tooltipLabel: `Day ${key}`, value })

describe('WasteChart', () => {
  it('draws a line with a dot per day, breaks at days with no data, and shows the waste score on hover', () => {
    const { container } = render(
      <WasteChart unit="score" buckets={[bucket('1', 120), bucket('2', 300), bucket('3', null), bucket('4', 450), bucket('5', 210)]} />,
    )
    expect(screen.getByRole('img', { name: /^Line chart of waste score/ })).toBeInTheDocument()
    expect(container.querySelectorAll('polyline')).toHaveLength(2)
    expect(container.querySelectorAll('circle')).toHaveLength(4)
    expect(container.querySelectorAll('path')).toHaveLength(0)
    fireEvent.mouseEnter(screen.getByRole('img', { name: 'Day 2: Waste score 300' }))
    expect(screen.getByRole('status')).toHaveTextContent('Waste score 300')
  })
})
