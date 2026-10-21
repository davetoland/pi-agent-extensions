# skill-read-dedupe

A Pi extension that blocks a full `read` of a `SKILL.md` when the complete, current text of that file is already in the model's current context. The model gets this tool error instead:

> Not re-read: the complete current text of `<path>` is already in your context from an earlier read in this conversation. Use that copy.

## How it decides

1. The extension caches the message list from the `context_with_system` event. Pi fires this event on every model request, after all `context` handlers have run, and the list it carries is the transcript sent to the provider. Compaction and `/tree` navigation are already applied to it, so the extension keeps no history of its own. The cache is cleared on `session_start`, `session_compact`, `session_tree` and `session_shutdown`; until the next request, every read is allowed.
2. On `tool_call` for `read`, the extension acts only when:
   - the call reads the whole file: `offset` is absent, null or ≤ 1; `limit` is absent, null or at least the file's current line count; there is no other argument besides `path`. Lines are counted as Pi's read tool counts them, `text.split("\n").length`, so a trailing newline adds one line. For example `offset: 1, limit: 2000`, which some models always send, counts as full for a file of up to 2000 lines;
   - the path's basename is `SKILL.md`, both as given and after resolution (strip `@`, expand `~` or `file://`, resolve against `ctx.cwd`, then `realpath`);
   - the call is not a nested call (`parentToolCallId` unset, e.g. from codemode).
3. The cached context contains a match if either of these holds:
   - **A previous read:** a `toolResult` from `read` with `isError === false`. Its matching assistant `toolCall` read the whole file by the same rule, measured against the file's current line count, and its path resolves to the same real path. `details.truncation` is absent or `truncated === false`. Its content is a single text block equal to the file's current text, compared byte for byte (UTF-8, CRLF preserved). Exact equality rules out truncation and continuation notices and also catches files edited since the read.
   - **A `/skill:name` injection:** a user message whose text matches Pi's skill block format, `<skill name="…" location="…">\nReferences are relative to ….\n\n<body>\n</skill>`. `location` must resolve to the same real path, and `<body>` must equal the current file with the frontmatter removed and whitespace trimmed, which is how Pi builds the block.
4. Anything else is allowed. Every handler is wrapped in `try/catch` and returns nothing on error, because Pi treats a thrown `tool_call` handler as a block.

## Disable

```bash
PI_SKILL_READ_DEDUPE=off pi    # also accepts 0, false, no, disabled
```

The variable is checked on every call.

## Enable

The extension is not loaded from this directory. To load it:

```bash
# One run only
pi -e /root/.pi/agent/extensions-disabled/skill-read-dedupe/index.ts

# Permanently
cp -r /root/.pi/agent/extensions-disabled/skill-read-dedupe /root/.pi/agent/extensions/
# then /reload or restart pi
```

## Known gaps and risks

- **The `/skill` injection has no frontmatter.** Pi strips the frontmatter when it injects a skill, but the extension still counts the injection as present, and the block reason says the frontmatter was omitted. `name` and `description` are in the system prompt's skill list. Other frontmatter fields, such as `allowed-tools` and `metadata`, are not, and a model that needs them is blocked from re-reading the file. If that matters, set the environment variable to turn the extension off.
- **The skill block format is copied from Pi.** If a Pi update changes the format or the frontmatter stripping, injections stop matching and those reads are allowed. Nothing is blocked wrongly.
- **Parallel tool calls in one batch.** The check runs when the call starts. If a sibling call in the same assistant message edits the `SKILL.md` (for example `bash` running `echo >>`), the read can be blocked against the pre-edit text. Pi's read would face the same race.
- **Cache is per extension.** The extension sees the `context_with_system` output from the moment its own handler runs. Another extension's `context_with_system` handler that runs later and drops or rewrites a read result is not seen, and the model is told the text is present when it is not. `context` handlers do not cause this, because they all run before `context_with_system`.
- **A blocked read is an error result.** Some models may retry or switch to `bash cat`. `bash` is not intercepted.
- Reads with `offset` > 1 or `limit` below the file's current line count are never counted or blocked, even when the rest of the file is in context from other reads. A `limit` equal to the number of visible lines in a file that ends with a newline is one short by Pi's count, so it is treated as partial; Pi appends a `[1 more lines in file…]` notice to that result anyway.
- Only files named exactly `SKILL.md` (case-sensitive) are covered.
