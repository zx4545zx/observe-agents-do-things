import assert from 'node:assert/strict'
import { test } from 'node:test'
import { restoreBounds } from './window-state.ts'

const screen = { x: 0, y: 0, width: 1920, height: 1080 }
const second = { x: 1920, y: 0, width: 1280, height: 1024 }

test('first launch gets the default size and no position', () => {
  assert.deepEqual(restoreBounds(undefined, [screen]), { width: 1400, height: 900, maximized: false })
})

test('a saved position on a connected screen is kept', () => {
  assert.deepEqual(restoreBounds({ x: 2000, y: 40, width: 1000, height: 700, maximized: true }, [screen, second]), { x: 2000, y: 40, width: 1000, height: 700, maximized: true })
})

test('a position on a monitor that is gone is dropped', () => {
  assert.deepEqual(restoreBounds({ x: 2000, y: 40, width: 1000, height: 700 }, [screen]), { width: 1000, height: 700, maximized: false })
})

test('a window dragged almost fully off screen is dropped', () => {
  assert.equal(restoreBounds({ x: 1900, y: 40, width: 1000, height: 700 }, [screen]).x, undefined)
})

test('size is clamped to the minimum and the screen, and garbage falls back', () => {
  assert.deepEqual(restoreBounds({ x: 0, y: 0, width: 100, height: 99999 }, [screen]), { x: 0, y: 0, width: 900, height: 1080, maximized: false })
  assert.deepEqual(restoreBounds({ width: 'x', x: NaN, y: 1 }, [screen]), { width: 1400, height: 900, maximized: false })
  assert.deepEqual(restoreBounds('nope', []), { width: 1400, height: 900, maximized: false })
})
