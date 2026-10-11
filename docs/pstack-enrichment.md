# PStack enrichment

Mission Control can tell which agents in a Pi session are PStack workers, and group them
into runs. This page says how PStack actually shows up in persisted data, what is derived
from it, and what is not, because the data does not contain it.

The enrichment is a read-only layer over the generic agent tree:
[`packages/protocol/src/workflows.ts`](../packages/protocol/src/workflows.ts). It adds no
events and no fields to state, so it cannot disagree with the tree, and a restart rebuilds the
same answer. The Pi adapter knows nothing about PStack.

Checked against 270 real Pi session files and the installed `pi-open-agents` 0.1.22, the
user's agent definitions in `~/.pi/agent/agents/`, and a PStack run's own `.audit/` files.

## The workflow as it is recorded

The user's setup has a front agent, Chief, and PStack behind it.

```text
user  ─ discusses the task with Chief (primary agent)
Chief ─ prepares a worktree and a PStack prompt, then stops for the user's approval
user  ─ approves in chat
Chief ─ launches a `poteto-agent` with the approved prompt          ← run lead
          └─ the lead reads the poteto-mode skill and its playbook, and launches
             more `poteto-agent` workers, which may launch their own
Chief ─ launches further `poteto-agent`s for continuation, review, correction   ← more runs
user  ─ final test, then approves the merge
```

What a session file actually holds of that.

| Fact | Where it is recorded |
|---|---|
| Which primary agent is active (`chief`, `plan`, `build`…) | a `custom` entry `open-agents-state` with `data.name`. It is in 46 of 270 files (some are fork copies of others), and `chief` is in 1. |
| A PStack launch | a `subagent` tool call with `arguments.agent: "poteto-agent"`, `arguments.task`, `arguments.session` (`fork`) |
| The worker's identity | the same `arguments.agent`, and independently the worker's own system prompt, which has the line "You are an internal PStack worker." |
| Who launched whom | the Pi subagent link ([pi-subagents.md](pi-subagents.md)) |
| The approval gate, the four Chief phases | prose in Chief's prompt and chat text. Not structured, not parseable reliably. |
| `/poteto-mode` | never recorded as a command. Chief delegates by launching a `poteto-agent` whose task tells it to read the skill. |
| `/goal` | the `pi-goal` extension writes `custom` entries with `goal.{id, objective, status, tokensUsed}`. One file of 270 has one. Not tied to any PStack run. |
| Roles such as architect, frontend, reviewer | not recorded for PStack. Every PStack worker has the same definition, `poteto-agent`. The `reviewer`, `explore`, `researcher` definitions in the data are ordinary `pi-open-agents` subagents, not PStack. |
| Phases (planning, implementation, review) | not recorded anywhere. See below. |

PStack also writes `.audit/workflow.md` and `.audit/decisions.tsv` in the project. They are
free-form notes written by the agents (milestones are the project's own, `M0` to `M11`),
different in every project, and outside the transcripts the observer reads. They are not used.

## What is derived

| Field | Source | Confidence |
|---|---|---|
| `kind: pstack` | the agent's definition name (`agent.role`) is `poteto-agent`, or its plugin or effort variants (`pstack:poteto-agent`, `poteto-agent-high`) | exact. In the real data 23 of 23 agree with the second signal, the worker system prompt. |
| `runId` | the id of the run's lead: the topmost PStack agent above this one | exact, structural |
| `tier` | `lead` if no PStack agent is above it, else `worker` | exact, structural |
| `depth` | PStack agents between it and the lead | exact, structural |
| `hostAgentId` | the lead's parent: the agent that launched the run (main, Chief, any other) | exact |
| `runIndex` | the run's position among the session's runs, by start time | derived. Stable once all agents are loaded. |
| delegated task | `agent.task`, the `subagent` call's `task` text | exact. It is prose, shown as written. |
| run status | `waiting` if any agent waits, else `running` if any works, else `done`, from the existing agent statuses | reliable, and as accurate as those statuses |
| `parentToolCallId` | unchanged, from the Pi adapter | exact |

## What is not derived, and why

- **Role.** PStack has no role names to read. A worker's job exists only in its task text. Labels
  like Architect or Reviewer would have to be guessed from wording, and PStack's own prompts tell
  Chief not to run a fixed architect, coder, reviewer pipeline, so they would often be wrong.
- **Phase.** Not persisted. Task texts are free-form and mostly open with the same boilerplate
  ("Read the poteto-mode skill in full…"), so even an anchored phrase match has nothing stable to
  anchor to. The 25 distinct task texts in the data have no common structure that separates
  planning from implementation from review. Nothing in this milestone invents one.
- **Poteto versus PStack.** One concept in the data. The worker is `poteto-agent`, it describes
  itself as a PStack worker, and the skill that drives it is `poteto-mode`. There is no persisted
  signal that separates an execution mode from an orchestration workflow, so there is one kind, `pstack`.
- **Goal of a run, reason for delegation, retries, review target, outcome.** The only goal record
  is session-level `pi-goal` state, shown as the session's goal. Chief's "continuation", "corrective"
  and "pickup" rounds are separate launches whose relation to earlier ones is stated only in prose.
- **Parallelism.** Visible from the tree and start times. Not a field.

## Runs

A run is one top-level PStack launch and everything below it. Chief launches several in a
session (one per round), so one session shows several runs, numbered by start. In the real
Chief session there are five. Runs are never merged because they share a session, and a
generic agent inside a run (or one that launches a PStack worker of its own) does not pull
anything into or out of a run.

Nesting stays as the tree has it. `depth` counts PStack agents only, so a generic helper between
two workers does not change a worker's depth or its run.

## In Mission Control

In a session's Agents tab, each PStack agent gets a badge: `PStack · run 2 · 3 agents · done`
on a run's lead (hover for who launched it and its task), and `PStack · run 2` on its workers.
Searching `pstack` finds sessions that have PStack agents. Ordinary agents look as before.
Project filtering is unchanged: the badges are computed from the filtered session.

## Real data

| | |
|---|---|
| Sessions | 81, of which 4 contain PStack agents |
| Subagents | 189 linked |
| PStack agents | 23 (15 leads, 8 workers). Deepest nesting: 2 workers below a lead. |
| PStack runs | 15 |
| Ordinary subagents left generic | 166 (`explore` 80, `reviewer` 76, `researcher` 10) |
| Agents with an explicit role | 189 of 189 (the definition name). With a PStack role name or phase: 0, none exist. |
| Agents with a phase | 0, not recorded |
| Classification vs the worker system prompt | 23 of 23 agree. The only 2 other PStack-prompt files are the 2 unlinked fork copies. |
| Run status | 14 done, 1 running (a round whose worker never finished) |

## Extending

Another workflow is one entry in `WORKFLOWS`: a name, and a test on what the harness recorded
(the agent definition). It must not read the task text. A source of phase or role that PStack
may persist later (a structured record, a tool argument) would extend `AgentWorkflow` with an
optional field and one more derivation here.
