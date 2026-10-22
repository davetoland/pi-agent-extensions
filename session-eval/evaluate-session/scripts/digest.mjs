#!/usr/bin/env node
// digest.mjs: deterministic digest of a trace bundle (schema version 1).
// Reads only the bundle contract in references/trace-bundle.md. Node >= 22, ESM, no dependencies.
//
//   node digest.mjs analyse <bundleDir> --out <dir> [--config thresholds.json] [--cutover ISO[,ISO…]]
//   node digest.mjs show <bundleDir> <runId> [fromSeq] [toSeq] [--full]
//   node digest.mjs runs <bundleDir> [--config thresholds.json]
//   node digest.mjs flags <bundleDir> [--type T] [--tree ID] [--run ID] [--limit N] [--out dir] [--config f]
//   node digest.mjs context <bundleDir> [--tree ID] [--out dir] [--config f]

import fs from "node:fs";
import readline from "node:readline";
import path from "node:path";

// ---------------------------------------------------------------------------
// Configuration. Every key can be overridden with --config <file.json>.
// Arrays replace the default array; they are not merged.
// ---------------------------------------------------------------------------
export const DEFAULTS = {
	idleGapMs: 600000, // idle_gap threshold; gaps below it count as active time
	slowToolMs: 120000,
	contextPressureTokens: 150000,
	largeOutputChars: 20000,
	repeatedCallMin: 2,
	repeatedReadMin: 3,
	editChurnMin: 5,
	errorThenSameWindow: 3,
	errorStreakMin: 3,
	loopMinRepeats: 3,
	loopMaxLen: 4,
	loopNameOnlyMinLen: 2,
	loopNameOnlyMaxLen: 4,
	loopNameOnlyMinRepeats: 4,
	parentHeavyIoChars: 200000,
	crystalliseMinTrees: 3,
	// Generic shell primitives are hidden from crystallisation candidates unless used this often per tree.
	crystallisePrimitiveMinCallsPerTree: 25,
	crystallisePrimitivePattern:
		"^(for \\S+ in|while |cat|ls|pwd|echo|printf|head|tail|grep|rg|wc|cd|mkdir|true|sleep|date|stat|sort|nl|sed -n|python3? -( |$)|python3? <str>|python3? -c|node -e|node -)",
	cohortMinTrees: 3,
	cutovers: [], // ISO timestamps; trees are split into time cohorts at each one (also --cutover)
	maxRefsPerFlag: 20,
	charsPerToken: 4, // impact estimates: tokens ≈ chars / charsPerToken
	topLeads: 25,
	readToolPattern: "^(read|read_?file|view|view_?file|open_?file|get_?file(_?contents?)?)$",
	editToolPattern:
		"^(edit|multi_?edit|write|write_?file|create_?file|str_replace(_editor|_based_edit_tool)?|apply_?patch|replace(_in_file)?|insert|notebook_?edit)$",
	pathArgKeys: ["path", "file_path", "filePath", "file"],
	commandArgKeys: ["command", "cmd", "script"],
	riskyArgKeys: ["command", "cmd", "script", "query", "sql"],
	contentArgKeys: ["content", "text", "newText", "new_string", "file_text"],
	rangeArgKeys: ["offset", "limit", "start_line", "end_line", "startLine", "endLine", "view_range", "line", "lines"],
	searchToolPattern:
		"^(grep|rg|ripgrep|find|glob|ls|list_?dir(ectory)?|list_?files|search(_?files)?|file_?search|codebase_?search)$",
	// Tools that fetch the result of an earlier (background) delegation.
	delegationResultToolPattern:
		"(^|_)(agent|subagent|task)_?(result|output)s?$|^(get|wait|await|read)_(subagent|agent|task)",
	shellReadVerbs: ["cat", "head", "tail", "less", "more", "bat", "nl", "sed", "awk", "type"],
	shellSearchVerbs: ["grep", "egrep", "rg", "ag", "find", "fd", "ls", "tree", "locate", "git grep", "git ls-files"],
	docPathPattern: "\\.(md|mdx|markdown|rst|adoc|txt)$",
	// Shell segments skipped when choosing the command a shape describes.
	shapeSkipVerbs: [
		"cd",
		"set",
		"mkdir",
		"export",
		"source",
		".",
		"trap",
		"umask",
		"shopt",
		"unset",
		"pushd",
		"popd",
		"true",
		":",
		"local",
		"declare",
	],
	// Messages recorded with origin human that are really agent- or harness-originated.
	agentMessagePatterns: [
		"^\\s*<[a-z][\\w-]*[\\s>]",
		"^\\s*(orchestrator|supervisor|coordinator|parent agent)\\b[^\\n]{0,100}[:—-]",
		"^\\s*you have reached your turn limit",
	],
	// rm -rf and similar deletes whose every target matches this are downgraded to low severity.
	scratchPathPattern:
		"^(/tmp|/var/tmp|/dev/shm|\\$\\{?(TMPDIR|TMP|TEMP|tmp|tmpdir|TMP_DIR|scratch|work(dir)?)\\b)|(^|/)([\\w.-]*[-_.])?(tmp|temp|scratch|drafts?)(/|$)|(^|/)(\\.cache|node_modules|bin|obj|dist|build|out|coverage|__pycache__|\\.pytest_cache)(/|$)|^[\\w.-]*(tmp|temp|scratch|draft)[\\w.-]*/?$",
	// Tools that block until something else finishes (waiting for a background job or agent) are not "slow tools".
	slowToolExcludePattern: "(^|_)(wait|await|poll|sleep|join)(_|$)|_result$",
	parentHeavyIoKinds: ["primary", "peer"],
	// Setup, credential and syntax probes. Routine CRUD (`<cli> … show/list/update` on work items, PRs, …) is
	// deliberately not matched. `kind` is one of syntax | setup | credential | environment.
	discoveryPatterns: [
		{ id: "help", kind: "syntax", pattern: "(^|\\s)--help(\\s|$)|^\\s*\\S+(\\s+[a-z][\\w-]*)*\\s+-h\\s*$" },
		{ id: "man", kind: "syntax", pattern: "(^|[;&|(]\\s*)man\\s+\\S" },
		{ id: "which", kind: "setup", pattern: "(^|[;&|(]\\s*)(which|whereis|type)\\s+\\S" },
		{ id: "command-v", kind: "setup", pattern: "\\bcommand\\s+-v\\b" },
		{
			id: "version-probe",
			kind: "setup",
			pattern:
				"\\b(dotnet|node|npm|pnpm|yarn|python3?|pip3?|az|gh|git|kubectl|docker|go|cargo|java|mvn)\\s+(--version|-v|version)(\\s|$)",
		},
		{
			id: "cli-config-list",
			kind: "setup",
			pattern: "\\b(configure|config)\\s+(--list|-l|list|get|--get|show)\\b|\\bextension\\s+(list|show)\\b",
		},
		{ id: "git-remote-v", kind: "setup", pattern: "\\bgit\\s+remote\\s+(-v|get-url|show)\\b" },
		{
			id: "git-config-get",
			kind: "setup",
			pattern: "\\bgit\\s+config\\s+(--list|-l|--get|--get-all|--global\\s+--list)\\b",
		},
		{
			id: "auth-status",
			kind: "credential",
			pattern: "\\b(auth|login)\\s+(status|show|whoami|list)\\b|\\bauth\\s+token\\b",
		},
		{ id: "account-show", kind: "credential", pattern: "\\baccount\\s+(show|list|get-access-token)\\b" },
		{ id: "whoami", kind: "credential", pattern: "\\bwhoami\\b" },
		{ id: "printenv", kind: "credential", pattern: "\\bprintenv\\b" },
		{ id: "env-dump", kind: "credential", pattern: "(^|[;&|(]\\s*)(env|set)\\s*(\\||$)" },
		{
			id: "cat-secret-config",
			kind: "credential",
			pattern:
				"\\b(cat|less|more|head|tail|bat)\\s+[^|;&]*(\\.env\\b|credential|token|secret|\\.npmrc|\\.netrc|\\.pypirc|\\.git-credentials|\\.azure/|\\.ssh/|\\.kube/config|config(\\.json|\\.ya?ml|\\.toml|\\.ini)?(\\s|$))",
		},
		{ id: "find-root", kind: "environment", pattern: "\\bfind\\s+(/|~|\\$HOME)(\\s|$)" },
		{
			id: "ls-home-config",
			kind: "environment",
			pattern:
				"\\bls\\b[^|]*\\s((~|\\$HOME|/root|/home/[^\\s/]+)(/\\.[^\\s]*)?/?|/etc(/[^\\s]*)?|\\S*/\\.config(/[^\\s]*)?)(\\s|$)",
		},
	],
	riskyPatterns: [
		{
			id: "rm-rf",
			pattern:
				"\\brm\\s+(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*|-r\\s+-f|-f\\s+-r|--recursive\\s+--force|--force\\s+--recursive)\\b",
		},
		{ id: "git-push-force", pattern: "\\bgit\\s+push\\b[^;&|]*\\s(--force(-with-lease)?|-f)(\\s|$)" },
		{ id: "git-reset-hard", pattern: "\\bgit\\s+reset\\s+[^;&|]*--hard\\b" },
		{ id: "git-clean-f", pattern: "\\bgit\\s+clean\\s+-[a-zA-Z]*f" },
		{ id: "drop-table-db", pattern: "\\bdrop\\s+(table|database)\\b" },
		{ id: "az-delete", pattern: "\\baz\\s+([\\w-]+\\s+)*(?<![-\\w])delete(?![-\\w=])" },
		{ id: "kubectl-delete", pattern: "\\bkubectl\\s+([\\w-]+\\s+)*(?<![-\\w])delete(?![-\\w=])" },
		{ id: "chmod-777-r", pattern: "\\bchmod\\s+-R\\s+777\\b" },
	],
	verifyCommandPatterns: [
		"\\bdotnet\\s+(test|build)\\b",
		"\\b(npm|pnpm|yarn)\\s+(run\\s+)?(test|build|lint|typecheck|check)\\b",
		"\\bnpx\\s+(vitest|jest|tsc|eslint|playwright)\\b",
		"\\b(vitest|jest|pytest|tsc|eslint|ruff|mypy)\\b",
		"\\bnode\\s+--test\\b",
		"\\bgo\\s+(test|build|vet)\\b",
		"\\bcargo\\s+(test|build|check|clippy)\\b",
		"\\bmvn\\b",
		"\\bgradlew?\\b",
		"\\bmake\\s+(test|check|build|lint)\\b",
		"\\bgit\\s+diff\\b[^|;&]*--check\\b",
		"\\bpython3?\\s+-m\\s+(pytest|unittest|json\\.tool|py_compile|mypy|ruff)\\b",
		"\\b(node|deno|bun)\\s+--check\\b",
		"\\b(bash|sh|zsh)\\s+-n\\b",
		"\\b(shellcheck|markdownlint(-cli2?)?|xmllint|yamllint|hadolint|prettier\\s+--check|jq\\s+(-e\\s+)?empty)\\b",
		"\\bdotnet\\s+format\\b[^|;&]*--verify-no-changes",
		// validator scripts and test wrappers: run-tests.sh, scripts/validate.py, check-links.mjs, test-foo.mjs, …
		"^\\s*((sudo|time|env)\\s+)?((bash|sh|zsh|node|python3?|pwsh|bun|deno\\s+run|npx\\s+tsx|tsx|ruby)\\s+(-\\S+\\s+)*)?[\\w./~-]*?(test|tests|check|checks|validate|validator|verify|lint)[\\w.-]*\\.(sh|py|mjs|cjs|js|ts|ps1|rb)\\b",
		"\\b(npm|pnpm|yarn)\\s+(run\\s+)?[\\w:-]*(test|check|validate|verify|lint)[\\w:-]*\\b",
	],
	// Final replies with these caveats are not treated as unbacked verification claims.
	notVerifiedPatterns: [
		"\\b(not|never|n't)\\s+(been\\s+|yet\\s+)?(verified|tested|run|executed|built|validated|checked)\\b",
		"\\b(unverified|untested|unvalidated)\\b",
		"\\b(did\\s+not|didn't|could\\s+not|couldn't|cannot|can't|unable\\s+to|was\\s+not\\s+able\\s+to)\\s+(run|test|verify|build|execute|validate)\\b",
		"\\bwithout\\s+(running|testing|verifying|building)\\b",
		"\\bno\\s+(tests?|builds?|checks?)\\s+(were\\s+|was\\s+)?(run|executed)\\b",
	],
	verifyClaimPatterns: [
		"\\b(all\\s+)?tests?\\s+(now\\s+)?(all\\s+)?pass(es|ed|ing)?\\b",
		"\\ball\\s+tests\\b",
		"\\bbuild\\s+(now\\s+)?(succeeded|succeeds|passes|passed|is\\s+green|successful)\\b",
		"(?<!not\\s|un)\\bverified\\b",
		"\\blint(ing)?\\s+(now\\s+)?(passes|passed|is\\s+clean|clean)\\b",
		"\\bchecks?\\s+(all\\s+)?pass(es|ed)?\\b",
	],
	correctionPatterns: [
		"^\\s*(no|nope|stop|wrong|undo|revert)\\b",
		"\\b(don'?t|do\\s+not|that'?s\\s+not|that\\s+is\\s+not|i\\s+said|i\\s+told\\s+you|instead|why\\s+did\\s+you|undo|revert|again|stop|wrong)\\b",
	],
};

const SEV = { high: 3, med: 2, low: 1 };
const USAGE_KEYS = ["input", "output", "cacheRead", "cacheWrite", "reasoning", "cost"];
const FLAG_TYPES = [
	"repeated_call",
	"repeated_read",
	"edit_churn",
	"error_then_same_call",
	"error_streak",
	"loop",
	"loop_name_only",
	"large_output",
	"discovery",
	"user_correction",
	"model_error",
	"retry",
	"context_reset",
	"idle_gap",
	"slow_tool",
	"context_pressure",
	"unbacked_claim",
	"risky_command",
	"delegation_unlinked",
	"parent_rereads_child_files",
	"parent_heavy_io",
	"skill_reloaded",
	"skill_blocked",
	"user_abort",
];
const HEURISTIC_TYPES = new Set(["user_correction", "unbacked_claim", "discovery", "loop_name_only"]);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const num = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);
const tsMs = (ts) => {
	if (typeof ts !== "string") return null;
	const t = Date.parse(ts);
	return Number.isNaN(t) ? null : t;
};
const zeroUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0 });
const addInto = (a, b) => {
	for (const k of USAGE_KEYS) a[k] += b[k] || 0;
	return a;
};
const inc = (o, k, n = 1) => {
	o[k] = (o[k] || 0) + n;
};
const round = (x, d = 4) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sortObj = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => cmpStr(a[0], b[0])));
const median = (xs) => {
	const v = xs.filter((x) => x != null).sort((a, b) => a - b);
	if (!v.length) return null;
	const m = v.length >> 1;
	return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const oneLine = (s) =>
	String(s ?? "")
		.replace(/\r?\n/g, "⏎")
		.replace(/\s+/g, " ");
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const cacheHit = (u) => {
	const d = u.input + u.cacheRead + u.cacheWrite;
	return d > 0 ? round(u.cacheRead / d, 4) : null;
};
const fmtCost = (c) => (c == null ? "-" : c.toFixed(4));
const fmtMs = (ms) => {
	if (ms == null) return "-";
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
};
const fmtK = (n) =>
	n == null ? "-" : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
const mdCell = (s) =>
	String(s ?? "-")
		.replace(/\|/g, "\\|")
		.replace(/\r?\n/g, " ");

function compileConfig(cfg) {
	const re = (p) => new RegExp(p, "i");
	return {
		read: re(cfg.readToolPattern),
		edit: re(cfg.editToolPattern),
		slowExclude: cfg.slowToolExcludePattern ? re(cfg.slowToolExcludePattern) : null,
		discovery: cfg.discoveryPatterns.map((d) => ({ id: d.id, kind: d.kind ?? "other", re: re(d.pattern) })),
		search: re(cfg.searchToolPattern),
		delegResult: cfg.delegationResultToolPattern ? re(cfg.delegationResultToolPattern) : null,
		doc: re(cfg.docPathPattern),
		notVerified: cfg.notVerifiedPatterns.map(re),
		agentMsg: cfg.agentMessagePatterns.map(re),
		scratch: new RegExp(cfg.scratchPathPattern),
		primitive: re(cfg.crystallisePrimitivePattern),
		readVerbs: new Set(cfg.shellReadVerbs),
		searchVerbs: new Set(cfg.shellSearchVerbs),
		skipVerbs: new Set(cfg.shapeSkipVerbs),
		risky: cfg.riskyPatterns.map((d) => ({ id: d.id, re: re(d.pattern) })),
		verifyCmd: cfg.verifyCommandPatterns.map(re),
		verifyClaim: cfg.verifyClaimPatterns.map(re),
		correction: cfg.correctionPatterns.map(re),
	};
}

function loadConfig(file) {
	const cfg = structuredClone(DEFAULTS);
	if (file) {
		const over = JSON.parse(fs.readFileSync(file, "utf8"));
		for (const [k, v] of Object.entries(over)) {
			if (!(k in DEFAULTS)) throw new Error(`unknown config key: ${k}`);
			cfg[k] = v;
		}
	}
	return cfg;
}

function argString(args, keys) {
	if (!args || typeof args !== "object") return null;
	for (const k of keys) if (typeof args[k] === "string" && args[k].length) return args[k];
	return null;
}

function normPath(p, cwd) {
	if (!p) return null;
	let s = p.trim();
	if (!s) return null;
	if (cwd && !s.startsWith("/") && !s.startsWith("~") && !/^[a-zA-Z]:[\\/]/.test(s)) s = path.posix.join(cwd, s);
	return path.posix.normalize(s);
}

// Strip shell prefixes (sudo, env assignments, export, control keywords) from a token list.
function stripPrefixes(toks) {
	for (;;) {
		const n = toks.length;
		while (
			toks.length &&
			(/^(sudo|time|nohup|exec|export|do|then|else|if|while|until|!|\{|\()$/.test(toks[0]) ||
				(toks[0] === "env" && /^[A-Za-z_][A-Za-z0-9_]*=|^-/.test(toks[1] ?? "")))
		) {
			toks.shift();
			while (toks.length > 1 && toks[0].startsWith("-")) toks.shift();
		}
		while (toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[0])) toks.shift();
		if (toks.length === n) break;
	}
	return toks;
}
const verbOf = (t) => (t && t.includes("/") ? t.split("/").filter(Boolean).pop() || t : t);
const DEFAULT_SKIP = new Set(DEFAULTS.shapeSkipVerbs);

// Normalised shell command shape: first 3 tokens of the first substantive simple command after skipping
// setup segments (cd, set, mkdir, export, source, …), env assignments and prefixes, with quoted strings,
// paths, ids, numbers and values masked. Falls back to the first setup segment when nothing else runs.
export function commandShape(cmd, skip = DEFAULT_SKIP) {
	let fallback = null;
	for (const seg of commandSegments(cmd)) {
		let toks = stripPrefixes(seg.split("|")[0].trim().split(/\s+/).filter(Boolean));
		const cut = toks.findIndex((t) => t !== "<str>" && /^(\d*[<>]|&>)/.test(t));
		if (cut >= 0) toks = toks.slice(0, cut);
		if (!toks.length || toks[0] === "<str>") continue;
		const shape = [verbOf(toks[0]), ...toks.slice(1, 3).map(normTok)].join(" ");
		if (skip.has(toks[0]) || toks[0] === "cd") {
			fallback ??= toks[0] === "cd" ? null : shape;
			continue;
		}
		return shape;
	}
	return fallback ?? "<empty>";
}
function stripHeredocs(cmd) {
	const lines = String(cmd ?? "").split("\n");
	const kept = [];
	for (let i = 0; i < lines.length; i++) {
		kept.push(lines[i]);
		const h = lines[i].match(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/);
		if (h) {
			while (i + 1 < lines.length && lines[i + 1].trim() !== h[1]) i++;
			i++;
		}
	}
	return kept.join("\n");
}
// Split a shell command into simple commands (pipelines kept together) with heredoc bodies removed.
// `text` has quoted strings masked as <str>, so patterns do not match inside embedded scripts or prose;
// `words` are the words before the first pipe with quotes removed (for path extraction).
export function shellSegments(cmd) {
	const strs = [];
	const masked = stripHeredocs(cmd).replace(/'[^'\n]*'|"[^"\n]*"/g, (q) => {
		strs.push(q.slice(1, -1));
		return ` \u0001${strs.length - 1}\u0001 `;
	});
	return masked
		.split(/\n|&&|\|\||;/)
		.map((x) => x.trim())
		.filter(Boolean)
		.map((seg) => ({
			text: seg.replace(/\s*\u0001\d+\u0001\s*/g, " <str> ").trim(),
			words: stripPrefixes(
				seg
					.split("|")[0]
					.split(/\s+/)
					.filter(Boolean)
					.map((w) => w.replace(/\u0001(\d+)\u0001/g, (_, i) => strs[i])),
			),
		}));
}
export function commandSegments(cmd) {
	return shellSegments(cmd).map((x) => x.text);
}

// Files a shell command reads with a read verb (cat, head, sed -n, …), and whether its first substantive verb searches.
function shellReads(cmd, rx) {
	const files = [];
	let firstVerb = null;
	for (const { words } of shellSegments(cmd)) {
		if (!words.length) continue;
		const v = verbOf(words[0]);
		const v2 = words[1] && !words[1].startsWith("-") ? `${v} ${words[1]}` : null;
		if (firstVerb == null && !rx.skipVerbs.has(v)) firstVerb = rx.searchVerbs.has(v2) ? v2 : v;
		if (!rx.readVerbs.has(v)) continue;
		const redir = words.findIndex((w, i) => i > 0 && /^(\d*[<>]|&>)/.test(w));
		let args = words.slice(1, redir > 0 ? redir : undefined).filter((w) => !w.startsWith("-"));
		if ((v === "sed" || v === "awk") && !words.includes("-e") && !words.includes("-f")) args = args.slice(1);
		for (const a of args) if (/^[~\w./@+,-]+$/.test(a) && /[/.]/.test(a) && !/^\d+(,\d+)?p?$/.test(a)) files.push(a);
	}
	return { files, search: firstVerb != null && rx.searchVerbs.has(firstVerb) };
}
function normTok(t) {
	if (t === "<str>") return t;
	if (/^https?:\/\//i.test(t)) return "<url>";
	if (t.startsWith("-")) return t.includes("=") ? `${t.split("=")[0]}=<v>` : /\d/.test(t) && t.length > 3 ? "<opt>" : t;
	if (t.includes("=")) return `${t.split("=")[0]}=<v>`;
	if (/^\d+([.:,]\d+)*$/.test(t)) return "<n>";
	if (/^[0-9a-f]{7,}$/i.test(t) || /^[0-9a-f-]{16,}$/i.test(t)) return "<id>";
	if (/[/\\]/.test(t) || t.startsWith("~") || /^\.{1,2}$/.test(t) || /\.[A-Za-z][A-Za-z0-9]{0,5}$/.test(t))
		return "<path>";
	if (/\d{3,}/.test(t)) return "<id>";
	return t;
}

async function* readEvents(file, gap) {
	const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
	for await (const line of rl) {
		if (!line.trim()) continue;
		let ev;
		try {
			ev = JSON.parse(line);
		} catch {
			gap("event_lines_unparseable");
			continue;
		}
		if (!ev || typeof ev !== "object" || Array.isArray(ev)) {
			gap("event_lines_not_objects");
			continue;
		}
		yield ev;
	}
}

function readManifest(bundleDir) {
	const f = path.join(bundleDir, "manifest.json");
	if (!fs.existsSync(f)) throw new Error(`manifest.json not found in ${bundleDir}`);
	const m = JSON.parse(fs.readFileSync(f, "utf8"));
	if (m.schemaVersion !== 1) process.stderr.write(`warning: schemaVersion ${m.schemaVersion} (expected 1)\n`);
	if (!Array.isArray(m.runs)) throw new Error("manifest.runs is not an array");
	return m;
}

const runFile = (bundleDir, id) => path.join(bundleDir, "runs", `${id}.jsonl`);

// ---------------------------------------------------------------------------
// Loop detection: consecutive repetition of a block of length minL..maxL.
// ---------------------------------------------------------------------------
function isPeriodic(block) {
	for (let p = 1; p < block.length; p++) {
		if (block.length % p) continue;
		let ok = true;
		for (let i = p; i < block.length && ok; i++) if (block[i] !== block[i - p]) ok = false;
		if (ok) return true;
	}
	return false;
}
export function findLoops(seq, minL, maxL, minReps, requireDistinct) {
	const out = [];
	const n = seq.length;
	let i = 0;
	while (i < n) {
		let best = null;
		for (let L = minL; L <= maxL && i + L * minReps <= n; L++) {
			const block = seq.slice(i, i + L);
			if (requireDistinct && new Set(block).size < 2) continue;
			if (isPeriodic(block)) continue;
			let reps = 1;
			outer: while (i + (reps + 1) * L <= n) {
				for (let k = 0; k < L; k++) if (seq[i + reps * L + k] !== block[k]) break outer;
				reps++;
			}
			if (reps >= minReps && (!best || reps * L > best.reps * best.L)) best = { L, reps };
		}
		if (best) {
			out.push({ start: i, end: i + best.L * best.reps - 1, L: best.L, reps: best.reps });
			i += best.L * best.reps;
		} else i++;
	}
	return out;
}

// ---------------------------------------------------------------------------
// Per-run analysis (streams the run file once).
// ---------------------------------------------------------------------------
async function analyseRun(run, bundleDir, cfg, rx, gap, bctx) {
	const id = run.id;
	const flags = [];
	const maxRefs = cfg.maxRefsPerFlag;
	const R = (ev) => ({ runId: id, seq: ev.seq ?? null, ref: ev.ref ?? null });
	const RR = (a, b) => ({ runId: id, seq: a.seq ?? null, seqTo: b.seq ?? null, ref: a.ref ?? null });
	// `extra._items` ([{ seq, chars }]) and `extra._cost` / `extra._ms` feed the impact estimate computed after the pass.
	const flag = (type, severity, refs, detail, extra = {}) => {
		flags.push({
			type,
			severity,
			runId: id,
			refs: refs.slice(0, maxRefs),
			refCount: refs.length,
			detail,
			...(HEURISTIC_TYPES.has(type) ? { heuristic: true } : {}),
			...extra,
		});
	};

	const m = {
		events: 0,
		abandonedEvents: 0,
		eventTypes: {},
		turns: 0,
		assistantTurnsAll: 0,
		abortedTurns: 0,
		toolCalls: {},
		toolCallCount: 0,
		toolResults: 0,
		toolResultsDurationNull: 0,
		shellResults: 0,
		shellResultsExitCodeNull: 0,
		errors: { failures: 0, byName: {}, byClass: {}, harnessPolicyByName: {} },
		usage: zeroUsage(),
		usageActive: zeroUsage(),
		usageAbandoned: zeroUsage(),
		usageNested: zeroUsage(),
		cacheHitRatio: null,
		contextTokens: { start: null, p50: null, peak: null, end: null, samples: 0 },
		startedAt: null,
		endedAt: null,
		wallClockMs: null,
		activeMs: 0,
		outputChars: 0,
		thinkingChars: 0,
		models: [],
		abandonedCostShare: null,
		abandonedEventShare: null,
		userMessages: {},
		instructionLoads: 0,
		instructionChars: 0,
		contextResets: 0,
		retries: 0,
		modelErrors: 0,
		notes: {},
		context: { totalChars: 0, carriedTokens: 0, byCategory: {} },
	};
	const aux = {
		calls: [],
		reads: [],
		edits: [],
		shellShapes: [],
		skillLoads: [],
		delegations: [],
		claim: null,
		hasVerify: false,
		hasReadback: false,
		fileMissing: false,
		firstUser: null,
	};
	const models = new Set(Array.isArray(run.models) ? run.models.filter(Boolean) : []);
	const file = runFile(bundleDir, id);
	if (!fs.existsSync(file)) {
		aux.fileMissing = true;
		gap("run_files_missing");
		return { m, flags, aux };
	}

	const calls = [];
	const results = new Map();
	const resultList = [];
	const ctx = [];
	const turnSeqs = [],
		resetSeqs = [];
	let ctxFirstOver = null,
		ctxPeakEv = null;
	let firstTs = null,
		lastTs = null,
		prevTs = null,
		prevEv = null,
		lastSeq = -Infinity;
	let humanCount = 0;
	let abandonedSeg = null;
	const retries = [];
	let lastAssistantText = null;

	const closeSeg = () => {
		if (!abandonedSeg) return;
		flag(
			"user_correction",
			"low",
			[RR(abandonedSeg.first, abandonedSeg.last)],
			`abandoned branch (rewind): ${abandonedSeg.n} events, cost ${fmtCost(abandonedSeg.cost)}`,
			{ kind: "rewind", target: "rewind", _cost: abandonedSeg.cost },
		);
		abandonedSeg = null;
	};

	for await (const ev of readEvents(file, gap)) {
		m.events++;
		inc(m.eventTypes, ev.type ?? "null");
		if (typeof ev.seq !== "number") gap("events_seq_missing");
		else {
			if (ev.seq <= lastSeq) gap("events_seq_not_increasing");
			lastSeq = ev.seq;
		}
		const abandoned = ev.branch === "abandoned";
		if (abandoned) {
			m.abandonedEvents++;
			if (!abandonedSeg) abandonedSeg = { first: ev, last: ev, n: 0, cost: 0 };
			abandonedSeg.last = ev;
			abandonedSeg.n++;
		} else {
			if (ev.branch !== "active") gap("events_branch_missing");
			closeSeg();
		}
		const t = tsMs(ev.ts);
		if (t == null) gap("events_ts_null");
		else {
			if (firstTs == null || t < firstTs) firstTs = t;
			if (lastTs == null || t > lastTs) lastTs = t;
			if (prevTs != null) {
				const g = t - prevTs;
				if (g > cfg.idleGapMs)
					flag("idle_gap", "low", [RR(prevEv, ev)], `idle ${fmtMs(g)} between events`, {
						gapMs: g,
						target: "idle",
						_ms: g,
					});
				else if (g > 0) m.activeMs += g;
			}
			prevTs = t;
			prevEv = ev;
		}

		switch (ev.type) {
			case "assistant": {
				m.assistantTurnsAll++;
				if (!abandoned) {
					m.turns++;
					if (typeof ev.seq === "number") turnSeqs.push(ev.seq);
				}
				if (ev.model) models.add(ev.model);
				const u = ev.usage;
				let turnCost = 0;
				if (!u || typeof u !== "object") gap("assistant_usage_null");
				else {
					const uu = zeroUsage();
					for (const k of USAGE_KEYS) {
						const v = num(u[k]);
						if (v == null) gap(`assistant_usage_${k}_null`);
						else uu[k] = v;
					}
					addInto(m.usage, uu);
					addInto(abandoned ? m.usageAbandoned : m.usageActive, uu);
					if (abandonedSeg) abandonedSeg.cost += uu.cost;
					turnCost = uu.cost;
				}
				const c = num(ev.contextTokens);
				if (c == null) gap("assistant_contextTokens_null");
				else {
					ctx.push(c);
					if (c > cfg.contextPressureTokens && !ctxFirstOver) ctxFirstOver = ev;
					if (!ctxPeakEv || c > ctxPeakEv.contextTokens) ctxPeakEv = ev;
				}
				const th = num(ev.thinkingChars);
				if (th != null) m.thinkingChars += th;
				if (ev.stopReason === "error") {
					m.modelErrors++;
					flag("model_error", "med", [R(ev)], `model error: ${clip(oneLine(ev.error ?? "unknown"), 160)}`, {
						target: clip(oneLine(ev.error ?? "unknown"), 40),
						_cost: turnCost,
					});
				} else if (ev.stopReason === "aborted") {
					m.abortedTurns++;
					flag("user_abort", "low", [R(ev)], "assistant turn aborted (likely user interrupt)", {
						target: "aborted turn",
						_cost: turnCost,
					});
				}
				if (!abandoned && typeof ev.text === "string" && ev.text.trim())
					lastAssistantText = { text: ev.text, seq: ev.seq, ref: ev.ref ?? null };
				break;
			}
			case "tool_call": {
				const name = ev.name ?? "unknown";
				if (ev.name == null) gap("tool_call_name_null");
				inc(m.toolCalls, name);
				m.toolCallCount++;
				if (ev.argsHash == null) gap("tool_call_argsHash_null");
				const cmd = argString(ev.args, cfg.commandArgKeys);
				const range =
					ev.args && typeof ev.args === "object"
						? cfg.rangeArgKeys
								.filter((k) => ev.args[k] != null)
								.map((k) => `${k}=${JSON.stringify(ev.args[k])}`)
								.join(",")
						: "";
				const interval = readInterval(ev.args);
				calls.push({
					seq: ev.seq,
					ref: ev.ref ?? null,
					t,
					callId: ev.callId ?? null,
					name,
					abandoned,
					sig: ev.argsHash != null ? `${name}\u0000${ev.argsHash}` : `${name}\u0000#${ev.seq}`,
					cmd,
					riskyText: argString(ev.args, cfg.riskyArgKeys),
					path: normPath(argString(ev.args, cfg.pathArgKeys), run.cwd),
					range,
					interval,
					content: rx.edit.test(name) ? argString(ev.args, cfg.contentArgKeys) : null,
				});
				break;
			}
			case "tool_result": {
				m.toolResults++;
				const oc = num(ev.outputChars);
				if (oc == null) gap("tool_result_outputChars_null");
				else m.outputChars += oc;
				const r = {
					seq: ev.seq,
					ref: ev.ref ?? null,
					t,
					callId: ev.callId ?? null,
					name: ev.name ?? "unknown",
					isError: ev.isError === true,
					errorClass: ev.errorClass ?? null,
					outputChars: oc,
					durationMs: num(ev.durationMs),
					exitCode: num(ev.exitCode),
					abandoned,
				};
				if (r.durationMs == null) m.toolResultsDurationNull++;
				if (r.isError && r.errorClass == null) {
					gap("tool_result_error_without_class");
					r.errorClass = "unknown";
				}
				if (r.callId != null) results.set(r.callId, r);
				else gap("tool_result_callId_null");
				resultList.push(r);
				if (r.isError) {
					inc(m.errors.byClass, r.errorClass);
					if (r.errorClass === "harness_policy") inc(m.errors.harnessPolicyByName, r.name);
					else {
						m.errors.failures++;
						inc(m.errors.byName, r.name);
					}
				}
				if (ev.nestedUsage && typeof ev.nestedUsage === "object") {
					const uu = zeroUsage();
					for (const k of USAGE_KEYS) uu[k] = num(ev.nestedUsage[k]) ?? 0;
					addInto(m.usage, uu);
					addInto(m.usageNested, uu);
					addInto(abandoned ? m.usageAbandoned : m.usageActive, uu);
					if (abandonedSeg) abandonedSeg.cost += uu.cost;
				}
				break;
			}
			case "user": {
				const o = ev.origin ?? "null";
				inc(m.userMessages, o);
				const txt = typeof ev.text === "string" ? ev.text : "";
				const agentLike = !!txt && rx.agentMsg.some((re) => re.test(txt));
				if ((o === "human" || o === "parent" || o === "command") && !aux.firstUser && txt.trim())
					aux.firstUser = labelFromMessage(txt);
				if (o === "human" && !agentLike) {
					humanCount++;
					if (humanCount > 1 && txt && rx.correction.some((re) => re.test(txt))) {
						flag(
							"user_correction",
							"med",
							[R(ev)],
							`heuristic: user message looks like a correction: "${clip(oneLine(txt), 140)}"`,
							{ kind: "text_heuristic", target: "human message" },
						);
					}
				} else if (o === "human") m.agentLikeHumanMessages = (m.agentLikeHumanMessages || 0) + 1;
				break;
			}
			case "skill_load":
				aux.skillLoads.push({
					skill: ev.skill ?? null,
					path: ev.path ?? null,
					via: ev.via ?? null,
					callId: ev.callId ?? null,
					blocked: ev.blocked === true,
					chars: num(ev.chars),
					contentHash: ev.contentHash ?? null,
					seq: ev.seq,
					ref: ev.ref ?? null,
				});
				if (ev.skill == null) gap("skill_load_skill_null");
				if (ev.skill && ev.path) bctx.addSkillPath(ev.skill, ev.path);
				break;
			case "instruction_load":
				m.instructionLoads++;
				m.instructionChars += num(ev.chars) ?? 0;
				break;
			case "delegation":
				aux.delegations.push({
					runId: id,
					seq: ev.seq,
					ref: ev.ref ?? null,
					callId: ev.callId ?? null,
					mode: ev.mode ?? null,
					childRunId: ev.childRunId ?? null,
					promptChars: num(ev.promptChars),
					description: ev.description ?? null,
					resultCharsReported: num(ev.resultChars),
					resultRef: ev.resultRef && typeof ev.resultRef === "object" ? ev.resultRef : null,
				});
				break;
			case "context_reset":
				m.contextResets++;
				if (typeof ev.seq === "number") resetSeqs.push(ev.seq);
				flag(
					"context_reset",
					"low",
					[R(ev)],
					`context ${ev.kind ?? "reset"}${num(ev.tokensBefore) != null ? ` at ${fmtK(ev.tokensBefore)} tokens` : ""}`,
					{ kind: ev.kind ?? null, target: ev.kind ?? "reset" },
				);
				break;
			case "retry":
				m.retries++;
				retries.push(ev);
				break;
			case "model_change":
				if (ev.model) models.add(ev.model);
				break;
			case "note":
				inc(m.notes, ev.kind ?? "null");
				break;
			default:
				gap(`event_type_unknown:${ev.type}`);
		}
	}
	closeSeg();

	// --- metrics finalisation
	m.models = [...models].sort();
	const sa = tsMs(run.startedAt) ?? firstTs,
		ea = tsMs(run.endedAt) ?? lastTs;
	m.startedAt = sa != null ? new Date(sa).toISOString() : null;
	m.endedAt = ea != null ? new Date(ea).toISOString() : null;
	m.wallClockMs = sa != null && ea != null ? ea - sa : null;
	m.cacheHitRatio = cacheHit(m.usage);
	if (ctx.length) {
		const s = [...ctx].sort((a, b) => a - b);
		m.contextTokens = {
			start: ctx[0],
			p50: median(s),
			peak: s[s.length - 1],
			end: ctx[ctx.length - 1],
			samples: ctx.length,
		};
	}
	m.abandonedCostShare = m.usage.cost > 0 ? round(m.usageAbandoned.cost / m.usage.cost) : null;
	m.abandonedEventShare = m.events ? round(m.abandonedEvents / m.events) : null;

	// carried(seq): active turns after `seq` and before the next context reset, i.e. how many prompts re-send it.
	turnSeqs.sort((a, b) => a - b);
	resetSeqs.sort((a, b) => a - b);
	const countBelow = (arr, x) => {
		let lo = 0,
			hi = arr.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (arr[mid] <= x) lo = mid + 1;
			else hi = mid;
		}
		return lo;
	};
	const turnsAfter = (seq) => {
		if (typeof seq !== "number") return 0;
		const nextReset = resetSeqs.find((x) => x > seq) ?? Infinity;
		return countBelow(turnSeqs, nextReset) - countBelow(turnSeqs, seq);
	};
	const tok = (chars) => chars / cfg.charsPerToken;

	// --- call/result joins
	calls.sort((a, b) => a.seq - b.seq);
	resultList.sort((a, b) => a.seq - b.seq);
	const res = (c) => (c.callId != null ? results.get(c.callId) : undefined);
	const isPolicy = (c) => res(c)?.errorClass === "harness_policy";
	const cR = (c) => ({ runId: id, seq: c.seq, ref: c.ref });
	const rR = (r) => ({ runId: id, seq: r.seq, ref: r.ref });
	const outItem = (c) => {
		const r = res(c);
		return r && r.outputChars != null ? { seq: r.seq, chars: r.outputChars } : null;
	};
	const live = calls.filter((c) => !isPolicy(c));
	const callById = new Map(calls.filter((c) => c.callId != null).map((c) => [c.callId, c]));
	for (const c of calls)
		if (c.path && rx.edit.test(c.name) && !isPolicy(c)) aux.edits.push({ path: c.path, seq: c.seq });
	const editsOf = new Map();
	for (const e of aux.edits) {
		if (!editsOf.has(e.path)) editsOf.set(e.path, []);
		editsOf.get(e.path).push(e.seq);
	}
	const editBetween = (p, a, b) => (editsOf.get(p) || []).some((s) => s > a && s < b);
	const editSeqs = calls.filter((c) => rx.edit.test(c.name) && !isPolicy(c)).map((c) => c.seq);
	const anyEditBetween = (a, b) => editSeqs.some((s) => s > a && s < b);

	// --- skill loads: adapter events plus loads inferred from reads/shell reads of skill files
	const loadByCall = new Map(aux.skillLoads.filter((s) => s.callId != null).map((s) => [s.callId, s]));
	const classifyFile = (p) => {
		const abs = normPath(p, run.cwd);
		const sk = bctx.skillOfPath(abs);
		if (sk) return { cat: `skill:${sk.name}`, skill: sk.name, isSkillMd: sk.isSkillMd, path: abs };
		if (bctx.instructionSources.has(abs) || rx.doc.test(abs)) return { cat: "docs", path: abs };
		if (/\.(log|out|trx|err)$|(^|\/)(logs?|TestResults)\//i.test(abs)) return { cat: "shell/log", path: abs };
		return { cat: "source", path: abs };
	};
	const delegCallIds = new Set(aux.delegations.map((d) => d.callId).filter((x) => x != null));
	const resultRefSeqs = new Set(aux.delegations.map((d) => d.resultRef?.seq).filter((x) => typeof x === "number"));
	const shellInfo = new Map(); // callId/seq -> shellReads
	const addCat = (cat, chars, seq, isPrimaryRead) => {
		const b = (m.context.byCategory[cat] ??= { chars: 0, results: 0, carriedTokens: 0 });
		b.chars += chars;
		if (isPrimaryRead) b.results++;
		const carried = tok(chars) * turnsAfter(seq);
		b.carriedTokens += carried;
		m.context.carriedTokens += carried;
		m.context.totalChars += chars;
	};
	const catOfResult = new Map();
	for (const r of resultList) {
		const c = r.callId != null ? callById.get(r.callId) : undefined;
		const chars = r.outputChars ?? 0;
		let parts = null; // [{cat, share}]
		const sl = r.callId != null ? loadByCall.get(r.callId) : undefined;
		if (sl && sl.skill) parts = [{ cat: `skill:${sl.skill}` }];
		else if (
			(r.callId != null && delegCallIds.has(r.callId)) ||
			resultRefSeqs.has(r.seq) ||
			rx.delegResult?.test(r.name)
		)
			parts = [{ cat: "delegation" }];
		else if (c && c.path && rx.read.test(c.name)) {
			const f = classifyFile(c.path);
			parts = [{ cat: f.cat }];
			if (f.skill && f.isSkillMd && !r.isError && r.callId != null && !loadByCall.has(r.callId))
				aux.skillLoads.push({
					skill: f.skill,
					path: f.path,
					via: "read",
					callId: r.callId,
					blocked: false,
					chars: r.outputChars,
					contentHash: null,
					seq: c.seq,
					ref: c.ref,
					inferred: true,
				});
		} else if (c && c.cmd) {
			const sr = shellReads(c.cmd, rx);
			shellInfo.set(c.seq, sr);
			if (sr.files.length) {
				const fs2 = sr.files.map(classifyFile);
				parts = fs2.map((f) => ({ cat: f.cat }));
				if (!r.isError && !(r.callId != null && loadByCall.has(r.callId))) {
					for (const f of fs2)
						if (f.skill && f.isSkillMd)
							aux.skillLoads.push({
								skill: f.skill,
								path: f.path,
								via: "shell",
								callId: r.callId,
								blocked: false,
								chars: null,
								contentHash: null,
								seq: c.seq,
								ref: c.ref,
								inferred: true,
							});
				}
			} else parts = [{ cat: sr.search ? "search" : "shell/log" }];
		} else if (rx.search.test(r.name)) parts = [{ cat: "search" }];
		else parts = [{ cat: "other" }];
		catOfResult.set(r.seq, parts[0].cat);
		parts.forEach((p, i) => addCat(p.cat, chars / parts.length, r.seq, i === 0));
	}
	for (const b of Object.values(m.context.byCategory)) {
		b.chars = Math.round(b.chars);
		b.carriedTokens = Math.round(b.carriedTokens);
	}
	m.context.carriedTokens = Math.round(m.context.carriedTokens);
	m.context.byCategory = sortObj(m.context.byCategory);
	aux.skillLoads.sort((a, b) => a.seq - b.seq);
	for (const k of ["toolCalls", "eventTypes", "userMessages", "notes"]) m[k] = sortObj(m[k]);
	for (const k of Object.keys(m.errors)) if (typeof m.errors[k] === "object") m.errors[k] = sortObj(m.errors[k]);
	for (const u of ["usage", "usageActive", "usageAbandoned", "usageNested"]) m[u].cost = round(m[u].cost, 6);
	const targetOf = (c) =>
		c.cmd
			? commandShape(c.cmd, rx.skipVerbs)
			: c.path
				? `*${path.posix.extname(c.path) || path.posix.basename(c.path)}`
				: c.name;

	// repeated_call: identical calls with no edit/write in between (re-running after a change is not a repeat)
	const bySig = new Map();
	for (const c of live) {
		if (!bySig.has(c.sig)) bySig.set(c.sig, []);
		bySig.get(c.sig).push(c);
	}
	for (const [, cs] of bySig) {
		if (cs[0].sig.includes("\u0000#")) continue;
		const redundant = cs.filter((c, i) => i > 0 && !anyEditBetween(cs[i - 1].seq, c.seq));
		if (redundant.length + 1 >= cfg.repeatedCallMin && redundant.length) {
			const n = redundant.length + 1;
			flag(
				"repeated_call",
				n >= 5 ? "high" : n >= 3 ? "med" : "low",
				cs.map(cR),
				`${cs[0].name} called ${cs.length}x with identical args (${redundant.length} with no edit in between)${cs[0].cmd ? `: ${clip(oneLine(cs[0].cmd), 100)}` : cs[0].path ? `: ${cs[0].path}` : ""}`,
				{
					count: cs.length,
					redundant: redundant.length,
					tool: cs[0].name,
					target: `${cs[0].name}: ${targetOf(cs[0])}`,
					_items: redundant.map(outItem).filter(Boolean),
				},
			);
		}
	}
	// repeated_read: a read is redundant when the same path and range was already read since the last edit of that path.
	// Contiguous chunked reads (different offset/limit) and re-reads after an edit are not redundant.
	const readsByPath = new Map();
	for (const c of live)
		if (c.path && rx.read.test(c.name)) {
			if (!readsByPath.has(c.path)) readsByPath.set(c.path, []);
			readsByPath.get(c.path).push(c);
		}
	for (const [p, cs] of readsByPath) {
		const prior = [];
		const redundant = [];
		for (const c of cs) {
			const iv = c.interval;
			// redundant when an earlier read since the last edit of this path covered the same range
			if (
				prior.some(
					(q) =>
						!editBetween(p, q.seq, c.seq) &&
						(q.range === c.range || (q.iv && iv && q.iv[0] <= iv[0] && q.iv[1] >= iv[1])),
				)
			)
				redundant.push(c);
			prior.push({ seq: c.seq, range: c.range, iv });
		}
		if (redundant.length + 1 >= cfg.repeatedReadMin) {
			const n = redundant.length;
			flag(
				"repeated_read",
				n >= 9 ? "high" : n >= 5 ? "med" : "low",
				cs.map(cR),
				`${p} read ${cs.length}x (${n} redundant: same range, no edit in between)`,
				{
					count: cs.length,
					redundant: n,
					path: p,
					target: `${catOfResult.get(res(cs[0])?.seq) ?? "file"}: ${path.posix.basename(p)}`,
					_items: redundant.map(outItem).filter(Boolean),
				},
			);
		}
	}
	for (const [p, seqs] of editsOf) {
		if (seqs.length >= cfg.editChurnMin)
			flag(
				"edit_churn",
				seqs.length >= 10 ? "high" : "med",
				live.filter((c) => c.path === p && rx.edit.test(c.name)).map(cR),
				`${p} edited/written ${seqs.length}x`,
				{ count: seqs.length, path: p, target: path.posix.extname(p) || path.posix.basename(p) },
			);
	}
	// error_then_same_call
	const failed = (r) =>
		!!r && r.errorClass !== "harness_policy" && (r.isError || (r.exitCode != null && r.exitCode !== 0));
	for (let i = 0; i < calls.length; i++) {
		const r = res(calls[i]);
		if (!r || !r.isError || r.errorClass === "harness_policy") continue;
		for (let j = i + 1; j <= i + cfg.errorThenSameWindow && j < calls.length; j++) {
			if (calls[j].sig === calls[i].sig && !calls[i].sig.includes("\u0000#")) {
				flag(
					"error_then_same_call",
					"med",
					[cR(calls[i]), rR(r), cR(calls[j])],
					`${calls[i].name} failed (${r.errorClass}) then retried with identical args ${j - i} call(s) later`,
					{
						tool: calls[i].name,
						target: `${calls[i].name}: ${targetOf(calls[i])}`,
						_items: [outItem(calls[j])].filter(Boolean),
					},
				);
				break;
			}
		}
	}
	// error_streak (harness_policy results are skipped, successes break the streak)
	let streak = [];
	const endStreak = () => {
		if (streak.length >= cfg.errorStreakMin) {
			const names = [...new Set(streak.map((r) => r.name))].sort().join(", ");
			flag(
				"error_streak",
				streak.length >= 5 ? "high" : "med",
				[
					{ runId: id, seq: streak[0].seq, seqTo: streak[streak.length - 1].seq, ref: streak[0].ref },
					...streak.map(rR),
				],
				`${streak.length} consecutive tool errors (${names})`,
				{
					count: streak.length,
					target: names,
					_items: streak.filter((r) => r.outputChars != null).map((r) => ({ seq: r.seq, chars: r.outputChars })),
				},
			);
		}
		streak = [];
	};
	for (const r of resultList) {
		if (r.isError && r.errorClass === "harness_policy") continue;
		if (r.isError) streak.push(r);
		else endStreak();
	}
	endStreak();
	// loops
	const sigLoops = findLoops(
		live.map((c) => c.sig),
		1,
		cfg.loopMaxLen,
		cfg.loopMinRepeats,
		false,
	);
	for (const l of sigLoops) {
		const a = live[l.start],
			b = live[l.end];
		const names = live
			.slice(l.start, l.start + l.L)
			.map((c) => c.name)
			.join("→");
		flag(
			"loop",
			l.reps >= 5 ? "high" : "med",
			[{ runId: id, seq: a.seq, seqTo: b.seq, ref: a.ref }],
			`identical call block [${names}] repeated ${l.reps}x consecutively`,
			{
				blockLen: l.L,
				reps: l.reps,
				target: names,
				_items: live
					.slice(l.start + l.L, l.end + 1)
					.map(outItem)
					.filter(Boolean),
			},
		);
	}
	const covered = (s, e) => sigLoops.some((l) => s <= l.end && e >= l.start);
	for (const l of findLoops(
		live.map((c) => c.name),
		cfg.loopNameOnlyMinLen,
		cfg.loopNameOnlyMaxLen,
		cfg.loopNameOnlyMinRepeats,
		true,
	)) {
		if (covered(l.start, l.end)) continue;
		const a = live[l.start],
			b = live[l.end];
		const names = live
			.slice(l.start, l.start + l.L)
			.map((c) => c.name)
			.join("→");
		flag(
			"loop_name_only",
			"low",
			[{ runId: id, seq: a.seq, seqTo: b.seq, ref: a.ref }],
			`heuristic: tool-name pattern [${names}] repeated ${l.reps}x (args differ)`,
			{ blockLen: l.L, reps: l.reps, target: names },
		);
	}
	// per-call: large output, discovery, risky, slow, verify, shapes, reads
	const disc = new Map();
	const verifyScripts = new Set(); // basenames of files written in this run whose content runs tests/builds/linters
	const editedSoFar = new Set();
	for (const c of calls) {
		const r = res(c);
		const policy = r?.errorClass === "harness_policy";
		if (c.content && c.path && rx.verifyCmd.some((re) => re.test(c.content)))
			verifyScripts.add(path.posix.basename(c.path));
		if (c.path && rx.edit.test(c.name) && !policy) editedSoFar.add(c.path);
		// read-back of a file this run edited counts as verification of that edit
		if (!policy && c.path && rx.read.test(c.name) && editedSoFar.has(c.path)) aux.hasReadback = true;
		if (r && r.outputChars != null && r.outputChars > cfg.largeOutputChars) {
			const oc = r.outputChars;
			flag(
				"large_output",
				oc > cfg.largeOutputChars * 5 ? "high" : "med",
				[rR(r)],
				`${r.name} output ${fmtK(oc)} chars${c.cmd ? `: ${clip(oneLine(c.cmd), 80)}` : c.path ? `: ${c.path}` : ""}`,
				{
					outputChars: oc,
					tool: r.name,
					source: catOfResult.get(r.seq) ?? "other",
					target: `${catOfResult.get(r.seq) ?? "other"} | ${r.name}: ${targetOf(c)}`,
					_items: [{ seq: r.seq, chars: oc }],
				},
			);
		}
		if (c.cmd) {
			const shape = commandShape(c.cmd, rx.skipVerbs);
			const segs = commandSegments(c.cmd);
			let discShape = null;
			const ids = new Set(),
				kinds = new Set();
			for (const seg of segs) {
				const hit = rx.discovery.filter((d) => d.re.test(seg));
				if (hit.length) {
					hit.forEach((x) => {
						ids.add(x.id);
						kinds.add(x.kind);
					});
					discShape ??= commandShape(seg, rx.skipVerbs);
				}
			}
			const isFail = failed(r);
			aux.shellShapes.push({
				shape,
				failed: isFail,
				exitCode: r?.exitCode ?? null,
				policy,
				discovery: ids.size > 0,
				discShape,
				discKinds: [...kinds],
			});
			if ((r && /bash|shell|exec|terminal|command/i.test(r.name)) || r?.exitCode != null) {
				m.shellResults++;
				if (r.exitCode == null) m.shellResultsExitCodeNull++;
			}
			if (ids.size && !policy) {
				if (!disc.has(discShape)) disc.set(discShape, { ids: new Set(), kinds: new Set(), cs: [] });
				const d = disc.get(discShape);
				ids.forEach((x) => d.ids.add(x));
				kinds.forEach((x) => d.kinds.add(x));
				d.cs.push(c);
			}
			if (segs.some((seg) => rx.verifyCmd.some((re) => re.test(seg)))) aux.hasVerify = true;
			else if (
				verifyScripts.size &&
				segs.some((seg) => seg.split(/\s+/).some((t) => verifyScripts.has(path.posix.basename(t))))
			)
				aux.hasVerify = true;
			// shell read-back of an edited file (cat/head/sed -n, git diff)
			if (!policy && editedSoFar.size) {
				const sr = shellInfo.get(c.seq) ?? shellReads(c.cmd, rx);
				if (
					sr.files.some((f) => editedSoFar.has(normPath(f, run.cwd))) ||
					segs.some((s) => /^git\s+(diff|show)\b/.test(s))
				)
					aux.hasReadback = true;
			}
		}
		if (c.riskyText) {
			const risk = riskyMatch(c, rx);
			if (risk) {
				const sev = risk.scratch
					? "low"
					: risk.ids.every((x) => x === "git-push-force") && /--force-with-lease/.test(c.riskyText)
						? "med"
						: "high";
				flag(
					"risky_command",
					sev,
					[cR(c)],
					`${risk.ids.join(", ")}${risk.scratch ? " (scratch/temp targets only)" : ""}: ${clip(oneLine(c.riskyText), 140)}${c.abandoned ? " (abandoned branch)" : ""}${policy ? " (blocked by harness)" : ""}`,
					{
						patterns: risk.ids,
						scope: risk.scratch ? "scratch" : "general",
						target: `${risk.ids.join(", ")}${risk.scratch ? " (scratch)" : ""}`,
					},
				);
			}
		}
		if (r) {
			const dur = r.durationMs ?? (r.t != null && c.t != null ? r.t - c.t : null);
			if (r.durationMs == null) gap("tool_result_durationMs_null");
			if (dur != null && dur > cfg.slowToolMs && !delegCallIds.has(c.callId) && !rx.slowExclude?.test(c.name))
				flag(
					"slow_tool",
					dur > cfg.slowToolMs * 5 ? "med" : "low",
					[cR(c), rR(r)],
					`${c.name} took ${fmtMs(dur)}${r.durationMs == null ? " (from timestamps)" : ""}`,
					{ durationMs: dur, tool: c.name, target: `${c.name}: ${targetOf(c)}`, _ms: dur },
				);
		} else if (c.callId != null) gap("tool_call_without_result");
		if (c.path && rx.read.test(c.name) && !policy)
			aux.reads.push({ path: c.path, t: c.t, seq: c.seq, ref: c.ref, chars: r?.outputChars ?? null });
	}
	for (const [shape, d] of [...disc].sort((a, b) => cmpStr(a[0], b[0]))) {
		const kinds = [...d.kinds].sort();
		flag(
			"discovery",
			d.cs.length >= 3 ? "med" : "low",
			d.cs.map(cR),
			`heuristic: ${kinds.join("/")} probe "${shape}" x${d.cs.length} (${[...d.ids].sort().join(", ")})`,
			{
				shape,
				kinds,
				count: d.cs.length,
				patterns: [...d.ids].sort(),
				target: `${kinds.join("/")}: ${shape}`,
				_items: d.cs.map(outItem).filter(Boolean),
			},
		);
	}
	if (retries.length)
		flag(
			"retry",
			retries.length >= 3 ? "med" : "low",
			retries.map(R),
			`${retries.length} model call retr${retries.length === 1 ? "y" : "ies"} (${[...new Set(retries.map((e) => e.reason ?? "unknown"))].sort().join(", ")})`,
			{
				count: retries.length,
				target: [...new Set(retries.map((e) => clip(oneLine(e.reason ?? "unknown"), 30)))].sort().join(", "),
			},
		);
	if (ctxFirstOver) {
		const peak = ctxPeakEv.contextTokens;
		flag(
			"context_pressure",
			peak > cfg.contextPressureTokens * 1.3 ? "high" : "med",
			[R(ctxFirstOver), R(ctxPeakEv)],
			`context exceeded ${fmtK(cfg.contextPressureTokens)} tokens; peak ${fmtK(peak)}`,
			{ peak, target: "context", _tokens: peak - cfg.contextPressureTokens },
		);
	}
	if (lastAssistantText) {
		const txt = lastAssistantText.text;
		const hit = rx.verifyClaim.map((re) => txt.match(re)).find(Boolean);
		const caveat = rx.notVerified.some((re) => re.test(txt));
		// test/build/lint claims need a verification command; generic "verified"/"checks pass" claims are backed by any
		// non-edit tool call after the last edit (the agent looked at something after changing it)
		const lastEdit = Math.max(-1, ...editSeqs);
		const checkedAfter = calls.some(
			(c) =>
				c.seq > lastEdit &&
				c.seq < lastAssistantText.seq &&
				!rx.edit.test(c.name) &&
				!isPolicy(c) &&
				!delegCallIds.has(c.callId),
		);
		if (hit && !caveat)
			aux.claim = {
				seq: lastAssistantText.seq,
				ref: lastAssistantText.ref,
				phrase: hit[0],
				specific: /test|build|lint/i.test(hit[0]),
				checkedAfter,
			};
	}
	// skills
	const bySkill = new Map();
	for (const s of aux.skillLoads) {
		const k = s.skill ?? "(null)";
		if (!bySkill.has(k)) bySkill.set(k, { loaded: [], blocked: [] });
		bySkill.get(k)[s.blocked ? "blocked" : "loaded"].push(s);
	}
	const loadChars = (s) => s.chars ?? (s.callId != null ? (results.get(s.callId)?.outputChars ?? null) : null);
	for (const [k, v] of [...bySkill].sort((a, b) => cmpStr(a[0], b[0]))) {
		if (v.loaded.length >= 2) {
			const vias = [...new Set(v.loaded.map((s) => s.via ?? "null"))].sort().join("/");
			flag(
				"skill_reloaded",
				v.loaded.length >= 3 ? "med" : "low",
				v.loaded.map(R),
				`skill ${k} loaded ${v.loaded.length}x (via ${vias})`,
				{
					skill: k,
					count: v.loaded.length,
					target: k,
					_items: v.loaded
						.slice(1)
						.map((s) => ({ seq: s.seq, chars: loadChars(s) }))
						.filter((x) => x.chars != null),
				},
			);
		}
		if (v.blocked.length)
			flag(
				"skill_blocked",
				"low",
				v.blocked.map(R),
				`skill ${k}: ${v.blocked.length} repeat load(s) blocked by harness`,
				{ skill: k, count: v.blocked.length, target: k },
			);
	}
	if (
		m.outputChars > cfg.parentHeavyIoChars &&
		aux.delegations.length === 0 &&
		cfg.parentHeavyIoKinds.includes(run.kind)
	) {
		const top = resultList
			.filter((r) => r.outputChars != null)
			.sort((a, b) => b.outputChars - a.outputChars || a.seq - b.seq)
			.slice(0, 5);
		flag(
			"parent_heavy_io",
			m.outputChars > cfg.parentHeavyIoChars * 3 ? "high" : "med",
			top.map(rR),
			`${fmtK(m.outputChars)} chars of tool output and no delegation (refs: largest outputs)`,
			{ outputChars: m.outputChars, target: run.kind ?? "run", _chars: m.outputChars },
		);
	}
	// delegation result size: adapter-reported resultChars, else the foreground tool result. Background launch
	// acknowledgements are never reported as results.
	for (const d of aux.delegations) {
		const direct = d.callId != null ? (results.get(d.callId)?.outputChars ?? null) : null;
		d.launchAckChars = d.mode === "foreground" ? null : direct;
		d.resultChars = d.resultCharsReported ?? (d.mode === "foreground" ? direct : null);
		d.resultSource = d.resultCharsReported != null ? "reported" : d.resultChars != null ? "tool_result" : null;
	}
	aux.lastT = lastTs;
	aux.turnsAfter = turnsAfter;
	// impact
	for (const f of flags) finaliseImpact(f, turnsAfter, cfg);
	return { m, flags, aux };
}

// Short label from a user message. Expanded commands (`<tag name="x" …>body</tag> args`) become `/x args`.
function labelFromMessage(txt) {
	const mm = txt.match(/^\s*<([a-z][\w-]*)\b[^>]*\bname="([^"]+)"/i);
	if (mm) {
		const close = txt.lastIndexOf(`</${mm[1]}>`);
		return clip(`/${mm[2]} ${close >= 0 ? txt.slice(close + mm[1].length + 3) : ""}`.replace(/\s+/g, " ").trim(), 60);
	}
	return clip(txt.replace(/\s+/g, " ").trim(), 60);
}

// Line interval [from, to] a read covers, from common offset/limit or start/end argument styles. Whole file when none.
function readInterval(args) {
	if (!args || typeof args !== "object") return [0, Infinity];
	const n = (k) =>
		typeof args[k] === "number"
			? args[k]
			: typeof args[k] === "string" && /^\d+$/.test(args[k])
				? Number(args[k])
				: null;
	if (Array.isArray(args.view_range) && args.view_range.length === 2) {
		const [a, b] = args.view_range.map(Number);
		return [a, b < 0 ? Infinity : b];
	}
	const off = n("offset") ?? n("start_line") ?? n("startLine") ?? n("line");
	const lim = n("limit"),
		end = n("end_line") ?? n("endLine");
	if (off == null && lim == null && end == null) return [0, Infinity];
	const from = off ?? 0;
	return [from, end != null ? end : lim != null ? from + lim - 1 : Infinity];
}

// Impact estimate from internal fields: chars of avoidable/attributable output, tokens, carried tokens (tokens × later
// turns that re-send them), direct cost when the flag itself is a cost, and time.
function finaliseImpact(f, turnsAfter, cfg) {
	const items = f._items || [];
	let chars = items.length ? items.reduce((a, x) => a + x.chars, 0) : null;
	let carried = items.length ? items.reduce((a, x) => a + (x.chars / cfg.charsPerToken) * turnsAfter(x.seq), 0) : null;
	if (f._chars != null) chars = f._chars;
	const tokens = f._tokens != null ? f._tokens : chars != null ? Math.round(chars / cfg.charsPerToken) : null;
	f.impact = {
		chars: chars != null ? Math.round(chars) : null,
		tokens,
		carriedTokens: carried != null ? Math.round(carried) : null,
		cost: f._cost != null ? round(f._cost, 6) : null,
		ms: f._ms ?? null,
	};
	delete f._items;
	delete f._chars;
	delete f._tokens;
	delete f._cost;
	delete f._ms;
}

// risky_command: patterns are matched on shell segments with quoted strings and heredoc bodies masked
// (non-shell text such as SQL is matched as is). Deletes whose targets are all scratch/temp paths are marked.
function riskyMatch(c, rx) {
	const isShell = c.cmd != null && c.cmd === c.riskyText;
	const segs = isShell ? shellSegments(c.riskyText) : [{ text: c.riskyText, words: [] }];
	const ids = new Set();
	let allScratch = true,
		anyDelete = false;
	let dir = null; // directory set by an earlier `cd` in the same command; relative targets resolve against it
	for (const s of segs) {
		if (s.words[0] === "cd" && s.words[1]) {
			const w = s.words[1];
			dir = /^[/~$]/.test(w) ? w : dir ? path.posix.join(dir, w) : null;
		}
		const hits = rx.risky.filter((d) => d.re.test(s.text)).map((d) => d.id);
		if (!hits.length) continue;
		hits.forEach((x) => ids.add(x));
		if (hits.every((h) => h === "rm-rf") && s.words.length) {
			anyDelete = true;
			const targets = s.words
				.slice(1)
				.filter((w) => !w.startsWith("-"))
				.map((w) => (dir && !/^[/~$]/.test(w) ? path.posix.join(dir, w) : w));
			const mktemp = /\bmktemp\b/.test(c.riskyText);
			if (!targets.length || !targets.every((t) => rx.scratch.test(t) || (mktemp && /^\$\{?\w+\}?(\/|$)/.test(t))))
				allScratch = false;
		} else allScratch = false;
	}
	if (!ids.size) return null;
	return { ids: [...ids].sort(), scratch: anyDelete && allScratch };
}

// ---------------------------------------------------------------------------
// Bundle analysis
// ---------------------------------------------------------------------------
export async function analyseBundle(bundleDir, cfg) {
	const rx = compileConfig(cfg);
	const manifest = readManifest(bundleDir);
	const gapCounts = new Map();
	const gap = (k, n = 1) => gapCounts.set(k, (gapCounts.get(k) || 0) + n);

	const runsMeta = [];
	const seen = new Set();
	for (const r of manifest.runs) {
		if (!r || typeof r.id !== "string") {
			gap("manifest_runs_without_id");
			continue;
		}
		if (seen.has(r.id)) {
			gap("manifest_runs_duplicate_id");
			continue;
		}
		seen.add(r.id);
		runsMeta.push(r);
	}
	runsMeta.sort((a, b) => cmpStr(a.id, b.id));
	const byId = new Map(runsMeta.map((r) => [r.id, r]));
	const runsDir = path.join(bundleDir, "runs");
	if (fs.existsSync(runsDir)) {
		const extra = fs.readdirSync(runsDir).filter((f) => f.endsWith(".jsonl") && !byId.has(f.slice(0, -6)));
		if (extra.length) gap("run_files_not_in_manifest", extra.length);
	}

	// root resolution
	const rootOf = (r) => {
		let cur = r;
		const guard = new Set();
		while (cur.parentId && byId.has(cur.parentId) && !guard.has(cur.id)) {
			guard.add(cur.id);
			cur = byId.get(cur.parentId);
		}
		return cur.id;
	};
	const children = new Map();
	for (const r of runsMeta) {
		if (r.parentId && !byId.has(r.parentId)) gap("runs_parent_not_in_bundle");
		if (r.parentId && byId.has(r.parentId)) {
			if (!children.has(r.parentId)) children.set(r.parentId, []);
			children.get(r.parentId).push(r.id);
		}
		const computed = rootOf(r);
		if (r.rootId && r.rootId !== computed) gap("runs_rootId_mismatch");
		r._root = computed;
		if (r.link?.confidence === "inferred") gap("runs_link_inferred");
		if (!Array.isArray(r.harnessFeatures) || !r.harnessFeatures.length) gap("runs_harnessFeatures_empty_or_unknown");
		if (!r.context) gap("runs_context_null");
		else
			for (const k of ["instructions", "skillsAvailable", "toolsAvailable", "systemPromptChars"])
				if (r.context[k] == null) gap(`runs_context_${k}_null`);
		for (const k of ["startedAt", "endedAt", "cwd"]) if (r[k] == null) gap(`runs_${k}_null`);
	}
	const startKey = (id) => byId.get(id).startedAt ?? "";
	for (const [, cs] of children) cs.sort((a, b) => cmpStr(startKey(a), startKey(b)) || cmpStr(a, b));

	// bundle-wide context: skill directories and instruction sources, used to classify tool output by source
	const skillDirs = new Map(); // dir -> { name, skillMd }
	const addSkillPath = (name, p) => {
		if (!name || typeof p !== "string" || !p) return;
		const abs = path.posix.normalize(p);
		const dir = /\.md$/i.test(abs) ? path.posix.dirname(abs) : abs;
		if (!skillDirs.has(dir)) {
			skillDirs.set(dir, { name, skillMd: abs });
			skillCache.clear();
		}
	};
	const skillCache = new Map();
	const skillOfPath = (p) => {
		if (!p) return null;
		if (skillCache.has(p)) return skillCache.get(p);
		let best = null;
		for (const [dir, v] of skillDirs)
			if ((p === v.skillMd || p.startsWith(dir + "/")) && (!best || dir.length > best.dir.length)) best = { dir, ...v };
		let out = best
			? {
					name: best.name,
					isSkillMd: p === best.skillMd || (/\/SKILL\.md$/i.test(p) && path.posix.dirname(p) === best.dir),
				}
			: null;
		if (!out) {
			const mm = p.match(/\/([^/]+)\/SKILL\.md$/i) || p.match(/\/skills\/([^/]+)\//);
			if (mm) out = { name: mm[1], isSkillMd: /\/SKILL\.md$/i.test(p) };
		}
		skillCache.set(p, out);
		return out;
	};
	const instructionSources = new Set();
	for (const r of runsMeta) {
		for (const s of Array.isArray(r.context?.skillsAvailable) ? r.context.skillsAvailable : [])
			addSkillPath(s?.name, s?.path);
		for (const i of Array.isArray(r.context?.instructions) ? r.context.instructions : [])
			if (typeof i?.source === "string") instructionSources.add(path.posix.normalize(i.source));
	}
	const bctx = { addSkillPath, skillOfPath, instructionSources };

	// per-run pass (sequential streaming keeps memory bounded)
	const res = new Map();
	for (const r of runsMeta) res.set(r.id, await analyseRun(r, bundleDir, cfg, rx, gap, bctx));

	const flags = [];
	for (const r of runsMeta) flags.push(...res.get(r.id).flags);

	// subtree helpers
	const descendants = (id) => {
		const out = [];
		const st = [...(children.get(id) || [])];
		while (st.length) {
			const c = st.shift();
			out.push(c);
			st.push(...(children.get(c) || []));
		}
		return out;
	};
	const subtree = new Map();
	const subtreeOf = (id) => {
		if (subtree.has(id)) return subtree.get(id);
		const ids = [id, ...descendants(id)];
		const u = zeroUsage();
		let turns = 0,
			toolCalls = 0,
			failures = 0,
			outputChars = 0,
			hasVerify = false,
			hasReadback = false;
		for (const x of ids) {
			const { m, aux } = res.get(x);
			addInto(u, m.usage);
			turns += m.turns;
			toolCalls += m.toolCallCount;
			failures += m.errors.failures;
			outputChars += m.outputChars;
			hasVerify ||= aux.hasVerify;
			hasReadback ||= aux.hasReadback;
		}
		u.cost = round(u.cost, 6);
		const v = { ids, usage: u, turns, toolCalls, failures, outputChars, hasVerify, hasReadback };
		subtree.set(id, v);
		return v;
	};

	// delegations and cross-run flags
	const delegations = [];
	for (const r of runsMeta) {
		const { aux } = res.get(r.id);
		const later = [];
		for (const d of aux.delegations) {
			let child = d.childRunId && byId.has(d.childRunId) ? d.childRunId : null;
			if (!child && d.callId != null)
				child = (children.get(r.id) || []).find((c) => byId.get(c).link?.parentCallId === d.callId) ?? null;
			const rec = { ...d, childFound: !!child, childRunId: child ?? d.childRunId };
			if (child) {
				const st = subtreeOf(child);
				Object.assign(rec, {
					childCost: st.usage.cost,
					childTurns: st.turns,
					childRuns: st.ids.length,
					childAgentType: byId.get(child).agentType ?? null,
				});
				// parent re-reads files the child already read, after the child ended; reads followed by an edit of the same
				// path in the parent are discounted (the parent is about to change that file)
				const ce = tsMs(byId.get(child).endedAt) ?? res.get(child).aux.lastT;
				const childPaths = new Set(res.get(child).aux.reads.map((x) => x.path));
				const childEdited = new Set(st.ids.flatMap((x) => res.get(x).aux.edits.map((e) => e.path)));
				if (ce != null && childPaths.size) {
					const hit = new Map();
					let discounted = 0;
					for (const pr of aux.reads) {
						if (pr.t == null || pr.t <= ce || !childPaths.has(pr.path) || hit.has(pr.path)) continue;
						if (childEdited.has(pr.path) || aux.edits.some((e) => e.path === pr.path && e.seq > pr.seq)) {
							discounted++;
							continue;
						}
						hit.set(pr.path, pr);
					}
					if (hit.size) {
						const list = [...hit.values()].sort((a, b) => a.seq - b.seq);
						const f = {
							type: "parent_rereads_child_files",
							severity: list.length >= 3 ? "med" : "low",
							runId: r.id,
							refs: [
								{ runId: r.id, seq: d.seq, ref: d.ref },
								...list.map((x) => ({ runId: r.id, seq: x.seq, ref: x.ref })),
							].slice(0, cfg.maxRefsPerFlag),
							refCount: list.length + 1,
							detail: `after child ${child} ended, parent re-read ${list.length} file(s) the child had read and did not then edit${discounted ? ` (${discounted} not counted: parent edited them next or the child changed them)` : ""}: ${list
								.slice(0, 3)
								.map((x) => x.path)
								.join(", ")}${list.length > 3 ? ", …" : ""}`,
							childRunId: child,
							paths: list.map((x) => x.path),
							discounted,
							target: byId.get(child).agentType ?? "child",
							_items: list.filter((x) => x.chars != null).map((x) => ({ seq: x.seq, chars: x.chars })),
						};
						finaliseImpact(f, aux.turnsAfter, cfg);
						later.push(f);
					}
				}
			} else {
				later.push({
					type: "delegation_unlinked",
					severity: d.mode === "peer_message" ? "low" : "med",
					runId: r.id,
					refs: [{ runId: r.id, seq: d.seq, ref: d.ref }],
					refCount: 1,
					detail: `${d.mode ?? "unknown-mode"} delegation has no child run in bundle${d.description ? `: ${clip(oneLine(d.description), 80)}` : ""}`,
					target: d.mode ?? "unknown",
					impact: { chars: null, tokens: null, carriedTokens: null, cost: null, ms: null },
				});
			}
			delegations.push(rec);
		}
		if (aux.claim) {
			const st = subtreeOf(r.id);
			if (!st.hasVerify && !(aux.claim.specific ? false : st.hasReadback || aux.claim.checkedAfter))
				later.push({
					type: "unbacked_claim",
					severity: "low",
					heuristic: true,
					runId: r.id,
					refs: [{ runId: r.id, seq: aux.claim.seq, ref: aux.claim.ref }],
					refCount: 1,
					detail: `heuristic: final reply claims "${aux.claim.phrase}" but no test/build/lint/validator command or read-back of an edited file ran in this run or its descendants`,
					phrase: aux.claim.phrase,
					target: aux.claim.phrase.toLowerCase(),
					impact: { chars: null, tokens: null, carriedTokens: null, cost: null, ms: null },
				});
		}
		flags.push(...later);
	}

	// corpus price used for rough cost estimates of context impact
	const allU = runsMeta.reduce((a, r) => addInto(a, res.get(r.id).m.usage), zeroUsage());
	const promptTok = allU.input + allU.cacheRead + allU.cacheWrite;
	const costPerPromptToken = promptTok > 0 && allU.cost > 0 ? allU.cost / promptTok : null;
	const estCostOf = (imp) =>
		imp.cost != null
			? imp.cost
			: imp.carriedTokens != null && costPerPromptToken != null
				? round(imp.carriedTokens * costPerPromptToken, 6)
				: null;
	for (const f of flags) f.impact.estCost = estCostOf(f.impact);

	// finalise flags: root ids, deterministic order, ids
	for (const f of flags) f.rootId = byId.get(f.runId)._root;
	flags.sort(
		(a, b) =>
			cmpStr(a.rootId, b.rootId) ||
			cmpStr(a.runId, b.runId) ||
			(a.refs[0]?.seq ?? -1) - (b.refs[0]?.seq ?? -1) ||
			cmpStr(a.type, b.type) ||
			cmpStr(a.detail, b.detail),
	);
	flags.forEach((f, i) => {
		f.id = `F${String(i + 1).padStart(4, "0")}`;
	});
	const flagsByRun = new Map();
	for (const f of flags) {
		if (!flagsByRun.has(f.runId)) flagsByRun.set(f.runId, {});
		inc(flagsByRun.get(f.runId), f.type);
	}

	// runs output
	const runsOut = runsMeta.map((r) => {
		const { m, aux } = res.get(r.id);
		const loaded = aux.skillLoads.filter((s) => !s.blocked);
		return {
			id: r.id,
			parentId: r.parentId ?? null,
			rootId: r._root,
			kind: r.kind ?? null,
			label: r.label ?? null,
			firstMessage: aux.firstUser,
			agentType: r.agentType ?? null,
			link: r.link ?? null,
			cwd: r.cwd ?? null,
			harnessFeatures: Array.isArray(r.harnessFeatures) ? [...r.harnessFeatures].sort() : [],
			fileMissing: aux.fileMissing,
			metrics: m,
			skills: {
				loads: loaded.length,
				inferredLoads: loaded.filter((s) => s.inferred).length,
				blockedLoads: aux.skillLoads.length - loaded.length,
				distinct: [...new Set(loaded.map((s) => s.skill))].sort(),
			},
			delegations: aux.delegations.length,
			flagCounts: sortObj(flagsByRun.get(r.id) || {}),
			notes: Array.isArray(r.notes) ? r.notes : [],
		};
	});
	const runOut = new Map(runsOut.map((r) => [r.id, r]));

	// context spent by source
	const kindKey = (k) => (k === "subagent" ? "subagent" : k === "peer" ? "peer" : "primary");
	const ctxAgg = (ids) => {
		const by = {};
		let total = 0,
			carried = 0;
		for (const x of ids) {
			const c = res.get(x).m.context;
			const kk = kindKey(byId.get(x).kind);
			total += c.totalChars;
			carried += c.carriedTokens;
			for (const [cat, b] of Object.entries(c.byCategory)) {
				const o = (by[cat] ??= { chars: 0, results: 0, carriedTokens: 0, byKind: {}, trees: new Set(), runs: 0 });
				o.chars += b.chars;
				o.results += b.results;
				o.carriedTokens += b.carriedTokens;
				inc(o.byKind, kk, b.chars);
				o.trees.add(byId.get(x)._root);
				o.runs++;
			}
		}
		const rows = Object.entries(by)
			.map(([cat, o]) => ({
				category: cat,
				chars: o.chars,
				share: total ? round(o.chars / total) : null,
				results: o.results,
				carriedTokens: o.carriedTokens,
				estCost: costPerPromptToken != null ? round(o.carriedTokens * costPerPromptToken, 4) : null,
				byKind: sortObj(o.byKind),
				trees: o.trees.size,
				runs: o.runs,
			}))
			.sort((a, b) => b.chars - a.chars || cmpStr(a.category, b.category));
		const groups = {};
		for (const row of rows) {
			const g = row.category.startsWith("skill:") ? "skill files" : row.category;
			const o = (groups[g] ??= { chars: 0, byKind: {} });
			o.chars += row.chars;
			for (const [k, v] of Object.entries(row.byKind)) inc(o.byKind, k, v);
		}
		const groupRows = Object.entries(groups)
			.map(([g, o]) => ({
				group: g,
				chars: o.chars,
				share: total ? round(o.chars / total) : null,
				byKind: sortObj(o.byKind),
			}))
			.sort((a, b) => b.chars - a.chars);
		const byKindTotal = {};
		for (const x of ids) inc(byKindTotal, kindKey(byId.get(x).kind), res.get(x).m.context.totalChars);
		return { totalChars: total, carriedTokens: carried, byKindTotal: sortObj(byKindTotal), groups: groupRows, rows };
	};

	// trees
	const roots = runsMeta
		.filter((r) => r._root === r.id)
		.sort((a, b) => cmpStr(a.startedAt ?? "", b.startedAt ?? "") || cmpStr(a.id, b.id));
	const trees = roots.map((r) => {
		const st = subtreeOf(r.id);
		const ms = st.ids.map((x) => res.get(x).m);
		const starts = ms.map((m) => tsMs(m.startedAt)).filter((x) => x != null);
		const ends = ms.map((m) => tsMs(m.endedAt)).filter((x) => x != null);
		const fc = {};
		for (const x of st.ids) for (const [k, v] of Object.entries(flagsByRun.get(x) || {})) inc(fc, k, v);
		const sev = { high: 0, med: 0, low: 0 };
		for (const f of flags) if (f.rootId === r.id) sev[f.severity]++;
		const features = [...new Set(st.ids.flatMap((x) => runOut.get(x).harnessFeatures))].sort();
		const ownCost = res.get(r.id).m.usage.cost;
		const tc = ctxAgg(st.ids);
		const hashes = [
			...new Set(
				st.ids.flatMap((x) =>
					(Array.isArray(byId.get(x).context?.instructions) ? byId.get(x).context.instructions : [])
						.filter((i) => typeof i?.contentHash === "string")
						.map((i) => `${path.posix.basename(i.source ?? "?")}@${i.contentHash.replace(/^sha256:/, "").slice(0, 8)}`),
				),
			),
		].sort();
		return {
			rootId: r.id,
			label: r.label ?? null,
			firstMessage: res.get(r.id).aux.firstUser,
			cwd: r.cwd ?? null,
			startedAt: starts.length ? new Date(Math.min(...starts)).toISOString() : null,
			durationMs: starts.length && ends.length ? Math.max(...ends) - Math.min(...starts) : null,
			runs: st.ids.length,
			runIds: st.ids,
			usage: st.usage,
			cacheHitRatio: cacheHit(st.usage),
			activeCost: round(
				ms.reduce((a, m) => a + m.usageActive.cost, 0),
				6,
			),
			childCostShare: st.usage.cost > 0 ? round((st.usage.cost - ownCost) / st.usage.cost) : null,
			turns: st.turns,
			toolCalls: st.toolCalls,
			toolFailures: st.failures,
			outputChars: st.outputChars,
			thinkingChars: ms.reduce((a, m) => a + m.thinkingChars, 0),
			agentActiveMs: ms.reduce((a, m) => a + m.activeMs, 0),
			peakContextTokens: Math.max(0, ...ms.map((m) => m.contextTokens.peak ?? 0)) || null,
			delegations: delegations.filter((d) => st.ids.includes(d.runId)).length,
			skillLoads: st.ids.reduce((a, x) => a + runOut.get(x).skills.loads, 0),
			skillChars: tc.groups.find((g) => g.group === "skill files")?.chars ?? 0,
			context: {
				totalChars: tc.totalChars,
				groups: tc.groups,
				top: tc.rows.slice(0, 8).map((x) => ({ category: x.category, chars: x.chars, share: x.share })),
			},
			harnessFeatures: features,
			instructionHashes: hashes,
			flagCounts: sortObj(fc),
			flagSeverity: sev,
			flagTotal: sev.high + sev.med + sev.low,
		};
	});
	const treeOf = new Map();
	for (const t of trees) for (const x of t.runIds) treeOf.set(x, t.rootId);
	const contextBySource = ctxAgg(runsMeta.map((r) => r.id));
	contextBySource.costPerPromptToken = costPerPromptToken != null ? round(costPerPromptToken, 10) : null;
	contextBySource.injectedSkillChars = runsMeta.reduce(
		(a, r) =>
			a +
			res
				.get(r.id)
				.aux.skillLoads.filter((s) => !s.blocked && (s.via === "user_command" || s.via === "harness_injection"))
				.reduce((b, s) => b + (s.chars ?? 0), 0),
		0,
	);

	// ---------------- cross-session
	const flagTypes = {};
	for (const ty of FLAG_TYPES)
		flagTypes[ty] = {
			flags: 0,
			trees: new Set(),
			runs: new Set(),
			high: 0,
			med: 0,
			low: 0,
			chars: 0,
			carriedTokens: 0,
			estCost: 0,
		};
	for (const f of flags) {
		const s = flagTypes[f.type];
		s.flags++;
		s.trees.add(f.rootId);
		s.runs.add(f.runId);
		s[f.severity]++;
		s.chars += f.impact.chars ?? 0;
		s.carriedTokens += f.impact.carriedTokens ?? 0;
		s.estCost += f.impact.estCost ?? 0;
	}
	const flagTypesOut = Object.fromEntries(
		Object.entries(flagTypes)
			.filter(([, s]) => s.flags)
			.map(([k, s]) => [
				k,
				{
					flags: s.flags,
					trees: s.trees.size,
					runs: s.runs.size,
					high: s.high,
					med: s.med,
					low: s.low,
					heuristic: HEURISTIC_TYPES.has(k),
					chars: s.chars,
					carriedTokens: s.carriedTokens,
					estCost: round(s.estCost, 4),
				},
			]),
	);

	// top leads: flags grouped by (type, target), ranked by estimated cost, then recurrence; plus skill-file context spend
	const leadMap = new Map();
	for (const f of flags) {
		const k = `${f.type}\u0000${f.target ?? ""}`;
		if (!leadMap.has(k))
			leadMap.set(k, {
				type: f.type,
				target: f.target ?? null,
				flags: 0,
				trees: new Set(),
				runs: new Set(),
				sev: { high: 0, med: 0, low: 0 },
				chars: 0,
				carriedTokens: 0,
				estCost: 0,
				costKnown: false,
				ms: 0,
				refs: [],
				heuristic: HEURISTIC_TYPES.has(f.type),
			});
		const g = leadMap.get(k);
		g.flags++;
		g.trees.add(f.rootId);
		g.runs.add(f.runId);
		g.sev[f.severity]++;
		g.chars += f.impact.chars ?? 0;
		g.carriedTokens += f.impact.carriedTokens ?? 0;
		g.ms += f.impact.ms ?? 0;
		if (f.impact.estCost != null) {
			g.estCost += f.impact.estCost;
			g.costKnown = true;
		}
		if (g.refs.length < 3 && f.refs[0]) g.refs.push(refStr(f.refs[0]));
	}
	for (const row of contextBySource.rows) {
		if (
			!row.category.startsWith("skill:") ||
			!contextBySource.totalChars ||
			row.chars / contextBySource.totalChars < 0.005
		)
			continue;
		leadMap.set(`context\u0000${row.category}`, {
			type: "context_spend",
			target: row.category,
			flags: row.results,
			trees: { size: row.trees },
			runs: { size: row.runs },
			sev: { high: 0, med: 0, low: 0 },
			chars: row.chars,
			carriedTokens: row.carriedTokens,
			estCost: row.estCost ?? 0,
			costKnown: row.estCost != null,
			ms: 0,
			refs: [],
			heuristic: false,
			share: row.share,
		});
	}
	const leads = [...leadMap.values()].map((g) => ({
		type: g.type,
		target: g.target,
		flags: g.flags,
		trees: g.trees.size,
		runs: g.runs.size,
		severity: g.sev,
		heuristic: g.heuristic,
		chars: g.chars,
		tokens: Math.round(g.chars / cfg.charsPerToken),
		carriedTokens: g.carriedTokens,
		estCost: g.costKnown ? round(g.estCost, 4) : null,
		ms: g.ms || null,
		share: g.share ?? null,
		sampleRefs: g.refs,
	}));
	const quantified = leads
		.filter((x) => x.estCost != null && x.estCost > 0)
		.sort(
			(a, b) =>
				b.estCost - a.estCost || b.trees - a.trees || cmpStr(a.type, b.type) || cmpStr(a.target ?? "", b.target ?? ""),
		);
	const unquantified = leads
		.filter((x) => !(x.estCost != null && x.estCost > 0) && (x.severity.high || x.severity.med || x.trees >= 2))
		.sort(
			(a, b) =>
				b.severity.high - a.severity.high ||
				b.trees - a.trees ||
				b.flags - a.flags ||
				cmpStr(a.type, b.type) ||
				cmpStr(a.target ?? "", b.target ?? ""),
		);

	// tool error rates
	const tools = {};
	for (const r of runsOut) {
		const m = r.metrics;
		for (const [n, c] of Object.entries(m.toolCalls))
			(tools[n] ??= { calls: 0, failures: 0, harnessPolicy: 0, trees: new Set() }).calls += c;
		for (const [n, c] of Object.entries(m.errors.byName))
			(tools[n] ??= { calls: 0, failures: 0, harnessPolicy: 0, trees: new Set() }).failures += c;
		for (const [n, c] of Object.entries(m.errors.harnessPolicyByName))
			(tools[n] ??= { calls: 0, failures: 0, harnessPolicy: 0, trees: new Set() }).harnessPolicy += c;
		for (const n of Object.keys(m.toolCalls)) tools[n].trees.add(r.rootId);
	}
	const toolErrorRates = Object.entries(tools)
		.map(([name, t]) => ({
			name,
			calls: t.calls,
			failures: t.failures,
			harnessPolicy: t.harnessPolicy,
			errorRate: t.calls ? round(t.failures / t.calls) : null,
			trees: t.trees.size,
		}))
		.sort((a, b) => b.failures - a.failures || b.calls - a.calls || cmpStr(a.name, b.name));

	// shell shapes
	const shapes = new Map();
	const discShapes = new Map();
	for (const r of runsOut) {
		for (const s of res.get(r.id).aux.shellShapes) {
			if (s.discShape && !s.policy) {
				if (!discShapes.has(s.discShape))
					discShapes.set(s.discShape, {
						shape: s.discShape,
						kinds: new Set(),
						discoveryCalls: 0,
						trees: new Set(),
						runs: new Set(),
					});
				const x = discShapes.get(s.discShape);
				x.discoveryCalls++;
				x.trees.add(r.rootId);
				x.runs.add(r.id);
				s.discKinds.forEach((k) => x.kinds.add(k));
			}
			if (!shapes.has(s.shape))
				shapes.set(s.shape, {
					shape: s.shape,
					calls: 0,
					failures: 0,
					harnessPolicy: 0,
					discoveryCalls: 0,
					exitCodes: {},
					trees: new Set(),
					runs: new Set(),
				});
			const x = shapes.get(s.shape);
			x.calls++;
			if (s.failed) {
				x.failures++;
				if (s.exitCode != null) inc(x.exitCodes, String(s.exitCode));
			}
			if (s.policy) x.harnessPolicy++;
			if (s.discovery) x.discoveryCalls++;
			x.trees.add(r.rootId);
			x.runs.add(r.id);
		}
	}
	const shapeOut = (x) => ({
		shape: x.shape,
		trees: x.trees.size,
		runs: x.runs.size,
		calls: x.calls,
		failures: x.failures,
		errorRate: x.calls ? round(x.failures / x.calls) : null,
		discoveryCalls: x.discoveryCalls,
		exitCodes: sortObj(x.exitCodes),
	});
	const allShapes = [...shapes.values()].map(shapeOut);
	const isPrimitive = (x) =>
		rx.primitive.test(x.shape) && x.calls / Math.max(1, x.trees) < cfg.crystallisePrimitiveMinCallsPerTree;
	const crystAll = allShapes.filter((x) => x.trees >= cfg.crystalliseMinTrees && x.shape !== "<empty>");
	const crystallisation = crystAll
		.filter((x) => !isPrimitive(x))
		.sort((a, b) => b.trees - a.trees || b.calls - a.calls || cmpStr(a.shape, b.shape));
	const primitivesHidden = crystAll
		.filter(isPrimitive)
		.sort((a, b) => b.trees - a.trees || b.calls - a.calls || cmpStr(a.shape, b.shape))
		.map((x) => x.shape);
	const topErroring = allShapes
		.filter((x) => x.failures > 0)
		.sort((a, b) => b.failures - a.failures || b.errorRate - a.errorRate || cmpStr(a.shape, b.shape));
	const topDiscovery = [...discShapes.values()]
		.map((x) => ({
			shape: x.shape,
			kinds: [...x.kinds].sort(),
			trees: x.trees.size,
			runs: x.runs.size,
			discoveryCalls: x.discoveryCalls,
		}))
		.sort((a, b) => b.trees - a.trees || b.discoveryCalls - a.discoveryCalls || cmpStr(a.shape, b.shape));

	// skills
	const skills = new Map();
	const sk = (n) => {
		if (!skills.has(n))
			skills.set(n, {
				skill: n,
				loads: 0,
				inferredLoads: 0,
				blockedLoads: 0,
				chars: 0,
				trees: new Set(),
				runs: new Set(),
				subagentLoads: 0,
				runsLoadedMultiple: 0,
				availableInRuns: 0,
				listedInRuns: 0,
				manualOnly: null,
				via: {},
				hashes: new Set(),
			});
		return skills.get(n);
	};
	let skillsAvailKnown = 0;
	for (const r of runsMeta) {
		const av = r.context?.skillsAvailable;
		if (Array.isArray(av)) {
			skillsAvailKnown++;
			for (const s of av)
				if (s?.name) {
					const x = sk(s.name);
					x.availableInRuns++;
					if (s.listed !== false) x.listedInRuns++;
					if (s.manualOnly != null) x.manualOnly = !!s.manualOnly;
				}
		}
		const per = {};
		const { m } = res.get(r.id);
		for (const l of res.get(r.id).aux.skillLoads) {
			const x = sk(l.skill ?? "(null)");
			if (l.blocked) x.blockedLoads++;
			else {
				x.loads++;
				if (l.inferred) x.inferredLoads++;
				if (r.kind === "subagent") x.subagentLoads++;
				inc(per, x.skill);
				inc(x.via, l.via ?? "null");
				if (l.contentHash) x.hashes.add(l.contentHash);
			}
			x.trees.add(r._root);
			x.runs.add(r.id);
		}
		for (const [cat, b] of Object.entries(m.context.byCategory))
			if (cat.startsWith("skill:")) sk(cat.slice(6)).chars += b.chars;
		for (const [n, c] of Object.entries(per)) if (c > 1) sk(n).runsLoadedMultiple++;
	}
	const skillsOut = [...skills.values()]
		.map((x) => ({
			skill: x.skill,
			loads: x.loads,
			inferredLoads: x.inferredLoads,
			subagentLoads: x.subagentLoads,
			blockedLoads: x.blockedLoads,
			chars: x.chars,
			trees: x.trees.size,
			runs: x.runs.size,
			runsLoadedMultiple: x.runsLoadedMultiple,
			availableInRuns: x.availableInRuns,
			listedInRuns: x.listedInRuns,
			manualOnly: x.manualOnly,
			via: sortObj(x.via),
			contentHashes: x.hashes.size,
		}))
		.sort((a, b) => b.loads - a.loads || b.trees - a.trees || cmpStr(a.skill, b.skill));
	const neverLoaded = skillsOut
		.filter((x) => x.loads === 0 && x.blockedLoads === 0 && x.availableInRuns > 0)
		.map((x) => ({ skill: x.skill, availableInRuns: x.availableInRuns, manualOnly: x.manualOnly }));

	// cohorts: harness feature sets, time windows (--cutover), instruction content hashes
	const cohortRows = (groups) =>
		[...groups].map(([k, ts]) => ({
			key: k,
			trees: ts.length,
			insufficient: ts.length < cfg.cohortMinTrees,
			rootIds: ts.map((t) => t.rootId),
			median: {
				cost: round(median(ts.map((t) => t.usage.cost)), 4),
				turns: median(ts.map((t) => t.turns)),
				skillLoads: median(ts.map((t) => t.skillLoads)),
				skillChars: median(ts.map((t) => t.skillChars)),
				outputChars: median(ts.map((t) => t.outputChars)),
				repeatedReadFlags: median(ts.map((t) => t.flagCounts.repeated_read || 0)),
				flags: median(ts.map((t) => t.flagTotal)),
				toolFailures: median(ts.map((t) => t.toolFailures)),
				cacheHitRatio: round(median(ts.map((t) => t.cacheHitRatio)), 4),
			},
		}));
	const groupBy = (keyOf) => {
		const g = new Map();
		for (const t of trees) {
			const k = keyOf(t);
			if (!g.has(k)) g.set(k, []);
			g.get(k).push(t);
		}
		return g;
	};
	const featureCohorts = cohortRows(groupBy((t) => t.harnessFeatures.join(", ") || "(none recorded)")).sort(
		(a, b) => b.trees - a.trees || cmpStr(a.key, b.key),
	);
	const cuts = [...new Set((cfg.cutovers || []).map((c) => tsMs(c)).filter((x) => x != null))].sort((a, b) => a - b);
	const iso = (x) => new Date(x).toISOString().slice(0, 16);
	const timeKey = (t) => {
		const s = tsMs(t.startedAt);
		if (s == null) return "(unknown start)";
		const i = cuts.findIndex((c) => s < c);
		return i === 0 ? `< ${iso(cuts[0])}` : i < 0 ? `≥ ${iso(cuts.at(-1))}` : `${iso(cuts[i - 1])} – ${iso(cuts[i])}`;
	};
	const timeCohorts = cuts.length ? cohortRows(groupBy(timeKey)).sort((a, b) => cmpStr(a.key, b.key)) : null;
	const anyHash = trees.some((t) => t.instructionHashes.length);
	const instructionCohorts = anyHash
		? cohortRows(groupBy((t) => t.instructionHashes.join(", ") || "(no hashes)")).sort(
				(a, b) => b.trees - a.trees || cmpStr(a.key, b.key),
			)
		: null;
	const cohorts = { features: featureCohorts, time: timeCohorts, instructions: instructionCohorts };

	// delegation summary
	const totalCost = round(
		trees.reduce((a, t) => a + t.usage.cost, 0),
		6,
	);
	const childCost = round(
		trees.reduce((a, t) => a + t.usage.cost - res.get(t.rootId).m.usage.cost, 0),
		6,
	);
	const byMode = {};
	for (const d of delegations) inc(byMode, d.mode ?? "null");
	const delegationSummary = {
		total: delegations.length,
		linked: delegations.filter((d) => d.childFound).length,
		unlinked: delegations.filter((d) => !d.childFound).length,
		byMode: sortObj(byMode),
		childCostShare: totalCost > 0 ? round(childCost / totalCost) : null,
		perTree: {
			median: median(trees.map((t) => t.delegations)),
			max: Math.max(0, ...trees.map((t) => t.delegations)),
			treesWithDelegation: trees.filter((t) => t.delegations).length,
		},
		promptChars: { median: median(delegations.map((d) => d.promptChars)) },
		resultChars: {
			median: median(delegations.map((d) => d.resultChars)),
			known: delegations.filter((d) => d.resultChars != null).length,
			reported: delegations.filter((d) => d.resultSource === "reported").length,
		},
		backgroundWithoutResult: delegations.filter((d) => d.mode !== "foreground" && d.resultChars == null).length,
		childRunsWithoutDelegation: runsMeta
			.filter((r) => r.parentId && !delegations.some((d) => d.childFound && d.childRunId === r.id))
			.map((r) => r.id),
	};

	const totalUsage = trees.reduce((a, t) => addInto(a, t.usage), zeroUsage());
	totalUsage.cost = round(totalUsage.cost, 6);
	const sevTotals = { high: 0, med: 0, low: 0 };
	for (const f of flags) sevTotals[f.severity]++;
	const overview = {
		trees: trees.length,
		runs: runsMeta.length,
		events: runsOut.reduce((a, r) => a + r.metrics.events, 0),
		span: {
			from:
				trees
					.map((t) => t.startedAt)
					.filter(Boolean)
					.sort()[0] ?? null,
			to:
				runsOut
					.map((r) => r.metrics.endedAt)
					.filter(Boolean)
					.sort()
					.at(-1) ?? null,
		},
		usage: totalUsage,
		cacheHitRatio: cacheHit(totalUsage),
		turns: trees.reduce((a, t) => a + t.turns, 0),
		toolCalls: trees.reduce((a, t) => a + t.toolCalls, 0),
		toolFailures: trees.reduce((a, t) => a + t.toolFailures, 0),
		delegations: delegations.length,
		flags: flags.length,
		flagSeverity: sevTotals,
		kinds: sortObj(runsMeta.reduce((o, r) => (inc(o, r.kind ?? "null"), o), {})),
		models: [...new Set(runsOut.flatMap((r) => r.metrics.models))].sort(),
	};

	// data quality
	const sumM = (k) => runsOut.reduce((a, r) => a + (r.metrics[k] || 0), 0);
	const evTotals = {};
	for (const r of runsOut) for (const [k, v] of Object.entries(r.metrics.eventTypes)) inc(evTotals, k, v);
	// truncation ceiling: many large outputs from different commands/files ending up at about the same, maximal size
	const bucket = new Map();
	let maxOut = 0;
	for (const f of flags)
		if (f.type === "large_output") {
			const k = Math.round(f.outputChars / 1000);
			maxOut = Math.max(maxOut, f.outputChars);
			if (!bucket.has(k)) bucket.set(k, { n: 0, targets: new Set() });
			const b = bucket.get(k);
			b.n++;
			b.targets.add(f.target);
		}
	const top = [...bucket]
		.filter(([k, b]) => b.targets.size >= 3 && k * 1000 >= maxOut * 0.9)
		.sort((a, b) => b[1].n - a[1].n)[0];
	const ceilTop = top ? [String(top[0] * 1000), top[1].n] : null;
	const dataQuality = {
		selection: manifest.selection
			? {
					scanned: num(manifest.selection.scanned),
					selected: num(manifest.selection.selected),
					excluded: num(manifest.selection.excluded),
				}
			: null,
		toolResults: sumM("toolResults"),
		durationNull: sumM("toolResultsDurationNull"),
		shellResults: sumM("shellResults"),
		shellExitCodeNull: sumM("shellResultsExitCodeNull"),
		eventTypeTotals: sortObj(evTotals),
		abandonedEvents: sumM("abandonedEvents"),
		abortedTurns: sumM("abortedTurns"),
		zeroCounts: ["context_reset", "instruction_load", "retry", "skill_load", "delegation"]
			.filter((k) => !evTotals[k])
			.concat(sumM("abandonedEvents") ? [] : ["abandoned branch"]),
		agentLikeHumanMessages: sumM("agentLikeHumanMessages"),
		subagentRunsWithEmptyInstructions: runsMeta.filter(
			(r) => r.kind === "subagent" && Array.isArray(r.context?.instructions) && !r.context.instructions.length,
		).length,
		outputCeiling: ceilTop && ceilTop[1] >= 5 ? { chars: Number(ceilTop[0]), count: ceilTop[1] } : null,
		inferredSkillLoads: runsOut.reduce((a, r) => a + r.skills.inferredLoads, 0),
	};

	const runNotes = runsOut.flatMap((r) => r.notes.map((n) => ({ runId: r.id, note: n })));
	return {
		digestVersion: 2,
		bundle: {
			manifestGeneratedAt: manifest.generatedAt ?? null,
			source: manifest.source ?? null,
			selection: manifest.selection ?? null,
			schemaVersion: manifest.schemaVersion ?? null,
		},
		config: cfg,
		overview,
		contextBySource,
		leads: { quantified, unquantified },
		trees,
		runs: runsOut,
		delegations,
		flags,
		crossSession: {
			flagTypes: flagTypesOut,
			toolErrorRates,
			shellShapes: { crystallisation, primitivesHidden, topErroring, topDiscovery, distinctShapes: allShapes.length },
			skills: { usage: skillsOut, neverLoaded, runsWithSkillsAvailableKnown: skillsAvailKnown },
			cohorts,
			delegation: delegationSummary,
		},
		dataQuality,
		dataGaps: {
			manifestWarnings: Array.isArray(manifest.warnings) ? manifest.warnings : [],
			runNotes,
			counters: sortObj(Object.fromEntries(gapCounts)),
		},
	};
}

// ---------------------------------------------------------------------------
// Markdown rendering (bounded)
// ---------------------------------------------------------------------------
const refStr = (r) =>
	`${r.runId}#${r.seq ?? "?"}${r.seqTo != null && r.seqTo !== r.seq ? `-${r.seqTo}` : ""}${r.ref ? `@${r.ref}` : ""}`;
function more(n, shown, what = "see digest.json") {
	return n > shown ? [`…and ${n - shown} more, ${what}`] : [];
}

const pct = (x) => (x == null ? "-" : `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`);
const fmtCost2 = (c) => (c == null ? "-" : c >= 1 ? c.toFixed(2) : c.toFixed(4));
const treeLabel = (t) => t.label ?? (t.firstMessage ? `“${t.firstMessage}”` : "-");
function impactStr(x) {
	const p = [];
	if (x.chars) p.push(`${fmtK(x.chars)} chars`);
	if (x.carriedTokens) p.push(`${fmtK(x.carriedTokens)} carried tok`);
	if (x.estCost != null && x.estCost > 0) p.push(`~$${fmtCost2(x.estCost)}`);
	if (x.ms) p.push(fmtMs(x.ms));
	return p.join(", ") || "-";
}
export function flagLine(f) {
	const refs = f.refs.slice(0, 3).map(refStr).join(", ") + (f.refCount > 3 ? ` +${f.refCount - 3}` : "");
	return `${f.id} [${f.severity}] ${f.type}: ${clip(oneLine(f.detail), 160)} | impact ${impactStr(f.impact ?? {})} | ${refs}`;
}
function contextTable(c, rowsMax, kinds) {
	const L = [];
	const ks = kinds ?? Object.keys(c.byKindTotal);
	L.push(
		`| source | chars | share | ${ks.map((k) => `${k} chars`).join(" | ")} | results | carried tok | trees |`,
		`|---|---|---|${ks.map(() => "---|").join("")}---|---|---|`,
	);
	for (const r of c.rows.slice(0, rowsMax))
		L.push(
			`| ${mdCell(r.category)} | ${fmtK(r.chars)} | ${pct(r.share)} | ${ks.map((k) => fmtK(r.byKind[k] ?? 0)).join(" | ")} | ${r.results} | ${fmtK(r.carriedTokens)} | ${r.trees} |`,
		);
	return L;
}

export function renderMd(d) {
	const L = [];
	const o = d.overview;
	const push = (...xs) => L.push(...xs);
	push("# Session digest", "");
	push(
		"Generated deterministically from the trace bundle. Flags marked *heuristic* are pattern matches and need checking against the refs before they are reported as findings. Refs are `runId#seq[-seqTo][@sourceRef]`; drill down with `digest.mjs show <bundle> <runId> <fromSeq> <toSeq>`, query flags with `digest.mjs flags <bundle> --out <dir> [--type T] [--tree ID]`.",
		"",
	);

	push("## Overview", "");
	const src = d.bundle.source || {};
	push(
		`- Source: ${src.harness ?? "?"} ${src.harnessVersion ?? ""} via ${src.adapter ?? "?"} ${src.adapterVersion ?? ""} (bundle generated ${d.bundle.manifestGeneratedAt ?? "?"})`.replace(
			/\s+/g,
			" ",
		),
	);
	const sel = d.bundle.selection;
	if (sel?.description || sel?.scanned != null)
		push(
			`- Selection: ${oneLine(sel.description ?? "-")}${sel.scanned != null ? ` (scanned ${sel.scanned}, selected ${sel.selected ?? "?"}, excluded ${sel.excluded ?? "?"})` : ""}`,
		);
	push(
		`- ${o.trees} trees, ${o.runs} runs (${Object.entries(o.kinds)
			.map(([k, v]) => `${k} ${v}`)
			.join(", ")}), ${o.events} events, span ${o.span.from ?? "?"} → ${o.span.to ?? "?"}`,
	);
	push(
		`- Cost ${fmtCost(o.usage.cost)}; tokens in ${fmtK(o.usage.input)}, out ${fmtK(o.usage.output)}, cacheRead ${fmtK(o.usage.cacheRead)}, cacheWrite ${fmtK(o.usage.cacheWrite)}; cache hit ratio ${o.cacheHitRatio ?? "-"}`,
	);
	push(
		`- ${o.turns} active turns, ${o.toolCalls} tool calls, ${o.toolFailures} tool failures (harness_policy excluded), ${o.delegations} delegations`,
	);
	push(`- ${o.flags} flags: ${o.flagSeverity.high} high, ${o.flagSeverity.med} med, ${o.flagSeverity.low} low`);
	push(`- Models: ${clip(o.models.join(", ") || "-", 300)}`, "");

	const c = d.contextBySource;
	push("## Context spent by source", "");
	push(
		`Tool output entering context: ${fmtK(c.totalChars)} chars (${Object.entries(c.byKindTotal)
			.map(([k, v]) => `${k} ${fmtK(v)}`)
			.join(
				", ",
			)}). *Carried tok* = tokens × later turns that re-send them (until a context reset); a proxy for what the output cost while it stayed in context. Shell reads (\`cat\`, \`sed -n\`, …) are attributed to the file read.`,
		"",
	);
	push(
		"| group | chars | share | " +
			Object.keys(c.byKindTotal)
				.map((k) => `${k} chars`)
				.join(" | ") +
			" |",
		"|---|---|---|" +
			Object.keys(c.byKindTotal)
				.map(() => "---|")
				.join(""),
	);
	for (const g of c.groups)
		push(
			`| ${mdCell(g.group)} | ${fmtK(g.chars)} | ${pct(g.share)} | ${Object.keys(c.byKindTotal)
				.map((k) => fmtK(g.byKind[k] ?? 0))
				.join(" | ")} |`,
		);
	push("", "By source (skill files per skill):", "");
	push(...contextTable(c, 15));
	push(...more(c.rows.length, 15, "see `digest.mjs context`"));
	if (c.injectedSkillChars)
		push(`- Skill content injected by command or harness (not tool output): ${fmtK(c.injectedSkillChars)} chars`);
	push("");

	push("## Top leads", "");
	push(
		`Flags grouped by (type, target), ranked by estimated cost: ~$ = direct cost where the flag is a cost (abandoned branch, aborted turn), otherwise carried tokens × corpus mean cost per prompt token (${c.costPerPromptToken != null ? `$${(c.costPerPromptToken * 1e6).toFixed(2)}/M` : "-"}; includes output and cache-write spend, so it overstates cached re-reads). Rough; use it for ranking only. \`context_spend\` rows are skill files from the table above (≥0.5% of output).`,
		"",
	);
	const LQ = d.leads.quantified;
	if (!LQ.length) push("- none");
	else {
		push("| # | type | target | flags | trees | runs | impact | sample refs |", "|---|---|---|---|---|---|---|---|");
		LQ.slice(0, 20).forEach((x, i) =>
			push(
				`| ${i + 1} | ${x.type}${x.heuristic ? " (h)" : ""} | ${mdCell(clip(x.target ?? "-", 60))} | ${x.flags} | ${x.trees} | ${x.runs} | ${mdCell(impactStr(x))}${x.share != null ? `, ${pct(x.share)} of output` : ""} | ${mdCell(x.sampleRefs.slice(0, 2).join(", ") || "-")} |`,
			),
		);
	}
	push(...more(LQ.length, 20), "");
	const LU = d.leads.unquantified;
	push("Unquantified (no size or cost derivable), by severity then recurrence:", "");
	if (!LU.length) push("- none");
	for (const x of LU.slice(0, 12))
		push(
			`- ${x.type}${x.heuristic ? " (heuristic)" : ""} \`${clip(oneLine(x.target ?? "-"), 60)}\`: ${x.flags} flags, ${x.trees} trees, ${x.runs} runs (h/m/l ${x.severity.high}/${x.severity.med}/${x.severity.low})${x.ms ? `, ${fmtMs(x.ms)}` : ""}; e.g. ${x.sampleRefs.slice(0, 2).join(", ")}`,
		);
	push(...more(LU.length, 12), "");

	push("## Per-tree table", "");
	push("Label falls back to the first human or parent message.", "");
	push(
		"| root | label | start | dur | cost | child% | turns | deleg | tool out | skill% | peak ctx | flags (h/m/l) | top flag types |",
		"|---|---|---|---|---|---|---|---|---|---|---|---|---|",
	);
	const TMAX = 50;
	for (const t of d.trees.slice(0, TMAX)) {
		const top = Object.entries(t.flagCounts)
			.sort((a, b) => b[1] - a[1] || cmpStr(a[0], b[0]))
			.slice(0, 3)
			.map(([k, v]) => `${k}:${v}`)
			.join(" ");
		push(
			`| ${mdCell(t.rootId)} | ${mdCell(clip(treeLabel(t), 60))} | ${t.startedAt?.slice(0, 16) ?? "-"} | ${fmtMs(t.durationMs)} | ${fmtCost(t.usage.cost)} | ${t.childCostShare == null ? "-" : Math.round(t.childCostShare * 100) + "%"} | ${t.turns} | ${t.delegations} | ${fmtK(t.context.totalChars)} | ${t.context.totalChars ? pct(t.skillChars / t.context.totalChars) : "-"} | ${fmtK(t.peakContextTokens)} | ${t.flagSeverity.high}/${t.flagSeverity.med}/${t.flagSeverity.low} | ${mdCell(top)} |`,
		);
	}
	push(...more(d.trees.length, TMAX), "");

	push("## Top flags", "");
	push(
		"By type (impact columns sum the per-flag estimates):",
		"",
		"| type | flags | trees | runs | high | med | low | chars | ~$ |",
		"|---|---|---|---|---|---|---|---|---|",
	);
	const ft = Object.entries(d.crossSession.flagTypes).sort(
		(a, b) => b[1].high - a[1].high || b[1].flags - a[1].flags || cmpStr(a[0], b[0]),
	);
	for (const [k, s] of ft)
		push(
			`| ${k}${s.heuristic ? " (heuristic)" : ""} | ${s.flags} | ${s.trees} | ${s.runs} | ${s.high} | ${s.med} | ${s.low} | ${s.chars ? fmtK(s.chars) : "-"} | ${s.estCost ? fmtCost2(s.estCost) : "-"} |`,
		);
	push("");
	const highs = d.flags
		.filter((f) => f.severity === "high")
		.sort((a, b) => (b.impact?.estCost ?? 0) - (a.impact?.estCost ?? 0) || cmpStr(a.id, b.id));
	push(`High severity (${highs.length}; large_output is aggregated under Top leads and below):`, "");
	const HM = 12;
	const highShown = highs.filter((f) => f.type !== "large_output").slice(0, HM);
	if (!highShown.length) push("- none");
	for (const f of highShown) push(`- ${flagLine(f)}`);
	push(
		...more(
			highs.filter((f) => f.type !== "large_output").length,
			highShown.length,
			"use `digest.mjs flags --type <T>`",
		),
		"",
	);
	const lo = new Map();
	for (const f of d.flags)
		if (f.type === "large_output") {
			const k = f.target ?? "-";
			const g = lo.get(k) ?? { n: 0, chars: 0, trees: new Set(), max: 0 };
			g.n++;
			g.chars += f.outputChars ?? 0;
			g.trees.add(f.rootId);
			g.max = Math.max(g.max, f.outputChars ?? 0);
			lo.set(k, g);
		}
	if (lo.size) {
		push(
			"large_output by source and command shape:",
			"",
			"| source \\| tool: shape | outputs | trees | total chars | max |",
			"|---|---|---|---|---|",
		);
		const rows = [...lo].sort((a, b) => b[1].chars - a[1].chars || cmpStr(a[0], b[0]));
		for (const [k, g] of rows.slice(0, 10))
			push(`| ${mdCell(clip(k, 70))} | ${g.n} | ${g.trees.size} | ${fmtK(g.chars)} | ${fmtK(g.max)} |`);
		push(...more(rows.length, 10, "use `digest.mjs flags --type large_output`"), "");
	}

	push("## Cross-session patterns", "");
	push(
		"Tool error rates (failures exclude harness_policy blocks):",
		"",
		"| tool | calls | failures | rate | policy blocks | trees |",
		"|---|---|---|---|---|---|",
	);
	const TE = 12;
	for (const t of d.crossSession.toolErrorRates.slice(0, TE))
		push(
			`| ${mdCell(t.name)} | ${t.calls} | ${t.failures} | ${t.errorRate ?? "-"} | ${t.harnessPolicy} | ${t.trees} |`,
		);
	push(...more(d.crossSession.toolErrorRates.length, TE), "");

	push("## Crystallisation candidates", "");
	const sh = d.crossSession.shellShapes;
	push(
		`Shell command shapes seen in ≥${d.config.crystalliseMinTrees} trees (${sh.distinctShapes} distinct shapes in total). Shapes skip setup segments (cd, set, mkdir, export, source).`,
		"",
	);
	const CM = 15;
	if (!sh.crystallisation.length) push("- none");
	else {
		push("| shape | trees | calls | error rate |", "|---|---|---|---|");
		for (const x of sh.crystallisation.slice(0, CM))
			push(`| \`${mdCell(x.shape)}\` | ${x.trees} | ${x.calls} | ${x.errorRate ?? "-"} |`);
	}
	push(...more(sh.crystallisation.length, CM));
	if (sh.primitivesHidden.length)
		push(
			`- ${sh.primitivesHidden.length} generic primitive shapes hidden (fewer than ${d.config.crystallisePrimitiveMinCallsPerTree} calls per tree): ${sh.primitivesHidden
				.slice(0, 8)
				.map((x) => `\`${x}\``)
				.join(", ")}${sh.primitivesHidden.length > 8 ? ", …" : ""}`,
		);
	push("");
	push("Top erroring shapes (failure = isError, or non-zero exitCode when recorded):", "");
	if (!sh.topErroring.length) push("- none");
	for (const x of sh.topErroring.slice(0, 10))
		push(
			`- \`${x.shape}\`: ${x.failures}/${x.calls} failed, ${x.trees} trees${
				Object.keys(x.exitCodes).length
					? `, exit codes ${Object.entries(x.exitCodes)
							.map(([k, v]) => `${k}:${v}`)
							.join(" ")}`
					: ""
			}`,
		);
	push(...more(sh.topErroring.length, 10), "");
	push("Top discovery shapes (heuristic; setup, credential and syntax probes only):", "");
	if (!sh.topDiscovery.length) push("- none");
	for (const x of sh.topDiscovery.slice(0, 10))
		push(`- \`${x.shape}\` (${x.kinds.join("/")}): ${x.discoveryCalls} calls, ${x.trees} trees`);
	push(...more(sh.topDiscovery.length, 10), "");

	push("## Skills", "");
	const su = d.crossSession.skills;
	push(
		`skillsAvailable known for ${su.runsWithSkillsAvailableKnown}/${d.overview.runs} runs. Loads include reads of SKILL.md through read tools or shell (\`inferred\` when the adapter emitted no skill_load event). Chars are tool output from the skill's directory.`,
		"",
	);
	const loadedSkills = su.usage.filter((x) => x.loads || x.blockedLoads || x.chars);
	if (!loadedSkills.length) push("- no skill loads recorded");
	else {
		push(
			"| skill | loads | in subagents | inferred | blocked repeats | chars | trees | runs loading >1x | via |",
			"|---|---|---|---|---|---|---|---|---|",
		);
		for (const x of loadedSkills.slice(0, 20))
			push(
				`| ${mdCell(x.skill)}${x.listedInRuns === 0 && x.availableInRuns ? " (unlisted)" : ""} | ${x.loads} | ${x.subagentLoads} | ${x.inferredLoads} | ${x.blockedLoads} | ${fmtK(x.chars)} | ${x.trees} | ${x.runsLoadedMultiple} | ${mdCell(
					Object.entries(x.via)
						.map(([k, v]) => `${k}:${v}`)
						.join(" "),
				)} |`,
			);
	}
	push(...more(loadedSkills.length, 20));
	push(
		`- Available but never loaded (${su.neverLoaded.length}): ${
			su.neverLoaded
				.slice(0, 25)
				.map((x) => `${x.skill}${x.manualOnly ? " (manual-only)" : ""}`)
				.join(", ") || "-"
		}${su.neverLoaded.length > 25 ? ` …and ${su.neverLoaded.length - 25} more` : ""}`,
		"",
	);

	push("## Delegation", "");
	const ds = d.crossSession.delegation;
	push(
		`- ${ds.total} delegations (${ds.linked} linked, ${ds.unlinked} unlinked); modes: ${
			Object.entries(ds.byMode)
				.map(([k, v]) => `${k} ${v}`)
				.join(", ") || "-"
		}`,
	);
	push(
		`- Child share of total cost: ${ds.childCostShare == null ? "-" : Math.round(ds.childCostShare * 100) + "%"}; per tree median ${ds.perTree.median ?? "-"}, max ${ds.perTree.max}; ${ds.perTree.treesWithDelegation}/${d.overview.trees} trees delegate`,
	);
	push(
		`- Median prompt chars ${ds.promptChars.median ?? "-"}; median result chars ${ds.resultChars.median ?? "-"} over ${ds.resultChars.known} delegations with a known result (${ds.resultChars.reported} adapter-reported). ${ds.backgroundWithoutResult} non-foreground delegations have no result size; launch acknowledgements are not counted as results.`,
	);
	if (ds.childRunsWithoutDelegation.length)
		push(
			`- Child runs with no matching delegation event: ${ds.childRunsWithoutDelegation.length} (e.g. ${ds.childRunsWithoutDelegation.slice(0, 5).join(", ")})`,
		);
	push("");
	const DM = 15;
	if (d.delegations.length) {
		push(
			"| parent ref | mode | child | agentType | prompt chars | child cost | child turns | result chars |",
			"|---|---|---|---|---|---|---|---|",
		);
		const dl = [...d.delegations].sort(
			(a, b) => (b.childCost ?? -1) - (a.childCost ?? -1) || cmpStr(a.runId, b.runId) || a.seq - b.seq,
		);
		for (const x of dl.slice(0, DM))
			push(
				`| ${refStr(x)} | ${x.mode ?? "-"} | ${x.childFound ? x.childRunId : "NOT FOUND"} | ${x.childAgentType ?? "-"} | ${x.promptChars ?? "-"} | ${fmtCost(x.childCost ?? null)} | ${x.childTurns ?? "-"} | ${x.resultChars ?? (x.launchAckChars != null ? `n/a (ack ${x.launchAckChars})` : "-")} |`,
			);
		push(...more(d.delegations.length, DM), "");
	}

	push("## Cohorts", "");
	push(
		`Medians per tree. Cohorts with fewer than ${d.config.cohortMinTrees} trees are marked insufficient; do not draw conclusions from them.`,
		"",
	);
	const co = d.crossSession.cohorts;
	const cohortTable = (title, rows, note) => {
		if (!rows) {
			push(`- ${title}: ${note}`);
			return;
		}
		if (rows.length < 2) {
			push(
				`- ${title}: one cohort only (${clip(oneLine(rows[0]?.key ?? "-"), 80)}, ${rows[0]?.trees ?? 0} trees); no comparison possible.`,
			);
			return;
		}
		push(
			"",
			`${title}:`,
			"",
			"| cohort | trees | cost | turns | skill loads | skill chars | tool out | flags | tool failures | cache hit |",
			"|---|---|---|---|---|---|---|---|---|---|",
		);
		for (const x of rows.slice(0, 10)) {
			const m = x.median;
			push(
				`| ${mdCell(clip(x.key, 70))}${x.insufficient ? " (insufficient)" : ""} | ${x.trees} | ${fmtCost(m.cost)} | ${m.turns ?? "-"} | ${m.skillLoads ?? "-"} | ${fmtK(m.skillChars)} | ${fmtK(m.outputChars)} | ${m.flags ?? "-"} | ${m.toolFailures ?? "-"} | ${m.cacheHitRatio ?? "-"} |`,
			);
		}
		push(...more(rows.length, 10));
	};
	cohortTable("By harnessFeatures (union over tree)", co.features);
	cohortTable(
		"By time (--cutover)",
		co.time,
		"no cutovers given; pass `--cutover ISO[,ISO…]` to compare before/after a change.",
	);
	cohortTable("By instruction content hashes", co.instructions, "no instruction contentHash recorded in the bundle.");
	push("");

	push("## Data quality", "");
	const q = d.dataQuality;
	if (q.selection && q.selection.scanned != null)
		push(
			`- Selection: scanned ${q.selection.scanned}, selected ${q.selection.selected ?? "?"}, excluded ${q.selection.excluded ?? "?"}`,
		);
	else
		push(
			'- Selection counts (scanned/selected/excluded) not recorded; "no runs" cannot be told apart from "filtered out".',
		);
	push(
		`- tool_result durationMs null: ${q.durationNull}/${q.toolResults} (${pct(q.toolResults ? q.durationNull / q.toolResults : null)}); shell-like results with exitCode null: ${q.shellExitCodeNull}/${q.shellResults} (${pct(q.shellResults ? q.shellExitCodeNull / q.shellResults : null)})`,
	);
	if (q.zeroCounts.length)
		push(
			`- Zero events of: ${q.zeroCounts.join(", ")}. Real absence or an adapter gap? Check before answering questions that depend on them${q.abortedTurns && q.zeroCounts.includes("abandoned branch") ? ` (${q.abortedTurns} aborted turns exist)` : ""}.`,
		);
	if (q.agentLikeHumanMessages)
		push(
			`- ${q.agentLikeHumanMessages} origin=human messages look agent- or harness-originated (command expansion, orchestrator prefix); excluded from user_correction.`,
		);
	if (q.subagentRunsWithEmptyInstructions)
		push(
			`- ${q.subagentRunsWithEmptyInstructions} subagent runs have context.instructions = [] (claims none; null would mean unknown).`,
		);
	if (q.inferredSkillLoads)
		push(`- ${q.inferredSkillLoads} skill loads inferred from reads/shell reads of SKILL.md with no skill_load event.`);
	if (q.outputCeiling)
		push(
			`- ${q.outputCeiling.count} large outputs from different commands/files are ≈${fmtK(q.outputCeiling.chars)} chars, the largest size seen: likely a tool truncation ceiling that hides true size.`,
		);
	push("");

	push("## Data gaps", "");
	const w = d.dataGaps.manifestWarnings;
	push(`Manifest warnings (${w.length}):`, "");
	if (!w.length) push("- none");
	for (const x of w.slice(0, 15)) push(`- ${clip(oneLine(x), 300)}`);
	push(...more(w.length, 15), "");
	const rn = d.dataGaps.runNotes;
	push(`Run notes (${rn.length}):`, "");
	const noteCounts = {};
	for (const x of rn) inc(noteCounts, x.note);
	const nc = Object.entries(noteCounts).sort((a, b) => b[1] - a[1] || cmpStr(a[0], b[0]));
	if (!nc.length) push("- none");
	for (const [k, v] of nc.slice(0, 10)) push(`- ${v}x ${clip(oneLine(k), 200)}`);
	push(...more(nc.length, 10), "");
	push("Nulls and anomalies encountered (counts):", "");
	const gc = Object.entries(d.dataGaps.counters);
	if (!gc.length) push("- none");
	for (const [k, v] of gc.slice(0, 25)) push(`- ${k}: ${v}`);
	push(...more(gc.length, 25), "");
	return L.join("\n");
}

// Plain-text context table for one tree or the corpus.
export function renderContext(d, treeId) {
	const L = [];
	if (treeId) {
		const t = d.trees.find((x) => x.rootId === treeId || x.rootId.startsWith(treeId));
		if (!t) throw new Error(`tree not found: ${treeId}`);
		L.push(`tree ${t.rootId} ${clip(treeLabel(t), 60)}: ${fmtK(t.context.totalChars)} chars of tool output`);
		const rows = d.runs.filter((r) => t.runIds.includes(r.id));
		const agg = {};
		for (const r of rows)
			for (const [cat, b] of Object.entries(r.metrics.context.byCategory)) {
				const o = (agg[cat] ??= { chars: 0, results: 0, carriedTokens: 0, byKind: {} });
				o.chars += b.chars;
				o.results += b.results;
				o.carriedTokens += b.carriedTokens;
				inc(o.byKind, r.kind === "subagent" ? "subagent" : r.kind === "peer" ? "peer" : "primary", b.chars);
			}
		const total = t.context.totalChars;
		for (const [cat, o] of Object.entries(agg).sort((a, b) => b[1].chars - a[1].chars))
			L.push(
				`${cat.padEnd(32)} ${fmtK(o.chars).padStart(7)} ${pct(total ? o.chars / total : null).padStart(6)}  results ${o.results}  carried ${fmtK(o.carriedTokens)}  ${Object.entries(
					o.byKind,
				)
					.map(([k, v]) => `${k} ${fmtK(v)}`)
					.join(" ")}`,
			);
		return L.join("\n");
	}
	const c = d.contextBySource;
	L.push(
		`corpus: ${fmtK(c.totalChars)} chars of tool output (${Object.entries(c.byKindTotal)
			.map(([k, v]) => `${k} ${fmtK(v)}`)
			.join(", ")})`,
	);
	for (const g of c.groups)
		L.push(
			`group ${g.group.padEnd(26)} ${fmtK(g.chars).padStart(7)} ${pct(g.share).padStart(6)}  ${Object.entries(g.byKind)
				.map(([k, v]) => `${k} ${fmtK(v)}`)
				.join(" ")}`,
		);
	for (const r of c.rows)
		L.push(
			`${r.category.padEnd(32)} ${fmtK(r.chars).padStart(7)} ${pct(r.share).padStart(6)}  results ${r.results}  carried ${fmtK(r.carriedTokens)}  trees ${r.trees}  ${Object.entries(
				r.byKind,
			)
				.map(([k, v]) => `${k} ${fmtK(v)}`)
				.join(" ")}`,
		);
	return L.join("\n");
}

// ---------------------------------------------------------------------------
// show: one line per event
// ---------------------------------------------------------------------------
function fmtArgs(args, full) {
	if (!args || typeof args !== "object") return "";
	return Object.entries(args)
		.map(([k, v]) => {
			let s = typeof v === "string" ? JSON.stringify(oneLine(v)) : oneLine(JSON.stringify(v));
			if (!full) s = clip(s, 120);
			return `${k}=${s}`;
		})
		.join(" ");
}
export function renderEvent(ev, full) {
	const T = (s) => {
		const x = oneLine(s);
		return JSON.stringify(full ? x : clip(x, 200));
	};
	const u = (x) => (x == null ? "-" : typeof x === "number" ? round(x, 6) : x);
	const id = (x) => (x == null ? "-" : full || String(x).length <= 24 ? x : `${String(x).slice(0, 23)}…`);
	const p = [`#${ev.seq}`, ev.ts ?? "-", ev.type];
	if (ev.branch === "abandoned") p.push("[abandoned]");
	switch (ev.type) {
		case "user":
			p.push(`origin=${u(ev.origin)}`, `chars=${u(ev.textChars)}`, T(ev.text));
			break;
		case "assistant": {
			const us = ev.usage || {};
			p.push(
				u(ev.model),
				`stop=${u(ev.stopReason)}`,
				`in=${u(us.input)} out=${u(us.output)} cr=${u(us.cacheRead)} cw=${u(us.cacheWrite)} rs=${u(us.reasoning)} cost=${u(us.cost)}`,
				`ctx=${u(ev.contextTokens)}`,
				`think=${u(ev.thinkingChars)}`,
				`calls=${Array.isArray(ev.toolCallIds) ? ev.toolCallIds.length : "-"}`,
			);
			if (ev.error) p.push(`error=${T(ev.error)}`);
			if (ev.text) p.push(`chars=${u(ev.textChars)}`, T(ev.text));
			break;
		}
		case "tool_call":
			p.push(
				u(ev.name),
				`id=${id(ev.callId)}`,
				`hash=${String(ev.argsHash ?? "-").slice(0, 10)}`,
				full ? fmtArgs(ev.args, true) : clip(fmtArgs(ev.args, false), 300),
			);
			break;
		case "tool_result":
			p.push(
				u(ev.name),
				`id=${id(ev.callId)}`,
				ev.isError ? `ERR(${u(ev.errorClass)})` : "ok",
				`chars=${u(ev.outputChars)}`,
				`dur=${ev.durationMs == null ? "-" : ev.durationMs + "ms"}`,
			);
			if (ev.nestedUsage) p.push(`nestedCost=${u(ev.nestedUsage.cost)}`);
			p.push(T(ev.output));
			break;
		case "skill_load":
			p.push(u(ev.skill), `via=${u(ev.via)}`, ev.blocked ? "BLOCKED" : "loaded", u(ev.path));
			break;
		case "instruction_load":
			p.push(u(ev.source), `chars=${u(ev.chars)}`, `trigger=${u(ev.trigger)}`);
			break;
		case "delegation":
			p.push(
				`mode=${u(ev.mode)}`,
				`child=${u(ev.childRunId)}`,
				`call=${id(ev.callId)}`,
				`promptChars=${u(ev.promptChars)}`,
				ev.description ? `desc=${T(ev.description)}` : "",
				T(ev.prompt),
			);
			break;
		case "context_reset":
			p.push(`kind=${u(ev.kind)}`, `tokensBefore=${u(ev.tokensBefore)}`, `summaryChars=${u(ev.summaryChars)}`);
			break;
		case "retry":
			p.push(`reason=${T(ev.reason)}`, `attempt=${u(ev.attempt)}`);
			break;
		case "model_change":
			p.push(u(ev.model), `thinking=${u(ev.thinkingLevel)}`);
			break;
		case "note":
			p.push(`kind=${u(ev.kind)}`, T(JSON.stringify(ev.data ?? null)));
			break;
		default:
			p.push(T(JSON.stringify(ev)));
	}
	if (ev.ref) p.push(`ref=${ev.ref}`);
	return p.filter((x) => x !== "").join(" ");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
	const pos = [];
	const opt = {};
	const valued = new Set(["--out", "--config", "--cutover", "--type", "--tree", "--run", "--limit"]);
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--full") opt.full = true;
		else if (valued.has(a)) {
			if (argv[i + 1] == null) throw new Error(`${a} needs a value`);
			opt[a.slice(2)] = argv[++i];
		} else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
		else pos.push(a);
	}
	return { pos, opt };
}
const USAGE = `usage:
  node digest.mjs analyse <bundleDir> --out <dir> [--config thresholds.json] [--cutover ISO[,ISO…]]
  node digest.mjs show <bundleDir> <runId> [fromSeq] [toSeq] [--full]
  node digest.mjs runs <bundleDir> [--config thresholds.json]
  node digest.mjs flags <bundleDir> [--type T[,T…]] [--tree ID] [--run ID] [--limit N] [--out dir] [--config f]
  node digest.mjs context <bundleDir> [--tree ID] [--out dir] [--config f]
  (flags/context read <out>/digest.json when present, otherwise recompute; IDs match by prefix)`;

function configFromOpts(opt) {
	const cfg = loadConfig(opt.config);
	if (opt.cutover) {
		const cs = opt.cutover
			.split(",")
			.map((x) => x.trim())
			.filter(Boolean);
		for (const c of cs) if (tsMs(c) == null) throw new Error(`--cutover: not an ISO timestamp: ${c}`);
		cfg.cutovers = cs;
	}
	return cfg;
}
async function loadDigest(bundleDir, opt) {
	const f = opt.out ? path.join(opt.out, "digest.json") : null;
	if (f && fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
	return analyseBundle(bundleDir, configFromOpts(opt));
}
export function selectFlags(flags, { type, tree, run, limit } = {}) {
	const types = type
		? new Set(
				String(type)
					.split(",")
					.map((x) => x.trim()),
			)
		: null;
	const sel = flags
		.filter(
			(f) => (!types || types.has(f.type)) && (!tree || f.rootId.startsWith(tree)) && (!run || f.runId.startsWith(run)),
		)
		.sort(
			(a, b) =>
				(b.impact?.estCost ?? -1) - (a.impact?.estCost ?? -1) ||
				SEV[b.severity] - SEV[a.severity] ||
				cmpStr(a.id, b.id),
		);
	const n = limit != null ? Number(limit) : 50;
	return { shown: sel.slice(0, n), total: sel.length };
}

async function main() {
	const [cmd, ...rest] = process.argv.slice(2);
	const { pos, opt } = parseArgs(rest);
	if (cmd === "analyse" || cmd === "analyze") {
		if (!pos[0] || !opt.out) throw new Error(USAGE);
		const t0 = performance.now();
		const d = await analyseBundle(pos[0], configFromOpts(opt));
		fs.mkdirSync(opt.out, { recursive: true });
		fs.writeFileSync(path.join(opt.out, "digest.json"), JSON.stringify(d, null, 1) + "\n");
		const md = renderMd(d);
		fs.writeFileSync(path.join(opt.out, "digest.md"), md + "\n");
		const o = d.overview;
		console.log(
			`digest: ${o.trees} trees, ${o.runs} runs, ${o.events} events, cost ${fmtCost(o.usage.cost)}, ${o.flags} flags (${o.flagSeverity.high} high, ${o.flagSeverity.med} med), ${Object.keys(d.dataGaps.counters).length} gap kinds -> ${path.join(opt.out, "digest.md")} (${md.split("\n").length} lines) in ${Math.round(performance.now() - t0)}ms`,
		);
	} else if (cmd === "flags") {
		if (!pos[0]) throw new Error(USAGE);
		const d = await loadDigest(pos[0], opt);
		const { shown, total } = selectFlags(d.flags, opt);
		for (const f of shown) console.log(flagLine(f));
		console.log(
			`(${shown.length} of ${total} matching flags${total > shown.length ? "; raise --limit for more" : ""})`,
		);
	} else if (cmd === "context") {
		if (!pos[0]) throw new Error(USAGE);
		const d = await loadDigest(pos[0], opt);
		console.log(renderContext(d, opt.tree));
	} else if (cmd === "show") {
		const [dir, runId, from, to] = pos;
		if (!dir || !runId) throw new Error(USAGE);
		const f = runFile(dir, runId);
		if (!fs.existsSync(f)) throw new Error(`run file not found: ${f}`);
		const lo = from != null ? Number(from) : -Infinity,
			hi = to != null ? Number(to) : from != null ? Number(from) : Infinity;
		const gap = () => {};
		for await (const ev of readEvents(f, gap)) {
			if (typeof ev.seq === "number" && (ev.seq < lo || ev.seq > hi)) continue;
			process.stdout.write(renderEvent(ev, !!opt.full) + "\n");
		}
	} else if (cmd === "runs") {
		if (!pos[0]) throw new Error(USAGE);
		const d = await analyseBundle(pos[0], configFromOpts(opt));
		const byId = new Map(d.runs.map((r) => [r.id, r]));
		const kids = new Map();
		for (const r of d.runs)
			if (r.parentId && byId.has(r.parentId)) {
				if (!kids.has(r.parentId)) kids.set(r.parentId, []);
				kids.get(r.parentId).push(r);
			}
		for (const [, ks] of kids)
			ks.sort((a, b) => cmpStr(a.metrics.startedAt ?? "", b.metrics.startedAt ?? "") || cmpStr(a.id, b.id));
		const line = (r, depth) => {
			const fc = Object.values(r.flagCounts).reduce((a, b) => a + b, 0);
			console.log(
				`${"  ".repeat(depth)}${r.id} [${r.kind ?? "?"}${r.agentType ? ":" + r.agentType : ""}${r.link?.confidence === "inferred" ? ",inferred" : ""}] ${clip(oneLine(r.label ?? (r.firstMessage ? `“${r.firstMessage}”` : "-")), 60)} | ${r.metrics.startedAt?.slice(0, 16) ?? "-"} | cost ${fmtCost(r.metrics.usage.cost)} | turns ${r.metrics.turns} | flags ${fc}`,
			);
			for (const k of kids.get(r.id) || []) line(k, depth + 1);
		};
		for (const t of d.trees) {
			const r = byId.get(t.rootId);
			console.log(
				`== tree ${t.rootId}: cost ${fmtCost(t.usage.cost)}, ${t.runs} runs, ${t.turns} turns, ${t.flagTotal} flags`,
			);
			line(r, 1);
		}
	} else {
		console.error(USAGE);
		process.exitCode = 2;
	}
}

if (
	process.argv[1] &&
	fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(new URL(import.meta.url).pathname)
) {
	main().catch((e) => {
		console.error(`error: ${e.message}`);
		process.exitCode = 1;
	});
}
