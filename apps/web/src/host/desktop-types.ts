/** The narrow API the desktop shell exposes to the page (`window.oadtDesktop`). Types only, shared with apps/desktop. */
export type HarnessId = 'pi' | 'claude-code' | 'codex'

export interface DesktopSettings {
  /** How far back sessions are loaded, in hours. */
  backfillHours: number
  harnesses: Record<HarnessId, { enabled: boolean; /** Empty means the harness default. */ path: string }>
  notifications: { enabled: boolean; attention: boolean; runCompleted: boolean }
}

export interface HarnessStatus {
  id: HarnessId
  label: string
  state: 'watching' | 'missing' | 'disabled' | 'error'
  /** What the path is when nothing is configured, or the configured one. */
  path: string
  sessions: number
  readErrors: number
}

export interface DesktopState {
  settings: DesktopSettings
  observer: { state: 'starting' | 'running' | 'restarting' | 'error' | 'stopped'; error?: string }
  harnesses: HarnessStatus[]
  login: { supported: boolean; enabled: boolean }
  notificationsSupported: boolean
  version: string
}

export interface DesktopResult { ok: boolean; error?: string; state: DesktopState }

export type DesktopCommand = { type: 'open-settings' } | { type: 'mission' } | { type: 'navigate'; sessionId: string }

export interface DesktopBridge {
  getState(): Promise<DesktopState>
  saveSettings(patch: unknown): Promise<DesktopResult>
  chooseFolder(harness: HarnessId): Promise<string | null>
  restartObserver(): Promise<DesktopResult>
  rescanSessions(): Promise<DesktopResult>
  setLaunchAtLogin(enabled: boolean): Promise<DesktopResult>
  onState(cb: (state: DesktopState) => void): () => void
  onCommand(cb: (cmd: DesktopCommand) => void): () => void
}
