/**
 * One way to bring up an observer and its HTTP server, shared by the CLI and the desktop app.
 * It owns the lifecycle: watchers start first, the server binds second, `close()` undoes both.
 */
import { Observer, type ObserverOptions } from '@oadt/core'
import { ObserverServer, type ServerOptions } from './server.js'

export interface StartObserverOptions extends Omit<ServerOptions, 'observer' | 'port'> {
  /** Reuse an observer you built, or pass options for a new one. Default: all built-in harnesses. */
  observer?: Observer | ObserverOptions
  /** 0 picks a free port. Default 4545. */
  port?: number
}

export interface ObserverHandle {
  observer: Observer
  server: ObserverServer
  host: string
  port: number
  url: string
  /** Stops the watchers, ends open streams and releases the port. Safe to call twice. */
  close(): Promise<void>
}

export async function startObserver(opts: StartObserverOptions = {}): Promise<ObserverHandle> {
  const { observer: given, port, ...serverOpts } = opts
  const observer = given instanceof Observer ? given : new Observer(given)
  await observer.start()
  const server = new ObserverServer({ ...serverOpts, observer, host: serverOpts.host ?? '127.0.0.1', port: port ?? 4545 })
  let bound: { host: string; port: number; url: string }
  try {
    bound = await server.listen()
  } catch (err) {
    observer.stop()
    throw err
  }
  let closing: Promise<void> | undefined
  return {
    observer,
    server,
    ...bound,
    close: () => (closing ??= (async () => {
      observer.stop()
      await server.close()
    })()),
  }
}
