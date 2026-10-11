/**
 * Selectors for monitoring multi-agent work: runs as cards, what each agent is doing now,
 * agents outside any workflow, and a feed of what just happened. Pure reads over a
 * WorldState and the workflow projection, with no state of their own, so a
 * frontend only has to draw what they return.
 */
import type { ToolCategory } from './events.js'
import type { AgentState, SessionState, WorldState } from './state.js'
import { workflowIndex, type AgentWorkflow, type WorkflowIndex, type WorkflowRun } from './workflows.js'

/** What an agent is doing right now, from its open tool calls and status. Deterministic, no summarising. */
export interface ActivityLine {
  state: 'tool' | 'delegating' | 'waiting' | 'thinking' | 'working' | 'finished' | 'idle'
  text: string
  category?: ToolCategory
  /** When this started (epoch ms). */
  since: number
}

export function agentCurrentActivity(s: SessionState, a: AgentState): ActivityLine {
  if (a.status === 'waiting') return { state: 'waiting', text: a.statusReason ?? 'waiting', since: a.statusSince }
  const open = a.activeTools.map((id) => s.tools[id]).filter((t) => t && t.endedAt === undefined)
  const own = open.filter((t) => t!.category !== 'agent')
  const tool = own[own.length - 1]
  if (tool) return { state: 'tool', text: tool.title, category: tool.category, since: tool.startedAt }
  const launching = open.filter((t) => t!.category === 'agent')
  if (launching.length) {
    const running = a.children.filter((id) => s.agents[id] && s.agents[id]!.status !== 'done').length
    return { state: 'delegating', text: running ? `waiting for ${running} ${running === 1 ? 'agent' : 'agents'}` : 'waiting for an agent', since: launching[0]!.startedAt }
  }
  if (a.status === 'done') return { state: 'finished', text: 'finished', since: a.statusSince }
  if (a.thinking) return { state: 'thinking', text: 'thinking', since: a.lastActivityAt }
  if (a.status === 'working') return { state: 'working', text: 'working', since: a.statusSince }
  return { state: 'idle', text: 'idle', since: a.statusSince }
}

export interface AgentView {
  agent: AgentState
  sessionId: string
  /** Indent level in the list it appears in. */
  depth: number
  workflow?: AgentWorkflow
  activity: ActivityLine
}

export interface RunView {
  sessionId: string
  run: WorkflowRun
  /** `running` or `waiting`. */
  active: boolean
  lead: AgentView
  /** The run's other PStack agents in tree order, indented by their workflow depth. */
  workers: AgentView[]
  counts: { working: number; waiting: number; done: number; failed: number }
  /** Running: so far. Done: until its last activity. */
  durationMs: number
}

function view(s: SessionState, a: AgentState, wf: AgentWorkflow | undefined, depth: number): AgentView {
  return { agent: a, sessionId: s.id, depth, workflow: wf, activity: agentCurrentActivity(s, a) }
}

/** Runs of one session: active first, then newest to oldest. */
export function runViews(s: SessionState, now = Date.now(), index: WorkflowIndex = workflowIndex(s)): RunView[] {
  const out: RunView[] = []
  for (const run of index.runs) {
    const lead = s.agents[run.leadId]
    if (!lead) continue
    const members = new Set(run.agentIds)
    const workers: AgentView[] = []
    const walk = (a: AgentState, guard: number): void => {
      for (const id of a.children) {
        const c = s.agents[id]
        if (!c || guard > 64) continue
        if (members.has(id) && id !== run.leadId) workers.push(view(s, c, index.byAgent.get(id), index.byAgent.get(id)!.depth))
        walk(c, guard + 1)
      }
    }
    walk(lead, 0)
    const all = run.agentIds.map((id) => s.agents[id]).filter((a): a is AgentState => !!a)
    const active = run.status !== 'done'
    out.push({
      sessionId: s.id,
      run,
      active,
      lead: view(s, lead, index.byAgent.get(lead.id), 0),
      workers,
      counts: {
        working: all.filter((a) => a.status === 'working').length,
        waiting: all.filter((a) => a.status === 'waiting').length,
        done: all.filter((a) => a.status === 'done').length,
        failed: all.filter((a) => a.errorCount > 0).length,
      },
      durationMs: Math.max(0, (active ? now : run.lastActivityAt) - run.startedAt),
    })
  }
  return out.sort(compareRuns)
}

/** Active runs first, then newest to oldest. */
export function compareRuns(a: RunView, b: RunView): number {
  return Number(b.active) - Number(a.active) || b.run.startedAt - a.run.startedAt || a.run.id.localeCompare(b.run.id)
}

/** Every run in the world, ordered with `compareRuns`. */
export function activeRuns(world: WorldState, now = Date.now()): RunView[] {
  return Object.values(world.sessions).flatMap((s) => runViews(s, now)).sort(compareRuns)
}

export interface OtherAgent extends AgentView {
  /** The run it works inside, when a PStack worker above it launched it. */
  viaRun?: number
}

/** Agents that are not the main agent and not part of any workflow, in tree order. */
export function genericAgents(s: SessionState, index: WorkflowIndex = workflowIndex(s)): OtherAgent[] {
  const out: OtherAgent[] = []
  const walk = (a: AgentState, depth: number, via: number | undefined, guard: number): void => {
    for (const id of a.children) {
      const c = s.agents[id]
      if (!c || guard > 64) continue
      const wf = index.byAgent.get(id)
      if (!wf) out.push({ ...view(s, c, undefined, depth), viaRun: via })
      walk(c, wf ? 0 : depth + 1, wf ? wf.runIndex : via, guard + 1)
    }
  }
  const root = s.agents[s.rootAgentId]
  if (root) walk(root, 0, undefined, 0)
  return out
}

/** Text a search box can match for a session's agents: definitions, tasks, run numbers. Built only when needed. */
export function sessionSearchText(s: SessionState, index: WorkflowIndex = workflowIndex(s)): string {
  const parts: string[] = []
  for (const run of index.runs) parts.push(`${run.label} run ${run.index}`)
  for (const a of Object.values(s.agents)) {
    if (a.id === s.rootAgentId) continue
    parts.push(a.name, a.role ?? '', (a.task ?? '').slice(0, 400))
  }
  return parts.join(' ').toLowerCase()
}

export interface FeedItem {
  key: string
  ts: number
  sessionId: string
  agentId: string
  kind: 'tool' | 'started' | 'finished'
  /** Present for tool items. */
  toolId?: string
  workflow?: AgentWorkflow
}

/**
 * What happened lately, newest first: tool calls, and sub-agents starting and finishing.
 * `finished` uses when the agent's status last changed to done.
 */
export function activityFeed(world: WorldState, limit = 60): FeedItem[] {
  const items: FeedItem[] = []
  for (const s of Object.values(world.sessions)) {
    const wf = workflowIndex(s).byAgent
    const perSession: FeedItem[] = []
    for (const id of s.toolOrder.slice(-limit)) {
      const t = s.tools[id]
      if (t) perSession.push({ key: `t:${s.id}:${id}`, ts: t.startedAt, sessionId: s.id, agentId: t.agentId, kind: 'tool', toolId: id, workflow: wf.get(t.agentId) })
    }
    for (const a of Object.values(s.agents)) {
      if (a.id === s.rootAgentId) continue
      perSession.push({ key: `s:${s.id}:${a.id}`, ts: a.startedAt, sessionId: s.id, agentId: a.id, kind: 'started', workflow: wf.get(a.id) })
      if (a.status === 'done') perSession.push({ key: `f:${s.id}:${a.id}`, ts: a.statusSince, sessionId: s.id, agentId: a.id, kind: 'finished', workflow: wf.get(a.id) })
    }
    items.push(...perSession.sort((x, y) => y.ts - x.ts).slice(0, limit))
  }
  return items.sort((x, y) => y.ts - x.ts || x.key.localeCompare(y.key)).slice(0, limit)
}
