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

## Behaviour

- **Server.** Loopback only (`127.0.0.1`). It first tries the port used last launch (kept in `desktop.json` under the app's userData folder) so the web UI's `localStorage`, which belongs to an origin with its port, survives restarts. If that port is taken it uses a free one. Selected project persistence relies on this.
- **Harnesses.** All three, with their usual defaults (`~/.claude`, `~/.codex`, `~/.pi/agent`). Missing folders are fine. Backfill window is 6h like the CLI, `OADT_SINCE_HOURS` overrides it. A Finder launch does not see shell variables such as `PI_CODING_AGENT_DIR`.
- **Security.** `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, no preload. Navigation away from the server origin is blocked and http(s) links open in the default browser. `window.open` is denied. Every permission request is denied.
- **Lifecycle.** One instance (a second launch focuses the window). Closing the window keeps the app and observer running (macOS convention), Dock click reopens it, Quit closes the observer and the port before exiting.
- **Window.** Size, position and maximized state are saved. A position that is no longer on a connected screen is dropped. Default 1400x900, minimum 900x600.
- **Startup failure.** A dialog with the first line of the error (home folder shown as `~`) and Retry or Quit.
- DevTools open automatically only when not packaged.

## Limits

Unsigned and not notarized (`identity: null`): Gatekeeper asks for right-click, Open on first run, and a distributed build needs an Apple Developer certificate. arm64 macOS only. Icon is the VS Code extension icon scaled up, a placeholder. No auto-update, tray or remote mode. Window and project-persistence behaviour is checked by hand, the pure window bounds logic by `node --test apps/desktop/src/window-state.test.ts`.
