/**
 * pi-living-spec — turn a Lovable (or any web) prototype into a requirements spec.
 *
 * Tools (callable by the model):
 *   spec_scan_source  static analysis of the prototype's code (routes, screens, forms, data model, auth, stubs)
 *   spec_crawl        visit every reachable screen in a headless browser; outlines + screenshots + API calls
 *   spec_browse       drive the app step by step (click, fill, select…) to exercise flows; writes are intercepted
 *   spec_requirement  structured requirements ledger (stable IDs, evidence, status, priority, questions)
 *   spec_entity       data-model ledger (entities, fields, relations, rules)
 *   spec_export       render REQUIREMENTS.md / CSV / JSON from the ledger
 *
 * Commands (for the human):
 *   /spec <url> [repo]   configure and start the guided extraction workflow
 *   /spec-status         progress summary
 *   /spec-export [fmt]   write the deliverables
 *   /spec-writes <mode>  fake | block | off — how mutating requests are handled while exploring
 *   /spec-login [url]    open a visible browser to log in once; the session is reused headlessly
 *   /spec-close          close the browser
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type BrowseAction, type BrowseResult, SpecBrowser, shortUrl } from "./browser.js";
import { crawl, renderApiInventory, routeMatches } from "./crawl.js";
import { exportAll } from "./export.js";
import { KINDS, Ledger, PRIORITIES, STATUSES } from "./ledger.js";
import { renderSourceMap, type SourceMap, scanSource } from "./source-scan.js";
import { clip } from "./text.js";
import { type WriteGuard, Workspace } from "./workspace.js";

const ACTIONS = [
	"open", "snapshot", "click", "fill", "select", "check", "uncheck", "hover", "press", "upload",
	"back", "forward", "reload", "scroll", "wait", "screenshot", "viewport",
] as const;

interface State {
	ws: Workspace;
	browser: SpecBrowser;
	ledger: Ledger;
}

export default function livingSpec(pi: ExtensionAPI) {
	let state: State | undefined;

	const get = (cwd: string): State => {
		if (!state || state.ws.cwd !== cwd) {
			void state?.browser.close();
			const ws = new Workspace(cwd);
			state = { ws, browser: new SpecBrowser(ws), ledger: new Ledger(ws) };
		}
		return state;
	};

	const updateStatus = (ctx: ExtensionContext) => {
		if (!state) return;
		const c = state.ledger.counts();
		if (c.requirements + c.questions + c.entities === 0) return;
		ctx.ui?.setStatus?.("living-spec", `spec: ${c.requirements} reqs · ${c.entities} entities · ${c.questions} Qs`);
	};

	const text = (t: string) => [{ type: "text" as const, text: t }];

	pi.on("session_start", async (_e, ctx) => {
		const s = get(ctx.cwd);
		if (s.ledger.reload().counts().requirements > 0) updateStatus(ctx);
	});
	pi.on("session_shutdown", async () => {
		await state?.browser.close();
	});

	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "spec_scan_source",
		label: "Scan prototype source",
		description:
			"Statically analyse the prototype's source code (Lovable GitHub sync / ZIP export, or any Vite/React/TanStack/Next app). " +
			"Extracts routes, per-screen headings/buttons/form fields/validation rules/navigation/toasts, Supabase tables, enums, RLS policies, " +
			"edge functions, auth calls, env var names, hard-coded mock data, stubbed handlers and TODOs. Writes .living-spec/source-map.{json,md}. " +
			"Never executes project code.",
		promptSnippet: "Analyse the prototype's source code into a source map (routes, screens, data model, auth, stubs)",
		promptGuidelines: [
			"Run spec_scan_source first whenever the prototype's source is available; its routes seed spec_crawl and it reveals data and rules the UI hides.",
		],
		parameters: Type.Object({
			repoPath: Type.Optional(Type.String({ description: "Path to the prototype repo. Defaults to the configured repoPath." })),
		}),
		async execute(_id, params, _signal, onUpdate, ctx) {
			const s = get(ctx.cwd);
			const repo = s.ws.resolveRepo(params.repoPath);
			if (!repo) throw new Error("No repoPath given and none configured. Pass repoPath, or run /spec <url> <repo>.");
			if (params.repoPath) s.ws.saveConfig({ repoPath: params.repoPath.replace(/^@/, "") });
			onUpdate?.({ content: text(`Scanning ${repo}…`), details: undefined });
			const sm = await scanSource(repo);
			s.ws.writeJson("source-map.json", sm);
			const md = renderSourceMap(sm);
			const mdPath = s.ws.writeText("source-map.md", md);
			const head = [
				`Source map written to ${s.ws.rel(mdPath)} (+ source-map.json).`,
				`${sm.routes.length} routes, ${sm.screens.length} screens analysed, ${sm.tables.length} tables, ${sm.edgeFunctions.length} edge functions, ${sm.mockData.length} hard-coded data sets, ${sm.stubs.length} stubs.`,
				"",
			].join("\n");
			return {
				content: text(head + clip(md, { savedAt: s.ws.rel(mdPath) })),
				details: undefined,
			};
		},
	});

	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "spec_crawl",
		label: "Crawl prototype",
		description:
			"Visit every reachable screen of the running prototype in a headless browser (same-origin links plus routes from the source map). " +
			"For each screen saves a full-page screenshot, a structured outline of what's visible and interactive, API calls made on load, " +
			"console errors and redirects (e.g. protected routes bouncing to login). Writes .living-spec/crawl/{sitemap.json,pages/*.md,screens/*,api-inventory.md}. " +
			"Logout links are never followed. Mutating requests are intercepted per the write guard.",
		promptSnippet: "Crawl the running prototype: per-screen outlines, screenshots, API calls, redirects",
		promptGuidelines: [
			"After spec_crawl, read the per-screen outline files it lists (and view screenshots with read when layout matters) before writing requirements for that screen.",
		],
		parameters: Type.Object({
			url: Type.Optional(Type.String({ description: "Start URL. Defaults to the configured baseUrl." })),
			maxPages: Type.Optional(Type.Number({ description: "Max screens to capture (default 40)." })),
			include: Type.Optional(Type.String({ description: "Regex; only crawl paths matching it." })),
			exclude: Type.Optional(Type.String({ description: "Regex; skip paths matching it." })),
			mobile: Type.Optional(Type.Boolean({ description: "Also capture a 390px-wide mobile screenshot of every screen." })),
			useSourceRoutes: Type.Optional(Type.Boolean({ description: "Seed with static routes from the source map (default true)." })),
		}),
		executionMode: "sequential",
		async execute(_id, params, signal, onUpdate, ctx) {
			const s = get(ctx.cwd);
			if (params.url && !s.ws.loadConfig().baseUrl) s.ws.saveConfig({ baseUrl: params.url });
			s.browser.refreshConfig();
			const sm = params.useSourceRoutes === false ? undefined : s.ws.readJson<SourceMap | undefined>("source-map.json", undefined);
			const seeds = sm?.routes.map((r) => r.path).filter((p) => p.startsWith("/")) ?? [];
			const map = await crawl(s.browser, s.ws, {
				startUrl: params.url,
				maxPages: params.maxPages,
				include: params.include,
				exclude: params.exclude,
				mobile: params.mobile,
				seeds,
				signal,
				onProgress: (m) => onUpdate?.({ content: text(`Crawling ${m}`), details: undefined }),
			});
			const L = [
				`Crawled ${map.pages.length} screens from ${map.baseUrl}. Sitemap: .living-spec/crawl/sitemap.json; API inventory: .living-spec/crawl/api-inventory.md`,
				"",
				"| Path | Title / h1 | Outline file | API calls | Notes |",
				"|---|---|---|---|---|",
			];
			for (const p of map.pages) {
				const notes = [
					p.redirectedTo ? `→ ${p.redirectedTo}` : "",
					p.notFound ? "404" : "",
					p.error ? `ERROR ${p.error}` : "",
					p.consoleErrors.length ? `${p.consoleErrors.length} console errors` : "",
					p.stats.forms ? `${p.stats.forms} form(s)` : "",
					p.stats.dialogs ? "dialog open" : "",
				].filter(Boolean).join("; ");
				L.push(`| ${p.requested} | ${(p.headings[0] ?? p.title).replace(/^h\d: /, "").replace(/\|/g, "/")} | ${p.outlineFile} | ${p.apiCalls.length} | ${notes} |`);
			}
			const unvisited = (sm?.routes ?? []).filter((r) => r.path !== "/*" && !map.pages.some((p) => routeMatches(r.path, p.requested) || routeMatches(r.path, p.path)));
			if (unvisited.length) {
				L.push("", `Routes from source not visited (dynamic params or unreachable): ${unvisited.map((r) => r.path).join(", ")}`);
				L.push("Visit dynamic ones with spec_browse by clicking through from a list screen.");
			}
			if (map.skipped.length) L.push("", `Skipped ${map.skipped.length} URLs (see sitemap.json).`);
			const ext = Object.keys(map.externalLinks);
			if (ext.length) L.push("", `External links: ${ext.slice(0, 20).join(", ")}`);
			return { content: text(clip(L.join("\n"))), details: undefined };
		},
	});

	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "spec_browse",
		label: "Browse prototype",
		description:
			"Drive the running prototype like a user to discover behaviour: open URLs, click, fill, select, check, press keys, upload dummy files, " +
			"scroll, change viewport (mobile/tablet/desktop) and take screenshots. Returns an outline of the page where interactive elements carry refs " +
			"like [e12]; pass a ref (preferred), visible text, or a Playwright selector (text=…, role=button[name=\"Save\"], css) as `target`. " +
			"After an action on the same page only the outline diff is returned (use action=snapshot for the full outline). " +
			"Reports navigation, toasts, browser dialogs, console errors and every API call; mutating requests (POST/PUT/PATCH/DELETE) are intercepted and " +
			"answered with a fake success by default, so forms can be submitted safely and their payloads become evidence for the data model.",
		promptSnippet: "Drive the prototype in a browser (click/fill/select/…); returns outline with [eN] refs, API calls, toasts",
		promptGuidelines: [
			"Use spec_browse to exercise each flow end to end (open dialogs, submit forms empty and filled to see validation, switch tabs, open menus) — a static crawl misses most behaviour.",
			"Target spec_browse actions with the [eN] refs from the most recent outline; refs can go stale after navigation, so take a snapshot if a ref is not found.",
			"Treat 'intercepted' writes reported by spec_browse as evidence of the data a form persists; they were not sent to the real backend.",
		],
		parameters: Type.Object({
			action: StringEnum(ACTIONS, { description: "What to do" }),
			url: Type.Optional(Type.String({ description: "For open: absolute URL or path relative to baseUrl." })),
			target: Type.Optional(Type.String({ description: "Element ref (e12), visible text, or Playwright selector. For wait: text to wait for." })),
			value: Type.Optional(Type.String({ description: "fill: text; select: option label; press: key (Enter, Escape, Tab…); upload: file name e.g. photo.png or data.csv; scroll: up|down|top|bottom; wait: ms; viewport: mobile|tablet|desktop|wide|WxH" })),
			screenshot: Type.Optional(Type.Boolean({ description: "Attach a screenshot after the action (costs tokens; use when layout/visual design matters)." })),
			fullPage: Type.Optional(Type.Boolean({ description: "Screenshot the full scrollable page instead of the viewport." })),
			full: Type.Optional(Type.Boolean({ description: "Return the full outline instead of a diff." })),
		}),
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const s = get(ctx.cwd);
			const r = await s.browser.perform({ ...params, action: params.action as BrowseAction });
			const body = formatBrowse(r, s.browser.origin);
			const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = text(
				clip(body, { maxBytes: 40 * 1024 }),
			);
			if (r.screenshotJpeg) content.push({ type: "image", data: r.screenshotJpeg.toString("base64"), mimeType: "image/jpeg" });
			return {
				content,
				details: { url: r.url, ok: r.ok, screenshot: r.screenshotPath },
				isError: !r.ok,
			};
		},
	});

	// -------------------------------------------------------------------------
	const ReqItem = Type.Object({
		area: Type.String({ description: "Feature area, short code or name (e.g. AUTH, Projects, Billing). Becomes the ID prefix." }),
		kind: StringEnum(KINDS),
		title: Type.String({ description: "Short name, e.g. 'Create project'" }),
		statement: Type.String({ description: "The requirement in 'When/While/If …, the system shall …' form (EARS). For kind=question: the question for the client." }),
		acceptance: Type.Optional(Type.Array(Type.String(), { description: "Testable acceptance criteria, ideally Given/When/Then." })),
		evidence: Type.Optional(Type.Array(Type.String(), { description: "Where this came from: route (e.g. /projects), screenshot path, source file, API call." })),
		status: Type.Optional(StringEnum(STATUSES)),
		priority: Type.Optional(StringEnum(PRIORITIES)),
		notes: Type.Optional(Type.String({ description: "For mocked items: what the prototype actually does." })),
		assumption: Type.Optional(Type.String({ description: "Working assumption if unconfirmed (always set for questions)." })),
		related: Type.Optional(Type.Array(Type.String(), { description: "Related requirement IDs." })),
	});

	pi.registerTool({
		name: "spec_requirement",
		label: "Requirements ledger",
		description:
			"Persistent requirements ledger in .living-spec/ledger.json (survives compaction and restarts). Actions: " +
			"add (items[] — batch several at once; near-duplicate titles in the same area are rejected and reported), " +
			"update (id + any fields; appendEvidence/appendAcceptance to extend), remove (id), get (id), list (optional area/kind/status/query filters), " +
			"define_area (area code + areaName + areaDescription), set_project (projectName, summary, users[], goals[]). " +
			"IDs are stable: AREA-001, questions Q-001.",
		promptSnippet: "Record/update/list requirements, open questions, feature areas and project summary in the spec ledger",
		promptGuidelines: [
			"Record each requirement with spec_requirement as soon as it is identified, citing evidence; never keep requirements only in conversation.",
			"Set spec_requirement status to 'mocked' when the prototype only fakes the behaviour (hard-coded data, no-op handler, 'coming soon', intercepted write with no visible effect) and describe what it does in notes.",
			"Use spec_requirement kind 'question' for anything the prototype cannot answer (business rules, limits, edge cases, who can do what) and always give a working assumption.",
		],
		parameters: Type.Object({
			action: StringEnum(["add", "update", "remove", "get", "list", "define_area", "set_project"] as const),
			items: Type.Optional(Type.Array(ReqItem, { description: "add: requirements to add" })),
			id: Type.Optional(Type.String()),
			area: Type.Optional(Type.String()),
			kind: Type.Optional(StringEnum(KINDS)),
			title: Type.Optional(Type.String()),
			statement: Type.Optional(Type.String()),
			acceptance: Type.Optional(Type.Array(Type.String())),
			evidence: Type.Optional(Type.Array(Type.String())),
			appendEvidence: Type.Optional(Type.Array(Type.String())),
			appendAcceptance: Type.Optional(Type.Array(Type.String())),
			status: Type.Optional(StringEnum(STATUSES)),
			priority: Type.Optional(StringEnum(PRIORITIES)),
			notes: Type.Optional(Type.String()),
			assumption: Type.Optional(Type.String()),
			related: Type.Optional(Type.Array(Type.String())),
			query: Type.Optional(Type.String({ description: "list: substring filter" })),
			areaName: Type.Optional(Type.String()),
			areaDescription: Type.Optional(Type.String()),
			order: Type.Optional(Type.Number()),
			projectName: Type.Optional(Type.String()),
			summary: Type.Optional(Type.String()),
			users: Type.Optional(Type.Array(Type.String(), { description: "User roles / personas" })),
			goals: Type.Optional(Type.Array(Type.String())),
		}),
		executionMode: "sequential",
		async execute(_id, p, _signal, _onUpdate, ctx) {
			const s = get(ctx.cwd);
			const L = s.ledger.reload();
			let out = "";
			switch (p.action) {
				case "add": {
					if (!p.items?.length) throw new Error("add needs items[]");
					const lines: string[] = [];
					for (const it of p.items) {
						const { req, duplicateOf } = L.add(it as Parameters<Ledger["add"]>[0]);
						lines.push(duplicateOf ? `= ${duplicateOf} already exists ("${req.title}") — use update to extend it` : `+ ${req.id} ${req.title}`);
					}
					L.save();
					out = lines.join("\n");
					break;
				}
				case "update": {
					if (!p.id) throw new Error("update needs id");
					const { action: _a, items: _i, id, query: _q, areaName: _an, areaDescription: _ad, order: _o, projectName: _pn, summary: _s, users: _u, goals: _g, ...patch } = p;
					const r = L.update(id, patch as Parameters<Ledger["update"]>[1]);
					L.save();
					out = `Updated ${r.id}: ${r.title} [${r.kind}/${r.status}/${r.priority}]`;
					break;
				}
				case "remove": {
					if (!p.id) throw new Error("remove needs id");
					out = L.remove(p.id) ? `Removed ${p.id}` : `No requirement ${p.id}`;
					L.save();
					break;
				}
				case "get": {
					if (!p.id) throw new Error("get needs id");
					const r = L.data.requirements.find((x) => x.id.toUpperCase() === p.id!.toUpperCase());
					out = r ? JSON.stringify(r, null, 2) : `No requirement ${p.id}`;
					break;
				}
				case "list":
					out = L.list({ area: p.area, kind: p.kind, status: p.status, query: p.query });
					break;
				case "define_area": {
					if (!p.area) throw new Error("define_area needs area (code)");
					const a = L.defineArea({ code: p.area, name: p.areaName ?? p.area, description: p.areaDescription, order: p.order });
					L.save();
					out = `Area ${a.code} = ${a.name}`;
					break;
				}
				case "set_project": {
					L.data.project = {
						...(L.data.project ?? {}),
						...(p.projectName ? { name: p.projectName } : {}),
						...(p.summary ? { summary: p.summary } : {}),
						...(p.users ? { users: p.users } : {}),
						...(p.goals ? { goals: p.goals } : {}),
					};
					L.save();
					out = "Project overview updated.";
					break;
				}
			}
			updateStatus(ctx);
			return { content: text(clip(out)), details: L.counts() };
		},
	});

	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "spec_entity",
		label: "Data model ledger",
		description:
			"Record the product's data entities (business objects, not necessarily the prototype's tables) in the spec ledger. " +
			"upsert merges fields/relations/rules/evidence into an existing entity of the same name; remove deletes; list shows all with fields.",
		promptSnippet: "Record/merge data entities (fields, relations, rules) in the spec ledger",
		promptGuidelines: [
			"Use spec_entity for data entities, their fields, relationships and invariants, combining evidence from Supabase tables, form fields, intercepted write payloads and hard-coded mock data.",
		],
		parameters: Type.Object({
			action: StringEnum(["upsert", "remove", "list"] as const),
			name: Type.Optional(Type.String({ description: "Entity name, singular PascalCase, e.g. Project" })),
			description: Type.Optional(Type.String()),
			fields: Type.Optional(
				Type.Array(
					Type.Object({
						name: Type.String(),
						type: Type.String({ description: "Business type: text, number, money, date, datetime, boolean, enum(a|b|c), email, url, file, reference(Entity)…" }),
						required: Type.Optional(Type.Boolean()),
						notes: Type.Optional(Type.String({ description: "Validation, defaults, uniqueness, source of values" })),
					}),
				),
			),
			relations: Type.Optional(
				Type.Array(
					Type.Object({
						to: Type.String(),
						kind: StringEnum(["one-to-one", "one-to-many", "many-to-one", "many-to-many"] as const),
						via: Type.Optional(Type.String()),
						notes: Type.Optional(Type.String()),
					}),
				),
			),
			rules: Type.Optional(Type.Array(Type.String(), { description: "Invariants / business rules on this entity" })),
			evidence: Type.Optional(Type.Array(Type.String())),
			status: Type.Optional(StringEnum(STATUSES)),
		}),
		executionMode: "sequential",
		async execute(_id, p, _signal, _onUpdate, ctx) {
			const s = get(ctx.cwd);
			const L = s.ledger.reload();
			let out: string;
			if (p.action === "list") {
				out = L.data.entities.length
					? L.data.entities
							.map((e) => `${e.name} [${e.status}]: ${e.fields.map((f) => `${f.name}:${f.type}${f.required ? "*" : ""}`).join(", ")}${e.relations.length ? ` | ${e.relations.map((r) => `${r.kind}→${r.to}`).join(", ")}` : ""}`)
							.join("\n")
					: "No entities yet.";
			} else if (p.action === "remove") {
				if (!p.name) throw new Error("remove needs name");
				out = L.removeEntity(p.name) ? `Removed ${p.name}` : `No entity ${p.name}`;
				L.save();
			} else {
				if (!p.name) throw new Error("upsert needs name");
				const { entity, created } = L.upsertEntity(p as Parameters<Ledger["upsertEntity"]>[0]);
				L.save();
				out = `${created ? "Created" : "Updated"} ${entity.name}: ${entity.fields.length} fields, ${entity.relations.length} relations`;
			}
			updateStatus(ctx);
			return { content: text(out), details: L.counts() };
		},
	});

	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "spec_export",
		label: "Export spec",
		description:
			"Render the ledger into deliverables: REQUIREMENTS.md (overview, screen inventory with screenshot links, requirements by area with acceptance criteria, " +
			"data model with a Mermaid ER diagram, NFRs, prototype gaps, open questions, traceability), requirements.csv (for Jira/Linear import) and requirements.json.",
		promptSnippet: "Write REQUIREMENTS.md / CSV / JSON from the spec ledger",
		parameters: Type.Object({
			formats: Type.Optional(Type.Array(StringEnum(["md", "csv", "json"] as const), { description: "Default: all three" })),
			path: Type.Optional(Type.String({ description: "Where to write the markdown (default .living-spec/REQUIREMENTS.md)" })),
		}),
		async execute(_id, p, _signal, _onUpdate, ctx) {
			const s = get(ctx.cwd);
			const files = exportAll(s.ws, s.ledger.reload().data, s.ws.loadConfig(), p.formats ?? ["md", "csv", "json"], p.path);
			if (s.browser.apiLog.length) s.ws.writeText("crawl/api-inventory.md", renderApiInventory(s.browser.apiLog));
			return { content: text(`Wrote:\n${files.map((f) => `- ${s.ws.rel(f)}`).join("\n")}`), details: { files } };
		},
	});

	// -------------------------------------------------------------------------
	// Commands
	// -------------------------------------------------------------------------
	pi.registerCommand("spec", {
		description: "Extract requirements from a prototype: /spec <url> [repo-path]",
		handler: async (args, ctx) => {
			const s = get(ctx.cwd);
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const cfg = s.ws.loadConfig();
			let url = parts.find((x) => /^https?:\/\//i.test(x)) ?? cfg.baseUrl;
			let repo = parts.find((x) => !/^https?:\/\//i.test(x)) ?? cfg.repoPath;
			if (!url && ctx.hasUI) url = (await ctx.ui.input("Prototype URL", "https://your-app.lovable.app"))?.trim() || undefined;
			if (!repo && ctx.hasUI) repo = (await ctx.ui.input("Path to the prototype's source (blank if none)", "./prototype"))?.trim() || undefined;
			if (!url && !repo) {
				ctx.ui.notify("Need a prototype URL and/or a source path: /spec <url> [repo]", "warning");
				return;
			}
			s.ws.saveConfig({ ...(url ? { baseUrl: url } : {}), ...(repo ? { repoPath: repo } : {}) });
			s.browser.refreshConfig();
			pi.setSessionName?.(`Living spec: ${url ?? repo}`);
			const msg = [
				"/skill:living-spec",
				`Extract a complete requirements specification from this prototype.`,
				url ? `Running app: ${url}` : "No running app URL — work from source only.",
				repo ? `Source code: ${repo}` : "No source code — work from the running app only.",
			].join("\n");
			if (ctx.isIdle()) pi.sendUserMessage(msg, { expandPromptTemplates: true });
			else pi.sendUserMessage(msg, { deliverAs: "followUp", expandPromptTemplates: true });
		},
	});

	pi.registerCommand("spec-status", {
		description: "Show requirements-extraction progress",
		handler: async (_args, ctx) => {
			const s = get(ctx.cwd);
			const c = s.ledger.reload().counts();
			const cfg = s.ws.loadConfig();
			const sitemap = s.ws.readJson<{ pages: unknown[] } | undefined>("crawl/sitemap.json", undefined);
			ctx.ui.notify(
				[
					`URL: ${cfg.baseUrl ?? "(none)"} · repo: ${cfg.repoPath ?? "(none)"} · writes: ${cfg.writeGuard}`,
					`${sitemap ? sitemap.pages.length : 0} screens crawled · ${c.requirements} requirements (${c.mocked} mocked) · ${c.entities} entities · ${c.questions} open questions · ${c.areas} areas`,
				].join("\n"),
				"info",
			);
		},
	});

	pi.registerCommand("spec-export", {
		description: "Write REQUIREMENTS.md, requirements.csv and requirements.json",
		getArgumentCompletions: (prefix: string) =>
			["md", "csv", "json"].filter((x) => x.startsWith(prefix)).map((x) => ({ value: x, label: x })),
		handler: async (args, ctx) => {
			const s = get(ctx.cwd);
			const fmts = (args ?? "").split(/\s+/).filter((x): x is "md" | "csv" | "json" => x === "md" || x === "csv" || x === "json");
			const files = exportAll(s.ws, s.ledger.reload().data, s.ws.loadConfig(), fmts.length ? fmts : ["md", "csv", "json"]);
			ctx.ui.notify(`Wrote ${files.map((f) => s.ws.rel(f)).join(", ")}`, "info");
		},
	});

	pi.registerCommand("spec-writes", {
		description: "How mutating requests are handled while exploring: fake (default) | block | off",
		getArgumentCompletions: (prefix: string) =>
			["fake", "block", "off"].filter((x) => x.startsWith(prefix)).map((x) => ({ value: x, label: x })),
		handler: async (args, ctx) => {
			const s = get(ctx.cwd);
			const mode = (args ?? "").trim() as WriteGuard;
			if (!["fake", "block", "off"].includes(mode)) {
				ctx.ui.notify(`Write guard is "${s.ws.loadConfig().writeGuard}". Use /spec-writes fake|block|off`, "info");
				return;
			}
			if (mode === "off" && ctx.hasUI) {
				const ok = await ctx.ui.confirm(
					"Allow real writes?",
					"The prototype may be connected to a live backend. With writes allowed, exploring can create, change or delete real data and trigger emails or payments.",
				);
				if (!ok) return;
			}
			s.ws.saveConfig({ writeGuard: mode });
			s.browser.refreshConfig();
			ctx.ui.notify(`Write guard set to ${mode}`, "info");
		},
	});

	pi.registerCommand("spec-login", {
		description: "Open a visible browser to log in to the prototype; the session is reused by the crawler",
		handler: async (args, ctx) => {
			const s = get(ctx.cwd);
			if (!ctx.hasUI) {
				ctx.ui.notify("/spec-login needs the interactive UI", "warning");
				return;
			}
			try {
				const path = await s.browser.interactiveLogin(args?.trim() || "", () =>
					ctx.ui.confirm("Log in to the prototype", "Log in in the browser window that just opened, then confirm here to save the session."),
				);
				ctx.ui.notify(`Saved login session to ${s.ws.rel(path)} — it will be reused headlessly. Keep it out of git.`, "info");
			} catch (err) {
				ctx.ui.notify(`Login failed: ${(err as Error).message}`, "error");
			}
		},
	});

	pi.registerCommand("spec-close", {
		description: "Close the living-spec browser",
		handler: async (_args, ctx) => {
			await state?.browser.close();
			ctx.ui.notify("Browser closed", "info");
		},
	});
}

function formatBrowse(r: BrowseResult, origin?: string): string {
	const L: string[] = [];
	L.push(`${r.ok ? "✓" : "✗"} ${r.summary}${r.error ? ` — ${r.error}` : ""}`);
	L.push(`Page: ${shortUrl(r.url, origin) || r.url} — "${r.title}"${r.navigated ? " (navigated)" : ""}`);
	const writes = r.events.net.filter((e) => e.intercepted);
	const reads = r.events.net.filter((e) => !e.intercepted);
	if (writes.length) {
		L.push("Intercepted writes (NOT sent to the server):");
		for (const w of writes) L.push(`  ${w.method} ${shortUrl(w.url, origin)} → ${w.intercepted}${w.postData ? `  body=${w.postData.slice(0, 600)}` : ""}`);
	}
	if (reads.length) {
		L.push("API calls:");
		for (const e of reads.slice(0, 25)) L.push(`  ${e.method} ${shortUrl(e.url, origin)} → ${e.status}${e.postData ? `  body=${e.postData.slice(0, 300)}` : ""}`);
		if (reads.length > 25) L.push(`  … ${reads.length - 25} more`);
	}
	if (r.snapshot?.toasts.length) L.push(`New toasts/alerts: ${r.snapshot.toasts.join(" | ")}`);
	if (r.events.dialogs.length) L.push(`Browser dialogs: ${r.events.dialogs.join(" | ")}`);
	if (r.events.popups.length) L.push(`New tabs: ${r.events.popups.join(" | ")}`);
	if (r.events.console.length) L.push(`Console: ${r.events.console.slice(0, 8).join(" | ")}`);
	if (r.snapshot?.notFound) L.push("⚠ This looks like a 404 / Not Found page.");
	if (r.outline) {
		L.push("", r.outlineMode === "diff" ? "Outline changes since last step (- removed, + added):" : "Page outline:", r.outline);
		if (r.snapshot?.truncated) L.push("… (outline truncated; scroll or use a narrower view)");
	}
	if (r.screenshotPath) L.push("", `Screenshot saved: ${r.screenshotPath}`);
	return L.join("\n");
}
