/**
 * The single owner of the observer and its server in the desktop app.
 * Start, restart and rescan all go through here, one at a time, so two calls can never
 * leave two observers behind. Restart prefers the port in use so the page keeps its origin (and localStorage).
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { ClaudeCodeAdapter, CodexAdapter, PiAdapter } from '@oadt/core'
import type { ObserverHandle, StartObserverOptions } from '@oadt/server'
import type { DesktopState, HarnessStatus } from '../../web/src/host/desktop-types.ts'
import { HARNESS_IDS, toObserverOptions, type DesktopSettings, type HarnessId } from './settings.ts'

export type StartFn = (opts: StartObserverOptions) => Promise<ObserverHandle>
type ObserverState = DesktopState['observer']['state']

const LABEL: Record<HarnessId, string> = { pi: 'Pi Agent', 'claude-code': 'Claude Code', codex: 'Codex' }
const MAX_ERRORS = 50

/** The first line of an error with the home folder hidden, safe for a dialog. */
export function plainError(err: unknown, home = ''): string {
  const msg = err instanceof Error ? err.message : String(err)
  const line = msg.split('\n')[0]!
  const code = (err as NodeJS.ErrnoException)?.code
  const text = code === 'EADDRINUSE' ? 'The local port is in use.' : line
  return (home ? text.split(home).join('~') : text).slice(0, 300)
}

export class ObserverManager {
  private handle?: ObserverHandle
  private _settings: DesktopSettings
  private state: ObserverState = 'stopped'
  private error?: string
  private chain: Promise<unknown> = Promise.resolve()
  private errors: string[] = []
  private listeners = new Set<() => void>()
  private attachers = new Set<(h: ObserverHandle | undefined) => void>()

  private deps: { start: StartFn; uiDir: string; port?: number; log?: (m: string) => void; home?: string }

  constructor(deps: ObserverManager['deps'], initial: DesktopSettings) {
    this.deps = deps
    this._settings = initial
  }

  get settings(): DesktopSettings { return this._settings }
  get url(): string | undefined { return this.handle?.url }
  get port(): number | undefined { return this.handle?.port }
  get observer() { return this.handle?.observer }

  onChange(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn) }
  /** Called with the new handle after every successful start, and with undefined when it goes away. */
  onHandle(fn: (h: ObserverHandle | undefined) => void): () => void { this.attachers.add(fn); return () => this.attachers.delete(fn) }

  private emit(): void { for (const f of this.listeners) f() }
  private set(state: ObserverState, error?: string): void { this.state = state; this.error = error; this.emit() }
  private serial<T>(job: () => Promise<T>): Promise<T> {
    const run = this.chain.then(job, job)
    this.chain = run.catch(() => undefined)
    return run
  }

  start(settings: DesktopSettings = this._settings): Promise<void> {
    return this.serial(async () => {
      this.set('starting')
      await this.bring(settings, this.deps.port)
    })
  }

  /** Take settings that do not need a new observer (alert preferences). */
  adopt(settings: DesktopSettings): void {
    this._settings = settings
    this.emit()
  }

  /** Apply settings by replacing the observer. If the new ones fail, the previous ones are put back. */
  restart(settings: DesktopSettings = this._settings): Promise<void> {
    return this.serial(async () => {
      const previous = this._settings
      const port = this.handle?.port ?? this.deps.port
      this.set('restarting')
      await this.drop()
      try {
        await this.bring(settings, port)
      } catch (err) {
        const message = plainError(err, this.deps.home)
        this.deps.log?.(`restart failed: ${message}`)
        if (settings !== previous) {
          try { await this.bring(previous, port) } catch (again) { this.set('error', plainError(again, this.deps.home)); throw err }
          this.set('running', message)
        } else this.set('error', message)
        throw err
      }
    })
  }

  /** Re-runs discovery and backfill with the current settings. There is no incremental rescan, so this replaces the observer. */
  rescan(): Promise<void> {
    return this.restart(this._settings)
  }

  close(): Promise<void> {
    return this.serial(async () => {
      await this.drop()
      this.set('stopped')
    })
  }

  private async drop(): Promise<void> {
    const h = this.handle
    this.handle = undefined
    for (const f of this.attachers) f(undefined)
    await h?.close()
  }

  private async bring(settings: DesktopSettings, port: number | undefined): Promise<void> {
    this.errors = []
    const options: StartObserverOptions = {
      observer: { ...toObserverOptions(settings), onError: (err, path) => { if (this.errors.length < MAX_ERRORS) this.errors.push(`${path ?? ''}\n${String(err)}`) } },
      host: '127.0.0.1',
      uiDir: this.deps.uiDir,
    }
    let handle: ObserverHandle
    try {
      if (port === undefined) throw Object.assign(new Error('no preferred port'), { code: 'EADDRINUSE' })
      handle = await this.deps.start({ ...options, port })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') { this.set('error', plainError(err, this.deps.home)); throw err }
      if (port !== undefined) this.deps.log?.(`port ${port} is busy, taking a free one`)
      try { handle = await this.deps.start({ ...options, port: 0 }) } catch (e) { this.set('error', plainError(e, this.deps.home)); throw e }
    }
    this.handle = handle
    this._settings = settings
    this.set('running')
    for (const f of this.attachers) f(handle)
  }

  /** Where each harness looks (configured or default), from the adapters themselves, so there is one source of truth. */
  private roots(id: HarnessId, s: DesktopSettings): string[] {
    const p = s.harnesses[id].path || undefined
    return id === 'pi' ? new PiAdapter({ piDir: p }).roots() : id === 'claude-code' ? new ClaudeCodeAdapter({ claudeDir: p }).roots() : new CodexAdapter({ codexHome: p }).roots()
  }

  /** Derived on demand from the running observer and the folders, never polled. */
  status(): DesktopState['observer'] & { harnesses: HarnessStatus[] } {
    const world = this.handle?.observer.world
    const counts: Record<string, number> = {}
    for (const s of Object.values(world?.sessions ?? {})) counts[s.harness] = (counts[s.harness] ?? 0) + 1
    const harnesses = HARNESS_IDS.map((id): HarnessStatus => {
      const roots = this.roots(id, this._settings)
      const enabled = this._settings.harnesses[id].enabled
      const readErrors = this.errors.filter((e) => roots.some((r) => e.startsWith(r))).length
      const sessions = counts[id] ?? 0
      const state: HarnessStatus['state'] = !enabled ? 'disabled' : !roots.some((r) => existsSync(r)) ? 'missing' : readErrors > 0 && sessions === 0 ? 'error' : 'watching'
      return { id, label: LABEL[id], state, path: roots.map((r) => (r.startsWith(homedir() + '/') ? `~${r.slice(homedir().length)}` : r)).join(', '), sessions: enabled ? sessions : 0, readErrors }
    })
    return { state: this.state, error: this.error, harnesses }
  }
}
