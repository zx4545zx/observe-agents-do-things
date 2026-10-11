/**
 * Workflow enrichment: which agents belong to a named orchestration workflow
 * (today PStack), and how they group into runs.
 *
 * This is a read-only layer over the generic agent tree. Nothing here is
 * written into state or the event stream, so it cannot disagree with the tree,
 * it needs no persistence, and a restart rebuilds exactly the same answer.
 * Harness adapters stay generic: they only report what the harness recorded
 * (an agent's definition name and its task). All workflow knowledge lives in `WORKFLOWS`.
 *
 * What is derived, and what is deliberately not, is documented in docs/pstack-enrichment.md.
 */
import type { AgentStatus } from './events.js'
import type { AgentState, SessionState } from './state.js'

export type WorkflowKind = 'pstack'

interface WorkflowDef {
  kind: WorkflowKind
  label: string
  /** True for an agent the workflow itself defines. Must rest on what the harness recorded, never on the wording of a task. */
  isMember(a: AgentState): boolean
}

/**
 * PStack's worker agent is `poteto-agent` (its definition describes it as "Internal PStack worker").
 * Claude Code plugin names (`pstack:poteto-agent`) and the effort variants are the same worker.
 */
const PSTACK_WORKER = /^(?:[\w-]+:)?poteto-agent(?:-(?:low|medium|high|xhigh|max))?$/

export const WORKFLOWS: readonly WorkflowDef[] = [
  { kind: 'pstack', label: 'PStack', isMember: (a) => !!a.role && PSTACK_WORKER.test(a.role) },
]

/** How an agent takes part in a workflow. */
export interface AgentWorkflow {
  kind: WorkflowKind
  label: string
  /** The run this agent belongs to: the id of the run's lead agent. */
  runId: string
  /** 1-based position of the run among the session's runs of this workflow, by start time. */
  runIndex: number
  /** `lead` starts a run (nothing above it is part of the workflow). Everything below is a `worker`. */
  tier: 'lead' | 'worker'
  /** Workflow agents between this one and the run's lead. 0 for the lead. */
  depth: number
  /** The agent that launched the run (the session's main agent, a primary like Chief, or any other). */
  hostAgentId?: string
}

export interface WorkflowRun {
  kind: WorkflowKind
  label: string
  id: string
  index: number
  leadId: string
  hostAgentId?: string
  /** Every workflow agent in the run, in start order. */
  agentIds: string[]
  /** `waiting` if any agent is, else `running` if any is working, else `done`. */
  status: 'running' | 'waiting' | 'done'
  startedAt: number
  lastActivityAt: number
  /** The lead's delegated task, as the harness recorded it. */
  task?: string
}

export interface WorkflowIndex {
  byAgent: Map<string, AgentWorkflow>
  runs: WorkflowRun[]
}

const GUARD = 64

function runStatus(statuses: AgentStatus[]): WorkflowRun['status'] {
  if (statuses.includes('waiting')) return 'waiting'
  return statuses.includes('working') ? 'running' : 'done'
}

/** Classify every agent of a session once. Cheap enough to call per render. */
export function workflowIndex(s: SessionState): WorkflowIndex {
  const byAgent = new Map<string, AgentWorkflow>()
  const runs: WorkflowRun[] = []
  for (const def of WORKFLOWS) {
    const members = Object.values(s.agents).filter((a) => def.isMember(a))
    if (!members.length) continue
    const isMember = new Set(members.map((a) => a.id))
    /** The member above `a` that has no member above it, and how many members sit in between. */
    const lead = (a: AgentState): { lead: AgentState; depth: number } => {
      let top = a
      let depth = 0
      for (let p = a.parentId ? s.agents[a.parentId] : undefined, i = 0; p && i < GUARD; p = p.parentId ? s.agents[p.parentId] : undefined, i++) {
        if (isMember.has(p.id)) { top = p; depth++ }
      }
      return { lead: top, depth }
    }
    const leads = [...new Map(members.map((a) => [lead(a).lead.id, lead(a).lead])).values()]
      .sort((x, y) => x.startedAt - y.startedAt || x.id.localeCompare(y.id))
    const index = new Map(leads.map((l, i) => [l.id, i + 1]))
    for (const a of members) {
      const { lead: top, depth } = lead(a)
      byAgent.set(a.id, { kind: def.kind, label: def.label, runId: top.id, runIndex: index.get(top.id)!, tier: top.id === a.id ? 'lead' : 'worker', depth, hostAgentId: top.parentId })
    }
    for (const l of leads) {
      const agents = members.filter((a) => byAgent.get(a.id)!.runId === l.id).sort((x, y) => x.startedAt - y.startedAt || x.id.localeCompare(y.id))
      runs.push({
        kind: def.kind,
        label: def.label,
        id: l.id,
        index: index.get(l.id)!,
        leadId: l.id,
        hostAgentId: l.parentId,
        agentIds: agents.map((a) => a.id),
        status: runStatus(agents.map((a) => a.status)),
        startedAt: Math.min(...agents.map((a) => a.startedAt)),
        lastActivityAt: Math.max(...agents.map((a) => a.lastActivityAt)),
        task: l.task,
      })
    }
  }
  return { byAgent, runs }
}

export function workflowOf(s: SessionState, agentId: string): AgentWorkflow | undefined {
  return workflowIndex(s).byAgent.get(agentId)
}

export function workflowRuns(s: SessionState): WorkflowRun[] {
  return workflowIndex(s).runs
}

/** Names of the workflows with agents in this session, for search and badges. */
export function workflowLabels(s: SessionState): string[] {
  return [...new Set([...workflowIndex(s).byAgent.values()].map((w) => w.label))]
}
