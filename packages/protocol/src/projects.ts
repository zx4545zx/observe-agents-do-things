/**
 * Projects: sessions grouped by working directory, for every harness alike.
 * Pure helpers over a WorldState, so a frontend can filter without touching transcripts.
 */
import type { SessionState, WorldState } from './state.js'

/** The group for sessions whose harness did not report a working directory. */
export const UNKNOWN_PROJECT = '?'

export interface ProjectInfo {
  /** The normalised working directory, or `UNKNOWN_PROJECT`. */
  key: string
  /** Last path segment. */
  name: string
  /** `name`, extended with parent folders when two projects share it. */
  label: string
  sessions: number
  live: number
  lastActivityAt: number
  harnesses: string[]
}

const slashed = (cwd: string) => cwd.trim().replace(/\\/g, '/').replace(/\/+$/, '') || '/'

/** `/a/b/` and `/a/b` are one project; so are `C:\a` and `c:/a`. */
export function projectKey(s: SessionState): string {
  if (!s.meta.cwd?.trim()) return UNKNOWN_PROJECT
  const path = slashed(s.meta.cwd)
  return /^[a-zA-Z]:/.test(path) ? path.toLowerCase() : path
}

const segments = (key: string) => key.split('/').filter(Boolean)

/** Projects present in the world, alphabetical with the unknown group last, so the list does not shuffle as agents work. */
export function listProjects(world: WorldState): ProjectInfo[] {
  const byKey = new Map<string, ProjectInfo>()
  /** The path as the harness wrote it, for display. */
  const shown = new Map<string, string[]>()
  for (const s of Object.values(world.sessions)) {
    const key = projectKey(s)
    let p = byKey.get(key)
    if (!p) {
      const parts = key === UNKNOWN_PROJECT ? [] : segments(slashed(s.meta.cwd!))
      const name = key === UNKNOWN_PROJECT ? 'Unknown Project' : (parts.at(-1) ?? key)
      shown.set(key, parts)
      byKey.set(key, (p = { key, name, label: name, sessions: 0, live: 0, lastActivityAt: 0, harnesses: [] }))
    }
    p.sessions++
    if (s.status === 'working' || s.status === 'waiting') p.live++
    p.lastActivityAt = Math.max(p.lastActivityAt, s.lastActivityAt)
    if (!p.harnesses.includes(s.harness)) p.harnesses.push(s.harness)
  }
  const list = [...byKey.values()]
  for (const p of list) {
    if (p.key === UNKNOWN_PROJECT) continue
    const same = list.filter((o) => o.name === p.name)
    if (same.length === 1) continue
    const two = (o: ProjectInfo) => shown.get(o.key)!.slice(-2).join('/')
    p.label = same.filter((o) => two(o) === two(p)).length > 1 ? slashed(p.key) : two(p)
  }
  return list.sort((a, b) => Number(a.key === UNKNOWN_PROJECT) - Number(b.key === UNKNOWN_PROJECT) || a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }))
}

/**
 * The project to show for a remembered choice. A choice that no session belongs to
 * (it aged out, or its sessions were never loaded) falls back to everything,
 * without forgetting it: it applies again if the project returns.
 */
export function resolveProject(world: WorldState, selected: string): string {
  if (!selected) return ''
  return Object.values(world.sessions).some((s) => projectKey(s) === selected) ? selected : ''
}

/** The world with only one project's sessions. An empty key returns the world itself. */
export function filterWorld(world: WorldState, key: string): WorldState {
  if (!key) return world
  const sessions: Record<string, SessionState> = {}
  for (const [id, s] of Object.entries(world.sessions)) if (projectKey(s) === key) sessions[id] = s
  return { ...world, sessions }
}
