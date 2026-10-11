/** Desktop-only preferences: what to watch, how far back, which alerts. Never part of the event protocol. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import type { BuiltinHarness, ObserverOptions } from '@oadt/core'
import type { DesktopSettings, HarnessId } from '../../web/src/host/desktop-types.ts'

export type { DesktopSettings, HarnessId }
export const HARNESS_IDS: readonly HarnessId[] = ['pi', 'claude-code', 'codex']
export const BACKFILL_PRESETS = [6, 24, 72, 168] as const
export const MAX_BACKFILL_HOURS = 24 * 90

export const DEFAULT_SETTINGS: DesktopSettings = {
  backfillHours: 6,
  harnesses: {
    pi: { enabled: true, path: '' },
    'claude-code': { enabled: true, path: '' },
    codex: { enabled: true, path: '' },
  },
  notifications: { enabled: true, attention: true, runCompleted: true },
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Expands `~`, requires an absolute path, rejects control characters. Empty stays empty (use the default). */
export function normalizePath(raw: string): string {
  const p = raw.trim()
  if (!p) return ''
  if (p.length > 1024 || /[\u0000-\u001f]/.test(p)) throw new Error('The path contains characters that are not allowed.')
  const full = p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
  if (!isAbsolute(full)) throw new Error('Use an absolute path, for example /Users/you/.pi/agent.')
  return full.length > 1 ? full.replace(/\/+$/, '') : full
}

/**
 * Applies a partial update from an untrusted source onto `base`. Unknown keys are ignored.
 * Returns the new settings, or every problem found and `base` unchanged.
 */
export function applyPatch(base: DesktopSettings, patch: unknown): { settings: DesktopSettings; errors: string[] } {
  const errors: string[] = []
  const next: DesktopSettings = structuredClone(base)
  if (!isObj(patch)) return { settings: base, errors: ['Settings must be an object.'] }

  if ('backfillHours' in patch) {
    const v = patch.backfillHours
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) errors.push('History range must be a positive number of hours.')
    else if (v > MAX_BACKFILL_HOURS) errors.push(`History range can be at most ${MAX_BACKFILL_HOURS / 24} days.`)
    else next.backfillHours = Math.max(1 / 60, Math.round(v * 100) / 100)
  }
  if (isObj(patch.harnesses)) {
    for (const [id, v] of Object.entries(patch.harnesses)) {
      if (!HARNESS_IDS.includes(id as HarnessId)) { errors.push(`Unknown harness: ${id.slice(0, 40)}`); continue }
      if (!isObj(v)) continue
      const cur = next.harnesses[id as HarnessId]
      if ('enabled' in v) {
        if (typeof v.enabled === 'boolean') cur.enabled = v.enabled
        else errors.push(`${id}: enabled must be true or false.`)
      }
      if ('path' in v) {
        if (typeof v.path !== 'string') errors.push(`${id}: path must be text.`)
        else try { cur.path = normalizePath(v.path) } catch (e) { errors.push(`${id}: ${(e as Error).message}`) }
      }
    }
  }
  if (isObj(patch.notifications)) {
    for (const k of ['enabled', 'attention', 'runCompleted'] as const) {
      const v = patch.notifications[k]
      if (v === undefined) continue
      if (typeof v === 'boolean') next.notifications[k] = v
      else errors.push(`notifications.${k} must be true or false.`)
    }
  }
  return errors.length ? { settings: base, errors } : { settings: next, errors }
}

/** Observer configuration for these settings. An empty path leaves the adapter's own default (env or home). */
export function toObserverOptions(s: DesktopSettings): Pick<ObserverOptions, 'harnesses' | 'sinceMs' | 'piDir' | 'claudeDir' | 'codexHome'> {
  const path = (id: HarnessId) => s.harnesses[id].path || undefined
  return {
    harnesses: HARNESS_IDS.filter((id) => s.harnesses[id].enabled) as BuiltinHarness[],
    sinceMs: Math.round(s.backfillHours * 3_600_000),
    piDir: path('pi'),
    claudeDir: path('claude-code'),
    codexHome: path('codex'),
  }
}

/** Settings from disk. A missing or damaged file gives the defaults, and says so. */
export function loadSettings(file: string): { settings: DesktopSettings; warning?: string } {
  let raw: string
  try { raw = readFileSync(file, 'utf8') } catch { return { settings: DEFAULT_SETTINGS } }
  try {
    const { settings, errors } = applyPatch(DEFAULT_SETTINGS, JSON.parse(raw))
    return errors.length ? { settings: DEFAULT_SETTINGS, warning: `Saved settings were invalid and were reset: ${errors[0]}` } : { settings }
  } catch {
    return { settings: DEFAULT_SETTINGS, warning: 'Saved settings could not be read and were reset.' }
  }
}

export function saveSettings(file: string, s: DesktopSettings): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(s, null, 2))
  renameSync(tmp, file)
}
