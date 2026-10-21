# Trace bundle format (schema version 1)

A trace bundle is the harness-neutral input to `evaluate-session`. A harness adapter produces it from the harness's own session records. The skill and `scripts/digest.mjs` read only the bundle and do not depend on any harness.

A bundle holds one or more **runs**. A run is one agent working in one context, such as a primary session, a delegated subagent, or a peer agent started by another agent. Parent links join runs into trees. A bundle can hold many trees, which is how one bundle covers several sessions.

## Layout

```
<bundle>/
  manifest.json
  runs/<runId>.jsonl     one event per line, in time order
```

## manifest.json

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-10-03T16:00:00.000Z",
  "source": {
    "harness": "pi",
    "harnessVersion": "x.y.z or null",
    "adapter": "pi-session-eval",
    "adapterVersion": "0.1.0"
  },
  "selection": {
    "description": "how runs were selected, e.g. --cwd /home/me/project --since 2026-09-01",
    "scanned": 120, "selected": 48, "excluded": 72
  },
  "warnings": ["adapter-level caveats, e.g. 'tmux peer links inferred by name and time'"],
  "runs": [ /* Run objects */ ]
}
```

### Run

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Unique within the bundle. Use it as the file name in `runs/`. |
| `parentId` | string or null | The run that started this run. Null for a root. |
| `rootId` | string | The id of the root run of this tree. |
| `kind` | `primary` \| `subagent` \| `peer` | `subagent`: started by a delegation tool and returning a result to its parent. `peer`: a separately running agent that the parent steers or messages. |
| `label` | string or null | Human-readable name, such as a session name or task description. |
| `agentType` | string or null | Role or profile of a delegated agent, such as `Explore`. |
| `link` | object or null | How the parent link was established: `{ "confidence": "explicit" \| "inferred", "method": string, "parentCallId": string or null }`. |
| `source` | object | `{ "path": string, "sessionId": string or null }`. The original record, used for drill-down. |
| `cwd` | string or null | Working directory. |
| `startedAt`, `endedAt` | ISO string or null | First and last event times. |
| `models` | string[] | Distinct `provider/model` values used. |
| `context` | object | What the agent was given at the start. See below. |
| `harnessFeatures` | string[] | Harness-specific features that were active and might change behaviour, such as `extension:skill-read-dedupe`. Use an empty array if this is unknown, and record the gap in `warnings`. |
| `notes` | string[] | Run-level caveats from the adapter. |

`context`:

```json
{
  "instructions": [ { "source": "/path/AGENTS.md", "chars": 5123, "contentHash": "sha256:…" } ],
  "skillsAvailable": [ { "name": "review-changes", "path": "/path/SKILL.md", "manualOnly": false, "listed": true } ],
  "toolsAvailable": ["read", "bash", "edit"],
  "systemPromptChars": 21000
}
```

`contentHash` is `sha256:<hex>` of the instruction text as delivered to the agent, or null. Hashes let an evaluator detect when governing material changed between runs.

`listed` is true when the skill was advertised to the agent in its context. Adapters may add skills that were invocable but not advertised, such as user-only skills, with `listed: false`. `manualOnly` is null when unknown.

Use `null` for any `context` field the adapter cannot determine. Do not use an empty array for that, because an empty array claims there was nothing.

## Events (`runs/<runId>.jsonl`)

All events have these fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `seq` | integer | Position in the run, starting at 0. |
| `type` | string | One of the types below. |
| `ts` | ISO string or null | When the event happened. |
| `ref` | string or null | The source record's id, for drill-down. |
| `branch` | `active` \| `abandoned` | `abandoned` marks events on a path the session later rewound away from. They count towards cost but are not part of the final trajectory. |

Text fields are truncated by the adapter. Every truncated text field `x` has a matching `xChars` field that holds the original length. Excerpts keep the head and the tail, joined by `\n…[truncated]…\n`.

### `user`

A message from the human, or a prompt injected by the parent for subagent and peer runs.

`text` (excerpt, at most 4000 characters), `textChars`, `origin`: `human` \| `command` \| `parent` \| `harness`.

- `command`: a human-issued command that the harness expanded, such as a skill invocation. It is not a free-text instruction or correction.
- `parent`: a message from another agent, whether a delegating parent, an orchestrator or a peer. Use it whenever the sender is known or reliably inferred to be an agent, and record inference in `notes`.

### `assistant`

One model response.

| Field | Meaning |
| --- | --- |
| `model` | `provider/model` |
| `thinkingLevel` | string or null |
| `usage` | `{ input, output, cacheRead, cacheWrite, reasoning, cost }`. All are numbers or null, and `cost` is in the provider's currency. `input` excludes cache reads and writes. |
| `contextTokens` | `input + cacheRead + cacheWrite`, or null. This is the prompt size for the turn. |
| `stopReason` | `stop` \| `tool_use` \| `length` \| `error` \| `aborted` \| `other` |
| `error` | Error message when `stopReason` is `error`, otherwise null. |
| `text` | Visible reply excerpt (at most 6000 characters), plus `textChars`. |
| `thinkingChars` | Length of the reasoning text. The text itself is not included. |
| `toolCallIds` | Ids of the tool calls this response made. |

### `tool_call`

`callId`, `name`, `args` (an object in which every string value is truncated to at most 2000 characters), `argsHash` (a stable hash of the full, untruncated arguments; identical calls have identical hashes).

### `tool_result`

| Field | Meaning |
| --- | --- |
| `callId`, `name` | The call this result answers. |
| `isError` | boolean |
| `errorClass` | null for successes. For errors: `tool` (the tool failed), `harness_policy` (the harness deliberately blocked the call, for example a dedupe guard), `user_denied`, or `unknown`. |
| `output` | Excerpt, at most 3000 characters. |
| `outputChars` | Full output length. This is a proxy for context cost. |
| `durationMs` | number or null |
| `exitCode` | Process exit code for shell-like tools, otherwise null. |
| `nestedUsage` | Usage that a tool spent on its own model calls, in the same shape as `assistant.usage`, or null. |

### `skill_load`

The agent brought a skill's instructions into context.

`skill` (name), `path`, `via`: `read` \| `shell` \| `user_command` \| `harness_injection`, `callId` (null unless `via` is `read` or `shell`), `blocked` (true when the harness refused a repeat load), `chars` (number or null), `contentHash` (`sha256:<hex>` of the content delivered, or null).

`shell` means the agent loaded the skill file through a shell command such as `cat`.

### `instruction_load`

Extra instructions entered context during the run. Examples are conditional instructions and files injected by path.

`source`, `chars`, `trigger` (string or null).

### `delegation`

The run started or messaged another agent.

`callId`, `mode`: `foreground` \| `background` \| `peer_spawn` \| `peer_message`, `childRunId` (null if no child run was found in the bundle), `prompt` (excerpt, at most 4000 characters), `promptChars`, `description` (string or null), `resultChars` (size of the result the parent eventually received, possibly through a later retrieval call or notification, or null), `resultRef` (`{ "seq", "ref" }` of the event that delivered it, or null).

### `context_reset`

The harness compacted, summarised or truncated the context.

`kind`: `compaction` \| `branch_summary` \| `edit`, `tokensBefore` (number or null), `summaryChars` (number or null).

### `retry`

The harness retried a failed model call.

`reason`, `attempt` (number or null).

### `model_change`

`model`, `thinkingLevel`.

### `note`

A harness-specific fact that fits no other type.

`kind` (string), `data` (object).

## Compatibility

- Adapters may add fields. Consumers must ignore fields they do not recognise.
- Messages sent to an already running delegated agent (steering) have no `delegation` mode in version 1. Adapters record them as `note` events.
- `retry` events may be inferred from records the harness keeps, such as failed responses that were later removed from context, when the harness does not record retries directly.

## Adapter obligations

- **Do not invent data.** Use null for unknown values, and put systematic gaps in `warnings`.
- **Mark inferred parent links** with `link.confidence: "inferred"`.
- **Classify harness blocks.** If the harness blocks calls on purpose, give those results `errorClass: "harness_policy"` so they are not counted as tool failures.
- **Include abandoned branches** and mark them with `branch: "abandoned"`.
- **Keep the bundle self-contained.** Redact secrets that are visible in excerpts, replacing them with `[REDACTED]`. Never copy credential files into the bundle.
