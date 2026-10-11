/**
 * Pi sessions: <agent dir>/sessions/--<cwd with separators dashed>--/<timestamp>_<session-id>.jsonl
 *
 * One file is one session. The first line is the `session` header (id, cwd);
 * every other line is a tree entry (`id`/`parentId`). Pi writes a message only
 * once it is complete, so an assistant message arrives whole: thinking, text
 * and tool calls together, followed later by one `toolResult` message per call.
 * Pi has no turn records, so turns are derived from message roles and stop reasons.
 *
 * Extensions may put further session files in a `subagents/` directory next to
 * the project's sessions. They are ordinary Pi sessions and are observed as such;
 * linking them to the session that spawned them is an extension convention, not Pi's.
 */
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
/** Project dirs sit directly under the root; extensions add one more level (`subagents/`). */
const MAX_DEPTH = 2

export interface PiAdapterOptions {
  /** Pi agent dir. Defaults to $PI_CODING_AGENT_DIR or ~/.pi/agent */
  piDir?: string
  maxText?: number
}

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p
}

export class PiAdapter implements TranscriptAdapter {
  readonly harness = HARNESS
  readonly sessionsDir: string

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

  createParser(path: string, emit: Emit): LineParser {
    return new PiSessionParser(path, emit, { maxText: this.opts.maxText })
  }
}

type Body = EventDraft extends infer T ? (T extends unknown ? Omit<T, 'ts' | 'harness' | 'sessionId' | 'agentId'> : never) : never

/** Parses one Pi session file. */
export class PiSessionParser implements LineParser {
  sessionId: string | undefined
  private cwd: string | undefined
  private model: string | undefined
  private titled = false
  private named = false
  private partial = false
  private turnOpen = false
  private lastTs: number | undefined
  private openCalls = new Set<string>()
  private readonly maxText: number

  constructor(
    readonly path: string,
    private emit: Emit,
    opts: { maxText?: number } = {},
  ) {
    this.maxText = opts.maxText ?? 4000
    // Fallback id from the filename for files whose header was skipped.
    this.sessionId = SESSION_FILE.exec(basename(path))?.[1]
  }

  markPartial(): void {
    this.partial = true
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
    if (!this.sessionId) return
    this.emit({ ts, harness: HARNESS, sessionId: this.sessionId, agentId: this.sessionId, ...body } as EventDraft)
  }

  private header(rec: Record<string, unknown>, ts: number): void {
    const id = str(rec.id)
    if (id) this.sessionId = id
    this.cwd = str(rec.cwd)
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
    for (const callId of this.openCalls) this.send(ts, { kind: 'tool.finished', callId, ok: false, output: 'interrupted' })
    this.openCalls.clear()
    this.turnOpen = false
    this.send(ts, { kind: 'turn.ended', outcome })
  }

  private message(m: Record<string, unknown>, entryId: string | undefined, ts: number): void {
    switch (m.role) {
      case 'user': {
        const text = humanText(contentText(m.content))
        if (!text) return
        if (!this.titled && !this.named) {
          this.titled = true
          this.send(ts, { kind: 'session.updated', meta: { title: firstLine(text, 80), titleSource: 'prompt' } })
        }
        this.startTurn(entryId, ts)
        this.send(ts, { kind: 'message', role: 'user', text: clip(text, this.maxText) })
        return
      }
      case 'assistant':
        return this.assistant(m, entryId, ts)
      case 'toolResult': {
        const callId = str(m.toolCallId)
        if (callId && this.openCalls.delete(callId)) {
          const text = contentText(m.content).trim()
          this.send(ts, {
            kind: 'tool.finished',
            callId,
            ok: m.isError !== true,
            output: text ? clip(text, OUTPUT_MAX) : undefined,
            durationMs: typeof m.durationMs === 'number' ? m.durationMs : undefined,
          })
        }
        return this.usage(m.usage, ts)
      }
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
    this.openCalls.add(callId)
    const args = isRecord(block.arguments) ? block.arguments : {}
    const d = describePiTool(name, args, this.cwd)
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
