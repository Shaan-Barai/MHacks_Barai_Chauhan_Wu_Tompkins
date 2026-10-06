import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import { setApiLatency, setMockReadOnly } from './data/mockApi'

beforeEach(() => {
  localStorage.clear()
  setApiLatency(0)
  setMockReadOnly(false)
})

afterEach(() => {
  cleanup()
})
