/**
 * context-pressure
 *
 * Pushes the model to delegate as its context fills, and cuts off heavy reads
 * past a limit. Thresholds are a percent of the model's context window, from
 * `ctx.getContextUsage()`, plus an absolute token cap. Whichever comes first
 * applies.
 *
 * - Warn (default 20% or 200k tokens, subagents 20% or 100k tokens): appends a
 *   short note to a tool result when the threshold is first crossed. It adds
 *   the note again every 5 more points or 50k tokens, whichever comes first.
 *   Subagents get it every 20k tokens. Steps count from the warn point that
 *   was crossed first.
 * - Block (default 40% or 400k tokens, subagents 40% or 150k tokens): blocks
 *   `read` of a text file over 16 KB unless `limit` <= 200, and truncates any
 *   other tool result over 4 KB. Delegation and state-saving tools are exempt.
 *
 * Fails open: any error, or missing usage data, allows the call and leaves the
 * result unchanged.
 *
 * Disable with PI_CONTEXT_PRESSURE=off (also: 0, false, no, disabled).
 * Tune with PI_CONTEXT_PRESSURE_WARN, PI_CONTEXT_PRESSURE_BLOCK (percent),
 * PI_CONTEXT_PRESSURE_WARN_TOKENS, PI_CONTEXT_PRESSURE_BLOCK_TOKENS (main
 * session tokens), PI_CONTEXT_PRESSURE_SUB_WARN_TOKENS and
 * PI_CONTEXT_PRESSURE_SUB_BLOCK_TOKENS (subagent tokens).
 */

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	type Block,
	evaluate,
	isExempt,
	isSubagentSessionFile,
	nextWarn,
	type Pressure,
	parseConfig,
	READ_RESULT_MAX_BYTES,
	RESULT_MAX_BYTES,
	readBlockReason,
	shouldBlockRead,
	truncateContent,
	warnNote,
} from "./logic.ts";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** Resolve a read-tool path the way Pi does. Throws if it cannot. */
function resolveReadPath(rawPath: string, cwd: string): string {
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

	return isAbsolute(p) ? p : resolve(cwd, p);
}

/** Byte size of a regular file, or undefined when it cannot be read as one. */
function fileSize(rawPath: string, cwd: string): number | undefined {
	try {
		const stat = statSync(resolveReadPath(rawPath, cwd));

		return stat.isFile() ? stat.size : undefined;
	} catch {
		return undefined;
	}
}

export default function (pi: ExtensionAPI) {
	// All state lives in this closure: pi-subagents runs children in the same
	// process, each with its own extension runtime, so module-level state would
	// be shared between sessions.
	let lastWarnStep = -1;
	let subagentCache: { file: string | undefined; subagent: boolean } | undefined;

	const reset = () => {
		lastWarnStep = -1;
		subagentCache = undefined;
	};

	const isSubagent = (ctx: ExtensionContext): boolean => {
		const file = ctx.sessionManager.getSessionFile();

		if (!subagentCache || subagentCache.file !== file) {
			subagentCache = { file, subagent: isSubagentSessionFile(file, existsSync) };
		}

		return subagentCache.subagent;
	};

	const pressureFor = (ctx: ExtensionContext): { pressure: Pressure | undefined; enabled: boolean } => {
		const config = parseConfig(process.env);

		if (!config.enabled) {
			return { pressure: undefined, enabled: false };
		}

		return { pressure: evaluate(ctx.getContextUsage(), isSubagent(ctx), config), enabled: true };
	};

	pi.on("session_start", async () => reset());
	pi.on("session_shutdown", async () => reset());

	pi.on("tool_call", async (event, ctx) => {
		// A throw from a tool_call handler blocks the tool, so everything is caught.
		try {
			if (event.toolName !== "read" || event.parentToolCallId) {
				return undefined;
			}

			const { pressure } = pressureFor(ctx);

			if (pressure?.level !== "block") {
				return undefined;
			}

			const input = event.input as Record<string, unknown>;
			const size = typeof input.path === "string" ? fileSize(input.path, ctx.cwd) : undefined;

			if (!shouldBlockRead(pressure, input, size)) {
				return undefined;
			}

			if (ctx.hasUI) {
				try {
					ctx.ui.notify(`context-pressure: blocked a ${Math.round((size ?? 0) / 1024)} KB read`, "info");
				} catch {
					// UI is best effort.
				}
			}

			return { block: true, reason: readBlockReason(pressure) };
		} catch {
			return undefined;
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		try {
			if (event.parentToolCallId) {
				return undefined;
			}

			const { pressure, enabled } = pressureFor(ctx);

			if (!enabled) {
				return undefined;
			}

			let content = event.content as Block[];
			let changed = false;

			if (pressure?.level === "block" && !isExempt(event.toolName, event.input)) {
				const max = event.toolName === "read" ? READ_RESULT_MAX_BYTES : RESULT_MAX_BYTES;
				const truncated = truncateContent(content, max, pressure);

				if (truncated) {
					content = truncated.content;
					changed = true;
				}
			}

			const warn = nextWarn(pressure, lastWarnStep);
			lastWarnStep = warn.lastStep;

			if (warn.warn && pressure) {
				// Leading blank line: some providers join text blocks without a separator.
				content = [...content, { type: "text", text: `\n\n${warnNote(pressure)}` }];
				changed = true;
			}

			if (!changed) {
				return undefined;
			}

			// Return structuredContent too, or Pi drops it.
			return { content: content as typeof event.content, structuredContent: event.structuredContent };
		} catch {
			return undefined;
		}
	});
}
