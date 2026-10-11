export interface Rect { x: number; y: number; width: number; height: number }

export interface WindowState {
  width: number
  height: number
  x?: number
  y?: number
  maximized?: boolean
}

export const DEFAULT_SIZE = { width: 1400, height: 900 }
export const MIN_SIZE = { width: 900, height: 600 }

/** At least this much of the title area must be on a screen for a saved position to be kept. */
const VISIBLE = { width: 120, height: 48 }

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function overlap(a: Rect, b: Rect): { width: number; height: number } {
  return {
    width: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
    height: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
  }
}

/**
 * Turns whatever was saved (possibly corrupt, or from another monitor layout) into bounds that are safe to open with.
 * A position that no longer lands on a screen is dropped, so the OS centres the window instead.
 */
export function restoreBounds(saved: unknown, workAreas: Rect[]): WindowState {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Partial<WindowState>
  const screen = workAreas[0]
  const maxW = screen ? screen.width : Infinity
  const maxH = screen ? screen.height : Infinity
  const width = Math.min(Math.max(num(s.width) ? s.width : DEFAULT_SIZE.width, MIN_SIZE.width), Math.max(maxW, MIN_SIZE.width))
  const height = Math.min(Math.max(num(s.height) ? s.height : DEFAULT_SIZE.height, MIN_SIZE.height), Math.max(maxH, MIN_SIZE.height))
  const out: WindowState = { width, height, maximized: s.maximized === true }
  if (num(s.x) && num(s.y)) {
    const rect = { x: s.x, y: s.y, width, height }
    const visible = workAreas.some((w) => {
      const o = overlap(rect, w)
      return o.width >= VISIBLE.width && o.height >= VISIBLE.height
    })
    if (visible) { out.x = s.x; out.y = s.y }
  }
  return out
}
