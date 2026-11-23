# custom-footer

A Pi extension that replaces Pi's footer with a near-copy of it, with three changes:

- **Context is shown as tokens.** The context readout shows `244k/1.1M (23.2%)` rather than Pi's `23.2%/1.1M`.
- **Warnings come earlier.** The readout turns amber at 20% and red at 40%, rather than at 70% and 90%.
- **The branch stays correct on Docker mounts.** The branch shown updates even where Pi's own folder watch misses changes.

Everything else matches Pi's footer.

## Install

Install it with the rest of this repository's package (see the [main README](../README.md)), or copy `index.ts` to `~/.pi/agent/extensions/custom-footer/index.ts` and run `/reload`. To try it for one session, run `pi -e ./custom-footer/index.ts`.

## When it runs

The footer is set on `session_start`, in interactive terminal mode only. In print (`-p`), JSON and RPC modes the extension does nothing.

## What it shows

```text
~/projects/my-app (main) • my-session
↑394k ↓24k R4.4M CH93.9% $3.802 (sub) 244k/1.1M (23.2%) (auto)      (anthropic) claude-opus-5-5 • high
```

**First line:** the working directory (with your home directory shown as `~`), the git branch, and the session name if it has one.

**Second line, left side:** totals for the session.

| Field            | Meaning                                                                                                          |
| ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| `↑` / `↓`        | Input and output tokens                                                                                          |
| `R` / `W`        | Cache read and cache write tokens                                                                                |
| `CH`             | Cache hit rate of the latest request: cache reads as a share of its prompt tokens                                |
| `$`              | Cost so far. `(sub)` means the model is billed through a subscription.                                           |
| `244k/1.1M (…%)` | Tokens in context, the model's context window, and the percentage used. `(auto)` means auto-compaction is on. |

The totals include assistant messages, tool results, compaction and branch summaries, and other usage such as cache warming, as Pi's footer does. A field is left out while its value is zero.

**Second line, right side:** the model, its thinking level (when the model supports reasoning), and the provider (when more than one provider is set up and there's room). If the line is too wide, the right side is shortened first.

**Third line:** status text set by other extensions with `ctx.ui.setStatus()`, sorted by key. It appears only when some extension has set a status.

## Context colours

| Context used | Colour              |
| ------------ | ------------------- |
| Under 20%    | Dim, as on the rest of the footer |
| 20% to 40%   | Amber (`warning`)   |
| 40% and over | Red (`error`)       |

These are the default thresholds of [`context-pressure`](../context-pressure), which starts warning the agent at 20% and blocks large reads at 40%. With both installed, the colour shows what the agent is being told. To change them, edit `CONTEXT_WARNING_PERCENT` and `CONTEXT_ERROR_PERCENT` at the top of `index.ts`.

## Branch display on Docker mounts

Pi detects branch changes by watching the `.git` directory with `fs.watch`. On some bind mounts, such as a Windows folder mounted into a Linux container, git's rewrite of `HEAD` raises no watch event, so Pi keeps showing the old branch.

This extension also checks `HEAD` itself, every 2 seconds:
- It finds `.git` by walking up from the working directory. In a worktree or submodule, where `.git` is a file containing `gitdir: <path>`, it follows that path.
- `ref: refs/heads/<name>` shows as `<name>`. A bare commit hash shows as `detached`.
- If `HEAD` can't be read or understood, as in a reftable repository, the footer falls back to Pi's branch.

The check stops when the footer is replaced, or the session ends.