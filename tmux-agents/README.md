# tmux agents

Local Pi tools for interactive child sessions in tmux. This extension runs persistent, unreferenced watchers: children poll their spawn-family message store and automatically inject permitted peer messages into their sessions. Parent-owned families also poll for messages addressed to the parent. A delivered child message starts a real model turn; it is not a notification that requires a human to copy text into the child.

Requires Linux with `/proc`, tmux, and Pi. Tested with Pi 0.85.1, tmux 3.5a, and Node 22. Run the parent Pi inside tmux.

Install it with the rest of this repository's package (see the [main README](../README.md)), or copy this directory to `~/.pi/agent/extensions/tmux-agents/`. Use `/reload` in a running parent to enable it. Installing does not reload or control existing sessions.

## Tools

All tools return bounded JSON text. IDs are tmux pane IDs such as `%12`, not names. Only children launched by the current parent process are eligible. Existing agents cannot be adopted.

| Tool | Parameters | Result |
| --- | --- | --- |
| `tmux_agent_spawn` | `name`, optional `mode`, `cwd`, `systemPrompt`, `provider`, `model`, `thinking`, `waitMs` | New pane ID, window ID, label, and readiness status |
| `tmux_agent_send` | `id`, `text` | Terminal submission status, not an acceptance confirmation |
| `tmux_agent_read` | `id`, optional `terminal`, `maxChars` | Latest completed assistant reply, or visible terminal output |
| `tmux_agent_context` | `id` | Context tokens, Xk, capacity, percent, selected model, and thinking level |
| `tmux_agent_list` | Optional `offset` | Up to 50 managed children with IDs and status, plus `nextOffset` |
| `tmux_agent_permissions` | `action`, and `from`, `to` for `grant` or `revoke` | Manage directed peer-message permission edges in the caller's own spawn family |
| `tmux_agent_peers` | None | The endpoints the caller may message in its family |
| `tmux_agent_message` | `to`, `text`, `mode` | Queue one peer message |
| `tmux_agent_broadcast` | `text`, `mode`, optional `recipients` | Queue one independent message for each selected child |
| `tmux_agent_messages` | Optional `offset`, `peer`, `maxChars` | Inspect message records in the caller's own spawn family |

### Spawn

```json
{"name":"worker2"}
```

The default is a new detached tmux **window** in the parent's tmux session. The parent keeps focus. `name` sets the bottom tab's window label and Pi's `--name`. It must contain 1–48 letters, digits, underscores, or hyphens, starting with a letter or digit. Existing window labels and names already recorded by this parent are rejected, including retired names. Automatic window renaming and terminal-driven window renaming are disabled for the destination window.

```json
{
  "name":"reviewer2",
  "mode":"window",
  "cwd":"/workspace",
  "systemPrompt":"/absolute/path/review-system.md",
  "provider":"github-copilot",
  "model":"YOUR_CONFIGURED_MODEL_ID",
  "thinking":"high"
}
```

- `mode` is `window` or `pane`. Pane mode splits the parent's pane and **renames its containing window**, including the label shared by every existing pane there. A pane cannot have its own bottom tab.
- `cwd` defaults to the parent's current working directory. Relative paths resolve against that directory.
- `systemPrompt` is a readable regular file, checked before creating a pane. Relative paths resolve against the parent's directory. Pi replaces its default prompt with the file, but still appends applicable context files and skills. Other extensions can still modify the prompt.
- `provider`, `model`, and `thinking` are optional CLI overrides. Unset values use the child's normal Pi defaults, not the parent's selected model. Thinking accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.
- Existing safety and workflow extensions remain enabled. This extension is also explicitly loaded in the child for telemetry and peer delivery. No existing configuration is edited. tmux supplies the child environment, so environment changes made only inside the parent process are not copied wholesale.
- `waitMs` defaults to 10000 and accepts 0–30000. A timeout returns `starting`, with the new ID. Do not spawn again. Use list, context, or a terminal read to check startup. Project trust or extension dialogs can require human action.

Semicolons and backslashes in argument values are passed literally, including trailing semicolons.

A spawn is attempted once. Post-creation setup errors report the pane ID when tmux returned it. Nothing is silently killed or rolled back. If tmux fails before returning an ID, the error reports uncertain creation. Inspect tmux before retrying.

## Peer messages and permissions

A parent Pi process that spawns children owns a **spawn family**. An endpoint is a spawned child, addressed by its spawn `name`, or the reserved endpoint `parent` for the owning process. A name outside the registry is not addressable. A manually launched Pi is not a family member: it cannot be addressed, does not poll a family store, and is never adopted.

The tools have an intentional v1 boundary. `tmux_agent_permissions`, `tmux_agent_broadcast`, and `tmux_agent_messages` act on the caller's own spawn family: the children it has spawned. `tmux_agent_peers` and `tmux_agent_message` act on the family the caller belongs to when it is itself a child. Therefore, a mid-level child can broadcast to children it spawned, but cannot use `tmux_agent_message` to address one of those children individually. This asymmetry is a v1 boundary, not an error.

A child sees all ten tools, but its `tmux_agent_permissions` and `tmux_agent_messages` operate on the children it has spawned. If it has not spawned children, its `tmux_agent_messages` result is empty; that does not show whether the family that contains it has messages.

### Permissions

The family owner manages an allow-list with `tmux_agent_permissions`:

```json
{"action":"grant","from":"worker1","to":"worker2"}
```

`action` is `grant`, `revoke`, or `list`. `from` and `to` are required for `grant` and `revoke`. A grant or revoke returns the full `edges` list; `list` returns the full permission object.

Edges are directed: `worker1` → `worker2` does not allow the reverse direction. An absent `permissions.json` file, or an empty `edges` array, denies child-to-child messages. Parent → child needs no edge because the parent owns the family. Child → `parent` needs an explicit edge such as `{ "from": "worker1", "to": "parent" }`. Only the owning process writes the allow-list.

Permission is checked when the sender writes the record and again before the recipient delivers it. If an edge is revoked before delivery, the recipient records `blocked-revoked`. An already delivered message is not retracted. A broadcast grants no permissions and creates no thread.

Use `tmux_agent_peers` to discover only the endpoints the current caller may send to. Each result contains `name`, `paneId`, `status`, `modes` (`["steering","interrupt"]`), and `delivery`. `delivery` is `turn` for a child and `ping` for `parent`; it is not the whole family directory. A child with an explicit edge to `parent` sees `parent` in this result with `delivery: "ping"`.

### Send one message or broadcast

```json
{"to":"worker2","text":"Check the failing test.","mode":"steering"}
```

`tmux_agent_message` accepts `text` from 1 to 10000 characters and `mode` `steering` or `interrupt`. It writes one immutable message record and returns:

```json
{"messageId":"…","to":"worker2","mode":"steering","delivery":"turn","state":"queued"}
```

`queued` means the record was written. It does not confirm recipient acceptance or delivery.

```json
{"text":"Stop and report your current result.","mode":"interrupt","recipients":["worker1","worker2"]}
```

`tmux_agent_broadcast` acts on the caller's own spawned children. It writes one independent record per recipient with a shared `broadcastId`. With no `recipients`, it targets all live children. A supplied recipient list is processed as given. The result has one queued record or error per requested child. A delivered message consumes recipient tokens and can start work; a broadcast to all children can start every child at once.

Two identical sends are two different messages. There is no content-level deduplication.

### Delivery modes

Use **steering** unless you must stop the recipient's current work. An idle child receives steering as a new turn. A busy child receives it as a steering message after the current assistant turn's tool calls and before the next model call, so the extension does not interrupt tool execution. How many steering messages are delivered per completed turn depends on the recipient's `steeringMode`; this extension does not change that setting.

**Interrupt has a material side effect.** It aborts the recipient's run, then waits up to five seconds for the session to become idle before it injects the text. It tries at most three times. An interrupt can abort the recipient's work and move queued steering and follow-up text into the recipient's editor without submitting it. The editor is then non-empty, and `tmux_agent_send` refuses to send to that child until a human clears the editor. An interrupt that does not reach idle after three attempts records `failed-interrupt-timeout`; it is not retried as steering and its mode is never changed silently.

Child pollers run approximately every 500 ms in TUI sessions. They deliver at most one record per poll. An interrupt in progress blocks later delivery until it resolves, which can take about 15 seconds. Poll timers are unreferenced and do not keep Pi alive.

A child only delivers records created at or after its process start time. Older undelivered records get `expired-stale`, so restarting a pane does not replay history. `/reload` does not restart the process, so pending records can survive a reload.

### Parent pings

A message addressed to `parent` requires an explicit child → `parent` edge. It is deliberately weaker than a child message: it never starts a parent turn and never consumes parent context. A child cannot put work into the parent session; only the parent can do that.

Both requested modes are accepted for `parent`, but both are delivered as a `ping`. The message result states `delivery: "ping"`; its receipt retains the requested mode. A family-owning parent polls for these records roughly every 500 ms. When it has a UI, it shows a transient toast and a persistent `tmux-agents` footer badge with the unread count and sender names. Without a UI, the record is written but nothing is surfaced. In RPC mode, the footer status is a client request that the client may ignore.

The badge is the only push mechanism. Read content with `tmux_agent_messages`; reading parent-addressed rows clears their badge. A filtered read or one page clears only the returned rows.

### Delivery status is owner-only

A sender is not told when its own message fails to be delivered. `tmux_agent_message` returns as soon as the record is written, and the delivery outcome is recorded later in a receipt that only the family owner can read with `tmux_agent_messages`. A child that sends an interrupt which times out will not learn that it failed. This is a known limitation of this version. If you need certainty that a peer acted, ask the family owner to inspect the records.

The family owner can use `tmux_agent_messages` with optional non-negative `offset`, `peer`, and `maxChars` (1000–20000). Results are paginated at 50 records and include endpoints, content, requested mode, delivery type, and outcome. `peer` filters messages where that endpoint is sender or recipient. This is the one read tool that changes state: returned parent-addressed rows gain `readAt` and have their unread badge cleared.

Each message has one durable record and a receipt outcome. Stored receipt states are:

| State | Meaning |
| --- | --- |
| `delivered` | Injected into the recipient's session |
| `notified` | A parent-addressed record was processed as a passive ping |
| `failed-interrupt-timeout` | Three abort-and-wait attempts did not reach idle; nothing was delivered |
| `blocked-revoked` | The permission edge was absent at delivery time |
| `invalid-record` | The record failed file, schema, or size validation |
| `expired-stale` | The record predates the recipient process start |
| `failed-injection` | Reserved receipt state for an injection or receipt-path failure other than interrupt timeout |

`pending` means no receipt exists yet and is shown during inspection but is not stored. `undeliverable` is also inspection-only and means the recipient child pane is gone. Parent-addressed rows include `readAt`, which is `null` until read.

## Send and read

```json
{"id":"%12","text":"Review the error handling.\nDo not edit files."}
```

```json
{"id":"%12","text":"/model provider/exact-model-id"}
```

Text goes through tmux bracketed paste, then a separate Enter. Built-in slash commands reach the real TUI. No text is evaluated as a shell command by this extension, and key-like text such as `C-c` remains text. Pi still interprets its normal commands, including `!` shell input. Pi's editor expands pasted tabs to spaces.

Sending requires an idle child snapshot, an empty-editor snapshot, no known extension dialog, a live matching Pi PID and process start time, and no tmux copy mode. It rejects stale or unmanaged panes and does not queue into a busy agent. It never clears the editor with Ctrl+C.

These checks are not an editor lock. Sending assumes the child currently has a normal empty editor, no built-in selector, and no concurrent human typing. Snapshot checks cannot detect every intervening edit or UI change. A peer injection can start a turn after `tmux_agent_send` passes its readiness check and before it pastes; the pasted text then lands as steering. This is the same class of race as concurrent human typing. Use exact slash-command arguments when possible. Commands such as `/model` without an exact match can open a selector that requires human interaction. Do not send more text into that selector.

A successful send means tmux accepted paste and Enter. It does not prove Pi accepted or executed the command. Inspect the reply, model telemetry, or terminal afterward. A failed send can leave pasted text in the editor. Do not retry blindly.

```json
{"id":"%12"}
```

Use this with `tmux_agent_read` for the latest completed assistant message. It returns text blocks, the message ID, stop reason, and any error. It excludes thinking blocks, tool calls, tool results, and user prompts. It does not stream a partial reply or return the whole conversation. `busy` can accompany an earlier completed reply. Check the reply ID and snapshot timestamp.

```json
{"id":"%12","terminal":true,"maxChars":8000}
```

Terminal mode reads the current screen and up to 200 preceding terminal lines. Use it for `/session`, command feedback, startup diagnostics, or dialogs. It returns visible terminal text, which can include prompts, expanded thinking, or sensitive text displayed by Pi. It does not retrieve hidden thinking from session storage. Request terminal mode only when that exposure is acceptable.

`maxChars` defaults to 12000 and accepts 1000–20000. Assistant snapshots retain at most 12000 reply characters and 2000 error characters. Terminal truncation retains the end. Truncation markers stay inside these string fields. JSON escaping can expand each character to six serialized characters. Tool output has a 128000-character serialization ceiling. If metadata pushes a result beyond that ceiling, the tool returns a small JSON error instead of cutting the JSON. Send accepts at most 50000 characters and rejects terminal control characters except LF and tab.

## Context

```json
{"id":"%12"}
```

Use this with `tmux_agent_context`. Example context fields:

```json
{
  "tokens":123456,
  "tokensK":"123.5k",
  "contextWindow":200000,
  "contextWindowK":"200.0k",
  "percent":61.728
}
```

These are Pi's context estimates, not cumulative billed input/output tokens. `k` means 1000 tokens. Unknown values remain `null`, not zero. Fresh-session estimates can omit system-prompt and tool-schema cost. Usage can be unknown after compaction until another response supplies usage.

Snapshots update on startup/reload, agent start, turn end, final agent settlement, model/thinking changes, compaction, tree navigation, extension dialogs, and shutdown. After tree and compaction events, a temporary timer checks every 100 ms until Pi reports idle with no pending messages, then refreshes the snapshot. This accommodates asynchronous extension handlers without forcing readiness.

User `!` and `!!` commands start the same temporary refresh when this extension receives `user_bash`. Pi does not include user bash in `isIdle()`, so the refresh also waits for a matching new saved bash result. It reads context usage from Pi after settlement, not from command output or billing totals. Bash output is not included in assistant-only reads.

Each refresh stops after settlement or after ten minutes. A timeout warns in the child TUI and leaves the last snapshot intact. If another extension intercepts `user_bash` before this handler runs, or execution fails without saving a result, this extension cannot observe bash completion. Context can remain stale until another snapshot event. Commands lasting beyond the refresh timeout have the same limitation.

Snapshots are not live token counters during streaming. `updatedAt` identifies their age. Only provider and model IDs are exposed, not model configuration, headers, or credentials.

## Window menu

Right-click a window's tab in the tmux status bar to open a menu for that window:

| Item | What it does |
| --- | --- |
| Panes to Windows | Breaks every pane except the first out into its own window |
| Join *window* | Moves every pane of the clicked window into the chosen window, lays them out side by side, and switches you there |
| Send Left / Send Right / Send to End | Moves the window along the tab bar, keeping window numbers contiguous |
| Rename | Renames the window's tab |
| Kill | Closes the window, and anything running in it, after you confirm |

Items that don't apply, such as Send Left on the first tab, are greyed out. Moving panes between windows is safe for spawned agents: they are tracked by pane ID, process ID and process start time, which survive a move, so they stay manageable from the parent. Rename changes only the tab label. Tools and peer messages still address an agent by the name it was spawned with.

The menu is installed when a parent Pi starts inside tmux. It binds `MouseDown3Status`, a right-click on a window tab, which replaces tmux's built-in window menu for that tmux server until the server exits. It replaces only tmux's default binding or an earlier copy of this menu. If you've bound that key yourself, your binding is kept and Pi shows a note. To stop the extension installing the menu, start Pi with `PI_TMUX_AGENTS_MENU=off`. To remove it from a running tmux server, run `tmux unbind-key -n MouseDown3Status`.

The menu is a standalone script, [`tmux-menu.sh`](tmux-menu.sh), so you can also bind it yourself without Pi. Its header shows the binding. It uses `display-menu -M -O` where tmux supports them and falls back to a plain menu on versions that don't, such as tmux 3.4.

If a window has a `@piao_script` option naming a layout script, the menu also offers **Layout...** and **Focus / Restore active agent**, and joining into that window uses its remembered layout. No such script ships with this extension yet.

## State, lifecycle, and trust

State lives under `$TMPDIR/pi-tmux-agents-<uid>/<parent-pid>-<start-ticks>`, normally in `/tmp`:

```text
$TMPDIR/pi-tmux-agents-<uid>/<parent-pid>-<parent-start-ticks>/
  child-XXXXXX/meta.json              per-child record
  child-XXXXXX/snapshot.json          per-child telemetry
  permissions.json                    directed allow-list
  messages/<messageId>.json           immutable message record
  messages/<messageId>.receipt.json   delivery receipt
  messages/<messageId>.read.json      parent-ping read marker
```

Directories are owner-only (`0700`) and files use mode `0600`. Spawn passes `PI_TMUX_AGENT_DIR`, `PI_TMUX_AGENT_TOKEN`, `PI_TMUX_AGENT_FAMILY`, and `PI_TMUX_AGENT_NAME` to each child. Snapshots and state updates use atomic replacement. Nothing is deleted in this version: message records and receipts accumulate, cleanup is manual, and records can contain task text.

The extension validates the tmux socket, server identity, pane ID, PID, and Linux process start time before `tmux_agent_send`. Session and window are not checked, because moving a pane between windows keeps its pane ID; `tmux_agent_list` reports each agent's current window. A child that inherits another child's environment cannot publish under that identity unless it is the original pane process.

The registry survives `/reload` within the same parent process. It does not reconnect from a different parent process or adopt a manually moved or replaced pane. Children remain interactive and do not close when the parent exits.

### Trust boundary

The permission allow-list is a coordination guardrail, not a security boundary. All family processes run as the same OS user. A hostile or buggy child can use ordinary shell commands to read or write the owner-only family directory, including messages, tokens in `meta.json`, permissions, and receipts. Sibling-readable tokens prove nothing between siblings. There is no privacy from the family owner. Message content is stored under `$TMPDIR` in that owner-only directory and can contain task text.

The same OS user can enumerate `/tmp/pi-tmux-agents-<uid>/`, locate other family roots, and write records into them. A hostile or buggy child can therefore inject records across families by bypassing the extension API. A child identity is inherited through `PI_TMUX_AGENT_FAMILY` and `PI_TMUX_AGENT_NAME`: any descendant process of a child inherits that identity and can send as that child. The `owned` check gates only message consumption; it does not prevent that inherited identity from sending.

Within the extension API, a child cannot claim another sender identity through a tool argument: identity comes from its process environment and family registry. It can use only permission edges granted to its own name, so it cannot use the peer tools to send to an unpermitted sibling or the parent. An explicit child → `parent` edge permits only a passive ping, never a parent model turn. The peer tools cannot address a manually launched session, another family, or any process outside the family.

These API limits do not constrain a malicious same-user process that bypasses the extension and edits a family directory or otherwise uses its operating-system access. The OS user boundary, the `0700` directory, and the absence of caller-supplied identities are the relevant protections; the extension does not provide isolation between family members.

## Verification

```bash
node --test tmux-agents/test.mjs
```

Tests use Node's test runner, the installed Pi loader, `tsc`, and an isolated temporary tmux socket. No packages are installed. Set `PI_TEST_PACKAGE_DIR` if the Pi package is not under `npm root -g`.

The tests launch real interactive Pi children with temporary test-only configuration and offline startup. A test input hook consumes prompts without calling a model. Synthetic session entries and an extension-provided summary exercise tree navigation and manual compaction. The test provider points to an unreachable local endpoint, and the tests check that no provider request was attempted. Pi children exit through `/quit`. A separate isolated tmux fixture uses an argv recorder to check semicolon and backslash handling, including command-injection attempts and literal model/provider values. That fixture shuts down only its own test server. Test artifacts remain in the reported temporary directories. The tests do not interact with the user's tmux socket or existing agents.

Coverage includes context/null formatting, assistant-only filtering, valid JSON with escaped output, argument boundaries, invalid prompt files, loader/type checks, window and pane labels, duplicate names, multiline input, built-in slash commands, reload, private state permissions, stale identity, copy mode, and exited children. Regression tests compare actual Pi idle/context state after tree navigation without a summary, manual compaction, and user bash, including delayed extension handlers and the next `/session` submission. Controlled-clock tests cover refresh settlement, timeout, shutdown, session replacement, and late ownership checks. No paid model response, actual provider switch, or model-generated compaction is exercised by these tests.
