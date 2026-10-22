#!/usr/bin/env node
// pi-session-eval adapter: converts pi coding-agent session JSONL files into a
// harness-neutral trace bundle (schema version 1). Node >= 22, ESM, no npm deps.
//
// Contract: evaluate-session/references/trace-bundle.md

import { createReadStream } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const ADAPTER_NAME = "pi-session-eval";
export const ADAPTER_VERSION = "0.3.0";

const LIMIT = {
	user: 4000,
	assistant: 6000,
	arg: 2000,
	output: 3000,
	prompt: 4000,
	error: 2000,
	reason: 500,
	note: 500,
};
const MARK = "\n…[truncated]…\n";

const DEFAULT_SESSIONS_ROOT = path.join(os.homedir(), ".pi", "agent", "sessions");

// ---------------------------------------------------------------------------
// Text helpers: redaction, excerpts, hashing
// ---------------------------------------------------------------------------

// Key names whose values are secrets. Matched anywhere in the key, so prefixed
// names such as AZURE_CLIENT_SECRET, OPENAI_API_KEY or _authToken count.
// `token` and `auth` must end a word, so max_tokens or author do not count.
const STRONG_KEY =
	/secret|passw(?:or)?d|pwd|credential|api[_.-]?key|private[_.-]?key|access[_.-]?key|(?:^|[_.-])pat$|(?:^|[_.-])sas$/;
const WEAK_KEY = /token(?![a-z])|(?:^|[_.-])auth(?:[_.-]?(?:token|key)|orization)?(?![a-z])/;
// The shell variables PWD and OLDPWD hold directories, not passwords.
const SHELL_DIR_VARS = new Set(["PWD", "OLDPWD"]);

/** "strong", "weak" or null. Weak keys (token, auth) need a secret-like value after `:`. */
function sensitiveKeyStrength(key) {
	if (typeof key !== "string" || SHELL_DIR_VARS.has(key)) return null;
	const k = key.replace(/^-+/, "").toLowerCase();
	if (STRONG_KEY.test(k)) return "strong";
	if (WEAK_KEY.test(k)) return "weak";
	return null;
}

function isSensitiveKey(key) {
	return sensitiveKeyStrength(key) !== null;
}

// Values that are type names, placeholders or code, not secrets.
const NON_SECRET_VALUES = new Set([
	"true",
	"false",
	"null",
	"undefined",
	"none",
	"string",
	"number",
	"boolean",
	"bool",
	"str",
	"int",
	"any",
	"unknown",
	"object",
	"required",
	"optional",
]);

function isNonSecretValue(v) {
	return (
		v.length < 3 ||
		/^\d+$/.test(v) ||
		NON_SECRET_VALUES.has(v.toLowerCase()) ||
		v.includes("REDACTED") ||
		/^[$%<{=*]/.test(v) ||
		/[([]/.test(v)
	);
}

function looksSecret(v) {
	return v.length >= 24 || (v.length >= 8 && /\d/.test(v) && /[A-Za-z]/.test(v));
}

// key = value, key: value, "key": "value", key="value", including JSON escaped inside a string.
const KEY_VALUE =
	/(?<![A-Za-z0-9_.$-])(\\?["'])?(-{0,2}[A-Za-z_][A-Za-z0-9_.-]*)(\\?["'])?(\s*[:=]\s*)(\\"(?:[^"\\\n]|\\[^"])*\\"|"(?:[^"\\\n]|\\.)*"|'[^'\n]*'|[^\s"'`,;&})\]]+)/g;

function redactKeyValue(match, q1, key, q2, sep, value) {
	const strength = sensitiveKeyStrength(key);
	if (strength === null) return match;
	const quote = /^(\\"|"|')/.exec(value)?.[1] ?? "";
	const inner = quote ? value.slice(quote.length, value.length - quote.length) : value;
	if (inner.length === 0 || inner.includes("REDACTED")) return match;
	if (!quote) {
		if (isNonSecretValue(inner)) return match;
		if (strength === "weak" && sep.trim() === ":" && !looksSecret(inner)) return match;
	}
	return `${q1 ?? ""}${key}${q2 ?? ""}${sep}${quote}[REDACTED]${quote}`;
}

const CLI_VALUE = "(\"[^\"\\n]*\"|'[^'\\n]*'|[^\\s\"'`-][^\\s\"'`]*)";

const REDACTIONS = [
	[/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, "[REDACTED]"],
	[/\b(Bearer|Basic)\s+[A-Za-z0-9\-._~+/]{12,}=*/gi, "$1 [REDACTED]"],
	[/\b(AccountKey|SharedAccessKey|SharedAccessSignature)(\s*=\s*)[^;\s"'`]+/gi, "$1$2[REDACTED]"],
	[/([?&]sig=)[^&\s"'`]+/gi, "$1[REDACTED]"],
	[/\b(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@"],
	[KEY_VALUE, redactKeyValue],
	// CLI flags followed by a separate value: --password X, --client-secret X
	[
		new RegExp(
			`(--(?:password|passwd|pwd|secret|client-secret|token|access-token|auth-token|sas-token|api-key|apikey|account-key|pat)\\s+)${CLI_VALUE}`,
			"gi",
		),
		"$1[REDACTED]",
	],
	// Short password flags of common database and cloud CLIs
	[new RegExp(`(\\b(?:sqlcmd|bcp)\\b[^\\n|;&]*?\\s-P\\s*)${CLI_VALUE}`, "g"), "$1[REDACTED]"],
	[new RegExp(`(\\baz\\b[^\\n|;&]*?\\s-p\\s+)${CLI_VALUE}`, "g"), "$1[REDACTED]"],
	[/(\b(?:mysql|mysqldump|mysqladmin|mariadb)\b[^\n|;&]*?\s-p)([^\s"'`]+)/g, "$1[REDACTED]"],
	[new RegExp(`(\\bredis-cli\\b[^\\n|;&]*?\\s-a\\s+)${CLI_VALUE}`, "g"), "$1[REDACTED]"],
	[/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[REDACTED]"],
	[/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED]"],
	[/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED]"],
	[
		/\b((?:pat|token|access[_-]?token|AZURE_DEVOPS_EXT_PAT|SYSTEM_ACCESSTOKEN)\b[^\n]{0,40}?)\b([a-z0-9]{52}|[A-Za-z0-9]{84})\b/gi,
		"$1[REDACTED]",
	],
	[/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, "[REDACTED]"],
	[/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]"],
	[/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "[REDACTED]"],
];

export function redact(s) {
	if (typeof s !== "string" || s.length === 0) return s;
	let out = s;
	for (const [re, rep] of REDACTIONS) out = out.replace(re, rep);
	return out;
}

/** Head+tail excerpt of at most `limit` chars (marker included). Redacts first. */
export function excerpt(s, limit) {
	if (s == null) return null;
	const r = redact(String(s));
	if (r.length <= limit) return r;
	const room = Math.max(0, limit - MARK.length);
	const head = Math.ceil(room / 2);
	const tail = room - head;
	return r.slice(0, head) + MARK + (tail > 0 ? r.slice(r.length - tail) : "");
}

function textField(name, s, limit) {
	const str = s == null ? "" : String(s);
	return { [name]: excerpt(str, limit), [name + "Chars"]: str.length };
}

function canonicalJson(v) {
	if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
	if (v && typeof v === "object") {
		return (
			"{" +
			Object.keys(v)
				.sort()
				.filter((k) => v[k] !== undefined)
				.map((k) => JSON.stringify(k) + ":" + canonicalJson(v[k]))
				.join(",") +
			"}"
		);
	}
	return JSON.stringify(v ?? null);
}

export function argsHash(args) {
	return createHash("sha1")
		.update(canonicalJson(args ?? {}))
		.digest("hex");
}

/** `sha256:<hex>` of delivered text, or null. */
function contentHash(s) {
	return typeof s === "string" ? "sha256:" + createHash("sha256").update(s, "utf8").digest("hex") : null;
}

function truncateArgs(v, key) {
	if (typeof v === "string") {
		if (key && isSensitiveKey(key) && v.length > 0) return "[REDACTED]";
		return excerpt(v, LIMIT.arg);
	}
	if (Array.isArray(v)) return v.map((x) => truncateArgs(x));
	if (v && typeof v === "object") {
		const o = {};
		for (const [k, x] of Object.entries(v)) o[k] = truncateArgs(x, k);
		return o;
	}
	return v;
}

function contentText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b) => b && b.type === "text" && typeof b.text === "string")
		.map((b) => b.text)
		.join("\n");
}

function contentTextJoinedRaw(content) {
	// pi-ai contentText semantics for system messages (concatenate text blocks)
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b) => b && b.type === "text")
		.map((b) => b.text ?? "")
		.join("");
}

function num(x) {
	return typeof x === "number" && Number.isFinite(x) ? x : null;
}

function normUsage(u) {
	if (!u || typeof u !== "object") return null;
	return {
		input: num(u.input),
		output: num(u.output),
		cacheRead: num(u.cacheRead),
		cacheWrite: num(u.cacheWrite),
		reasoning: num(u.reasoning),
		cost: num(u.cost?.total),
	};
}

function isoOrNull(t) {
	if (typeof t === "string" && !Number.isNaN(Date.parse(t))) return new Date(t).toISOString();
	if (typeof t === "number" && Number.isFinite(t)) return new Date(t).toISOString();
	return null;
}

function shortData(v, depth = 0) {
	if (typeof v === "string") return excerpt(v, LIMIT.note);
	if (Array.isArray(v)) return depth > 3 ? `[array ${v.length}]` : v.slice(0, 50).map((x) => shortData(x, depth + 1));
	if (v && typeof v === "object") {
		if (depth > 3) return "[object]";
		const o = {};
		for (const [k, x] of Object.entries(v))
			o[k] = isSensitiveKey(k) && typeof x === "string" ? "[REDACTED]" : shortData(x, depth + 1);
		return o;
	}
	return v;
}

// ---------------------------------------------------------------------------
// File reading
// ---------------------------------------------------------------------------

async function* readLines(file) {
	const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
	try {
		for await (const line of rl) yield line;
	} finally {
		rl.close();
	}
}

async function readHeader(file) {
	for await (const line of readLines(file)) {
		if (!line.trim()) continue;
		try {
			const h = JSON.parse(line);
			return h && h.type === "session" ? h : null;
		} catch {
			return null;
		}
	}
	return null;
}

/** Streams a file for light metadata: header, session name (last), first user text. */
async function scanMeta(file, { maxLines = Infinity, wantFirstUser = true, wantName = true } = {}) {
	let header = null,
		name = null,
		firstUser = null,
		n = 0;
	for await (const line of readLines(file)) {
		n++;
		if (n === 1) {
			try {
				const h = JSON.parse(line);
				header = h?.type === "session" ? h : null;
			} catch {
				/* ignore */
			}
			if (!header) break;
			continue;
		}
		if (wantName && line.includes('"session_info"')) {
			try {
				const e = JSON.parse(line);
				if (e.type === "session_info" && typeof e.name === "string") name = e.name;
			} catch {
				/* ignore */
			}
		} else if (wantFirstUser && firstUser === null && line.includes('"role":"user"')) {
			try {
				const e = JSON.parse(line);
				if (e.type === "message" && e.message?.role === "user") firstUser = contentText(e.message.content);
			} catch {
				/* ignore */
			}
		}
		if (n >= maxLines) break;
		if (!wantName && (!wantFirstUser || firstUser !== null)) break;
	}
	return { header, name, firstUser };
}

async function readEntries(file) {
	const entries = [];
	let header = null,
		bad = 0,
		first = true;
	for await (const line of readLines(file)) {
		if (!line.trim()) continue;
		let e;
		try {
			e = JSON.parse(line);
		} catch {
			bad++;
			continue;
		}
		if (first) {
			first = false;
			if (e?.type === "session") {
				header = e;
				continue;
			}
		}
		entries.push(e);
	}
	return { header, entries, bad };
}

async function exists(p) {
	try {
		await fsp.access(p);
		return true;
	} catch {
		return false;
	}
}

async function listJsonl(dir) {
	try {
		const items = await fsp.readdir(dir, { withFileTypes: true });
		return items
			.filter((d) => d.isFile() && d.name.endsWith(".jsonl"))
			.map((d) => path.join(dir, d.name))
			.sort();
	} catch {
		return [];
	}
}

function expandHome(p) {
	if (!p) return p;
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

async function listRootSessionFiles(sessionsRoot) {
	let dirs = [];
	try {
		dirs = (await fsp.readdir(sessionsRoot, { withFileTypes: true })).filter(
			(d) => d.isDirectory() || d.isSymbolicLink(),
		);
	} catch {
		return [];
	}
	const files = [];
	for (const d of dirs) files.push(...(await listJsonl(path.join(sessionsRoot, d.name))));
	return files;
}

const RUN_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/** Run ids become file names in runs/, so only plain names are allowed. */
function isValidRunId(id) {
	return typeof id === "string" && RUN_ID.test(id);
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Epoch ms of a since/until value. A date-only value is local midnight, and a
 * date-time without an offset is local time. Throws on anything unparseable. */
function parseTimeOption(value, label) {
	if (value == null || value === "") return null;
	const s = String(value).trim();
	const d = DATE_ONLY.exec(s);
	let t = Number.NaN;
	if (d) {
		const local = new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]));
		if (
			local.getFullYear() === Number(d[1]) &&
			local.getMonth() === Number(d[2]) - 1 &&
			local.getDate() === Number(d[3])
		)
			t = local.getTime();
	} else {
		t = Date.parse(s);
	}
	if (Number.isNaN(t)) throw new Error(`Invalid ${label}: ${value} (use YYYY-MM-DD or an ISO 8601 date-time)`);
	return t;
}

function parseLatestOption(value) {
	if (value == null || value === "") return null;
	const n = typeof value === "string" && /^\s*\d+\s*$/.test(value) ? Number(value) : value;
	if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid latest: ${value} (must be a positive integer)`);
	return n;
}

function parseNameOption(value) {
	if (value == null || value === "") return null;
	try {
		return new RegExp(String(value), "i");
	} catch (err) {
		throw new Error(`Invalid name: ${value} is not a valid regular expression (${err.message})`);
	}
}

function parseExcludeOption(value) {
	if (value == null) return new Set();
	if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || id === "")) {
		throw new Error("Invalid excludeSessionIds: must be an array of non-empty strings");
	}
	return new Set(value);
}

/** Validates selection options at the boundary, before any disk access. */
function parseSelectionOptions(opts) {
	return {
		sessionsRoot: path.resolve(expandHome(opts.sessionsRoot ?? DEFAULT_SESSIONS_ROOT)),
		sessions: (opts.sessions ?? []).map((p) => path.resolve(expandHome(String(p)))),
		cwd: opts.cwd ? path.resolve(expandHome(opts.cwd)) : null,
		since: parseTimeOption(opts.since, "since"),
		until: parseTimeOption(opts.until, "until"),
		nameRe: parseNameOption(opts.name),
		latest: parseLatestOption(opts.latest),
		exclude: parseExcludeOption(opts.excludeSessionIds),
		includeChildren: opts.includeChildren !== false,
	};
}

export async function selectSessions(opts = {}) {
	const sel = parseSelectionOptions(opts);
	return (await selectSessionsDetailed({ sel, index: new SessionIndex(sel.sessionsRoot) })).files;
}

/** Like selectSessions, plus how many root session files were considered and
 * which files were skipped for an unusable session id. */
async function selectSessionsDetailed({ sel, index }) {
	const badIds = [];
	if (sel.sessions.length > 0) {
		const out = [];
		const seen = new Set();
		for (const abs of sel.sessions) {
			if (seen.has(abs)) continue;
			seen.add(abs);
			const h = await readHeader(abs);
			if (!h) throw new Error(`Not a pi session file (no session header): ${abs}`);
			if (sel.exclude.has(h.id)) continue;
			if (!isValidRunId(h.id)) {
				badIds.push(abs);
				continue;
			}
			out.push(abs);
		}
		return { files: out, scanned: seen.size, badIds };
	}

	const matches = [];
	const allFiles = await listRootSessionFiles(sel.sessionsRoot);
	for (const file of allFiles) {
		const h = await readHeader(file);
		if (!h) continue;
		if (sel.exclude.has(h.id)) continue;
		if (sel.cwd && (typeof h.cwd !== "string" || path.resolve(h.cwd) !== sel.cwd)) continue;
		const t = Date.parse(h.timestamp);
		if (sel.since !== null && !(t >= sel.since)) continue;
		if (sel.until !== null && !(t < sel.until)) continue;
		if (sel.nameRe) {
			const m = await scanMeta(file, { wantFirstUser: true, wantName: true });
			const subject = m.name ?? m.firstUser;
			if (!(subject && sel.nameRe.test(subject))) continue;
		}
		if (!isValidRunId(h.id)) {
			badIds.push(file);
			continue;
		}
		matches.push({ file, id: h.id, t: Number.isNaN(t) ? 0 : t });
	}
	matches.sort((a, b) => a.t - b.t || a.file.localeCompare(b.file));
	const chosen =
		sel.latest === null
			? matches
			: sel.includeChildren
				? await latestTrees({ matches, latest: sel.latest, index })
				: matches.slice(-sel.latest);
	return { files: chosen.map((m) => m.file), scanned: allFiles.length, badIds };
}

/** The `latest` most recent matches that stay roots. Walks newest first; a match
 * that an older chosen root claims as a peer child gives its place back. */
async function latestTrees({ matches, latest, index }) {
	const chosen = new Map();
	const taken = new Set();
	for (let i = matches.length - 1; i >= 0 && chosen.size < latest; i--) {
		const m = matches[i];
		if (taken.has(m.id)) continue;
		chosen.set(m.id, m);
		const { header, entries } = await readEntries(m.file);
		const found = await discoverPeers({
			meta: scanEntries(entries),
			header,
			sessionsRoot: index.root,
			index,
			isTaken: (id) => taken.has(id) || id === m.id,
		});
		for (const p of found.peers) {
			taken.add(p.childId);
			chosen.delete(p.childId);
		}
	}
	return [...chosen.values()].sort((a, b) => a.t - b.t || a.file.localeCompare(b.file));
}

// ---------------------------------------------------------------------------
// System prompt replay (mirrors pi-ai getCurrentSystemMessage/getSystemMessageText)
// ---------------------------------------------------------------------------

class SystemState {
	constructor() {
		this.seen = false;
		this.content = [];
		this.sections = new Map();
		this.tools = new Map();
	}
	apply(msg) {
		this.seen = true;
		if (msg.replace === true) {
			this.content = [];
			this.sections = new Map();
			this.tools = new Map();
		}
		const text = contentTextJoinedRaw(msg.content);
		if (text.length > 0) this.content.push(text);
		for (const [k, v] of Object.entries(msg.sections ?? {})) {
			if (v === null) this.sections.delete(k);
			else this.sections.set(k, String(v));
		}
		for (const t of msg.toolsAdded ?? []) if (t?.name) this.tools.set(t.name, true);
		for (const t of msg.toolsRemoved ?? []) if (t?.name) this.tools.delete(t.name);
	}
	promptChars() {
		const parts = [this.content.join("\n\n"), ...this.sections.values()].filter((p) => p.length > 0);
		return parts.join("\n\n").length;
	}
	instructions() {
		// Roots carry a project_context section. pi-subagents children suppress pi's
		// own context files and instead inherit the parent's rendered
		// <project_context> block inside their preamble section, so scan every part.
		const pc = this.sections.get("project_context");
		const parts = pc != null ? [pc] : [...this.sections.values(), ...this.content];
		const out = [];
		const seen = new Set();
		const re = /<project_instructions path="([^"]*)">([\s\S]*?)<\/project_instructions>/g;
		for (const part of parts) {
			let m;
			re.lastIndex = 0;
			while ((m = re.exec(part))) {
				if (seen.has(m[1])) continue;
				seen.add(m[1]);
				const body = m[2].replace(/^\n/, "").replace(/\n$/, "");
				out.push({ source: m[1], chars: body.length, contentHash: contentHash(body) });
			}
		}
		return out;
	}
	skills() {
		const s = this.sections.get("skills");
		if (s == null) return [];
		const out = [];
		const re = /<skill>([\s\S]*?)<\/skill>/g;
		let m;
		while ((m = re.exec(s))) {
			const name = /<name>([\s\S]*?)<\/name>/.exec(m[1])?.[1]?.trim() ?? null;
			const loc = /<location>([\s\S]*?)<\/location>/.exec(m[1])?.[1]?.trim() ?? null;
			if (name) out.push({ name, path: loc, manualOnly: false, listed: true });
		}
		return out;
	}
	context() {
		return {
			instructions: this.instructions(),
			skillsAvailable: this.skills(),
			toolsAvailable: [...this.tools.keys()],
			systemPromptChars: this.promptChars(),
		};
	}
}

// ---------------------------------------------------------------------------
// Classification helpers
// ---------------------------------------------------------------------------

const SKILL_BLOCK = /^<skill name="([^"]+)" location="([^"]+)">\n/;
// pi's /skill:name expansion (agent-session.js parseSkillBlock)
const SKILL_BLOCK_FULL = /^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/;
const CI_BLOCK_HEADER = "Applicable repository instructions:\n\n";
const READ_TRUNC_TRAILER = /\n\n\[(?:Showing lines \d+-\d+ of \d+|\d+ more lines in file)[^\]]*\]$/;

/** Exit code of a pi bash tool result. pi's bash tool returns isError=false only for exit 0
 * and appends "Command exited with code N" otherwise; timeouts/aborts carry no code. */
function bashExitCode(isError, text) {
	if (!isError) return 0;
	const m = /(?:^|\n\n)Command exited with code (\d+)$/.exec(text ?? "");
	return m ? Number(m[1]) : null;
}

const SHELL_READERS = new Set(["cat", "sed", "head", "tail", "less", "more", "bat", "nl"]);

function unquote(t) {
	return t.replace(/^(['"])(.*)\1$/, "$2");
}

/** SKILL.md files a shell command prints via cat/sed/head/less/…, resolved against the
 * session cwd and any `cd DIR` segments. `onlyReaders`: every segment is a reader or a
 * cd, so the output is skill text only. `plain`: the only reader is `cat <one file>`,
 * so the output is the complete file. */
function shellSkillReads(command, cwd) {
	if (typeof command !== "string" || !command.includes("SKILL.md")) return null;
	const paths = [];
	let base = cwd || "/";
	let onlyReaders = true,
		readers = 0,
		plainCat = false;
	for (const seg of command.split(/\|\||&&|[|;\n]/)) {
		const toks = seg.trim().split(/\s+/).filter(Boolean).map(unquote);
		if (toks.length === 0) continue;
		if (toks[0] === "cd") {
			if (toks.length === 2) base = resolveToolPath(toks[1], base);
			else onlyReaders = false;
			continue;
		}
		let i = 0;
		while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i])) i++;
		if (i < toks.length && (toks[i] === "sudo" || toks[i] === "command")) i++;
		if (i >= toks.length || !SHELL_READERS.has(path.basename(toks[i]))) {
			onlyReaders = false;
			continue;
		}
		const args = toks.slice(i + 1);
		if (path.basename(toks[i]) === "sed" && args.some((t) => /^-[a-zA-Z]*i|^--in-place/.test(t))) {
			onlyReaders = false;
			continue;
		}
		readers++;
		const files = args.filter((t) => /(^|\/)SKILL\.md$/.test(t));
		if (path.basename(toks[i]) === "cat" && args.length === 1 && files.length === 1) plainCat = true;
		for (const f of files) paths.push(resolveToolPath(f, base));
	}
	if (paths.length === 0) return null;
	const unique = [...new Set(paths)];
	return { paths: unique, onlyReaders, plain: onlyReaders && readers === 1 && plainCat && unique.length === 1 };
}

// Roots that look driven by an orchestrating agent rather than a human.
const AGENT_DRIVEN_FIRST = /^\s*You are (?:an? )?(?:[\w-]+ )?worker\b|\bunattended run\b/i;
const AGENT_DRIVEN_PREFIX = /^\s*Orchestrator:/;

function classifyError(toolName, text) {
	const t = (text ?? "").trimStart();
	if (toolName === "read" && t.startsWith("Not re-read:"))
		return { errorClass: "harness_policy", feature: "skill-read-dedupe" };
	if (t.startsWith("Repository instructions must be loaded before modifying"))
		return { errorClass: "harness_policy", feature: "conditional-instructions" };
	if (t === "Tool execution was blocked") return { errorClass: "harness_policy", feature: null };
	if (t === "Operation aborted") return { errorClass: "unknown", feature: null };
	return { errorClass: "tool", feature: null };
}

function mapStopReason(s) {
	switch (s) {
		case "stop":
			return "stop";
		case "toolUse":
			return "tool_use";
		case "length":
			return "length";
		case "error":
			return "error";
		case "aborted":
			return "aborted";
		default:
			return "other";
	}
}

function resolveToolPath(p, cwd) {
	if (typeof p !== "string") return null;
	let s = p.trim();
	if (s.startsWith("@")) s = s.slice(1);
	s = expandHome(s);
	if (s.startsWith("file://")) {
		try {
			s = fileURLToPath(s);
		} catch {
			/* keep */
		}
	}
	return path.isAbsolute(s) ? path.normalize(s) : path.resolve(cwd || "/", s);
}

// ---------------------------------------------------------------------------
// Peer (tmux) session index, built lazily
// ---------------------------------------------------------------------------

class SessionIndex {
	constructor(root) {
		this.root = root;
		this.items = null;
	}
	async load() {
		if (this.items) return this.items;
		this.items = [];
		for (const file of await listRootSessionFiles(this.root)) {
			const m = await scanMeta(file, { maxLines: 40, wantFirstUser: false, wantName: true });
			if (!m.header) continue;
			this.items.push({
				file: path.resolve(file),
				id: m.header.id,
				cwd: m.header.cwd ?? null,
				t: Date.parse(m.header.timestamp),
				name: m.name,
				parentSession: m.header.parentSession ?? null,
			});
		}
		return this.items;
	}
	async fileOf(id) {
		return (await this.load()).find((x) => x.id === id)?.file ?? null;
	}
}

function isInside(file, dir) {
	const rel = path.relative(dir, file);
	return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

// ---------------------------------------------------------------------------
// Run conversion
// ---------------------------------------------------------------------------

/** Entry ids on the path from the leaf back to the root. When a parentId names an
 * entry that is missing (a lost or unparseable line), the walk continues from the
 * entry before it in file order, which is where pi appends. */
function activeSet(entries) {
	const byId = new Map();
	const pos = new Map();
	entries.forEach((e, i) => {
		if (typeof e?.id === "string") {
			byId.set(e.id, e);
			pos.set(e.id, i);
		}
	});
	const previousWithId = (i) => {
		for (let j = i - 1; j >= 0; j--) if (typeof entries[j]?.id === "string") return entries[j];
		return null;
	};
	let cur = null;
	for (let i = entries.length - 1; i >= 0; i--)
		if (typeof entries[i]?.id === "string") {
			cur = entries[i];
			break;
		}
	const active = new Set();
	let dangling = 0;
	while (cur && !active.has(cur.id)) {
		active.add(cur.id);
		if (!cur.parentId) break;
		let next = byId.get(cur.parentId);
		if (!next) {
			dangling++;
			next = previousWithId(pos.get(cur.id));
		}
		cur = next;
	}
	return { active, dangling };
}

/** Pass 1: metadata used to link child runs and to annotate events. */
function scanEntries(entries) {
	const m = {
		calls: new Map(), // callId -> {name, args, ts, entryId}
		results: new Map(), // callId -> toolResult message
		resultTs: new Map(), // callId -> result entry time (ms)
		subCallAgent: new Map(), // callId -> agentId
		agentPath: new Map(), // agentId -> {path, method}
		records: new Map(), // agentId -> {type, description, startedAt}
		spawnPane: new Map(), // paneId -> spawn callId
		spawnNames: new Map(), // name -> spawn callId
		peerCaptures: [], // {callId, name, childSessionId, childSessionFile}
		timing: new Map(), // callId -> durationMs
		features: null, // {extensions, piVersion}
		hasRetryCapture: false,
		sessionName: null,
	};
	for (const e of entries) {
		if (e?.type === "session_info" && typeof e.name === "string") m.sessionName = e.name;
		if (e?.type === "custom") {
			const d = e.data ?? {};
			if (e.customType === "subagents:record" && d.id)
				m.records.set(d.id, { type: d.type ?? null, description: d.description ?? null, startedAt: num(d.startedAt) });
			if (e.customType === "session-eval:peer-link") m.peerCaptures.push(d);
			if (e.customType === "session-eval:timing" && d.callId && num(d.durationMs) !== null)
				m.timing.set(d.callId, d.durationMs);
			if (e.customType === "session-eval:features") m.features = d;
			if (e.customType === "session-eval:retry") m.hasRetryCapture = true;
		}
		if (e?.type === "custom_message" && e.customType === "subagent-notification") {
			const d = e.details ?? {};
			const txt = contentText(e.content);
			const of = d.outputFile ?? /<output-file>([^<]+)<\/output-file>/.exec(txt)?.[1];
			const aid = d.id ?? /<task-id>([^<]+)<\/task-id>/.exec(txt)?.[1];
			if (aid && of && !m.agentPath.has(aid))
				m.agentPath.set(aid, { path: path.resolve(of), method: "subagent-notification.outputFile" });
		}
		if (e?.type !== "message") continue;
		const msg = e.message ?? {};
		if (msg.role === "assistant") {
			for (const b of msg.content ?? []) {
				if (b?.type === "toolCall")
					m.calls.set(b.id, { name: b.name, args: b.arguments ?? {}, ts: Date.parse(e.timestamp), entryId: e.id });
			}
		} else if (msg.role === "toolResult") {
			m.results.set(msg.toolCallId, msg);
			m.resultTs.set(msg.toolCallId, Date.parse(e.timestamp));
			const d = msg.details ?? {};
			if (msg.toolName === "subagent" && d.agentId) m.subCallAgent.set(msg.toolCallId, d.agentId);
			if (msg.toolName === "get_subagent_result" && d.agentId && d.transcriptPath)
				m.agentPath.set(d.agentId, {
					path: path.resolve(d.transcriptPath),
					method: "get_subagent_result.details.transcriptPath",
				});
			if (msg.toolName === "tmux_agent_spawn" && !msg.isError) {
				try {
					const j = JSON.parse(contentText(msg.content));
					if (j?.id) m.spawnPane.set(j.id, msg.toolCallId);
				} catch {
					/* not a JSON result */
				}
			}
		}
	}
	for (const [callId, c] of m.calls)
		if (c.name === "tmux_agent_spawn" && c.args?.name) m.spawnNames.set(c.args.name, callId);
	return m;
}

/** Peer sessions this session started: session-eval:peer-link captures first, then
 * tmux_agent_spawn calls matched by name, cwd and start time. A captured path
 * outside the sessions root is not followed; the session id is looked up instead.
 * `isTaken(id)` rules out sessions claimed elsewhere; each session is used once. */
async function discoverPeers({ meta, header, sessionsRoot, index, isTaken }) {
	const cwd = header?.cwd ?? null;
	const peers = [],
		notes = [],
		missing = [];
	let unmatched = 0;
	const claimedHere = new Set();
	const available = (id) => !claimedHere.has(id) && !isTaken(id);
	const capturedCalls = new Set();
	for (const pc of meta.peerCaptures) {
		let childId = typeof pc.childSessionId === "string" ? pc.childSessionId : null;
		let file = typeof pc.childSessionFile === "string" ? path.resolve(expandHome(pc.childSessionFile)) : null;
		if (!childId && !file) continue; // the capture found no session; spawn inference below may
		if (file && !isInside(file, sessionsRoot)) file = null;
		if (!file && childId) file = await index.fileOf(childId);
		if (!file || !(await exists(file))) {
			missing.push(childId ?? pc.childSessionFile ?? "unknown");
			continue;
		}
		if (!childId) childId = (await readHeader(file))?.id ?? null;
		if (!childId) continue;
		if (pc.callId) capturedCalls.add(pc.callId);
		if (!available(childId)) continue;
		claimedHere.add(childId);
		peers.push({
			file,
			childId,
			callId: pc.callId ?? null,
			name: pc.name ?? null,
			link: { confidence: "explicit", method: "capture:session-eval:peer-link", parentCallId: pc.callId ?? null },
		});
	}
	for (const [cid, c] of meta.calls) {
		if (c.name !== "tmux_agent_spawn" || capturedCalls.has(cid)) continue;
		const r = meta.results.get(cid);
		if (!r || r.isError) continue;
		const name = c.args?.name;
		if (typeof name !== "string") continue;
		const wantCwd = path.resolve(cwd ?? "/", c.args?.cwd ?? ".");
		const lo = c.ts - 5000;
		const hi = Math.max(meta.resultTs.get(cid) || 0, c.ts || 0) + 120000;
		const cands = (await index.load()).filter(
			(x) =>
				x.name === name &&
				x.cwd &&
				path.resolve(x.cwd) === wantCwd &&
				x.t >= lo &&
				x.t <= hi &&
				x.id !== header?.id &&
				available(x.id),
		);
		if (cands.length === 0) {
			unmatched++;
			continue;
		}
		cands.sort((a, b) => Math.abs(a.t - c.ts) - Math.abs(b.t - c.ts));
		if (cands.length > 1)
			notes.push(`tmux_agent_spawn ${name}: ${cands.length} unclaimed candidate sessions, chose nearest in time`);
		claimedHere.add(cands[0].id);
		peers.push({
			file: cands[0].file,
			childId: cands[0].id,
			callId: cid,
			name,
			link: { confidence: "inferred", method: "tmux_agent_spawn name+cwd+start time", parentCallId: cid },
		});
	}
	return { peers, notes, missing, unmatched };
}

async function resolveSessionRef({ ref, env }) {
	if (ref.includes("/") || ref.includes(path.sep) || ref.endsWith(".jsonl")) {
		const p = path.resolve(expandHome(ref));
		return (await exists(p)) ? p : null;
	}
	return env.fileById.get(ref) ?? (await env.index.fileOf(ref));
}

function idSet(entries) {
	return new Set(entries.filter((e) => typeof e?.id === "string").map((e) => e.id));
}

async function entryIdsOf({ file, env }) {
	const cached = env.entryIds.get(file);
	if (cached) return cached;
	const { header, entries } = await readEntries(file);
	const v = { sessionId: header?.id ?? null, ids: idSet(entries) };
	env.entryIds.set(file, v);
	return v;
}

/** A fork or clone copies entries from its source session with their ids. A header
 * parentSession alone does not make a fork: subagent sessions also carry one.
 * Returns null without a parentSession, else { sourcePath, sourceSessionId, copied }. */
async function detectFork({ header, entries, env }) {
	const ref = header?.parentSession;
	if (typeof ref !== "string" || ref === "") return null;
	const sourcePath = await resolveSessionRef({ ref, env });
	if (!sourcePath) return { sourcePath: null, sourceSessionId: null, copied: new Set() };
	const source = await entryIdsOf({ file: sourcePath, env });
	const copied = new Set();
	for (const e of entries) if (typeof e?.id === "string" && source.ids.has(e.id)) copied.add(e.id);
	return { sourcePath, sourceSessionId: source.sessionId, copied };
}

/**
 * Converts one session file. Returns { run, events, childJobs, linkStats }.
 * job: { file, runId, parentId, rootId, kind, link, labelHint, agentTypeHint, parentSendTexts, abandoned }
 */
async function convertRun(job, env) {
	const { header, entries, bad } = await readEntries(job.file);
	env.entryIds.set(job.file, { sessionId: header?.id ?? null, ids: idSet(entries) });
	env.fileById.set(job.runId, job.file);
	const notes = [];
	if (bad > 0) notes.push(`${bad} unparseable line(s) skipped`);
	const cwd = header?.cwd ?? null;
	const { active, dangling } = activeSet(entries);
	if (dangling > 0) {
		notes.push(
			`${dangling} parentId reference(s) point to missing entries; the active path continues through the preceding entry in file order`,
		);
		env.stats.danglingParentRuns++;
	}
	const isAbandonedId = (id) => typeof id === "string" && !active.has(id);
	const branchOf = (e) => (job.abandoned || isAbandonedId(e?.id) ? "abandoned" : "active");
	if (job.abandoned) {
		notes.push("started by a delegation on an abandoned branch of an ancestor run; every event is marked abandoned");
		env.stats.abandonedChildRuns++;
	}

	const fork = await detectFork({ header, entries, env });
	const copied = fork?.copied ?? new Set();
	if (copied.size > 0) {
		notes.push(
			`forked from session ${fork.sourceSessionId ?? "unknown"}; ${copied.size} entries copied from the source are not emitted as events`,
		);
		env.stats.forkedRuns++;
	} else if (fork && job.kind !== "subagent") {
		notes.push(
			fork.sourcePath
				? `header.parentSession=${header.parentSession} shares no entries with this session, not linked`
				: `header.parentSession=${header.parentSession} not found; entries copied from it cannot be told apart and may be counted twice`,
		);
		if (!fork.sourcePath) env.stats.forkSourceMissing++;
	}

	// ---------------- pass 1: metadata for linking ----------------
	const meta = scanEntries(entries);
	const {
		calls,
		subCallAgent,
		agentPath,
		records,
		spawnPane,
		spawnNames,
		timing,
		features,
		hasRetryCapture,
		sessionName,
	} = meta;
	const firstAssistantIdx = entries.findIndex(
		(e) => e?.type === "message" && e.message?.role === "assistant" && !copied.has(e.id),
	);

	// ---------------- child discovery & linking ----------------
	const callChild = new Map(); // callId -> childRunId
	const childJobs = [];
	const linkStats = {
		tasksFiles: 0,
		linked: 0,
		callExplicit: 0,
		callInferred: 0,
		callUnknown: 0,
		peersExplicit: 0,
		peersInferred: 0,
	};
	// A child started by a call on an abandoned branch is abandoned as a whole.
	const childAbandoned = (callId) =>
		job.abandoned === true || (callId != null && isAbandonedId(calls.get(callId)?.entryId));
	const acceptChild = (childId, file) => {
		if (env.exclude.has(childId)) return false;
		if (!isValidRunId(childId)) {
			env.warn(`skipped session with an id that is not a safe run id: ${file}`);
			return false;
		}
		return true;
	};

	if (env.includeChildren) {
		const tasksDir = job.file.replace(/\.jsonl$/, "") + path.sep + "tasks";
		const childFiles = await listJsonl(tasksDir);
		linkStats.tasksFiles = childFiles.length;
		const pathToAgent = new Map();
		for (const [aid, v] of agentPath) pathToAgent.set(v.path, { aid, method: v.method });
		const agentToCall = new Map();
		for (const [cid, aid] of subCallAgent) if (!agentToCall.has(aid)) agentToCall.set(aid, cid);
		const usedCalls = new Set();
		const pending = [];

		for (const cf of childFiles) {
			const cm = await scanMeta(cf, { wantName: false, wantFirstUser: true });
			if (!cm.header) {
				env.warn(`skipped child without session header: ${cf}`);
				continue;
			}
			if (env.claimed.has(cm.header.id) || !acceptChild(cm.header.id, cf)) continue;
			const viaHeader = cm.header.parentSession === header?.id;
			const baseMethod = viaHeader ? "header.parentSession+tasks_dir" : "tasks_dir";
			let callId = null,
				method = baseMethod,
				aid = null;
			const pa = pathToAgent.get(path.resolve(cf));
			if (pa) {
				aid = pa.aid;
				const cid = agentToCall.get(aid);
				if (cid) {
					callId = cid;
					method = `${baseMethod}; callId via subagent.details.agentId+${pa.method}`;
					usedCalls.add(cid);
				}
			}
			pending.push({ cf, meta: cm, callId, confidence: "explicit", method, aid });
		}
		// Fallback: match the child's first user message to a subagent prompt. The
		// subagents:record start time, when recorded, is the closer time signal.
		const subCalls = [...calls.entries()].filter(([, c]) => c.name === "subagent").sort((a, b) => a[1].ts - b[1].ts);
		for (const p of pending) {
			if (p.callId) continue;
			const fu = (p.meta.firstUser ?? "").trim();
			const start = Date.parse(p.meta.header.timestamp);
			let best = null;
			for (const [cid, c] of subCalls) {
				if (usedCalls.has(cid)) continue;
				const pr = typeof c.args?.prompt === "string" ? c.args.prompt.trim() : "";
				if (!pr || !fu) continue;
				if (!(fu === pr || fu.startsWith(pr) || pr.startsWith(fu))) continue;
				const dt = start - c.ts;
				if (dt < -5000) continue;
				const recStart = records.get(subCallAgent.get(cid))?.startedAt ?? null;
				const distance = Math.abs(recStart === null ? dt : start - recStart);
				if (!best || distance < best.distance) best = { cid, distance, viaRecord: recStart !== null };
			}
			if (best) {
				p.callId = best.cid;
				usedCalls.add(best.cid);
				p.confidence = "inferred";
				p.method += `; callId via first user message = subagent prompt${best.viaRecord ? " and subagents:record startedAt" : ""}`;
				const aid = subCallAgent.get(best.cid);
				if (aid) p.aid = aid;
			}
		}
		const agentToChild = new Map();
		for (const p of pending) {
			const childId = p.meta.header.id;
			if (p.callId) callChild.set(p.callId, childId);
			if (!p.aid && p.callId) p.aid = subCallAgent.get(p.callId) ?? null;
			if (p.aid) agentToChild.set(p.aid, childId);
			const c = p.callId ? calls.get(p.callId) : null;
			const rec = p.aid ? records.get(p.aid) : null;
			if (p.callId && p.confidence === "explicit") linkStats.callExplicit++;
			else if (p.callId) linkStats.callInferred++;
			else linkStats.callUnknown++;
			linkStats.linked++;
			env.claimed.add(childId);
			childJobs.push({
				file: p.cf,
				runId: childId,
				parentId: job.runId,
				rootId: job.rootId,
				kind: "subagent",
				link: { confidence: p.confidence, method: p.method, parentCallId: p.callId },
				labelHint: c?.args?.description ?? rec?.description ?? null,
				agentTypeHint: c?.args?.subagent_type ?? rec?.type ?? null,
				parentSendTexts: null,
				abandoned: childAbandoned(p.callId),
			});
		}

		// Resumed subagents continue an existing child transcript.
		for (const [cid, c] of subCalls) {
			if (callChild.has(cid)) continue;
			const resume = typeof c.args?.resume === "string" ? c.args.resume : "";
			const aid = subCallAgent.get(cid);
			if (resume && aid === resume && agentToChild.has(aid)) callChild.set(cid, agentToChild.get(aid));
		}

		// Peers: explicit captures first, then tmux_agent_spawn inference.
		const peerTexts = new Map(); // spawn callId -> Set(texts)
		const addPeerText = (sc, text) => {
			if (!sc || typeof text !== "string") return;
			if (!peerTexts.has(sc)) peerTexts.set(sc, new Set());
			peerTexts.get(sc).add(text.trim());
		};
		for (const [, c] of calls) {
			if (c.name === "tmux_agent_send") addPeerText(spawnPane.get(c.args?.id), c.args?.text);
			else if (c.name === "tmux_agent_message") addPeerText(spawnNames.get(c.args?.to), c.args?.text);
		}
		// Excluded sessions still take part in matching so they are not mistaken for
		// another spawn's peer; acceptChild drops them afterwards.
		const isTaken = (id) => env.claimed.has(id) && !env.pendingRoots.has(id);
		const found = await discoverPeers({ meta, header, sessionsRoot: env.index.root, index: env.index, isTaken });
		notes.push(...found.notes);
		for (const m of found.missing) env.warn(`peer-link capture points to a missing session (${m})`);
		env.stats.peerSpawnUnmatched += found.unmatched;
		for (const p of found.peers) {
			if (!acceptChild(p.childId, p.file)) continue;
			env.claimed.add(p.childId);
			env.pendingRoots.delete(p.childId);
			if (p.callId) callChild.set(p.callId, p.childId);
			if (p.link.confidence === "explicit") linkStats.peersExplicit++;
			else linkStats.peersInferred++;
			childJobs.push({
				file: p.file,
				runId: p.childId,
				parentId: job.runId,
				rootId: job.rootId,
				kind: "peer",
				link: p.link,
				labelHint: p.name,
				agentTypeHint: null,
				parentSendTexts: p.callId ? (peerTexts.get(p.callId) ?? null) : null,
				abandoned: childAbandoned(p.callId),
			});
		}
	}
	for (const [cid, c] of calls)
		if (c.name === "subagent" && !callChild.has(cid) && env.includeChildren) env.stats.subagentCallsUnlinked++;

	// ---------------- pass 2: events ----------------
	const events = [];
	const push = (type, e, fields) => {
		events.push({
			seq: events.length,
			type,
			ts: isoOrNull(e?.timestamp),
			ref: typeof e?.id === "string" ? e.id : null,
			branch: branchOf(e),
			...fields,
		});
	};

	const sys = new SystemState();
	let context = null;
	let contextFromLate = false;
	let curModel = null,
		curThinking = null;
	const models = new Set();
	const assistantById = new Map();
	const errorStreak = new Map(); // assistant entry id -> attempt number
	const dedupeBlocks = { n: 0 },
		ciEvidence = { n: 0 };
	const skillByPath = () =>
		new Map(
			(context?.skillsAvailable ?? sys.skills()).filter((s) => s.path).map((s) => [path.resolve(s.path), s.name]),
		);
	const callArgs = new Map();
	const origin = job.kind === "subagent" ? "parent" : job.kind === "peer" ? null : "human";
	const commandSkills = new Map(); // name -> path, from /skill:name expansions
	const delegByCall = new Map(); // subagent callId -> delegation event
	const delegPending = new Map(); // agentId -> [delegation event] awaiting a delivered result
	const delegPreview = new Map(); // delegation event -> truncated notification fallback
	let userCount = 0,
		agentDrivenFirst = false,
		orchestratorPrefixed = 0,
		namedBeforeFirstUser = null;
	const lastEvent = () => events[events.length - 1];
	const setResult = (d, ev, chars, via) => {
		d.resultChars = chars;
		d.resultRef = { seq: ev.seq, ref: ev.ref };
		d.resultVia = via;
	};
	const deliverAgent = (aid, ev, chars, via) => {
		const list = aid ? delegPending.get(aid) : null;
		if (!list) return;
		for (const d of list) {
			setResult(d, ev, chars, via);
			delegPreview.delete(d);
		}
		delegPending.delete(aid);
	};

	const takeContext = () => {
		if (!context && sys.seen) context = sys.context();
	};
	// Entries copied from a fork source set the starting state but are not events.
	const replayCopied = (e) => {
		if (isAbandonedId(e.id)) return;
		if (e.type === "message" && e.message?.role === "system") sys.apply(e.message);
		else if (e.type === "compaction" && e.systemMessage) sys.apply({ ...e.systemMessage, replace: true });
		else if (e.type === "model_change")
			curModel = e.provider && e.modelId ? `${e.provider}/${e.modelId}` : (e.modelId ?? null);
		else if (e.type === "thinking_level_change") curThinking = e.thinkingLevel ?? null;
	};

	if (copied.size > 0) {
		push(
			"note",
			{ timestamp: header?.timestamp },
			{
				kind: "fork",
				data: { sourcePath: fork.sourcePath, sourceSessionId: fork.sourceSessionId, copiedEntries: copied.size },
			},
		);
	}

	for (let i = 0; i < entries.length; i++) {
		const e = entries[i];
		if (!e || typeof e !== "object") continue;
		if (copied.has(e.id)) {
			replayCopied(e);
			continue;
		}
		if (i === firstAssistantIdx) takeContext();

		switch (e.type) {
			case "message": {
				const m = e.message ?? {};
				switch (m.role) {
					case "system": {
						// Only system messages on the active path shape the prompt.
						const onPath = !isAbandonedId(e.id);
						const before = context
							? { instr: new Map(sys.instructions().map((x) => [x.source, x.contentHash])) }
							: null;
						if (onPath) sys.apply(m);
						if (context) {
							push("note", e, {
								kind: "system_update",
								data: {
									sectionsChanged: Object.entries(m.sections ?? {})
										.filter(([, v]) => v !== null)
										.map(([k]) => k),
									sectionsRemoved: Object.entries(m.sections ?? {})
										.filter(([, v]) => v === null)
										.map(([k]) => k),
									toolsAdded: (m.toolsAdded ?? []).map((t) => t?.name).filter(Boolean),
									toolsRemoved: (m.toolsRemoved ?? []).map((t) => t?.name).filter(Boolean),
									replace: m.replace === true,
									systemPromptChars: onPath ? sys.promptChars() : null,
								},
							});
							if (onPath)
								for (const ins of sys.instructions()) {
									if (before.instr.get(ins.source) !== ins.contentHash)
										push("instruction_load", e, {
											source: ins.source,
											chars: ins.chars,
											contentHash: ins.contentHash,
											trigger: "system_update",
										});
								}
						}
						break;
					}
					case "user": {
						const text = contentText(m.content);
						const sb = SKILL_BLOCK.exec(text);
						let o = origin;
						if (o === null) o = job.parentSendTexts && job.parentSendTexts.has(text.trim()) ? "parent" : "human";
						if (sb && o === "human") o = "command";
						if (job.kind === "primary") {
							if (userCount === 0 && AGENT_DRIVEN_FIRST.test(text)) agentDrivenFirst = true;
							if (AGENT_DRIVEN_PREFIX.test(text)) orchestratorPrefixed++;
						}
						userCount++;
						push("user", e, { ...textField("text", text, LIMIT.user), origin: o });
						if (sb) {
							const full = SKILL_BLOCK_FULL.exec(text);
							const body = full ? full[3] : null;
							if (!commandSkills.has(sb[1])) commandSkills.set(sb[1], sb[2]);
							push("skill_load", e, {
								skill: sb[1],
								path: sb[2],
								via: "user_command",
								callId: null,
								blocked: false,
								chars: body === null ? null : body.length,
								contentHash: contentHash(body),
							});
						}
						break;
					}
					case "custom": {
						push("user", e, { ...textField("text", contentText(m.content), LIMIT.user), origin: "harness" });
						break;
					}
					case "assistant": {
						const model = m.provider && m.model ? `${m.provider}/${m.model}` : (m.model ?? null);
						if (model) models.add(model);
						const blocks = Array.isArray(m.content) ? m.content : [];
						const text = blocks
							.filter((b) => b?.type === "text")
							.map((b) => b.text ?? "")
							.join("\n");
						const thinkingChars = blocks
							.filter((b) => b?.type === "thinking")
							.reduce((n, b) => n + (b.thinking?.length ?? 0), 0);
						const toolCalls = blocks.filter((b) => b?.type === "toolCall");
						const usage = normUsage(m.usage);
						const ctxTok =
							usage && usage.input !== null && usage.cacheRead !== null && usage.cacheWrite !== null
								? usage.input + usage.cacheRead + usage.cacheWrite
								: null;
						const stop = mapStopReason(m.stopReason);
						const err = stop === "error" ? (m.errorMessage ?? "") : null;
						assistantById.set(e.id, m);
						if (stop === "error") {
							const prevAttempt = errorStreak.get(e.parentId) ?? 0;
							// parentId of a retried response is the context_edit; walk past it
							const pe = e.parentId ? entries.find((x) => x?.id === e.parentId) : null;
							const viaEdit = pe?.type === "context_edit" ? (errorStreak.get(pe.targetId) ?? 0) : 0;
							errorStreak.set(e.id, Math.max(prevAttempt, viaEdit) + 1);
						}
						push("assistant", e, {
							model,
							thinkingLevel: m.thinkingLevel ?? curThinking ?? null,
							usage,
							contextTokens: ctxTok,
							stopReason: stop,
							error: err === null ? null : excerpt(err, LIMIT.error),
							...(err === null ? {} : { errorChars: err.length }),
							...textField("text", text, LIMIT.assistant),
							thinkingChars,
							toolCallIds: toolCalls.map((b) => b.id),
						});
						for (const b of toolCalls) {
							const args = b.arguments ?? {};
							callArgs.set(b.id, { name: b.name, args });
							push("tool_call", e, { callId: b.id, name: b.name, args: truncateArgs(args), argsHash: argsHash(args) });
							if (b.name === "subagent") {
								push("delegation", e, {
									callId: b.id,
									mode:
										args.run_in_background === true || args.run_in_background === "true" ? "background" : "foreground",
									childRunId: callChild.get(b.id) ?? null,
									...textField("prompt", args.prompt ?? "", LIMIT.prompt),
									description: typeof args.description === "string" ? excerpt(args.description, LIMIT.note) : null,
									resultChars: null,
									resultRef: null,
								});
								delegByCall.set(b.id, lastEvent());
							} else if (b.name === "tmux_agent_spawn") {
								push("delegation", e, {
									callId: b.id,
									mode: "peer_spawn",
									childRunId: callChild.get(b.id) ?? null,
									prompt: null,
									promptChars: null,
									description: typeof args.name === "string" ? args.name : null,
									resultChars: null,
									resultRef: null,
								});
							} else if (b.name === "tmux_agent_send" || b.name === "tmux_agent_message") {
								const sc = b.name === "tmux_agent_send" ? spawnPane.get(args.id) : spawnNames.get(args.to);
								push("delegation", e, {
									callId: b.id,
									mode: "peer_message",
									childRunId: sc ? (callChild.get(sc) ?? null) : null,
									...textField("prompt", args.text ?? "", LIMIT.prompt),
									description: b.name === "tmux_agent_message" ? (args.to ?? null) : (args.id ?? null),
									resultChars: null,
									resultRef: null,
								});
							} else if (b.name === "tmux_agent_broadcast") {
								push("delegation", e, {
									callId: b.id,
									mode: "peer_message",
									childRunId: null,
									...textField("prompt", args.text ?? "", LIMIT.prompt),
									description: "broadcast",
									resultChars: null,
									resultRef: null,
								});
							} else if (b.name === "steer_subagent") {
								const aid = args.agent_id;
								let childRunId = null;
								for (const [cid, a] of subCallAgent)
									if (a === aid && callChild.has(cid)) childRunId = callChild.get(cid);
								push("note", e, {
									kind: "subagent_steer",
									data: {
										callId: b.id,
										agentId: aid ?? null,
										childRunId,
										messageChars: typeof args.message === "string" ? args.message.length : null,
									},
								});
							}
						}
						break;
					}
					case "toolResult": {
						const text = contentText(m.content);
						const call =
							callArgs.get(m.toolCallId) ??
							(calls.has(m.toolCallId)
								? { name: calls.get(m.toolCallId).name, args: calls.get(m.toolCallId).args }
								: null);
						const name = m.toolName ?? call?.name ?? null;
						let cls = null;
						if (m.isError) {
							const c = classifyError(name, text);
							cls = c.errorClass;
							if (c.feature === "skill-read-dedupe") dedupeBlocks.n++;
							if (c.feature === "conditional-instructions") ciEvidence.n++;
						}
						push("tool_result", e, {
							callId: m.toolCallId ?? null,
							name,
							isError: m.isError === true,
							errorClass: m.isError ? cls : null,
							...textField("output", text, LIMIT.output),
							durationMs: timing.get(m.toolCallId) ?? null,
							exitCode: name === "bash" ? bashExitCode(m.isError === true, text) : null,
							nestedUsage: normUsage(m.usage),
						});
						const resEv = lastEvent();
						const d = m.details ?? {};
						// delegation results
						if (name === "subagent" && delegByCall.has(m.toolCallId)) {
							const dg = delegByCall.get(m.toolCallId);
							if (d.status === "background" || d.status === "running") {
								const aid = d.agentId ?? subCallAgent.get(m.toolCallId);
								if (aid) {
									if (!delegPending.has(aid)) delegPending.set(aid, []);
									delegPending.get(aid).push(dg);
								}
							} else {
								setResult(dg, resEv, text.length, "tool_result");
							}
						} else if (
							name === "get_subagent_result" &&
							!m.isError &&
							d.agentId &&
							d.status &&
							d.status !== "running" &&
							d.status !== "queued"
						) {
							deliverAgent(d.agentId, resEv, text.length, "get_subagent_result");
						}
						// skill load via shell
						if (name === "bash" && !m.isError && typeof call?.args?.command === "string") {
							const sr = shellSkillReads(call.args.command, cwd);
							if (sr) {
								const single = sr.onlyReaders && sr.paths.length === 1;
								const complete = sr.plain && !d.truncation && !d.fullOutputPath;
								for (const abs of sr.paths) {
									const skill = skillByPath().get(abs) ?? path.basename(path.dirname(abs));
									push("skill_load", e, {
										skill,
										path: abs,
										via: "shell",
										callId: m.toolCallId ?? null,
										blocked: false,
										chars: single ? text.length : null,
										contentHash: complete ? contentHash(text) : null,
									});
								}
							}
						}
						// skill load via read
						if (name === "read" && call?.args && typeof call.args.path === "string") {
							const abs = resolveToolPath(call.args.path, cwd);
							if (abs && path.basename(abs) === "SKILL.md") {
								const blocked = m.isError === true && cls === "harness_policy";
								if (!m.isError || blocked) {
									const skill = skillByPath().get(abs) ?? path.basename(path.dirname(abs));
									// pi read returns the file as the first text block; conditional-instructions
									// appends its own block. Partial reads carry a continuation trailer.
									const first = Array.isArray(m.content)
										? (m.content.find((c) => c?.type === "text")?.text ?? null)
										: typeof m.content === "string"
											? m.content
											: null;
									const off = call.args.offset == null ? 1 : Number(call.args.offset);
									const partial =
										!(off <= 1) ||
										!!d.truncation ||
										(first !== null && first.startsWith("[Line ")) ||
										(first !== null && READ_TRUNC_TRAILER.test(first));
									const ok = !blocked && first !== null;
									push("skill_load", e, {
										skill,
										path: abs,
										via: "read",
										callId: m.toolCallId ?? null,
										blocked,
										chars: ok ? first.replace(READ_TRUNC_TRAILER, "").length : null,
										contentHash: ok && !partial ? contentHash(first) : null,
									});
								}
							}
							// conditional-instructions injection appended to read results
							if (!m.isError) {
								const idx = text.indexOf(CI_BLOCK_HEADER);
								if (idx >= 0) {
									ciEvidence.n++;
									const body = text.slice(idx + CI_BLOCK_HEADER.length);
									const parts = body.split(/^## Instructions from /m).slice(1);
									for (const part of parts) {
										const nl = part.indexOf("\n");
										const rel = (nl < 0 ? part : part.slice(0, nl)).trim();
										const src = cwd ? path.resolve(cwd, rel) : rel;
										push("instruction_load", e, {
											source: src,
											chars: part
												.slice(nl + 1)
												.replace(/^\n+/, "")
												.replace(/\n+$/, "").length,
											trigger: `read:${call.args.path}`,
										});
									}
								}
							}
						}
						break;
					}
					case "bashExecution": {
						push("note", e, {
							kind: "bash_execution",
							data: {
								command: excerpt(m.command ?? "", LIMIT.note),
								exitCode: m.exitCode ?? null,
								cancelled: m.cancelled ?? null,
								outputChars: (m.output ?? "").length,
								excludeFromContext: m.excludeFromContext === true,
							},
						});
						break;
					}
					case "branchSummary":
						push("context_reset", e, {
							kind: "branch_summary",
							tokensBefore: null,
							summaryChars: (m.summary ?? "").length,
							usage: null,
						});
						break;
					case "compactionSummary":
						push("context_reset", e, {
							kind: "compaction",
							tokensBefore: num(m.tokensBefore),
							summaryChars: (m.summary ?? "").length,
							usage: null,
						});
						break;
					default:
						push("note", e, { kind: "unknown_message_role", data: { role: m.role ?? null } });
				}
				break;
			}
			case "model_change": {
				curModel = e.provider && e.modelId ? `${e.provider}/${e.modelId}` : (e.modelId ?? null);
				push("model_change", e, { model: curModel, thinkingLevel: curThinking });
				break;
			}
			case "thinking_level_change": {
				curThinking = e.thinkingLevel ?? null;
				push("model_change", e, { model: curModel, thinkingLevel: curThinking });
				break;
			}
			case "compaction": {
				if (e.systemMessage && !isAbandonedId(e.id)) sys.apply({ ...e.systemMessage, replace: true });
				// usage: the model call that wrote the summary (counted in cost totals)
				push("context_reset", e, {
					kind: "compaction",
					tokensBefore: num(e.tokensBefore),
					summaryChars: typeof e.summary === "string" ? e.summary.length : null,
					usage: normUsage(e.usage),
				});
				break;
			}
			case "branch_summary": {
				push("context_reset", e, {
					kind: "branch_summary",
					tokensBefore: null,
					summaryChars: typeof e.summary === "string" ? e.summary.length : null,
					usage: normUsage(e.usage),
				});
				break;
			}
			case "context_edit": {
				const target = assistantById.get(e.targetId);
				if (!hasRetryCapture && target && target.stopReason === "error" && e.replacement === null) {
					push("retry", e, {
						reason: excerpt(target.errorMessage ?? "model call error", LIMIT.reason),
						attempt: errorStreak.get(e.targetId) ?? null,
					});
				} else {
					const rep = e.replacement;
					push("context_reset", e, {
						kind: "edit",
						tokensBefore: null,
						summaryChars: rep == null ? null : typeof rep === "string" ? rep.length : contentText(rep).length,
						usage: null,
					});
				}
				break;
			}
			case "usage": {
				push("note", e, {
					kind: "usage",
					data: { kind: e.kind ?? null, model: e.provider && e.model ? `${e.provider}/${e.model}` : null },
					usage: normUsage(e.usage),
				});
				break;
			}
			case "custom_message": {
				const txt = contentText(e.content);
				push("user", e, { ...textField("text", txt, LIMIT.user), origin: "harness" });
				if (e.customType === "subagent-notification") {
					const ev = lastEvent();
					const aid = e.details?.id ?? /<task-id>([^<]+)<\/task-id>/.exec(txt)?.[1] ?? null;
					const tid = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(txt)?.[1] ?? null;
					const truncated = txt.includes("...(truncated, use get_subagent_result for full output)");
					const pend = aid ? delegPending.get(aid) : null;
					if (pend) {
						if (!truncated) deliverAgent(aid, ev, txt.length, "notification");
						else for (const dg of pend) if (!delegPreview.has(dg)) delegPreview.set(dg, { ev, chars: txt.length });
					} else if (tid && delegByCall.has(tid) && delegByCall.get(tid).resultRef === null && !truncated) {
						setResult(delegByCall.get(tid), ev, txt.length, "notification");
					}
				}
				break;
			}
			case "custom": {
				const d = e.data ?? {};
				if (e.customType === "session-eval:retry")
					push("retry", e, { reason: excerpt(String(d.reason ?? "unknown"), LIMIT.reason), attempt: num(d.attempt) });
				else if (e.customType === "subagents:record" || e.customType?.startsWith("session-eval:")) {
					/* consumed as metadata */
				} else push("note", e, { kind: `custom:${e.customType ?? "unknown"}`, data: {} });
				break;
			}
			case "label": {
				push("note", e, {
					kind: "label",
					data: {
						targetId: e.targetId ?? null,
						label: typeof e.label === "string" ? excerpt(e.label, LIMIT.note) : null,
					},
				});
				break;
			}
			case "session_info":
				if (namedBeforeFirstUser === null && typeof e.name === "string")
					namedBeforeFirstUser = userCount === 0 ? e.name : false;
				break; // used for the run label
			default:
				push("note", e, { kind: "unknown_entry", data: { type: e.type ?? null } });
		}
	}
	if (!context && sys.seen) {
		context = sys.context();
		contextFromLate = firstAssistantIdx >= 0;
	}
	if (contextFromLate) notes.push("context taken from system messages recorded after the first response");
	if (!context) notes.push("no system message recorded; context unknown");

	// Background results that only arrived as a truncated notification preview.
	for (const [dg, p] of delegPreview) if (dg.resultRef === null) setResult(dg, p.ev, p.chars, "notification_preview");
	for (const ev of events)
		if (ev.type === "delegation" && ev.mode === "background" && ev.resultRef === null)
			env.stats.backgroundUndelivered++;

	// Skills invoked by /skill:name but not advertised in the system prompt.
	if (context && Array.isArray(context.skillsAvailable)) {
		const listed = new Set(context.skillsAvailable.map((s) => s.name));
		for (const [name, loc] of commandSkills) {
			if (listed.has(name)) continue;
			context.skillsAvailable.push({ name, path: loc, manualOnly: true, listed: false });
			env.stats.unlistedCommandSkills++;
		}
	}

	const named = job.kind === "primary" && typeof namedBeforeFirstUser === "string" && userCount > 0;
	if (agentDrivenFirst || orchestratorPrefixed > 0 || named) {
		env.stats.agentDrivenRoots++;
		const signals = [
			agentDrivenFirst ? "first message reads as a worker brief" : null,
			orchestratorPrefixed ? `${orchestratorPrefixed} message(s) prefixed 'Orchestrator:'` : null,
			named
				? `session named '${excerpt(namedBeforeFirstUser, 80)}' before the first user message, as 'pi --name' (used by tmux_agent_spawn) does; a human can do the same`
				: null,
		].filter(Boolean);
		notes.push(
			`user messages may be agent-driven (${signals.join("; ")}); origin kept 'human' because pi records no sender for injected or pasted user messages`,
		);
	}

	// harness features
	let harnessFeatures = [];
	if (features && Array.isArray(features.extensions)) {
		harnessFeatures = features.extensions
			.filter((x) => typeof x === "string")
			.map((x) => (x.startsWith("extension:") ? x : `extension:${x}`));
		if (features.piVersion) env.piVersions.add(String(features.piVersion));
	} else {
		env.stats.runsWithoutFeatures++;
		if (dedupeBlocks.n > 0) {
			harnessFeatures.push("extension:skill-read-dedupe");
			notes.push("extension:skill-read-dedupe inferred from blocked results");
		}
		if (ciEvidence.n > 0) {
			harnessFeatures.push("extension:conditional-instructions");
			notes.push("extension:conditional-instructions inferred from injected instructions or edit blocks");
		}
	}
	if (timing.size === 0 && events.some((x) => x.type === "tool_result")) env.stats.runsWithoutTiming++;

	// The fork note carries the fork time, not an event of this run.
	const tsList = events
		.filter((x) => !(x.type === "note" && x.kind === "fork"))
		.map((x) => x.ts)
		.filter(Boolean);
	const run = {
		id: job.runId,
		parentId: job.parentId,
		rootId: job.rootId,
		kind: job.kind,
		label: sessionName ?? job.labelHint ?? null,
		agentType: job.agentTypeHint ?? null,
		link: job.link,
		source: { path: job.file, sessionId: header?.id ?? null },
		cwd,
		startedAt: tsList[0] ?? isoOrNull(header?.timestamp),
		endedAt: tsList[tsList.length - 1] ?? isoOrNull(header?.timestamp),
		models: [...models],
		context: context ?? { instructions: null, skillsAvailable: null, toolsAvailable: null, systemPromptChars: null },
		harnessFeatures,
		notes,
	};
	linkStats.subagentCalls = [...calls.values()].filter((c) => c.name === "subagent").length;
	return { run, events, childJobs, linkStats };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function describeSelection(opts) {
	if (opts.selectionDescription) return opts.selectionDescription;
	const p = [];
	for (const s of opts.sessions ?? []) p.push(`--session ${s}`);
	if (opts.cwd) p.push(`--cwd ${opts.cwd}`);
	if (opts.since) p.push(`--since ${opts.since}`);
	if (opts.until) p.push(`--until ${opts.until}`);
	if (opts.name) p.push(`--name ${opts.name}`);
	if (opts.latest) p.push(`--latest ${opts.latest}`);
	for (const x of opts.excludeSessionIds ?? []) p.push(`--exclude-session ${x}`);
	if (opts.includeChildren === false) p.push("--no-children");
	if (opts.sessionsRoot) p.push(`--sessions-root ${opts.sessionsRoot}`);
	return p.length ? p.join(" ") : "all root sessions";
}

// Fixed notes on how pi records map to the bundle. They hold for every export.
const CAVEATS = [
	"skillsAvailable[].manualOnly is false for skills listed in the system prompt (pi lists only model-invocable skills) and true for unlisted skills seen via /skill:name; manual-only skills never invoked are not reported",
	"steer_subagent calls are emitted as note events (kind subagent_steer), not delegation events",
	"context reflects active-branch system messages recorded before the first assistant response; later system prompt changes are note events (kind system_update)",
	"assistant.thinkingLevel falls back to the latest thinking_level_change entry when the message does not record it",
	"peer-run user messages are origin 'parent' only when they exactly match a parent tmux_agent_send/message text; otherwise 'human'",
	"user origin 'command' covers /skill:name expansions only; prompt-template expansions leave no marker in pi sessions and stay 'human'",
	"tool_result.exitCode for bash: 0 when isError is false (pi's bash tool fails every non-zero exit), N from the trailing 'Command exited with code N', null for timeouts, aborts and other failures; other tools null",
	"skill_load.contentHash is null for partial, truncated, multi-file or non-'cat' loads; skill_load.chars is the delivered text length (null when blocked or ambiguous)",
	"delegation.resultChars/resultRef: foreground from the subagent tool_result; background from the first get_subagent_result with a final status or an untruncated subagent-notification (resultVia 'notification_preview' marks a truncated preview as the only delivery); peer delegations null",
	"context_reset.usage holds the model usage of compaction and branch summaries; note events of kind usage carry other usage-only records in note.usage",
	"delegation.prompt and promptChars are null for peer_spawn, because tmux_agent_spawn takes no prompt",
];

/** "absent", "empty" or "bundle". Throws when outDir holds anything else. */
async function outDirState(bundleDir) {
	let st;
	try {
		st = await fsp.stat(bundleDir);
	} catch (err) {
		if (err?.code === "ENOENT") return "absent";
		throw err;
	}
	if (!st.isDirectory()) throw new Error(`outDir exists and is not a directory: ${bundleDir}`);
	const names = await fsp.readdir(bundleDir);
	if (names.length === 0) return "empty";
	if (
		names.includes("manifest.json") &&
		names.every((n) => n === "manifest.json" || n === "runs") &&
		(await runsHoldOnlyRunFiles(bundleDir))
	)
		return "bundle";
	throw new Error(
		`outDir is not empty and is not a previous bundle (manifest.json and runs/*.jsonl only): ${bundleDir}`,
	);
}

/** True when `<bundleDir>/runs` is absent or holds only .jsonl files, so replacing it loses nothing else. */
async function runsHoldOnlyRunFiles(bundleDir) {
	const runsDir = path.join(bundleDir, "runs");
	let entries;
	try {
		entries = await fsp.readdir(runsDir, { withFileTypes: true });
	} catch (err) {
		if (err?.code === "ENOENT") return true;
		throw err;
	}
	return entries.every((e) => e.isFile() && e.name.endsWith(".jsonl"));
}

/** Moves the finished bundle into place. The previous bundle is kept until the move succeeds. */
async function installBundle({ tmpDir, bundleDir }) {
	if ((await outDirState(bundleDir)) === "absent") {
		await fsp.rename(tmpDir, bundleDir);
		return;
	}
	const oldDir = `${tmpDir}.old`;
	await fsp.rename(bundleDir, oldDir);
	try {
		await fsp.rename(tmpDir, bundleDir);
	} catch (err) {
		await fsp.rename(oldDir, bundleDir);
		throw err;
	}
	await fsp.rm(oldDir, { recursive: true, force: true });
}

export async function exportBundle(opts = {}) {
	if (!opts.outDir) throw new Error("exportBundle: outDir is required");
	const sel = parseSelectionOptions(opts);
	const bundleDir = path.resolve(expandHome(opts.outDir));
	await outDirState(bundleDir);

	const index = new SessionIndex(sel.sessionsRoot);
	const selected = await selectSessionsDetailed({ sel, index });
	await fsp.mkdir(path.dirname(bundleDir), { recursive: true });
	const tmpDir = await fsp.mkdtemp(path.join(path.dirname(bundleDir), `.${path.basename(bundleDir)}.tmp-`));
	try {
		const result = await writeBundle({ opts, sel, selected, index, dir: tmpDir });
		await installBundle({ tmpDir, bundleDir });
		return { bundleDir, ...result };
	} catch (err) {
		await fsp.rm(tmpDir, { recursive: true, force: true });
		throw err;
	}
}

async function writeBundle({ opts, sel, selected, index, dir }) {
	const includeChildren = opts.includeChildren !== false;
	const runsDir = path.join(dir, "runs");
	await fsp.mkdir(runsDir);
	const roots = selected.files;
	const warningSet = new Set();
	const warn = (w) => warningSet.add(w);
	for (const f of selected.badIds) warn(`skipped session with an id that is not a safe run id: ${f}`);
	const env = {
		includeChildren,
		exclude: sel.exclude,
		claimed: new Set(),
		pendingRoots: new Set(),
		index,
		fileById: new Map(),
		entryIds: new Map(),
		piVersions: new Set(),
		warn,
		stats: {
			runsWithoutFeatures: 0,
			runsWithoutTiming: 0,
			subagentCallsUnlinked: 0,
			peerSpawnUnmatched: 0,
			backgroundUndelivered: 0,
			unlistedCommandSkills: 0,
			agentDrivenRoots: 0,
			forkedRuns: 0,
			forkSourceMissing: 0,
			abandonedChildRuns: 0,
			danglingParentRuns: 0,
		},
	};

	const rootHeaders = [];
	for (const f of roots) {
		const h = await readHeader(f);
		if (!h) {
			warn(`skipped file without session header: ${f}`);
			continue;
		}
		if (env.pendingRoots.has(h.id)) continue;
		env.pendingRoots.add(h.id);
		rootHeaders.push({ f, h });
	}

	const manifestRuns = [];
	const totals = {
		tasksFiles: 0,
		linked: 0,
		callExplicit: 0,
		callInferred: 0,
		callUnknown: 0,
		peersExplicit: 0,
		peersInferred: 0,
		subagentCalls: 0,
	};
	let rootCount = 0;

	const processJob = async (job) => {
		const { run, events, childJobs, linkStats } = await convertRun(job, env);
		for (const k of Object.keys(totals)) totals[k] += linkStats[k] ?? 0;
		const out = events.map((ev) => JSON.stringify(ev)).join("\n") + (events.length ? "\n" : "");
		await fsp.writeFile(path.join(runsDir, `${run.id}.jsonl`), out, "utf8");
		manifestRuns.push(run);
		for (const cj of childJobs) await processJob(cj);
	};

	for (const { f, h } of rootHeaders) {
		if (!env.pendingRoots.has(h.id)) continue; // claimed as a peer child of an earlier root
		env.pendingRoots.delete(h.id);
		if (env.claimed.has(h.id)) continue;
		env.claimed.add(h.id);
		rootCount++;
		await processJob({
			file: path.resolve(f),
			runId: h.id,
			parentId: null,
			rootId: h.id,
			kind: "primary",
			link: null,
			labelHint: null,
			agentTypeHint: null,
			parentSendTexts: null,
			abandoned: false,
		});
	}

	const s = env.stats;
	if (s.runsWithoutTiming > 0)
		warn(
			`${s.runsWithoutTiming} run(s) with tool results have no session-eval:timing capture; their tool_result.durationMs is null`,
		);
	if (s.runsWithoutFeatures > 0)
		warn(
			`${s.runsWithoutFeatures} run(s) have no session-eval:features capture; harnessFeatures is empty or inferred from evidence`,
		);
	if (env.piVersions.size === 0) warn("harnessVersion unknown: no session-eval:features capture with piVersion");
	if (env.piVersions.size > 1) warn(`multiple pi versions captured: ${[...env.piVersions].join(", ")}`);
	if (!includeChildren) warn("children not included (--no-children); delegation.childRunId is null");
	if (totals.callInferred > 0)
		warn(
			`${totals.callInferred} subagent link(s) have parentCallId inferred by matching the child's first user message to the subagent prompt`,
		);
	if (totals.callUnknown > 0)
		warn(`${totals.callUnknown} subagent run(s) are linked by header/tasks dir only; spawning call unknown`);
	if (s.subagentCallsUnlinked > 0)
		warn(`${s.subagentCallsUnlinked} subagent tool call(s) have no child run in the bundle`);
	if (totals.peersInferred > 0)
		warn(`${totals.peersInferred} tmux peer link(s) inferred by session name, cwd and start time`);
	if (s.peerSpawnUnmatched > 0) warn(`${s.peerSpawnUnmatched} tmux_agent_spawn call(s) had no matching peer session`);
	if (s.backgroundUndelivered > 0)
		warn(
			`${s.backgroundUndelivered} background delegation(s) never had a result delivered in the parent session (resultChars null)`,
		);
	if (s.unlistedCommandSkills > 0)
		warn(`${s.unlistedCommandSkills} skillsAvailable entr(y/ies) added from /skill:name expansions with listed:false`);
	if (s.agentDrivenRoots > 0)
		warn(
			`${s.agentDrivenRoots} root run(s) may be orchestrator-driven (worker brief, 'Orchestrator:' prefixes, or named at launch) but have no recorded sender; their user messages stay origin 'human' (see run notes)`,
		);
	if (s.forkedRuns > 0)
		warn(
			`${s.forkedRuns} run(s) are forks or clones; entries copied from the source session are not emitted (see the note event of kind fork)`,
		);
	if (s.forkSourceMissing > 0)
		warn(
			`${s.forkSourceMissing} run(s) name a parent session that was not found; entries copied from it may be counted twice`,
		);
	if (s.abandonedChildRuns > 0)
		warn(
			`${s.abandonedChildRuns} child run(s) were started from an abandoned branch; all their events are marked abandoned`,
		);
	if (s.danglingParentRuns > 0)
		warn(
			`${s.danglingParentRuns} run(s) have parentId references to missing entries; their active path was repaired by file order (see run notes)`,
		);

	const warnings = [...warningSet];
	const manifest = {
		schemaVersion: 1,
		generatedAt: new Date().toISOString(),
		source: {
			harness: "pi",
			harnessVersion: env.piVersions.size === 1 ? [...env.piVersions][0] : null,
			adapter: ADAPTER_NAME,
			adapterVersion: ADAPTER_VERSION,
		},
		selection: {
			description: describeSelection(opts),
			scanned: selected.scanned,
			selected: roots.length,
			excluded: selected.scanned - roots.length,
			unit: "root session files",
		},
		warnings: [...warnings, ...CAVEATS],
		runs: manifestRuns,
	};
	await fsp.writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
	return { runCount: manifestRuns.length, rootCount, warnings, caveats: [...CAVEATS], linkStats: totals };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseCli(argv) {
	const o = { sessions: [], excludeSessionIds: [] };
	const need = (i, f) => {
		if (i + 1 >= argv.length) throw new Error(`${f} needs a value`);
		return argv[i + 1];
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		switch (a) {
			case "--out":
				o.outDir = need(i, a);
				i++;
				break;
			case "--session":
				o.sessions.push(need(i, a));
				i++;
				break;
			case "--cwd":
				o.cwd = need(i, a);
				i++;
				break;
			case "--since":
				o.since = need(i, a);
				i++;
				break;
			case "--until":
				o.until = need(i, a);
				i++;
				break;
			case "--name":
				o.name = need(i, a);
				i++;
				break;
			case "--latest":
				o.latest = need(i, a);
				i++;
				break;
			case "--exclude-session":
				o.excludeSessionIds.push(need(i, a));
				i++;
				break;
			case "--no-children":
				o.includeChildren = false;
				break;
			case "--sessions-root":
				o.sessionsRoot = need(i, a);
				i++;
				break;
			case "--description":
				o.selectionDescription = need(i, a);
				i++;
				break;
			case "-h":
			case "--help":
				o.help = true;
				break;
			default:
				throw new Error(`Unknown argument: ${a}`);
		}
	}
	return o;
}

const USAGE =
	"Usage: node adapter.mjs --out DIR [--session PATH]... [--cwd DIR] [--since ISO] [--until ISO] [--name REGEX] [--latest N] [--exclude-session ID]... [--no-children] [--sessions-root DIR] [--description TEXT]";

async function main() {
	let o;
	try {
		o = parseCli(process.argv.slice(2));
	} catch (err) {
		console.error(String(err.message));
		console.error(USAGE);
		process.exit(2);
	}
	if (o.help) {
		console.log(USAGE);
		return;
	}
	if (!o.outDir) {
		console.error(USAGE);
		process.exit(2);
	}
	const r = await exportBundle(o);
	console.log(
		JSON.stringify(
			{
				bundleDir: r.bundleDir,
				runCount: r.runCount,
				rootCount: r.rootCount,
				warningCount: r.warnings.length,
				caveatCount: r.caveats.length,
				linkStats: r.linkStats,
			},
			null,
			2,
		),
	);
}

const invokedDirectly = (() => {
	try {
		return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
	} catch {
		return false;
	}
})();
if (invokedDirectly) {
	main().catch((err) => {
		console.error(err?.stack ?? String(err));
		process.exit(1);
	});
}
