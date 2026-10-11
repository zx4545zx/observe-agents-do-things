# Pi support: handoff

Pi is a built-in harness (`pi`) beside Claude Code and Codex. Format and mapping are in
[pi-adapter.md](pi-adapter.md), subagents in [pi-subagents.md](pi-subagents.md).

## Milestone 1: native Pi monitoring

- `PiAdapter` and `PiSessionParser` (`packages/core/src/adapters/pi.ts`), registered in `Observer` and exported from `@oadt/core`. It uses the shared watcher, tailer and backfill, with no code of its own for those.
- Pi is in the default harness list. `--harness pi`, `--pi-dir`, `$PI_CODING_AGENT_DIR` and `$PI_CODING_AGENT_SESSION_DIR` control it.
- `describePiTool` and `piChanges` give tool calls a category, title, files touched and diffs.
- `permissionMode: 'none'` for Pi, because it has no approval gate. Without it a long `bash` call would be shown as awaiting approval.
- Turns are derived from message roles and stop reasons, because Pi writes none.

## Milestone 2: project filtering and subagent linking

### Project filtering

- `packages/protocol/src/projects.ts`: `projectKey`, `listProjects`, `resolveProject`, `filterWorld`, `UNKNOWN_PROJECT`. Pure functions over a `WorldState`, so any frontend can use them. A project is the session's `meta.cwd`, normalised (trailing slash, `\`, Windows case). Same folder names in different places get longer labels. No cwd means *Unknown Project*.
- Mission Control gets a project list beside the activity bar (chips on narrow screens, hidden when there is nothing to choose between). A scoped world is computed once per event from the live state and drives the sessions, agents, activity, diffs, detail and numbers. The choice is stored in `localStorage` through the existing settings (`mission.project`).
- It does not branch on harness. A missing remembered project shows everything and is not forgotten.
- Not filtered on purpose: the title-bar attention count and the Needs attention view, and desktop notifications, so an approval elsewhere is never hidden. Agent Office is untouched.

### Pi subagents

Outcome A: a generic link can be proven from persisted data.

- Pi stores no parent. `pi-open-agents` runs each subagent as its own Pi process and the child file names no parent.
- The link is rebuilt from the child's first message (`Task: <task>`), the launcher's recorded `subagent` call or `codemode` `nestedCalls` entry with the same task, and a start time that fits. Exactly one match links, otherwise nothing does. Fork children must also agree with `parentSession`.
- A linked child becomes an agent of the launcher's session, with `parentAgentId` and, for calls, `parentToolCallId`. Its conversation, tools, model, usage and file changes stay on that agent.
- Files that fork a session no longer replay the history they copied.
- A launcher too large to be read whole has its launch records read from the skipped middle once.

Real store (270 files): 79 sessions and 191 subagent files. **189 linked** (183 with a parent tool call, 6 through `nestedCalls`), **2 not linked** (fork copies with no entries of their own). Cross-checks: 30 of 30 fork children agree with Pi's `parentSession`, and 178 of 178 comparable links have the launch's recorded output equal to the child's final message. No child had more than one candidate. The observer loads all of it in about a second as 81 sessions with 270 agents.

## Milestone 3: PStack enrichment

[pstack-enrichment.md](pstack-enrichment.md) has the research and the evidence.

- `packages/protocol/src/workflows.ts`: `workflowIndex`, `workflowOf`, `workflowRuns`, `workflowLabels`, and a `WORKFLOWS` table with one entry, PStack. A pure read-only layer over the agent tree. It adds no events and no state, and the Pi adapter is unchanged by it.
- An agent is a PStack worker when the harness recorded its definition as `poteto-agent` (or the plugin and effort variants). Runs are one top-level worker with everything PStack below it. Each agent gets `runId`, `runIndex`, `tier` (lead or worker), `depth` and `hostAgentId`. A run gets a status aggregated from the agents.
- Mission Control's Agents tab shows `PStack · run N · …` badges, and search finds sessions by workflow name.
- Not derivable from the data, and not invented: role names (every worker is `poteto-agent`), phase, and Poteto as a separate concept from PStack.
- The Pi adapter now also reports the `pi-goal` extension's goal as the session's goal and goal status.

Real store: 23 PStack agents (15 leads, 8 workers) in 4 sessions, 15 runs, 166 ordinary subagents left generic. All 23 agree with the independent worker-system-prompt signal.

## Architecture decisions

- **Reuse.** No new watcher, store or state model. Subagents use `agent.spawned` and the projection's existing parent and tool linking. Projects are a selector over `WorldState`.
- **One shared index, no persistence.** Parent parsers record launches in an index owned by the adapter, and a child parser claims one. It is rebuilt from the files every start, so restarts agree.
- **Held until decided.** A session's first events are held until its first user message says whether it is a launched subagent, so a child never appears as a session first and an agent later.
- **No heuristics.** Matching needs exact task text, a time fit, an unclaimed launch and a single candidate. Ambiguity means no link.
- **No PStack or Poteto logic.** The extension's agent name is passed through as `name` and `role` and never inspected.

## Verified

| Check | Result |
|---|---|
| Baseline before milestone 2 | typecheck, `npm test` 43 of 43, build all passed |
| After milestone 2 | `npm test` 56 of 56 (13 new) |
| After milestone 3 | typecheck passes. `npm test` 62 of 62 (6 new). `npm run build` passes |
| Mutation checks | removing the ambiguity rule, the fork check or the skipped-middle scan each fails a test |
| Real UI | server on real `~/.pi` and `~/.claude`: 30 sessions, project list, filtering, persisted selection after reload, narrow layout |
| Real store | counts above |

Commands: `npm run typecheck`, `npm test`, `npm run build`, `node packages/server/dist/cli.js sessions --harness pi --since 3d`.

## Known limits

- Only the `pi-open-agents` convention is linked. Other subagent extensions stay ordinary sessions.
- Tasks over 8,000 characters (`Task: @file`), identical simultaneous launches, and a launcher outside `--since` are not linked.
- A `codemode` launch links only after its call finishes, so live it shows as a separate session until a restart.
- A session appears with its first user message.
- No context window or provider for Pi. `custom_message`, `custom`, `context_edit`, `label` and `system` entries are ignored. Pi's `sessionDir` setting is not read.
- `usage`, `branch_summary`, `session_info` and `bashExecution` are handled from Pi's docs and tested synthetically, not seen in the local data.
- Persisted project selection is verified in the browser, not in an automated test, because the web app has no test runner. The selection and fallback logic is tested.
- Agent Office does not filter by project.

## Next: custom monitoring UI

The data it needs is in place: parent and child agents with `parentToolCallId`, each child's `name`, `role` and delegated `task`, its own events, project keys, and per-session PStack runs with tier, depth and status. PStack workers still have no role name or phase, because the data has none. A design that needs them needs PStack to record them first, for example as a structured argument on the `subagent` launch.
