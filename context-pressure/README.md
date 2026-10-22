# context-pressure

As the context window fills up, this extension pushes the model to delegate work to subagents. Past a second limit it blocks large reads and truncates large tool results.

Each threshold is a percent of the model's context window, taken from `ctx.getContextUsage()`, plus an absolute token cap. Whichever limit is reached first applies.

| Level | Main session | Subagent session |
|---|---|---|
| Warn | 20% or 200k tokens | 20% or 100k tokens |
| Block | 40% or 400k tokens | 40% or 150k tokens |

In a main session on a 1M window the token caps and the percentages are the same. On smaller windows the percentages are reached first.

## Behaviour

**Warn.** Appends a short note to a tool result when the threshold is first crossed. After that it adds the note again at every further 5 percentage points or 50k tokens in a main session, whichever comes first, or every 20k tokens in a subagent session. Steps count from whichever warn point was crossed first. If usage drops below the warn threshold, for example after compaction, the count resets.

- Main session: `Context at 92k tokens (23% of 400k). Delegate further reading and searching to subagents and keep their returns short. Save any state you need to a file or the work item.`
- Subagent session: `Context at 110k tokens. Finish the current step and return your findings now. Do not start new reading.`

**Block.**

- Blocks a `read` of a file over 16 KB unless `limit` is set to 200 lines or fewer. Image files are not blocked.
- Truncates any other tool result whose text is over 4 KB, such as output from `bash`, `grep`, `find` or MCP tools. It keeps the first 3 KB and the last 1 KB, so `bash` exit codes and "Full output: …" lines survive, and adds a note telling the model to delegate or, in a subagent, to return.
- Caps the text of `read` results that get past the read rule at 16 KB.

**Exempt tools.** These are never blocked or truncated: `subagent`, `get_subagent_result` (unless `verbose: true`), `steer_subagent`, `ask_parent`, `notify_parent`, every `tmux_agent_*` tool, `write`, `edit`, `ask_user_question` and `session_eval_export`. Warn notes are still appended to their results.

Nested calls made by another tool, such as a codemode script, are ignored, because the calling tool's own result is what reaches the model.

**Fails open.** If an error occurs, or usage data is missing (for example straight after compaction, before the next response), the call is allowed and the result is left unchanged.

## Subagent detection

The extension treats a session as a subagent session when its session file is `<dir>/<stem>/tasks/<child>.jsonl` and the parent transcript `<dir>/<stem>.jsonl` exists. This is the layout `@gotgenes/pi-subagents` writes. When the parent session is not saved, the package uses `<tmpdir>/pi-subagents-<uid>/…/tasks/<child>.jsonl` instead, and that layout also counts as a subagent session. If there is no session file, as with `--no-session`, the session is treated as a main session.

`@gotgenes/pi-subagents` runs each child in the same process with its own resource loader. The child loads every user and package extension except packages listed in the subagents `excludedExtensionPackages` setting. An extension installed in `~/.pi/agent/extensions/` therefore also runs in subagents. An extension loaded only with `pi -e <path>` does not, because the child loader is not given command-line extension paths.

Children started with `tmux_agent_spawn` are separate interactive Pi processes. They count as main sessions.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PI_CONTEXT_PRESSURE` | on | `off`, `0`, `false`, `no` or `disabled` turns the extension off |
| `PI_CONTEXT_PRESSURE_WARN` | 20 | Warn threshold, as a percent of the window |
| `PI_CONTEXT_PRESSURE_BLOCK` | 40 | Block threshold, as a percent of the window |
| `PI_CONTEXT_PRESSURE_WARN_TOKENS` | 200000 | Warn threshold in main sessions, in tokens |
| `PI_CONTEXT_PRESSURE_BLOCK_TOKENS` | 400000 | Block threshold in main sessions, in tokens |
| `PI_CONTEXT_PRESSURE_SUB_WARN_TOKENS` | 100000 | Warn threshold in subagent sessions, in tokens |
| `PI_CONTEXT_PRESSURE_SUB_BLOCK_TOKENS` | 150000 | Block threshold in subagent sessions, in tokens |

Invalid values fall back to the defaults. Percent values must be greater than 0 and no more than 100.

## Files

- `index.ts`: the Pi wiring. It handles the `tool_call` and `tool_result` events, resolves paths and reads file sizes.
- `logic.ts`: the pure decision functions.
- `test/logic.test.ts`: unit tests. Run them with `node --test test/logic.test.ts`. This needs Node 22.18 or later.
