import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyEvent, createWorld, type AgentStatus, type ObserverEvent, type WorldState } from '@oadt/protocol'
import { NoticeService, NoticeTracker, wanted, type Notice } from './notices.ts'
import { DEFAULT_SETTINGS } from './settings.ts'

const SID = 's1'
let seq = 0
const send = (w: WorldState, d: Record<string, unknown>) => applyEvent(w, { harness: 'pi', sessionId: SID, ...d, seq: ++seq } as unknown as ObserverEvent)
const NOW = 1_000_000

function world(): WorldState {
  const w = createWorld()
  send(w, { ts: 1, agentId: SID, kind: 'session.started', meta: { cwd: '/work/Gojo' } })
  return w
}
const worker = (w: WorldState, id: string, parent: string, status: AgentStatus) => {
  send(w, { ts: 10, agentId: id, kind: 'agent.spawned', parentAgentId: parent, name: id, role: 'poteto-agent', task: 't' })
  send(w, { ts: 11, agentId: id, kind: 'agent.status', status })
}
const status = (w: WorldState, id: string, s: AgentStatus) => send(w, { ts: 20, agentId: id, kind: 'agent.status', status: s })

test('a run that goes from running to done notifies once', () => {
  const w = world(); worker(w, 'lead', SID, 'working'); worker(w, 'w1', 'lead', 'working')
  const t = new NoticeTracker()
  assert.deepEqual(t.observe(w, NOW), [])
  status(w, 'lead', 'done'); status(w, 'w1', 'done')
  const out = t.observe(w, NOW)
  assert.equal(out.length, 1)
  assert.deepEqual([out[0]!.subtitle, out[0]!.body], ['PStack Run 1 completed', 'Gojo · 2 agents'])
  assert.deepEqual(t.observe(w, NOW), [], 'not again')
})

test('runs that were already done at the baseline never notify', () => {
  const w = world(); worker(w, 'lead', SID, 'done')
  const t = new NoticeTracker()
  assert.deepEqual(t.observe(w, NOW), [])
  assert.deepEqual(t.observe(w, NOW + 5000), [])
})

test('a restart (new tracker) does not replay completed runs or old attention', () => {
  const w = world(); worker(w, 'lead', SID, 'working')
  status(w, 'lead', 'done')
  worker(w, 'late', SID, 'waiting')
  const fresh = new NoticeTracker()
  assert.deepEqual(fresh.observe(w, NOW), [])
  assert.deepEqual(fresh.observe(w, NOW), [])
})

test('a run first seen already done after the baseline is not a transition', () => {
  const w = world(); worker(w, 'a', SID, 'working')
  const t = new NoticeTracker(); t.observe(w, NOW)
  worker(w, 'b', SID, 'done')
  assert.deepEqual(t.observe(w, NOW), [])
})

test('an agent that starts waiting after the baseline notifies once, with the real reason', () => {
  const w = world(); worker(w, 'lead', SID, 'working')
  const t = new NoticeTracker(); t.observe(w, NOW)
  send(w, { ts: 30, agentId: 'lead', kind: 'agent.status', status: 'waiting', reason: 'approve Bash' })
  const out = t.observe(w, NOW)
  assert.equal(out.length, 1)
  assert.equal(out[0]!.kind, 'attention')
  assert.equal(out[0]!.subtitle, 'Gojo needs your attention')
  assert.match(out[0]!.body, /^Pi · /)
  assert.deepEqual(t.observe(w, NOW), [])
})

test('one failed tool call is neither attention nor a run failure', () => {
  const w = world(); worker(w, 'lead', SID, 'working')
  const t = new NoticeTracker(); t.observe(w, NOW)
  send(w, { ts: 30, agentId: 'lead', kind: 'tool.started', callId: 'c', tool: 'bash', category: 'shell', title: 'run' })
  send(w, { ts: 31, agentId: 'lead', kind: 'tool.finished', callId: 'c', ok: false })
  assert.deepEqual(t.observe(w, NOW), [])
})

test('preferences filter by master switch and kind', () => {
  const attn = { kind: 'attention' } as Notice, run = { kind: 'run' } as Notice
  const p = DEFAULT_SETTINGS.notifications
  assert.deepEqual([wanted(attn, p), wanted(run, p)], [true, true])
  assert.deepEqual([wanted(attn, { ...p, enabled: false }), wanted(run, { ...p, enabled: false })], [false, false])
  assert.deepEqual([wanted(attn, { ...p, attention: false }), wanted(run, { ...p, attention: false })], [false, true])
  assert.deepEqual([wanted(attn, { ...p, runCompleted: false }), wanted(run, { ...p, runCompleted: false })], [true, false])
})

test('the service shows only wanted notices, re-baselines on every attach, and stops on detach', async () => {
  const w = world(); worker(w, 'lead', SID, 'working')
  const shown: Notice[] = []
  let prefs = DEFAULT_SETTINGS.notifications
  const svc = new NoticeService({ prefs: () => prefs, show: (n) => shown.push(n), intervalMs: 5, now: () => NOW })
  const obs = { world: w }
  svc.attach(obs)
  prefs = { ...prefs, runCompleted: false }
  status(w, 'lead', 'done')
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(shown.length, 0, 'muted kind')
  svc.attach(obs)
  prefs = DEFAULT_SETTINGS.notifications
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(shown.length, 0, 'the completed run is baseline after re-attach')
  svc.detach()
})
