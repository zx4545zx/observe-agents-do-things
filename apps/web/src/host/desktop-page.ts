/**
 * The Desktop page of Settings. It exists only inside the desktop app, where `window.oadtDesktop`
 * is present. It holds no state of its own beyond the last answer from the app.
 */
import { h } from '../shared/dom'
import type { DesktopBridge, DesktopResult, DesktopState, HarnessId, HarnessStatus } from './desktop-types'

export const desktopBridge = (): DesktopBridge | undefined => (window as unknown as { oadtDesktop?: DesktopBridge }).oadtDesktop

const PRESETS: Array<[string, number]> = [['6 hours', 6], ['24 hours', 24], ['3 days', 72], ['7 days', 168]]
const STATE_TEXT: Record<DesktopState['observer']['state'], string> = { running: 'Running', starting: 'Starting…', restarting: 'Restarting observer…', error: 'Not running', stopped: 'Stopped' }
const HARNESS_TEXT: Record<HarnessStatus['state'], string> = { watching: 'Watching', missing: 'Folder not found', disabled: 'Disabled', error: 'Read errors' }

export class DesktopPage {
  private state?: DesktopState
  private busy?: string
  private error?: string
  private custom = false
  private customDays = ''

  constructor(private bridge: DesktopBridge, private rerender: () => void) {
    bridge.onState((s) => { this.state = s; this.rerender() })
    void bridge.getState().then((s) => { this.state = s; this.rerender() })
  }

  /** Fresh answer when the page is opened. */
  refresh(): void {
    void this.bridge.getState().then((s) => { this.state = s; this.rerender() })
  }

  content(): Array<Node | string> {
    const s = this.state
    if (!s) return [h('h2', null, 'Desktop'), h('p.oadt-settings-desc', null, 'Loading…')]
    return [
      h('h2', null, 'Desktop'),
      this.error ? h('div.oadt-settings-warn', { role: 'alert' }, this.error) : '',
      h('h3', null, 'Observer'),
      this.observerRow(s),
      h('h3', null, 'Monitoring'),
      this.backfillRow(s),
      h('h3', null, 'Harnesses'),
      ...s.harnesses.map((x) => this.harnessRow(s, x)),
      h('h3', null, 'Notifications'),
      !s.notificationsSupported ? h('div.oadt-settings-warn', null, 'Desktop notifications are not available on this system.') : '',
      this.toggle('Notifications', 'Show a system notification for the events below.', s.settings.notifications.enabled, (v) => this.save({ notifications: { enabled: v } })),
      this.toggle('Needs attention', 'An agent is waiting on you, or tool calls keep failing.', s.settings.notifications.attention, (v) => this.save({ notifications: { attention: v } }), !s.settings.notifications.enabled),
      this.toggle('PStack run completed', 'A run you watched finish. Runs that were already done are never announced.', s.settings.notifications.runCompleted, (v) => this.save({ notifications: { runCompleted: v } }), !s.settings.notifications.enabled),
      h('h3', null, 'Startup'),
      this.toggle('Launch at login', s.login.supported ? 'Open Observe Agents when you log in to macOS.' : 'Available in the installed app.', s.login.enabled, (v) => this.run('login', () => this.bridge.setLaunchAtLogin(v)), !s.login.supported),
    ]
  }

  // ─── rows ────────────────────────────────────────────────────────────

  private observerRow(s: DesktopState): HTMLElement {
    const text = this.busy ? this.busy : STATE_TEXT[s.observer.state]
    const off = this.locked() || s.observer.state === 'restarting'
    return h('div.oadt-setting', null,
      h('div', null,
        h('div.oadt-setting-label', null, 'Status: ', h('b', null, text)),
        s.observer.error ? h('div.oadt-settings-warn', null, s.observer.error) : '',
        h('div.oadt-settings-desc', null, 'Restart replaces the observer. Rescan loads history again with the current settings. Both keep your selections.'),
      ),
      h('div.oadt-viz-actions', null,
        h('button.oadt-btn', { disabled: off, onclick: () => void this.run('Restarting observer…', () => this.bridge.restartObserver()) }, 'Restart Observer'),
        h('button.oadt-btn', { disabled: off, onclick: () => void this.run('Rescanning sessions…', () => this.bridge.rescanSessions()) }, 'Rescan Sessions'),
      ),
    )
  }

  private backfillRow(s: DesktopState): HTMLElement {
    const hours = s.settings.backfillHours
    const preset = PRESETS.find(([, v]) => v === hours)
    const isCustom = this.custom || !preset
    const select = h('select', { id: 'desk-backfill', disabled: this.locked() },
      ...PRESETS.map(([label, v]) => { const o = h('option', { value: String(v) }, label) as HTMLOptionElement; o.selected = !isCustom && v === hours; return o }),
      (() => { const o = h('option', { value: 'custom' }, 'Custom…') as HTMLOptionElement; o.selected = isCustom; return o })(),
    ) as HTMLSelectElement
    select.addEventListener('change', () => {
      if (select.value === 'custom') { this.custom = true; this.customDays = String(Math.max(1, Math.round(hours / 24))); this.rerender(); return }
      this.custom = false
      void this.save({ backfillHours: Number(select.value) })
    })
    let days: HTMLInputElement | undefined
    if (isCustom) {
      days = h('input', { type: 'number', min: '1', max: '90', step: '1', value: this.customDays || String(Math.max(1, +(hours / 24).toFixed(1))), 'aria-label': 'Days of history', style: 'width:64px' }) as HTMLInputElement
      days.addEventListener('input', () => { this.customDays = days!.value })
    }
    return h('div.oadt-setting', null,
      h('div', null, h('label.oadt-setting-label', { for: 'desk-backfill' }, 'History range'), h('div.oadt-settings-desc', null, 'Sessions active within this long are loaded. Changing it reloads the observer.')),
      h('div.oadt-viz-actions', null, select,
        days ? h('span', null, days, ' days') : '',
        days ? h('button.oadt-btn.primary', { disabled: this.locked(), onclick: () => void this.save({ backfillHours: Number(days!.value) * 24 }) }, 'Apply') : ''),
    )
  }

  private harnessRow(s: DesktopState, x: HarnessStatus): HTMLElement {
    const cfg = s.settings.harnesses[x.id]
    const detail = x.state === 'disabled' ? 'Not being watched.' : `${x.sessions} ${x.sessions === 1 ? 'session' : 'sessions'}${x.readErrors ? ` · ${x.readErrors} read errors` : ''}`
    return h('div.oadt-setting', null,
      h('div', null,
        h('div.oadt-setting-label', null, x.label, h('span.oadt-tag', { 'data-state': x.state }, HARNESS_TEXT[x.state])),
        h('div.oadt-settings-desc', null, h('code', null, x.path), cfg.path ? ' (custom)' : ' (default)'),
        h('div.oadt-settings-desc', null, detail),
        x.state === 'missing' ? h('div.oadt-settings-warn', null, 'This folder does not exist. Nothing will appear until it does.') : '',
      ),
      h('div.oadt-viz-actions', null,
        h('button.oadt-btn', { disabled: this.locked(), onclick: () => void this.pick(x.id) }, 'Choose Folder…'),
        cfg.path ? h('button.oadt-btn', { disabled: this.locked(), onclick: () => void this.save({ harnesses: { [x.id]: { path: '' } } }) }, 'Use Default') : '',
        this.switch(cfg.enabled, (v) => this.save({ harnesses: { [x.id]: { enabled: v } } }), `${x.label} enabled`, this.locked()),
      ),
    )
  }

  private toggle(label: string, desc: string, on: boolean, change: (v: boolean) => void, disabled = false): HTMLElement {
    return h('div.oadt-setting', null, h('div', null, h('div.oadt-setting-label', null, label), h('div.oadt-settings-desc', null, desc)), this.switch(on, change, label, disabled || this.locked()))
  }

  private switch(on: boolean, change: (v: boolean) => void, label: string, disabled: boolean): HTMLElement {
    const input = h('input', { type: 'checkbox', role: 'switch', 'aria-label': label, disabled }) as HTMLInputElement
    input.checked = on
    input.addEventListener('change', () => change(input.checked))
    return h('span.oadt-switch', null, input, h('span', { 'aria-hidden': 'true' }))
  }

  /** Controls are disabled only while a restart is visibly in progress. */
  private locked(): boolean {
    return !!this.busy && this.busy !== 'Applying settings…'
  }

  // ─── actions ─────────────────────────────────────────────────────────

  private async pick(id: HarnessId): Promise<void> {
    const path = await this.bridge.chooseFolder(id).catch(() => null)
    if (path) await this.save({ harnesses: { [id]: { path } } })
  }

  private save(patch: unknown): Promise<void> {
    return this.run('Applying settings…', () => this.bridge.saveSettings(patch), false)
  }

  /** `show` draws the busy state while waiting. Quick edits skip it so a toggle does not flash. */
  private async run(busy: string, job: () => Promise<DesktopResult>, show = true): Promise<void> {
    this.busy = busy
    this.error = undefined
    if (show) this.rerender()
    try {
      const r = await job()
      this.state = r.state
      this.error = r.ok ? undefined : r.error
      if (r.ok) this.custom = false
    } catch (err) {
      this.error = String(err instanceof Error ? err.message : err).split('\n')[0]
    } finally {
      this.busy = undefined
      this.rerender()
    }
  }
}
