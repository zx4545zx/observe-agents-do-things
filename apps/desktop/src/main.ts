/**
 * Electron shell around the existing observer. It starts the same server the CLI does
 * (`startObserver`), then shows the unchanged web UI from it. No transcript logic lives here.
 */
import { app, BrowserWindow, dialog, screen, session, shell } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { startObserver, type ObserverHandle } from '@oadt/server'
import { restoreBounds, MIN_SIZE, type WindowState } from './window-state.js'

const log = (msg: string) => console.log(`[desktop] ${msg}`)

interface Saved { window?: WindowState; port?: number }

const settingsFile = () => join(app.getPath('userData'), 'desktop.json')

function loadSaved(): Saved {
  try { return JSON.parse(readFileSync(settingsFile(), 'utf8')) as Saved } catch { return {} }
}
function save(patch: Saved): void {
  try { writeFileSync(settingsFile(), JSON.stringify({ ...loadSaved(), ...patch })) } catch (err) { log(`could not save settings: ${describe(err)}`) }
}

/** One line, home directory hidden, no stack: safe to show in a dialog or log. */
function describe(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.split('\n')[0]!.split(homedir()).join('~').slice(0, 300)
}

let handle: ObserverHandle | undefined
let win: BrowserWindow | undefined
let quitting = false

/**
 * The web UI keeps its settings (selected project) in localStorage, which belongs to an origin
 * including the port. Try last launch's port first so they survive, and take any free port otherwise.
 */
async function start(): Promise<ObserverHandle> {
  const uiDir = join(__dirname, '..', 'ui')
  const options = { observer: { sinceMs: Number(process.env.OADT_SINCE_HOURS || 6) * 3_600_000 }, host: '127.0.0.1', uiDir }
  const preferred = loadSaved().port
  if (preferred) {
    try { return await startObserver({ ...options, port: preferred }) } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err
      log(`port ${preferred} is busy, taking a free one`)
    }
  }
  return startObserver({ ...options, port: 0 })
}

function createWindow(url: string): BrowserWindow {
  const state = restoreBounds(loadSaved().window, screen.getAllDisplays().map((d) => d.workArea))
  const w = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    show: false,
    title: 'Observe Agents',
    backgroundColor: '#0d1117',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  if (state.maximized) w.maximize()
  w.once('ready-to-show', () => w.show())

  const origin = new URL(url).origin
  const external = (target: string) => { if (/^https?:\/\//i.test(target)) void shell.openExternal(target) }
  w.webContents.setWindowOpenHandler(({ url: target }) => { external(target); return { action: 'deny' } })
  w.webContents.on('will-navigate', (e, target) => {
    if (new URL(target).origin !== origin) { e.preventDefault(); external(target) }
  })

  let timer: NodeJS.Timeout | undefined
  const persist = () => {
    if (w.isDestroyed() || w.isMinimized() || w.isFullScreen()) return
    const { x, y, width, height } = w.getNormalBounds()
    save({ window: { x, y, width, height, maximized: w.isMaximized() } })
  }
  const later = () => { clearTimeout(timer); timer = setTimeout(persist, 400) }
  w.on('resize', later)
  w.on('move', later)
  w.on('close', () => { clearTimeout(timer); persist() })
  w.on('closed', () => { if (win === w) win = undefined })

  void w.loadURL(url)
  if (!app.isPackaged) w.webContents.openDevTools({ mode: 'detach' })
  log('window opened')
  return w
}

async function boot(): Promise<void> {
  for (;;) {
    try {
      handle = await start()
      break
    } catch (err) {
      log(`observer failed to start: ${describe(err)}`)
      const { response } = await dialog.showMessageBox({
        type: 'error',
        title: 'Observe Agents',
        message: 'The observer failed to start.',
        detail: describe(err),
        buttons: ['Retry', 'Quit'],
        defaultId: 0,
        cancelId: 1,
      })
      if (response === 1) return void app.quit()
    }
  }
  save({ port: handle.port })
  log(`observer listening on ${handle.url}`)
  win = createWindow(handle.url)
}

if (!app.requestSingleInstanceLock()) {
  log('another instance is running, exiting')
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })

  void app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
    log('ready')
    return boot()
  })

  app.on('activate', () => {
    if (win) win.show()
    else if (handle) win = createWindow(handle.url)
  })

  // macOS convention: closing the window leaves the app and observer running, Quit stops them.
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })

  app.on('before-quit', (e) => {
    if (quitting || !handle) return
    e.preventDefault()
    quitting = true
    log('shutting down')
    const h = handle
    handle = undefined
    void h.close().catch((err) => log(`close failed: ${describe(err)}`)).finally(() => app.exit(0))
  })
}
