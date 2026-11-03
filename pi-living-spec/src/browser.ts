import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext, Locator, Page, Request, Route } from "playwright";
import { type PageSnapshot, snapshotExpression } from "./snapshot-script.js";
import { type SpecConfig, slugify, timestamp, type Workspace } from "./workspace.js";

export interface NetEvent {
	method: string;
	url: string;
	status?: number;
	resourceType: string;
	postData?: string;
	intercepted?: "faked" | "blocked";
	page?: string;
}

export interface BrowserEvents {
	console: string[];
	net: NetEvent[];
	dialogs: string[];
	popups: string[];
}

export type BrowseAction =
	| "open"
	| "snapshot"
	| "click"
	| "fill"
	| "select"
	| "check"
	| "uncheck"
	| "hover"
	| "press"
	| "upload"
	| "back"
	| "forward"
	| "reload"
	| "scroll"
	| "wait"
	| "screenshot"
	| "viewport";

export interface BrowseParams {
	action: BrowseAction;
	url?: string;
	target?: string;
	value?: string;
	screenshot?: boolean;
	fullPage?: boolean;
	full?: boolean;
}

export interface BrowseResult {
	ok: boolean;
	summary: string;
	url: string;
	title: string;
	navigated: boolean;
	outline?: string;
	outlineMode?: "full" | "diff" | "none";
	snapshot?: PageSnapshot;
	events: BrowserEvents;
	screenshotPath?: string;
	screenshotJpeg?: Buffer;
	error?: string;
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const NOISE_HOSTS = /(google-analytics|googletagmanager|posthog|sentry|segment|hotjar|clarity\.ms|intercom|gpteng\.co|lovable\.dev\/api\/(?:telemetry|analytics))/i;

const SENSITIVE_KEY = /pass(word)?|secret|token|otp|code_verifier|card|cvc|cvv|iban|ssn|pin$|api[_-]?key|authorization/i;

/** Mask credential-like values in captured request bodies before they are logged or shown to the model. */
export function redact(body: string | undefined): string | undefined {
	if (!body) return body;
	try {
		const scrub = (v: unknown): unknown => {
			if (Array.isArray(v)) return v.map(scrub);
			if (v && typeof v === "object") {
				return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, SENSITIVE_KEY.test(k) ? "***" : scrub(x)]));
			}
			return v;
		};
		return JSON.stringify(scrub(JSON.parse(body)));
	} catch {
		return body.replace(/([\w.-]*(?:pass(?:word)?|secret|token|otp|card|cvc|cvv|api[_-]?key)[\w.-]*)=([^&]*)/gi, "$1=***");
	}
}

export function shortUrl(url: string, baseOrigin?: string): string {
	try {
		const u = new URL(url);
		let host = u.host;
		if (baseOrigin && u.origin === baseOrigin) host = "";
		else if (/\.supabase\.co$/.test(u.host)) host = "supabase:";
		const out = `${host}${u.pathname}${u.search ? decodeURIComponent(u.search) : ""}`;
		return out.length > 220 ? `${out.slice(0, 219)}…` : out;
	} catch {
		return url;
	}
}

/**
 * One Playwright browser per pi session, lazily started. Shared by the crawl
 * and browse tools so login state and refs carry over between calls.
 */
export class SpecBrowser {
	private browser?: Browser;
	private context?: BrowserContext;
	private page?: Page;
	private config: SpecConfig;
	private pending: BrowserEvents = { console: [], net: [], dialogs: [], popups: [] };
	/** Every API call seen this session, for the API inventory. */
	readonly apiLog: NetEvent[] = [];
	private lastOutline?: { url: string; outline: string };
	private lastToasts = new Set<string>();
	private baseOrigin?: string;

	constructor(private ws: Workspace) {
		this.config = ws.loadConfig();
	}

	get isOpen(): boolean {
		return !!this.page && !this.page.isClosed();
	}

	refreshConfig(): SpecConfig {
		this.config = this.ws.loadConfig();
		return this.config;
	}

	get storageStatePath(): string {
		return this.ws.path("auth", "storage-state.json");
	}

	async ensurePage(opts: { headless?: boolean } = {}): Promise<Page> {
		this.refreshConfig();
		if (this.page && !this.page.isClosed()) return this.page;
		let pw: typeof import("playwright");
		try {
			pw = await import("playwright");
		} catch {
			throw new Error(
				"Playwright is not installed. Run `npm install` in the pi-living-spec package directory, then `npx playwright install chromium`.",
			);
		}
		const headless = opts.headless ?? this.config.headless;
		try {
			this.browser = await pw.chromium.launch({ headless });
		} catch (err) {
			throw new Error(
				`Could not launch Chromium (${(err as Error).message.split("\n")[0]}). Run \`npx playwright install chromium\` and try again.`,
			);
		}
		this.context = await this.browser.newContext({
			viewport: this.config.viewport,
			storageState: existsSync(this.storageStatePath) ? this.storageStatePath : undefined,
			ignoreHTTPSErrors: true,
		});
		await this.context.route("**/*", (route, request) => this.guard(route, request));
		this.page = await this.context.newPage();
		this.attachPageListeners(this.page);
		// Registered after our own page exists so it only sees popups / target=_blank tabs.
		this.context.on("page", (p) => {
			if (p !== this.page) {
				this.pending.popups.push(p.url() || "(new tab)");
				p.waitForLoadState("domcontentloaded", { timeout: 5000 })
					.then(() => this.pending.popups.push(`new tab loaded: ${p.url()}`))
					.catch(() => {})
					.finally(() => p.close().catch(() => {}));
			}
		});

		return this.page;
	}

	/** Open a visible browser so the human can log in, then persist the session cookies/localStorage. */
	async interactiveLogin(url: string, waitForUser: () => Promise<boolean>): Promise<string> {
		await this.close();
		const page = await this.ensurePage({ headless: false });
		await page.goto(this.resolveUrl(url), { waitUntil: "domcontentloaded", timeout: 60000 });
		const ok = await waitForUser();
		if (!ok) throw new Error("Login cancelled");
		mkdirSync(this.ws.path("auth"), { recursive: true });
		await this.context!.storageState({ path: this.storageStatePath });
		await this.close();
		return this.storageStatePath;
	}

	async saveStorageState(): Promise<string | undefined> {
		if (!this.context) return undefined;
		mkdirSync(this.ws.path("auth"), { recursive: true });
		await this.context.storageState({ path: this.storageStatePath });
		return this.storageStatePath;
	}

	async close(): Promise<void> {
		const b = this.browser;
		this.browser = undefined;
		this.context = undefined;
		this.page = undefined;
		this.lastOutline = undefined;
		if (b) await b.close().catch(() => {});
	}

	drainEvents(): BrowserEvents {
		const e = this.pending;
		this.pending = { console: [], net: [], dialogs: [], popups: [] };
		return e;
	}

	resolveUrl(url?: string): string {
		const base = this.config.baseUrl;
		if (!url) {
			if (!base) throw new Error("No URL given and no baseUrl configured. Pass url, or run /spec <url> first.");
			return base;
		}
		if (/^https?:\/\//i.test(url)) return url;
		if (!base) throw new Error(`Relative path "${url}" given but no baseUrl configured.`);
		return new URL(url, base.endsWith("/") ? base : `${base}/`).href.replace(/([^:]\/)\/+/g, "$1");
	}

	private attachPageListeners(page: Page) {
		page.on("console", (msg) => {
			const t = msg.type();
			if (t === "error" || t === "warning") {
				const text = msg.text().replace(/\s+/g, " ").slice(0, 300);
				if (this.pending.console.length < 30 && !this.pending.console.includes(`${t}: ${text}`)) {
					this.pending.console.push(`${t}: ${text}`);
				}
			}
		});
		page.on("pageerror", (err) => {
			if (this.pending.console.length < 30) this.pending.console.push(`uncaught: ${err.message.slice(0, 300)}`);
		});
		page.on("dialog", (d) => {
			this.pending.dialogs.push(`${d.type()}: ${d.message().slice(0, 300)} (auto-accepted)`);
			d.accept().catch(() => {});
		});
		page.on("response", (res) => {
			const req = res.request();
			const rt = req.resourceType();
			if (rt !== "fetch" && rt !== "xhr") return;
			if (NOISE_HOSTS.test(req.url())) return;
			if (MUTATING.has(req.method()) && this.wouldIntercept(req)) return; // logged by guard
			const ev: NetEvent = {
				method: req.method(),
				url: req.url(),
				status: res.status(),
				resourceType: rt,
				postData: redact(req.postData() ?? undefined)?.slice(0, 600),
				page: this.safePath(page.url()),
			};
			this.record(ev);
		});
	}

	private safePath(u: string): string {
		try {
			const x = new URL(u);
			return x.pathname + x.hash;
		} catch {
			return u;
		}
	}

	private record(ev: NetEvent) {
		if (this.pending.net.length < 60) this.pending.net.push(ev);
		if (this.apiLog.length < 5000) this.apiLog.push(ev);
	}

	private wouldIntercept(req: Request): boolean {
		if (this.config.writeGuard === "off") return false;
		if (!MUTATING.has(req.method())) return false;
		const rt = req.resourceType();
		if (rt === "document") return false; // classic form posts navigate; let them through to see result
		const url = req.url();
		if (NOISE_HOSTS.test(url)) return true;
		return !this.isAllowListed(url);
	}

	private isAllowListed(url: string): boolean {
		return this.config.writeAllow.some((re) => {
			try {
				return new RegExp(re, "i").test(url);
			} catch {
				return url.includes(re);
			}
		});
	}

	private async guard(route: Route, request: Request): Promise<void> {
		if (!this.wouldIntercept(request)) return route.continue().catch(() => {});
		const url = request.url();
		const method = request.method();
		const postData = request.postData() ?? undefined;
		const safeBody = redact(postData);
		const noisy = NOISE_HOSTS.test(url);
		if (!noisy) {
			this.record({
				method,
				url,
				resourceType: request.resourceType(),
				postData: safeBody?.slice(0, 1500),
				intercepted: this.config.writeGuard === "block" ? "blocked" : "faked",
				page: this.page ? this.safePath(this.page.url()) : undefined,
			});
		}
		if (this.config.writeGuard === "block" && !noisy) {
			return route.abort("blockedbyclient").catch(() => {});
		}
		const headers = request.headers();
		let parsed: unknown = null;
		try {
			parsed = postData ? JSON.parse(postData) : null;
		} catch {
			parsed = postData ?? null;
		}
		let status = 200;
		let body: unknown = { success: true };
		const wantsObject = (headers.accept ?? "").includes("vnd.pgrst.object");
		if (/\/rest\/v1\//.test(url)) {
			// Supabase PostgREST shape so supabase-js resolves without error.
			const now = new Date().toISOString();
			const rows = Array.isArray(parsed)
				? parsed
				: method === "DELETE"
					? []
					: [{ id: randomUUID(), created_at: now, updated_at: now, ...(parsed && typeof parsed === "object" ? parsed : {}) }];
			status = method === "POST" ? 201 : 200;
			body = wantsObject ? (rows[0] ?? {}) : rows;
		} else if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			body = { success: true, ...(parsed as object) };
		}
		const origin = headers.origin ?? (this.page ? new URL(this.page.url()).origin : "*");
		return route
			.fulfill({
				status,
				contentType: "application/json",
				headers: {
					"access-control-allow-origin": origin,
					"access-control-allow-credentials": "true",
					"access-control-allow-headers": "*",
				},
				body: JSON.stringify(body),
			})
			.catch(() => {});
	}

	async settle(page: Page, idleMs = 4000) {
		await page.waitForLoadState("networkidle", { timeout: idleMs }).catch(() => {});
		await page.waitForTimeout(350);
	}

	async goto(url?: string): Promise<Page> {
		const page = await this.ensurePage();
		const target = this.resolveUrl(url);
		if (!this.baseOrigin) {
			try {
				this.baseOrigin = new URL(this.config.baseUrl ?? target).origin;
			} catch {}
		}
		await page.goto(target, { waitUntil: "domcontentloaded", timeout: 45000 });
		await this.settle(page, 8000);
		return page;
	}

	async snapshot(opts: { maxLines?: number } = {}): Promise<PageSnapshot> {
		const page = await this.ensurePage();
		return (await page.evaluate(snapshotExpression({ maxLines: opts.maxLines ?? 600 }))) as PageSnapshot;
	}

	async screenshot(opts: { fullPage?: boolean; label?: string; dir?: string } = {}): Promise<{ path: string; jpeg: Buffer }> {
		const page = await this.ensurePage();
		const dir = opts.dir ?? this.ws.ensure("screens");
		mkdirSync(dir, { recursive: true });
		const name = `${timestamp()}-${slugify(opts.label ?? page.url())}.jpg`;
		const path = join(dir, name);
		const vp = page.viewportSize() ?? this.config.viewport;
		let jpeg: Buffer;
		if (opts.fullPage) {
			const h = (await page.evaluate("document.documentElement.scrollHeight")) as number;
			jpeg = await page.screenshot({
				type: "jpeg",
				quality: 70,
				fullPage: true,
				clip: { x: 0, y: 0, width: vp.width, height: Math.min(h, 6000) },
			});
		} else {
			jpeg = await page.screenshot({ type: "jpeg", quality: 70 });
		}
		writeFileSync(path, jpeg);
		return { path, jpeg };
	}

	/**
	 * Resolve a target to one element. Accepts a snapshot ref (e12), a Playwright selector
	 * (text=…, role=…, css=…, #id, .class, [attr], //xpath) or plain visible text, in which case
	 * interactive elements win over static text (so "Sign in" hits the button, not the heading).
	 */
	async locator(page: Page, target: string, prefer: "click" | "fill" = "click"): Promise<Locator> {
		const t = target.trim();
		if (/^e\d+$/.test(t)) {
			const loc = page.locator(`[data-ls-ref="${t}"]`).first();
			if (!(await loc.count())) throw new Error(`Ref ${t} is not on the current page (refs go stale after navigation/re-render). Take a snapshot and use a fresh ref.`);
			return loc;
		}
		if (/^(text=|role=|css=|xpath=|internal:|data-testid=|#|\.|\[|\/\/)/.test(t)) return page.locator(t).first();
		const roles = ["button", "link", "tab", "menuitem", "option", "checkbox", "radio", "switch", "combobox", "textbox", "searchbox", "spinbutton"] as const;
		const candidates: Locator[] = [];
		const byLabel = page.getByLabel(t);
		const byPlaceholder = page.getByPlaceholder(t);
		if (prefer === "fill") candidates.push(byLabel, byPlaceholder);
		for (const exact of [true, false]) for (const r of roles) candidates.push(page.getByRole(r, { name: t, exact }));
		if (prefer === "click") candidates.push(byLabel, byPlaceholder);
		candidates.push(page.getByText(t, { exact: true }), page.getByText(t));
		for (const c of candidates) {
			const visible = c.filter({ visible: true });
			if (await visible.count().catch(() => 0)) return visible.first();
		}
		throw new Error(`Nothing matching "${t}" on the page. Use a ref from the outline (e.g. e12).`);
	}

	/** Diff two outlines line-wise, ignoring ref ids so re-tagged elements don't show as changes. */
	static diff(prev: string, next: string): { added: string[]; removed: string[] } {
		const norm = (l: string) => l.replace(/ \[e\d+\]/g, "");
		const counts = new Map<string, number>();
		for (const l of prev.split("\n")) counts.set(norm(l), (counts.get(norm(l)) ?? 0) + 1);
		const added: string[] = [];
		for (const l of next.split("\n")) {
			const k = norm(l);
			const c = counts.get(k) ?? 0;
			if (c > 0) counts.set(k, c - 1);
			else added.push(l);
		}
		const removed: string[] = [];
		for (const [k, c] of counts) for (let i = 0; i < c; i++) removed.push(k);
		return { added, removed };
	}

	async perform(p: BrowseParams): Promise<BrowseResult> {
		const page = await this.ensurePage();
		const beforeUrl = page.url();
		let summary = "";
		let wantSnapshot = true;
		let forceFull = !!p.full;
		const need = (field: "target" | "value") => {
			if (!p[field]) throw new Error(`action "${p.action}" needs "${field}"`);
			return p[field] as string;
		};
		try {
			switch (p.action) {
				case "open": {
					await this.goto(p.url ?? p.target);
					summary = `Opened ${page.url()}`;
					forceFull = true;
					break;
				}
				case "snapshot":
					summary = "Snapshot";
					forceFull = true;
					break;
				case "click": {
					const loc = await this.locator(page, need("target"));
					await loc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
					await loc.click({ timeout: 8000 });
					await this.settle(page);
					summary = `Clicked ${p.target}`;
					break;
				}
				case "hover": {
					await (await this.locator(page, need("target"))).hover({ timeout: 8000 });
					await page.waitForTimeout(400);
					summary = `Hovered ${p.target}`;
					break;
				}
				case "fill": {
					const loc = await this.locator(page, need("target"), "fill");
					await loc.fill(p.value ?? "", { timeout: 8000 });
					await page.waitForTimeout(250);
					summary = `Filled ${p.target} with "${p.value ?? ""}"`;
					break;
				}
				case "select": {
					const loc = await this.locator(page, need("target"));
					const value = need("value");
					const isNativeSelect = (await loc.and(page.locator("select")).count()) > 0;
					if (isNativeSelect) {
						await loc.selectOption({ label: value }).catch(() => loc.selectOption(value));
					} else {
						await loc.click({ timeout: 8000 });
						await page.waitForTimeout(300);
						const opt = page.getByRole("option", { name: value }).first();
						if (await opt.count()) await opt.click({ timeout: 5000 });
						else await page.getByText(value, { exact: true }).last().click({ timeout: 5000 });
					}
					await this.settle(page, 2500);
					summary = `Selected "${value}" in ${p.target}`;
					break;
				}
				case "check":
				case "uncheck": {
					const loc = await this.locator(page, need("target"));
					if (p.action === "check") await loc.check({ timeout: 8000 }).catch(() => loc.click({ timeout: 8000 }));
					else await loc.uncheck({ timeout: 8000 }).catch(() => loc.click({ timeout: 8000 }));
					await page.waitForTimeout(300);
					summary = `${p.action === "check" ? "Checked" : "Unchecked"} ${p.target}`;
					break;
				}
				case "press": {
					const key = need("value");
					if (p.target) await (await this.locator(page, p.target, "fill")).press(key, { timeout: 8000 });
					else await page.keyboard.press(key);
					await this.settle(page, 2500);
					summary = `Pressed ${key}`;
					break;
				}
				case "upload": {
					const loc = await this.locator(page, need("target"));
					const name = p.value || "sample.txt";
					const dir = this.ws.ensure("tmp");
					const file = join(dir, name.replace(/[^\w.-]/g, "_"));
					writeFileSync(file, sampleFileContent(name));
					await loc.setInputFiles(file, { timeout: 8000 });
					await this.settle(page, 2500);
					summary = `Uploaded dummy file ${name}`;
					break;
				}
				case "back":
					await page.goBack({ timeout: 15000 });
					await this.settle(page);
					summary = "Went back";
					break;
				case "forward":
					await page.goForward({ timeout: 15000 });
					await this.settle(page);
					summary = "Went forward";
					break;
				case "reload":
					await page.reload({ timeout: 30000 });
					await this.settle(page);
					summary = "Reloaded";
					forceFull = true;
					break;
				case "scroll": {
					const dir = (p.value ?? "down").toLowerCase();
					if (p.target) await (await this.locator(page, p.target)).scrollIntoViewIfNeeded({ timeout: 5000 });
					else if (dir === "top") await page.evaluate("window.scrollTo(0,0)");
					else if (dir === "bottom") await page.evaluate("window.scrollTo(0, document.documentElement.scrollHeight)");
					else await page.mouse.wheel(0, dir === "up" ? -700 : 700);
					await page.waitForTimeout(400);
					summary = `Scrolled ${p.target ?? dir}`;
					wantSnapshot = false;
					break;
				}
				case "wait": {
					if (p.target) {
						await page.getByText(p.target).first().waitFor({ timeout: Number(p.value) || 10000 });
						summary = `Waited for "${p.target}"`;
					} else {
						await page.waitForTimeout(Math.min(Number(p.value) || 1000, 15000));
						summary = `Waited ${Number(p.value) || 1000}ms`;
					}
					break;
				}
				case "screenshot":
					summary = "Screenshot";
					wantSnapshot = false;
					break;
				case "viewport": {
					const presets: Record<string, { width: number; height: number }> = {
						mobile: { width: 390, height: 844 },
						tablet: { width: 820, height: 1180 },
						desktop: this.config.viewport,
						wide: { width: 1920, height: 1080 },
					};
					const v = (p.value ?? "desktop").toLowerCase();
					const m = v.match(/^(\d+)x(\d+)$/);
					const size = m ? { width: Number(m[1]), height: Number(m[2]) } : presets[v];
					if (!size) throw new Error(`Unknown viewport "${p.value}". Use mobile, tablet, desktop, wide or WIDTHxHEIGHT.`);
					await page.setViewportSize(size);
					await page.waitForTimeout(500);
					summary = `Viewport set to ${size.width}x${size.height}`;
					forceFull = true;
					break;
				}
				default:
					throw new Error(`Unknown action ${(p as { action: string }).action}`);
			}
		} catch (err) {
			const events = this.drainEvents();
			let outline: string | undefined;
			try {
				const snap = await this.snapshot();
				outline = snap.outline;
				this.lastOutline = { url: snap.url, outline: snap.outline };
			} catch {}
			return {
				ok: false,
				summary: `${p.action} failed`,
				error: (err as Error).message.split("\n").slice(0, 3).join(" "),
				url: page.url(),
				title: await page.title().catch(() => ""),
				navigated: page.url() !== beforeUrl,
				outline,
				outlineMode: outline ? "full" : "none",
				events,
			};
		}

		const result: BrowseResult = {
			ok: true,
			summary,
			url: page.url(),
			title: await page.title().catch(() => ""),
			navigated: page.url() !== beforeUrl,
			events: this.drainEvents(),
			outlineMode: "none",
		};
		// A successful auth request just went through: persist cookies/localStorage so later crawls are logged in.
		if (result.events.net.some((e) => !e.intercepted && MUTATING.has(e.method) && (e.status ?? 500) < 400 && this.isAllowListed(e.url))) {
			const saved = await this.saveStorageState().catch(() => undefined);
			if (saved) result.summary += " (login session saved for later crawls)";
		}

		if (wantSnapshot) {
			const snap = await this.snapshot();
			const fresh = snap.toasts.filter((t) => !this.lastToasts.has(t));
			this.lastToasts = new Set(snap.toasts);
			snap.toasts = fresh;
			result.snapshot = snap;
			const prev = this.lastOutline;
			if (!forceFull && prev && prev.url === snap.url && !result.navigated) {
				const d = SpecBrowser.diff(prev.outline, snap.outline);
				const changed = d.added.length + d.removed.length;
				if (changed === 0) {
					result.outline = "(no visible change to the page outline)";
					result.outlineMode = "diff";
				} else if (changed < Math.max(12, snap.lineCount * 0.5)) {
					result.outline = [...d.removed.map((l) => `- ${l.trim()}`), ...d.added.map((l) => `+ ${l.trim()}`)].join("\n");
					result.outlineMode = "diff";
				} else {
					result.outline = snap.outline;
					result.outlineMode = "full";
				}
			} else {
				result.outline = snap.outline;
				result.outlineMode = "full";
			}
			this.lastOutline = { url: snap.url, outline: snap.outline };
		}

		if (p.screenshot || p.action === "screenshot") {
			const shot = await this.screenshot({ fullPage: p.fullPage });
			result.screenshotPath = shot.path;
			result.screenshotJpeg = shot.jpeg;
		}
		return result;
	}

	get origin(): string | undefined {
		return this.baseOrigin;
	}
}

function sampleFileContent(name: string): string | Buffer {
	const ext = name.split(".").pop()?.toLowerCase();
	if (ext === "csv") return "name,email,amount\nJane Doe,jane@example.com,120\nJohn Roe,john@example.com,80\n";
	if (ext === "json") return JSON.stringify({ sample: true, items: [1, 2, 3] });
	if (ext === "png")
		return Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
			"base64",
		);
	return "Sample file generated by pi-living-spec for exploring upload flows.\n";
}
