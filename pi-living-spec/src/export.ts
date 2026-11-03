import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { routeMatches, type Sitemap } from "./crawl.js";
import type { Entity, LedgerData, Requirement } from "./ledger.js";
import type { SourceMap } from "./source-scan.js";
import type { SpecConfig, Workspace } from "./workspace.js";

const KIND_LABEL: Record<string, string> = {
	functional: "Functional",
	ui: "UI / UX",
	data: "Data",
	integration: "Integration",
	auth: "Auth & permissions",
	"business-rule": "Business rule",
	nfr: "Non-functional",
	question: "Question",
};
const STATUS_BADGE: Record<string, string> = {
	observed: "✅ observed",
	inferred: "🔎 inferred",
	mocked: "🧪 mocked in prototype",
	assumed: "❓ assumed",
};

function esc(s: string): string {
	return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function gitInfo(repo?: string): string | undefined {
	if (!repo) return undefined;
	try {
		const sha = execFileSync("git", ["-C", repo, "rev-parse", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		const date = execFileSync("git", ["-C", repo, "log", "-1", "--format=%cs"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		return `commit ${sha} (${date})`;
	} catch {
		return undefined;
	}
}

function mermaidName(s: string): string {
	return s.replace(/[^A-Za-z0-9_]/g, "_");
}

function erDiagram(entities: Entity[]): string {
	if (!entities.length) return "";
	const L = ["```mermaid", "erDiagram"];
	for (const e of entities) {
		L.push(`  ${mermaidName(e.name)} {`);
		for (const f of e.fields.slice(0, 25)) {
			const type = f.type.match(/^[A-Za-z_][A-Za-z0-9_]*/)?.[0] ?? "string";
			L.push(`    ${type} ${mermaidName(f.name)}${f.required ? ' "required"' : ""}`);
		}
		L.push("  }");
	}
	const card: Record<string, string> = {
		"one-to-one": "||--||",
		"one-to-many": "||--o{",
		"many-to-one": "}o--||",
		"many-to-many": "}o--o{",
	};
	const drawn = new Set<string>();
	for (const e of entities) {
		for (const r of e.relations) {
			if (!entities.some((x) => x.name.toLowerCase() === r.to.toLowerCase())) continue;
			const pair = [e.name.toLowerCase(), r.to.toLowerCase()].sort().join("|") + (r.via ?? "");
			if (drawn.has(pair)) continue;
			drawn.add(pair);
			L.push(`  ${mermaidName(e.name)} ${card[r.kind] ?? "||--o{"} ${mermaidName(r.to)} : "${(r.via ?? r.kind).replace(/"/g, "'")}"`);
		}
	}
	L.push("```");
	return L.join("\n");
}

function reqBlock(r: Requirement): string[] {
	const L = [`#### ${r.id} — ${r.title}`, "", `_${KIND_LABEL[r.kind] ?? r.kind} · priority: ${r.priority} · ${STATUS_BADGE[r.status] ?? r.status}_`, "", r.statement, ""];
	if (r.acceptance.length) {
		L.push("**Acceptance criteria**", "");
		for (const a of r.acceptance) L.push(`- ${a}`);
		L.push("");
	}
	if (r.assumption) L.push(`**Working assumption:** ${r.assumption}`, "");
	if (r.notes) L.push(`**Notes:** ${r.notes}`, "");
	if (r.related?.length) L.push(`**Related:** ${r.related.join(", ")}`, "");
	if (r.evidence.length) L.push(`<sub>Evidence: ${r.evidence.map((e) => `\`${e}\``).join(", ")}</sub>`, "");
	return L;
}

export function renderMarkdown(
	ledger: LedgerData,
	opts: { config: SpecConfig; sitemap?: Sitemap; sourceMap?: SourceMap; link?: (cwdRelPath: string) => string },
): string {
	const { config, sitemap, sourceMap } = opts;
	const reqs = ledger.requirements.filter((r) => r.kind !== "question");
	const questions = ledger.requirements.filter((r) => r.kind === "question");
	const name = ledger.project?.name ?? config.projectName ?? sourceMap?.product.title ?? "Product";
	const L: string[] = [];
	let sec = 0;
	const h2 = (title: string) => `## ${++sec}. ${title}`;

	L.push(`# ${name} — Requirements Specification`, "");
	L.push(`_Derived from the prototype ("living spec") on ${new Date().toISOString().slice(0, 10)}._`, "");
	L.push("| Source | Reference |", "|---|---|");
	if (config.baseUrl) L.push(`| Prototype URL | ${config.baseUrl} |`);
	if (config.repoPath) L.push(`| Prototype source | \`${config.repoPath}\`${gitInfo(sourceMap?.repo) ? ` @ ${gitInfo(sourceMap?.repo)}` : ""} |`);
	if (sitemap) L.push(`| Screens crawled | ${sitemap.pages.length} (${sitemap.crawledAt.slice(0, 10)}) |`);
	L.push("");
	L.push(
		"**How to read this document.** Each requirement carries a status: ✅ _observed_ – seen working in the prototype; 🔎 _inferred_ – implied by the prototype's code, data or UI but not demonstrably working; 🧪 _mocked_ – the prototype shows the UI but fakes the behaviour (hard-coded data, no-op buttons), so the real behaviour must be built and confirmed; ❓ _assumed_ – our assumption, to be confirmed by the client. The prototype is the reference for **what** the product does, not **how** it must be built.",
		"",
	);

	// Overview
	if (ledger.project?.summary || ledger.project?.users?.length || ledger.project?.goals?.length) {
		L.push(h2("Overview"), "");
		if (ledger.project.summary) L.push(ledger.project.summary, "");
		if (ledger.project.users?.length) {
			L.push("**User roles**", "");
			for (const u of ledger.project.users) L.push(`- ${u}`);
			L.push("");
		}
		if (ledger.project.goals?.length) {
			L.push("**Goals**", "");
			for (const g of ledger.project.goals) L.push(`- ${g}`);
			L.push("");
		}
	}

	const c = {
		total: reqs.length,
		byStatus: Object.fromEntries(["observed", "inferred", "mocked", "assumed"].map((s) => [s, reqs.filter((r) => r.status === s).length])),
		byPriority: Object.fromEntries(["must", "should", "could", "wont", "unknown"].map((p) => [p, reqs.filter((r) => r.priority === p).length])),
	};
	L.push(h2("Summary"), "");
	L.push(`${c.total} requirements across ${ledger.areas.length} feature areas, ${ledger.entities.length} data entities, ${questions.length} open questions.`, "");
	L.push("| Area | Requirements | Must | Mocked in prototype |", "|---|---|---|---|");
	const areas = [...ledger.areas].sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
	for (const a of areas) {
		const rs = reqs.filter((r) => r.area === a.code);
		L.push(`| ${a.code} — ${a.name} | ${rs.length} | ${rs.filter((r) => r.priority === "must").length} | ${rs.filter((r) => r.status === "mocked").length} |`);
	}
	L.push("");

	// Screens
	const screenRows: { path: string; title: string; shot?: string; notes: string }[] = [];
	if (sitemap) {
		for (const p of sitemap.pages) {
			screenRows.push({
				path: p.requested,
				title: p.headings[0]?.replace(/^h\d: /, "") || p.title || "",
				shot: p.screenshot,
				notes: [p.redirectedTo ? `redirects to ${p.redirectedTo}` : "", p.notFound ? "404" : "", p.error ? `error: ${p.error}` : ""].filter(Boolean).join("; "),
			});
		}
	}
	if (sourceMap) {
		for (const r of sourceMap.routes) {
			if (r.path === "/*") continue;
			if (!screenRows.some((s) => routeMatches(r.path, s.path))) screenRows.push({ path: r.path, title: r.component ?? "", notes: `not crawled${r.guards.length ? `; guarded by ${r.guards.join(", ")}` : ""}` });
		}
	}
	if (screenRows.length) {
		L.push(h2("Screen inventory"), "", "| Route | Screen | Requirements | Notes |", "|---|---|---|---|");
		for (const s of screenRows) {
			const ids = reqs.filter((r) => r.evidence.some((e) => e === s.path || e.startsWith(`${s.path} `) || e.startsWith(`route:${s.path}`) || e.includes(`${s.path}#`) || e === `route ${s.path}`)).map((r) => r.id);
			const shot = s.shot ? ` [screenshot](${opts.link ? opts.link(s.shot) : s.shot})` : "";
			L.push(`| \`${s.path}\` | ${esc(s.title)}${shot} | ${ids.join(", ")} | ${esc(s.notes)} |`);
		}
		L.push("");
	}

	// Requirements by area
	L.push(h2("Requirements by feature area"), "");
	const reqSec = sec;
	const known = new Set(areas.map((a) => a.code));
	const orphanAreas = [...new Set(reqs.map((r) => r.area).filter((a) => !known.has(a)))].map((code) => ({ code, name: code, description: undefined as string | undefined }));
	let n = 0;
	for (const a of [...areas, ...orphanAreas]) {
		const rs = reqs.filter((r) => r.area === a.code && r.kind !== "nfr");
		if (!rs.length) continue;
		n++;
		L.push(`### ${reqSec}.${n} ${a.name} (${a.code})`, "");
		if (a.description) L.push(a.description, "");
		const order = ["functional", "business-rule", "auth", "ui", "data", "integration"];
		rs.sort((x, y) => order.indexOf(x.kind) - order.indexOf(y.kind) || x.id.localeCompare(y.id, undefined, { numeric: true }));
		for (const r of rs) L.push(...reqBlock(r));
	}

	// Data model
	L.push(h2("Data model"), "");
	if (!ledger.entities.length) L.push("_No entities recorded yet._", "");
	else {
		L.push(erDiagram(ledger.entities), "");
		for (const e of ledger.entities) {
			L.push(`### ${e.name}  _(${STATUS_BADGE[e.status] ?? e.status})_`, "");
			if (e.description) L.push(e.description, "");
			L.push("| Field | Type | Required | Notes |", "|---|---|---|---|");
			for (const f of e.fields) L.push(`| ${esc(f.name)} | ${esc(f.type)} | ${f.required ? "yes" : ""} | ${esc(f.notes ?? "")} |`);
			L.push("");
			if (e.relations.length) {
				L.push("Relationships:", "");
				for (const r of e.relations) L.push(`- ${r.kind} → **${r.to}**${r.via ? ` via \`${r.via}\`` : ""}${r.notes ? ` — ${r.notes}` : ""}`);
				L.push("");
			}
			if (e.rules.length) {
				L.push("Rules:", "");
				for (const r of e.rules) L.push(`- ${r}`);
				L.push("");
			}
			if (e.evidence.length) L.push(`<sub>Evidence: ${e.evidence.map((x) => `\`${x}\``).join(", ")}</sub>`, "");
		}
	}

	// NFRs
	const nfr = reqs.filter((r) => r.kind === "nfr");
	L.push(h2("Non-functional requirements"), "");
	if (!nfr.length) L.push("_None recorded._", "");
	for (const r of nfr) L.push(...reqBlock(r));

	// Gaps
	const mocked = reqs.filter((r) => r.status === "mocked");
	L.push(h2("Prototype gaps (mocked behaviour that must be built for real)"), "");
	if (!mocked.length) L.push("_None recorded._", "");
	else {
		L.push("| ID | Requirement | What the prototype does |", "|---|---|---|");
		for (const r of mocked) L.push(`| ${r.id} | ${esc(r.title)} | ${esc(r.notes ?? "UI only / faked")} |`);
		L.push("");
	}

	// Questions
	L.push(h2("Open questions for the client"), "");
	if (!questions.length) L.push("_None._", "");
	else {
		L.push("| ID | Area | Question | Working assumption | Blocks |", "|---|---|---|---|---|");
		for (const q of questions) L.push(`| ${q.id} | ${q.area} | ${esc(q.statement)} | ${esc(q.assumption ?? "")} | ${(q.related ?? []).join(", ")} |`);
		L.push("");
	}

	// Traceability
	L.push(h2("Traceability"), "", "| Requirement | Evidence |", "|---|---|");
	for (const r of reqs) L.push(`| ${r.id} | ${esc(r.evidence.join(", "))} |`);
	L.push("");
	return L.join("\n");
}

export function renderCsv(ledger: LedgerData): string {
	const cols = ["id", "area", "kind", "title", "statement", "acceptance", "priority", "status", "evidence", "assumption", "notes"];
	const cell = (v: unknown) => {
		const s = Array.isArray(v) ? v.join(" | ") : v === undefined || v === null ? "" : String(v);
		return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
	};
	const rows = ledger.requirements.map((r) => cols.map((c) => cell((r as unknown as Record<string, unknown>)[c])).join(","));
	return `${cols.join(",")}\n${rows.join("\n")}\n`;
}

export function exportAll(ws: Workspace, ledger: LedgerData, config: SpecConfig, formats: ("md" | "csv" | "json")[], outPath?: string): string[] {
	const sitemap = ws.readJson<Sitemap | undefined>("crawl/sitemap.json", undefined);
	const sourceMap = ws.readJson<SourceMap | undefined>("source-map.json", undefined);
	const written: string[] = [];
	for (const f of formats) {
		if (f === "md") {
			const target = outPath && outPath.endsWith(".md") ? resolve(ws.cwd, outPath) : ws.path("REQUIREMENTS.md");
			const link = (p: string) => relative(dirname(target), join(ws.cwd, p)).split("\\").join("/");
			const md = renderMarkdown(ledger, { config, sitemap, sourceMap, link });
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, md, "utf8");
			written.push(target);
		} else if (f === "csv") written.push(ws.writeText("requirements.csv", renderCsv(ledger)));
		else written.push(ws.writeJson("requirements.json", ledger));
	}
	return written;
}
