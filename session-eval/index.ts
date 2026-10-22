/**
 * session-eval
 *
 * Pi side of the harness-neutral `evaluate-session` skill:
 *   - `/evaluate-session [selection]` exports a trace bundle and starts the skill.
 *   - `session_eval_export` lets an agent export a bundle itself.
 *   - When the skill is loaded (read of .../evaluate-session/SKILL.md or
 *     /skill:evaluate-session), injects a short pi harness context once per branch.
 *   - Passively records custom entries (not sent to the model) that the adapter
 *     (adapter.mjs) consumes: session-eval:features, session-eval:timing,
 *     session-eval:peer-link. session-eval:retry is NOT recorded: pi does not
 *     expose auto-retry events to extensions (see README).
 *
 * Every passive handler fails open: errors are swallowed and never block tools.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, VERSION } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const EXT_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_NAME = "evaluate-session";
const SKILL_BLOCK_MARK = `<skill name="${SKILL_NAME}" location=`;
const CONTEXT_TAG = "session-eval-harness-context";
const CONTEXT_MARK = `<${CONTEXT_TAG}>`;
const CONTEXT_CUSTOM_TYPE = "session-eval:harness-context";
const PEER_TOOL = "tmux_agent_spawn";
const PEER_WAIT_MS = 30_000;
const PEER_POLL_MS = 500;
/** Carries unfinished peer-link polls from the old extension runtime to the new one across /reload. */
const PEER_HANDOFF_KEY = Symbol.for("session-eval:peer-handoff");
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

// ---------------------------------------------------------------------------
// Untyped data helpers (JSON files, tool results, adapter module)

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function stringField(value: unknown, key: string): string | undefined {
	if (!isRecord(value)) return undefined;
	const field = value[key];
	return typeof field === "string" ? field : undefined;
}

/** Text of a message or tool result `content`: a string, or the text parts of a content array. */
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => stringField(part, "type") === "text")
		.map((part) => stringField(part, "text") ?? "")
		.join("\n");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Adapter (adapter.mjs, written separately). Loaded lazily so a missing or
// broken adapter does not stop the extension, and passive capture keeps working.

/** What to export, in the shape `exportBundle()` takes. */
interface Selection {
	sessions?: string[];
	cwd?: string;
	since?: string;
	until?: string;
	name?: string;
	latest?: number;
	excludeSessionIds?: string[];
	includeChildren: boolean;
}

interface ExportOptions extends Selection {
	sessionsRoot: string;
	outDir: string;
	selectionDescription: string;
}

interface ExportResult {
	bundleDir: string;
	runCount: number;
	rootCount: number;
	/** Conditional warnings about gaps in this export's data. */
	warnings: string[];
	/** Fixed notes on how pi records map to the bundle. Also at the end of manifest.json `warnings`. */
	caveats: string[];
}

interface Adapter {
	exportBundle(opts: ExportOptions): Promise<unknown>;
}

function isAdapter(value: unknown): value is Adapter {
	return isRecord(value) && typeof value.exportBundle === "function";
}

function parseExportResult(value: unknown): ExportResult {
	if (
		!isRecord(value) ||
		typeof value.bundleDir !== "string" ||
		!isCount(value.runCount) ||
		!isCount(value.rootCount) ||
		!isStringArray(value.warnings) ||
		!isStringArray(value.caveats)
	) {
		throw new Error("session-eval adapter returned an unexpected result from exportBundle()");
	}

	return {
		bundleDir: value.bundleDir,
		runCount: value.runCount,
		rootCount: value.rootCount,
		warnings: value.warnings,
		caveats: value.caveats,
	};
}

async function loadAdapter(): Promise<Adapter> {
	const path = join(EXT_DIR, "adapter.mjs");

	if (!existsSync(path)) {
		throw new Error(`session-eval adapter not found at ${path}`);
	}

	const mod: unknown = await import(pathToFileURL(path).href);
	if (isAdapter(mod)) return mod;
	if (isRecord(mod) && isAdapter(mod.default)) return mod.default;

	throw new Error(`session-eval adapter at ${path} does not export exportBundle()`);
}

// ---------------------------------------------------------------------------
// Paths and naming

const sessionsRoot = () => join(getAgentDir(), "sessions");
const reportRoot = () => join(homedir(), ".pi", "agent-evals");

function expandPath({ path, cwd }: { path: string; cwd: string }): string {
	let p = path.replace(UNICODE_SPACES, " ");

	if (p.startsWith("@")) p = p.slice(1);
	if (p === "~") p = homedir();
	else if (p.startsWith("~/")) p = join(homedir(), p.slice(2));
	else if (p.startsWith("file://")) p = fileURLToPath(p);

	return isAbsolute(p) ? p : resolve(cwd, p);
}

function stamp(date = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function slugify(text: string): string {
	const slug = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48)
		.replace(/-+$/, "");
	return slug || "latest";
}

function slugFor(selection: Selection): string {
	const sessions = selection.sessions ?? [];

	if (sessions.length) {
		const first = basename(sessions[0]).replace(/\.jsonl$/, "");
		const id = first.includes("_") ? first.slice(first.lastIndexOf("_") + 1) : first;
		return slugify(`session-${id.slice(0, 13)}${sessions.length > 1 ? `-and-${sessions.length - 1}` : ""}`);
	}

	const parts: string[] = [selection.cwd ? basename(selection.cwd) : "all-cwds"];
	if (selection.name) parts.push(`name-${selection.name}`);
	if (selection.since) parts.push(`since-${selection.since}`);
	if (selection.until) parts.push(`until-${selection.until}`);
	if (selection.latest) parts.push(`latest-${selection.latest}`);

	return slugify(parts.join("-"));
}

/** Create a fresh report directory under ~/.pi/agent-evals. Never reuses an existing one. */
function createReportDir(slug: string): string {
	const root = reportRoot();
	mkdirSync(root, { recursive: true });

	const base = join(root, `${stamp()}-${slug}`);

	for (let i = 1; i < 1000; i++) {
		const candidate = i === 1 ? base : `${base}-${i}`;

		try {
			mkdirSync(candidate);
			return candidate;
		} catch (error) {
			if (stringField(error, "code") !== "EEXIST") throw error;
		}
	}

	throw new Error(`Could not create a unique report directory under ${root}`);
}

/** Quote an argument for display when it would not survive tokenizing as is. */
function shellArg(value: string): string {
	return /^[^\s"'\\]+$/.test(value) ? value : `"${value.replace(/["\\]/g, "\\$&")}"`;
}

function describeSelection(selection: Selection): string {
	const parts: string[] = [];
	const sessions = selection.sessions ?? [];

	for (const path of sessions) parts.push(`--session ${shellArg(path)}`);
	if (!sessions.length) parts.push(selection.cwd ? `--cwd ${shellArg(selection.cwd)}` : "--all-cwds");
	if (selection.since) parts.push(`--since ${shellArg(selection.since)}`);
	if (selection.until) parts.push(`--until ${shellArg(selection.until)}`);
	if (selection.name) parts.push(`--name ${shellArg(selection.name)}`);
	if (selection.latest) parts.push(`--latest ${selection.latest}`);
	if (selection.excludeSessionIds?.length) parts.push(`excluding session ${selection.excludeSessionIds.join(", ")}`);
	if (!selection.includeChildren) parts.push("--no-children");

	return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Selection requests (shared by the command and the tool)

/** Root-session filters. They apply only when no explicit session paths are given. */
interface Filters {
	cwd?: string;
	allCwds?: boolean;
	since?: string;
	until?: string;
	name?: string;
	latest?: number;
}

type SelectionRequest =
	| { kind: "sessions"; sessions: string[]; includeChildren: boolean }
	| { kind: "filters"; filters: Filters; includeCurrent: boolean; includeChildren: boolean };

const FILTER_KEYS = [
	"cwd",
	"allCwds",
	"since",
	"until",
	"name",
	"latest",
] as const satisfies readonly (keyof Filters)[];
const FILTER_FLAGS: Record<keyof Filters, string> = {
	cwd: "--cwd",
	allCwds: "--all-cwds",
	since: "--since",
	until: "--until",
	name: "--name",
	latest: "--latest",
};
const FILTER_PARAMS: Record<keyof Filters, string> = {
	cwd: "cwd",
	allCwds: "allCwds",
	since: "since",
	until: "until",
	name: "name",
	latest: "latest",
};

/** Check that the given options fit together. `labels` names each filter in error messages. */
function selectionRequest(input: {
	sessions: string[];
	filters: Filters;
	includeCurrent: boolean;
	includeChildren: boolean;
	labels: Record<keyof Filters, string>;
}): SelectionRequest {
	const { sessions, filters, includeCurrent, includeChildren, labels } = input;

	if (filters.cwd && filters.allCwds) throw new Error(`Use either ${labels.cwd} or ${labels.allCwds}, not both`);

	if (!sessions.length) return { kind: "filters", filters, includeCurrent, includeChildren };

	const given = FILTER_KEYS.filter((key) => filters[key] !== undefined && filters[key] !== false);
	if (given.length) {
		throw new Error(
			`Explicit sessions cannot be combined with ${given.map((key) => labels[key]).join(", ")}. Give either sessions or filters.`,
		);
	}

	return { kind: "sessions", sessions, includeChildren };
}

/**
 * Apply defaults. Explicit session paths are exported as given. Otherwise: filter to the
 * given cwd (default: current cwd) unless all cwds were requested; select the latest root
 * session when no other filter was given; exclude the current session unless asked to include it.
 */
export function resolveSelection(input: {
	request: SelectionRequest;
	cwd: string;
	currentSessionId: string | null;
}): Selection {
	const { request, cwd, currentSessionId } = input;

	switch (request.kind) {
		case "sessions":
			return { sessions: request.sessions, includeChildren: request.includeChildren };
		case "filters": {
			const { filters } = request;
			const narrowed = filters.since || filters.until || filters.name;

			return {
				cwd: filters.allCwds ? undefined : (filters.cwd ?? cwd),
				since: filters.since,
				until: filters.until,
				name: filters.name,
				latest: filters.latest ?? (narrowed ? undefined : 1),
				excludeSessionIds: !request.includeCurrent && currentSessionId ? [currentSessionId] : undefined,
				includeChildren: request.includeChildren,
			};
		}
		default: {
			const _exhaustive: never = request;
			return _exhaustive;
		}
	}
}

// ---------------------------------------------------------------------------
// Command argument parsing

/**
 * Split command arguments like a shell. Single quotes are literal. Inside double quotes only
 * `\"` and `\\` are escapes, so regexes such as "run-\d+" keep their backslashes. Quoted parts
 * join the surrounding word, so `--name='a b'` is one token.
 */
function tokenize(text: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let inToken = false;
	let quote: '"' | "'" | null = null;

	for (let i = 0; i < text.length; i++) {
		const c = text[i];

		if (quote === "'") {
			if (c === "'") quote = null;
			else current += c;
			continue;
		}

		if (quote === '"') {
			const next = text[i + 1];
			if (c === '"') quote = null;
			else if (c === "\\" && (next === '"' || next === "\\")) {
				current += next;
				i++;
			} else current += c;
			continue;
		}

		if (/\s/.test(c)) {
			if (inToken) tokens.push(current);
			current = "";
			inToken = false;
			continue;
		}

		inToken = true;
		if (c === '"' || c === "'") quote = c;
		else current += c;
	}

	if (quote) throw new Error(`Unclosed ${quote} quote`);
	if (inToken) tokens.push(current);

	return tokens;
}

function positiveInteger(raw: string, flag: string): number {
	const n = Number(raw);
	if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < 1)
		throw new Error(`${flag} needs a positive integer, got "${raw}"`);
	return n;
}

export function parseArgs({ text, cwd }: { text: string; cwd: string }): SelectionRequest {
	const tokens = tokenize(text);
	const sessions: string[] = [];
	const filters: Filters = {};
	let includeChildren = true;
	let includeCurrent = false;

	const value = (i: number, flag: string) => {
		const v = tokens[i + 1];
		if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
		return v;
	};

	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		const eq = t.startsWith("--") ? t.indexOf("=") : -1;
		const flag = eq > 0 ? t.slice(0, eq) : t;
		const inline = eq > 0 ? t.slice(eq + 1) : undefined;
		const take = () => inline ?? value(i++, flag);

		switch (flag) {
			case "latest": {
				const next = tokens[i + 1];
				if (next !== undefined && /^\d+$/.test(next)) {
					filters.latest = positiveInteger(next, "latest");
					i++;
				} else {
					filters.latest = 1;
				}
				break;
			}
			case "--latest":
				filters.latest = positiveInteger(take(), flag);
				break;
			case "--session":
				sessions.push(expandPath({ path: take(), cwd }));
				break;
			case "--cwd":
				filters.cwd = expandPath({ path: take(), cwd });
				break;
			case "--since":
				filters.since = take();
				break;
			case "--until":
				filters.until = take();
				break;
			case "--name": {
				const re = take();
				new RegExp(re, "i"); // Validate early; the adapter compiles it again.
				filters.name = re;
				break;
			}
			case "--all-cwds":
				filters.allCwds = true;
				break;
			case "--no-children":
				includeChildren = false;
				break;
			case "--include-current":
				includeCurrent = true;
				break;
			default:
				if (!t.startsWith("-") && t.endsWith(".jsonl")) {
					sessions.push(expandPath({ path: t, cwd }));
					break;
				}
				throw new Error(`Unknown argument: ${t}`);
		}
	}

	return selectionRequest({ sessions, filters, includeCurrent, includeChildren, labels: FILTER_FLAGS });
}

// ---------------------------------------------------------------------------
// Harness context

function currentSession(ctx: ExtensionContext): { id: string | null; file: string | null } {
	let id: string | null = null;
	let file: string | null = null;

	try {
		id = ctx.sessionManager.getSessionId() ?? null;
	} catch {
		/* fall back below */
	}
	try {
		file = ctx.sessionManager.getSessionFile() ?? null;
	} catch {
		/* fall back below */
	}

	return { id: id ?? process.env.PI_SESSION_ID ?? null, file: file ?? process.env.PI_SESSION_FILE ?? null };
}

function harnessContext({ ctx, extra = [] }: { ctx: ExtensionContext; extra?: string[] }): string {
	const session = currentSession(ctx);

	return [
		CONTEXT_MARK,
		`harness: pi ${VERSION}`,
		"adapter: tool `session_eval_export` writes a trace bundle (schema v1) from pi sessions. Use it instead of parsing pi session files. " +
			"Give either sessions (root .jsonl paths) or filters: cwd (default: current cwd), allCwds, since (inclusive), until (exclusive), " +
			"name (case-insensitive regex on the session name, or on the first user message when unnamed), latest (N newest roots; 1 when no latest, since, until or name). " +
			"Dates are ISO 8601; a date alone means local midnight. Filters compare the session start time. " +
			"Also: includeCurrent (default false; the current session is excluded unless named in sessions), includeChildren (default true), " +
			"reportDir (bundle goes to <reportDir>/bundle; default: a new report directory). " +
			"Returns bundleDir, reportDir, runCount, rootCount, warnings, caveatCount (fixed notes, listed at the end of manifest.json warnings) and selection.",
		`sessions root: ${sessionsRoot()}. Layout: --<cwd with "/" replaced by "-">--/<timestamp>_<sessionId>.jsonl (one JSONL tree per session); subagent sessions under <same stem>/tasks/*.jsonl; tmux peer agents are separate root sessions, linked by session-eval:peer-link custom entries.`,
		`current session: id=${session.id ?? "unknown"} file=${session.file ?? "unknown"}. It is still being written, so a bundle that includes it is incomplete.`,
		`default report root: ${reportRoot()}/<YYYY-MM-DDTHHmm>-<slug>/ with the bundle in bundle/.`,
		...extra,
		`</${CONTEXT_TAG}>`,
	].join("\n");
}

// ---------------------------------------------------------------------------
// Passive capture helpers

/** True for a package source (npm:, git: or a remote URL) rather than a local path. */
function isPackageSource(source: string): boolean {
	return /^(npm|git):/.test(source) || (URL_SCHEME.test(source) && !/^file:/i.test(source));
}

/** A remote location without credentials, query string or fragment. */
function remoteName(source: string): string {
	if (URL_SCHEME.test(source)) {
		try {
			const url = new URL(source);
			return `${url.protocol}//${url.host}${url.pathname}`;
		} catch {
			/* fall through to the textual strip */
		}
	}

	return source
		.replace(/[?#].*$/, "")
		.replace(/\/\/[^/@\s]*@/, "//")
		.replace(/^[^/@\s]*@/, "");
}

/**
 * Name a package by its source without anything private: URL credentials, query strings and
 * fragments are removed, and a local path is reduced to its last segment.
 */
export function packageSourceName(source: string): string {
	const s = source.trim();

	if (s.startsWith("npm:")) return s.replace(/[?#].*$/, "").replace(/\/\/[^/@\s]*@/, "//");
	if (s.startsWith("git:")) return `git:${remoteName(s.slice(4))}`;
	if (isPackageSource(s)) return remoteName(s);

	let local = s;
	if (/^file:/i.test(local)) {
		try {
			local = fileURLToPath(local);
		} catch {
			local = local.replace(/^file:\/*/i, "/");
		}
	}

	return (
		local
			.replace(/[\\/]+$/, "")
			.split(/[\\/]/)
			.pop() || "local-package"
	);
}

function extensionNames(pi: ExtensionAPI, cwd: string): string[] {
	const names = new Set<string>();

	const fromPath = (p: string) => {
		const file = basename(p);
		return /^index\.[cm]?[jt]s$/.test(file) ? basename(dirname(p)) : file.slice(0, file.length - extname(file).length);
	};

	const fromEntry = (entry: string) => (isPackageSource(entry) ? packageSourceName(entry) : fromPath(entry));

	const fromSource = (info: { path: string; source: string; origin: string } | undefined) => {
		if (!info?.path || info.path.startsWith("builtin:") || info.path.startsWith("<")) return;
		names.add(info.origin === "package" && info.source ? packageSourceName(info.source) : fromPath(info.path));
	};

	// Extensions that registered tools or commands: exact.
	try {
		for (const tool of pi.getAllTools()) fromSource(tool.sourceInfo);
	} catch {
		/* best effort */
	}
	try {
		for (const cmd of pi.getCommands()) if (cmd.source === "extension") fromSource(cmd.sourceInfo);
	} catch {
		/* best effort */
	}

	// Extensions that only handle events are invisible to those APIs; derive from
	// the auto-discovery directories, settings and -e flags instead.
	const listDir = (dir: string) => {
		try {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				if (entry.isFile() && /\.[cm]?[jt]s$/.test(entry.name)) names.add(fromPath(join(dir, entry.name)));
				else if (entry.isDirectory() && ["index.ts", "index.js"].some((f) => existsSync(join(dir, entry.name, f))))
					names.add(entry.name);
			}
		} catch {
			/* missing directory */
		}
	};

	listDir(join(getAgentDir(), "extensions"));
	listDir(join(cwd, ".pi", "extensions"));

	try {
		for (const p of pi.getSettings().extensions ?? []) names.add(fromEntry(p));
	} catch {
		/* best effort */
	}

	const argv = process.argv;
	for (let i = 0; i < argv.length - 1; i++) {
		if (argv[i] === "-e" || argv[i] === "--extension") names.add(fromEntry(argv[i + 1]));
	}

	return [...names].sort();
}

/** Linux process start ticks, as tmux-agents uses to name its state directory. */
function processStart(pid: number): string | undefined {
	try {
		const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
		return raw.slice(raw.lastIndexOf(")") + 2).split(" ")[19];
	} catch {
		return undefined;
	}
}

function readJson(path: string): unknown {
	try {
		if (statSync(path).size > 200_000) return undefined;
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

interface PeerSession {
	sessionId: string;
	sessionFile: string | null;
}

/** A spawned peer whose session is not yet known. `paneId` or `name` identifies it in tmux-agents' state. */
interface PendingPeer {
	callId: string;
	paneId: string | null;
	name: string | null;
	deadline: number;
}

function isPendingPeer(value: unknown): value is PendingPeer {
	return (
		isRecord(value) &&
		typeof value.callId === "string" &&
		typeof value.deadline === "number" &&
		(value.paneId === null || typeof value.paneId === "string") &&
		(value.name === null || typeof value.name === "string")
	);
}

/** Peer polls handed from a runtime shutting down for /reload to the runtime that replaces it. */
interface PeerHandoff {
	sessionFile: string | null;
	peers: PendingPeer[];
}

function takePeerHandoff(): PeerHandoff | undefined {
	const value: unknown = Reflect.get(globalThis, PEER_HANDOFF_KEY);
	Reflect.deleteProperty(globalThis, PEER_HANDOFF_KEY);

	if (!isRecord(value) || !Array.isArray(value.peers)) return undefined;
	return {
		sessionFile: typeof value.sessionFile === "string" ? value.sessionFile : null,
		peers: value.peers.filter(isPendingPeer),
	};
}

function putPeerHandoff(handoff: PeerHandoff): void {
	Reflect.set(globalThis, PEER_HANDOFF_KEY, handoff);
}

/**
 * Find the child's session id and file from tmux-agents' private state
 * ($TMPDIR/pi-tmux-agents-<uid>/<pid>-<start>/child-*). Matches on the pane id when known.
 * Otherwise matches on the name and takes the newest child with that name.
 */
function findPeerSession(peer: Pick<PendingPeer, "paneId" | "name">): PeerSession | undefined {
	if (!peer.paneId && peer.name === null) return undefined;

	const start = processStart(process.pid);
	if (!start) return undefined;

	const root = join(tmpdir(), `pi-tmux-agents-${process.getuid?.()}`, `${process.pid}-${start}`);
	let dirs: string[];

	try {
		dirs = readdirSync(root).filter((d) => d.startsWith("child-"));
	} catch {
		return undefined;
	}

	const matches = dirs
		.map((dir) => ({ dir, meta: readJson(join(root, dir, "meta.json")) }))
		.filter(({ meta }) =>
			peer.paneId ? stringField(meta, "id") === peer.paneId : stringField(meta, "name") === peer.name,
		)
		.sort((a, b) => (stringField(b.meta, "createdAt") ?? "").localeCompare(stringField(a.meta, "createdAt") ?? ""));

	const match = matches[0];
	if (!match) return undefined;

	const token = stringField(match.meta, "token");
	const snap = readJson(join(root, match.dir, "snapshot.json"));
	const sessionId = stringField(snap, "sessionId");
	if (!token || stringField(snap, "token") !== token || !sessionId) return undefined;

	return { sessionId, sessionFile: stringField(snap, "sessionFile") ?? null };
}

// ---------------------------------------------------------------------------

export default function sessionEval(pi: ExtensionAPI) {
	let contextSent = false;
	const toolStarts = new Map<string, number>();
	const peerArgs = new Map<string, string | undefined>();
	const peerPolls = new Map<string, { peer: PendingPeer; timer: ReturnType<typeof setTimeout> }>();

	const append = (customType: string, data: unknown) => {
		try {
			pi.appendEntry(customType, data);
		} catch {
			/* never break the session */
		}
	};

	/** True when the active branch already carries the harness context (e.g. after reload, resume or tree navigation). */
	const branchHasContext = (ctx: ExtensionContext): boolean => {
		try {
			for (const entry of ctx.sessionManager.getBranch()) {
				if (entry.type === "custom_message" && entry.customType === CONTEXT_CUSTOM_TYPE) return true;
				if (entry.type !== "message") continue;
				const message: unknown = entry.message;
				if (!isRecord(message) || (message.role !== "user" && message.role !== "toolResult")) continue;
				if (textOf(message.content).includes(CONTEXT_MARK)) return true;
			}
		} catch {
			/* treat as absent */
		}
		return false;
	};

	/** Export to `<reportDir>/bundle`. Creates a new report directory unless one is given, and removes it again if empty after a failure. */
	const runExport = async (input: {
		selection: Selection;
		reportDir?: string;
		onStart?: (bundleDir: string) => void;
	}) => {
		const created = input.reportDir === undefined;
		const reportDir = input.reportDir ?? createReportDir(slugFor(input.selection));
		const bundleDir = join(reportDir, "bundle");

		try {
			input.onStart?.(bundleDir);
			const adapter = await loadAdapter();
			const result = parseExportResult(
				await adapter.exportBundle({
					...input.selection,
					sessionsRoot: sessionsRoot(),
					outDir: bundleDir,
					selectionDescription: describeSelection(input.selection),
				}),
			);
			return { reportDir, result };
		} catch (error) {
			if (created) {
				try {
					rmdirSync(reportDir);
				} catch {
					/* not empty or already gone */
				}
			}
			throw error;
		}
	};

	const writePeerLink = (peer: PendingPeer, found: PeerSession | undefined) => {
		append("session-eval:peer-link", {
			callId: peer.callId,
			name: peer.name,
			childSessionId: found?.sessionId ?? null,
			childSessionFile: found?.sessionFile ?? null,
		});
	};

	/** Poll until the child's session is known or the deadline passes. The child writes snapshot.json at its session_start, which can be after spawn returns. */
	const pollPeer = (peer: PendingPeer) => {
		peerPolls.delete(peer.callId);
		const found = findPeerSession(peer);

		if (found || Date.now() >= peer.deadline || (!peer.paneId && peer.name === null)) {
			writePeerLink(peer, found);
			return;
		}

		const timer = setTimeout(() => pollPeer(peer), PEER_POLL_MS);
		timer.unref?.();
		peerPolls.set(peer.callId, { peer, timer });
	};

	// --- Lifecycle -----------------------------------------------------------

	pi.on("session_start", async (event, ctx) => {
		contextSent = branchHasContext(ctx);
		toolStarts.clear();

		try {
			const handoff = takePeerHandoff();
			if (event.reason === "reload" && handoff && handoff.sessionFile === currentSession(ctx).file) {
				for (const peer of handoff.peers) pollPeer(peer);
			}
		} catch {
			/* best effort */
		}

		try {
			const data = { extensions: extensionNames(pi, ctx.cwd), piVersion: VERSION ?? null };
			const branch = ctx.sessionManager.getBranch();
			let last: unknown;
			for (let i = branch.length - 1; i >= 0; i--) {
				const entry = branch[i];
				if (entry.type === "custom" && entry.customType === "session-eval:features") {
					last = entry.data;
					break;
				}
			}
			if (JSON.stringify(last) !== JSON.stringify(data)) append("session-eval:features", data);
		} catch {
			/* best effort */
		}
	});

	// Navigating the tree changes the active branch, which may or may not carry the context.
	pi.on("session_tree", async (_event, ctx) => {
		contextSent = branchHasContext(ctx);
	});

	pi.on("session_shutdown", async (event, ctx) => {
		const pending = [...peerPolls.values()];
		for (const { timer } of pending) clearTimeout(timer);
		peerPolls.clear();
		toolStarts.clear();
		peerArgs.clear();

		try {
			if (event.reason === "reload") {
				// The same session continues in the new runtime, which resumes the polls.
				if (pending.length)
					putPeerHandoff({ sessionFile: currentSession(ctx).file, peers: pending.map((p) => p.peer) });
				return;
			}

			// The session is ending here: record what is known now rather than lose the link.
			for (const { peer } of pending) writePeerLink(peer, findPeerSession(peer));
		} catch {
			/* best effort */
		}
	});

	// --- Passive capture: timing and peer links ------------------------------

	pi.on("tool_execution_start", async (event) => {
		if (event.parentToolCallId) return;
		toolStarts.set(event.toolCallId, Date.now());
		const args: unknown = event.args;
		if (event.toolName === PEER_TOOL) peerArgs.set(event.toolCallId, stringField(args, "name"));
	});

	pi.on("tool_execution_end", async (event) => {
		if (event.parentToolCallId) return;

		const started = toolStarts.get(event.toolCallId);
		toolStarts.delete(event.toolCallId);
		// Prefer pi's own measurement of execute(); fall back to the time between start and end events.
		const durationMs = event.durationMs ?? (started === undefined ? undefined : Date.now() - started);
		if (durationMs !== undefined)
			append("session-eval:timing", { callId: event.toolCallId, durationMs: Math.round(durationMs) });

		if (event.toolName !== PEER_TOOL) return;
		const argName = peerArgs.get(event.toolCallId);
		peerArgs.delete(event.toolCallId);
		if (event.isError) return;

		try {
			const result: unknown = event.result;
			let parsed: unknown;
			try {
				parsed = JSON.parse(textOf(isRecord(result) ? result.content : undefined));
			} catch {
				parsed = undefined;
			}

			pollPeer({
				callId: event.toolCallId,
				paneId: stringField(parsed, "id") ?? null,
				name: stringField(parsed, "name") ?? argName ?? null,
				deadline: Date.now() + PEER_WAIT_MS,
			});
		} catch {
			/* best effort */
		}
	});

	// --- Skill-load detection and harness context injection ------------------

	// Path 1: the model read .../evaluate-session/SKILL.md. Append the context to that read result.
	pi.on("tool_result", async (event, ctx) => {
		try {
			if (contextSent || event.toolName !== "read" || event.isError || event.parentToolCallId) return undefined;

			const raw = event.input.path;
			if (typeof raw !== "string") return undefined;
			// Compare path segments, not a "/" suffix, so Windows paths match too.
			const path = expandPath({ path: raw, cwd: ctx.cwd });
			if (basename(path) !== "SKILL.md" || basename(dirname(path)) !== SKILL_NAME) return undefined;

			contextSent = true;
			return { content: [...event.content, { type: "text" as const, text: `\n\n${harnessContext({ ctx })}` }] };
		} catch {
			return undefined;
		}
	});

	// Path 2: /skill:evaluate-session expanded into the prompt of a new run.
	pi.on("before_agent_start", async (event, ctx) => {
		try {
			if (contextSent || event.messageType !== "user" || !event.prompt.includes(SKILL_BLOCK_MARK)) return undefined;
			if (event.prompt.includes(CONTEXT_MARK)) {
				contextSent = true;
				return undefined;
			}

			contextSent = true;
			return { message: { customType: CONTEXT_CUSTOM_TYPE, content: harnessContext({ ctx }), display: false } };
		} catch {
			return undefined;
		}
	});

	// Path 3: /skill:evaluate-session queued while the agent is streaming (no before_agent_start).
	pi.on("input", async (event, ctx) => {
		try {
			if (contextSent || !event.streamingBehavior) return undefined;
			const command = `/skill:${SKILL_NAME}`;
			const rest = event.text.slice(command.length);
			if (!event.text.startsWith(command) || (rest && !/^\s/.test(rest))) return undefined;
			if (event.text.includes(CONTEXT_MARK)) {
				contextSent = true;
				return undefined;
			}

			contextSent = true;
			pi.sendMessage(
				{ customType: CONTEXT_CUSTOM_TYPE, content: harnessContext({ ctx }), display: false },
				{ deliverAs: event.streamingBehavior },
			);
		} catch {
			/* best effort */
		}
		return undefined;
	});

	// --- Tool ----------------------------------------------------------------

	pi.registerTool({
		name: "session_eval_export",
		label: "Export session trace bundle",
		description:
			"Export pi sessions as a trace bundle for the evaluate-session skill. Give sessions or filters, not both. " +
			"Default: latest root session in the current cwd, excluding the current session, with subagent and peer sessions.",
		promptSnippet: "Export pi sessions as an evaluate-session trace bundle",
		parameters: Type.Object({
			sessions: Type.Optional(Type.Array(Type.String(), { description: "Root session .jsonl paths" })),
			cwd: Type.Optional(Type.String({ description: "Sessions started in this dir (default: current cwd)" })),
			allCwds: Type.Optional(Type.Boolean({ description: "No cwd filter" })),
			since: Type.Optional(Type.String({ description: "Started at or after (ISO 8601, date = local midnight)" })),
			until: Type.Optional(Type.String({ description: "Started before (ISO 8601, date = local midnight)" })),
			name: Type.Optional(Type.String({ description: "Case-insensitive regex on session name" })),
			latest: Type.Optional(
				Type.Integer({ minimum: 1, description: "N newest roots (default 1 without since/until/name)" }),
			),
			includeCurrent: Type.Optional(Type.Boolean({ description: "Include the current session" })),
			includeChildren: Type.Optional(
				Type.Boolean({ description: "Include subagent and peer sessions (default true)" }),
			),
			reportDir: Type.Optional(
				Type.String({ description: "Report dir; bundle goes to <reportDir>/bundle (default: new dir)" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { sessions = [], includeCurrent = false, includeChildren = true, reportDir, ...filters } = params;
			const request = selectionRequest({
				sessions: sessions.map((path) => expandPath({ path, cwd: ctx.cwd })),
				filters: {
					...filters,
					cwd: filters.cwd === undefined ? undefined : expandPath({ path: filters.cwd, cwd: ctx.cwd }),
				},
				includeCurrent,
				includeChildren,
				labels: FILTER_PARAMS,
			});
			const selection = resolveSelection({ request, cwd: ctx.cwd, currentSessionId: currentSession(ctx).id });

			let exported: Awaited<ReturnType<typeof runExport>>;
			try {
				exported = await runExport({
					selection,
					reportDir: reportDir === undefined ? undefined : expandPath({ path: reportDir, cwd: ctx.cwd }),
				});
			} catch (error) {
				throw new Error(`session_eval_export failed: ${errorMessage(error)}`);
			}

			const { result } = exported;
			const data = {
				bundleDir: result.bundleDir,
				reportDir: exported.reportDir,
				runCount: result.runCount,
				rootCount: result.rootCount,
				warnings: result.warnings,
				caveatCount: result.caveats.length,
				selection: describeSelection(selection),
			};

			return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], details: data };
		},
	});

	// --- Command -------------------------------------------------------------

	pi.registerCommand("evaluate-session", {
		description:
			"Export pi sessions as a trace bundle and run /skill:evaluate-session (args: latest [N] | --session PATH | --cwd DIR | --all-cwds | --since DATE | --until DATE | --name REGEX | --latest N | --no-children | --include-current)",
		handler: async (args, ctx) => {
			const notify = (text: string, level: "info" | "warning" | "error") => {
				try {
					ctx.ui.notify(text, level);
				} catch {
					/* no UI */
				}
			};

			let selection: Selection;

			try {
				const request = parseArgs({ text: args ?? "", cwd: ctx.cwd });
				selection = resolveSelection({ request, cwd: ctx.cwd, currentSessionId: currentSession(ctx).id });
			} catch (error) {
				notify(`/evaluate-session: ${errorMessage(error)}`, "error");
				return;
			}

			let reportDir: string;
			let result: ExportResult;

			try {
				({ reportDir, result } = await runExport({
					selection,
					onStart: (bundleDir) => notify(`session-eval: exporting bundle to ${bundleDir}...`, "info"),
				}));
			} catch (error) {
				notify(`session-eval: export failed: ${errorMessage(error)}`, "error");
				return;
			}

			if (!result.rootCount) {
				notify(
					`session-eval: no sessions matched (${describeSelection(selection)}). Empty bundle left at ${result.bundleDir}.`,
					"warning",
				);
				return;
			}

			const skill = (() => {
				try {
					return pi.getCommands().find((c) => c.source === "skill" && c.name === `skill:${SKILL_NAME}`);
				} catch {
					return undefined;
				}
			})();

			if (!skill) {
				notify(
					`session-eval: skill "${SKILL_NAME}" is not installed. Bundle (${result.runCount} runs, ${result.rootCount} roots) left at ${result.bundleDir}.`,
					"warning",
				);
				return;
			}

			const warnings = result.warnings.length ? result.warnings.map((w) => `- ${w}`).join("\n") : "none";
			const request = [
				`Evaluate the pi sessions in the trace bundle at ${result.bundleDir} (${result.runCount} runs, ${result.rootCount} root sessions).`,
				`Write the digest and report to ${reportDir}.`,
				`Selection: ${describeSelection(selection)}.`,
				`Adapter warnings:\n${warnings}`,
				`Adapter caveats: ${result.caveats.length} fixed notes on how pi records map to the bundle, listed at the end of the warnings in manifest.json.`,
				"",
				harnessContext({ ctx, extra: [`bundle: ${result.bundleDir}`, `report dir: ${reportDir}`] }),
			].join("\n");

			contextSent = true;
			pi.sendUserMessage(
				`/skill:${SKILL_NAME} ${request}`,
				ctx.isIdle() ? { expandPromptTemplates: true } : { expandPromptTemplates: true, deliverAs: "followUp" },
			);
		},
	});
}
