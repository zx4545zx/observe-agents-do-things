# Pi support: handoff

Milestone 1 of native Pi monitoring. Pi is a built-in harness (`pi`) beside Claude Code
and Codex. The format and mapping are in [pi-adapter.md](pi-adapter.md).

## Implemented

- `PiAdapter` and `PiSessionParser` in `packages/core/src/adapters/pi.ts`, registered in `Observer` and exported from `@oadt/core`.
- Pi is in the default harness list. `--harness pi` selects it alone. `--pi-dir`, `$PI_CODING_AGENT_DIR` and `$PI_CODING_AGENT_SESSION_DIR` locate it.
- `describePiTool` (`tools.ts`) and `piChanges` (`diff.ts`) give Pi tool calls a category, a title, the files touched and a line diff for edits and writes.
- `'none'` joins the permission modes that never ask (`status.ts`).
- UI recognises the harness: colour and label (`theme.ts`), badge and heartbeat colour in Mission Control, the VS Code notification label, and the empty-state text. No Pi-specific rendering.
- 7 tests in `packages/core/src/pi.test.ts`, and the docs.

## Architecture decisions

- **Reuse, no new watcher.** The adapter implements `TranscriptAdapter`. Discovery, watching, tailing, backfill and restart are unchanged shared code.
- **One parser, one state.** The parser keeps only the open tool-call ids, the model, and flags for turn and title. Every other fact comes from the line in hand, so restarting re-reads the file and lands in the same state.
- **Turns are derived.** Pi has none. A turn starts at the first user or assistant message after the last turn ended, and ends on an assistant `stop`, `length`, `error` or `aborted`. Calls still open at that point are closed as interrupted.
- **No approval waiting for Pi.** Pi core cannot prompt for approval, so the header sets `permissionMode: 'none'`. This stops the existing "awaiting approval" heuristic from flagging every long `bash` call.
- **Tool table is display only.** Seven Pi built-ins get a category. Every other tool, including extension tools, appears as `other` under its own name.
- **No PStack or Poteto logic.** Nothing in the parser looks at agent names, commands or skills.
- **Fixtures are inline.** The existing tests build synthetic transcripts in code, so the Pi tests do too. No file in the repo contains real session text.

## Verified

| Check | Result |
|---|---|
| Baseline before changes | `npm ci`, typecheck, `npm test` (36 of 36), build all passed. There is no lint script. |
| After changes | typecheck passes. `npm test` 43 of 43, 7 new. `npm run build` passes. |
| Real data sweep | Parser over all 270 local Pi files. No exceptions. 38,242 tool starts, 38,238 finishes, 0 finishes without a start, 0 duplicate starts. The 4 unmatched starts are calls that never got a result. |
| Real UI | Server run with `--harness pi --since 24h` against the real `~/.pi`. 59 sessions backfilled in 232 ms. Mission Control showed them with the Pi badge, project, model, tool, error and token counts. |
| Live Pi run | Not done. Driving a real `pi` turn would spend model credits. Tailing is covered by a test that appends to a session file, including a half-written line. |

Commands: `npm ci`, `npm run typecheck`, `npm test`, `npm run build`,
`node packages/server/dist/cli.js sessions --harness pi --since 3d`.

## Known limits and unsupported events

- Subagents are separate, unlinked sessions. See "Subagents" in pi-adapter.md.
- No context window, so no context percentage. No provider in the UI. No thinking level.
- `custom_message`, `custom`, `context_edit`, `label` and `system` entries are ignored. Extension-injected text is therefore not shown.
- `usage`, `branch_summary`, `session_info` and `bashExecution` are handled from Pi's documentation only. None appear in the local data, so they are unit-tested but not seen on a real file.
- Branches are read in file order, not by the current leaf.
- Pi's `sessionDir` setting is not read.
- Malformed lines are skipped without a log entry, as in the other adapters.

## Recommended next milestone

1. Project and workspace filtering from `meta.cwd`.
2. Pi subagent hierarchy. First find a reliable link between a parent's `subagent` call and the child file.
3. PStack and Poteto enrichment as a layer over the normalized events.
4. Custom monitoring UI.
5. Desktop packaging.
