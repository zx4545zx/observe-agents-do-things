import { app, Menu, type MenuItemConstructorOptions } from 'electron'

export interface MenuActions {
  openSettings(): void
  showMission(): void
  restartObserver(): void
  rescanSessions(): void
}

/** The standard macOS menu bar plus the monitor commands. Developer tools only when running unpackaged. */
export function buildMenu(a: MenuActions): Menu {
  const name = app.name
  const template: MenuItemConstructorOptions[] = [
    {
      label: name,
      submenu: [
        { role: 'about', label: `About ${name}` },
        { type: 'separator' },
        // The page already handles Cmd+, itself, so the menu shows the key without also grabbing it.
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', registerAccelerator: false, click: a.openSettings },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: `Hide ${name}` },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: `Quit ${name}` },
      ],
    },
    {
      label: 'Monitor',
      submenu: [
        { label: 'Restart Observer', accelerator: 'CmdOrCtrl+Alt+R', click: a.restartObserver },
        { label: 'Rescan Sessions', accelerator: 'CmdOrCtrl+Shift+R', click: a.rescanSessions },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Mission Control', click: a.showMission },
        { role: 'reload' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' } as MenuItemConstructorOptions]),
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]
  return Menu.buildFromTemplate(template)
}
