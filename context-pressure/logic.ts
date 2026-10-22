/**
 * Pure decision logic for context-pressure. No Pi imports, no I/O, so it can be
 * unit tested with plain `node --test`.
 */

export interface Config {
  enabled: boolean;
  /** Percent of the context window at which notes start. */
  warnPercent: number;
  /** Percent of the context window at which heavy reads are blocked and results truncated. */
  blockPercent: number;
  /** Main sessions only: absolute token count at which notes start. */
  warnTokens: number;
  /** Main sessions only: absolute token count at which blocking starts. */
  blockTokens: number;
  /** Subagent sessions only: absolute token count at which notes start. */
  subWarnTokens: number;
  /** Subagent sessions only: absolute token count at which blocking starts. */
  subBlockTokens: number;
}

/** Same shape as Pi's `ContextUsage`. */
export interface Usage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export type Level = "none" | "warn" | "block";

export interface Pressure {
  level: Level;
  tokens: number;
  contextWindow: number;
  percent: number;
  subagent: boolean;
  /** Re-warn step index: 0 when the warn threshold is first crossed, +1 per step after. -1 below warn. */
  step: number;
}

export interface TextBlock {
  type: "text";
  text: string;
}

/** Any content block. Only text blocks are inspected; others pass through untouched. */
export type Block = TextBlock | { type: string; [key: string]: unknown };

export const DEFAULTS: Config = {
  enabled: true,
  warnPercent: 20,
  blockPercent: 40,
  warnTokens: 200_000,
  blockTokens: 400_000,
  subWarnTokens: 100_000,
  subBlockTokens: 150_000,
};

/** Main sessions re-warn every this many percentage points, or every MAIN_WARN_STEP_TOKENS, whichever is fewer tokens. */
export const WARN_STEP_PERCENT = 5;
/** Main sessions re-warn every this many tokens, or every WARN_STEP_PERCENT points, whichever is fewer tokens. */
export const MAIN_WARN_STEP_TOKENS = 50_000;
/** Subagent sessions re-warn every this many tokens. */
export const WARN_STEP_TOKENS = 20_000;
/** A full `read` of a file larger than this is blocked under pressure. */
export const READ_BLOCK_BYTES = 16 * 1024;
/** A `read` with `limit` at or below this many lines is allowed under pressure. */
export const READ_MAX_LIMIT_LINES = 200;
/** Non-read results are cut to this many bytes of text under pressure. */
export const RESULT_MAX_BYTES = 4 * 1024;
/** Read results that got through the read rule are still capped at this. */
export const READ_RESULT_MAX_BYTES = READ_BLOCK_BYTES;
/** Share of a truncated result kept from the end (exit codes, "Full output: …" trailers). */
const TAIL_SHARE = 0.25;

const OFF_VALUES = new Set(["off", "0", "false", "no", "disabled"]);

/** Tools that are never blocked or truncated: delegation and state saving. */
const EXEMPT_TOOLS = new Set([
  "subagent",
  "get_subagent_result",
  "steer_subagent",
  "ask_parent",
  "notify_parent",
  "write",
  "edit",
  "ask_user_question",
  "session_eval_export",
]);

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);


function positiveNumber(raw: string | undefined, fallback: number, max = Number.POSITIVE_INFINITY): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }

  const value = Number(raw.trim());

  return Number.isFinite(value) && value > 0 && value <= max ? value : fallback;
}


/** Read configuration from environment variables. Invalid values fall back to the defaults. */
export function parseConfig(env: Record<string, string | undefined>): Config {
  const off = (env.PI_CONTEXT_PRESSURE ?? "").trim().toLowerCase();

  return {
    enabled: !OFF_VALUES.has(off),
    warnPercent: positiveNumber(env.PI_CONTEXT_PRESSURE_WARN, DEFAULTS.warnPercent, 100),
    blockPercent: positiveNumber(env.PI_CONTEXT_PRESSURE_BLOCK, DEFAULTS.blockPercent, 100),
    warnTokens: positiveNumber(env.PI_CONTEXT_PRESSURE_WARN_TOKENS, DEFAULTS.warnTokens),
    blockTokens: positiveNumber(env.PI_CONTEXT_PRESSURE_BLOCK_TOKENS, DEFAULTS.blockTokens),
    subWarnTokens: positiveNumber(env.PI_CONTEXT_PRESSURE_SUB_WARN_TOKENS, DEFAULTS.subWarnTokens),
    subBlockTokens: positiveNumber(env.PI_CONTEXT_PRESSURE_SUB_BLOCK_TOKENS, DEFAULTS.subBlockTokens),
  };
}


/**
 * Work out the pressure level. Returns undefined (no pressure, fail open) when
 * usage is missing or not a usable number.
 */
export function evaluate(usage: Usage | undefined, subagent: boolean, config: Config): Pressure | undefined {
  if (!usage || typeof usage.tokens !== "number" || typeof usage.contextWindow !== "number"
    || !Number.isFinite(usage.tokens) || !(usage.contextWindow > 0)) {
    return undefined;
  }

  const tokens = usage.tokens;
  const contextWindow = usage.contextWindow;
  const percent = typeof usage.percent === "number" && Number.isFinite(usage.percent)
    ? usage.percent
    : (tokens / contextWindow) * 100;

  const warnByPercent = percent >= config.warnPercent;
  const blockByPercent = percent >= config.blockPercent;
  const warnTokens = subagent ? config.subWarnTokens : config.warnTokens;
  const blockTokens = subagent ? config.subBlockTokens : config.blockTokens;
  const warnByTokens = tokens >= warnTokens;
  const blockByTokens = tokens >= blockTokens;

  const level: Level = blockByPercent || blockByTokens ? "block" : warnByPercent || warnByTokens ? "warn" : "none";

  let step = -1;

  if (level !== "none") {
    // Steps count from whichever warn threshold is lower in tokens.
    const start = Math.min(warnTokens, (config.warnPercent / 100) * contextWindow);
    // Main sessions step every 5 points or every 50k tokens, whichever is fewer tokens.
    const size = subagent
      ? WARN_STEP_TOKENS
      : Math.min(MAIN_WARN_STEP_TOKENS, (WARN_STEP_PERCENT / 100) * contextWindow);
    step = Math.max(0, Math.floor((tokens - start) / size));
  }

  return { level, tokens, contextWindow, percent, subagent, step };
}


/**
 * Decide whether to add a note, given the last step already noted (-1 for
 * none). Returns the new last step. Dropping below warn (e.g. after
 * compaction) resets, so the next crossing warns again.
 */
export function nextWarn(pressure: Pressure | undefined, lastStep: number): { warn: boolean; lastStep: number } {
  if (!pressure || pressure.level === "none") {
    return { warn: false, lastStep: -1 };
  }

  if (pressure.step > lastStep) {
    return { warn: true, lastStep: pressure.step };
  }

  return { warn: false, lastStep: Math.min(lastStep, pressure.step) };
}


export function formatTokens(tokens: number): string {
  if (tokens < 1000) {
    return String(Math.round(tokens));
  }

  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  }

  return `${Math.round(tokens / 1000)}k`;
}


function formatKB(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}


/** Whole percent, rounded down so "40%" is never shown below a 40% threshold. */
function wholePercent(percent: number): number {
  return Math.floor(percent);
}


function where(p: Pressure): string {
  return p.subagent
    ? `${formatTokens(p.tokens)} tokens`
    : `${formatTokens(p.tokens)} tokens (${wholePercent(p.percent)}% of ${formatTokens(p.contextWindow)})`;
}


export function warnNote(p: Pressure): string {
  if (p.subagent) {
    return `Context at ${formatTokens(p.tokens)} tokens. Finish the current step and return your findings now. Do not start new reading.`;
  }

  return `Context at ${where(p)}. `
    + "Delegate further reading and searching to subagents and keep their returns short. "
    + "Save any state you need to a file or the work item.";
}


export function readBlockReason(p: Pressure): string {
  if (p.subagent) {
    return `Blocked by context-pressure: context at ${where(p)}. Return your findings now. `
      + `If one more detail is essential, read a narrow range with offset/limit (limit <= ${READ_MAX_LIMIT_LINES}).`;
  }

  return `Blocked by context-pressure: context at ${where(p)}. Delegate this read to a subagent, `
    + `or read a narrow range with offset/limit (limit <= ${READ_MAX_LIMIT_LINES}).`;
}


function truncationNote(p: Pressure, originalBytes: number, keptBytes: number): string {
  const action = p.subagent
    ? "Return your findings now."
    : "Delegate this to a subagent, or narrow the command or range.";

  return `[Truncated by context-pressure: context at ${where(p)}. Output was ${formatKB(originalBytes)}; `
    + `kept the first and last parts, ${formatKB(keptBytes)} in total. ${action}]`;
}


/** True for tools that must never be blocked or truncated. */
export function isExempt(toolName: string, input: Record<string, unknown> | undefined): boolean {
  if (toolName === "get_subagent_result") {
    return input?.verbose !== true;
  }

  return EXEMPT_TOOLS.has(toolName) || toolName.startsWith("tmux_agent_");
}


export function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf(".");

  return dot !== -1 && IMAGE_EXTENSIONS.has(path.slice(dot).toLowerCase());
}


/**
 * Decide whether to block a `read`. `fileSize` is the byte size of the
 * resolved file, or undefined when it could not be found (then allow: the read
 * tool reports its own error).
 */
export function shouldBlockRead(
  pressure: Pressure | undefined,
  input: Record<string, unknown>,
  fileSize: number | undefined,
): boolean {
  if (!pressure || pressure.level !== "block" || typeof input.path !== "string") {
    return false;
  }

  if (isImagePath(input.path) || fileSize === undefined || fileSize <= READ_BLOCK_BYTES) {
    return false;
  }

  const limit = input.limit;

  return !(typeof limit === "number" && Number.isFinite(limit) && limit > 0 && limit <= READ_MAX_LIMIT_LINES);
}


const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/** First `max` bytes of `text`, never splitting a character. */
function headBytes(text: string, max: number): string {
  const bytes = encoder.encode(text);

  if (bytes.length <= max) {
    return text;
  }

  let end = max;

  // Back off continuation bytes (10xxxxxx) so we cut on a character boundary.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) {
    end--;
  }

  return decoder.decode(bytes.subarray(0, end));
}

/** Last `max` bytes of `text`, never splitting a character. */
function tailBytes(text: string, max: number): string {
  const bytes = encoder.encode(text);

  if (bytes.length <= max) {
    return text;
  }

  let start = bytes.length - max;

  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) {
    start++;
  }

  return decoder.decode(bytes.subarray(start));
}


export interface Truncated {
  content: Block[];
  originalBytes: number;
  keptBytes: number;
}

/**
 * Cut the text of `content` to at most `maxBytes`, keeping the first 75% and
 * last 25% of the budget, and append a note. Non-text blocks are kept in
 * place. Returns undefined when the text already fits.
 */
export function truncateContent(content: readonly Block[], maxBytes: number, p: Pressure): Truncated | undefined {
  const texts = content.filter((b): b is TextBlock => b.type === "text" && typeof (b as TextBlock).text === "string");
  const originalBytes = texts.reduce((sum, b) => sum + byteLength(b.text), 0);

  if (originalBytes <= maxBytes) {
    return undefined;
  }

  const tailBudget = Math.floor(maxBytes * TAIL_SHARE);
  const headBudget = maxBytes - tailBudget;

  // Bytes before each text block's start, so each block knows where it sits.
  let offset = 0;
  const tailStart = originalBytes - tailBudget;
  const out: Block[] = [];
  let keptBytes = 0;
  let markerPlaced = false;

  for (const block of content) {
    if (block.type !== "text" || typeof (block as TextBlock).text !== "string") {
      out.push(block);
      continue;
    }

    const text = (block as TextBlock).text;
    const size = byteLength(text);
    const start = offset;
    const end = offset + size;
    offset = end;

    // Part inside the head budget.
    const head = start < headBudget ? headBytes(text, headBudget - start) : "";
    // Part inside the tail budget.
    const tail = end > tailStart ? tailBytes(text, end - Math.max(start, tailStart)) : "";
    let marker = "";

    if (end > headBudget && start < tailStart && !markerPlaced) {
      marker = "\n\n[… truncated by context-pressure …]\n\n";
      markerPlaced = true;
    }

    keptBytes += byteLength(head) + byteLength(tail);

    const kept = head + marker + tail;

    if (kept.length > 0) {
      out.push({ ...block, text: kept });
    }
  }

  // Leading blank line: some providers join text blocks without a separator.
  out.push({ type: "text", text: `\n\n${truncationNote(p, originalBytes, keptBytes)}` });

  return { content: out, originalBytes, keptBytes };
}


/**
 * True when the session file belongs to a pi-subagents child. The package
 * writes child transcripts to `<parent dir>/<parent stem>/tasks/<child>.jsonl`,
 * or `<tmpdir>/pi-subagents-<uid>/<cwd>/tasks/<child>.jsonl` when the parent is
 * not persisted. `exists` checks the parent transcript for the first layout.
 */
export function isSubagentSessionFile(
  sessionFile: string | undefined,
  exists: (path: string) => boolean,
): boolean {
  if (!sessionFile) {
    return false;
  }

  const parts = sessionFile.replace(/\\/g, "/").split("/");

  if (parts.length < 4 || parts[parts.length - 2] !== "tasks" || !parts[parts.length - 1].endsWith(".jsonl")) {
    return false;
  }

  if (parts.some(part => /^pi-subagents-\d+$/.test(part))) {
    return true;
  }

  // <parent dir>/<parent stem>/tasks/<child>.jsonl -> <parent dir>/<parent stem>.jsonl
  const parentFile = `${parts.slice(0, -2).join("/")}.jsonl`;

  return exists(parentFile);
}
