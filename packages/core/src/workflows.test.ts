import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyEvent, createWorld, workflowIndex, workflowLabels, workflowOf, workflowRuns, type AgentStatus, type EventDraft, type ObserverEvent, type WorldState } from '@oadt/protocol'

const SID = 'sess'
let seq = 0
const send = (w: WorldState, d: EventDraft) => applyEvent(w, { ...d, seq: ++seq } as ObserverEvent)
const base = { harness: 'pi', sessionId: SID }

function spawn(w: WorldState, id: string, parent: string, ts: number, role?: string, task = `task of ${id}`, parentToolCallId?: string): void {
  send(w, { ...base, ts, agentId: id, kind: 'agent.spawned', parentAgentId: parent, parentToolCallId, name: role ?? id, role, task })
}

function status(w: WorldState, id: string, ts: number, s: AgentStatus): void {
  send(w, { ...base, ts, agentId: id, kind: 'agent.status', status: s })
}

function world(): WorldState {
  const w = createWorld()
  send(w, { ...base, ts: 1, agentId: SID, kind: 'session.started', meta: { cwd: '/work/app' } })
  return w
}

const ids = (xs: Array<{ id: string }>) => xs.map((x) => x.id)

test('workflows: only agents the harness named as PStack workers are classified', () => {
  const w = world()
  spawn(w, 'g1', SID, 10, 'reviewer')
  spawn(w, 'g2', SID, 11, 'explore')
  spawn(w, 'g3', SID, 12, undefined)
  spawn(w, 'g4', SID, 13, 'architect', 'Review the poteto-mode skill and the PStack playbook')
  spawn(w, 'g5', SID, 14, 'poteto-agent-fast')
  spawn(w, 'p1', SID, 15, 'poteto-agent', 'Do the thing')
  spawn(w, 'p2', SID, 16, 'pstack:poteto-agent-xhigh')
  const s = w.sessions[SID]!
  for (const id of ['g1', 'g2', 'g3', 'g4', 'g5', SID]) assert.equal(workflowOf(s, id), undefined, `${id} stays generic`)
  assert.deepEqual(['p1', 'p2'].map((id) => workflowOf(s, id)?.kind), ['pstack', 'pstack'])
  assert.deepEqual(workflowLabels(s), ['PStack'])
  assert.deepEqual(workflowLabels(world().sessions[SID]!), [])
})

test('workflows: agents group by run, runs by who launched them, and nothing unrelated joins', () => {
  const w = world()
  spawn(w, 'lead1', SID, 10, 'poteto-agent', 'Execute the approved task', 'call_1')
  spawn(w, 'w1', 'lead1', 20, 'poteto-agent')
  spawn(w, 'w2', 'lead1', 21, 'poteto-agent')
  spawn(w, 'w1a', 'w1', 30, 'poteto-agent')
  spawn(w, 'helper', 'w2', 31, 'explore')
  spawn(w, 'inner', 'helper', 32, 'poteto-agent')
  spawn(w, 'lead2', SID, 100, 'poteto-agent', 'Continue', 'call_2')
  spawn(w, 'w3', 'lead2', 110, 'poteto-agent')
  spawn(w, 'stranger', SID, 50, 'reviewer')
  spawn(w, 'stranger-kid', 'stranger', 51, 'poteto-agent')
  const s = w.sessions[SID]!
  const wf = (id: string) => workflowOf(s, id)!

  assert.deepEqual(['lead1', 'w1', 'w2', 'w1a', 'inner'].map((id) => wf(id).runId), Array(5).fill('lead1'))
  assert.deepEqual(['lead2', 'w3'].map((id) => wf(id).runId), ['lead2', 'lead2'])
  assert.deepEqual(['lead1', 'lead2', 'stranger-kid'].map((id) => wf(id).runIndex), [1, 3, 2], 'runs are numbered by start time')
  assert.deepEqual(['lead1', 'w1', 'w1a', 'inner'].map((id) => [wf(id).tier, wf(id).depth]), [['lead', 0], ['worker', 1], ['worker', 2], ['worker', 2]], 'depth counts workflow agents above, not generic ones in between')
  assert.equal(wf('stranger-kid').runId, 'stranger-kid', 'launched by a generic agent: a run of its own, not part of another')
  assert.equal(wf('stranger-kid').hostAgentId, 'stranger')
  assert.equal(wf('lead1').hostAgentId, SID)
  assert.equal(workflowOf(s, 'helper'), undefined, 'a generic helper inside a run stays generic')

  const runs = workflowRuns(s)
  assert.deepEqual(runs.map((r) => [r.id, r.agentIds]), [
    ['lead1', ['lead1', 'w1', 'w2', 'w1a', 'inner']],
    ['stranger-kid', ['stranger-kid']],
    ['lead2', ['lead2', 'w3']],
  ])
  assert.equal(runs[0]!.task, 'Execute the approved task')
})

test('workflows: run status follows the agents, and enrichment leaves the tree alone', () => {
  const w = world()
  spawn(w, 'lead', SID, 10, 'poteto-agent', 'Execute', 'call_1')
  spawn(w, 'w1', 'lead', 20, 'poteto-agent')
  send(w, { ...base, ts: 21, agentId: 'w1', kind: 'tool.started', callId: 'x', tool: 'bash', category: 'shell', title: '$ ls' })
  const before = JSON.stringify(w)
  const s = w.sessions[SID]!
  assert.equal(workflowRuns(s)[0]!.status, 'running')
  assert.equal(JSON.stringify(w), before, 'reading enrichment never changes state')
  assert.equal(s.agents.lead!.parentToolCallId, 'call_1', 'the parent tool call is preserved')
  assert.deepEqual(s.agents.lead!.children, ['w1'])

  status(w, 'w1', 30, 'waiting')
  assert.equal(workflowRuns(s)[0]!.status, 'waiting')
  status(w, 'w1', 40, 'done')
  status(w, 'lead', 41, 'done')
  assert.equal(workflowRuns(s)[0]!.status, 'done')
})

test('workflows: rebuilding from the same events, in any batching, gives the same answer', () => {
  const events: EventDraft[] = []
  const drafts: EventDraft[] = [
    { ...base, ts: 1, agentId: SID, kind: 'session.started', meta: {} },
    { ...base, ts: 10, agentId: 'a', kind: 'agent.spawned', parentAgentId: SID, name: 'a', role: 'poteto-agent', task: 't' },
    { ...base, ts: 11, agentId: 'b', kind: 'agent.spawned', parentAgentId: 'a', name: 'b', role: 'poteto-agent' },
    { ...base, ts: 12, agentId: 'c', kind: 'agent.spawned', parentAgentId: SID, name: 'c', role: 'poteto-agent' },
  ]
  events.push(...drafts)
  const build = (list: EventDraft[]) => {
    const w = createWorld()
    list.forEach((d, i) => applyEvent(w, { ...d, seq: i + 1 } as ObserverEvent))
    const idx = workflowIndex(w.sessions[SID]!)
    return JSON.stringify({ agents: [...idx.byAgent.entries()].sort(), runs: idx.runs })
  }
  assert.equal(build(events), build(events))
  assert.equal(build(events), build([...events.slice(0, 2), ...events.slice(2)]))
  const parentLast = [events[0]!, events[2]!, events[3]!, events[1]!]
  assert.equal(workflowIndex(parentLast.reduce((w, d, i) => applyEvent(w, { ...d, seq: i + 1 } as ObserverEvent), createWorld()).sessions[SID]!).runs.map((r) => r.agentIds.length).sort().join(), '1,2', 'a child announced before its parent still lands in the parent run once the tree is complete')
})

test('workflows: sessions of other harnesses are classified the same way', () => {
  const w = createWorld()
  send(w, { harness: 'claude-code', sessionId: 'cc', ts: 1, agentId: 'cc', kind: 'session.started', meta: {} })
  send(w, { harness: 'claude-code', sessionId: 'cc', ts: 2, agentId: 'sub', kind: 'agent.spawned', parentAgentId: 'cc', name: 'x', role: 'pstack:poteto-agent' })
  assert.equal(workflowOf(w.sessions.cc!, 'sub')?.kind, 'pstack')
  assert.deepEqual(ids(workflowRuns(w.sessions.cc!)), ['sub'])
})
