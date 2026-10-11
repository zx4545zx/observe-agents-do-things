# Pi adapter

`oadt` reads the session files Pi already writes. Pi needs no plugin, extension or
wrapper, keeps working when `oadt` is closed, and is never written to.

Code: [`packages/core/src/adapters/pi.ts`](../packages/core/src/adapters/pi.ts).
Tests: [`packages/core/src/pi.test.ts`](../packages/core/src/pi.test.ts).
The format reference is Pi's own `docs/session-format.md` and `docs/message-types.md`,
checked against 270 real session files (about 70,000 messages) on the machine this was built on.

## Session discovery

| | |
|---|---|
| Harness id | `pi` |
| Agent dir | `--pi-dir`, else `$PI_CODING_AGENT_DIR`, else `~/.pi/agent`. A leading `~` is expanded. |
| Session root | `<agent dir>/sessions`. `$PI_CODING_AGENT_SESSION_DIR` moves it when `--pi-dir` is not given. |
| Layout | `sessions/--<cwd>--/<timestamp>_<session-id>.jsonl`. `<cwd>` is the working directory with the leading `/` dropped and `/`, `\` and `:` turned into `-`. |
| File name | `2026-10-10T17-13-41-605Z_01a126ce-5fe5-7731-8b01-8c0433d2f3ba.jsonl`. Only names of this shape are read, so stray files in the tree are ignored. |
| Depth | Up to two directories below the root. That covers `--<cwd>--/` and the `--<cwd>--/subagents/` directory some extensions use. |
| Session id | `id` in the header line. Falls back to the id in the file name when the header was not read. |
| Working dir | `cwd` in the header. It is not decoded from the directory name, because that encoding is lossy. |

Pi's `sessionDir` setting in `settings.json` and its `--session-dir` flag are not read.
If you use either, point `--pi-dir` or `PI_CODING_AGENT_SESSION_DIR` at the real location.

Discovery, the recursive watch, polling, tailing, backfill and restart behaviour are
the shared `TranscriptWatcher` and `FileTail`. Pi adds no watcher code. A half-written
last line stays buffered until its newline arrives. Valid JSON that is not a record
Pi writes, and lines that are not JSON, are skipped.

## What a Pi session file contains

One JSON object per line. The first is the header, the rest are tree entries linked by
`id` and `parentId`. Counts below are from the 270 local files.

| Entry `type` | Seen | Notes |
|---|---|---|
| `session` | 270 | `version` (3), `id`, `timestamp`, `cwd`, optional `parentSession` for forks. `version` is the file format, not Pi's version. |
| `message` | 70,178 | Wraps a message. Roles seen: `toolResult` 38,180, `assistant` 30,560, `user` 1,137, `system` 301. The docs also define `bashExecution`, `custom`, `branchSummary`, `compactionSummary`. |
| `model_change` | 378 | `provider`, `modelId`. |
| `thinking_level_change` | 663 | `thinkingLevel`. |
| `custom` | 3,337 | Extension state. Not part of the conversation. |
| `custom_message` | 58 | Extension text injected into the model's context, for example goal reminders. |
| `compaction` | 93 | `summary`, `tokensBefore`, optional `usage`. |
| `context_edit` | 130 | Edits what a later request sends. |
| `usage`, `branch_summary`, `session_info`, `label` | 0 | In Pi's docs, not in the local data. |

Findings that shaped the adapter.

- **Messages are complete.** Pi never persists a streaming partial. An assistant
  message holds all of its `thinking`, `text` and `toolCall` blocks, so nothing is
  merged and no message can be duplicated.
- **Tool calls and results are separate messages.** A `toolCall` block has an `id`.
  The `toolResult` message names it in `toolCallId`. Ids can contain `|`.
- **The call is written before it runs.** Tool-call blocks land in the file when the
  model finishes, so a started call with no result yet really is in flight.
- **Stop reasons seen.** `toolUse` 29,290, `stop` 1,031, `error` 161, `aborted` 78.
  The docs also list `length`, `pending` and `deferred`. Pi does not persist `pending`.
- **Usage.** `input`, `output`, `cacheRead`, `cacheWrite`, optional `reasoning`, and
  `cost`. `reasoning` is already inside `output`. Aborted and failed messages carry all zeros.
- **No turn records.** Turns are inferred, see the table.
- **Tool arguments.** `read`, `write` and `edit` take a `path` that is usually relative
  to the session cwd. `edit` takes `edits: [{ oldText, newText }]`. `write` takes `content`.
- **Branching.** `/tree` and `/fork` branch inside the file or copy history into a new
  file. Entries are read in file order, so the view follows what Pi did, not the current branch.

## Pi to OADT mapping

| Pi data | OADT event | Notes |
|---|---|---|
| `session` header | `session.started` | `cwd`, `project` (its basename), `transcriptPath`. `permissionMode` is `none`, see below. |
| `session_info.name` | `session.updated` title (`custom`) | Wins over the prompt title. |
| First user message | `session.updated` title (`prompt`) | Also `message` with role `user`. Injected content is filtered by `humanText()`. |
| `user` message | `turn.started` (if none open) and `message` | Text and `[image]` placeholders only. |
| `assistant` text block | `message` role `assistant` | |
| `assistant` thinking block | `thinking` | Text is dropped for `redacted` blocks. Signatures are never read. |
| `assistant` toolCall block | `tool.started` | `callId` is the Pi id. Category, title and files come from the tool name, see below. `input` is compacted. Edits and writes carry a line diff in `changes`. |
| `toolResult` message | `tool.finished` | `ok` is `!isError`. Output is clipped to 2,000 characters. `durationMs` is Pi's. A result with no matching start is ignored. |
| `toolResult.usage` | `usage` | Nested model work done by a tool. |
| `assistant.usage` | `usage` | Delta per message. `contextTokens` is `input + cacheRead + cacheWrite`. |
| `assistant` `stopReason` `stop` or `length` | `turn.ended` completed | |
| `stopReason` `aborted` | `turn.ended` aborted | Calls still open are closed as interrupted. |
| `stopReason` `error` | `note` warn, then `turn.ended` error | The note carries `errorMessage`. |
| `assistant.model`, `model_change.modelId` | `session.updated` model | Announced when it changes. The provider has no field in `SessionMeta` and is not shown. |
| `compaction` | `note` info, and `usage` from its `usage` | |
| `branch_summary`, standalone `usage` entry | `note`, `usage` | Defined by Pi's docs, not seen locally. |
| `bashExecution` message | `tool.started` and `tool.finished` | A command the user ran with `!`. `ok` when not cancelled and exit code 0. |

Tool names map through `describePiTool` in `tools.ts`. The table is for display only,
and any other name is shown as `other` with its own name as the title.

| Pi tool | Category | Title |
|---|---|---|
| `read` | read | `Read <path>` |
| `write` | write | `Write <path>` |
| `edit` | edit | `Edit <path>` |
| `bash` | shell | `$ <first line>` |
| `grep`, `find`, `ls` | search | `Grep "<pattern>"`, `Find <pattern>`, `List <path>` |
| anything else | other | the tool name |

## Not derived, on purpose

- **Context window.** It is not in the file. `contextTokens` is set and `contextWindow` is left unset, so no percentage is shown.
- **Pi version and provider.** Not recorded in a form `SessionMeta` has a field for.
- **Approval prompts.** Pi has no permission gate in core. The header event sets
  `permissionMode: 'none'`, which the status heuristic treats as "never asks". Without
  it, any `bash` call over 8 seconds would be shown as awaiting approval. An extension
  that adds its own gate is not visible in the transcript.
- **Thinking level.** `thinking_level_change` has no OADT field.
- **`system`, `custom`, `custom_message`, `context_edit`, `label`.** Not conversation. Extension and injected text is not shown as if the user typed it.
- **Subagents.** See below.

## Subagents

Some extensions run a subagent as a separate Pi session in `--<cwd>--/subagents/`.
In the local data that is 191 of 270 files. Those files are ordinary Pi sessions, so
they appear as their own sessions next to the main one, with the task prompt as the title.
Nothing in the file says which session spawned them. `parentSession` is Pi's `/fork`
link, not a spawn link, and the parent's `subagent` tool call is an extension's convention.
The adapter does not guess. Linking them into the agent tree needs that extension's
conventions and is left for the next milestone.

## Limits

- Sessions older than the backfill window (`--since`, default 6 hours) are not loaded
  at startup. They are picked up when written to.
- Large files are read as the first 512 KiB plus the last 8 MiB, like the other adapters.
  `partialHistory` is set when that happens.
- Each rescan lists the session tree and stats every `.jsonl`. That is cheap at hundreds
  of files. Thousands of historical files would make it grow linearly.
- The Docker setup mounts `~/.claude` and `~/.codex` only. Mount `~/.pi/agent` the same way to watch Pi there.
