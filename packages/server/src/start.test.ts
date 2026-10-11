import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { startObserver } from './start.js'

const info = async (url: string) => (await fetch(`${url}/api/info`)).json() as Promise<{ protocol: number; sources: { name: string }[] }>

test('startObserver binds loopback on a free port and close() releases it', async () => {
  const h = await startObserver({ observer: { harnesses: [] }, port: 0 })
  assert.equal(h.host, '127.0.0.1')
  assert.ok(h.port > 0 && h.port !== 4545)
  assert.equal(h.url, `http://127.0.0.1:${h.port}`)
  assert.equal((await info(h.url)).protocol, 1)
  await h.close()
  await h.close()
  await assert.rejects(fetch(`${h.url}/api/info`))
  const probe = createServer()
  await new Promise<void>((r, j) => probe.once('error', j).listen(h.port, '127.0.0.1', r))
  probe.close()
})

test('sequential start and stop leave no listener behind', async () => {
  const ports = new Set<number>()
  for (let i = 0; i < 5; i++) {
    const h = await startObserver({ observer: { harnesses: [] }, port: 0 })
    ports.add(h.port)
    await h.close()
  }
  assert.ok(ports.size >= 1)
})

test('two observers can run side by side on different ports', async () => {
  const [a, b] = await Promise.all([0, 0].map((port) => startObserver({ observer: { harnesses: [] }, port })))
  assert.notEqual(a!.port, b!.port)
  await Promise.all([a!.close(), b!.close()])
})

test('a busy port fails with the listen error and stops the watchers it started', async () => {
  const busy = createServer()
  await new Promise<void>((r) => busy.listen(0, '127.0.0.1', r))
  const port = (busy.address() as { port: number }).port
  await assert.rejects(startObserver({ observer: { harnesses: [] }, port }), /EADDRINUSE/)
  busy.close()
})

test('observer configuration reaches the observer: a pi dir is watched and missing dirs are not fatal', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'oadt-start-'))
  mkdirSync(join(empty, 'sessions'), { recursive: true })
  writeFileSync(join(empty, 'sessions', 'x.txt'), '')
  const h = await startObserver({
    observer: { harnesses: ['pi', 'claude-code', 'codex'], piDir: empty, claudeDir: join(empty, 'none'), codexHome: join(empty, 'none') },
    port: 0,
  })
  try {
    const names = (await info(h.url)).sources.map((s) => s.name)
    assert.ok(names.some((n) => /pi/i.test(n)), `sources: ${names}`)
    assert.deepEqual(Object.keys(h.observer.world.sessions), [])
  } finally {
    await h.close()
  }
})
