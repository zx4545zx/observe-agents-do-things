/**
 * Electron shell around the existing observer. The observer and server come from the same
 * `startObserver` the CLI uses, owned by one ObserverManager. No transcript logic lives here.
 */
import { app, BrowserWindow, dialog, Menu, Notification, screen, session, shell } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { startObserver } from '@oadt/server'
import { desktopState, registerIpc } from './ipc.ts'
import { buildMenu } from './menu.ts'
import { NoticeService, type Notice } from './notices.ts'
import { ObserverManager, plainError } from './observer-manager.ts'
import { loadSettings } from './settings.ts'
import { restoreBounds, MIN_SIZE, type WindowState } from './window-state.ts'
import type { DesktopCommand } from '../../web/src/host/desktop-types.ts'

app.setName('Observe Agents')

const log = (msg: string) => console.log(`[desktop] ${msg}`)

interface Saved { window?: WindowState; port?: number }

const windowFile = () => join(app.getPath('userData'), 'desktop.json')
const settingsFile = () => join(app.getPath('userData'), 'settings.json')

function loadSaved(): Saved {
  try { return JSON.parse(readFileSync(windowFile(), 'utf8')) as Saved } catch { return {} }
}
function save(patch: Saved): void {
  try { writeFileSync(windowFile(), JSON.stringify({ ...loadSaved(), ...patch })) } catch (err) { log(`could not save window state: ${plainError(err, homedir())}`) }
}

let manager: ObserverManager
let win: BrowserWindow | undefined
let quitting = false
const shown = new Set<Notification>()

const send = (cmd: DesktopCommand) => { if (win && !win.isDestroyed()) win.webContents.send('desktop:command', cmd) }
const pushState = () => {
  if (win && !win.isDestroyed()) win.webContents.send('desktop:state', desktopState({ manager, settingsFile: settingsFile(), window: () => win, notificationsSupported: () => Notification.isSupported(), log }))
}

function focusWindow(): void {
  if (!win) { if (manager.url) win = createWindow(manager.url); return }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
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
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: join(__dirname, 'preload.cjs') },
  })
  if (state.maximized) w.maximize()
  w.once('ready-to-show', () => w.show())

  const external = (target: string) => { if (/^https?:\/\//i.test(target)) void shell.openExternal(target) }
  w.webContents.setWindowOpenHandler(({ url: target }) => { external(target); return { action: 'deny' } })
  w.webContents.on('will-navigate', (e, target) => {
    // Compared with the live server each time: a restart may move the app to another port.
    if (!manager.url || new URL(target).origin !== new URL(manager.url).origin) { e.preventDefault(); external(target) }
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

function notify(n: Notice): void {
  if (!Notification.isSupported()) return
  try {
    const note = new Notification({ title: n.title, subtitle: n.subtitle, body: n.body })
    shown.add(note)
    const done = () => shown.delete(note)
    note.on('click', () => { focusWindow(); send({ type: 'navigate', sessionId: n.sessionId }); done() })
    note.on('close', done)
    note.show()
    log(`notification: ${n.kind}`)
  } catch (err) { log(`notification failed: ${plainError(err, homedir())}`) }
}

/** An action from the menu or a button: run it, and show a plain message if it fails. */
async function action(name: string, job: () => Promise<void>): Promise<void> {
  try { await job() } catch (err) {
    await dialog.showMessageBox({ type: 'error', title: 'Observe Agents', message: `${name} failed.`, detail: plainError(err, homedir()) })
  }
}

async function boot(): Promise<void> {
  const loaded = loadSettings(settingsFile())
  if (loaded.warning) log(loaded.warning)
  manager = new ObserverManager({
    start: startObserver,
    uiDir: join(__dirname, '..', 'ui'),
    port: loadSaved().port,
    log,
    home: homedir(),
  }, loaded.settings)

  const notices = new NoticeService({ prefs: () => manager.settings.notifications, show: notify })
  manager.onHandle((h) => {
    notices.attach(h?.observer)
    if (!h) return
    save({ port: h.port })
    log(`observer listening on ${h.url}`)
    // The port only changes when the previous one was taken: the page must follow it.
    if (win && !win.isDestroyed() && new URL(win.webContents.getURL() || h.url).origin !== new URL(h.url).origin) void win.loadURL(h.url)
  })
  manager.onChange(pushState)
  registerIpc({ manager, settingsFile: settingsFile(), window: () => win, notificationsSupported: () => Notification.isSupported(), log })

  Menu.setApplicationMenu(buildMenu({
    openSettings: () => { focusWindow(); send({ type: 'open-settings' }) },
    showMission: () => { focusWindow(); send({ type: 'mission' }) },
    restartObserver: () => void action('Restart Observer', () => manager.restart()),
    rescanSessions: () => void action('Rescan Sessions', () => manager.rescan()),
  }))

  for (;;) {
    try {
      await manager.start()
      break
    } catch (err) {
      log(`observer failed to start: ${plainError(err, homedir())}`)
      const { response } = await dialog.showMessageBox({
        type: 'error',
        title: 'Observe Agents',
        message: 'The observer failed to start.',
        detail: plainError(err, homedir()),
        buttons: ['Retry', 'Quit'],
        defaultId: 0,
        cancelId: 1,
      })
      if (response === 1) return void app.quit()
    }
  }
  win = createWindow(manager.url!)
  if (loaded.warning) void dialog.showMessageBox(win, { type: 'warning', title: 'Observe Agents', message: 'Settings were reset.', detail: loaded.warning })
}

if (!app.requestSingleInstanceLock()) {
  log('another instance is running, exiting')
  app.quit()
} else {
  app.on('second-instance', () => { if (win) focusWindow() })

  void app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
    app.setAboutPanelOptions({ applicationName: 'Observe Agents', applicationVersion: app.getVersion(), copyright: 'Read-only observer for coding agents' })
    if (!app.isPackaged) app.dock?.setIcon(join(__dirname, '..', 'build', 'icon.png'))
    log('ready')
    return boot()
  })

  app.on('activate', () => focusWindow())

  // macOS convention: closing the window leaves the app and observer running, Quit stops them.
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })

  app.on('before-quit', (e) => {
    if (quitting || !manager) return
    e.preventDefault()
    quitting = true
    log('shutting down')
    void manager.close().catch((err) => log(`close failed: ${plainError(err, homedir())}`)).finally(() => app.exit(0))
  })
}
