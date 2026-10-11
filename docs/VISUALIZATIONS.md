# Visualizations

The web app is a thin **host**. It connects to the observer once and mounts
one **visualization** at a time. A visualization is not a theme or a skin. It
owns everything inside its element:

- its DOM and layout (sidebars, HUDs, panels, or none at all)
- its rendering technology (canvas 2D, SVG, WebGL, a framework, plain HTML)
- its own input handling, camera, animation loop and styles
- its own *interpretation* of the data (a dashboard, an office building, a table…)

What it does **not** do is parse transcripts, derive agent status or link
subagents. That all happens in the core, and the visualization reads it from
the live `WorldState` and the event stream.

Choose which visualization to show in **Settings › Visualizations** (the `⚙` button in every
visualization, or `Ctrl+,`). Each visualization has its own page there for its options, such as
Mission Control's theme. `?viz=<id>` in the URL and the `V` key also switch.

## Built in

| | |
|---|---|
| **Mission Control** (`mission`, the default) | A compact IDE-style dashboard: what needs you, what is running, and how fast, with a blob buddy per agent. Themeable. See below. |
| **Agent Office** (`office`) | A cute isometric office. Each session is a room and each agent a little blob. See below. |

### Mission Control

![Mission Control in Gruvbox Dark](images/mission-gruvbox.png)

Built for daily use on a second monitor:

- **Needs attention.** Approvals waiting (with a live timer), finished turns ready for review, failure streaks, context almost full, and tools that have run unusually long. Acknowledge items one by one, or clear them all with `X`.
- **Notifications.** Off by default. Turn on desktop notifications, a chime and the tab-title count on the settings page, and choose which kinds alert you. They work in every visualization, not just this one.
- **Buddies.** Each session tile has a blob buddy (drawn by [blobatar](https://github.com/Alain00/blobatar)) whose face, motion and prop follow what the agent is doing: a pencil and typing bounce while editing, a magnifier while searching, a terminal while running a command, a hop and a "!" when it needs approval, a red ✕ and a shake when a tool fails, sparkles when a turn finishes and Zzz when idle for long. Busy subagents appear as tiny buddies beside it, the drawer shows a large one, and each agent in the Agents tab has its own. Poses are held briefly so a burst of quick tools does not flicker.

  ![Buddies for each activity](images/buddies.png)

- **Live overview.** KPIs (live sessions, working agents, tools/min, tokens/min, recent errors), a smoothly scrolling throughput chart by tool kind, and compact session tiles. Each tile shows what the session is doing right now with a ticking timer, a heartbeat line that spikes on every tool call, and a context gauge.
- **Live diffs.** Edits stream in as coloured diffs the moment an agent makes them (Claude Code's Edit, MultiEdit and Write, Codex's apply_patch) and replay as if typed: removed lines are struck in, then the new code types itself out behind a caret. A running feed of every tool call sits beside them. Expand a diff for the full change.
- **Session drawer.** Open a session (click a tile, or `Enter`) to slide in its Activity (every tool call with input and output), Diffs, Chat, Agents (the tree and what each is waiting on) and Files. Pin it in Settings to keep it docked instead.
- **Monitor layout.** A project list on the left, the monitor in the middle, and a side panel on the right (a drawer, or docked with the pin). The monitor reads top to bottom: a one-line summary (project, live sessions, PStack runs running, then tools and tokens per minute and errors, with a throughput chart), Needs attention, PStack runs, Other agents, Sessions, and the live diff and activity panes.
- **PStack runs.** Each run is a card: `Run 4`, its status (`RUNNING`, `WAITING` or `DONE`), `Lead + 2 workers`, how long it has run, and the session it belongs to. Under it the lead and workers are rows indented by depth, each with its status, the delegated task, what it is doing now (the open tool call, or `waiting for 2 agents` while it waits on workers) and its tool and token counts. A run that is still going comes first, then the rest newest to oldest, and the four most recent finished runs are shown (the rest behind *Show N older*). Runs are never merged: each launch is its own run. Only the real structure is shown: Lead or Worker, run number, depth, task and status. There are no role or phase labels, because the data has none.
- **Other agents.** Subagents outside any workflow (explore, reviewer, researcher and the like) are listed separately, busy ones first, with the run they work inside when a PStack worker launched them. A generic agent is never counted as PStack because of its name or task.
- **Agent and run detail.** Clicking an agent row opens the **Agent** tab: its place in the run, status, the full task, what it is doing now, its numbers, the files its calls touched and its recent tool calls. Clicking a run's header opens the **Run** tab: host, counts, the lead's task, the whole tree and recent activity across it. Both tabs sit beside the session's own Activity, Diffs, Chat, Agents and Files tabs. Only calls the observer still keeps are listed, and the tab says how many older ones are not.
- **Activity feed.** Tool calls and agents starting or finishing, newest first, each labelled with the agent (`Run 4 · Worker`, or its own name) and the session.
- **Search.** The filter box matches a session's title, project, branch and path, and also its agents' definitions and tasks, `pstack`, and run numbers such as `run 4`.
- **Scope of Needs attention.** The list and its counter follow the selected project and say so (`this project`, with how many more are waiting in other projects). The title-bar badge, the Needs attention view and notifications always cover every project.
- **Projects.** The list beside the activity bar groups sessions of every harness by working directory. Picking one filters the sessions, agents, activity, live diffs and the numbers on screen, using the state already in the browser, and is remembered across reloads. A remembered project that no longer has sessions shows everything and returns when it does. The title-bar count and the Needs attention view stay global so an approval in another project is never hidden. Agent Office does not filter yet.
- **Themes.** Dark Modern, Light Modern, Gruvbox Dark and Gruvbox Light, or follow the system, in Settings › Visualizations › Mission Control.

Keys: `/` filter, `J`/`K` move between sessions, `Enter` open, `Esc` close, `1`–`5` drawer tabs, `X` acknowledge all.

Everything animates in and out (new rows, diffs, tiles, counters) and respects `prefers-reduced-motion`.

### Agent Office

![Agent Office by day](images/office-day.png)

How the data maps onto the office:

| What happens | What you see |
|---|---|
| A session | A room with the team's colour on the rug and the session title on a plaque by the door. Its lead is the same blob the session has in Mission Control |
| The main agent | The team lead, a blob in a headset, at the big two-monitor desk |
| A subagent is spawned | The phone rings at the parent's desk, the door swings open and a new blob hops in to a free desk |
| A subagent finishes | It takes a coffee break on the couch, then heads home through the door |
| A tool call | The blob bobs along (typing, peering, humming, depending on the tool), its screen glows in the tool's colour and a chip shows what it's doing |
| Reading files | Papers fly from the filing cabinet to the desk |
| Editing files | The blob types the diff out in a bubble beside it (the changed lines, with a caret), stamps it FILED and sends it flying to the front desk, where the full diff card lands |
| A tool fails | A puff of smoke, a red ✗ and a queasy face for a few seconds |
| Thinking | A thought cloud with bubbling dots and a pensive face |
| Waiting on you (permission prompt) | The blob hops in place with a scared face, a "!" bubble bounces and an amber ring pulses on the floor |
| Your prompt | A paper airplane flies in through the window to the lead, and the note pops up "FROM YOU" |
| An assistant message | A speech bubble |
| A question for you | A "?" bubble and a shy face |
| A plan / todo update | The whiteboard shows checkboxes and the current step |
| A finished turn | Confetti and a little jump |
| Long idle | Zzz |

There are also real details: the wall clock shows your time, the wall screen by
the door charts the session's tool calls over the last 15 minutes, the windows
follow day and night (click the clock to force day or night, or use
`?time=day`), desk lamps and the floor lamp switch on after dark, the coffee
machine steams, and there's an office cat.

Everything is drawn procedurally on a canvas, no image assets: one light
source shades every face, furniture casts soft shadows, and night is a
multiply wash with the lamps and screens added back on top. The blobs are
[blobatar](https://github.com/Alain00/blobatar) faces drawn as canvas paths,
seeded exactly as in Mission Control, so an agent looks the same wherever you
meet it; the expression and body motion follow the shared activity model.

Click any blob for its profile card: mood, role, model, current task, recent
tools and the files it just changed, and for the lead the session's turns,
cost and context fill. Drag to pan and scroll to zoom. `F` fits the view, `L`
toggles name tags, `D` toggles the front desk sidebar, `A` shows all rooms,
`J`/`K` step through rooms and `X` acknowledges everything.

The **front desk** sidebar (toggle with `D` or in Settings; it never
covers the office) shares Mission Control's attention queue: approvals,
finished turns, failure streaks, nearly full context and long-running tools,
each with a ✓ to acknowledge. Click an item to jump to that room and agent.
Under it, **Filed diffs** holds the latest changes from the rooms on screen,
same cards as Mission Control's live diff feed (click one to expand); a
change only appears there once its bubble has been filed. The "need you"
sticky counts open items.

The office has the same themes as Mission Control (Dark, Light, Gruvbox Dark,
Gruvbox Light or follow the system). A theme colours the controls, the front
desk and the space around the rooms; day and night lighting is separate and
still changes the rooms themselves. Theme, name tags, the front desk and
lighting are all in Settings › Visualizations › Agent Office.

![Agent Office at night](images/office-night.png)

## Writing your own

Implement the `Visualization` interface from
[`apps/web/src/viz/types.ts`](../apps/web/src/viz/types.ts) and add it to
[`apps/web/src/viz/index.ts`](../apps/web/src/viz/index.ts):

```ts
import type { Visualization } from '../types'
import { Disposer } from '../types'
import { sessionList } from '@oadt/protocol'

export const ticker: Visualization = {
  id: 'ticker',
  name: 'Ticker',
  description: 'One line per session, like a stock ticker.',
  icon: '≡',
  settings: [{ key: 'compact', label: 'Compact rows', type: 'toggle', default: false }],
  mount(root, { client, controls, settings }) {
    const d = new Disposer()
    root.innerHTML = '<div class="ticker"><header></header><ul></ul></div>'
    root.querySelector('header')!.append(controls) // the settings button; leave it out and the host floats it
    root.classList.toggle('compact', settings.get<boolean>('ticker.compact'))
    const list = root.querySelector('ul')!
    d.add(client.onChange((world) => {
      list.replaceChildren(...sessionList(world).map((s) => {
        const li = document.createElement('li')
        li.textContent = `${s.status.toUpperCase()} ${s.meta.title ?? s.id} — ${s.counts.tools} tools`
        return li
      }))
    }))
    return { destroy: () => d.dispose() }
  },
}
```

The rules:

1. **Everything you need is on `ctx`.** `ctx.client` is the live data,
   `ctx.settings` stores your options (declare them in `settings` on the
   visualization and they get their own page under Settings › Visualizations),
   `ctx.setChromeTheme()` makes the settings dialog match your look, and
   `ctx.attention` shares what needs the
   user, including acknowledgements. On the client, `client.world` is the live
   `WorldState`. `client.onChange((world, events) => …)` fires at most once
   per microtask with the new events. `client.sessionEvents(id)` gives history.
   The selectors in `@oadt/protocol` (`sessionList`, `agentTree`, `openTools`,
   `hotFiles`…) cover most derived views.
2. **Clean up in `destroy()`.** `Disposer` helps: `d.add(unsubscribe)`,
   `d.listen(window, 'keydown', fn)` and `d.loop(frame)` for a
   requestAnimationFrame loop that stops on dispose. The host removes your
   element afterwards.
3. **Don't assume you mounted first.** The client may already be live with a
   full world when you mount, so render from `client.world` straight away.
4. **Keep styles scoped.** Every visualization's CSS ends up in the same
   bundle. Prefix your classes (the office uses `of-`).
5. **If two visualizations need the same derived data, put it in the core.**
   That keeps them honest and lets frontends outside the web app, like the
   terminal dashboard and React hooks, have it too.

Outside the web app you can build a frontend with anything. See
[FRONTENDS.md](FRONTENDS.md) for raw SSE, the client SDK, the React hooks and
embedding the core directly.
