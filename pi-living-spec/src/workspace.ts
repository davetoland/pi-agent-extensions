import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Where the extension keeps everything it produces, relative to pi's cwd. */
export const WORKSPACE_DIRNAME = ".living-spec";

export type WriteGuard = "fake" | "block" | "off";

export interface SpecConfig {
	/** Base URL of the running prototype (published lovable.app URL, preview URL or localhost). */
	baseUrl?: string;
	/** Path to the prototype's source (GitHub sync / ZIP export), relative to cwd or absolute. */
	repoPath?: string;
	/**
	 * What to do with mutating HTTP requests (POST/PUT/PATCH/DELETE) the prototype makes while
	 * we explore it. The prototype may be wired to a real backend, so default is "fake":
	 * intercept, record, and answer with a plausible success response.
	 */
	writeGuard: WriteGuard;
	/** Regex sources for URLs whose writes are always allowed (auth by default). */
	writeAllow: string[];
	/** Run the browser headless (default true). */
	headless: boolean;
	/** Default viewport. */
	viewport: { width: number; height: number };
	/** Project / product name used in exported documents. */
	projectName?: string;
}

export const DEFAULT_CONFIG: SpecConfig = {
	writeGuard: "fake",
	writeAllow: ["/auth/v1/", "/token\\b", "/oauth", "/login", "/signin"],
	headless: true,
	viewport: { width: 1366, height: 900 },
};

export class Workspace {
	readonly root: string;

	constructor(readonly cwd: string) {
		this.root = join(cwd, WORKSPACE_DIRNAME);
	}

	path(...parts: string[]): string {
		return join(this.root, ...parts);
	}

	ensure(...sub: string[]): string {
		const p = this.path(...sub);
		mkdirSync(p, { recursive: true });
		const gi = this.path(".gitignore");
		// Saved login sessions and scratch files must never be committed.
		if (!existsSync(gi)) writeFileSync(gi, "auth/\ntmp/\n", "utf8");
		return p;
	}

	readJson<T>(rel: string, fallback: T): T {
		const p = this.path(rel);
		if (!existsSync(p)) return fallback;
		try {
			return JSON.parse(readFileSync(p, "utf8")) as T;
		} catch {
			return fallback;
		}
	}

	writeJson(rel: string, data: unknown): string {
		this.ensure();
		const p = this.path(rel);
		mkdirSync(join(p, ".."), { recursive: true });
		writeFileSync(p, `${JSON.stringify(data, null, 2)}\n`, "utf8");
		return p;
	}

	writeText(rel: string, text: string): string {
		this.ensure();
		const p = this.path(rel);
		mkdirSync(join(p, ".."), { recursive: true });
		writeFileSync(p, text, "utf8");
		return p;
	}

	loadConfig(): SpecConfig {
		const raw = this.readJson<Partial<SpecConfig>>("config.json", {});
		return { ...DEFAULT_CONFIG, ...raw, viewport: { ...DEFAULT_CONFIG.viewport, ...(raw.viewport ?? {}) } };
	}

	saveConfig(patch: Partial<SpecConfig>): SpecConfig {
		const next = { ...this.loadConfig(), ...patch };
		this.writeJson("config.json", next);
		return next;
	}

	resolveRepo(repoPath?: string): string | undefined {
		const p = repoPath ?? this.loadConfig().repoPath;
		if (!p) return undefined;
		return resolve(this.cwd, p.replace(/^@/, ""));
	}

	/** Make a path relative to cwd for display. */
	rel(p: string): string {
		return p.startsWith(this.cwd) ? p.slice(this.cwd.length + 1) || "." : p;
	}
}

export function slugify(s: string, max = 60): string {
	const slug = s
		.toLowerCase()
		.replace(/^https?:\/\/[^/]+/, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return (slug || "home").slice(0, max);
}

export function timestamp(): string {
	return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}
