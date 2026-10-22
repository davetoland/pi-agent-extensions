# Pi Coding Agent Extensions

A collection of custom extensions for the [Pi coding agent](https://pi.dev): focused add-ons that make day-to-day sessions tidier, leaner on context, easier to inspect, and able to run several agents side by side.

Everything ships as a single Pi package. Install the lot, or pick just the extensions you want.

📣 **[Extending Pi](series/README.md)** is a short series about these extensions: what each one adds and why, plus getting started with Pi and writing your own.

---

## Extensions at a glance

| Extension                                               | What it does                                                                                            |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| [`custom-footer`](#custom-footer)                       | Pi's footer with context shown in tokens, earlier warnings, and branch display that works in containers |
| [`conditional-instructions`](#conditional-instructions) | Load instructions only when the agent touches matching files                                            |
| [`skill-read-dedupe`](#skill-read-dedupe)               | Stop the agent re-reading a skill that's already in context                                             |
| [`context-pressure`](#context-pressure)                 | Push the agent to delegate as its context fills, and cut off heavy reads past a limit                   |
| [`tmux-agents`](#tmux-agents)                           | Spawn, drive and coordinate other Pi agents in tmux windows                                             |
| [`session-eval`](#session-eval)                         | Export sessions as trace bundles, with a skill to evaluate them                                         |

---

## Installation

### Prerequisites

- [Pi coding agent](https://pi.dev)
- Node.js 22.5 or later (`conditional-instructions` uses `matchesGlob` from `node:path`)
- For `tmux-agents` only: Linux and [tmux](https://github.com/tmux/tmux). On Windows, use WSL. Elsewhere it stays inactive.

### Install everything

```bash
pi install git:github.com/davetoland/pi-agent-extensions
```

Add `-l` to install into the current project only. To pin a release, add its tag:

```bash
pi install git:github.com/davetoland/pi-agent-extensions@v0.1.1
```

Update or remove it with `pi update` and `pi remove`.

### Install only some extensions

Install the package, then narrow it in `~/.pi/agent/settings.json` by replacing its source string with an object that lists what you want:

```json
{
	"source": "git:github.com/davetoland/pi-agent-extensions",
	"extensions": ["custom-footer/index.ts", "skill-read-dedupe/index.ts"],
	"skills": []
}
```

Leave out a key to load everything of that type, or set it to `[]` to load none.

### Try one without installing

```bash
git clone https://github.com/davetoland/pi-agent-extensions.git
pi -e ./pi-agent-extensions/custom-footer/index.ts
```

### Manual install

Each extension is a self-contained folder. Copy one into `~/.pi/agent/extensions/` (or `.pi/extensions/` in a project):

```bash
cp -r pi-agent-extensions/custom-footer ~/.pi/agent/extensions/
```

For `session-eval`, also copy its skill: `cp -r pi-agent-extensions/session-eval/evaluate-session ~/.pi/agent/skills/`.

---

## custom-footer

**Pi's footer, with a few tweaks.**

A small replacement for the footer at the bottom of every Pi session in the terminal. It shows the same information as Pi's own footer, in the same style, with three changes:

```text
Pi's own:       ↑394k ↓24k R4.4M CH93.9% $3.802 (sub) 23.2%/1.1M (auto)
custom-footer:  ↑394k ↓24k R4.4M CH93.9% $3.802 (sub) 244k/1.1M (23.2%) (auto)
```

- **Tokens used, not just a percentage.** Context shows as tokens used against the window, with the percentage after it.
- **Earlier warning.** The context reading turns amber at 20% and red at 40%, instead of Pi's 70% and 90%. These match where [`context-pressure`](#context-pressure) starts warning and blocking. The thresholds are two constants at the top of the file.
- **Branch display that works in containers.** Pi notices branch changes by watching `.git`, which misses changes on some bind mounts, such as a Windows folder mounted into a Docker container. This footer also polls `HEAD`, and handles worktrees and submodules.

It's one file with one event handler, which makes it a good starting point for your own footer. One difference from Pi's own footer: it can't show which model a routed request went to, because extensions can't see that.

---

## conditional-instructions

**Instructions that only show up when they're relevant.**

Inspired by GitHub Copilot's path-scoped instructions. Each instruction file declares an `applyTo` filter, and its contents only enter context when the agent reads a file that matches. Instead of front-loading every rule into `AGENTS.md`, context stays lean and the agent gets the right guidance at the right moment.

### Writing instructions

Put Markdown files with frontmatter anywhere under `~/.pi/agent/instructions/`. Subfolders are fine. These instructions apply to every project.

```markdown
---

description: React component conventions
applyTo: "src/**/*.tsx, src/**/*.jsx"
---

- Use function components and hooks, never class components.
- Co-locate tests as `Component.test.tsx`.
```

- `applyTo` takes one or more comma-separated globs, matched against the file's path relative to its repository root (worktrees included). `*` doesn't cross folders, so use `**/*.ts` to match `.ts` files at any depth.
- `description` is optional and is shown to the agent in the instruction index.

### How it works

1. **Index, not content.** At the start of each turn the agent gets a short list of the instruction files and their patterns, not their contents.
2. **Loaded on read.** When the agent successfully reads a matching file, the instructions are appended to that read result, once per session.
3. **Enforced before edits.** If the agent tries to edit or write a matching file before the instructions are in context, the call is blocked and the agent is told which file to read first.
4. **Compaction-aware.** After compaction, instructions are treated as unloaded, so they're supplied again the next time they're needed.

---

## skill-read-dedupe

**Never pay for the same skill twice.**

Agents sometimes re-read a `SKILL.md` that's already in context. `skill-read-dedupe` spots this and blocks the duplicate read, telling the agent to use the copy it already has.

It decides from the context Pi actually sent on the latest model request, so compaction, `/new` and `/tree` navigation are handled for free: if the earlier copy is no longer in context, the read goes ahead.

**Highlights**
- Recognises both earlier full reads and `/skill:name` injections.
- Only blocks when the copy in context is complete and matches the file byte for byte, so an edited skill is always re-read.
- Fails open: on any error or doubt, the read is allowed.
- Turn it off for a run with `PI_SKILL_READ_DEDUPE=off`.

See [`skill-read-dedupe/README.md`](skill-read-dedupe/README.md) for the exact matching rules and known gaps.

---

## context-pressure

**Keep the main session lean as the context window fills.**

Agents tend to keep reading and searching in their own context long after they should hand work off. `context-pressure` steps in at two levels, each a percentage of the context window or a token cap, whichever comes first:

| Level | Main session       | Subagent session   | What happens                                                                                            |
| ----- | ------------------ | ------------------ | ------------------------------------------------------------------------------------------------------- |
| Warn  | 20% or 200k tokens | 20% or 100k tokens | A short note on a tool result: delegate further reading, or in a subagent, finish and return            |
| Block | 40% or 400k tokens | 40% or 150k tokens | Full reads of files over 16 KB are blocked, and other tool output over 4 KB is cut to its start and end |

The warning repeats as usage climbs, and resets after compaction. Delegation and state-saving tools, such as `write`, `edit` and the `tmux_agent_*` tools, are never blocked or truncated. Like the other extensions, it fails open: on any error or missing usage data, nothing is blocked.

Its advice matches what's installed. With a subagent tool such as [`@gotgenes/pi-subagents`](https://www.npmjs.com/package/@gotgenes/pi-subagents), it tells the agent to delegate to subagents. With only [`tmux-agents`](#tmux-agents), it points to `tmux_agent_spawn`. With neither, it tells the agent to keep reads and searches narrow instead. Sessions started by `@gotgenes/pi-subagents` count as subagents and get the tighter limits. Every threshold can be changed with an environment variable, and `PI_CONTEXT_PRESSURE=off` turns it off. See [`context-pressure/README.md`](context-pressure/README.md) for the details.

---

## tmux-agents

**Multiple Pi agents, one terminal.**

`tmux-agents` lets a Pi agent spawn other interactive Pi agents, each in its own tmux window or pane. Every child shows up as a labelled tab in tmux's window bar, so you can switch to it, watch it work, or take over. Agents that share a window are laid out automatically around the parent, with a choice of layouts from a right-click menu in any agent pane. Right-click a tab for a menu to split its panes into windows, join it into another window, reorder, rename or close it. Agents stay manageable however you rearrange them.

The parent agent drives its children through tools:

| Tool                     | What it does                                                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `tmux_agent_spawn`       | Start a child Pi in a new window or pane, optionally with its own working directory, system prompt, model and thinking level |
| `tmux_agent_send`        | Submit a prompt or slash command to a ready child                                                                            |
| `tmux_agent_read`        | Read a child's latest reply, or its visible terminal                                                                         |
| `tmux_agent_context`     | Check a child's context usage, model and thinking level                                                                      |
| `tmux_agent_list`        | List the children this agent has spawned                                                                                     |
| `tmux_agent_permissions` | Allow or revoke messaging between agents                                                                                     |
| `tmux_agent_peers`       | List the agents the caller may message                                                                                       |
| `tmux_agent_message`     | Send a steering or interrupting message to one agent                                                                         |
| `tmux_agent_broadcast`   | Message all or selected children at once                                                                                     |
| `tmux_agent_messages`    | Inspect the family's messages and their delivery status                                                                      |

**Highlights**
- **Safe input.** Text is only sent to a child that's idle with an empty editor, and is pasted literally, so nothing is interpreted as a shell command.
- **Agent-to-agent messaging.** Children can message each other once the parent grants a link. Messages to the parent only raise a badge in its footer, so a child can never start work in the parent session.
- **Auditable delivery.** Every message gets a delivery receipt that the parent can inspect.

**Requires:** Linux and tmux, with the parent Pi running inside tmux. On native Windows, macOS, or outside tmux, it stays inactive and registers no tools; Windows users can run Pi in WSL. The tab menu replaces tmux's built-in window menu; start Pi with `PI_TMUX_AGENTS_MENU=off` to keep tmux's own, or `PI_TMUX_AGENTS_LAYOUT=off` to turn off automatic layout. The layout needs `node` on your `PATH`. See [`tmux-agents/README.md`](tmux-agents/README.md) for the full tool reference, delivery semantics and trust boundary.

---

## session-eval

**See exactly what happened in a session.**

`session-eval` exports Pi sessions as a **trace bundle**: a structured, harness-neutral record of one or more sessions, including context and token usage, tool calls, timing, subagents and peers. It ships with the `evaluate-session` skill, which reads a bundle and writes an evaluation report: wasted effort, weak delegation, instruction and skill gaps, and work that should be scripted, each with a recommended fix.

### Command: `/evaluate-session`

```text
/evaluate-session                         latest session in this cwd (excluding the current one)
/evaluate-session latest 3                three latest in this cwd
/evaluate-session --session PATH.jsonl    a specific session
/evaluate-session --cwd DIR --since 2026-09-01 --until 2026-10-01
/evaluate-session --all-cwds --name "run-\d+" --latest 5
```

The command exports the selected sessions to a new report folder under `~/.pi/agent-evals/`, then starts the `evaluate-session` skill with the bundle location.

### Tool: `session_eval_export`

The same export, available to the agent itself, for when the skill is loaded without the command.

### What it captures

Alongside exporting, the extension records a few facts Pi doesn't keep on its own. They're stored in the session file and never sent to the model:
- Which extensions and Pi version were active
- How long each tool call took
- Links to child sessions started by `tmux-agents`

### Good to know

- Forked and cloned sessions aren't double-counted.
- Excerpts are redacted for common secret formats. Redaction is pattern-based, so review a bundle before you share it.
- Want to judge sessions your own way? Write your own skill against the bundle format in [`trace-bundle.md`](session-eval/evaluate-session/references/trace-bundle.md). Name it `evaluate-session` and the command will hand bundles to it.
- Full details of the command, the tool, the selection rules and the bundle format are in [`session-eval/README.md`](session-eval/README.md).

---

## Repository structure

```
.
├── custom-footer/
│   └── index.ts
├── conditional-instructions/
│   └── index.ts
├── skill-read-dedupe/
│   ├── index.ts
│   └── README.md
├── context-pressure/
│   ├── index.ts           Pi wiring
│   ├── logic.ts           the decisions, unit tested
│   ├── test/
│   └── README.md
├── tmux-agents/
│   ├── index.ts
│   ├── tmux-menu.sh       right-click window menu
│   ├── layout.mjs         automatic pane layout
│   ├── test.mjs
│   └── README.md
├── session-eval/
│   ├── index.ts
│   ├── adapter.mjs
│   ├── README.md
│   ├── evaluate-session/        the skill
│   │   ├── SKILL.md
│   │   ├── references/
│   │   └── scripts/digest.mjs
│   └── test/
├── package.json
└── LICENSE
```

## Tests

```bash
npm test
```

The `tmux-agents` tests use your installed Pi (set `PI_TEST_PACKAGE_DIR` if it isn't under `npm root -g`) and an isolated tmux server. The `session-eval` and `context-pressure` tests need only Node (22.18 or later for `context-pressure`, which runs TypeScript tests directly).

---

## Contributing

Issues and pull requests are welcome. If you've built something on top of these extensions, or have an idea for a new one, open an issue and let's talk.

## License

[MIT](LICENSE)
