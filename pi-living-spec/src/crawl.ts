import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type NetEvent, SpecBrowser, shortUrl } from "./browser.js";
import { slugify, type Workspace } from "./workspace.js";

export interface CrawlOptions {
	startUrl?: string;
	maxPages?: number;
	/** Extra paths/URLs to visit (e.g. routes found by the source scan). */
	seeds?: string[];
	/** Only crawl URLs whose path matches this regex. */
	include?: string;
	/** Skip URLs whose path matches this regex (logout links are always skipped). */
	exclude?: string;
	/** Max pages per dynamic-route pattern such as /projects/:id (default 2). */
	perPattern?: number;
	/** Also capture a mobile screenshot of every page. */
	mobile?: boolean;
	onProgress?: (msg: string) => void;
	signal?: AbortSignal;
}

export interface CrawledPage {
	url: string;
	path: string;
	requested: string;
	title: string;
	headings: string[];
	redirectedTo?: string;
	notFound: boolean;
	outlineFile: string;
	screenshot: string;
	mobileScreenshot?: string;
	links: string[];
	apiCalls: string[];
	consoleErrors: string[];
	toasts: string[];
	stats: Record<string, number>;
	error?: string;
}

export interface Sitemap {
	crawledAt: string;
	baseUrl: string;
	pages: CrawledPage[];
	skipped: { url: string; reason: string }[];
	externalLinks: Record<string, string>;
}

const ALWAYS_SKIP = /(log-?out|sign-?out|\.(pdf|zip|csv|xlsx?|docx?|png|jpe?g|gif|svg|mp4)$)/i;

function routePattern(pathname: string): string {
	return pathname
		.split("/")
		.map((seg) => {
			if (!seg) return seg;
			if (/^\d+$/.test(seg)) return ":id";
			if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ":id";
			if (/^[A-Za-z0-9_-]{16,}$/.test(seg) && /\d/.test(seg)) return ":id";
			return seg;
		})
		.join("/");
}

/** Does a concrete path match a route template like /projects/:id, /posts/$postId or /docs/*? */
export function routeMatches(template: string, path: string): boolean {
	const clean = (x: string) => x.split("?")[0].replace(/\/+$/, "") || "/";
	const t = clean(template);
	const p = clean(path);
	if (t === p) return true;
	if (t === "/*" || t === "*") return false; // catch-all: don't count as covered
	const re = new RegExp(
		`^${t
			.split("/")
			.map((seg) => (/^[:$]/.test(seg) ? "[^/]+" : seg === "*" || seg === "$" ? ".*" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
			.join("/")}$`,
	);
	return re.test(p);
}

export function apiKey(ev: NetEvent): string {
	const s = shortUrl(ev.url);
	return `${ev.method} ${s.split("?")[0]}`;
}

export async function crawl(browser: SpecBrowser, ws: Workspace, opts: CrawlOptions): Promise<Sitemap> {
	const start = browser.resolveUrl(opts.startUrl);
	const startU = new URL(start);
	const origin = startU.origin;
	const hashRouting = startU.hash.startsWith("#/");
	const maxPages = Math.max(1, Math.min(opts.maxPages ?? 40, 300));
	const perPattern = opts.perPattern ?? 2;
	const include = opts.include ? new RegExp(opts.include, "i") : undefined;
	const exclude = opts.exclude ? new RegExp(opts.exclude, "i") : undefined;

	const outDir = ws.ensure("crawl");
	const shotDir = ws.ensure("crawl", "screens");
	const pageDir = ws.ensure("crawl", "pages");

	const normalize = (raw: string): string | undefined => {
		try {
			const u = new URL(raw, start);
			if (u.origin !== origin) return undefined;
			if (!hashRouting) u.hash = "";
			let s = u.href;
			if (s.endsWith("/") && u.pathname !== "/") s = s.slice(0, -1);
			return s;
		} catch {
			return undefined;
		}
	};
	const keyPath = (u: string) => {
		const x = new URL(u);
		return hashRouting ? x.hash.slice(1) || "/" : x.pathname + x.search;
	};

	const queue: string[] = [];
	const queued = new Set<string>();
	const patternCount = new Map<string, number>();
	const sitemap: Sitemap = {
		crawledAt: new Date().toISOString(),
		baseUrl: start,
		pages: [],
		skipped: [],
		externalLinks: {},
	};

	const enqueue = (raw: string, why = "link") => {
		const n = normalize(raw);
		if (!n) return;
		if (queued.has(n)) return;
		const path = keyPath(n);
		if (ALWAYS_SKIP.test(path)) {
			queued.add(n);
			sitemap.skipped.push({ url: n, reason: "logout/download link" });
			return;
		}
		if (include && !include.test(path)) return;
		if (exclude?.test(path)) {
			queued.add(n);
			sitemap.skipped.push({ url: n, reason: "excluded by pattern" });
			return;
		}
		const pat = routePattern(path.split("?")[0]);
		const c = patternCount.get(pat) ?? 0;
		if (c >= perPattern) {
			queued.add(n);
			sitemap.skipped.push({ url: n, reason: `already visited ${perPattern} pages matching ${pat}` });
			return;
		}
		patternCount.set(pat, c + 1);
		queued.add(n);
		queue.push(n);
		void why;
	};

	enqueue(start, "start");
	for (const s of opts.seeds ?? []) {
		if (/[:$*[]/.test(s)) continue; // dynamic route templates can't be visited directly
		try {
			enqueue(hashRouting ? `${origin}/#${s.startsWith("/") ? s : `/${s}`}` : new URL(s, start).href, "seed");
		} catch {}
	}

	const visitedFinal = new Set<string>();
	while (queue.length && sitemap.pages.length < maxPages) {
		if (opts.signal?.aborted) break;
		const url = queue.shift()!;
		opts.onProgress?.(`[${sitemap.pages.length + 1}/${Math.min(maxPages, sitemap.pages.length + queue.length + 1)}] ${keyPath(url)}`);
		browser.drainEvents();
		const entry: CrawledPage = {
			url,
			path: keyPath(url),
			requested: keyPath(url),
			title: "",
			headings: [],
			notFound: false,
			outlineFile: "",
			screenshot: "",
			links: [],
			apiCalls: [],
			consoleErrors: [],
			toasts: [],
			stats: {},
		};
		try {
			const page = await browser.goto(url);
			const finalUrl = normalize(page.url()) ?? page.url();
			if (finalUrl !== url) {
				// e.g. a protected route bouncing to /login: record the redirect, capture the target once.
				entry.redirectedTo = keyPath(finalUrl);
				entry.title = await page.title();
				entry.apiCalls = [...new Set(browser.drainEvents().net.map(apiKey))];
				sitemap.pages.push(entry);
				if (!queued.has(finalUrl) && !visitedFinal.has(finalUrl)) {
					queued.add(finalUrl);
					queue.unshift(finalUrl);
				}
				continue;
			}
			visitedFinal.add(finalUrl);
			entry.url = finalUrl;
			entry.path = keyPath(finalUrl);
			const snap = await browser.snapshot({ maxLines: 900 });
			entry.title = snap.title;
			entry.headings = snap.headings;
			entry.notFound = snap.notFound;
			entry.toasts = snap.toasts;
			entry.stats = snap.stats;
			for (const [href, text] of Object.entries(snap.links)) {
				const n = normalize(href);
				if (n) {
					entry.links.push(keyPath(n));
					enqueue(n);
				} else if (!/^(mailto|tel):/.test(href)) {
					sitemap.externalLinks[href] = text;
				}
			}
			entry.links = [...new Set(entry.links)];
			const slug = slugify(entry.path === "/" ? "home" : entry.path);
			const shot = await browser.screenshot({ fullPage: true, label: slug, dir: shotDir });
			entry.screenshot = ws.rel(shot.path);
			if (opts.mobile) {
				const vp = page.viewportSize();
				await page.setViewportSize({ width: 390, height: 844 });
				await page.waitForTimeout(500);
				const m = await browser.screenshot({ fullPage: true, label: `${slug}-mobile`, dir: shotDir });
				entry.mobileScreenshot = ws.rel(m.path);
				if (vp) await page.setViewportSize(vp);
			}
			const ev = browser.drainEvents();
			entry.apiCalls = [...new Set(ev.net.map((e) => `${apiKey(e)}${e.intercepted ? ` (${e.intercepted})` : ""}`))];
			entry.consoleErrors = ev.console.slice(0, 10);
			const md = [
				`# ${entry.path} — ${entry.headings[0]?.replace(/^h\d: /, "") || entry.title}`,
				"",
				`- URL: ${entry.url}`,
				entry.redirectedTo ? `- Requested ${entry.requested} → redirected to ${entry.redirectedTo}` : "",
				entry.notFound ? "- ⚠ Looks like a 404 / Not Found page" : "",
				`- Screenshot: ${entry.screenshot}${entry.mobileScreenshot ? ` (mobile: ${entry.mobileScreenshot})` : ""}`,
				`- Headings: ${entry.headings.join(" · ") || "(none)"}`,
				`- Interactive elements: ${snap.stats.interactive}, forms: ${snap.stats.forms}, tables: ${snap.stats.tables}`,
				entry.apiCalls.length ? `- API calls on load: ${entry.apiCalls.join(", ")}` : "- API calls on load: none (data is probably hard-coded/mock)",
				entry.consoleErrors.length ? `- Console: ${entry.consoleErrors.join(" | ")}` : "",
				entry.toasts.length ? `- Toasts/alerts visible: ${entry.toasts.join(" | ")}` : "",
				`- Links to: ${entry.links.join(", ") || "(none)"}`,
				"",
				"## Outline",
				"",
				"```",
				snap.outline,
				snap.truncated ? "… (outline truncated)" : "",
				"```",
				"",
			]
				.filter((l) => l !== "")
				.join("\n");
			const mdPath = join(pageDir, `${slug}.md`);
			writeFileSync(mdPath, md, "utf8");
			entry.outlineFile = ws.rel(mdPath);
		} catch (err) {
			entry.error = (err as Error).message.split("\n")[0];
		}
		sitemap.pages.push(entry);
	}
	for (const u of queue) sitemap.skipped.push({ url: u, reason: `maxPages (${maxPages}) reached` });

	writeFileSync(join(outDir, "sitemap.json"), `${JSON.stringify(sitemap, null, 2)}\n`, "utf8");
	writeFileSync(join(outDir, "api-inventory.md"), renderApiInventory(browser.apiLog), "utf8");
	return sitemap;
}

export function renderApiInventory(log: NetEvent[]): string {
	const groups = new Map<string, { pages: Set<string>; statuses: Set<string>; samples: string[]; queries: Set<string> }>();
	for (const ev of log) {
		const key = apiKey(ev);
		let g = groups.get(key);
		if (!g) {
			g = { pages: new Set(), statuses: new Set(), samples: [], queries: new Set() };
			groups.set(key, g);
		}
		if (ev.page) g.pages.add(ev.page);
		g.statuses.add(ev.intercepted ?? String(ev.status ?? "?"));
		const q = shortUrl(ev.url).split("?")[1];
		if (q && g.queries.size < 4) g.queries.add(q);
		if (ev.postData && g.samples.length < 2) g.samples.push(ev.postData.slice(0, 400));
	}
	const lines = ["# API inventory (observed in the browser)", ""];
	if (!groups.size) lines.push("No fetch/XHR traffic observed. Data shown in the prototype is most likely hard-coded.");
	for (const [k, g] of [...groups].sort()) {
		lines.push(`## ${k}`, `- Seen on: ${[...g.pages].join(", ") || "?"}`, `- Result: ${[...g.statuses].join(", ")}`);
		for (const q of g.queries) lines.push(`- Query: \`${q}\``);
		for (const s of g.samples) lines.push(`- Body: \`${s.replace(/`/g, "'")}\``);
		lines.push("");
	}
	return `${lines.join("\n")}\n`;
}
