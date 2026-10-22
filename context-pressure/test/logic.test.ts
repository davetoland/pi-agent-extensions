// Unit tests for context-pressure decision logic.
// Run: node --test /root/.pi/skill-drafts/extensions/context-pressure/test/logic.test.ts
// Needs Node >= 22.18 (built-in TypeScript type stripping).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Block, Pressure, Usage } from "../logic.ts";
import {
	DEFAULTS,
	evaluate,
	formatTokens,
	isExempt,
	isSubagentSessionFile,
	nextWarn,
	parseConfig,
	READ_BLOCK_BYTES,
	RESULT_MAX_BYTES,
	readBlockReason,
	shouldBlockRead,
	truncateContent,
	warnNote,
} from "../logic.ts";

const usage = (tokens: number | null, contextWindow = 400_000): Usage => ({
	tokens,
	contextWindow,
	percent: tokens === null ? null : (tokens / contextWindow) * 100,
});

const main = (tokens: number, window = 400_000) => evaluate(usage(tokens, window), false, DEFAULTS);
const sub = (tokens: number, window = 1_000_000) => evaluate(usage(tokens, window), true, DEFAULTS);

const textOf = (blocks: Block[]) =>
	blocks
		.filter((b) => b.type === "text")
		.map((b) => (b as { text: string }).text)
		.join("");
const bytes = (s: string) => new TextEncoder().encode(s).length;

describe("parseConfig", () => {
	it("uses defaults when nothing is set", () => {
		assert.deepEqual(parseConfig({}), DEFAULTS);
	});

	for (const value of ["off", "OFF", " 0 ", "false", "no", "disabled"]) {
		it(`disables on PI_CONTEXT_PRESSURE=${JSON.stringify(value)}`, () => {
			assert.equal(parseConfig({ PI_CONTEXT_PRESSURE: value }).enabled, false);
		});
	}

	it("stays enabled for other values", () => {
		assert.equal(parseConfig({ PI_CONTEXT_PRESSURE: "on" }).enabled, true);
		assert.equal(parseConfig({ PI_CONTEXT_PRESSURE: "" }).enabled, true);
	});

	it("reads numeric overrides", () => {
		const c = parseConfig({
			PI_CONTEXT_PRESSURE_WARN: "1",
			PI_CONTEXT_PRESSURE_BLOCK: "2.5",
			PI_CONTEXT_PRESSURE_WARN_TOKENS: "3000",
			PI_CONTEXT_PRESSURE_BLOCK_TOKENS: "7000",
			PI_CONTEXT_PRESSURE_SUB_WARN_TOKENS: "5000",
			PI_CONTEXT_PRESSURE_SUB_BLOCK_TOKENS: "9000",
		});
		assert.deepEqual(c, {
			enabled: true,
			warnPercent: 1,
			blockPercent: 2.5,
			warnTokens: 3000,
			blockTokens: 7000,
			subWarnTokens: 5000,
			subBlockTokens: 9000,
		});
	});

	it("falls back to defaults on invalid numbers", () => {
		const c = parseConfig({
			PI_CONTEXT_PRESSURE_WARN: "abc",
			PI_CONTEXT_PRESSURE_BLOCK: "150",
			PI_CONTEXT_PRESSURE_WARN_TOKENS: "lots",
			PI_CONTEXT_PRESSURE_BLOCK_TOKENS: "-5",
			PI_CONTEXT_PRESSURE_SUB_WARN_TOKENS: "-1",
			PI_CONTEXT_PRESSURE_SUB_BLOCK_TOKENS: "0",
		});
		assert.deepEqual(c, DEFAULTS);
	});
});

describe("evaluate", () => {
	it("fails open on missing or unknown usage", () => {
		assert.equal(evaluate(undefined, false, DEFAULTS), undefined);
		assert.equal(evaluate(usage(null), false, DEFAULTS), undefined);
		assert.equal(evaluate({ tokens: 100, contextWindow: 0, percent: null }, false, DEFAULTS), undefined);
		assert.equal(evaluate({ tokens: Number.NaN, contextWindow: 100, percent: 1 }, false, DEFAULTS), undefined);
	});

	it("main thresholds: none < 20% <= warn < 40% <= block", () => {
		assert.equal(main(79_999)?.level, "none");
		assert.equal(main(80_000)?.level, "warn");
		assert.equal(main(159_999)?.level, "warn");
		assert.equal(main(160_000)?.level, "block");
	});

	it("main: token caps apply when below the percent thresholds", () => {
		// 2M window: 20% is 400k and 40% is 800k, so the 200k and 400k caps come first.
		assert.equal(main(199_999, 2_000_000)?.level, "none");
		assert.equal(main(200_000, 2_000_000)?.level, "warn"); // 10%
		assert.equal(main(399_999, 2_000_000)?.level, "warn");
		assert.equal(main(400_000, 2_000_000)?.level, "block"); // 20%
	});

	it("main: token caps and percentages coincide on a 1M window", () => {
		assert.equal(main(199_999, 1_000_000)?.level, "none");
		assert.equal(main(200_000, 1_000_000)?.level, "warn");
		assert.equal(main(400_000, 1_000_000)?.level, "block");
	});

	it("main: token caps follow the env overrides", () => {
		const config = parseConfig({ PI_CONTEXT_PRESSURE_WARN_TOKENS: "50000", PI_CONTEXT_PRESSURE_BLOCK_TOKENS: "60000" });
		assert.equal(evaluate(usage(49_999, 1_000_000), false, config)?.level, "none");
		assert.equal(evaluate(usage(50_000, 1_000_000), false, config)?.level, "warn");
		assert.equal(evaluate(usage(60_000, 1_000_000), false, config)?.level, "block");
		// Subagent caps are separate.
		assert.equal(evaluate(usage(60_000, 1_000_000), true, config)?.level, "none");
	});

	it("subagent caps do not apply to main sessions", () => {
		assert.equal(main(150_000, 1_000_000)?.level, "none"); // 15%
	});

	it("subagent: token caps apply when below the percent thresholds", () => {
		assert.equal(sub(99_999)?.level, "none");
		assert.equal(sub(100_000)?.level, "warn");
		assert.equal(sub(150_000)?.level, "block");
	});

	it("subagent: percent thresholds apply when they come first", () => {
		assert.equal(sub(26_000, 128_000)?.level, "warn"); // 20.3%
		assert.equal(sub(52_000, 128_000)?.level, "block"); // 40.6%
	});

	it("computes percent from tokens when percent is null", () => {
		assert.equal(evaluate({ tokens: 160_000, contextWindow: 400_000, percent: null }, false, DEFAULTS)?.level, "block");
	});

	it("main re-warn steps every 5 points on a small window", () => {
		assert.equal(main(80_000)?.step, 0); // 20%
		assert.equal(main(99_999)?.step, 0); // 24.99%
		assert.equal(main(100_000)?.step, 1); // 25%
		assert.equal(main(120_000)?.step, 2); // 30%
	});

	it("main re-warn steps every 50k tokens from the token cap on a large window", () => {
		// 2M window: 5 points is 100k, so 50k steps come first. Start is the 200k cap.
		assert.equal(main(200_000, 2_000_000)?.step, 0);
		assert.equal(main(249_999, 2_000_000)?.step, 0);
		assert.equal(main(250_000, 2_000_000)?.step, 1);
		assert.equal(main(300_000, 2_000_000)?.step, 2);
	});

	it("main re-warn steps coincide on a 1M window", () => {
		assert.equal(main(200_000, 1_000_000)?.step, 0);
		assert.equal(main(249_999, 1_000_000)?.step, 0);
		assert.equal(main(250_000, 1_000_000)?.step, 1);
		assert.equal(main(350_000, 1_000_000)?.step, 3);
	});

	it("subagent re-warn steps every 20k tokens", () => {
		assert.equal(sub(100_000)?.step, 0);
		assert.equal(sub(119_999)?.step, 0);
		assert.equal(sub(120_000)?.step, 1);
		assert.equal(sub(140_000)?.step, 2);
	});

	it("subagent steps start from the percent threshold when that is lower", () => {
		// 20% of 128k = 25.6k
		assert.equal(sub(25_600, 128_000)?.step, 0);
		assert.equal(sub(45_600, 128_000)?.step, 1);
	});
});

describe("nextWarn", () => {
	it("warns on first crossing, then once per step", () => {
		let last = -1;
		const seen: boolean[] = [];

		for (const tokens of [40_000, 80_000, 90_000, 99_000, 100_000, 101_000, 120_000, 180_000]) {
			const r = nextWarn(main(tokens), last);
			last = r.lastStep;
			seen.push(r.warn);
		}

		assert.deepEqual(seen, [false, true, false, false, true, false, true, true]);
	});

	it("resets below warn so the next crossing warns again (e.g. after compaction)", () => {
		let r = nextWarn(main(120_000), -1);
		assert.equal(r.warn, true);
		r = nextWarn(main(50_000), r.lastStep);
		assert.deepEqual(r, { warn: false, lastStep: -1 });
		r = nextWarn(main(80_000), r.lastStep);
		assert.equal(r.warn, true);
	});

	it("fails open on unknown usage", () => {
		assert.deepEqual(nextWarn(undefined, 3), { warn: false, lastStep: -1 });
	});
});

describe("messages", () => {
	it("formats tokens", () => {
		assert.equal(formatTokens(950), "950");
		assert.equal(formatTokens(172_400), "172k");
		assert.equal(formatTokens(1_000_000), "1M");
		assert.equal(formatTokens(1_250_000), "1.3M");
	});

	it("main warn note", () => {
		assert.equal(
			warnNote(main(92_000) as Pressure),
			"Context at 92k tokens (23% of 400k). Delegate further reading and searching to subagents and keep their returns short. Save any state you need to a file or the work item.",
		);
	});

	it("subagent warn note", () => {
		assert.equal(
			warnNote(sub(110_000) as Pressure),
			"Context at 110k tokens. Finish the current step and return your findings now. Do not start new reading.",
		);
	});

	it("main warn note on a 1M window", () => {
		assert.match(warnNote(main(210_000, 1_000_000) as Pressure), /^Context at 210k tokens \(21% of 1M\)\. Delegate/);
	});

	it("percent is rounded down", () => {
		assert.match(warnNote(main(159_999) as Pressure), /^Context at 160k tokens \(39% of 400k\)\. /);
	});

	it("read block reasons", () => {
		assert.match(
			readBlockReason(main(252_000) as Pressure),
			/^Blocked by context-pressure: context at 252k tokens \(63% of 400k\)\. Delegate this read to a subagent, or read a narrow range with offset\/limit/,
		);
		assert.match(
			readBlockReason(sub(155_000) as Pressure),
			/^Blocked by context-pressure: context at 155k tokens\. Return your findings now\./,
		);
	});
});

describe("isExempt", () => {
	for (const name of [
		"subagent",
		"steer_subagent",
		"write",
		"edit",
		"ask_user_question",
		"session_eval_export",
		"ask_parent",
		"notify_parent",
		"tmux_agent_spawn",
		"tmux_agent_send",
		"tmux_agent_anything",
	]) {
		it(`exempts ${name}`, () => assert.equal(isExempt(name, {}), true));
	}

	it("exempts get_subagent_result unless verbose: true", () => {
		assert.equal(isExempt("get_subagent_result", { agent_id: "a" }), true);
		assert.equal(isExempt("get_subagent_result", { agent_id: "a", verbose: false }), true);
		assert.equal(isExempt("get_subagent_result", { agent_id: "a", verbose: true }), false);
	});

	for (const name of ["read", "bash", "grep", "find", "ls", "mcp__docs__search", "tmux_agents"]) {
		it(`does not exempt ${name}`, () => assert.equal(isExempt(name, {}), false));
	}
});

describe("shouldBlockRead", () => {
	const block = main(252_000);
	const warn = main(100_000);
	const big = READ_BLOCK_BYTES + 1;

	it("blocks a full read of a large text file at block level", () => {
		assert.equal(shouldBlockRead(block, { path: "a.ts" }, big), true);
		assert.equal(shouldBlockRead(block, { path: "a.ts", offset: 10 }, big), true);
	});

	it("allows files at or under 16 KB", () => {
		assert.equal(shouldBlockRead(block, { path: "a.ts" }, READ_BLOCK_BYTES), false);
	});

	it("allows limit <= 200, blocks larger or invalid limits", () => {
		assert.equal(shouldBlockRead(block, { path: "a.ts", limit: 200 }, big), false);
		assert.equal(shouldBlockRead(block, { path: "a.ts", offset: 500, limit: 50 }, big), false);
		assert.equal(shouldBlockRead(block, { path: "a.ts", limit: 201 }, big), true);
		assert.equal(shouldBlockRead(block, { path: "a.ts", limit: 0 }, big), true);
		assert.equal(shouldBlockRead(block, { path: "a.ts", limit: "100" }, big), true);
	});

	it("allows below block level, images, unknown size and missing path", () => {
		assert.equal(shouldBlockRead(warn, { path: "a.ts" }, big), false);
		assert.equal(shouldBlockRead(undefined, { path: "a.ts" }, big), false);
		assert.equal(shouldBlockRead(block, { path: "shot.PNG" }, big), false);
		assert.equal(shouldBlockRead(block, { path: "a.ts" }, undefined), false);
		assert.equal(shouldBlockRead(block, {}, big), false);
	});
});

describe("truncateContent", () => {
	const p = main(252_000) as Pressure;

	it("leaves content within the limit alone", () => {
		assert.equal(
			truncateContent([{ type: "text", text: "x".repeat(RESULT_MAX_BYTES) }], RESULT_MAX_BYTES, p),
			undefined,
		);
	});

	it("keeps head and tail within the budget and adds a note", () => {
		const text = `HEAD${"m".repeat(20_000)}TAIL`;
		const r = truncateContent([{ type: "text", text }], RESULT_MAX_BYTES, p);
		assert.ok(r);
		assert.equal(r.originalBytes, bytes(text));
		assert.equal(r.keptBytes, RESULT_MAX_BYTES);
		const first = (r.content[0] as { text: string }).text;
		assert.ok(first.startsWith("HEAD"));
		assert.ok(first.endsWith("TAIL"));
		assert.match(first, /truncated by context-pressure/);
		const note = (r.content.at(-1) as { text: string }).text;
		assert.match(note, /^\n\n\[Truncated by context-pressure: context at 252k tokens \(63% of 400k\)\./);
		assert.match(note, /Delegate this to a subagent/);
	});

	it("subagent note tells it to return", () => {
		const r = truncateContent([{ type: "text", text: "x".repeat(10_000) }], RESULT_MAX_BYTES, sub(160_000) as Pressure);
		assert.ok(r);
		assert.match((r.content.at(-1) as { text: string }).text, /Return your findings now\./);
	});

	it("spans multiple text blocks and keeps non-text blocks", () => {
		const image = { type: "image", data: "AAAA", mimeType: "image/png" };
		const content: Block[] = [
			{ type: "text", text: "A".repeat(3000) },
			image,
			{ type: "text", text: "B".repeat(3000) },
			{ type: "text", text: "C".repeat(3000) },
		];
		const r = truncateContent(content, RESULT_MAX_BYTES, p);
		assert.ok(r);
		assert.equal(r.keptBytes, RESULT_MAX_BYTES);
		assert.ok(r.content.includes(image));
		const all = textOf(r.content);
		assert.ok(all.startsWith(`${"A".repeat(3000)}B`));
		assert.ok(all.includes("C".repeat(1024)));
	});

	it("never splits a multi-byte character", () => {
		const text = "é".repeat(5000); // 2 bytes each
		const r = truncateContent([{ type: "text", text }], RESULT_MAX_BYTES, p);
		assert.ok(r);
		const kept = (r.content[0] as { text: string }).text;
		assert.ok(!kept.includes("\uFFFD"));
		assert.ok(r.keptBytes <= RESULT_MAX_BYTES);
	});
});

describe("isSubagentSessionFile", () => {
	const parent = "/root/.pi/agent/sessions/--workspace--/2026-10-21T08-19-25Z_abc.jsonl";
	const child = "/root/.pi/agent/sessions/--workspace--/2026-10-21T08-19-25Z_abc/tasks/2026-10-22T10-08-38Z_def.jsonl";
	const has =
		(...files: string[]) =>
		(f: string) =>
			files.includes(f);

	it("detects a child whose parent transcript exists", () => {
		assert.equal(isSubagentSessionFile(child, has(parent)), true);
	});

	it("requires the parent transcript for the persisted layout", () => {
		assert.equal(isSubagentSessionFile(child, has()), false);
	});

	it("detects the temp-dir layout used when the parent is not persisted", () => {
		assert.equal(isSubagentSessionFile("/tmp/pi-subagents-0/workspace/tasks/x.jsonl", has()), true);
	});

	it("rejects main sessions and missing files", () => {
		assert.equal(isSubagentSessionFile(parent, has(parent)), false);
		assert.equal(isSubagentSessionFile(undefined, has()), false);
		assert.equal(
			isSubagentSessionFile("/somewhere/tasks/notes.txt", () => true),
			false,
		);
	});
});
