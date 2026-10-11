/** The only thing the page can reach in Electron: named, typed calls. Each one is validated again in the main process. */
import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopBridge, DesktopCommand, DesktopState } from '../../web/src/host/desktop-types.ts'

const subscribe = <T>(channel: string, cb: (v: T) => void): (() => void) => {
  const listener = (_e: unknown, v: T) => cb(v)
  ipcRenderer.on(channel, listener)
  return () => { ipcRenderer.removeListener(channel, listener) }
}

const bridge: DesktopBridge = {
  getState: () => ipcRenderer.invoke('desktop:get-state'),
  saveSettings: (patch) => ipcRenderer.invoke('desktop:save-settings', patch),
  chooseFolder: (harness) => ipcRenderer.invoke('desktop:choose-folder', harness),
  restartObserver: () => ipcRenderer.invoke('desktop:restart'),
  rescanSessions: () => ipcRenderer.invoke('desktop:rescan'),
  setLaunchAtLogin: (enabled) => ipcRenderer.invoke('desktop:set-login', enabled),
  onState: (cb) => subscribe<DesktopState>('desktop:state', cb),
  onCommand: (cb) => subscribe<DesktopCommand>('desktop:command', cb),
}

contextBridge.exposeInMainWorld('oadtDesktop', bridge)
