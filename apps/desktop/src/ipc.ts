import { app, dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { homedir } from 'node:os'
import type { DesktopResult, DesktopState, HarnessId } from '../../web/src/host/desktop-types.ts'
import { plainError, type ObserverManager } from './observer-manager.ts'
import { applyPatch, HARNESS_IDS, saveSettings, toObserverOptions } from './settings.ts'

export interface IpcDeps {
  manager: ObserverManager
  settingsFile: string
  window: () => BrowserWindow | undefined
  notificationsSupported: () => boolean
  log: (m: string) => void
}

const loginSupported = () => process.platform === 'darwin' && app.isPackaged

export function desktopState(d: IpcDeps): DesktopState {
  const status = d.manager.status()
  return {
    settings: d.manager.settings,
    observer: { state: status.state, error: status.error },
    harnesses: status.harnesses,
    login: { supported: loginSupported(), enabled: loginSupported() && app.getLoginItemSettings().openAtLogin },
    notificationsSupported: d.notificationsSupported(),
    version: app.getVersion(),
  }
}

/** Handlers answer only the page this app serves from its own observer. */
export function registerIpc(d: IpcDeps): void {
  const trusted = (e: IpcMainInvokeEvent): boolean => {
    try { return !!d.manager.url && new URL(e.senderFrame?.url ?? '').origin === new URL(d.manager.url).origin } catch { return false }
  }
  const handle = <A extends unknown[], R>(channel: string, fn: (...args: A) => Promise<R> | R) =>
    ipcMain.handle(channel, (e, ...args) => {
      if (!trusted(e)) throw new Error('untrusted sender')
      return fn(...(args as A))
    })
  const result = async (job: () => Promise<unknown> | unknown): Promise<DesktopResult> => {
    try { await job(); return { ok: true, state: desktopState(d) } } catch (err) {
      d.log(`action failed: ${plainError(err, homedir())}`)
      return { ok: false, error: plainError(err, homedir()), state: desktopState(d) }
    }
  }

  handle('desktop:get-state', () => desktopState(d))

  handle('desktop:save-settings', (patch: unknown) => result(async () => {
    const { settings: next, errors } = applyPatch(d.manager.settings, patch)
    if (errors.length) throw new Error(errors.join(' '))
    const before = JSON.stringify(toObserverOptions(d.manager.settings))
    if (JSON.stringify(toObserverOptions(next)) !== before) await d.manager.restart(next)
    else d.manager.adopt(next)
    saveSettings(d.settingsFile, next)
  }))

  handle('desktop:choose-folder', async (id: unknown) => {
    if (!HARNESS_IDS.includes(id as HarnessId)) throw new Error('unknown harness')
    const s = d.manager.settings.harnesses[id as HarnessId].path
    const win = d.window()
    const options = { title: 'Choose folder', defaultPath: s || homedir(), properties: ['openDirectory' as const, 'showHiddenFiles' as const] }
    const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return r.canceled ? null : r.filePaths[0] ?? null
  })

  handle('desktop:restart', () => result(() => d.manager.restart()))
  handle('desktop:rescan', () => result(() => d.manager.rescan()))

  handle('desktop:set-login', (enabled: unknown) => result(() => {
    if (typeof enabled !== 'boolean') throw new Error('enabled must be true or false')
    if (!loginSupported()) throw new Error('Launch at login is available in the installed app.')
    app.setLoginItemSettings({ openAtLogin: enabled })
  }))
}
