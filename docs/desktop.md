# Desktop app (macOS)

Electron around the same observer and web UI. Web mode (`oadt`, `npm start`) is unchanged.

```text
Electron main  ->  startObserver()  ->  HTTP/SSE server on 127.0.0.1  ->  Mission Control (BrowserWindow)
```

`startObserver` (`packages/server/src/start.ts`) is the one lifecycle used by the CLI, the VS Code extension and the desktop app. It starts the watchers, binds the server, and returns `{ url, port, close() }`.

## Commands

| | |
|---|---|
| `npm run desktop:dev` | build everything, launch Electron with DevTools. After UI edits run `npm run build:web && npm run build --workspace apps/desktop`, then Cmd+R. |
| `npm run desktop:build` | build packages, web UI and the main-process bundle |
| `npm run desktop:package` | unpacked app: `apps/desktop/release/mac-arm64/Observe Agents.app` |
| `npm run desktop:dist` | the app plus `apps/desktop/release/Observe Agents-<version>-arm64.dmg` |

## Settings (Settings, then Desktop, or Cmd+,)

Desktop-only preferences, kept in `settings.json` in the app's userData folder (`~/Library/Application Support/Observe Agents/`). They are never part of the event protocol, and the CLI ignores them. A damaged file resets to the defaults and the app says so.

| Setting | Default |
|---|---|
| History range (6 h, 24 h, 3 d, 7 d, or custom days up to 90) | 6 hours |
| Pi, Claude Code, Codex: on or off | all on |
| Pi, Claude Code, Codex: folder | empty, meaning the harness default (`$PI_CODING_AGENT_DIR`, `~/.pi/agent` and so on) |
| Notifications, Needs attention, PStack run completed | all on |
| Launch at login | not stored: read from and written to macOS |

Changing history range, a harness switch or a folder restarts the observer with the new settings, on the same port. Alert switches and Launch at login apply at once. Every value from the page is validated again in the main process (absolute paths, numeric ranges, known harness ids), and a failed change leaves the old settings in place.

**Harness status** comes from the running observer, on request and when something changes, never by polling. Disabled is from the settings. Missing means none of the adapter's folders exist. Error means read errors and no sessions. Watching otherwise, with the number of sessions loaded inside the history range.

**Restart Observer** replaces the observer and server (same port when free). **Rescan Sessions** does the same: the observer has no incremental rescan, so it discards its state and backfills again with the current settings. If a restart fails the previous settings are put back. The page reconnects by itself and its selections (localStorage) are kept because the port does not change.

**Notifications** come from the main process, from the same attention rules and run model as the UI. Only two events: an agent starting to wait on you, or a failure streak (Needs attention), and a PStack run going from running to done. A tracker records what is already true when an observer starts as its baseline, so backfill, restart and rescan never announce history. There is no run failure notification: the model has no run failure state, and one failed tool call is not one. Clicking a notification focuses the app and opens that session.

**Launch at login** uses macOS login items for the installed app and opens a normal window (no hidden start). It is unavailable when running from source.

**Menu.** Observe Agents: About, Settings… (Cmd+,), Services, Hide, Quit. Monitor: Restart Observer (Cmd+Alt+R), Rescan Sessions (Cmd+Shift+R). Edit. View: Mission Control, Reload (renderer only, the observer stays in the main process), Developer Tools (unpackaged only), Full Screen. Window.

**Icon.** `apps/desktop/build/icon.png` and `icon.icns` are drawn by `node apps/desktop/scripts/make-icon.mjs` (no dependencies, uses macOS `sips` and `iconutil`). electron-builder puts it in the app and the DMG.

**Security.** A preload now exists with eight named calls (`window.oadtDesktop`), `contextIsolation` and `sandbox` stay on. Each handler checks that the sender is the page served by this observer.

## Behaviour (V1)

- **Server.** Loopback only (`127.0.0.1`). It first tries the port used last launch (kept in `desktop.json` under the app's userData folder) so the web UI's `localStorage`, which belongs to an origin with its port, survives restarts. If that port is taken it uses a free one. Selected project persistence relies on this.
- **Harnesses.** Configured in Settings. Missing folders are fine. A Finder launch does not see shell variables such as `PI_CODING_AGENT_DIR`: set the folder in Settings.
- **Security.** `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, no preload. Navigation away from the server origin is blocked and http(s) links open in the default browser. `window.open` is denied. Every permission request is denied.
- **Lifecycle.** One instance (a second launch focuses the window). Closing the window keeps the app and observer running (macOS convention), Dock click reopens it, Quit closes the observer and the port before exiting.
- **Window.** Size, position and maximized state are saved. A position that is no longer on a connected screen is dropped. Default 1400x900, minimum 900x600.
- **Startup failure.** A dialog with the first line of the error (home folder shown as `~`) and Retry or Quit.
- DevTools open automatically only when not packaged.

## Limits

Unsigned and not notarized (`identity: null`): Gatekeeper asks for right-click, Open on first run, and a distributed build needs an Apple Developer certificate. arm64 macOS only. No auto-update, tray or remote mode. Window and project-persistence behaviour is checked by hand, the pure window bounds logic by ``npm test --workspace apps/desktop` (also part of `npm test`)`.
