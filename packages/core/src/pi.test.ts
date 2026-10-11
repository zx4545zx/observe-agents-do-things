/**
 * Pi adapter tests against small synthetic sessions that mirror the real
 * on-disk shapes (docs/pi-adapter.md). No real user data lives in this repository.
 */
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { applyEvent, createWorld, workflowOf, workflowRuns, type EventDraft, type ObserverEvent } from '@oadt/protocol'
import { PiAdapter, PiSessionParser } from './adapters/pi.js'
import { Observer } from './observer.js'

const SID = '01a00000-0000-7000-8000-000000000001'
const FILE = `2026-01-01T12-00-00-000Z_${SID}.jsonl`
const iso = (s: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, s)).toISOString()
const usage = (input: number, output: number, cacheRead = 0, reasoning = 0) => ({
  input, output, cacheRead, cacheWrite: 0, reasoning, totalTokens: input + output + cacheRead,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
})
const entry = (id: string, s: number, message: object) => ({ type: 'message', id, parentId: null, timestamp: iso(s), message })
const assistant = (id: string, s: number, content: object[], stopReason: string, extra: object = {}) =>
  entry(id, s, { role: 'assistant', content, provider: 'test', model: 'pi-test-1', usage: usage(100, 10), stopReason, timestamp: s, ...extra })

function sessionLines(): object[] {
  return [
    { type: 'session', version: 3, id: SID, timestamp: iso(0), cwd: '/work/app' },
    { type: 'model_change', id: 'm1', parentId: null, timestamp: iso(0), provider: 'test', modelId: 'pi-test-1' },
    { type: 'thinking_level_change', id: 't1', parentId: 'm1', timestamp: iso(0), thinkingLevel: 'high' },
    entry('s1', 1, { role: 'system', content: '', sections: { preamble: 'You are...' }, timestamp: 1 }),
    entry('u1', 2, { role: 'user', content: [{ type: 'text', text: 'Why does test/api.test.ts fail?' }], timestamp: 2 }),
    assistant('a1', 3, [
      { type: 'thinking', thinking: 'Read the test first.', thinkingSignature: 'opaque' },
      { type: 'toolCall', id: 'call_read|fc_1', name: 'read', arguments: { path: 'test/api.test.ts', limit: 50 } },
    ], 'toolUse', { usage: usage(1000, 40, 500, 25) }),
    entry('r1', 4, { role: 'toolResult', toolCallId: 'call_read|fc_1', toolName: 'read', content: [{ type: 'text', text: 'file contents' }], isError: false, durationMs: 12, timestamp: 4 }),
    assistant('a2', 5, [
      { type: 'toolCall', id: 'call_edit', name: 'edit', arguments: { path: '/work/app/src/api.ts', edits: [{ oldText: 'sleep(10)', newText: 'sleep(100)' }] } },
      { type: 'toolCall', id: 'call_bash', name: 'bash', arguments: { command: 'npm test -- api\necho done', timeout: 60 } },
      { type: 'toolCall', id: 'call_custom', name: 'query-docs', arguments: { libraryId: '/x/y', query: 'timers' } },
    ], 'toolUse', { usage: usage(1200, 60, 500) }),
    entry('r2', 6, { role: 'toolResult', toolCallId: 'call_edit', toolName: 'edit', content: [{ type: 'text', text: 'Successfully replaced 1 block(s)' }], isError: false, timestamp: 6 }),
    entry('r3', 9, { role: 'toolResult', toolCallId: 'call_bash', toolName: 'bash', content: [{ type: 'text', text: '1 failing\n\nCommand exited with code 1' }], isError: true, timestamp: 9 }),
    entry('r4', 9, { role: 'toolResult', toolCallId: 'call_custom', toolName: 'query-docs', content: [{ type: 'text', text: 'docs' }], isError: false, usage: usage(5, 5), timestamp: 9 }),
    { type: 'custom', id: 'c1', parentId: 'r4', timestamp: iso(10), customType: 'some-extension', data: { anything: true } },
    { type: 'mystery', id: 'x1', parentId: 'c1', timestamp: iso(10), payload: {} },
    assistant('a3', 11, [{ type: 'text', text: 'The test sleeps for 10 ms; CI is slower.' }], 'stop', { usage: usage(1500, 30, 800) }),
    { type: 'compaction', id: 'k1', parentId: 'a3', timestamp: iso(12), summary: 's', firstKeptEntryId: 'a3', tokensBefore: 90000, usage: usage(7, 3) },
    entry('u2', 20, { role: 'user', content: 'again', timestamp: 20 }),
    assistant('a4', 21, [], 'error', { errorMessage: 'rate limited', usage: usage(0, 0) }),
    entry('u3', 30, { role: 'user', content: 'once more', timestamp: 30 }),
    assistant('a5', 31, [{ type: 'toolCall', id: 'call_stuck', name: 'bash', arguments: { command: 'sleep 999' } }], 'toolUse'),
    assistant('a6', 32, [{ type: 'thinking', thinking: '', thinkingSignature: 'enc', redacted: true }], 'aborted', { usage: usage(0, 0) }),
    { type: 'custom', id: 'g1', parentId: null, timestamp: iso(1), customType: 'pi-goal', data: { goal: { id: 'goal-1', objective: 'Ship the thing', status: 'active', tokensUsed: 0 } } },
    { type: 'custom', id: 'g2', parentId: null, timestamp: iso(5), customType: 'pi-goal', data: { goal: { id: 'goal-1', objective: 'Ship the thing', status: 'active', tokensUsed: 900 } } },
    { type: 'custom', id: 'g3', parentId: null, timestamp: iso(35), customType: 'pi-goal', data: { goal: { id: 'goal-1', objective: 'Ship the thing', status: 'complete', tokensUsed: 1200 } } },
    entry('b1', 40, { role: 'bashExecution', command: 'git status', output: 'clean', exitCode: 0, cancelled: false, truncated: false, timestamp: 40 }),
  ]
}

const jsonl = (lines: object[]) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n'

function parse(lines: object[]): EventDraft[] {
  const out: EventDraft[] = []
  const p = new PiSessionParser(`/x/sessions/--work-app--/${FILE}`, (d) => out.push(d))
  for (const l of lines) p.line(JSON.stringify(l))
  return out
}

function project(drafts: EventDraft[]) {
  const world = createWorld()
  drafts.forEach((d, i) => applyEvent(world, { ...d, seq: i + 1 } as ObserverEvent))
  return world
}

test('pi: normalises a session', () => {
  const drafts = parse(sessionLines())
  const find = <K extends EventDraft['kind']>(k: K) => drafts.filter((d): d is Extract<EventDraft, { kind: K }> => d.kind === k)

  assert.ok(drafts.every((d) => d.harness === 'pi' && d.sessionId === SID && d.agentId === SID))
  const started = find('session.started')
  assert.equal(started.length, 1)
  assert.deepEqual([started[0]!.meta.cwd, started[0]!.meta.project], ['/work/app', 'app'])

  assert.deepEqual(find('message').map((d) => [d.role, d.text]), [
    ['user', 'Why does test/api.test.ts fail?'],
    ['assistant', 'The test sleeps for 10 ms; CI is slower.'],
    ['user', 'again'],
    ['user', 'once more'],
  ])
  assert.deepEqual(find('thinking').map((d) => d.text), ['Read the test first.', undefined])

  assert.deepEqual(find('tool.started').map((d) => [d.callId, d.category, d.title]), [
    ['call_read|fc_1', 'read', 'Read test/api.test.ts'],
    ['call_edit', 'edit', 'Edit src/api.ts'],
    ['call_bash', 'shell', '$ npm test -- api …'],
    ['call_custom', 'other', 'query-docs'],
    ['call_stuck', 'shell', '$ sleep 999'],
    ['bash-b1', 'shell', '$ git status'],
  ])
  const edit = find('tool.started')[1]!
  assert.deepEqual(edit.files, [{ path: '/work/app/src/api.ts', op: 'edit' }])
  assert.deepEqual(edit.changes?.[0]?.lines, ['-sleep(10)', '+sleep(100)'])
  assert.deepEqual(find('tool.started')[0]!.files, [{ path: '/work/app/test/api.test.ts', op: 'read' }], 'relative paths resolve against the session cwd')

  const fin = find('tool.finished')
  assert.deepEqual(fin.map((d) => [d.callId, d.ok]), [
    ['call_read|fc_1', true], ['call_edit', true], ['call_bash', false], ['call_custom', true], ['call_stuck', false], ['bash-b1', true],
  ])
  assert.equal(fin[0]!.durationMs, 12)
  assert.equal(fin[4]!.output, 'interrupted', 'a call still open when the turn aborts is closed')

  assert.deepEqual(find('turn.ended').map((d) => d.outcome), ['completed', 'error', 'aborted'])
  assert.deepEqual(find('turn.started').map((d) => d.turnId), ['u1', 'u2', 'u3'])
  assert.deepEqual(find('note').map((d) => [d.level, d.text]), [
    ['info', 'Context compacted (90000 tokens summarized)'],
    ['warn', 'rate limited'],
  ])

  const metas = find('session.updated').map((d) => d.meta)
  assert.deepEqual(metas.map((m) => m.model).filter(Boolean), ['pi-test-1'], 'model is announced once')
  assert.ok(metas.some((m) => m.title === 'Why does test/api.test.ts fail?' && m.titleSource === 'prompt'))
  assert.deepEqual(metas.filter((m) => m.goal).map((m) => [m.goal, m.goalStatus]), [['Ship the thing', 'active'], ['Ship the thing', 'complete']], 'a goal is reported when it or its status changes, not on every token update')

  const u = find('usage')
  assert.deepEqual(u[0]!.delta, { input: 1000, output: 40, cacheRead: 500, cacheWrite: 0, reasoning: 25 })
  assert.equal(u[0]!.contextTokens, 1500)
  assert.equal(u[0]!.contextWindow, undefined, 'the window is not in the transcript, so it is not invented')
  assert.equal(u.reduce((n, d) => n + d.delta.output, 0), 40 + 60 + 5 + 30 + 3 + 10, 'assistant, nested tool and compaction usage count; all-zero messages add nothing')
})

test('pi: projects to the shared world state', () => {
  const s = project(parse(sessionLines())).sessions[SID]!
  assert.equal(s.harness, 'pi')
  assert.equal(s.meta.model, 'pi-test-1')
  assert.equal(s.meta.cwd, '/work/app')
  assert.equal(s.counts.tools, 6)
  assert.equal(s.contextTokens, 100, 'context fill follows the latest assistant message with usage')
  assert.equal(s.status, 'working', 'the stuck call and the later bash run keep it from idling')
  assert.equal(s.tools.call_bash!.ok, false)
})

test('pi: sessions with a custom name, unknown records and junk lines', () => {
  const out: EventDraft[] = []
  const p = new PiSessionParser(`/x/${FILE}`, (d) => out.push(d))
  p.line('not json')
  p.line('[1,2]')
  p.line(JSON.stringify({ type: 'message', id: 'z', message: 'oops' }))
  p.line(JSON.stringify({ type: 'message', id: 'z', message: { role: 'toolResult', toolCallId: 'never-started', content: 'x' } }))
  p.line(JSON.stringify({ type: 'session_info', id: 'n', timestamp: iso(1), name: 'Refactor auth' }))
  p.line(JSON.stringify(entry('u', 2, { role: 'user', content: 'hello', timestamp: 2 })))
  assert.equal(p.sessionId, SID, 'id falls back to the file name when the header was not read')
  const titles = out.filter((d) => d.kind === 'session.updated').map((d) => d.kind === 'session.updated' && d.meta.title)
  assert.deepEqual(titles, ['Refactor auth'], 'a user-set name is not overridden by the first prompt')
  assert.deepEqual(out.map((d) => d.kind), ['session.updated', 'turn.started', 'message'])
})

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'oadt-pi-'))
  mkdirSync(join(root, 'sessions', '--work-app--'), { recursive: true })
  mkdirSync(join(root, 'sessions', '--work-other--', 'subagents'), { recursive: true })
  return root
}

test('pi: discovery finds sessions across projects and ignores other files', async () => {
  const root = makeRoot()
  const a = join(root, 'sessions', '--work-app--', FILE)
  const b = join(root, 'sessions', '--work-app--', `2026-01-01T13-00-00-000Z_other.jsonl`)
  const sub = join(root, 'sessions', '--work-other--', 'subagents', `2026-01-01T14-00-00-000Z_sub.jsonl`)
  for (const f of [a, b, sub]) writeFileSync(f, jsonl(sessionLines().slice(0, 1)))
  writeFileSync(join(root, 'sessions', '--work-app--', 'notes.jsonl'), '{}\n')
  writeFileSync(join(root, 'sessions', '--work-app--', 'readme.md'), 'x')
  writeFileSync(join(root, 'settings.json'), '{}')

  const adapter = new PiAdapter({ piDir: root })
  assert.deepEqual((await adapter.discover(0)).sort(), [a, b, sub].sort())
  assert.deepEqual(await adapter.discover(Date.now() + 60_000), [], 'files older than the window are skipped')
  assert.ok(adapter.accepts(a) && adapter.accepts(sub))
  assert.ok(!adapter.accepts(join(root, 'sessions', '--work-app--', 'notes.jsonl')))
  assert.ok(!adapter.accepts(join(root, 'elsewhere', FILE)))
})

test('pi: a missing Pi directory is not an error', async () => {
  const obs = new Observer({ harnesses: ['pi'], piDir: join(tmpdir(), 'oadt-no-such-pi'), sinceMs: 1e12 })
  await obs.start()
  obs.stop()
  assert.deepEqual(Object.keys(obs.world.sessions), [])
})

test('pi: root resolution honours options, environment and ~', () => {
  const saved = { dir: process.env.PI_CODING_AGENT_DIR, sess: process.env.PI_CODING_AGENT_SESSION_DIR }
  try {
    delete process.env.PI_CODING_AGENT_DIR
    delete process.env.PI_CODING_AGENT_SESSION_DIR
    assert.equal(new PiAdapter().sessionsDir, join(homedir(), '.pi', 'agent', 'sessions'))
    assert.equal(new PiAdapter({ piDir: '~/custom-pi' }).sessionsDir, join(homedir(), 'custom-pi', 'sessions'))
    process.env.PI_CODING_AGENT_DIR = '/env/pi'
    assert.equal(new PiAdapter().sessionsDir, '/env/pi/sessions')
    process.env.PI_CODING_AGENT_SESSION_DIR = '~/moved'
    assert.equal(new PiAdapter().sessionsDir, join(homedir(), 'moved'))
    assert.equal(new PiAdapter({ piDir: '/explicit' }).sessionsDir, '/explicit/sessions')
  } finally {
    for (const [k, v] of [['PI_CODING_AGENT_DIR', saved.dir], ['PI_CODING_AGENT_SESSION_DIR', saved.sess]] as const) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
})

test('pi: live tailing emits each record once, waits out a half-written line, and a restart rebuilds the same state', async () => {
  const root = makeRoot()
  const file = join(root, 'sessions', '--work-app--', FILE)
  const lines = sessionLines()
  writeFileSync(file, jsonl(lines.slice(0, 7)))

  const obs = new Observer({ harnesses: ['pi'], piDir: root, sinceMs: 1e12 })
  const seen: ObserverEvent[] = []
  obs.subscribe((e) => seen.push(e))
  await obs.start()
  const countKind = (k: string) => seen.filter((e) => e.kind === k).length
  assert.equal(countKind('session.started'), 1)
  assert.equal(countKind('tool.started'), 1)

  // The next record is written in two pieces; the first must not be parsed.
  const next = JSON.stringify(lines[7])
  appendFileSync(file, next.slice(0, 40))
  await new Promise((r) => setTimeout(r, 1700))
  assert.equal(countKind('tool.started'), 1, 'half a line produces nothing')
  appendFileSync(file, next.slice(40) + '\n' + jsonl(lines.slice(8, 14)))
  const deadline = Date.now() + 5000
  while (countKind('message') < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
  obs.stop()

  assert.equal(countKind('session.started'), 1, 'existing events are not replayed')
  assert.equal(countKind('tool.started'), 4)
  assert.equal(countKind('tool.finished'), 4)
  assert.equal(countKind('turn.ended'), 1)
  const live = obs.world.sessions[SID]!
  assert.equal(live.status, 'idle')

  const again = new Observer({ harnesses: ['pi'], piDir: root, sinceMs: 1e12 })
  await again.start()
  again.stop()
  const rebuilt = again.world.sessions[SID]!
  assert.deepEqual(
    [rebuilt.status, rebuilt.counts, rebuilt.usage, rebuilt.meta.model, rebuilt.meta.title],
    [live.status, live.counts, live.usage, live.meta.model, live.meta.title],
    'restart reconstructs the same state',
  )
})

// ─── Subagents ────────────────────────────────────────────────────────────

const BASE = Date.UTC(2026, 0, 1, 12, 0, 0)
const at = (ms: number) => new Date(BASE + ms).toISOString()
const stamp = (ms: number) => at(ms).replace(/[:.]/g, '-')
const PARENT = '01a00000-0000-7000-8000-0000000000a0'
const kid = (n: number) => `01a00000-0000-7000-8000-0000000000b${n}`
const TASK = 'Review the diff and report findings.'

interface Dir { root: string; sessions: string }

function newDir(): Dir {
  const root = mkdtempSync(join(tmpdir(), 'oadt-pi-sub-'))
  const sessions = join(root, 'sessions', '--work-app--')
  mkdirSync(join(sessions, 'subagents'), { recursive: true })
  return { root, sessions }
}

function put(dir: Dir, id: string, startMs: number, lines: object[], opts: { sub?: boolean; header?: object } = {}): string {
  const header = { type: 'session', version: 3, id, timestamp: at(startMs), cwd: '/work/app', ...opts.header }
  const path = join(opts.sub ? join(dir.sessions, 'subagents') : dir.sessions, `${stamp(startMs)}_${id}.jsonl`)
  writeFileSync(path, jsonl([header, ...lines]))
  return path
}

const msg = (id: string, ms: number, message: object) => ({ type: 'message', id, parentId: null, timestamp: at(ms), message })
const asst = (id: string, ms: number, content: object[], stopReason: string, u = usage(10, 5)) =>
  msg(id, ms, { role: 'assistant', content, provider: 'test', model: 'pi-test-1', usage: u, stopReason, timestamp: BASE + ms })
const user = (id: string, ms: number, text: string) => msg(id, ms, { role: 'user', content: [{ type: 'text', text }], timestamp: BASE + ms })
const launch = (callId: string, ms: number, task: string, agent = 'reviewer') =>
  asst(`c-${callId}`, ms, [{ type: 'toolCall', id: callId, name: 'subagent', arguments: { agent, task } }], 'toolUse')
const launched = (callId: string, ms: number, startedAt: number | string | undefined, status = 'done') =>
  msg(`r-${callId}`, ms, { role: 'toolResult', toolCallId: callId, toolName: 'subagent', content: [{ type: 'text', text: 'RESULT' }], details: { agent: 'reviewer', status, output: 'RESULT', startedAt, elapsedMs: 100 }, isError: status !== 'done', timestamp: BASE + ms })
const system = msg('sys', 0, { role: 'system', content: '', sections: {}, timestamp: BASE })

/** What a launched child writes: its header just after `startedAt`, then `Task: ...`, some work, a final answer. */
function childLines(startMs: number, task: string): object[] {
  return [
    system,
    user('cu', startMs + 60, `Task: ${task}`),
    asst('ca1', startMs + 100, [{ type: 'toolCall', id: 'k-read', name: 'read', arguments: { path: 'a.ts' } }], 'toolUse', usage(100, 7)),
    msg('cr1', startMs + 120, { role: 'toolResult', toolCallId: 'k-read', toolName: 'read', content: [{ type: 'text', text: 'x' }], isError: false, timestamp: BASE + startMs + 120 }),
    asst('ca2', startMs + 200, [{ type: 'text', text: 'RESULT' }], 'stop', usage(120, 9)),
  ]
}

function parentWithChild(dir: Dir, opts: { task?: string; childStart?: number } = {}): void {
  const task = opts.task ?? TASK
  const childStart = opts.childStart ?? 5040
  put(dir, PARENT, 0, [
    system, user('u', 10, 'please review'),
    launch('call_sub', 5000, task),
    launched('call_sub', 6000, BASE + 5000 + 10, 'done'),
    asst('pa', 6100, [{ type: 'text', text: 'done' }], 'stop'),
  ])
  put(dir, kid(1), childStart, childLines(childStart, task), { sub: true })
}

async function observe(dir: Dir) {
  const obs = new Observer({ harnesses: ['pi'], piDir: dir.root, sinceMs: 1e12 })
  await obs.start()
  obs.stop()
  return obs.world
}

test('pi subagents: a launched child joins its launcher as an agent of the same session', async () => {
  const dir = newDir()
  parentWithChild(dir)
  const world = await observe(dir)
  assert.deepEqual(Object.keys(world.sessions), [PARENT], 'the child is not a session of its own')
  const s = world.sessions[PARENT]!
  const child = s.agents[kid(1)]!
  assert.equal(child.parentId, PARENT)
  assert.equal(child.role, 'reviewer')
  assert.equal(child.task, TASK)
  assert.equal(s.tools.call_sub!.childAgentId, kid(1), 'tied to the spawning tool call')
  assert.equal(s.tools.call_sub!.category, 'agent')
  assert.equal(child.status, 'done')
  assert.equal(child.toolCount, 1, 'its own tool call is attributed to it, not the parent')
  assert.equal(child.usage.output, 7 + 9)
  assert.equal(s.agents[PARENT]!.toolCount, 1)
  assert.equal(s.meta.title, 'please review', 'the child does not rewrite the session title')
  assert.equal(s.counts.userMessages, 1)
})

test('pi subagents: several children, and a child that launches its own', async () => {
  const dir = newDir()
  put(dir, PARENT, 0, [
    system, user('u', 10, 'go'),
    asst('c1', 1000, [
      { type: 'toolCall', id: 'call_a', name: 'subagent', arguments: { agent: 'explore', task: 'task A' } },
      { type: 'toolCall', id: 'call_b', name: 'subagent', arguments: { agent: 'worker', task: 'task B' } },
    ], 'toolUse'),
    launched('call_a', 9000, BASE + 1000, 'done'),
    launched('call_b', 9100, BASE + 1005, 'done'),
  ])
  put(dir, kid(1), 1040, childLines(1040, 'task A'), { sub: true })
  put(dir, kid(2), 1050, [
    system, user('cu', 1110, 'Task: task B'),
    asst('g1', 1200, [{ type: 'toolCall', id: 'call_g', name: 'subagent', arguments: { agent: 'explore', task: 'grandchild task' } }], 'toolUse'),
    launched('call_g', 4000, BASE + 1300, 'done'),
    asst('g2', 4100, [{ type: 'text', text: 'ok' }], 'stop'),
  ], { sub: true })
  put(dir, kid(3), 1340, childLines(1340, 'grandchild task'), { sub: true })

  const s = (await observe(dir)).sessions[PARENT]!
  assert.deepEqual(Object.keys(await observe(dir).then((w) => w.sessions)), [PARENT])
  assert.equal(s.agents[kid(1)]!.parentId, PARENT)
  assert.equal(s.agents[kid(2)]!.parentId, PARENT)
  assert.equal(s.agents[kid(3)]!.parentId, kid(2), 'nesting follows the launching agent')
  assert.equal(s.agents[kid(1)]!.role, 'explore')
  assert.equal(s.agents[kid(2)]!.role, 'worker')
})

test('pi subagents: a launch made inside codemode links through nestedCalls', async () => {
  const dir = newDir()
  put(dir, PARENT, 0, [
    system, user('u', 10, 'go'),
    asst('c1', 1000, [{ type: 'toolCall', id: 'call_code', name: 'codemode', arguments: { code: 'await tools.subagent(...)' } }], 'toolUse'),
    msg('rc', 9000, {
      role: 'toolResult', toolCallId: 'call_code', toolName: 'codemode', content: [{ type: 'text', text: 'done' }], isError: false, timestamp: BASE + 9000,
      nestedCalls: { complete: true, calls: [{ id: 'call_code/1', name: 'subagent', status: 'ok', arguments: { agent: 'reviewer', task: TASK } }, 'junk', { name: 'subagent', arguments: 'not an object' }] },
    }),
  ])
  put(dir, kid(1), 1040, childLines(1040, TASK), { sub: true })
  const s = (await observe(dir)).sessions[PARENT]!
  const child = s.agents[kid(1)]!
  assert.equal(child.parentId, PARENT)
  assert.equal(child.parentToolCallId, undefined, 'the nested call has no tool.started to point at')
  assert.equal(s.tools.call_code!.childAgentId, undefined)
})

test('pi subagents: a fork child does not replay the history it copied, and must agree with parentSession', async () => {
  const dir = newDir()
  const parentPath = put(dir, PARENT, 0, [
    system, user('u', 10, 'please review'),
    launch('call_sub', 5000, TASK),
    launched('call_sub', 6000, BASE + 5000 + 10),
  ])
  const copied = [user('u', 10, 'please review'), launch('call_sub', 5000, TASK)]
  put(dir, kid(1), 5040, [...copied, ...childLines(5040, TASK).slice(1)], { sub: true, header: { parentSession: parentPath } })
  const s = (await observe(dir)).sessions[PARENT]!
  assert.equal(s.agents[kid(1)]!.parentId, PARENT)
  assert.equal(s.counts.tools, 2, 'the parent call and the child read; the copied launch is not counted again')
  assert.equal(s.counts.userMessages, 1)

  const other = newDir()
  parentWithChild(other)
  put(other, kid(2), 5030, childLines(5030, TASK), { sub: true, header: { parentSession: join(other.sessions, `${stamp(0)}_somebody-else.jsonl`) } })
  const w = await observe(other)
  assert.ok(w.sessions[kid(2)], 'a child forked from a different session than the launcher stays standalone')
  assert.equal(w.sessions[PARENT]!.agents[kid(1)]!.parentId, PARENT)
})

test('pi subagents: no match, wrong time, ambiguous or malformed launches leave the child a normal session', async () => {
  const none = newDir()
  put(none, kid(1), 40, childLines(40, 'nobody asked for this'), { sub: true })
  assert.ok((await observe(none)).sessions[kid(1)], 'unknown parent')

  const late = newDir()
  parentWithChild(late, { childStart: 5000 + 10 + 30_000 })
  assert.ok((await observe(late)).sessions[kid(1)], 'started long after the recorded start time')

  const twice = newDir()
  put(twice, PARENT, 0, [
    system, user('u', 10, 'go'),
    asst('c1', 1000, [
      { type: 'toolCall', id: 'call_a', name: 'subagent', arguments: { agent: 'reviewer', task: TASK } },
      { type: 'toolCall', id: 'call_b', name: 'subagent', arguments: { agent: 'reviewer', task: TASK } },
    ], 'toolUse'),
  ])
  put(twice, kid(1), 1040, childLines(1040, TASK), { sub: true })
  const w = await observe(twice)
  assert.ok(w.sessions[kid(1)], 'two identical launches that cannot be told apart are not guessed')
  assert.equal(Object.keys(w.sessions[PARENT]!.agents).length, 1)

  const bad = newDir()
  put(bad, PARENT, 0, [
    system, user('u', 10, 'go'),
    launch('call_sub', 5000, TASK),
    launched('call_sub', 6000, 'yesterday'),
    { type: 'message', id: 'weird', message: { role: 'toolResult', toolCallId: 'call_sub', nestedCalls: 7, details: [1] } },
  ])
  put(bad, kid(1), 5040, childLines(5040, TASK), { sub: true })
  const linked = (await observe(bad)).sessions[PARENT]!
  assert.equal(linked.agents[kid(1)]!.parentId, PARENT, 'a launch without a usable start time still matches on its recorded window')
})

test('pi subagents: the launcher is read first even when the child file is older on disk, and restarts agree', async () => {
  const dir = newDir()
  put(dir, kid(1), 5040, childLines(5040, TASK), { sub: true })
  await new Promise((r) => setTimeout(r, 20))
  parentWithChild(dir)
  const first = await observe(dir)
  const again = await observe(dir)
  for (const w of [first, again]) {
    assert.deepEqual(Object.keys(w.sessions), [PARENT])
    assert.deepEqual(Object.keys(w.sessions[PARENT]!.agents).sort(), [PARENT, kid(1)].sort())
  }
  assert.deepEqual(again.sessions[PARENT]!.counts, first.sessions[PARENT]!.counts)
  assert.deepEqual(again.sessions[PARENT]!.usage, first.sessions[PARENT]!.usage)
})

test('pi subagents: a child that appears while the observer runs joins its launcher', async () => {
  const dir = newDir()
  put(dir, PARENT, 0, [system, user('u', 10, 'go'), launch('call_sub', 5000, TASK)])
  const obs = new Observer({ harnesses: ['pi'], piDir: dir.root, sinceMs: 1e12 })
  await obs.start()
  assert.deepEqual(Object.keys(obs.world.sessions), [PARENT])
  put(dir, kid(1), 5040, childLines(5040, TASK), { sub: true })
  const deadline = Date.now() + 8000
  while (!obs.world.sessions[PARENT]!.agents[kid(1)] && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
  obs.stop()
  const s = obs.world.sessions[PARENT]!
  assert.equal(s.agents[kid(1)]?.parentId, PARENT)
  assert.equal(s.tools.call_sub!.childAgentId, kid(1))
  assert.deepEqual(Object.keys(obs.world.sessions), [PARENT])
})

test('pi subagents: launches in the skipped middle of a large launcher file still link', async () => {
  const dir = newDir()
  const pad = (n: number, from: number): object[] =>
    Array.from({ length: n }, (_, i) => ({ type: 'custom', id: `pad${from + i}`, parentId: null, timestamp: at(100 + from + i), customType: 'filler', data: { text: 'x'.repeat(1000) } }))
  put(dir, PARENT, 0, [
    system, user('u', 10, 'go'),
    ...pad(600, 0),
    launch('call_sub', 5000, TASK),
    launched('call_sub', 6000, BASE + 5000 + 10),
    ...pad(8, 1000),
  ])
  put(dir, kid(1), 5040, childLines(5040, TASK), { sub: true })
  const obs = new Observer({ harnesses: ['pi'], piDir: dir.root, sinceMs: 1e12, backfillBytes: 2000 })
  await obs.start()
  obs.stop()
  assert.equal(obs.world.sessions[PARENT]!.meta.partialHistory, true, 'the launcher really was read in part')
  assert.equal(obs.world.sessions[PARENT]!.tools.call_sub, undefined, 'and the launch itself was in the skipped part')
  assert.deepEqual(Object.keys(obs.world.sessions), [PARENT])
  assert.equal(obs.world.sessions[PARENT]!.agents[kid(1)]?.parentId, PARENT)
})

test('pi subagents: PStack workers get workflow metadata and ordinary subagents do not', async () => {
  const dir = newDir()
  put(dir, PARENT, 0, [
    system, user('u', 10, 'go'),
    launch('call_p1', 1000, 'task one', 'poteto-agent'),
    launch('call_p2', 2000, 'task two', 'poteto-agent'),
    launch('call_r', 3000, 'task three', 'reviewer'),
    launched('call_p1', 9000, BASE + 1000 + 10),
    launched('call_p2', 9100, BASE + 2000 + 10),
    launched('call_r', 9200, BASE + 3000 + 10),
  ])
  put(dir, kid(1), 1040, childLines(1040, 'task one'), { sub: true })
  put(dir, kid(2), 2040, [
    system, user('cu', 2100, 'Task: task two'),
    asst('g1', 2200, [{ type: 'toolCall', id: 'call_n', name: 'subagent', arguments: { agent: 'poteto-agent', task: 'nested task' } }], 'toolUse'),
    launched('call_n', 4000, BASE + 2300),
  ], { sub: true })
  put(dir, kid(3), 2290, childLines(2290, 'nested task'), { sub: true })
  put(dir, kid(4), 3040, childLines(3040, 'task three'), { sub: true })

  const s = (await observe(dir)).sessions[PARENT]!
  assert.deepEqual([kid(1), kid(2), kid(3), kid(4)].map((id) => s.agents[id]!.role), ['poteto-agent', 'poteto-agent', 'poteto-agent', 'reviewer'])
  assert.deepEqual([PARENT, kid(1), kid(2), kid(3), kid(4)].map((id) => workflowOf(s, id)?.runId), [undefined, kid(1), kid(2), kid(2), undefined])
  assert.equal(workflowOf(s, kid(3))!.tier, 'worker')
  assert.equal(s.agents[kid(3)]!.parentId, kid(2), 'the tree is the one the adapter built')
  assert.equal(s.agents[kid(1)]!.parentToolCallId, 'call_p1')
  assert.deepEqual(workflowRuns(s).map((r) => [r.index, r.agentIds.length, r.status]), [[1, 1, 'done'], [2, 2, 'done']])
})
