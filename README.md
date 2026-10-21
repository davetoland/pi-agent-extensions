# Pi Coding Agent Extensions

A collection of custom extensions for the [Pi coding agent](https://pi.dev): small, focused add-ons that make day-to-day sessions tidier, leaner on context, and easier to inspect.

Everything ships as a single Pi package. Install the lot, or pick just the extensions you want.

---

## Extensions at a glance

| Extension | What it does | Status |
| --- | --- | --- |
| [`custom-footer`](#custom-footer) | A reworked session footer with clearer context, cache and cost stats | ✅ Available |
| [`conditional-instructions`](#conditional-instructions) | Load instructions only when the agent touches matching files | ✅ Available |
| [`session-eval`](#session-eval) | Export sessions as trace bundles for evaluation | ✅ Available |
| [`skill-read-dedupe`](#skill-read-dedupe) | Stop the same skill being loaded into context twice | 🔜 Coming soon |
| [`tmux-agents`](#tmux-agents) | Run multiple Pi instances in tmux, navigable as TUI tabs | 🔜 Coming soon |

---

## Installation

### Prerequisites

- [Pi coding agent](https://pi.dev)
- Node.js 22.5 or later (`conditional-instructions` uses `matchesGlob` from `node:path`)

### Install everything

```bash
pi install git:github.com/davetoland/pi-agent-extensions
```

Add `-l` to install into the current project only. To pin a release, add the tag:

```bash
pi install git:github.com/davetoland/pi-agent-extensions@v0.1.0
```

Update or remove it with `pi update` and `pi remove`.

### Install only some extensions

Install the package, then narrow it in `~/.pi/agent/settings.json` by replacing its source string with an object that lists the extensions you want:

```json
{
  "source": "git:github.com/davetoland/pi-agent-extensions",
  "extensions": ["custom-footer/index.ts", "session-eval/index.ts"]
}
```

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

---

## custom-footer

**Pi's footer, reworked to show what matters.**

A replacement for the footer at the bottom of every Pi session in the terminal. It keeps the look and warning colours of Pi's native footer, and changes what it shows and how reliably it shows it.

```text
/workspace (main) • my-session
↑394k ↓24k R4.4M CH93.9% $3.802 (sub) 244k/1.1M (23.2%) (auto)      claude-opus-5-5 • high
```

**Highlights**
- **Clear context usage.** Tokens used against the context window, with a percentage that turns amber above 70% and red above 90%.
- **Cumulative usage.** Input, output, cache read and cache write totals across the session, including tool results, compactions and branch summaries.
- **Cache hit rate.** The share of the latest prompt served from cache.
- **Cost, with subscription awareness.** Shows `(sub)` when you're on an OAuth subscription rather than paying per token.
- **Reliable branch display.** Pi detects branch changes by watching `.git`, which misses changes on some bind mounts (for example 9p from a Windows host into a container). This footer also polls `HEAD`, and handles worktrees and submodules.
- **Plays well with others.** Status lines from other extensions are kept on their own line.

Want different stats? The footer is built in one `render()` function, so it's easy to fork and make your own.

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

- `applyTo` takes one or more comma-separated globs, matched against the file's path relative to its repository root (worktrees included).
- `description` is optional and is shown to the agent in the instruction index.

### How it works

1. **Index, not content.** At the start of each turn the agent gets a short list of the instruction files and their patterns, not their contents.
2. **Loaded on read.** When the agent reads a matching file, the instructions are appended to that read result, once per session.
3. **Enforced before edits.** If the agent tries to edit or write a matching file before the instructions are in context, the call is blocked and the agent is told which file to read first.
4. **Compaction-aware.** After compaction, instructions are treated as unloaded, so they're supplied again the next time they're needed.

---

## session-eval

**See exactly what happened in a session.**

`session-eval` exports Pi sessions as a **trace bundle**: a structured, harness-neutral record of one or more sessions, including context and token usage, tool calls, timing, subagents and peers. It pairs with the `evaluate-session` skill, which reads the bundle and writes an evaluation report.

### Command: `/evaluate-session`

```text
/evaluate-session                         latest session in this cwd (excluding the current one)
/evaluate-session latest 3                three latest in this cwd
/evaluate-session --session PATH.jsonl    a specific session
/evaluate-session --cwd DIR --since 2026-09-01 --until 2026-10-01
/evaluate-session --all-cwds --name "run-\d+" --latest 5
```

The command exports the selected sessions to a new report folder under `~/.pi/agent-evals/`, then starts the `evaluate-session` skill with the bundle location. If the skill isn't installed, the bundle is still written and you're told where.

### Tool: `session_eval_export`

The same export, available to the agent itself, for when the skill is loaded without the command.

### What it captures

Alongside exporting, the extension records a few facts Pi doesn't keep on its own. They're stored in the session file and never sent to the model:

- Which extensions and Pi version were active
- How long each tool call took
- Links to peer sessions started by `tmux-agents`

### Good to know

- Forked and cloned sessions aren't double-counted.
- Excerpts are redacted for common secret formats. Redaction is pattern-based, so review a bundle before you share it.
- Full details of the command, the tool, the selection rules and the bundle format are in [`session-eval/README.md`](session-eval/README.md).

---

## skill-read-dedupe

🔜 **Coming soon.**

Agents sometimes try to load a skill that's already in context. `skill-read-dedupe` detects this and blocks the duplicate read, saving context space. It handles `/new` and compaction, so a skill that has genuinely dropped out of context can be loaded again.

---

## tmux-agents

🔜 **Coming soon.** Requires [tmux](https://github.com/tmux/tmux).

`tmux-agents` hosts separate Pi instances in tmux windows and panes, and shows them as tabs in the Pi TUI. Arrange, split, join, rename and kill agents using tmux controls, without leaving your session.

---

## Repository structure

```
.
├── custom-footer/
│   └── index.ts
├── conditional-instructions/
│   └── index.ts
├── session-eval/
│   ├── index.ts
│   ├── adapter.mjs
│   └── README.md
├── package.json
└── LICENSE
```

---