/**
 * DOM for monitoring multi-agent work: agent rows, run cards, and the agent and run
 * detail views. All data comes from the pure selectors in @oadt/protocol (runViews,
 * agentCurrentActivity, ...). Nothing here parses workflows or touches state.
 */
import {
  clip,
  formatAgo,
  formatCount,
  formatDuration,
  shortPath,
  totalTokens,
  type AgentView,
  type AgentWorkflow,
  type FileRef,
  type RunView,
  type SessionState,
  type ToolCallState,
} from '@oadt/protocol'
import { h } from '../../shared/dom'
import { CATEGORY } from '../../shared/theme'

export interface MonitorDeps {
  agentName(s: SessionState, id: string): string
  /** `Run 4 · Lead` for workflow agents, otherwise the agent's name. */
  label(s: SessionState, id: string): string
  openAgent(sid: string, agentId: string): void
  openRun(sid: string, runId: string): void
  setTab(tab: 'chat' | 'activity' | 'diffs'): void
}

export const tierLabel = (wf: AgentWorkflow) => (wf.tier === 'lead' ? 'Lead' : 'Worker')

/** `Run 4 · Worker`, or the agent's own name when it is not part of a workflow. */
export function agentLabel(name: string, wf: AgentWorkflow | undefined): string {
  return wf ? `Run ${wf.runIndex} · ${tierLabel(wf)}` : name
}

export const STATUS_WORD: Record<string, string> = { working: 'working', waiting: 'waiting', done: 'done', idle: 'idle' }

/** First line of a delegated task, clipped for a list. The full text is in the detail view. */
export function taskHeadline(task: string | undefined, max = 160): string {
  const line = (task ?? '').trim().split(/\r?\n/).find((l) => l.trim()) ?? ''
  return clip(line.trim(), max)
}

/** Ordinal of each worker by start, for "Worker 3". */
function workerNumbers(rv: RunView): Map<string, number> {
  const order = rv.run.agentIds.filter((id) => id !== rv.run.leadId)
  return new Map(order.map((id, i) => [id, i + 1]))
}

export function activityNode(av: AgentView, now: number): HTMLElement {
  const a = av.activity
  const el = h('div.cur.' + a.state, null,
    a.category ? h('span.chip', { style: `--c:var(--c-${a.category})` }, CATEGORY[a.category]?.label ?? a.category) : '',
    h('span.t', null, a.text),
    h('span.el', { 'data-since': a.since, 'data-mode': a.state === 'finished' || a.state === 'idle' ? 'ago' : 'dur' }, a.state === 'finished' || a.state === 'idle' ? formatAgo(a.since, now).replace(' ago', '') : formatDuration(now - a.since)))
  return el
}

/** Keep elapsed times ticking without rebuilding the rows around them. */
export function tickElapsed(root: HTMLElement, now: number): void {
  for (const el of root.querySelectorAll<HTMLElement>('.el[data-since]')) {
    const since = Number(el.dataset.since)
    const text = el.dataset.mode === 'ago' ? formatAgo(since, now).replace(' ago', '') : formatDuration(now - since)
    if (el.textContent !== text) el.textContent = text
  }
}

/** One agent as a row: status, who, the delegated task, what it is doing, and its numbers. */
export function agentRow(s: SessionState, av: AgentView, rv: RunView | undefined, deps: MonitorDeps, now: number, note = ''): HTMLElement {
  const a = av.agent
  const wf = av.workflow
  const num = rv && wf ? workerNumbers(rv).get(a.id) : undefined
  const who = wf ? `${tierLabel(wf)}${wf.tier === 'worker' && num ? ` ${num}` : ''}` : deps.agentName(s, a.id)
  const sub = wf ? (a.role ?? a.name) : a.role && a.role !== a.name ? a.role : ''
  const row = h('div.mc-ar.st-' + a.status + (wf ? '.wf-' + wf.tier : '.generic') + (av.depth > 0 ? '.nested' : ''), {
    style: `--d:${av.depth}`, tabindex: '0', title: a.task ? clip(a.task, 400) : a.name,
    onclick: () => deps.openAgent(s.id, a.id),
    onkeydown: (e: Event) => { if ((e as KeyboardEvent).key === 'Enter') deps.openAgent(s.id, a.id) },
  },
    h('span.dot.' + a.status, { title: STATUS_WORD[a.status] ?? a.status }),
    h('div.main', null,
      h('div.l1', null, h('b', null, who), sub ? h('span.faint', null, ` ${sub}`) : '', h('span.st', null, STATUS_WORD[a.status] ?? a.status),
        a.errorCount ? h('span.err', { title: 'failed tool calls' }, `✕ ${a.errorCount}`) : '', note ? h('span.faint.note', null, note) : ''),
      a.task ? h('div.task', null, taskHeadline(a.task)) : '',
      a.status === 'done' ? '' : activityNode(av, now)),
    h('span.num', null, `${a.toolCount} tools · ${formatCount(totalTokens(a.usage))}`))
  return row
}

const RUN_STATUS: Record<string, string> = { running: 'RUNNING', waiting: 'WAITING', done: 'DONE' }

export function runHead(rv: RunView): Array<HTMLElement | string> {
  const { run, counts } = rv
  const workers = run.agentIds.length - 1
  return [
    h('span.run', null, `Run ${run.index}`),
    h('span.pill.' + run.status, null, RUN_STATUS[run.status]),
    h('span.agents', null, `Lead${workers ? ` + ${workers} ${workers === 1 ? 'worker' : 'workers'}` : ''}`),
    counts.working || counts.waiting ? h('span.faint', null, `${counts.working} working${counts.waiting ? ` · ${counts.waiting} waiting` : ''}`) : '',
    counts.failed ? h('span.err', { title: 'agents with failed tool calls' }, `✕ ${counts.failed}`) : '',
  ]
}

/** A run as a card: header, then the lead and its workers as an indented list. */
export function runBody(s: SessionState, rv: RunView, deps: MonitorDeps, now: number): HTMLElement[] {
  return [rv.lead, ...rv.workers].map((av) => agentRow(s, av, rv, deps, now))
}

function toolRow(t: ToolCallState, now: number): HTMLElement {
  const running = t.endedAt === undefined
  return h('div.mc-arow' + (running ? '.running' : '') + (t.ok === false ? '.failed' : ''), { title: t.title },
    h('span.time', null, clock(t.startedAt)),
    h('span.chip', { style: `--c:var(--c-${t.category})` }, CATEGORY[t.category]?.label ?? t.category),
    h('span.title', null, t.title),
    h('span.dur', null, running ? formatDuration(now - t.startedAt) : t.ok === false ? `✕ ${formatDuration(t.durationMs ?? 0)}` : formatDuration(t.durationMs ?? 0)))
}

const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })

const FILE_OPS = ['edit', 'write', 'delete', 'read', 'search'] as const

/** Files this agent's tool calls touched, edits first. */
function agentFiles(tools: ToolCallState[]): Array<{ path: string; ops: string[] }> {
  const by = new Map<string, Set<string>>()
  for (const t of tools) for (const f of t.files as FileRef[]) {
    let set = by.get(f.path)
    if (!set) by.set(f.path, (set = new Set()))
    set.add(f.op)
  }
  const rank = (ops: Set<string>) => FILE_OPS.findIndex((o) => ops.has(o))
  return [...by.entries()].map(([path, ops]) => ({ path, ops: FILE_OPS.filter((o) => ops.has(o)) })).sort((a, b) => rank(new Set(a.ops)) - rank(new Set(b.ops)) || a.path.localeCompare(b.path))
}

const fact = (v: string | number, k: string) => h('div', null, h('b', null, String(v)), h('span', null, k))

function section(title: string, ...body: Array<HTMLElement | false | undefined>): HTMLElement {
  return h('section.mc-dsec', null, h('div.mc-dhead', null, title), ...body)
}

/** Agent detail: who it is, its task, what it is doing, its numbers, files and recent tools. */
export function agentDetail(s: SessionState, av: AgentView, rv: RunView | undefined, deps: MonitorDeps, now: number): HTMLElement[] {
  const a = av.agent
  const wf = av.workflow
  const tools = s.toolOrder.map((id) => s.tools[id]).filter((t): t is ToolCallState => !!t && t.agentId === a.id)
  const recent = [...tools].sort((x, y) => y.startedAt - x.startedAt).slice(0, 40)
  const files = agentFiles(tools)
  const parent = a.parentId ? deps.label(s, a.parentId) : undefined
  const kept = tools.length
  const lost = a.toolCount > kept ? `${a.toolCount - kept} older ${a.toolCount - kept === 1 ? 'call is' : 'calls are'} no longer kept in memory.` : ''
  const num = rv && wf ? workerNumbers(rv).get(a.id) : undefined
  return [
    h('div.mc-dtitle', null,
      h('b', null, wf ? `${wf.label} · Run ${wf.runIndex} · ${tierLabel(wf)}${wf.tier === 'worker' && num ? ` ${num}` : ''}` : deps.agentName(s, a.id)),
      h('span.dot.' + a.status), h('span', null, `${STATUS_WORD[a.status] ?? a.status} for ${formatDuration(now - a.statusSince)}`)),
    h('div.mc-dmeta', null, [
      !wf && a.role && a.role !== a.name ? `definition ${a.role}` : wf ? `definition ${a.role ?? a.name}` : '',
      parent ? `launched by ${parent}` : '',
      wf?.hostAgentId && wf.tier === 'lead' ? `run host ${deps.label(s, wf.hostAgentId)}` : '',
      a.model ?? '',
      `started ${formatAgo(a.startedAt, now)}`,
    ].filter(Boolean).join(' · ')),
    section('Task', a.task ? h('pre.mc-task', null, a.task) : h('div.mc-empty', null, 'No task was recorded for this agent.')),
    section('Now', activityNode(av, now)),
    h('div.mc-facts', null, fact(a.toolCount, 'tools'), fact(a.errorCount, 'failed'), fact(formatCount(totalTokens(a.usage)), 'tokens'),
      fact(formatCount(a.usage.output), 'output'), fact(a.contextTokens ? formatCount(a.contextTokens) : '—', 'context'), fact(a.children.length, 'children')),
    section(`Files · ${files.length}`, files.length
      ? h('div.mc-dfiles', null, ...files.slice(0, 40).map((f) => h('div.f', { title: f.path }, h('span.ops', null, f.ops.join(' ')), h('code', null, shortPath(f.path, 4)))))
      : h('div.mc-empty', null, a.toolCount ? `None among the ${kept} retained calls.` : 'No files touched.')),
    section(`Recent tools · ${kept}${lost ? ` of ${a.toolCount}` : ''}`, recent.length ? h('div.mc-arows', null, ...recent.map((t) => toolRow(t, now))) : h('div.mc-empty', null, lost || 'No tool calls yet.'),
      recent.length && lost ? h('div.mc-empty', null, lost) : undefined),
    h('div.mc-dlinks', null,
      h('button', { onclick: () => deps.setTab('chat') }, 'Open conversation'),
      h('button', { onclick: () => deps.setTab('diffs') }, 'Open diffs')),
  ]
}

/** Run detail: status, host, counts, the lead's task, the whole tree, and recent activity across it. */
export function runDetail(s: SessionState, rv: RunView, deps: MonitorDeps, now: number): HTMLElement[] {
  const { run, counts } = rv
  const members = new Set(run.agentIds)
  const tools = s.toolOrder.map((id) => s.tools[id]).filter((t): t is ToolCallState => !!t && members.has(t.agentId)).sort((x, y) => y.startedAt - x.startedAt).slice(0, 30)
  const wfOf = (id: string) => (id === run.leadId ? 'Lead' : `Worker ${workerNumbers(rv).get(id) ?? ''}`.trim())
  return [
    h('div.mc-dtitle', null, h('b', null, `${run.label} · Run ${run.index}`), h('span.pill.' + run.status, null, RUN_STATUS[run.status])),
    h('div.mc-dmeta', null, [
      `host ${run.hostAgentId ? deps.label(s, run.hostAgentId) : 'unknown'}`,
      `${run.agentIds.length} ${run.agentIds.length === 1 ? 'agent' : 'agents'}`,
      `${formatDuration(rv.durationMs)}${rv.active ? ' so far' : ''}`,
      `started ${formatAgo(run.startedAt, now)}`,
    ].join(' · ')),
    h('div.mc-facts', null, fact(counts.working, 'working'), fact(counts.waiting, 'waiting'), fact(counts.done, 'done'), fact(counts.failed, 'failed'),
      fact(formatCount(rv.lead.agent.usage.output + rv.workers.reduce((n, w) => n + w.agent.usage.output, 0)), 'output'), fact(tools.length ? tools.length : 0, 'recent calls')),
    section('Lead task', rv.lead.agent.task ? h('pre.mc-task', null, rv.lead.agent.task) : h('div.mc-empty', null, 'No task was recorded.')),
    section('Agents', h('div.mc-runtree', null, ...runBody(s, rv, deps, now))),
    section('Recent activity', tools.length ? h('div.mc-arows', null, ...tools.map((t) => h('div.mc-arow.run' + (t.endedAt === undefined ? '.running' : '') + (t.ok === false ? '.failed' : ''), { title: t.title },
      h('span.time', null, clock(t.startedAt)),
      h('span.who', null, wfOf(t.agentId)),
      h('span.title', null, t.title),
      h('span.dur', null, t.endedAt === undefined ? formatDuration(now - t.startedAt) : t.ok === false ? '✕' : formatDuration(t.durationMs ?? 0))))) : h('div.mc-empty', null, 'No tool calls yet.')),
  ]
}
