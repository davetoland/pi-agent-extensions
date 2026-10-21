# session-eval

This pi extension supports the harness-neutral [`evaluate-session`](../../skills/evaluate-session/) skill. The skill evaluates agent sessions from a *trace bundle*, which `references/trace-bundle.md` in the skill defines. This extension does four things:

- It exports pi sessions as a trace bundle, through `adapter.mjs` in this directory.
- It starts the skill from a command, with the bundle and report locations.
- It tells the agent how pi stores sessions when the skill is loaded some other way.
- It records a few facts in the session file that pi does not otherwise record, for later bundles.

The skill does not depend on this extension. Without an adapter, the skill stops and asks for one.

## Install

Put this directory in `~/.pi/agent/extensions/`.

`index.ts` loads `adapter.mjs` from its own directory only when an export runs. It checks that the module exports `exportBundle` and checks the shape of the result. If the adapter is missing, passive capture still works and exports report an error.

## Command: `/evaluate-session`

```text
/evaluate-session                         latest root session in this cwd, excluding the current session
/evaluate-session latest 3                three latest in this cwd
/evaluate-session --session PATH.jsonl    one session (repeatable, a bare *.jsonl argument also works)
/evaluate-session --cwd DIR --since 2026-09-01 --until 2026-10-01
/evaluate-session --all-cwds --name "run-\d+" --latest 5
```

| Argument | Meaning |
| --- | --- |
| `latest [N]`, `--latest N` | Keep the N most recent root sessions. N must be a positive integer. Default 1. |
| `--session PATH` | Explicit root session file. The current session is not excluded. Cannot be combined with `latest`, `--cwd`, `--all-cwds`, `--since`, `--until` or `--name`. |
| `--cwd DIR` | Sessions started in DIR. Default: the current cwd. |
| `--all-cwds` | No cwd filter. Cannot be combined with `--cwd`. |
| `--since DATE`, `--until DATE` | Start-time window. See [Selection rules](#selection-rules). |
| `--name REGEX` | Case-insensitive regex. See [Selection rules](#selection-rules). |
| `--no-children` | Leave out subagent and peer sessions. |
| `--include-current` | Do not exclude the running session. |

When none of `latest`, `--since`, `--until` or `--name` is given, `latest 1` applies.

Quoting works like a shell. Single quotes are literal. Inside double quotes, only `\"` and `\\` are escapes, so `--name "run-\d+"` keeps its backslashes. `--name='a b'` is one argument. An unclosed quote is an error.

The command takes these steps:

1. It creates `~/.pi/agent-evals/<YYYY-MM-DDTHHmm>-<slug>/` in local time. If that directory exists, it adds a numeric suffix.
2. It exports the bundle to `<reportDir>/bundle`. If the export fails, it shows an error and removes the report directory if it is still empty.
3. If the `evaluate-session` skill is installed, it sends `/skill:evaluate-session <request>` as a user message with skill expansion on. The request holds the bundle path, the report directory, the selection, the adapter warnings, the number of adapter caveats, and the harness context block. If the agent is busy, the message is queued as a follow-up.

If no session matches, or the skill is not installed, the command shows a notification and leaves the bundle in place.

## Tool: `session_eval_export`

The tool lets an agent export a bundle itself, for example when the skill was loaded without the command.

| Parameter | Meaning |
| --- | --- |
| `sessions` | Explicit root session files. Cannot be combined with the filters below. |
| `cwd`, `allCwds` | As `--cwd` and `--all-cwds`. |
| `since`, `until`, `name`, `latest` | As the command arguments. |
| `includeCurrent` | Do not exclude the running session. Default false. |
| `includeChildren` | Include subagent and peer sessions. Default true. |
| `reportDir` | Report directory. The bundle goes to `<reportDir>/bundle`. If omitted, a new report directory is created as the command does. |

The defaults match the command. The cwd is the current cwd unless `cwd` or `allCwds` is given. `latest 1` applies when none of `latest`, `since`, `until` or `name` is given. The current session is excluded unless `sessions` is given or `includeCurrent` is true.

The tool returns `bundleDir`, `reportDir`, `runCount`, `rootCount`, `warnings`, `caveatCount` and `selection`. Invalid options and adapter errors are returned as tool errors.

The tool is registered with the default `direct` exposure, so its schema is sent with every request in every session. The schema is about 1,200 characters, roughly 300 tokens.

## Selection rules

The adapter applies these rules for both the command and the tool:

- `since` is inclusive and `until` is exclusive. Both are compared with the session start time, so a session started before `since` and resumed later is not selected.
- A date-only value, such as `2026-10-01`, means local midnight. A date-time without an offset is local time.
- `name` matches the session name. A session with no name is matched on its first user message.
- `latest N` returns the N most recent root trees. With children included, a session that an older selected root claims as a peer child does not take up a place. With `--no-children`, it is the N most recent matching sessions.
- The excluded current session is also left out when it appears as a child or peer of a selected session.

## Bundle output

The adapter writes the bundle to a temporary directory and then moves it into place. It replaces an existing directory only if that directory is empty or holds a previous bundle (`manifest.json` and `runs/*.jsonl` only). Otherwise it stops before writing. If an export fails, the previous bundle stays intact.

Adapter messages come in two kinds:

- **Warnings** are gaps found in this export, such as runs without timing captures or links that were inferred.
- **Caveats** are fixed notes about how the adapter maps pi sessions to the bundle format.

`manifest.json` lists the warnings followed by the caveats. The command and the tool pass on the warnings and the number of caveats only.

The adapter also handles these cases:

- **Forks and clones.** Entries that a forked or cloned session copied from its source are left out, so their cost is not counted twice. The run gets a note and a `fork` note event that names the source.
- **Abandoned delegations.** A subagent started from an abandoned branch has all its events marked abandoned.
- **Unsafe session ids.** A session whose id cannot be used safely as a file name is skipped with a warning.
- **Secrets.** Excerpts are redacted. The rules cover private keys, bearer tokens, connection-string keys, URL credentials, common token formats, `KEY=value` and `key: value` pairs whose key names a secret, and password flags on common database and cloud CLIs. Redaction is pattern-based, so review bundles before you share them.

## Harness context injection

When the skill is loaded and the agent has not yet had the harness context on the active branch, the extension adds a `<session-eval-harness-context>` block once. The block gives:

- the harness and pi version
- the export tool and its selection rules
- the sessions root and its layout
- the current session id and file, with a note that this session is still being written
- the default report root

| How the skill was loaded | Where the block goes |
| --- | --- |
| `read` of a path ending `/evaluate-session/SKILL.md` (not an error, not a nested call) | Appended to that read result. |
| `/skill:evaluate-session` starting a new run | Custom message (`session-eval:harness-context`, hidden in the UI) added by `before_agent_start`. |
| `/skill:evaluate-session` queued while the agent is streaming | Same custom message, queued with the same delivery mode just before it. |
| `/evaluate-session` | Already in the request, so nothing is added. |

The extension checks the active branch for an earlier block on `session_start` and on `session_tree`. The block therefore survives `/reload` and resume. Moving with `/tree` to a branch without the block allows one more injection. The block is not re-injected after compaction.

## Captured entries

The extension writes custom entries with `pi.appendEntry()`. Pi stores them in the session JSONL and never sends them to the model. `adapter.mjs` reads them.

| `customType` | When | `data` |
| --- | --- | --- |
| `session-eval:features` | `session_start`, skipped when identical to the last one on the branch | `{ extensions: string[], piVersion: string }` |
| `session-eval:timing` | `tool_execution_end` of each top-level tool call | `{ callId, durationMs }` |
| `session-eval:peer-link` | `tool_execution_end` of a successful `tmux_agent_spawn` | `{ callId, name, childSessionId, childSessionFile }` |

- **`extensions`** combines two sources:
  - Extensions that registered tools or commands, taken from their `sourceInfo`. Package extensions are named by package source, such as `npm:@scope/pkg@1.2.3`.
  - For extensions that only handle events, the entries in `~/.pi/agent/extensions/` and `<cwd>/.pi/extensions/`, the `extensions` setting, and `-e` or `--extension` arguments. Directory entries are listed even if pi did not load them, for example untrusted project extensions or files that failed to load.

  Package sources are recorded without URL credentials, query strings or fragments. Local paths are reduced to their last segment.
- **`durationMs`** is pi's own `tool_execution_end.durationMs` when present. Otherwise it is the wall-clock time between `tool_execution_start` and `tool_execution_end`, measured by the extension. Nested calls made by other tools, such as codemode scripts, are not timed.
- **`peer-link`** supports peers started by a `tmux-agents` extension that provides `tmux_agent_spawn`. It depends on that extension's internal state layout under `$TMPDIR/pi-tmux-agents-<uid>/<pid>-<start>/`.
  - The extension matches the child on the pane id from the spawn result. If the result has no pane id, it matches on the agent name and takes the child with the newest `createdAt`. With neither, it writes the entry with null session fields at once.
  - It reads the child's `sessionId` and `sessionFile` from `snapshot.json`. The child writes that file at its own session start, so the extension checks every 500 ms for up to 30 s. If nothing is found by then, it writes the entry with null session fields.
  - On `/reload`, unfinished checks pass to the reloaded extension and continue until the original deadline. On quit or a session switch, the extension makes one last check and writes what it finds.

Retries are not captured. Pi emits `auto_retry_start` and `auto_retry_end` only to session subscribers (SDK, RPC and UI), not to extensions. The failed attempt stays in the session file as an assistant message with `stopReason: "error"`, so the adapter infers retries from it.

**Size:** one entry of about 150 bytes per tool call, one per tmux spawn, and one features entry of a few hundred bytes per session start. Writes are synchronous appends to the session file.

**Privacy:** entries hold tool call ids, durations, extension names, tmux agent names, and child session paths. They hold no prompts, tool arguments or outputs. Pi's session export and share features include them, as they include the rest of the file.

## Known gaps

- Detection covers `read` only. A skill file read with `bash cat` gets no harness context.
- The installed check uses `pi.getCommands()` (`skill:evaluate-session`). It finds only skills that pi discovered at startup or on `/reload`.
- If the extension is removed before a `/reload` completes, peer-link checks that were still running are lost. The adapter then infers those links from name, cwd and start time.
