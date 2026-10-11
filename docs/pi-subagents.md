# Pi subagents

Pi has no subagent concept and records no parent for a session. Subagents come from
extensions. This page says what that means for the data, how `oadt` rebuilds the parent
link anyway, how sure it can be, and what it leaves alone.

Everything here was checked against 270 real Pi session files (79 sessions and 191 subagent
sessions) and the source of the extension that makes them, `pi-open-agents` 0.1.22.

## How subagent sessions are stored

`pi-open-agents` adds a `subagent` tool. A call runs the subagent as a separate Pi process
(`pi --mode json -p … --session-dir <sessions>/--<cwd>--/subagents "Task: <task>"`,
`src/subagent/executor.ts`). That process writes an ordinary Pi session file of its own in
the project's `subagents/` folder. Facts about those files.

- **The header names no parent.** It has `id`, `timestamp` and `cwd`, like any session.
- **The first message is `Task: <task>`.** The prefix and the task are written by the
  extension (`buildTaskArgument`). Tasks over 8,000 characters are passed as `Task: @file`
  instead (`TASK_FILE_THRESHOLD`).
- **Fork mode.** With `session: "fork"` the extension branches the launcher's session into
  the child (`createBranchedSession`). The child file then starts with the launcher's history,
  copied with its original timestamps, and its header carries Pi's own `parentSession` path.
  Without `fork`, or when forking is not possible, the child starts empty. 32 of the 191 are forks.
- **The launcher records the call.** The assistant message holds a `toolCall` named
  `subagent` with `arguments.agent` and `arguments.task`. The result carries
  `details.{agent, status, startedAt, elapsedMs, output, model, usage, session}`. `startedAt` is the
  epoch time just before the child process starts. Nothing in the result names the child's file.
- **Launches from `codemode`.** When the call is made from inside a `codemode` script, the
  launcher has only a `codemode` call. Pi records the inner calls on the result as
  `nestedCalls.calls[]` with `name`, `status` and `arguments`, so the task is still there.
- **Environment variables** such as `PI_OPEN_AGENTS_DEPTH` reach the child process but are
  not written to its session file.

So there is no persisted parent id, call id or spawn id anywhere in the child. The link
has to be derived.

## How the link is derived

A child is linked to a launch when all of these hold.

1. The child's first message after its header is `Task: <task>`, and the launcher recorded a
   `subagent` call (or a `nestedCalls` entry) whose task is exactly that text.
2. The time fits. When the launcher's result is known, the child's header is within
   -1 s to +10 s of `details.startedAt`. Otherwise it falls inside the span from the call being
   written to its result arriving.
3. That launch has not already been claimed by another child.
4. For a fork child, `parentSession` names the same session file as the launcher.
5. Exactly one launch satisfies 1 to 4. Zero or several means no link.

Nothing about names, roles or paths is used. The extension's agent name (`reviewer`,
`explore`, a custom one) is passed through as the agent's `name` and `role`, nothing more.

A launcher is read before its children because files are ordered by the creation time in
their file name. A launcher too large to be read whole has its launch records read from the
skipped part once, so large orchestrating sessions link too.

### What it produces

A linked child is not a session of its own. Its events are filed under the launcher's session
as a child agent, which is how Claude Code and Codex subagents already look.

| Event | Source |
|---|---|
| `agent.spawned` | `parentAgentId` is the launching agent (the session's main agent, or another child for nesting). `parentToolCallId` is the launcher's `subagent` call, absent for `codemode` launches. `name` and `role` are `arguments.agent`. `task` is the task, clipped. |
| the child's messages, thinking, tools, usage, errors | as for any Pi session, with `agentId` set to the child's session id. Its first message has role `agent`. |
| lifecycle | The child is done when its own turn ends, or when the launcher's `tool.finished` for the call arrives (calls only, not `codemode` launches). Neither is guessed from a file going quiet. A child with neither falls under the existing "inactive for 5 minutes" rule, as every harness's subagents do. |

The child's conversation, tool calls, model, tokens and file changes are all kept, on its
agent. Entries a fork copied from the launcher are not replayed, because they are the
launcher's own activity and would count twice.

## Evidence

| Check on the real store | Result |
|---|---|
| Subagent session files | 191 (159 fresh, 32 forks) |
| Linked to a launch | **189** |
| of which through a `subagent` call, with `parentToolCallId` | 183 |
| of which through `codemode` `nestedCalls`, without it | 6 |
| Not linked | **2** |
| Fork children whose `parentSession` agrees with the derived launcher | 30 of 30 |
| Linked children where the launch's recorded `details.output` equals the child's final message | 178 of 178 comparable (5 have no comparable text) |
| Children with more than one candidate launch | 0 |

The last two are independent of the matching rules. `parentSession` comes from Pi itself, and
the output comparison uses text the matching never looks at.

The 2 not linked are fork copies with no entries of their own: a header and the launcher's
history, and nothing the child did. There is nothing to show for them and no launch to tie
them to. They appear as empty sessions.

Loading the whole store through the real observer gives 81 sessions and 270 agents (81 main
agents and 189 children), 8 of them nested more than one level deep, in about a second.
Before linking it was 270 sessions.

## What is not supported

- **Other extensions.** Only the `pi-open-agents` convention is read: a tool named
  `subagent` with a string `task`. `pi-herdr-agents` and `@pi-orca/agents` use other
  mechanisms. Their sessions stay ordinary sessions. Another convention is a few lines in
  `PiSessionParser` (the launch) and the `Task:` prefix.
- **Tasks over 8,000 characters** (`Task: @file`). None exist in the local data.
- **Identical simultaneous launches.** Two calls with the same task text and indistinguishable
  times link neither child. The children stay sessions of their own.
- **Launches seen late.** A `codemode` launch is only recorded when its call finishes, so a
  child that appears live before that stays a separate session until the observer restarts.
  Top-level `subagent` calls are recorded when they start, so they link live.
- **A launcher outside the backfill window** (default 6 hours, `--since`). A launch that
  has been running longer than that has an unread launcher, so its child is a separate session.
- **A child before its launcher.** The launcher is read first on startup. A launcher that
  first appears after its child was already shown does not claim it.
- **Failure and cancellation as a state.** The protocol has `done`, not `failed`. A failed
  launch shows through the launcher's failed `tool.finished` and the child's own error note.
  In the data, 4 launches never got a result at all, and their children stay `working` until
  the inactivity rule closes them.

## For PStack and Poteto enrichment

Built, as a read-only layer: see [pstack-enrichment.md](pstack-enrichment.md). What it relies on is below.

What a later layer can rely on, from the normalized events and with no new parsing.

- Parent and child agents, with `parentToolCallId` where the launch was a call.
- `agent.spawned.name` and `role` carry the extension's agent definition name, and `task`
  carries the full delegation text. That is where a role like architect or reviewer would be
  read, by the enrichment layer rather than here.
- The launch's own result (`details.output`, `status`, `usage`, `model`) is on the parent's
  `tool.finished` output and is not yet exposed as structured fields.
- Not available from Pi data at all: a plan, a phase, or why a launch happened. Those would
  come from the delegation text, or from state the extension writes elsewhere
  (`~/.pi/agent/pi-herdr-subagents/runs` exists but was empty on the machine checked).
