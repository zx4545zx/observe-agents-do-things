import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyEvent, createWorld, filterWorld, listProjects, projectKey, resolveProject, UNKNOWN_PROJECT, type EventDraft, type ObserverEvent, type WorldState } from '@oadt/protocol'

let seq = 0
function add(world: WorldState, harness: string, id: string, cwd: string | undefined, extra: EventDraft[] = []): void {
  const drafts: EventDraft[] = [
    { ts: 1000, harness, sessionId: id, agentId: id, kind: 'session.started', meta: { cwd } },
    { ts: 1001, harness, sessionId: id, agentId: id, kind: 'tool.started', callId: `${id}-t`, tool: 'edit', category: 'edit', title: `Edit ${id}.ts`, files: [{ path: `/x/${id}.ts`, op: 'edit' }] },
    { ts: 1002, harness, sessionId: id, agentId: id, kind: 'tool.finished', callId: `${id}-t`, ok: true },
    ...extra,
  ]
  for (const d of drafts) applyEvent(world, { ...d, seq: ++seq } as ObserverEvent)
}

function world(): WorldState {
  const w = createWorld()
  add(w, 'claude-code', 'c1', '/work/gojo')
  add(w, 'codex', 'x1', '/work/gojo/')
  add(w, 'pi', 'p1', '/work/gojo')
  add(w, 'pi', 'p2', '/work/gojo', [{ ts: 1100, harness: 'pi', sessionId: 'p2', agentId: 'p2-sub', kind: 'agent.spawned', name: 'worker', parentAgentId: 'p2' }])
  add(w, 'pi', 'p3', '/work/ark-postgres')
  add(w, 'claude-code', 'c2', 'C:\\Work\\Bunny')
  add(w, 'codex', 'x2', undefined)
  add(w, 'pi', 'p4', '   ')
  return w
}

test('projects: sessions of every harness group by working directory', () => {
  const projects = listProjects(world())
  assert.deepEqual(projects.map((p) => [p.label, p.sessions, [...p.harnesses].sort()]), [
    ['ark-postgres', 1, ['pi']],
    ['Bunny', 1, ['claude-code']],
    ['gojo', 4, ['claude-code', 'codex', 'pi']],
    ['Unknown Project', 2, ['codex', 'pi']],
  ])
  assert.equal(projects.at(-1)!.key, UNKNOWN_PROJECT, 'sessions without a cwd are grouped, never guessed')
  assert.equal(projects[1]!.key, 'c:/work/bunny', 'Windows paths compare without case or separator differences')
})

test('projects: filtering keeps one project and everything inside its sessions', () => {
  const w = world()
  const gojo = filterWorld(w, '/work/gojo')
  assert.deepEqual(Object.keys(gojo.sessions).sort(), ['c1', 'p1', 'p2', 'x1'])
  assert.equal(Object.keys(gojo.sessions.p2!.agents).length, 2, 'agents come along with their session')
  assert.deepEqual(Object.values(gojo.sessions).flatMap((s) => Object.keys(s.tools)).sort(), ['c1-t', 'p1-t', 'p2-t', 'x1-t'])
  assert.equal(filterWorld(w, '/work/ark-postgres').sessions.p3!.id, 'p3')
  assert.deepEqual(Object.keys(filterWorld(w, UNKNOWN_PROJECT).sessions).sort(), ['p4', 'x2'])
  assert.equal(filterWorld(w, ''), w, 'All Projects is the world itself')
  assert.deepEqual(Object.keys(w.sessions).length, 8, 'filtering does not change the world')
  assert.deepEqual(Object.keys(filterWorld(w, '/nowhere').sessions), [])
})

test('projects: a remembered choice that no longer exists shows everything, and returns when the project does', () => {
  const w = world()
  assert.equal(resolveProject(w, '/work/gojo'), '/work/gojo')
  assert.equal(resolveProject(w, ''), '')
  assert.equal(resolveProject(w, '/work/deleted'), '')
  assert.equal(resolveProject(w, '/work/new-app'), '', 'not there yet')
  add(w, 'pi', 'p9', '/work/new-app')
  assert.equal(resolveProject(w, '/work/new-app'), '/work/new-app', 'a project that appears while running becomes selectable')
  assert.ok(listProjects(w).some((p) => p.key === '/work/new-app'))
})

test('projects: same folder name in two places stays two projects with distinguishable labels', () => {
  const w = createWorld()
  add(w, 'pi', 'a', '/home/me/work/app')
  add(w, 'pi', 'b', '/home/me/play/app')
  add(w, 'pi', 'c', '/home/me/work/other')
  const labels = Object.fromEntries(listProjects(w).map((p) => [p.key, p.label]))
  assert.deepEqual(labels, { '/home/me/play/app': 'play/app', '/home/me/work/app': 'work/app', '/home/me/work/other': 'other' })
  assert.equal(projectKey(w.sessions.a!), '/home/me/work/app')
})

test('projects: live sessions are counted per project', () => {
  const w = world()
  assert.equal(listProjects(w).find((p) => p.key === '/work/gojo')!.live, 4, 'new sessions are working until they finish a turn')
  applyEvent(w, { seq: ++seq, ts: 2000, harness: 'pi', sessionId: 'p1', agentId: 'p1', kind: 'turn.ended', outcome: 'completed' })
  assert.equal(listProjects(w).find((p) => p.key === '/work/gojo')!.live, 3)
})
