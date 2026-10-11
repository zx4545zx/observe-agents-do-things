import assert from 'node:assert/strict'
import { test } from 'node:test'
import { activeRuns, activityFeed, agentCurrentActivity, applyEvent, createWorld, filterWorld, genericAgents, listProjects, runViews, sessionSearchText, type AgentStatus, type EventDraft, type ObserverEvent, type WorldState } from '@oadt/protocol'

let seq = 0
const send = (w: WorldState, d: EventDraft) => applyEvent(w, { ...d, seq: ++seq } as ObserverEvent)

function session(w: WorldState, sid: string, cwd: string): void {
  send(w, { harness: 'pi', sessionId: sid, ts: 1, agentId: sid, kind: 'session.started', meta: { cwd } })
}
function agent(w: WorldState, sid: string, id: string, parent: string, ts: number, role: string, task?: string, parentToolCallId?: string): void {
  send(w, { harness: 'pi', sessionId: sid, ts, agentId: id, kind: 'agent.spawned', parentAgentId: parent, parentToolCallId, name: role, role, task })
}
function status(w: WorldState, sid: string, id: string, ts: number, s: AgentStatus): void {
  send(w, { harness: 'pi', sessionId: sid, ts, agentId: id, kind: 'agent.status', status: s })
}
function tool(w: WorldState, sid: string, id: string, call: string, ts: number, title: string, category: 'edit' | 'shell' | 'agent' = 'edit', done = false): void {
  send(w, { harness: 'pi', sessionId: sid, ts, agentId: id, kind: 'tool.started', callId: call, tool: 'x', category, title })
  if (done) send(w, { harness: 'pi', sessionId: sid, ts: ts + 5, agentId: id, kind: 'tool.finished', callId: call, ok: true })
}

function build(): WorldState {
  const w = createWorld()
  session(w, 'S', '/work/gojo')
  // run 1: lead + nested workers, finished
  agent(w, 'S', 'l1', 'S', 100, 'poteto-agent', 'Execute the approved task')
  agent(w, 'S', 'w1', 'l1', 110, 'poteto-agent', 'Add tests')
  agent(w, 'S', 'w1a', 'w1', 120, 'poteto-agent', 'Fix flaky test')
  agent(w, 'S', 'w2', 'l1', 130, 'poteto-agent', 'Update the API')
  for (const id of ['w1a', 'w1', 'w2', 'l1']) status(w, 'S', id, 200, 'done')
  // run 2: lead only, working
  agent(w, 'S', 'l2', 'S', 300, 'poteto-agent', 'Continue the implementation')
  // run 3: lead + one worker, older than run 2 but still going
  agent(w, 'S', 'l0', 'S', 50, 'poteto-agent', 'First pass')
  agent(w, 'S', 'w0', 'l0', 60, 'poteto-agent', 'Investigate')
  // generic agents
  agent(w, 'S', 'g1', 'S', 70, 'reviewer', 'Review the diff')
  agent(w, 'S', 'g2', 'w1', 125, 'explore', 'Find usages')
  session(w, 'T', '/work/ark')
  agent(w, 'T', 'tg', 'T', 80, 'explore', 'Look around')
  session(w, 'U', '/work/ark')
  agent(w, 'U', 'u1', 'U', 90, 'poteto-agent', 'Ark run')
  return w
}

test('monitor: runs are ordered active first, then newest to oldest, and never merged', () => {
  const w = build()
  const runs = runViews(w.sessions.S!, 1000)
  assert.deepEqual(runs.map((r) => [r.run.id, r.run.status]), [['l2', 'running'], ['l0', 'running'], ['l1', 'done']])
  assert.deepEqual(runs.map((r) => r.active), [true, true, false])
  assert.equal(runs.length, 3, 'three launches stay three runs')
})

test('monitor: a run lists its lead and its workers in tree order, with depth, and leaves generic agents out', () => {
  const w = build()
  const r = runViews(w.sessions.S!, 1000).find((x) => x.run.id === 'l1')!
  assert.equal(r.lead.agent.id, 'l1')
  assert.deepEqual(r.workers.map((x) => [x.agent.id, x.depth]), [['w1', 1], ['w1a', 2], ['w2', 1]])
  assert.deepEqual(r.counts, { working: 0, waiting: 0, done: 4, failed: 0 })
  const lone = runViews(w.sessions.S!, 1000).find((x) => x.run.id === 'l2')!
  assert.deepEqual(lone.workers, [], 'a run with only a lead')
  assert.ok(![r.lead, ...r.workers].some((x) => x.agent.role === 'explore' || x.agent.role === 'reviewer'))
})

test('monitor: durations count up while running and stop when the run is done', () => {
  const w = build()
  const runs = runViews(w.sessions.S!, 10_000)
  assert.equal(runs.find((r) => r.run.id === 'l2')!.durationMs, 10_000 - 300)
  const done = runs.find((r) => r.run.id === 'l1')!
  assert.equal(done.durationMs, done.run.lastActivityAt - 100)
  assert.ok(done.durationMs < 1000, 'does not keep growing')
})

test('monitor: other agents are the generic ones, with the run they work inside', () => {
  const w = build()
  const others = genericAgents(w.sessions.S!)
  assert.deepEqual(others.map((o) => [o.agent.id, o.viaRun]), [['g2', 2], ['g1', undefined]], 'tree order; g2 works inside the run that started second')
  assert.deepEqual(genericAgents(w.sessions.T!).map((o) => o.agent.id), ['tg'])
  assert.deepEqual(runViews(w.sessions.T!), [], 'a session without PStack has no runs')
})

test('monitor: current activity comes from the open tool, with waiting, delegating and finished cases', () => {
  const w = build()
  const s = w.sessions.S!
  assert.equal(agentCurrentActivity(s, s.agents.w0!).state, 'working')
  tool(w, 'S', 'w1', 'c1', 400, 'Edit src/pay.ts')
  tool(w, 'S', 'w1', 'c2', 410, '$ npm test', 'shell')
  const act = agentCurrentActivity(s, s.agents.w1!)
  assert.deepEqual([act.state, act.text, act.category], ['tool', '$ npm test', 'shell'], 'the latest open call')
  tool(w, 'S', 'l2', 'launch', 420, 'poteto-agent: do it', 'agent')
  agent(w, 'S', 'k', 'l2', 421, 'poteto-agent')
  assert.equal(agentCurrentActivity(s, s.agents.l2!).text, 'waiting for 1 agent')
  status(w, 'S', 'w0', 430, 'waiting')
  s.agents.w0!.statusReason = 'approve rm -rf'
  assert.deepEqual([agentCurrentActivity(s, s.agents.w0!).state, agentCurrentActivity(s, s.agents.w0!).text], ['waiting', 'approve rm -rf'])
  assert.equal(agentCurrentActivity(s, s.agents.w2!).state, 'finished')
})

test('monitor: project filtering narrows runs and the project list counts what is active', () => {
  const w = build()
  const gojo = filterWorld(w, '/work/gojo')
  assert.deepEqual(activeRuns(gojo, 1000).map((r) => r.run.id), ['l2', 'l0', 'l1'])
  const ark = filterWorld(w, '/work/ark')
  assert.deepEqual(activeRuns(ark, 1000).map((r) => r.run.id), ['u1'])
  assert.deepEqual(activeRuns(w, 1000).map((r) => r.run.id), ['l2', 'u1', 'l0', 'l1'], 'across projects: active first, newest first')
  const p = Object.fromEntries(listProjects(w).map((x) => [x.key, [x.activeAgents, x.runsRunning]]))
  assert.deepEqual(p['/work/ark'], [4, 1], 'two main agents, an explorer and a run lead')
  assert.deepEqual(p['/work/gojo'], [6, 2], 'finished agents do not count')
})

test('monitor: search text finds PStack, run numbers, tasks and definitions, and a plain session finds none', () => {
  const w = build()
  const text = sessionSearchText(w.sessions.S!)
  for (const needle of ['pstack run 2', 'pstack', 'fix flaky test', 'reviewer', 'poteto-agent']) assert.ok(text.includes(needle), needle)
  assert.ok(!sessionSearchText(w.sessions.T!).includes('pstack'))
})

test('monitor: the feed has tool calls and agents starting and finishing, newest first', () => {
  const w = build()
  tool(w, 'S', 'w2', 'c9', 500, 'Edit api.ts', 'edit', true)
  const feed = activityFeed(w, 200)
  assert.deepEqual(feed.map((f) => f.ts), [...feed.map((f) => f.ts)].sort((a, b) => b - a))
  assert.equal(feed[0]!.kind, 'tool')
  assert.equal(feed[0]!.workflow?.runIndex, 2, "w2 works in the run that started second")
  assert.ok(feed.some((f) => f.kind === 'finished' && f.agentId === 'w1a' && f.workflow?.tier === 'worker'))
  assert.ok(feed.some((f) => f.kind === 'started' && f.agentId === 'g1' && !f.workflow), 'generic agents are in the feed without a run')
  assert.equal(new Set(feed.map((f) => f.key)).size, feed.length, 'no duplicates')
  assert.equal(activityFeed(w, 3).length, 3)
})
