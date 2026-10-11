/**
 * Decides which changes in the world deserve a desktop notification.
 * A tracker only reports transitions it watched happen: whatever was already true when it
 * started (backfill, a restart, a rescan) is its baseline, so history never notifies.
 */
import { attentionItems, projectKey, workflowRuns, type SessionState, type WorldState } from '@oadt/protocol'
import type { DesktopSettings } from './settings.ts'

export interface Notice {
  kind: 'attention' | 'run'
  /** Stable per occurrence. */
  id: string
  sessionId: string
  title: string
  subtitle: string
  body: string
}

const HARNESS_NAME: Record<string, string> = { pi: 'Pi', 'claude-code': 'Claude Code', codex: 'Codex' }
const MAX_SEEN = 2000

function projectName(s: SessionState): string {
  const key = projectKey(s)
  return key === '?' ? s.meta.title ?? 'Unknown project' : key.split('/').filter(Boolean).pop() ?? key
}

export class NoticeTracker {
  private primed = false
  private attention = new Set<string>()
  private runs = new Map<string, string>()

  /** The first call only records the baseline. Later calls return what changed since. */
  observe(world: WorldState, now: number): Notice[] {
    const out: Notice[] = []
    const prime = !this.primed
    this.primed = true

    // Only conditions a person has to act on. Finished turns and long tools are not interruptions.
    for (const item of attentionItems(world, now)) {
      if (item.kind !== 'waiting' && item.kind !== 'errors') continue
      if (this.attention.has(item.id)) continue
      this.attention.add(item.id)
      const s = world.sessions[item.sessionId]
      if (prime || !s) continue
      out.push({
        kind: 'attention', id: item.id, sessionId: s.id,
        title: 'Observe Agents',
        subtitle: `${projectName(s)} needs your attention`,
        body: `${HARNESS_NAME[s.harness] ?? s.harness} · ${item.title}`,
      })
    }
    if (this.attention.size > MAX_SEEN) this.attention = new Set([...this.attention].slice(-MAX_SEEN / 2))

    const live = new Set<string>()
    for (const s of Object.values(world.sessions)) {
      for (const run of workflowRuns(s)) {
        const key = `${s.id}:${run.id}`
        live.add(key)
        const before = this.runs.get(key)
        this.runs.set(key, run.status)
        if (!prime && before !== undefined && before !== 'done' && run.status === 'done') {
          out.push({
            kind: 'run', id: `run:${key}`, sessionId: s.id,
            title: 'Observe Agents',
            subtitle: `${run.label} Run ${run.index} completed`,
            body: `${projectName(s)} · ${run.agentIds.length} ${run.agentIds.length === 1 ? 'agent' : 'agents'}`,
          })
        }
      }
    }
    for (const k of this.runs.keys()) if (!live.has(k)) this.runs.delete(k)
    return out
  }
}

export function wanted(n: Notice, prefs: DesktopSettings['notifications']): boolean {
  return prefs.enabled && (n.kind === 'attention' ? prefs.attention : prefs.runCompleted)
}

/** Runs a fresh tracker against each observer it is attached to and hands wanted notices to `show`. */
export class NoticeService {
  private timer?: NodeJS.Timeout
  private deps: { prefs: () => DesktopSettings['notifications']; show: (n: Notice) => void; intervalMs?: number; now?: () => number }

  constructor(deps: NoticeService['deps']) {
    this.deps = deps
  }

  attach(observer: { world: WorldState } | undefined): void {
    this.detach()
    if (!observer) return
    const tracker = new NoticeTracker()
    const now = this.deps.now ?? Date.now
    const check = () => { for (const n of tracker.observe(observer.world, now())) if (wanted(n, this.deps.prefs())) this.deps.show(n) }
    check()
    this.timer = setInterval(check, this.deps.intervalMs ?? 1500)
    this.timer.unref?.()
  }

  detach(): void {
    clearInterval(this.timer)
    this.timer = undefined
  }
}
