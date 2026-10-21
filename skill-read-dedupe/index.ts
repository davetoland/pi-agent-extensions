/**
 * skill-read-dedupe
 *
 * Blocks a full `read` of a SKILL.md when the complete, current text of that
 * file is already in the model's current context.
 *
 * "Current context" is the message list Pi actually sent on the latest model
 * request, captured from the `context_with_system` event (fired after every
 * `context` handler, on each request). Compaction and /tree navigation are
 * therefore handled by Pi's own projection: if a read is no longer in the
 * projected context it is not found and the read proceeds.
 *
 * Fails open: any error, uncertainty, or missing data allows the read.
 * Disable with PI_SKILL_READ_DEDUPE=off (also: 0, false, no, disabled).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";


const SKILL_FILE = "SKILL.md";
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

// Mirrors Pi's /skill:name expansion (core/agent-session.js `_expandSkillCommand`
// and `parseSkillBlock`). If Pi changes the format, matching fails and the
// read is allowed.
const SKILL_BLOCK = /^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/;
const SKILL_PREAMBLE = /^References are relative to [^\n]*\.$/;

type Msg = Record<string, any>;

interface Match {
  source: "read" | "skill";
  skillName?: string;
}


function isDisabled(): boolean {
  const value = (process.env.PI_SKILL_READ_DEDUPE ?? "").trim().toLowerCase();
  return ["off", "0", "false", "no", "disabled"].includes(value);
}


/** Resolve a read-tool path the way Pi does, then canonicalise via realpath. Throws if unresolvable. */
function canonicalPath(rawPath: string, cwd: string): string {
  let p = rawPath.replace(UNICODE_SPACES, " ");

  if (p.startsWith("@")) {
    p = p.slice(1);
  }

  if (p === "~") {
    p = homedir();
  } else if (p.startsWith("~/")) {
    p = join(homedir(), p.slice(2));
  } else if (/^file:\/\//.test(p)) {
    p = fileURLToPath(p);
  }

  return realpathSync(isAbsolute(p) ? p : resolve(cwd, p));
}


/** Same body that Pi injects for /skill:name (frontmatter stripped, trimmed). */
function skillBody(content: string): string {
  const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  if (!normalized.startsWith("---")) {
    return normalized.trim();
  }

  const end = normalized.indexOf("\n---", 3);

  if (end === -1) {
    return normalized.trim();
  }

  return normalized.slice(end + 4).trim();
}


/**
 * True when the read arguments select the whole of `text`. Mirrors Pi's read
 * tool (core/tools/read.js): `offset` is 1-indexed and any value ≤ 1 starts at
 * the first line; `limit` covers the file when it is at least
 * `text.split("\n").length` (a trailing newline counts as one more line).
 * The 2000-line/50KB truncation is not considered here.
 */
function isFullReadArgs(args: unknown, text: string): args is { path: string } {
  if (!args || typeof args !== "object") {
    return false;
  }

  const a = args as Record<string, unknown>;

  if (typeof a.path !== "string") {
    return false;
  }

  const lineCount = text.split("\n").length;

  // Any argument other than `path`, `offset` and `limit` means a possibly
  // partial read.
  return Object.entries(a).every(([key, value]) => {
    if (key === "path" || value === undefined || value === null) {
      return true;
    }

    if (key === "offset") {
      return typeof value === "number" && value <= 1;
    }

    if (key === "limit") {
      return typeof value === "number" && value >= lineCount;
    }

    return false;
  });
}


function sameCanonical(rawPath: string, cwd: string, target: string): boolean {
  try {
    return canonicalPath(rawPath, cwd) === target;
  } catch {
    return false;
  }
}


function findInContext(messages: Msg[], target: string, current: string, cwd: string): Match | undefined {
  // toolCallId -> arguments, for read calls in assistant messages.
  const readCalls = new Map<string, unknown>();

  for (const message of messages) {
    if (message?.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }

    for (const block of message.content) {
      if (block?.type === "toolCall" && block.name === "read" && typeof block.id === "string") {
        readCalls.set(block.id, block.arguments);
      }
    }
  }

  let body: string | undefined;

  for (const message of messages) {
    if (message?.role === "toolResult") {
      if (message.toolName !== "read" || message.isError !== false) {
        continue;
      }

      const args = readCalls.get(message.toolCallId);

      if (!isFullReadArgs(args, current) || !sameCanonical(args.path, cwd, target)) {
        continue;
      }

      // The read tool sets details.truncation only when it truncated output.
      const truncation = message.details?.truncation;

      if (truncation !== undefined && truncation?.truncated !== false) {
        continue;
      }

      const content = message.content;

      if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== "text") {
        continue;
      }

      // Exact equality with the file's current text proves both completeness
      // (no truncation/continuation notice) and currency (no edits since).
      if (content[0].text === current) {
        return { source: "read" };
      }

      continue;
    }

    if (message?.role === "user") {
      const parts = typeof message.content === "string"
        ? [message.content]
        : Array.isArray(message.content)
          ? message.content.filter((p: Msg) => p?.type === "text" && typeof p.text === "string").map((p: Msg) => p.text)
          : [];

      for (const text of parts) {
        const match = text.match(SKILL_BLOCK);

        if (!match || !sameCanonical(match[2], cwd, target)) {
          continue;
        }

        body ??= skillBody(current);

        const injected = match[3];
        const split = injected.indexOf("\n\n");

        if (split !== -1 && SKILL_PREAMBLE.test(injected.slice(0, split)) && injected.slice(split + 2) === body) {
          return { source: "skill", skillName: match[1] };
        }
      }
    }
  }

  return undefined;
}


export default function (pi: ExtensionAPI) {
  let lastContext: Msg[] | undefined;

  const reset = () => {
    lastContext = undefined;
  };

  // Observe only: return nothing so the request is unchanged.
  pi.on("context_with_system", async (event) => {
    try {
      lastContext = Array.isArray(event.messages) ? (event.messages as Msg[]) : undefined;
    } catch {
      lastContext = undefined;
    }

    return undefined;
  });

  // Until the next model request, the cached list may not match what the model
  // will see. Dropping it only makes us fail open.
  pi.on("session_start", async () => reset());
  pi.on("session_compact", async () => reset());
  pi.on("session_tree", async () => reset());
  pi.on("session_shutdown", async () => reset());

  pi.on("tool_call", async (event, ctx) => {
    try {
      if (isDisabled() || event.toolName !== "read" || event.parentToolCallId || !lastContext) {
        return undefined;
      }

      const input = event.input as Record<string, unknown>;

      if (typeof input?.path !== "string" || basename(input.path) !== SKILL_FILE) {
        return undefined;
      }

      const target = canonicalPath(input.path, ctx.cwd);

      if (basename(target) !== SKILL_FILE) {
        return undefined;
      }

      const current = readFileSync(target, "utf8");

      if (!isFullReadArgs(input, current)) {
        return undefined;
      }

      const found = findInContext(lastContext, target, current, ctx.cwd);

      if (!found) {
        return undefined;
      }

      const origin = found.source === "skill"
        ? `the /skill:${found.skillName} injection earlier in this conversation (frontmatter omitted)`
        : "an earlier read in this conversation";

      const reason = `Not re-read: the complete current text of ${target} is already in your context from ${origin}. Use that copy.`;

      if (ctx.hasUI) {
        try {
          ctx.ui.notify(`skill-read-dedupe: skipped re-read of ${basename(dirname(target))}/${SKILL_FILE}`, "info");
        } catch {
          // UI is best effort.
        }
      }

      return { block: true, reason };
    } catch {
      return undefined;
    }
  });
}
