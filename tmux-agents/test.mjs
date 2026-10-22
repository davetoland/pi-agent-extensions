import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync, execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
const exec = promisify(execFile);

// Use the already-installed Pi loader dependencies. No installation is needed.
const piDir =
	process.env.PI_TEST_PACKAGE_DIR ||
	join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@earendil-works/pi-coding-agent");
const requirePi = createRequire(join(piDir, "package.json"));
const { createJiti } = requirePi("jiti");
const jiti = createJiti(import.meta.url, {
	moduleCache: false,
	alias: {
		typebox: requirePi.resolve("typebox"),
		"@earendil-works/pi-ai": join(piDir, "node_modules/@earendil-works/pi-ai/dist/index.js"),
	},
});
const extensionPath = join(dirname(fileURLToPath(import.meta.url)), "index.ts");
const mod = await jiti.import(extensionPath);

/** Run fn with TMUX and TMUX_PANE set, as inside tmux, then restore them. The extension is inactive outside tmux. */
async function insideTmux(fn) {
	const before = { TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE };
	process.env.TMUX ??= "/tmp/tmux-agents-test-unused-socket,0,0";
	process.env.TMUX_PANE ??= "%1";
	try {
		return await fn();
	} finally {
		for (const [key, value] of Object.entries(before)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

test("context retains unknown values and reports raw tokens and decimal k", () => {
	const ctx = { getContextUsage: () => ({ tokens: null, contextWindow: 200000, percent: null }) };
	assert.deepEqual(mod.contextSummary(ctx), {
		tokens: null,
		tokensK: null,
		contextWindow: 200000,
		contextWindowK: "200.0k",
		percent: null,
	});
	ctx.getContextUsage = () => ({ tokens: 123456, contextWindow: 200000, percent: 61.728 });
	assert.equal(mod.contextSummary(ctx).tokensK, "123.5k");
	ctx.getContextUsage = () => undefined;
	assert.equal(mod.contextSummary(ctx).tokens, null);
	assert.equal(mod.contextSummary(ctx).contextWindow, null);
	ctx.getContextUsage = () => ({ tokens: 0, contextWindow: 200000, percent: 0 });
	assert.equal(mod.contextSummary(ctx).tokensK, "0.0k");
});

test("reply contains only latest assistant text with stop reason and error", () => {
	const entries = [
		{ type: "message", id: "old", message: { role: "assistant", content: [{ type: "text", text: "old" }] } },
		{
			type: "message",
			id: "new",
			message: {
				role: "assistant",
				timestamp: 123,
				stopReason: "error",
				errorMessage: "failed",
				content: [
					{ type: "thinking", thinking: "PRIVATE" },
					{ type: "text", text: "visible" },
					{ type: "toolCall", arguments: { key: "PRIVATE" } },
				],
			},
		},
		{ type: "message", message: { role: "user", content: "PRIVATE prompt" } },
	];
	assert.deepEqual(mod.assistantReply(entries), {
		id: "new",
		timestamp: 123,
		text: "visible",
		stopReason: "error",
		error: "failed",
	});
	assert.equal(mod.assistantReply([]), null);
});

test("bounded output includes a truncation marker within the limit", () => {
	const result = mod.bounded("x".repeat(30000), 1000);
	assert.ok(result.length <= 1000);
	assert.match(result, /truncated/);
	assert.equal(mod.bounded("short", 1000), "short");
});

test("tool JSON remains valid for bounded strings that expand during escaping", async () => {
	const tools = new Map();
	await insideTmux(() =>
		mod.default({
			registerTool(tool) {
				tools.set(tool.name, tool);
			},
			on() {},
		}),
	);
	const original = mod.TmuxAgents.prototype.read;
	try {
		for (const text of ['"\n'.repeat(10000), "\x00".repeat(20000)]) {
			mod.TmuxAgents.prototype.read = async () => ({ id: "%1", status: "ready", terminal: text });
			const result = await tools.get("tmux_agent_read").execute("test", { id: "%1", terminal: true, maxChars: 20000 });
			const output = result.content[0].text;
			assert.ok(output.length <= 128000);
			assert.equal(JSON.parse(output).terminal, text);
		}
		const reply = { id: "reply", text: '"\n'.repeat(6000), error: "\x00".repeat(2000), stopReason: "error" };
		mod.TmuxAgents.prototype.read = async () => ({ id: "%1", status: "ready", reply });
		const result = await tools.get("tmux_agent_read").execute("test", { id: "%1" });
		assert.deepEqual(JSON.parse(result.content[0].text).reply, reply);
		mod.TmuxAgents.prototype.read = async () => ({ terminal: "x".repeat(128000) });
		const oversized = await tools.get("tmux_agent_read").execute("test", { id: "%1", terminal: true });
		assert.ok(oversized.content[0].text.length <= 128000);
		assert.match(JSON.parse(oversized.content[0].text).error, /exceeds 128000/);
	} finally {
		mod.TmuxAgents.prototype.read = original;
	}
});

test("deferred telemetry drains and cannot outlive shutdown, reload, or session replacement", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "tmux-agents-lifecycle-"));
	const keys = ["PI_TMUX_AGENT_DIR", "PI_TMUX_AGENT_TOKEN", "TMUX", "TMUX_PANE"];
	const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
	const file = join(root, "snapshot.json");
	const hooks = new Map();
	const warnings = [];
	let idle = true;
	let pending = false;
	let entries = [];
	let sessionId = "first";
	let reads = 0;
	let tokens = 2000;
	let invalidated = false;
	let resolveOwnership;
	const access = () => {
		reads++;
		assert.equal(invalidated, false, "old context must not be read");
	};
	const ctx = {
		mode: "tui",
		isIdle() {
			access();
			return idle;
		},
		hasPendingMessages: () => pending,
		sessionManager: {
			getSessionId() {
				access();
				return sessionId;
			},
			getSessionFile: () => undefined,
			getBranch: () => entries,
			getEntries() {
				access();
				return entries;
			},
		},
		getContextUsage: () => ({ tokens, contextWindow: 200000, percent: tokens / 2000 }),
		ui: { getEditorText: () => "", notify: (text) => warnings.push(text) },
	};
	const emit = (event, extra = {}) => hooks.get(event)?.({ type: event, ...extra }, ctx);
	try {
		process.env.PI_TMUX_AGENT_DIR = root;
		process.env.PI_TMUX_AGENT_TOKEN = "test-token";
		process.env.TMUX = `${join(root, "unused-socket")},0,0`;
		process.env.TMUX_PANE = "%1";
		mod.default({
			registerTool() {},
			on(event, handler) {
				hooks.set(event, handler);
			},
			exec: async () => {
				if (resolveOwnership)
					await new Promise((resolve) => {
						resolveOwnership = resolve;
					});
				return { code: 0, stdout: String(process.pid) };
			},
		});
		t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
		const snapshot = () => JSON.parse(readFileSync(file, "utf8"));
		await emit("session_start");
		idle = false;
		await emit("session_tree");
		t.mock.timers.tick(300);
		assert.equal(snapshot().idle, false);
		idle = true;
		pending = true;
		t.mock.timers.tick(100);
		assert.equal(snapshot().idle, false, "queued continuation must not be published as settled");
		pending = false;
		t.mock.timers.tick(100);
		assert.equal(snapshot().idle, true);
		let previousReads = reads;
		let previous = readFileSync(file, "utf8");
		t.mock.timers.tick(1000);
		assert.equal(reads, previousReads, "refresh stops after settlement");
		assert.equal(readFileSync(file, "utf8"), previous);

		await emit("user_bash", { command: "synthetic bash" });
		t.mock.timers.tick(300);
		assert.equal(readFileSync(file, "utf8"), previous, "idle alone cannot settle bash");
		entries = [
			{
				type: "message",
				id: "bash",
				message: { role: "bashExecution", command: "synthetic bash", output: "PRIVATE OUTPUT" },
			},
		];
		tokens = 4005;
		t.mock.timers.tick(100);
		assert.equal(snapshot().context.tokens, 4005);
		assert.doesNotMatch(readFileSync(file, "utf8"), /PRIVATE OUTPUT|synthetic bash/);

		await emit("user_bash", { command: "no saved result" });
		t.mock.timers.tick(10 * 60 * 1000);
		assert.match(warnings.at(-1), /timed out/);
		previousReads = reads;
		t.mock.timers.tick(1000);
		assert.equal(reads, previousReads, "missing bash result must not create an indefinite timer");

		for (const reason of ["reload", "new", "resume", "fork", "quit"]) {
			idle = false;
			await emit("session_compact");
			await emit("user_bash", { command: "still pending" });
			await emit("session_shutdown", { reason });
			assert.equal(snapshot().stopped, true);
			previous = readFileSync(file, "utf8");
			previousReads = reads;
			invalidated = true;
			t.mock.timers.tick(1000);
			await emit("agent_settled");
			assert.equal(reads, previousReads, `${reason} must cancel all old-context access`);
			assert.equal(readFileSync(file, "utf8"), previous, "stopped snapshot must not be overwritten");
			invalidated = false;
			sessionId = reason;
			idle = true;
			await emit("session_start");
			previous = readFileSync(file, "utf8");
			previousReads = reads;
			t.mock.timers.tick(10 * 60 * 1000);
			assert.equal(reads, previousReads);
			assert.equal(readFileSync(file, "utf8"), previous, "old refresh must not overwrite a replacement session");
		}
		// An ownership probe may still be awaiting tmux when shutdown occurs.
		resolveOwnership = true;
		const starting = emit("session_start");
		await emit("session_shutdown", { reason: "quit" });
		previous = readFileSync(file, "utf8");
		resolveOwnership();
		await starting;
		await emit("session_tree");
		t.mock.timers.tick(1000);
		assert.equal(readFileSync(file, "utf8"), previous, "late ownership must not reactivate a stopped instance");
	} finally {
		invalidated = false;
		await emit("session_shutdown");
		t.mock.timers.reset();
		for (const key of keys) {
			if (before[key] === undefined) delete process.env[key];
			else process.env[key] = before[key];
		}
	}
});

test("argument boundaries preserve metacharacters and prompt files are validated before spawn", async () => {
	const root = mkdtempSync(join(tmpdir(), "tmux-agents-unit-"));
	const prompt = join(root, "prompt ; $(nope).md");
	writeFileSync(prompt, "Test system prompt.");
	const launch = mod.launchArgs(
		{ name: "test-label", systemPrompt: prompt, model: "model;$(nope)", provider: "test provider" },
		root,
	);
	assert.equal(launch.args[launch.args.indexOf("--system-prompt") + 1], prompt);
	assert.equal(launch.args[launch.args.indexOf("--model") + 1], "model;$(nope)");
	assert.ok(!launch.args.includes("--no-extensions"));
	assert.equal(launch.args.filter((a) => a === "-e").length, 1);
	for (const name of ["-x", "x;y", "x y", "x\n", "#{pid}", "a".repeat(49)])
		assert.throws(() => mod.launchArgs({ name }, root));
	const manager = new mod.TmuxAgents({ exec: () => assert.fail("must not spawn") }, root);
	await assert.rejects(manager.spawn({ name: "missing", systemPrompt: join(root, "missing.md") }, { cwd: root }));
	await assert.rejects(manager.spawn({ name: "directory", systemPrompt: root }, { cwd: root }), /regular file/);
});

test("loader registers exactly ten sequential tools and no services", async () => {
	const { loadExtensions } = await import(pathToFileURL(join(piDir, "dist/core/extensions/loader.js")));
	const loaded = await insideTmux(() => loadExtensions([extensionPath], tmpdir()));
	assert.deepEqual(loaded.errors, []);
	const tools = [...loaded.extensions[0].tools.values()].map((t) => t.definition);
	assert.deepEqual(tools.map((t) => t.name).sort(), [
		"tmux_agent_broadcast",
		"tmux_agent_context",
		"tmux_agent_list",
		"tmux_agent_message",
		"tmux_agent_messages",
		"tmux_agent_peers",
		"tmux_agent_permissions",
		"tmux_agent_read",
		"tmux_agent_send",
		"tmux_agent_spawn",
	]);
	assert.ok(tools.every((t) => t.executionMode === "sequential"));
});

test("a child discovers the permitted parent ping endpoint and loses it after revoke", async () => {
	const root = mkdtempSync(join(tmpdir(), "tmux-agents-parent-peer-"));
	const child = join(root, "child-alpha");
	mkdirSync(child, { mode: 0o700 });
	writeFileSync(join(child, "meta.json"), JSON.stringify({ name: "alpha" }), { mode: 0o600 });
	writeFileSync(
		join(root, "permissions.json"),
		JSON.stringify({
			familyId: "test-family",
			version: 1,
			updatedAt: new Date().toISOString(),
			edges: [{ from: "alpha", to: "parent" }],
		}),
		{ mode: 0o600 },
	);
	const peers = new mod.TmuxAgents({ exec: () => assert.fail("parent discovery must not inspect a pane") }, root);

	assert.deepEqual(await peers.peers("alpha"), {
		peers: [{ name: "parent", paneId: null, status: "parent", modes: ["steering", "interrupt"], delivery: "ping" }],
		note: undefined,
	});
	peers.revoke("alpha", "parent");
	assert.deepEqual(await peers.peers("alpha"), {
		peers: [],
		note: "No permitted peers. The parent grants communication links.",
	});
});

test("spawn rejects the reserved parent endpoint name", () => {
	const root = mkdtempSync(join(tmpdir(), "tmux-agents-reserved-name-"));
	assert.throws(() => mod.launchArgs({ name: "parent" }, root), /reserved|parent/i);
});

test("a process named parent never injects a parent-addressed family record", { timeout: 5000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "tmux-agents-parent-injection-"));
	const child = join(root, "child-impostor");
	const source = join(root, "child-alpha");
	mkdirSync(child, { mode: 0o700 });
	mkdirSync(source, { mode: 0o700 });
	mkdirSync(join(root, "messages"), { mode: 0o700 });
	writeFileSync(join(source, "meta.json"), JSON.stringify({ name: "alpha" }), { mode: 0o600 });
	writeFileSync(
		join(root, "permissions.json"),
		JSON.stringify({
			familyId: "test-family",
			version: 1,
			updatedAt: new Date().toISOString(),
			edges: [{ from: "alpha", to: "parent" }],
		}),
		{ mode: 0o600 },
	);
	writeFileSync(
		join(root, "messages", "parent-ping.json"),
		JSON.stringify({
			messageId: "parent-ping",
			broadcastId: null,
			familyId: "test-family",
			from: { name: "alpha", paneId: "%2" },
			to: { name: "parent", paneId: null },
			mode: "steering",
			content: "must remain a ping",
			createdAt: new Date().toISOString(),
		}),
		{ mode: 0o600 },
	);
	const environment = [
		"PI_TMUX_AGENT_DIR",
		"PI_TMUX_AGENT_TOKEN",
		"PI_TMUX_AGENT_FAMILY",
		"PI_TMUX_AGENT_NAME",
		"TMUX",
		"TMUX_PANE",
	];
	const before = Object.fromEntries(environment.map((key) => [key, process.env[key]]));
	const hooks = new Map();
	const injected = [];
	const ctx = {
		mode: "tui",
		hasUI: false,
		isIdle: () => true,
		hasPendingMessages: () => false,
		sessionManager: {
			getSessionId: () => "session",
			getSessionFile: () => undefined,
			getBranch: () => [],
			getEntries: () => [],
		},
		ui: { getEditorText: () => "", notify() {}, setStatus() {} },
		getContextUsage: () => undefined,
	};
	try {
		process.env.PI_TMUX_AGENT_DIR = child;
		process.env.PI_TMUX_AGENT_TOKEN = "token";
		process.env.PI_TMUX_AGENT_FAMILY = root;
		process.env.PI_TMUX_AGENT_NAME = "parent";
		process.env.TMUX = `${join(root, "socket")},0,0`;
		process.env.TMUX_PANE = "%1";
		mod.default({
			registerTool() {},
			on(event, handler) {
				const registered = hooks.get(event) ?? [];
				registered.push(handler);
				hooks.set(event, registered);
			},
			exec: async () => ({ code: 0, stdout: String(process.pid) }),
			sendUserMessage: (...args) => injected.push(args),
		});
		for (const handler of hooks.get("session_start")) await handler({}, ctx);
		await new Promise((resolve) => setTimeout(resolve, 650));
		assert.deepEqual(injected, [], "parent-addressed records are pings, never turns");
	} finally {
		for (const handler of hooks.get("session_shutdown") ?? []) await handler({}, ctx);
		for (const key of environment) {
			if (before[key] === undefined) delete process.env[key];
			else process.env[key] = before[key];
		}
	}
});

test("AC1 AC2 AC3 AC4 AC7 AC8 AC10 AC11 AC12 AC13 AC14 family records enforce addressing and inspection contracts", async () => {
	const root = mkdtempSync(join(tmpdir(), "tmux-agents-ac-records-"));
	for (const [dir, name, id] of [
		["child-alpha", "alpha", "%11"],
		["child-beta", "beta", "%12"],
		["child-gamma", "gamma", "%13"],
	]) {
		const path = join(root, dir);
		mkdirSync(path, { mode: 0o700 });
		writeFileSync(join(path, "meta.json"), JSON.stringify({ name, id }), { mode: 0o600 });
	}
	const manager = new mod.TmuxAgents({ exec: () => assert.fail("these record-only checks must not use tmux") }, root);

	// AC1: registry addressing excludes the manual, unregistered name.
	assert.throws(() => manager.recordByName("manual-pi"), /Unknown family member/);
	// AC2: no record is written for an unknown recipient.
	assert.throws(() => manager.message("alpha", "manual-pi", "hello", "steering"), /Unknown family member/);
	assert.equal(existsSync(join(root, "messages")), false);
	// AC3 and AC7: default deny applies to both direct modes.
	for (const mode of ["steering", "interrupt"])
		assert.throws(() => manager.message("alpha", "beta", "hello", mode), /No permission edge from alpha to beta/);
	// AC4: the directed grant permits exactly the requested route.
	manager.grant("alpha", "beta");
	const direct = manager.message("alpha", "beta", "hello beta", "steering");
	assert.match(direct.messageId, /^[0-9a-f-]+$/i);
	assert.deepEqual(
		{ to: direct.to, mode: direct.mode, delivery: direct.delivery, state: direct.state },
		{ to: "beta", mode: "steering", delivery: "turn", state: "queued" },
	);
	// AC7: the other registered child remains unreachable under both modes.
	for (const mode of ["steering", "interrupt"])
		assert.throws(
			() => manager.message("alpha", "gamma", "not allowed", mode),
			/No permission edge from alpha to gamma/,
		);

	// AC8: a selected broadcast creates only the listed recipient record.
	const selected = await manager.broadcast("selected", "steering", ["beta"]);
	assert.equal(selected.results.length, 1);
	assert.equal(selected.results[0].to, "beta");
	const selectedRecord = manager.readMessage(`${selected.results[0].messageId}.json`);
	assert.equal(selectedRecord.to.name, "beta");
	// AC10: broadcasting changes no child-to-child permission.
	assert.throws(
		() => manager.message("beta", "gamma", "still denied", "steering"),
		/No permission edge from beta to gamma/,
	);
	// AC12: broadcast records share the result broadcast ID.
	assert.equal(selectedRecord.broadcastId, selected.broadcastId);

	// AC11: owner inspection returns direct fields, and parent rows become read when returned.
	manager.grant("alpha", "parent");
	const ping = manager.message("alpha", "parent", "ping owner", "interrupt");
	manager.writeReceipt({ messageId: direct.messageId, state: "delivered", deliveredAt: new Date().toISOString() });
	manager.writeReceipt({
		messageId: ping.messageId,
		state: "notified",
		deliveredAt: new Date().toISOString(),
		surfaced: false,
		requestedMode: "interrupt",
	});
	const inspected = await manager.messages(0, undefined, 12000, undefined, "owner-session");
	const directRow = inspected.messages.find((row) => row.messageId === direct.messageId);
	const pingRow = inspected.messages.find((row) => row.messageId === ping.messageId);
	assert.deepEqual(
		{
			content: directRow.content,
			from: directRow.from.name,
			to: directRow.to.name,
			mode: directRow.mode,
			state: directRow.state,
		},
		{ content: "hello beta", from: "alpha", to: "beta", mode: "steering", state: "delivered" },
	);
	assert.equal(pingRow.state, "notified");
	assert.ok(pingRow.readAt);
	assert.ok(existsSync(join(root, "messages", `${ping.messageId}.read.json`)));
	// AC13: the unregistered manual endpoint cannot receive or create a receipt.
	assert.throws(() => manager.message("alpha", "manual-pi", "never delivered", "steering"), /Unknown family member/);
	assert.equal(existsSync(join(root, "messages", "manual-pi.receipt.json")), false);
	// AC14: a child-owned empty family broadcast has no sibling reach.
	const childRoot = mkdtempSync(join(tmpdir(), "tmux-agents-ac-child-family-"));
	const childOwner = new mod.TmuxAgents(
		{ exec: () => assert.fail("empty child family must not inspect tmux") },
		childRoot,
	);
	const childBroadcast = await childOwner.broadcast("no descendants", "steering");
	assert.match(childBroadcast.broadcastId, /^[0-9a-f-]+$/i);
	assert.deepEqual(childBroadcast.results, []);
});

test("AC5 delivers idle and busy steering through the recipient extension with the required delivery mode", {
	timeout: 5000,
}, async () => {
	const root = mkdtempSync(join(tmpdir(), "tmux-agents-ac5-"));
	const target = join(root, "child-beta");
	const source = join(root, "child-alpha");
	mkdirSync(target, { mode: 0o700 });
	mkdirSync(source, { mode: 0o700 });
	writeFileSync(join(source, "meta.json"), JSON.stringify({ name: "alpha", id: "%2" }), { mode: 0o600 });
	writeFileSync(join(target, "meta.json"), JSON.stringify({ name: "beta", id: "%1" }), { mode: 0o600 });
	writeFileSync(
		join(root, "permissions.json"),
		JSON.stringify({
			familyId: "family",
			version: 1,
			updatedAt: new Date().toISOString(),
			edges: [{ from: "alpha", to: "beta" }],
		}),
		{ mode: 0o600 },
	);
	const previous = Object.fromEntries(
		["PI_TMUX_AGENT_DIR", "PI_TMUX_AGENT_TOKEN", "PI_TMUX_AGENT_FAMILY", "PI_TMUX_AGENT_NAME", "TMUX", "TMUX_PANE"].map(
			(key) => [key, process.env[key]],
		),
	);
	const hooks = new Map();
	const delivered = [];
	let idle = true;
	const ctx = {
		mode: "tui",
		hasUI: false,
		isIdle: () => idle,
		hasPendingMessages: () => false,
		sessionManager: {
			getSessionId: () => "beta-session",
			getSessionFile: () => undefined,
			getBranch: () => [],
			getEntries: () => [],
		},
		ui: { getEditorText: () => "", notify() {}, setStatus() {} },
		getContextUsage: () => undefined,
	};
	try {
		Object.assign(process.env, {
			PI_TMUX_AGENT_DIR: target,
			PI_TMUX_AGENT_TOKEN: "token",
			PI_TMUX_AGENT_FAMILY: root,
			PI_TMUX_AGENT_NAME: "beta",
			TMUX: `${join(root, "socket")},0,0`,
			TMUX_PANE: "%1",
		});
		mod.default({
			registerTool() {},
			on(event, handler) {
				const entries = hooks.get(event) ?? [];
				entries.push(handler);
				hooks.set(event, entries);
			},
			exec: async () => ({ code: 0, stdout: String(process.pid) }),
			sendUserMessage: (...args) => delivered.push(args),
		});
		for (const handler of hooks.get("session_start")) await handler({}, ctx);
		const family = new mod.TmuxAgents({ exec: () => assert.fail("delivery uses no tmux command") }, root);
		const idleMessage = family.message("alpha", "beta", "idle steering", "steering");
		await new Promise((resolve) => setTimeout(resolve, 650));
		assert.deepEqual(delivered[0], ["idle steering"]);
		assert.equal(family.receipt(idleMessage.messageId).state, "delivered");
		idle = false;
		const busyMessage = family.message("alpha", "beta", "busy steering", "steering");
		await new Promise((resolve) => setTimeout(resolve, 650));
		assert.deepEqual(delivered[1], ["busy steering", { deliverAs: "steer" }]);
		assert.equal(family.receipt(busyMessage.messageId).state, "delivered");
	} finally {
		for (const handler of hooks.get("session_shutdown") ?? []) await handler({}, ctx);
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

test("AC6 interrupts once, then injects only after the recipient becomes idle", { timeout: 5000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "tmux-agents-ac6-"));
	const target = join(root, "child-beta");
	const source = join(root, "child-alpha");
	mkdirSync(target, { mode: 0o700 });
	mkdirSync(source, { mode: 0o700 });
	writeFileSync(join(source, "meta.json"), JSON.stringify({ name: "alpha", id: "%2" }), { mode: 0o600 });
	writeFileSync(join(target, "meta.json"), JSON.stringify({ name: "beta", id: "%1" }), { mode: 0o600 });
	writeFileSync(
		join(root, "permissions.json"),
		JSON.stringify({
			familyId: "family",
			version: 1,
			updatedAt: new Date().toISOString(),
			edges: [{ from: "alpha", to: "beta" }],
		}),
		{ mode: 0o600 },
	);
	const keys = [
		"PI_TMUX_AGENT_DIR",
		"PI_TMUX_AGENT_TOKEN",
		"PI_TMUX_AGENT_FAMILY",
		"PI_TMUX_AGENT_NAME",
		"TMUX",
		"TMUX_PANE",
	];
	const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
	const hooks = new Map();
	const delivered = [];
	let idle = false;
	let aborts = 0;
	const ctx = {
		mode: "tui",
		hasUI: false,
		isIdle: () => idle,
		hasPendingMessages: () => false,
		abort: () => {
			aborts++;
			idle = true;
		},
		sessionManager: {
			getSessionId: () => "beta-session",
			getSessionFile: () => undefined,
			getBranch: () => [],
			getEntries: () => [],
		},
		ui: { getEditorText: () => "", notify() {}, setStatus() {} },
		getContextUsage: () => undefined,
	};
	try {
		Object.assign(process.env, {
			PI_TMUX_AGENT_DIR: target,
			PI_TMUX_AGENT_TOKEN: "token",
			PI_TMUX_AGENT_FAMILY: root,
			PI_TMUX_AGENT_NAME: "beta",
			TMUX: `${join(root, "socket")},0,0`,
			TMUX_PANE: "%1",
		});
		mod.default({
			registerTool() {},
			on(event, handler) {
				const entries = hooks.get(event) ?? [];
				entries.push(handler);
				hooks.set(event, entries);
			},
			exec: async () => ({ code: 0, stdout: String(process.pid) }),
			sendUserMessage: (...args) => delivered.push(args),
		});
		for (const handler of hooks.get("session_start")) await handler({}, ctx);
		const family = new mod.TmuxAgents({ exec: () => assert.fail("delivery uses no tmux command") }, root);
		const message = family.message("alpha", "beta", "interrupt now", "interrupt");
		await new Promise((resolve) => setTimeout(resolve, 650));
		assert.equal(aborts, 1);
		assert.deepEqual(delivered, [["interrupt now"]]);
		assert.equal(family.receipt(message.messageId).state, "delivered");
		assert.equal(family.receipt(message.messageId).attempts, 1);
	} finally {
		for (const handler of hooks.get("session_shutdown") ?? []) await handler({}, ctx);
		for (const key of keys) {
			if (previous[key] === undefined) delete process.env[key];
			else process.env[key] = previous[key];
		}
	}
});

test("outside tmux or Linux the extension registers nothing", async () => {
	assert.equal(mod.supportedEnvironment("linux", { TMUX: "/tmp/s,1,0", TMUX_PANE: "%1" }), true);
	assert.equal(mod.supportedEnvironment("win32", { TMUX: "/tmp/s,1,0", TMUX_PANE: "%1" }), false);
	assert.equal(mod.supportedEnvironment("darwin", { TMUX: "/tmp/s,1,0", TMUX_PANE: "%1" }), false);
	assert.equal(mod.supportedEnvironment("linux", {}), false);
	const before = { TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE };
	delete process.env.TMUX;
	delete process.env.TMUX_PANE;
	try {
		const registered = [];
		mod.default({
			registerTool(tool) {
				registered.push(tool.name);
			},
			on(event) {
				registered.push(event);
			},
		});
		assert.deepEqual(registered, []);
	} finally {
		for (const [key, value] of Object.entries(before)) {
			if (value !== undefined) process.env[key] = value;
		}
	}
});

test("peer tool schemas expose only the agreed modes and bounded message text", async () => {
	const tools = new Map();
	await insideTmux(() =>
		mod.default({
			registerTool(tool) {
				tools.set(tool.name, tool);
			},
			on() {},
		}),
	);
	const parameters = (name) => tools.get(name).parameters;

	assert.deepEqual(parameters("tmux_agent_permissions").properties.action.enum, ["grant", "revoke", "list"]);
	assert.deepEqual(parameters("tmux_agent_message").properties.mode.enum, ["steering", "interrupt"]);
	assert.deepEqual(parameters("tmux_agent_broadcast").properties.mode.enum, ["steering", "interrupt"]);
	for (const name of ["tmux_agent_message", "tmux_agent_broadcast"]) {
		const text = parameters(name).properties.text;
		assert.equal(text.minLength, 1);
		assert.equal(text.maxLength, 10000);
	}
	assert.deepEqual(parameters("tmux_agent_peers").properties, {});
	assert.deepEqual(Object.keys(parameters("tmux_agent_messages").properties).sort(), ["maxChars", "offset", "peer"]);
});

test("TypeScript check against the installed Pi API", async () => {
	const root = mkdtempSync(join(tmpdir(), "tmux-agents-types-"));
	const config = join(root, "tsconfig.json");
	writeFileSync(
		config,
		JSON.stringify({
			compilerOptions: {
				noEmit: true,
				strict: true,
				skipLibCheck: true,
				target: "ES2022",
				module: "ESNext",
				moduleResolution: "Bundler",
				types: ["node"],
				typeRoots: [join(piDir, "node_modules/@types")],
				paths: {
					"@earendil-works/pi-coding-agent": [join(piDir, "dist/index.d.ts")],
					"@earendil-works/pi-ai": [join(piDir, "node_modules/@earendil-works/pi-ai/dist/index.d.ts")],
					typebox: [join(piDir, "node_modules/typebox/build/index.d.mts")],
				},
			},
			files: [extensionPath],
		}),
	);
	try {
		await exec("tsc", ["-p", config]);
	} catch (error) {
		assert.fail(error.stdout || error.message);
	}
});

test("isolated tmux preserves literal argv without executing injected commands", { timeout: 30000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "tmux-agents-argv-"));
	const socket = join(root, "socket");
	const stateRoot = join(root, "state");
	mkdirSync(stateRoot, { mode: 0o700 });
	// Record what exec receives instead of calling Pi with deliberately invalid model IDs.
	const recorder = join(root, "record.cjs");
	writeFileSync(
		recorder,
		`const { writeFileSync } = require('node:fs');
writeFileSync(${JSON.stringify(root)} + '/' + process.env.TMUX_PANE + '.json', JSON.stringify({
  argv: process.argv.slice(2), cwd: process.cwd(), environment: {
    PI_TMUX_AGENT_DIR: process.env.PI_TMUX_AGENT_DIR,
    PI_TMUX_AGENT_TOKEN: process.env.PI_TMUX_AGENT_TOKEN,
    PI_TMUX_AGENT_FAMILY: process.env.PI_TMUX_AGENT_FAMILY,
    PI_TMUX_AGENT_NAME: process.env.PI_TMUX_AGENT_NAME,
  },
}));
process.stdin.resume();`,
	);
	const tmux = async (args) => (await exec("tmux", ["-S", socket, ...args])).stdout;
	const initial = (
		await tmux([
			"-f",
			"/dev/null",
			"new-session",
			"-d",
			"-P",
			"-F",
			"#{pane_id}",
			"-s",
			"isolated",
			"-c",
			root,
			process.execPath,
			recorder,
		])
	).trim();
	const before = { TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE, argv: process.argv[1] };
	process.env.TMUX = `${socket},0,0`;
	process.env.TMUX_PANE = initial;
	process.argv[1] = recorder;
	const manager = new mod.TmuxAgents(
		{
			exec: async (command, args, options) => {
				try {
					const out = await exec(command, args, { signal: options?.signal, timeout: options?.timeout });
					return { ...out, code: 0, killed: false };
				} catch (error) {
					return { stdout: error.stdout || "", stderr: error.stderr || "", code: error.code, killed: error.killed };
				}
			},
		},
		stateRoot,
	);
	const observed = async (id) => {
		assert.match(id, /^%\d+$/);
		const file = join(root, `${id}.json`);
		const until = Date.now() + 5000;
		while (!existsSync(file) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
		return JSON.parse(readFileSync(file, "utf8"));
	};
	try {
		const prompt = join(root, "replacement prompt;");
		writeFileSync(prompt, "Literal system prompt filename.");
		const cwd = join(root, String.raw`working dir\;`);
		mkdirSync(cwd);
		const marker = join(root, "INJECTED_FROM_MODEL_OR_PROVIDER");
		const cases = [
			{ name: "prompt-file", systemPrompt: prompt, cwd },
			{ name: "standalone", provider: ";", model: ";" },
			{ name: "multiple", provider: ";;", model: "model;;;" },
			{ name: "one-backslash", provider: String.raw`\;`, model: String.raw`model\;` },
			{ name: "two-backslashes", provider: String.raw`\\;`, model: String.raw`model\\;` },
			{ name: "ordinary", provider: "provider; with spaces", model: 'model\\;middle "quote" $() \\\\' },
			{ name: "command-text", provider: `; run-shell 'touch ${marker}';`, model: `; run-shell 'touch ${marker}';` },
		];
		for (const params of cases)
			await t.test(`spawn preserves ${params.name} arguments`, async () => {
				const child = await manager.spawn({ ...params, waitMs: 0 }, { cwd: root });
				const actual = await observed(child.id);
				const expected = ["--name", params.name, "-e", extensionPath];
				for (const [key, flag] of [
					["systemPrompt", "--system-prompt"],
					["provider", "--provider"],
					["model", "--model"],
				]) {
					if (params[key] !== undefined) expected.push(flag, params[key]);
				}
				const record = manager.record(child.id);
				assert.deepEqual(actual, {
					argv: expected,
					cwd: params.cwd || root,
					environment: {
						PI_TMUX_AGENT_DIR: record.dir,
						PI_TMUX_AGENT_TOKEN: record.token,
						PI_TMUX_AGENT_FAMILY: stateRoot,
						PI_TMUX_AGENT_NAME: params.name,
					},
				});
				assert.equal(existsSync(marker), false);
			});
		// Exercise the central boundary with a valid second tmux command, not an unknown --model command.
		for (const value of [";", "value;"])
			await t.test(`literal ${JSON.stringify(value)} cannot append a tmux command`, async () => {
				const marker = join(root, value === ";" ? "INJECTED_STANDALONE" : "INJECTED_TRAILING");
				const argv = [value, "run-shell", `touch ${marker}`];
				const id = (
					await manager.tmux(socket, [
						"new-window",
						"-d",
						"-P",
						"-F",
						"#{pane_id}",
						"-t",
						"isolated:",
						"-c",
						root,
						process.execPath,
						recorder,
						...argv,
					])
				).trim();
				assert.equal(existsSync(marker), false, "literal arguments must not run a second tmux command");
				assert.deepEqual(await observed(id), { argv, cwd: root, environment: {} });
			});
	} finally {
		if (before.TMUX === undefined) delete process.env.TMUX;
		else process.env.TMUX = before.TMUX;
		if (before.TMUX_PANE === undefined) delete process.env.TMUX_PANE;
		else process.env.TMUX_PANE = before.TMUX_PANE;
		process.argv[1] = before.argv;
		// This server contains only this fixture's argv recorders. Never use the user's socket.
		await tmux(["kill-server"]);
		t.diagnostic(`Isolated argv test artifacts: ${root}`);
	}
});

test("isolated tmux keeps agents tracked when the window menu moves their panes", { timeout: 30000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "tmux-agents-move-"));
	const socket = join(root, "socket");
	const stateRoot = join(root, "state");
	mkdirSync(stateRoot, { mode: 0o700 });
	const idle = join(root, "idle.cjs");
	writeFileSync(idle, "process.stdin.resume();");
	const tmux = async (args) => (await exec("tmux", ["-S", socket, ...args])).stdout;
	const initial = (
		await tmux([
			"-f",
			"/dev/null",
			"new-session",
			"-d",
			"-P",
			"-F",
			"#{pane_id}",
			"-s",
			"isolated",
			"-c",
			root,
			process.execPath,
			idle,
		])
	).trim();
	const before = { TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE, argv: process.argv[1] };
	process.env.TMUX = `${socket},0,0`;
	process.env.TMUX_PANE = initial;
	process.argv[1] = idle;
	const piExec = async (command, args, options) => {
		try {
			const out = await exec(command, args, { signal: options?.signal, timeout: options?.timeout });
			return { ...out, code: 0, killed: false };
		} catch (error) {
			return { stdout: error.stdout || "", stderr: error.stderr || "", code: error.code, killed: error.killed };
		}
	};
	const manager = new mod.TmuxAgents({ exec: piExec }, stateRoot);
	const menu = join(dirname(extensionPath), "tmux-menu.sh");
	// Run the menu's actions the way its menu items do, against this fixture's server only.
	const action = (...args) => tmux(["run-shell", `bash ${menu} ${args.join(" ")}`]);
	const windowOf = async (id) => (await tmux(["display-message", "-p", "-t", id, "#{window_id}"])).trim();
	try {
		const first = await manager.spawn({ name: "mover-a", waitMs: 0 }, { cwd: root });
		const second = await manager.spawn({ name: "mover-b", mode: "pane", waitMs: 0 }, { cwd: root });
		// Without snapshots the children report "starting"; an identity mismatch reports "unavailable".
		assert.equal((await manager.context(first.id)).status, "starting");

		await t.test("spawned agents join the automatic pane layout", async () => {
			assert.equal((await tmux(["show-options", "-pqv", "-t", second.id, "@pi_agent_name"])).trim(), "mover-b");
			assert.equal(
				(await tmux(["show-options", "-wqv", "-t", await windowOf(second.id), "@piao_managed"])).trim(),
				"1",
			);
			assert.equal(
				(await tmux(["show-options", "-wqv", "-t", await windowOf(initial), "@piao_main"])).trim(),
				initial,
				"the parent pane is the main pane",
			);
		});

		await t.test("panes-to-windows breaks a pane out and the agent stays tracked", async () => {
			const from = await windowOf(second.id);
			await action("panes-to-windows", from);
			assert.notEqual(await windowOf(second.id), from);
			assert.equal((await manager.context(second.id)).status, "starting");
		});

		await t.test("join moves every pane and the agents stay tracked", async () => {
			const target = await windowOf(first.id);
			const client = "unused-client";
			await action("join", client, await windowOf(second.id), target).catch(() => {}); // No client is attached to switch.
			assert.equal(await windowOf(second.id), target);
			assert.equal((await manager.context(second.id)).status, "starting");
			const listed = (await manager.list()).agents.find((agent) => agent.id === second.id);
			assert.equal(listed.window, target, "list reports the current window, not the spawn window");
		});

		await t.test("a replaced process in the same pane is still rejected", async () => {
			const record = manager.record(first.id);
			assert.equal((await manager.inspect({ ...record, start: "wrong-start" })).status, "unavailable");
		});

		await t.test("the menu rejects IDs that would change its commands", async () => {
			await assert.rejects(action("send-end", `'@0;kill-server'`));
			assert.ok((await tmux(["list-windows", "-a"])).length > 0, "server still running");
		});

		await t.test("installing the menu replaces the default binding but keeps a custom one", async () => {
			assert.equal(await mod.installWindowMenu(piExec, socket, menu), "installed");
			assert.match(await tmux(["list-keys", "-T", "root", "MouseDown3Status"]), /tmux-menu\.sh menu/);
			assert.equal(await mod.installWindowMenu(piExec, socket, menu), "already-installed");
			await tmux(["bind-key", "-n", "MouseDown3Status", "display-message", "custom"]);
			assert.equal(await mod.installWindowMenu(piExec, socket, menu), "kept-custom-binding");
			assert.equal(await mod.installWindowMenu(piExec, socket, "/path with space/tmux-menu.sh"), "unsupported-path");
		});
	} finally {
		if (before.TMUX === undefined) delete process.env.TMUX;
		else process.env.TMUX = before.TMUX;
		if (before.TMUX_PANE === undefined) delete process.env.TMUX_PANE;
		else process.env.TMUX_PANE = before.TMUX_PANE;
		process.argv[1] = before.argv;
		// This server contains only this fixture's idle children. Never use the user's socket.
		await tmux(["kill-server"]);
	}
});

test("isolated tmux accepts every generated pane layout", { timeout: 30000 }, async () => {
	const layout = await import(pathToFileURL(join(dirname(extensionPath), "layout.mjs")).href);
	const root = mkdtempSync(join(tmpdir(), "tmux-agents-layout-"));
	const socket = join(root, "socket");
	const tmux = async (args) => (await exec("tmux", ["-S", socket, ...args])).stdout.trim();
	await tmux(["-f", "/dev/null", "new-session", "-d", "-s", "layout", "-x", "200", "-y", "50", "sleep 600"]);
	try {
		for (let count = 1; count <= 8; count++) {
			if (count > 1)
				await tmux(["split-window", "-d", "-t", "layout:0", "sleep 600"]).catch(() =>
					tmux(["select-layout", "-t", "layout:0", "tiled"]).then(() =>
						tmux(["split-window", "-d", "-t", "layout:0", "sleep 600"]),
					),
				);
			const ids = (await tmux(["list-panes", "-t", "layout:0", "-F", "#{pane_id}"])).split("\n");
			assert.equal(ids.length, count);
			for (const [mode, width] of [
				["auto", 0],
				["stack", 0],
				["columns", 0],
				["grid", 0],
				["auto", 30],
				["stack", 70],
			]) {
				const encoded = layout.encodeLayout(layout.makeLayout(ids, 200, 50, mode, width));
				// tmux rejects a layout whose checksum, sizes or pane count is wrong.
				await tmux(["select-layout", "-t", "layout:0", encoded]);
				assert.equal(
					await tmux(["display-message", "-p", "-t", "layout:0", "#{window_layout}"]),
					encoded,
					`${count} panes, ${mode} ${width}%`,
				);
			}
		}
		assert.throws(() => layout.makeLayout(["%1", "%2", "%3"], 10, 4), /too (small|narrow)/);
	} finally {
		await tmux(["kill-server"]);
	}
});

test("isolated tmux and real interactive Pi, without model calls", { timeout: 90000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "tmux-agents-smoke-"));
	const config = join(root, "config");
	mkdirSync(join(config, "extensions"), { recursive: true });
	writeFileSync(
		join(config, "settings.json"),
		JSON.stringify({ extensions: [extensionPath], compaction: { enabled: false, keepRecentTokens: 10 } }),
	);
	// Compaction resolves auth before consulting extensions. This test-only provider cannot reach a real endpoint.
	writeFileSync(
		join(config, "models.json"),
		JSON.stringify({
			providers: {
				openai: {
					baseUrl: "http://127.0.0.1:1",
					apiKey: "TEST_ONLY_NOT_A_CREDENTIAL",
				},
			},
		}),
	);
	const prompt = join(root, "replacement prompt.md;");
	writeFileSync(prompt, "TEST REPLACEMENT SYSTEM PROMPT. Do not call a model during this test.");
	const promptSeen = join(root, "prompt-seen.json");
	const received = join(root, "received.json");
	writeFileSync(
		join(config, "extensions/input-test.ts"),
		`import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
const root = ${JSON.stringify(root)};
const save = (file, value) => {
  const temp = file + '.' + process.pid + '.tmp';
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  renameSync(temp, file);
};
const append = (file, value) => {
  const previous = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
  save(file, [...previous, value]);
};
export default function(pi) {
  pi.registerProvider('test-delay', {
    baseUrl: 'http://127.0.0.1:1', apiKey: 'TEST_ONLY_NOT_A_CREDENTIAL', api: 'test-delay',
    models: [{ id: 'delayed', name: 'Delayed fixture', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
    streamSimple(model, _context, options) {
      const stream = createAssistantMessageEventStream();
      const output = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'pending', timestamp: Date.now() };
      stream.push({ type: 'start', partial: output });
      const finish = reason => {
        output.stopReason = reason;
        if (reason === 'aborted') stream.push({ type: 'error', reason, error: output });
        else stream.push({ type: 'done', reason, message: output });
        stream.end();
      };
      const timer = setTimeout(() => finish('stop'), 10000);
      options?.signal?.addEventListener('abort', () => { clearTimeout(timer); append(root + '/provider-aborts.json', { name: process.env.PI_TMUX_AGENT_NAME ?? 'manual' }); finish('aborted'); }, { once: true });
      return stream;
    },
  });
  const record = (name, ctx, extra = {}) => save(root + '/' + name + '.json', {
    idle: ctx.isIdle(), context: ctx.getContextUsage(), ...extra,
  });
  pi.on('before_provider_request', () => { writeFileSync(root + '/UNEXPECTED_MODEL_CALL', 'Unexpected request'); });
  pi.on('session_before_compact', event => ({ compaction: {
    summary: 'Synthetic test summary. No provider call.',
    firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore,
  } }));
  for (const event of ['session_tree', 'session_compact']) pi.on(event, async (event, ctx) => {
    record(event.type + '-during', ctx, { summary: !!event.summaryEntry, fromExtension: event.fromExtension });
    // Keep a later extension handler active across several telemetry refresh attempts.
    await delay(500);
    if (event.type === 'session_compact') setTimeout(() => record('compact-done', ctx), 100);
  });
  pi.registerCommand('test-seed', { handler: async (_args, ctx) => {
    await ctx.newSession({ setup: async sm => {
      const assistant = (text, tokens) => ({ role: 'assistant', content: [{ type: 'text', text },
        { type: 'thinking', thinking: 'PRIVATE THINKING' }], api: 'openai-completions', provider: 'openai', model: 'gpt-4o',
        timestamp: Date.now(), stopReason: 'stop', usage: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0,
          totalTokens: tokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
      sm.appendMessage({ role: 'user', content: 'PRIVATE synthetic input A '.repeat(100), timestamp: Date.now() });
      sm.appendMessage(assistant('synthetic reply A', 1000));
      sm.appendMessage({ role: 'user', content: 'PRIVATE synthetic input B', timestamp: Date.now() });
      sm.appendMessage(assistant('synthetic reply B', 2000));
    }, withSession: async fresh => record('seed-done', fresh) });
  } });
  pi.registerCommand('test-tree', { handler: async (_args, ctx) => {
    const entry = ctx.sessionManager.getBranch().find(e => e.type === 'message' && e.message.role === 'assistant');
    await ctx.navigateTree(entry.id, { summarize: false });
    record('tree-done', ctx);
  } });
  pi.registerCommand('test-observe', { handler: async (_args, ctx) => record('observe', ctx) });
  pi.on('user_bash', async (event, ctx) => {
    record('bash-during', ctx);
    await delay(500);
    // No return value: execute the real local command after this delayed handler.
  });
  pi.on('session_start', (_event, ctx) => {
    save(${JSON.stringify(promptSeen)}, ctx.getSystemPrompt().includes('TEST REPLACEMENT SYSTEM PROMPT'));
  });
  pi.on('input', (event, ctx) => {
    const name = process.env.PI_TMUX_AGENT_NAME ?? 'manual';
    append(root + '/input-' + name + '.json', { text: event.text, source: event.source, streamingBehavior: event.streamingBehavior ?? null });
    save(${JSON.stringify(received)}, event.text);
    if (event.text.startsWith('RUN:')) return { action: 'continue' };
    ctx.ui.notify('TEST INPUT OBSERVED WITHOUT A MODEL CALL', 'info');
    return { action: 'handled' };
  });
}`,
	);
	const anchor = join(root, "anchor.cjs");
	writeFileSync(anchor, "process.stdin.resume(); process.stdin.on('data', () => process.exit(0));");
	const socket = join(root, "socket");
	const tmux = async (args) => (await exec("tmux", ["-S", socket, ...args])).stdout;
	const initial = (
		await tmux([
			"-f",
			"/dev/null",
			"new-session",
			"-d",
			"-P",
			"-F",
			"#{pane_id}",
			"-s",
			"isolated",
			"-n",
			"anchor",
			"-x",
			"140",
			"-y",
			"50",
			"-e",
			`PI_CODING_AGENT_DIR=${config}`,
			"-e",
			"PI_OFFLINE=1",
			"-c",
			root,
			process.execPath,
			anchor,
		])
	).trim();
	const before = { TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE, argv: process.argv[1] };
	process.env.TMUX = `${socket},0,0`;
	process.env.TMUX_PANE = initial;
	process.argv[1] = join(piDir, "dist/cli.js");
	const stateRoot = join(root, "state");
	mkdirSync(stateRoot, { mode: 0o700 });
	const commands = [];
	const piExec = {
		exec: async (command, args, options) => {
			commands.push(args);
			try {
				const out = await exec(command, args, { signal: options?.signal, timeout: options?.timeout });
				return { ...out, code: 0, killed: false };
			} catch (error) {
				return { stdout: error.stdout || "", stderr: error.stderr || "", code: error.code, killed: error.killed };
			}
		},
	};
	const manager = new mod.TmuxAgents(piExec, stateRoot);
	const wait = async (fn) => {
		const until = Date.now() + 15000;
		while (Date.now() < until) {
			if (await fn()) return;
			await new Promise((r) => setTimeout(r, 100));
		}
		assert.fail("Timed out waiting for isolated child observation");
	};
	let windowChild;
	let paneChild;
	const direct = async (id, text) => {
		await tmux(["send-keys", "-t", id, "-l", text]);
		await tmux(["send-keys", "-t", id, "Enter"]);
	};
	const observed = (name) => JSON.parse(readFileSync(join(root, `${name}.json`), "utf8"));
	const seed = async () => {
		const previous = (await manager.context(windowChild.id)).updatedAt;
		// Independent test setup must also recover a child whose old snapshot incorrectly says busy.
		await direct(windowChild.id, "/test-seed");
		await wait(async () => {
			const state = await manager.context(windowChild.id);
			return state.updatedAt !== previous && state.status === "ready" && state.context.tokens === 2000;
		});
		assert.equal((await manager.read(windowChild.id)).reply.text, "synthetic reply B");
	};
	try {
		await t.test("default new window, label, launch once, permissions and ready identity", async () => {
			windowChild = await manager.spawn(
				{ name: "smoke-window", waitMs: 0, thinking: "off", systemPrompt: prompt, provider: "openai", model: "gpt-4o" },
				{ cwd: root },
			);
			assert.equal(windowChild.mode, "window");
			assert.ok(["starting", "ready"].includes(windowChild.status));
			await wait(async () => (await manager.context(windowChild.id)).status === "ready");
			assert.equal(commands.filter((a) => a.includes("new-window")).length, 1);
			assert.equal(
				(await tmux(["display-message", "-p", "-t", windowChild.id, "#{window_name}"])).trim(),
				"smoke-window",
			);
			assert.equal((await tmux(["show-options", "-wv", "-t", windowChild.window, "automatic-rename"])).trim(), "off");
			assert.equal((await tmux(["show-options", "-wv", "-t", windowChild.window, "allow-rename"])).trim(), "off");
			const record = manager.record(windowChild.id);
			for (const file of ["meta.json", "snapshot.json"])
				assert.equal(statSync(join(record.dir, file)).mode & 0o777, 0o600);
			assert.equal(statSync(record.dir).mode & 0o777, 0o700);
			assert.equal((await manager.context(windowChild.id)).thinking, "off");
			assert.equal(JSON.parse(readFileSync(promptSeen)), true);
			assert.equal((await manager.read(windowChild.id)).reply, null);
		});
		await t.test("duplicate labels do not create additional agents", async () => {
			await assert.rejects(manager.spawn({ name: "smoke-window" }, { cwd: root }), /already exists/);
			await assert.rejects(manager.spawn({ name: "anchor" }, { cwd: root }), /already exists/);
			assert.equal(commands.filter((a) => a.includes("new-window")).length, 1);
		});
		await t.test("multiline literal submission and built-in slash command reach the TUI", async () => {
			const text = "line one\nC-c Enter ; $(touch MUST_NOT_EXIST)\nlast\tline";
			const sent = await manager.send(windowChild.id, text);
			assert.match(sent.delivery, /not confirmed/);
			await wait(() => existsSync(received));
			// Pi's editor expands pasted tabs to four spaces; newlines and key-like text stay literal.
			assert.equal(JSON.parse(readFileSync(received, "utf8")), text.replaceAll("\t", "    "));
			assert.equal(existsSync(join(root, "MUST_NOT_EXIST")), false);
			assert.ok(commands.some((a) => a.includes("paste-buffer") && a.includes("-p") && a.includes("-r")));
			assert.ok(!commands.some((a) => a.includes("C-c")));
			await manager.send(windowChild.id, "/session");
			await wait(async () => (await manager.read(windowChild.id, true)).terminal.includes("Session"));
			const terminal = await manager.read(windowChild.id, true, 1000);
			assert.ok(terminal.terminal.length <= 1000);
			await assert.rejects(manager.send(windowChild.id, "\x1b[201~"), /control/);
		});
		await t.test("paste preserves standalone and trailing semicolons and backslashes", async () => {
			for (const text of [
				";",
				";;;",
				String.raw`\;`,
				String.raw`\\;`,
				String.raw`literal\; ; run-shell 'touch MUST_NOT_EXIST';`,
			]) {
				await manager.send(windowChild.id, text);
				await wait(() => JSON.parse(readFileSync(received, "utf8")) === text);
			}
			assert.equal(existsSync(join(root, "MUST_NOT_EXIST")), false);
		});
		await t.test("child and parent reload preserve manageable identity without duplicate extension", async () => {
			const record = manager.record(windowChild.id);
			const previous = JSON.parse(readFileSync(join(record.dir, "snapshot.json"))).updatedAt;
			await manager.send(windowChild.id, "/reload");
			await wait(async () => {
				const state = await manager.context(windowChild.id);
				return state.status === "ready" && state.updatedAt !== previous;
			});
			// session_start precedes dismissal of Pi's built-in reload overlay. Wait for the actual editor too.
			await wait(async () => (await manager.read(windowChild.id, true)).terminal.includes("Reloaded keybindings"));
			const reloaded = new mod.TmuxAgents(piExec, stateRoot);
			assert.equal((await reloaded.list()).agents[0].id, windowChild.id);
			const output = (await manager.read(windowChild.id, true)).terminal;
			assert.doesNotMatch(output, /duplicate tool|Failed to load extension|conflicting tool/i);
		});
		await t.test("tree without summary settles before the next managed submission", async () => {
			await seed();
			await manager.send(windowChild.id, "/test-tree");
			await wait(() => existsSync(join(root, "session_tree-during.json")));
			assert.equal(observed("session_tree-during").idle, false);
			assert.equal(observed("session_tree-during").summary, false);
			await new Promise((r) => setTimeout(r, 200));
			assert.equal(
				(await manager.context(windowChild.id)).status,
				"busy",
				"must not force ready during a later async handler",
			);
			await wait(() => existsSync(join(root, "tree-done.json")));
			assert.equal(observed("tree-done").idle, true);
			await wait(async () => (await manager.context(windowChild.id)).status === "ready");
			assert.equal((await manager.context(windowChild.id)).context.tokens, observed("tree-done").context.tokens);
			assert.equal((await manager.read(windowChild.id)).reply.text, "synthetic reply A");
			await manager.send(windowChild.id, "/session");
			await wait(async () => (await manager.read(windowChild.id, true)).terminal.includes("Session Info"));
		});
		await t.test("successful manual compaction settles without a provider call", async () => {
			await seed();
			await manager.send(windowChild.id, "/compact");
			await wait(() => existsSync(join(root, "session_compact-during.json")));
			assert.equal(observed("session_compact-during").idle, false);
			assert.equal(observed("session_compact-during").fromExtension, true);
			await new Promise((r) => setTimeout(r, 200));
			assert.equal((await manager.context(windowChild.id)).status, "busy");
			await wait(() => existsSync(join(root, "compact-done.json")));
			assert.equal(observed("compact-done").idle, true);
			await wait(async () => (await manager.context(windowChild.id)).status === "ready");
			assert.equal((await manager.context(windowChild.id)).context.tokens, observed("compact-done").context.tokens);
			assert.equal((await manager.context(windowChild.id)).context.tokens, null);
			await manager.send(windowChild.id, "/session");
			await wait(async () => (await manager.read(windowChild.id, true)).terminal.includes("Session Info"));
			assert.equal(existsSync(join(root, "UNEXPECTED_MODEL_CALL")), false);
		});
		await t.test("completed user bash refreshes context after delayed hooks and real execution", async () => {
			await seed();
			await manager.send(windowChild.id, "!sleep 0.3; printf '%08000d' 0");
			await wait(() => existsSync(join(root, "bash-during.json")));
			assert.equal(observed("bash-during").idle, true, "Pi idle does not include user bash");
			await new Promise((r) => setTimeout(r, 250));
			assert.equal((await manager.context(windowChild.id)).context.tokens, 2000);
			await wait(async () => (await manager.read(windowChild.id, true)).terminal.includes("0000000000000000"));
			// Do not type the diagnostic command while the settlement snapshot is sampling the editor.
			await wait(async () => (await manager.context(windowChild.id)).context.tokens > 2000);
			await direct(windowChild.id, "/test-observe");
			await wait(() => existsSync(join(root, "observe.json")));
			const actual = observed("observe");
			assert.equal(actual.idle, true);
			assert.ok(actual.context.tokens > 4000);
			await wait(async () => (await manager.context(windowChild.id)).context.tokens === actual.context.tokens);
			assert.equal(
				(await manager.context(windowChild.id)).context.tokensK,
				(actual.context.tokens / 1000).toFixed(1) + "k",
			);
			assert.equal((await manager.read(windowChild.id)).reply.text, "synthetic reply B");
			assert.doesNotMatch(JSON.stringify(await manager.read(windowChild.id)), /PRIVATE|0000000000000000/);
			assert.equal(existsSync(join(root, "UNEXPECTED_MODEL_CALL")), false);
			await manager.send(windowChild.id, "/session");
			await wait(async () => (await manager.read(windowChild.id, true)).terminal.includes("Session Info"));
		});
		await t.test("pane mode renames only its containing test window", async () => {
			paneChild = await manager.spawn({ name: "smoke-pane", mode: "pane", waitMs: 15000 }, { cwd: root });
			assert.equal(paneChild.status, "ready");
			assert.equal((await tmux(["display-message", "-p", "-t", initial, "#{window_name}"])).trim(), "smoke-pane");
			assert.equal(
				(await tmux(["display-message", "-p", "-t", windowChild.id, "#{window_name}"])).trim(),
				"smoke-window",
			);
			assert.match(paneChild.note, /shared/);
		});
		await t.test("inherited child environment cannot overwrite the original telemetry", async () => {
			const record = manager.record(windowChild.id);
			const file = join(record.dir, "snapshot.json");
			const original = readFileSync(file, "utf8");
			const previousDir = process.env.PI_TMUX_AGENT_DIR;
			const previousToken = process.env.PI_TMUX_AGENT_TOKEN;
			const hooks = new Map();
			try {
				process.env.PI_TMUX_AGENT_DIR = record.dir;
				process.env.PI_TMUX_AGENT_TOKEN = record.token;
				mod.default({
					...piExec,
					registerTool() {},
					on(event, handler) {
						hooks.set(event, handler);
					},
				});
				await hooks.get("session_start")({}, { mode: "tui" });
				assert.equal(readFileSync(file, "utf8"), original);
			} finally {
				if (previousDir === undefined) delete process.env.PI_TMUX_AGENT_DIR;
				else process.env.PI_TMUX_AGENT_DIR = previousDir;
				if (previousToken === undefined) delete process.env.PI_TMUX_AGENT_TOKEN;
				else process.env.PI_TMUX_AGENT_TOKEN = previousToken;
			}
		});
		await t.test("post-spawn failure reports the created ID and does not retry or close it", async () => {
			const fault = new mod.TmuxAgents(
				{
					exec: async (command, args, options) => {
						if (args.includes("set-option")) return { code: 1, killed: false, stdout: "", stderr: "" };
						return piExec.exec(command, args, options);
					},
				},
				stateRoot,
			);
			const before = manager.records().length;
			await assert.rejects(fault.spawn({ name: "smoke-fault" }, { cwd: root }), /Created pane %\d+.*NOT closed/);
			assert.equal(manager.records().length, before + 1);
			const record = manager.records().find((r) => r.name === "smoke-fault");
			await wait(async () => (await manager.context(record.id)).status === "ready");
			assert.equal((await tmux(["display-message", "-p", "-t", record.id, "#{pane_dead}"])).trim(), "0");
		});
		await t.test("stale snapshot, dead PID, unmanaged ID and tmux copy mode refuse input", async () => {
			const record = manager.record(windowChild.id);
			const file = join(record.dir, "snapshot.json");
			const original = JSON.parse(readFileSync(file));
			mod.atomicJSON(file, { ...original, pid: original.pid + 1 });
			await assert.rejects(manager.send(windowChild.id, "/session"), /not ready/);
			assert.equal((await manager.context(windowChild.id)).status, "stale");
			mod.atomicJSON(file, original);
			assert.equal((await manager.inspect({ ...record, start: "wrong-start" })).status, "unavailable");
			await assert.rejects(manager.send(initial, "NO"), /Unknown managed/);
			await tmux(["copy-mode", "-t", windowChild.id]);
			await assert.rejects(manager.send(windowChild.id, "/session"), /not ready/);
			await tmux(["send-keys", "-t", windowChild.id, "-X", "cancel"]);
			await manager.send(windowChild.id, "/quit");
			await wait(async () => (await manager.context(windowChild.id)).status === "unavailable");
			await assert.rejects(manager.send(windowChild.id, "/session"), /not ready/);
		});
	} finally {
		// Quit only test-created Pi processes. Never address the user's tmux socket.
		const cleanupFailures = [];
		for (const child of manager.records()) {
			if (!child) continue;
			try {
				const state = await manager.context(child.id);
				// Test-only recovery also handles a stale busy or nonempty-editor snapshot after a failed assertion.
				if (state.status === "ready" || state.status === "busy") await direct(child.id, "/quit");
				await wait(async () => (await manager.context(child.id)).status === "unavailable");
			} catch {
				cleanupFailures.push(child.id);
			}
		}
		await tmux(["send-keys", "-t", initial, "quit", "Enter"]).catch(() => {
			cleanupFailures.push("anchor");
		});
		if (before.TMUX === undefined) delete process.env.TMUX;
		else process.env.TMUX = before.TMUX;
		if (before.TMUX_PANE === undefined) delete process.env.TMUX_PANE;
		else process.env.TMUX_PANE = before.TMUX_PANE;
		process.argv[1] = before.argv;
		t.diagnostic(`Isolated test artifacts: ${root}`);
		assert.deepEqual(cleanupFailures, [], "test processes must exit gracefully");
		await wait(async () => {
			try {
				await tmux(["has-session", "-t", "isolated"]);
				return false;
			} catch {
				return true;
			}
		});
	}
});
