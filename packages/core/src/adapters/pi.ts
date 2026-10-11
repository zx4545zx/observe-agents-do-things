/**
 * Pi sessions: <agent dir>/sessions/--<cwd with separators dashed>--/<timestamp>_<session-id>.jsonl
 *
 * One file is one session. The first line is the `session` header (id, cwd);
 * every other line is a tree entry (`id`/`parentId`). Pi writes a message only
 * once it is complete, so an assistant message arrives whole: thinking, text
 * and tool calls together, followed later by one `toolResult` message per call.
 * Pi has no turn records, so turns are derived from message roles and stop reasons.
 *
 * Subagents are not a Pi concept. The pi-open-agents extension runs each one as a
 * separate Pi process whose session lands in `--<cwd>--/subagents/`. Nothing in that
 * file names its parent, so the link is rebuilt from two facts that are both persisted:
 * the child's first message is `Task: <task>`, and the parent recorded the `subagent`
 * call (or a `nestedCalls` entry, for calls made inside `codemode`) with that same
 * task and a start time matching the child's header. Only an exact, unambiguous match
 * links; anything else stays an ordinary session. See docs/pi-subagents.md.
 */
import { createHash } from 'node:crypto'
import { closeSync, openSync, readSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { EventDraft, Usage } from '@oadt/protocol'
import { piChanges } from '../diff.js'
import { basename, clip, compactInput, contentText, firstLine, humanText, isRecord, num, str, toMs } from '../text.js'
import { describePiTool, piPath } from '../tools.js'
import type { Emit, LineParser, TranscriptAdapter } from './types.js'

const HARNESS = 'pi'
/** Tool output kept per call (the projection trims further for display). */
const OUTPUT_MAX = 2000
/** <project dir>/<ISO timestamp with ':' and '.' dashed>_<session id>.jsonl */
const SESSION_FILE = /^\d{4}-\d\d-\d\dT[\d-]+Z_(.+)\.jsonl$/
/** pi-open-agents: the spawning tool, and the prefix it puts on the child's first message. */
const SPAWN_TOOL = 'subagent'
const TASK_PREFIX = 'Task: '
/** The extension records `startedAt` just before the child process starts; its header follows within ms. */
const START_SLACK_MS = 10_000
const DAY_MS = 86_400_000
/** Project dirs sit directly under the root; extensions add one more level (`subagents/`). */
const MAX_DEPTH = 2

export interface PiAdapterOptions {
  /** Pi agent dir. Defaults to $PI_CODING_AGENT_DIR or ~/.pi/agent */
  piDir?: string
  maxText?: number
}

function fileId(path: string): string | undefined {
  return SESSION_FILE.exec(basename(path))?.[1]
}

const taskKey = (task: string) => createHash('sha1').update(task.trim()).digest('hex')

/** One subagent launch recorded in a parent session. */
interface Spawn {
  /** Where the child's events go: the root session and the launching agent. */
  root: string
  parent: string
  /** Session file id of the launching session, checked against a fork child's `parentSession`. */
  parentFile: string
  /** The launching tool call's id, when it is a call of its own (not nested in another tool). */
  callId?: string
  /** Identity of the launch, so reading the same record twice registers it once. */
  id: string
  label?: string
  task: string
  key: string
  /** When the call was written, and when its result was. */
  t0: number
  t1?: number
  startedAt?: number
  claimed: boolean
}

/**
 * Launches recorded by parent parsers, claimed by child parsers. Shared by all
 * parsers of one adapter. Rebuilt from the files on every start, so it needs no persistence.
 */
export class PiSpawnIndex {
  private byKey = new Map<string, Spawn[]>()
  private byCall = new Map<string, Spawn>()
  private ids = new Set<string>()

  add(s: Omit<Spawn, 'key' | 'claimed'>): void {
    if (this.ids.has(s.id)) return
    this.ids.add(s.id)
    const spawn: Spawn = { ...s, key: taskKey(s.task), claimed: false }
    const list = this.byKey.get(spawn.key)
    if (list) list.push(spawn)
    else this.byKey.set(spawn.key, [spawn])
    if (s.callId) this.byCall.set(s.callId, spawn)
  }

  finish(callId: string, t1: number, startedAt: number | undefined): void {
    const s = this.byCall.get(callId)
    if (!s) return
    s.t1 = t1
    s.startedAt = startedAt
  }

  /** The one unclaimed launch of `task` that fits a child started at `start`, or none when there are zero or several. */
  claim(task: string, start: number, parentFile: string | undefined): Spawn | undefined {
    const fits = (s: Spawn) => {
      if (s.claimed || (parentFile && s.parentFile !== parentFile)) return false
      if (s.startedAt !== undefined) return start - s.startedAt >= -1000 && start - s.startedAt <= START_SLACK_MS
      return start >= s.t0 - 1000 && start <= (s.t1 ?? s.t0 + DAY_MS) + 2000
    }
    const found = (this.byKey.get(taskKey(task)) ?? []).filter(fits)
    if (found.length !== 1) return undefined
    found[0]!.claimed = true
    return found[0]
  }
}

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p
}

export class PiAdapter implements TranscriptAdapter {
  readonly harness = HARNESS
  readonly sessionsDir: string
  private spawns = new PiSpawnIndex()

  constructor(private opts: PiAdapterOptions = {}) {
    const dir = expandHome(opts.piDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent'))
    // Pi lets the session dir be moved on its own; an explicit piDir wins over the environment.
    const moved = opts.piDir ? undefined : process.env.PI_CODING_AGENT_SESSION_DIR
    this.sessionsDir = moved ? expandHome(moved) : join(dir, 'sessions')
  }

  roots(): string[] {
    return [this.sessionsDir]
  }

  accepts(path: string): boolean {
    return path.startsWith(this.sessionsDir) && SESSION_FILE.test(basename(path))
  }

  async discover(sinceMs: number): Promise<string[]> {
    const out: string[] = []
    const walk = async (dir: string, depth: number): Promise<void> => {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const p = join(dir, e.name)
        if (e.isDirectory()) {
          if (depth < MAX_DEPTH) await walk(p, depth + 1)
        } else if (e.isFile() && SESSION_FILE.test(e.name)) {
          try {
            if ((await stat(p)).mtimeMs >= sinceMs) out.push(p)
          } catch { /* vanished */ }
        }
      }
    }
    await walk(this.sessionsDir, 0)
    return out
  }

  /** Creation time from the file name, so a launching session is read before the children it launched. */
  order(path: string): number {
    const m = /^(\d{4}-\d\d-\d\dT)(\d\d)-(\d\d)-(\d\d)-(\d{3})Z_/.exec(basename(path))
    return m ? Date.parse(`${m[1]}${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) : 0
  }

  createParser(path: string, emit: Emit): LineParser {
    return new PiSessionParser(path, emit, { maxText: this.opts.maxText, spawns: this.spawns })
  }
}

type Body = EventDraft extends infer T ? (T extends unknown ? Omit<T, 'ts' | 'harness' | 'sessionId' | 'agentId'> : never) : never

/** Synchronously feed `cb` every line of a file that contains `needle`, without holding the file in memory. */
function forEachLine(path: string, needle: string, cb: (line: string) => void): void {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return
  }
  try {
    const buf = Buffer.alloc(4 * 1024 * 1024)
    let carry: Buffer = Buffer.alloc(0)
    for (let n = readSync(fd, buf, 0, buf.length, null); n > 0; n = readSync(fd, buf, 0, buf.length, null)) {
      let chunk = Buffer.concat([carry, buf.subarray(0, n)])
      let nl: number
      while ((nl = chunk.indexOf(0x0a)) >= 0) {
        const line = chunk.subarray(0, nl)
        if (line.includes(needle)) cb(line.toString('utf8'))
        chunk = chunk.subarray(nl + 1)
      }
      carry = Buffer.from(chunk)
    }
    if (carry.includes(needle)) cb(carry.toString('utf8'))
  } finally {
    closeSync(fd)
  }
}

/** Parses one Pi session file. */
export class PiSessionParser implements LineParser {
  /** The session events are filed under. A subagent's is its root session once linked, otherwise its own id. */
  sessionId: string | undefined
  private agentId: string | undefined
  private cwd: string | undefined
  private model: string | undefined
  private titled = false
  private named = false
  private partial = false
  private turnOpen = false
  private lastTs: number | undefined
  private openCalls = new Map<string, number>()
  private readonly maxText: number
  private readonly spawns?: PiSpawnIndex
  private readonly fileId: string | undefined
  private headerTs: number | undefined
  private parentFile: string | undefined
  /** Entries older than the header were copied from the parent session by a fork. */
  private inheritedBefore: number | undefined
  private linked: Spawn | undefined
  /** Until the first message says whether this is a launched subagent, events are held back. */
  private decided = false
  private held: Array<{ ts: number; body: Body }> = []

  constructor(
    readonly path: string,
    private emit: Emit,
    opts: { maxText?: number; spawns?: PiSpawnIndex } = {},
  ) {
    this.maxText = opts.maxText ?? 4000
    this.spawns = opts.spawns
    // Fallback id from the filename for files whose header was skipped.
    this.fileId = fileId(path)
    this.sessionId = this.agentId = this.fileId
  }

  markPartial(): void {
    this.partial = true
  }

  /**
   * A large file is read as its head and tail only, so launches in the skipped middle
   * would be missed and their children left unlinked. Read just those records, once,
   * once this session's place in the tree is known.
   */
  private scanSkippedLaunches(): void {
    if (!this.spawns || !this.sessionId || !this.agentId || !this.fileId) return
    const { spawns, fileId, sessionId: root, agentId: parent } = this
    forEachLine(this.path, SPAWN_TOOL, (raw) => {
      let rec: unknown
      try {
        rec = JSON.parse(raw)
      } catch {
        return
      }
      if (!isRecord(rec) || rec.type !== 'message' || !isRecord(rec.message)) return
      const m = rec.message
      const ts = toMs(rec.timestamp, 0)
      if (m.role === 'assistant' && Array.isArray(m.content)) {
        for (const b of m.content) {
          const task = isRecord(b) && b.type === 'toolCall' && b.name === SPAWN_TOOL && isRecord(b.arguments) ? str(b.arguments.task) : undefined
          const callId = isRecord(b) ? str(b.id) : undefined
          if (task && callId) spawns.add({ id: callId, root, parent, parentFile: fileId, callId, label: str((b as { arguments: Record<string, unknown> }).arguments.agent), task, t0: ts })
        }
      } else if (m.role === 'toolResult') {
        const callId = str(m.toolCallId)
        if (m.toolName === SPAWN_TOOL && callId) {
          const details = isRecord(m.details) ? m.details : {}
          spawns.finish(callId, ts, typeof details.startedAt === 'number' ? details.startedAt : undefined)
        } else if (isRecord(m.nestedCalls) && Array.isArray(m.nestedCalls.calls)) {
          // The outer call's own record may not mention the subagent, so its start is taken from how long it ran.
          const t0 = ts - (typeof m.durationMs === 'number' ? m.durationMs : 0)
          for (const c of m.nestedCalls.calls) {
            const task = isRecord(c) && c.name === SPAWN_TOOL && isRecord(c.arguments) ? str(c.arguments.task) : undefined
            const id = isRecord(c) ? str(c.id) : undefined
            if (task && id) spawns.add({ id, root, parent, parentFile: fileId, label: str((c as { arguments: Record<string, unknown> }).arguments.agent), task, t0, t1: ts })
          }
        }
      }
    })
  }

  line(raw: string): void {
    let rec: unknown
    try {
      rec = JSON.parse(raw)
    } catch {
      return
    }
    if (!isRecord(rec)) return
    const ts = toMs(rec.timestamp, this.lastTs ?? Date.now())
    if (rec.timestamp !== undefined) this.lastTs = ts
    if (rec.type !== 'session' && this.inheritedBefore !== undefined && rec.timestamp !== undefined && ts < this.inheritedBefore) return
    switch (rec.type) {
      case 'session':
        return this.header(rec, ts)
      case 'message':
        return isRecord(rec.message) ? this.message(rec.message, str(rec.id), ts) : undefined
      case 'model_change':
        return this.setModel(str(rec.modelId), ts)
      case 'session_info': {
        const name = str(rec.name)
        if (name) {
          this.named = true
          this.send(ts, { kind: 'session.updated', meta: { title: clip(name, 120), titleSource: 'custom' } })
        }
        return
      }
      case 'compaction': {
        const before = num(rec.tokensBefore)
        this.send(ts, { kind: 'note', level: 'info', text: before ? `Context compacted (${before} tokens summarized)` : 'Context compacted' })
        return this.usage(rec.usage, ts)
      }
      case 'branch_summary':
        this.send(ts, { kind: 'note', level: 'info', text: 'Branch summarized' })
        return this.usage(rec.usage, ts)
      case 'usage':
        return this.usage(rec.usage, ts, str(rec.model))
    }
  }

  private send(ts: number, body: Body): void {
    if (!this.decided) this.held.push({ ts, body })
    else this.emitNow(ts, body)
  }

  private emitNow(ts: number, body: Body): void {
    if (!this.sessionId || !this.agentId) return
    this.emit({ ts, harness: HARNESS, sessionId: this.sessionId, agentId: this.agentId, ...body } as EventDraft)
  }

  /**
   * Settle whether this file is a launched subagent, then release what was held.
   * A linked subagent's events join its launcher's session as a child agent.
   */
  private decide(link?: Spawn): void {
    if (this.decided) return
    this.decided = true
    const held = this.held
    this.held = []
    if (this.partial) this.scanSkippedLaunches()
    if (!link) {
      for (const h of held) this.emitNow(h.ts, h.body)
      return
    }
    this.linked = link
    this.sessionId = link.root
    this.emitNow(this.headerTs ?? Date.now(), {
      kind: 'agent.spawned',
      parentAgentId: link.parent,
      parentToolCallId: link.callId,
      name: link.label ?? 'subagent',
      role: link.label,
      task: clip(link.task, 400),
    })
    // The child's own session metadata describes the launcher's session, not it; everything else is its activity.
    for (const h of held) if (h.body.kind !== 'session.started' && h.body.kind !== 'session.updated') this.emitNow(h.ts, h.body)
  }

  private header(rec: Record<string, unknown>, ts: number): void {
    const id = str(rec.id)
    if (id) this.sessionId = this.agentId = id
    this.cwd = str(rec.cwd)
    this.headerTs = ts
    const parent = str(rec.parentSession)
    if (parent) {
      this.parentFile = fileId(parent)
      this.inheritedBefore = ts
    }
    this.send(ts, {
      kind: 'session.started',
      meta: {
        cwd: this.cwd,
        project: this.cwd ? basename(this.cwd) : undefined,
        // Pi has no approval gate; this keeps a long-running tool from being reported as "awaiting approval".
        permissionMode: 'none',
        transcriptPath: this.path,
        partialHistory: this.partial || undefined,
      },
    })
  }

  private setModel(model: string | undefined, ts: number): void {
    if (!model || model === this.model) return
    this.model = model
    this.send(ts, { kind: 'session.updated', meta: { model } })
  }

  private startTurn(id: string | undefined, ts: number): void {
    if (this.turnOpen) return
    this.turnOpen = true
    this.send(ts, { kind: 'turn.started', turnId: id })
  }

  private endTurn(outcome: 'completed' | 'aborted' | 'error', ts: number): void {
    for (const callId of this.openCalls.keys()) this.send(ts, { kind: 'tool.finished', callId, ok: false, output: 'interrupted' })
    this.openCalls.clear()
    this.turnOpen = false
    this.send(ts, { kind: 'turn.ended', outcome })
  }

  private message(m: Record<string, unknown>, entryId: string | undefined, ts: number): void {
    if (m.role === 'user') return this.user(m, entryId, ts)
    if (m.role === 'system') return
    this.decide()
    switch (m.role) {
      case 'assistant':
        return this.assistant(m, entryId, ts)
      case 'toolResult':
        return this.toolResult(m, ts)
      case 'bashExecution': {
        // A command the user ran directly (`!cmd`), outside the model loop.
        const callId = `bash-${entryId ?? ts}`
        const command = str(m.command) ?? ''
        const output = str(m.output)
        this.send(ts, { kind: 'tool.started', callId, tool: 'bash', category: 'shell', title: `$ ${firstLine(command, 100)}`, input: { command: clip(command, 600) }, files: [] })
        this.send(ts, { kind: 'tool.finished', callId, ok: m.cancelled !== true && (m.exitCode === undefined || m.exitCode === 0), output: output ? clip(output, OUTPUT_MAX) : undefined })
        return
      }
    }
  }

  private user(m: Record<string, unknown>, entryId: string | undefined, ts: number): void {
    const text = humanText(contentText(m.content))
    if (!this.decided) {
      const task = text?.startsWith(TASK_PREFIX) ? text.slice(TASK_PREFIX.length) : undefined
      const link = task && this.headerTs !== undefined ? this.spawns?.claim(task, this.headerTs, this.parentFile) : undefined
      this.decide(link)
    }
    if (!text) return
    if (!this.titled && !this.named && !this.linked) {
      this.titled = true
      this.send(ts, { kind: 'session.updated', meta: { title: firstLine(text, 80), titleSource: 'prompt' } })
    }
    this.startTurn(entryId, ts)
    this.send(ts, { kind: 'message', role: this.linked ? 'agent' : 'user', text: clip(text, this.maxText) })
  }

  private toolResult(m: Record<string, unknown>, ts: number): void {
    const callId = str(m.toolCallId)
    const started = callId ? this.openCalls.get(callId) : undefined
    if (callId && started !== undefined) {
      this.openCalls.delete(callId)
      const text = contentText(m.content).trim()
      const details = isRecord(m.details) ? m.details : {}
      this.spawns?.finish(callId, ts, typeof details.startedAt === 'number' ? details.startedAt : undefined)
      this.send(ts, {
        kind: 'tool.finished',
        callId,
        ok: m.isError !== true,
        output: text ? clip(text, OUTPUT_MAX) : undefined,
        durationMs: typeof m.durationMs === 'number' ? m.durationMs : undefined,
      })
      this.nestedSpawns(m.nestedCalls, started, ts)
    }
    this.usage(m.usage, ts)
  }

  /** Subagents launched from inside another tool (`codemode`) are only recorded on that tool's result. */
  private nestedSpawns(nested: unknown, t0: number, t1: number): void {
    if (!this.spawns || !this.sessionId || !this.agentId || !this.fileId || !isRecord(nested) || !Array.isArray(nested.calls)) return
    for (const c of nested.calls) {
      if (!isRecord(c) || c.name !== SPAWN_TOOL || !isRecord(c.arguments)) continue
      const task = str(c.arguments.task)
      if (task) this.spawns.add({ id: str(c.id) ?? `${this.fileId}#${t1}`, root: this.sessionId, parent: this.agentId, parentFile: this.fileId, label: str(c.arguments.agent), task, t0, t1 })
    }
  }

  private assistant(m: Record<string, unknown>, entryId: string | undefined, ts: number): void {
    this.startTurn(entryId, ts)
    const model = str(m.model)
    this.setModel(model, ts)
    for (const block of Array.isArray(m.content) ? m.content : []) {
      if (!isRecord(block)) continue
      switch (block.type) {
        case 'thinking': {
          const text = block.redacted === true ? '' : str(block.thinking)?.trim()
          this.send(ts, { kind: 'thinking', text: text ? clip(text, this.maxText) : undefined })
          break
        }
        case 'text': {
          const text = str(block.text)?.trim()
          if (text) this.send(ts, { kind: 'message', role: 'assistant', text: clip(text, this.maxText) })
          break
        }
        case 'toolCall':
          this.toolCall(block, ts)
          break
      }
    }
    this.usage(m.usage, ts, model, true)
    const stop = m.stopReason
    if (stop === 'stop' || stop === 'length') this.endTurn('completed', ts)
    else if (stop === 'aborted') this.endTurn('aborted', ts)
    else if (stop === 'error') {
      this.send(ts, { kind: 'note', level: 'warn', text: clip(str(m.errorMessage) ?? 'error', 300) })
      this.endTurn('error', ts)
    }
  }

  private toolCall(block: Record<string, unknown>, ts: number): void {
    const callId = str(block.id)
    const name = str(block.name)
    if (!callId || !name || this.openCalls.has(callId)) return
    this.openCalls.set(callId, ts)
    const args = isRecord(block.arguments) ? block.arguments : {}
    const d = describePiTool(name, args, this.cwd)
    const task = name === SPAWN_TOOL ? str(args.task) : undefined
    if (task && this.spawns && this.sessionId && this.agentId && this.fileId) {
      this.spawns.add({ id: callId, root: this.sessionId, parent: this.agentId, parentFile: this.fileId, callId, label: str(args.agent), task, t0: ts })
    }
    this.send(ts, {
      kind: 'tool.started',
      callId,
      tool: name,
      category: d.category,
      title: d.title,
      input: compactInput(args),
      files: d.files,
      changes: piChanges(name, args, piPath(args.path, this.cwd)),
    })
  }

  /** Pi's `reasoning` count is already inside `output`, as it is in `Usage.reasoning`. */
  private usage(raw: unknown, ts: number, model?: string, context = false): void {
    if (!isRecord(raw)) return
    const delta: Usage = {
      input: num(raw.input),
      output: num(raw.output),
      cacheRead: num(raw.cacheRead),
      cacheWrite: num(raw.cacheWrite),
      reasoning: num(raw.reasoning),
    }
    if (Object.values(delta).every((n) => n === 0)) return
    // The context window is not in the transcript, so only the fill is reported.
    this.send(ts, { kind: 'usage', delta, model, contextTokens: context ? delta.input + delta.cacheRead + delta.cacheWrite : undefined })
  }
}
