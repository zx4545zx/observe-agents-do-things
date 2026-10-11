import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { startObserver } from '@oadt/server'
import { ObserverManager, plainError, type StartFn } from './observer-manager.ts'
import { applyPatch, DEFAULT_SETTINGS } from './settings.ts'

/** A start function that records what it was asked and can be told to fail. */
function fake() {
  const calls: Array<{ port: number | undefined; sinceMs: number | undefined; harnesses: string[] | undefined }> = []
  let open = 0
  let busy = new Set<number>()
  let failNext: Error | undefined
  const start: StartFn = async (opts) => {
    const o = opts.observer as { sinceMs?: number; harnesses?: string[] }
    calls.push({ port: opts.port, sinceMs: o.sinceMs, harnesses: o.harnesses })
    if (failNext) { const e = failNext; failNext = undefined; throw e }
    if (opts.port && busy.has(opts.port)) throw Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' })
    const port = opts.port || 40000 + calls.length
    open++
    let closed = false
    return { port, host: '127.0.0.1', url: `http://127.0.0.1:${port}`, observer: { world: { sessions: {} } } as never, server: {} as never, close: async () => { if (!closed) { closed = true; open-- } } }
  }
  return { start, calls, get open() { return open }, busy: (p: number) => busy.add(p), fail: (e: Error) => { failNext = e } }
}

const mgr = (f: ReturnType<typeof fake>, port?: number) => new ObserverManager({ start: f.start, uiDir: '/ui', port }, DEFAULT_SETTINGS)
const patch = (p: unknown) => applyPatch(DEFAULT_SETTINGS, p).settings

test('restart replaces the observer, keeps the port and applies the new settings', async () => {
  const f = fake(); const m = mgr(f)
  await m.start()
  const port = m.port
  await m.restart(patch({ backfillHours: 24, harnesses: { codex: { enabled: false } } }))
  assert.equal(m.port, port)
  assert.equal(f.open, 1, 'the old observer was closed')
  assert.deepEqual(f.calls.at(-1), { port, sinceMs: 86_400_000, harnesses: ['pi', 'claude-code'] })
  assert.equal(m.settings.backfillHours, 24)
})

test('rescan is a restart with the same settings and port', async () => {
  const f = fake(); const m = mgr(f)
  await m.start(patch({ backfillHours: 72 }))
  const port = m.port
  await m.rescan()
  assert.equal(f.calls.length, 2)
  assert.deepEqual(f.calls[1], { port, sinceMs: 259_200_000, harnesses: ['pi', 'claude-code', 'codex'] })
  assert.equal(f.open, 1)
})

test('a taken port falls back to a free one, a free one is reused', async () => {
  const f = fake(); const m = mgr(f, 5555)
  await m.start()
  assert.equal(m.port, 5555)
  f.busy(5555)
  await m.restart()
  assert.notEqual(m.port, 5555)
  assert.equal(f.open, 1)
})

test('a failed restart puts the previous settings back, leaves one observer, and reports the error', async () => {
  const f = fake(); const m = mgr(f)
  await m.start()
  const port = m.port
  f.fail(new Error('boom /Users/x'))
  await assert.rejects(m.restart(patch({ backfillHours: 168 })), /boom/)
  assert.equal(m.settings.backfillHours, 6, 'rolled back')
  assert.equal(m.port, port)
  assert.equal(f.open, 1)
  const s = m.status()
  assert.equal(s.state, 'running')
  assert.match(s.error!, /boom/)
})

test('if the rollback fails too, nothing is left running and the state is error', async () => {
  const f = fake()
  let n = 0
  const m = new ObserverManager({ start: async (o) => { if (++n >= 2) throw new Error('still down'); return f.start(o) }, uiDir: '/ui' }, DEFAULT_SETTINGS)
  await m.start()
  await assert.rejects(m.restart(patch({ backfillHours: 24 })), /still down/)
  assert.equal(m.status().state, 'error')
  assert.equal(m.port, undefined)
  assert.equal(f.open, 0)
  await m.close()
})

test('overlapping restarts run one at a time and never leave two observers', async () => {
  const f = fake(); const m = mgr(f)
  await m.start()
  await Promise.all([m.restart(), m.rescan(), m.restart(patch({ backfillHours: 24 }))])
  assert.equal(f.open, 1)
  await m.close()
  assert.equal(f.open, 0)
  assert.equal(m.status().state, 'stopped')
})

test('listeners hear about handles coming and going', async () => {
  const f = fake(); const m = mgr(f)
  const seen: Array<string | undefined> = []
  m.onHandle((h) => seen.push(h?.url))
  await m.start(); await m.restart(); await m.close()
  assert.deepEqual(seen.map((u) => !!u), [true, false, true, false])
})

test('status: disabled harnesses are disabled, a missing folder is missing, a present one is watching', async () => {
  const f = fake()
  const claude = mkdtempSync(join(tmpdir(), 'oadt-cl-'))
  mkdirSync(join(claude, 'projects'))
  const m = new ObserverManager({ start: f.start, uiDir: '/ui' }, applyPatch(DEFAULT_SETTINGS, { harnesses: { pi: { path: '/definitely/not/here' }, codex: { enabled: false }, 'claude-code': { path: claude } } }).settings)
  await m.start()
  const by = Object.fromEntries(m.status().harnesses.map((h) => [h.id, h]))
  assert.equal(by.pi!.state, 'missing')
  assert.match(by.pi!.path, /definitely/)
  assert.equal(by.codex!.state, 'disabled')
  assert.equal(by['claude-code']!.state, 'watching')
  await m.close()
})

test('with the real server: restart keeps the port, serves again, and releases it on close', async () => {
  const m = new ObserverManager({ start: startObserver, uiDir: '/nonexistent' }, applyPatch(DEFAULT_SETTINGS, { harnesses: { pi: { enabled: false }, codex: { enabled: false }, 'claude-code': { enabled: false } } }).settings)
  await m.start()
  const url = m.url!
  assert.equal((await (await fetch(`${url}/api/info`)).json() as { protocol: number }).protocol, 1)
  await m.restart(); await m.rescan()
  assert.equal(m.url, url)
  assert.equal((await fetch(`${url}/api/info`)).ok, true)
  await m.close()
  await assert.rejects(fetch(`${url}/api/info`))
})

test('errors shown to people are one line without the home folder', () => {
  assert.equal(plainError(new Error('cannot read /Users/me/x\n  at stack'), '/Users/me'), 'cannot read ~/x')
  assert.equal(plainError(Object.assign(new Error('listen EADDRINUSE 127.0.0.1:1'), { code: 'EADDRINUSE' })), 'The local port is in use.')
})
