/**
 * Static analysis of a Lovable (or similar Vite/React/TanStack/Next) prototype's source.
 *
 * Produces a "source map": routes → screens → what each screen shows and does,
 * the data model (Supabase types + migrations), auth, integrations, mock data,
 * validation rules and unfinished/stubbed behaviour. It never executes project code.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import type * as TS from "typescript";

type TSModule = typeof TS;

export interface ZodField {
	name: string;
	rules: string;
}
export interface FileFacts {
	file: string;
	kind: "page" | "component" | "hook" | "lib" | "server" | "route" | "other";
	headings: string[];
	buttons: string[];
	labels: string[];
	placeholders: string[];
	formFields: string[];
	options: string[];
	tabs: string[];
	navigations: string[];
	supabase: string[];
	fetches: string[];
	toasts: string[];
	zodSchemas: { name: string; fields: ZodField[] }[];
	mockData: { name: string; count: number; fields: string[]; sample: string }[];
	stubs: string[];
	todos: string[];
	state: string[];
	queries: string[];
	serverFns: string[];
	conditions: string[];
	widgets: string[];
	texts: string[];
	localImports: string[];
}

export interface RouteInfo {
	path: string;
	component?: string;
	file?: string;
	guards: string[];
	source: "react-router" | "tanstack" | "next" | "unknown";
	index?: boolean;
	layout?: string;
}

export interface TableInfo {
	name: string;
	columns: { name: string; type: string; nullable?: boolean; default?: string }[];
	relations: string[];
	source: "types.ts" | "migration";
}

export interface SourceMap {
	scannedAt: string;
	repo: string;
	product: { name?: string; title?: string; description?: string };
	stack: string[];
	capabilities: string[];
	routes: RouteInfo[];
	screens: { route: string; files: string[]; facts: Omit<FileFacts, "file" | "kind" | "localImports"> }[];
	sharedComponents: { file: string; usedBy: number }[];
	tables: TableInfo[];
	enums: Record<string, string[]>;
	dbFunctions: string[];
	policies: { table: string; name: string; command: string; using?: string; check?: string }[];
	rlsTables: string[];
	triggers: string[];
	storageBuckets: string[];
	edgeFunctions: { name: string; env: string[]; externalHosts: string[]; inputs: string[]; calledFrom: string[] }[];
	serverFunctions: { file: string; names: string[] }[];
	auth: string[];
	envVars: string[];
	mockData: { file: string; name: string; count: number; fields: string[]; sample: string }[];
	stubs: { file: string; note: string }[];
	todos: { file: string; note: string }[];
	designTokens: string[];
	uiKit: string[];
	files: number;
	warnings: string[];
}

const IGNORE_DIRS = new Set(["node_modules", "dist", "build", ".git", ".next", ".output", ".vercel", ".netlify", ".living-spec", "coverage", ".turbo", ".vinxi"]);
const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx"]);
const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "CardTitle", "DialogTitle", "SheetTitle", "AlertDialogTitle", "DrawerTitle", "PageHeader", "PageTitle"]);
const BUTTON_TAGS = new Set(["button", "Button", "DropdownMenuItem", "MenuItem", "ContextMenuItem", "CommandItem", "AlertDialogAction", "AlertDialogCancel", "MenubarItem"]);
const LABEL_TAGS = new Set(["label", "Label", "FormLabel", "FormDescription"]);
const LINK_TAGS = new Set(["Link", "NavLink", "a"]);
const OPTION_TAGS = new Set(["SelectItem", "option", "RadioGroupItem", "ToggleGroupItem"]);
const STUB_TEXT = /\b(coming soon|not (yet )?implemented|under construction|lorem ipsum|placeholder data|mock(ed)? data|dummy|demo only|fake data|todo)\b/i;

const CAPABILITY_HINTS: [RegExp, string][] = [
	[/^@supabase\/supabase-js$/, "Supabase backend (Postgres DB, auth, storage, edge functions)"],
	[/^@tanstack\/react-query$/, "Server-state fetching/caching (TanStack Query)"],
	[/^react-hook-form$/, "Validated forms (react-hook-form)"],
	[/^zod$/, "Schema validation (zod) – field rules are extractable"],
	[/^recharts$|^chart\.js$|^react-chartjs-2$|^@nivo\//, "Charts / data visualisation"],
	[/^react-day-picker$|^date-fns$|^dayjs$|^moment$/, "Dates / date picking"],
	[/^@dnd-kit\/|^react-beautiful-dnd$|^@hello-pangea\/dnd$/, "Drag and drop"],
	[/^embla-carousel/, "Carousels"],
	[/^stripe$|^@stripe\//, "Payments (Stripe)"],
	[/^(mapbox-gl|leaflet|react-leaflet|@react-google-maps\/api|maplibre-gl)$/, "Maps"],
	[/^(i18next|react-i18next|react-intl|@lingui\/)/, "Internationalisation"],
	[/^next-themes$/, "Light/dark theme switching"],
	[/^(@tiptap\/|slate|lexical|react-quill|@uiw\/react-md-editor)/, "Rich-text editing"],
	[/^(react-markdown|marked|remark)/, "Markdown rendering"],
	[/^(xlsx|papaparse|exceljs|react-csv)$/, "Spreadsheet/CSV import or export"],
	[/^(jspdf|@react-pdf\/renderer|pdfmake|html2canvas)$/, "PDF / image export"],
	[/^(openai|@anthropic-ai\/sdk|ai|@ai-sdk\/)/, "AI / LLM features"],
	[/^(resend|@sendgrid\/mail|nodemailer)$/, "Transactional email"],
	[/^react-dropzone$/, "File uploads (drag & drop)"],
	[/^input-otp$/, "One-time-passcode inputs"],
	[/^cmdk$/, "Command palette / searchable menus"],
	[/^framer-motion$|^motion$/, "Animations"],
	[/^(socket\.io-client|pusher-js|ably)$/, "Realtime updates"],
	[/^@clerk\/|^@auth0\/|^firebase$|^next-auth$/, "Third-party auth provider"],
	[/^(@tanstack\/react-table|ag-grid-react)$/, "Data grids / sortable tables"],
	[/^react-resizable-panels$/, "Resizable split panes"],
	[/^vaul$/, "Mobile-style drawers"],
	[/^qrcode|^react-qr/, "QR codes"],
];

function walkFiles(root: string, out: string[] = [], depth = 0): string[] {
	if (depth > 12) return out;
	let entries: string[] = [];
	try {
		entries = readdirSync(root);
	} catch {
		return out;
	}
	for (const name of entries) {
		if (IGNORE_DIRS.has(name)) continue;
		const p = join(root, name);
		let st;
		try {
			st = statSync(p);
		} catch {
			continue;
		}
		if (st.isDirectory()) walkFiles(p, out, depth + 1);
		else out.push(p);
	}
	return out;
}

function readSafe(p: string): string {
	try {
		return readFileSync(p, "utf8");
	} catch {
		return "";
	}
}

function stripJsonComments(s: string): string {
	return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1").replace(/,(\s*[}\]])/g, "$1");
}

function uniq<T>(xs: T[], cap = 200): T[] {
	return [...new Set(xs)].slice(0, cap);
}

function squash(s: string, max = 160): string {
	const t = s.replace(/\s+/g, " ").trim();
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export async function scanSource(repoRoot: string): Promise<SourceMap> {
	const ts: TSModule = ((await import("typescript")) as unknown as { default?: TSModule }).default ?? ((await import("typescript")) as unknown as TSModule);
	const root = resolve(repoRoot);
	if (!existsSync(root)) throw new Error(`Repo path not found: ${root}`);
	const warnings: string[] = [];
	const all = walkFiles(root);
	const relOf = (p: string) => relative(root, p).split(sep).join("/");

	// ---------- package.json, stack, capabilities ----------
	const pkg = JSON.parse(readSafe(join(root, "package.json")) || "{}") as {
		name?: string;
		dependencies?: Record<string, string>;
		devDependencies?: Record<string, string>;
	};
	const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
	const depNames = Object.keys(deps);
	const stack: string[] = [];
	if (existsSync(join(root, "vite.config.ts")) || existsSync(join(root, "vite.config.js"))) stack.push("Vite SPA");
	if (existsSync(join(root, "app.config.ts")) || deps["@tanstack/react-start"] || deps["@tanstack/start"]) stack.push("TanStack Start (SSR)");
	if (deps.next) stack.push("Next.js");
	if (deps["react-router-dom"] || deps["react-router"]) stack.push("React Router");
	if (deps["@tanstack/react-router"]) stack.push("TanStack Router");
	if (deps.react) stack.push(`React ${deps.react}`);
	if (deps.tailwindcss) stack.push("Tailwind CSS");
	if (deps["@supabase/supabase-js"]) stack.push("Supabase");
	if (all.some((f) => /components\/ui\/button\.(t|j)sx$/.test(relOf(f)))) stack.push("shadcn/ui (Radix)");
	if (existsSync(join(root, "supabase", "config.toml"))) stack.push("Supabase project config (Lovable Cloud / Supabase)");
	const capabilities = uniq(
		depNames.flatMap((d) => CAPABILITY_HINTS.filter(([re]) => re.test(d)).map(([, label]) => label)),
	);

	// ---------- product metadata ----------
	const product: SourceMap["product"] = { name: pkg.name };
	const indexHtml = readSafe(join(root, "index.html"));
	if (indexHtml) {
		product.title = indexHtml.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim();
		product.description = indexHtml.match(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i)?.[1]?.trim();
	}

	// ---------- path aliases ----------
	const aliases: [string, string][] = [];
	for (const tsc of ["tsconfig.json", "tsconfig.app.json"]) {
		const raw = readSafe(join(root, tsc));
		if (!raw) continue;
		try {
			const j = JSON.parse(stripJsonComments(raw)) as { compilerOptions?: { paths?: Record<string, string[]>; baseUrl?: string } };
			const base = j.compilerOptions?.baseUrl ?? ".";
			for (const [k, v] of Object.entries(j.compilerOptions?.paths ?? {})) {
				if (v[0]) aliases.push([k.replace(/\*$/, ""), join(root, base, v[0].replace(/\*$/, ""))]);
			}
		} catch {
			warnings.push(`Could not parse ${tsc}`);
		}
	}
	const srcRoot = existsSync(join(root, "src")) ? join(root, "src") : existsSync(join(root, "app")) ? join(root, "app") : root;
	if (!aliases.some(([k]) => k === "@/")) aliases.push(["@/", `${srcRoot}/`]);
	if (!aliases.some(([k]) => k === "~/")) aliases.push(["~/", `${srcRoot}/`]);

	const codeFiles = all.filter((f) => CODE_EXT.has(extname(f)) && !/\.(test|spec|stories)\.[jt]sx?$/.test(f) && !f.endsWith(".d.ts"));
	const isUiKit = (rel: string) => /(^|\/)components\/ui\//.test(rel);
	const uiKit = codeFiles.filter((f) => isUiKit(relOf(f))).map((f) => basename(f).replace(/\.[jt]sx?$/, ""));

	const resolveImport = (from: string, spec: string): string | undefined => {
		let base: string | undefined;
		if (spec.startsWith(".")) base = resolve(dirname(from), spec);
		else {
			const a = aliases.find(([k]) => spec.startsWith(k));
			if (a) base = join(a[1], spec.slice(a[0].length));
		}
		if (!base) return undefined;
		for (const cand of [base, ...[".tsx", ".ts", ".jsx", ".js"].map((e) => base + e), ...["index.tsx", "index.ts", "index.jsx", "index.js"].map((i) => join(base!, i))]) {
			if (existsSync(cand) && statSync(cand).isFile()) return cand;
		}
		return undefined;
	};

	// ---------- per-file analysis ----------
	const facts = new Map<string, FileFacts>();
	const importMaps = new Map<string, Map<string, string>>(); // file -> identifier -> specifier
	const sources = new Map<string, TS.SourceFile>();

	for (const file of codeFiles) {
		const rel = relOf(file);
		if (isUiKit(rel)) continue;
		if (/integrations\/supabase\/types\.ts$/.test(rel) || /routeTree\.gen\.ts$/.test(rel)) continue;
		const text = readSafe(file);
		if (text.length > 400_000) {
			warnings.push(`Skipped very large file ${rel}`);
			continue;
		}
		const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
		sources.set(file, sf);
		const { facts: f, imports } = analyzeFile(ts, sf, rel, (spec) => resolveImport(file, spec));
		f.localImports = f.localImports.map((p) => relOf(p));
		facts.set(rel, f);
		importMaps.set(rel, imports);
	}

	// ---------- routes ----------
	const routes: RouteInfo[] = [];
	for (const [file, sf] of sources) {
		const rel = relOf(file);
		if (!/<Route\b|createBrowserRouter|createHashRouter|createMemoryRouter|useRoutes\(/.test(sf.text)) continue;
		routes.push(...extractReactRouterRoutes(ts, sf, (spec) => {
			const r = resolveImport(file, spec);
			return r ? relOf(r) : undefined;
		}, importMaps.get(rel)));
	}
	const routeDirs = ["app/routes", "src/routes"].map((d) => join(root, d)).filter((d) => existsSync(d));
	for (const dir of routeDirs) {
		for (const file of codeFiles.filter((f) => f.startsWith(dir + sep))) {
			const sf = sources.get(file);
			const rel = relOf(file);
			if (!sf || /__root\.[jt]sx?$/.test(file)) continue;
			const literal = sf.text.match(/create(?:File|LazyFile)Route\(\s*["'`]([^"'`]+)["'`]/)?.[1];
			const derived = tanstackPathFromFile(relative(dir, file).split(sep).join("/"));
			if (derived === null) continue;
			const guards: string[] = [];
			if (/beforeLoad[\s\S]{0,400}redirect\(/.test(sf.text)) guards.push("beforeLoad redirect (auth/permission guard)");
			const comp = sf.text.match(/component:\s*([A-Z]\w*)/)?.[1];
			routes.push({ path: normalizeTanstackPath(literal ?? derived), component: comp, file: rel, guards, source: "tanstack" });
		}
	}
	const nextApp = ["app", "src/app"].map((d) => join(root, d)).find((d) => existsSync(d) && deps.next);
	if (nextApp) {
		for (const file of codeFiles.filter((f) => f.startsWith(nextApp + sep) && /\/page\.[jt]sx?$/.test(f))) {
			const segs = relative(nextApp, dirname(file)).split(sep).filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith("@"));
			routes.push({ path: `/${segs.map((s) => s.replace(/^\[\.\.\.(\w+)\]$/, "*").replace(/^\[(\w+)\]$/, ":$1")).join("/")}`, file: relOf(file), guards: [], source: "next" });
		}
	}
	if (!routes.length) {
		// Fall back to pages/ directory conventions
		for (const file of codeFiles.filter((f) => /\/pages\/[^/]+\.[jt]sx$/.test(relOf(f)))) {
			const name = basename(file).replace(/\.[jt]sx$/, "");
			routes.push({ path: name === "Index" ? "/" : `/(unrouted) ${name}`, file: relOf(file), component: name, guards: [], source: "unknown" });
		}
		if (codeFiles.length) warnings.push("No router configuration found; screens inferred from pages/ directory.");
	}
	// de-dupe
	const seenRoute = new Set<string>();
	const routesU = routes.filter((r) => {
		const k = `${r.path}|${r.file}`;
		if (seenRoute.has(k)) return false;
		seenRoute.add(k);
		return true;
	});

	// ---------- screens (route file + transitive project components) ----------
	const usage = new Map<string, number>();
	const screens: SourceMap["screens"] = [];
	for (const r of routesU) {
		if (!r.file || !facts.has(r.file)) continue;
		const files: string[] = [];
		const visit = (f: string, d: number) => {
			if (files.includes(f) || d > 4) return;
			const ff = facts.get(f);
			if (!ff) return;
			files.push(f);
			for (const imp of ff.localImports) {
				if (/\/(lib|utils|integrations|types|hooks\/use-toast|hooks\/use-mobile)\b/.test(imp) && !/\/hooks\//.test(imp)) continue;
				if (/(^|\/)(pages|routes)\//.test(imp) && d > 0) continue;
				visit(imp, d + 1);
			}
		};
		visit(r.file, 0);
		for (const f of files.slice(1)) usage.set(f, (usage.get(f) ?? 0) + 1);
		screens.push({ route: r.path, files, facts: mergeFacts(files.map((f) => facts.get(f)!)) });
	}
	const sharedComponents = [...usage].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]).map(([file, usedBy]) => ({ file, usedBy }));

	// ---------- Supabase types.ts ----------
	const tables: TableInfo[] = [];
	const enums: Record<string, string[]> = {};
	const dbFunctions: string[] = [];
	const typesFile = codeFiles.find((f) => /integrations\/supabase\/types\.ts$/.test(relOf(f)));
	if (typesFile) {
		const sf = ts.createSourceFile(typesFile, readSafe(typesFile), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		parseSupabaseTypes(ts, sf, tables, enums, dbFunctions);
	}

	// ---------- migrations ----------
	const migrationFiles = all.filter((f) => /supabase\/migrations\/.+\.sql$/.test(relOf(f))).sort();
	const policies: SourceMap["policies"] = [];
	const rlsTables: string[] = [];
	const triggers: string[] = [];
	const storageBuckets: string[] = [];
	for (const mf of migrationFiles) {
		parseMigration(readSafe(mf), { tables, enums, dbFunctions, policies, rlsTables, triggers, storageBuckets });
	}

	// ---------- edge functions ----------
	const edgeFunctions: SourceMap["edgeFunctions"] = [];
	const fnRoot = join(root, "supabase", "functions");
	if (existsSync(fnRoot)) {
		for (const name of readdirSync(fnRoot)) {
			if (name.startsWith("_") || name.startsWith(".")) continue;
			const dir = join(fnRoot, name);
			if (!statSync(dir).isDirectory()) continue;
			const text = walkFiles(dir).filter((f) => CODE_EXT.has(extname(f))).map(readSafe).join("\n");
			const env = uniq([...text.matchAll(/(?:Deno\.env\.get|process\.env)\s*[.(]\s*["'`]?([A-Z0-9_]+)/g)].map((m) => m[1]));
			const hosts = uniq([...text.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)].map((m) => m[1]).filter((h) => !/supabase\.co$|deno\.land|esm\.sh|jsr\.io/.test(h)));
			const inputs = uniq([...text.matchAll(/const\s*\{([^}]+)\}\s*=\s*await\s+req\.json\(\)/g)].flatMap((m) => m[1].split(",").map((s) => s.trim().split(/[:=\s]/)[0]).filter(Boolean)));
			const calledFrom = [...facts.values()].filter((f) => f.supabase.some((s) => s.includes(`functions.invoke(${name})`))).map((f) => f.file);
			edgeFunctions.push({ name, env, externalHosts: hosts, inputs, calledFrom });
		}
	}
	const serverFunctions = [...facts.values()].filter((f) => f.serverFns.length).map((f) => ({ file: f.file, names: f.serverFns }));

	// ---------- auth ----------
	const auth = uniq(
		[...facts.values()].flatMap((f) => f.supabase.filter((s) => s.startsWith("auth.")).map((s) => `${s} (${f.file})`)),
		60,
	);
	for (const r of routesU) if (r.guards.length) auth.push(`Route ${r.path} guarded by ${r.guards.join(", ")}`);
	for (const f of facts.values()) for (const c of f.conditions) auth.push(`Condition in ${f.file}: ${c}`);

	// ---------- env vars ----------
	const envVars = uniq(
		[".env", ".env.example", ".env.local", ".env.sample"].flatMap((n) =>
			readSafe(join(root, n))
				.split("\n")
				.map((l) => l.match(/^\s*([A-Z][A-Z0-9_]+)\s*=/)?.[1])
				.filter((x): x is string => !!x),
		),
	);
	for (const f of codeFiles) {
		for (const m of readSafe(f).matchAll(/import\.meta\.env\.([A-Z0-9_]+)|process\.env\.([A-Z0-9_]+)/g)) envVars.push(m[1] ?? m[2]);
	}

	// ---------- design tokens ----------
	const designTokens: string[] = [];
	const cssFile = ["src/index.css", "app/styles.css", "src/styles.css", "app/globals.css", "src/app/globals.css", "src/styles/globals.css"].map((p) => join(root, p)).find(existsSync);
	if (cssFile) {
		const css = readSafe(cssFile);
		const rootBlock = css.match(/:root\s*\{([\s\S]*?)\}/)?.[1] ?? "";
		for (const m of rootBlock.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) if (designTokens.length < 40) designTokens.push(`--${m[1]}: ${m[2].trim()}`);
		if (/\.dark\s*\{/.test(css)) designTokens.push("(dark theme tokens defined)");
		const fonts = [...css.matchAll(/@import\s+url\(['"]?([^'")]+fonts[^'")]+)/g)].map((m) => m[1]);
		for (const f of fonts) designTokens.push(`font import: ${f}`);
	}

	// ---------- roll-ups ----------
	const mockData = [...facts.values()].flatMap((f) => f.mockData.map((m) => ({ file: f.file, ...m })));
	const stubs = [...facts.values()].flatMap((f) => f.stubs.map((note) => ({ file: f.file, note })));
	const todos = [...facts.values()].flatMap((f) => f.todos.map((note) => ({ file: f.file, note })));

	return {
		scannedAt: new Date().toISOString(),
		repo: root,
		product,
		stack,
		capabilities,
		routes: routesU,
		screens,
		sharedComponents,
		tables,
		enums,
		dbFunctions: uniq(dbFunctions),
		policies,
		rlsTables: uniq(rlsTables),
		triggers: uniq(triggers),
		storageBuckets: uniq(storageBuckets),
		edgeFunctions,
		serverFunctions,
		auth: uniq(auth, 80),
		envVars: uniq(envVars),
		mockData,
		stubs,
		todos,
		designTokens,
		uiKit,
		files: codeFiles.length,
		warnings,
	};
}

function normalizeTanstackPath(p: string): string {
	const segs = p.split("/").filter((x) => x && !x.startsWith("_") && !/^\(.*\)$/.test(x));
	return `/${segs.join("/")}`;
}

function tanstackPathFromFile(rel: string): string | null {
	const noExt = rel.replace(/\.[jt]sx?$/, "");
	if (/(^|\/)-/.test(noExt) || /\.(server|test|spec)$/.test(noExt)) return null; // ignored files (-components etc.)
	const parts = noExt
		.split(/[/.]/)
		.filter((p) => p && p !== "index" && p !== "route" && !/^_/.test(p) && !/^\(.*\)$/.test(p))
		.map((p) => p.replace(/_$/, ""))
		.map((p) => (p === "$" ? "*" : p));
	return `/${parts.join("/")}`;
}

function mergeFacts(list: FileFacts[]): SourceMap["screens"][number]["facts"] {
	const keys = [
		"headings", "buttons", "labels", "placeholders", "formFields", "options", "tabs", "navigations", "supabase", "fetches",
		"toasts", "stubs", "todos", "state", "queries", "serverFns", "conditions", "widgets", "texts",
	] as const;
	const out: Record<string, unknown> = {};
	for (const k of keys) out[k] = uniq(list.flatMap((f) => f[k] as string[]), k === "texts" ? 25 : 80);
	out.zodSchemas = list.flatMap((f) => f.zodSchemas);
	out.mockData = list.flatMap((f) => f.mockData);
	return out as SourceMap["screens"][number]["facts"];
}

// ---------------------------------------------------------------------------
// File analysis
// ---------------------------------------------------------------------------

function analyzeFile(
	ts: TSModule,
	sf: TS.SourceFile,
	rel: string,
	resolveImport: (spec: string) => string | undefined,
): { facts: FileFacts; imports: Map<string, string> } {
	const kind: FileFacts["kind"] = /\.server\.[jt]sx?$/.test(rel)
		? "server"
		: /(^|\/)routes\//.test(rel)
			? "route"
			: /(^|\/)(pages|app)\//.test(rel) && /\.[jt]sx$/.test(rel)
				? "page"
				: /(^|\/)components\//.test(rel)
					? "component"
					: /(^|\/)hooks\//.test(rel)
						? "hook"
						: /(^|\/)(lib|utils|services|api)\//.test(rel)
							? "lib"
							: "other";
	const f: FileFacts = {
		file: rel, kind, headings: [], buttons: [], labels: [], placeholders: [], formFields: [], options: [], tabs: [],
		navigations: [], supabase: [], fetches: [], toasts: [], zodSchemas: [], mockData: [], stubs: [], todos: [], state: [],
		queries: [], serverFns: [], conditions: [], widgets: [], texts: [], localImports: [],
	};
	const imports = new Map<string, string>();

	for (const st of sf.statements) {
		if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
			const spec = st.moduleSpecifier.text;
			const clause = st.importClause;
			if (clause?.name) imports.set(clause.name.text, spec);
			if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
				for (const el of clause.namedBindings.elements) imports.set(el.name.text, spec);
			}
			const r = resolveImport(spec);
			if (r) f.localImports.push(r);
		}
	}
	// lazy(() => import("./pages/X"))
	for (const m of sf.text.matchAll(/import\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) {
		const r = resolveImport(m[1]);
		if (r) f.localImports.push(r);
	}

	const jsxText = (node: TS.JsxElement): string => {
		const parts: string[] = [];
		const recChildren = (el: TS.JsxElement | TS.JsxFragment) => {
			for (const c of el.children) rec(c);
		};
		const rec = (n: TS.Node) => {
			if (ts.isJsxText(n)) parts.push(n.text);
			else if (ts.isJsxElement(n) || ts.isJsxFragment(n)) recChildren(n);
			else if (ts.isJsxSelfClosingElement(n)) return;
			else if (ts.isJsxExpression(n) && n.expression) {
				const e = n.expression;
				if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) parts.push(e.text);
				else if (ts.isTemplateExpression(e)) parts.push(templateToPattern(ts, e));
				else if (ts.isConditionalExpression(e)) {
					rec(e.whenTrue);
					parts.push("/");
					rec(e.whenFalse);
				} else if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) rec(e.right);
				else if (ts.isJsxElement(e) || ts.isJsxFragment(e)) recChildren(e);
				else if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) parts.push(`{${squash(e.getText(sf), 30)}}`);
			} else if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) parts.push(n.text);
			else if (ts.isParenthesizedExpression(n)) rec(n.expression);
		};
		recChildren(node);
		return squash(parts.join(" ").replace(/\s*\/\s*$/, ""), 120);
	};
	const attr = (el: TS.JsxOpeningLikeElement, name: string): string | undefined => {
		for (const p of el.attributes.properties) {
			if (ts.isJsxAttribute(p) && p.name.getText(sf) === name) {
				if (!p.initializer) return "true";
				if (ts.isStringLiteral(p.initializer)) return p.initializer.text;
				if (ts.isJsxExpression(p.initializer) && p.initializer.expression) {
					const e = p.initializer.expression;
					if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
					if (ts.isTemplateExpression(e)) return templateToPattern(ts, e);
					return `{${squash(e.getText(sf), 80)}}`;
				}
			}
		}
		return undefined;
	};
	const attrNode = (el: TS.JsxOpeningLikeElement, name: string): TS.Expression | undefined => {
		for (const p of el.attributes.properties) {
			if (ts.isJsxAttribute(p) && p.name.getText(sf) === name && p.initializer && ts.isJsxExpression(p.initializer)) return p.initializer.expression;
		}
		return undefined;
	};
	const iconChild = (node: TS.JsxElement): string | undefined => {
		for (const c of node.children) {
			if (ts.isJsxSelfClosingElement(c)) {
				const t = c.tagName.getText(sf);
				if (imports.get(t) === "lucide-react" || /Icon$/.test(t)) return `icon:${t}`;
			}
		}
		return undefined;
	};
	const isStubHandler = (e: TS.Expression | undefined): string | undefined => {
		if (!e || !(ts.isArrowFunction(e) || ts.isFunctionExpression(e))) return undefined;
		const body = e.body;
		if (ts.isBlock(body)) {
			if (body.statements.length === 0) return "empty handler";
			if (body.statements.every((s) => /^\s*(console\.(log|info|warn)|alert)\(/.test(s.getText(sf)))) return `handler only logs: ${squash(body.getText(sf), 80)}`;
		} else if (/^(console\.(log|info|warn)|alert)\(/.test(body.getText(sf))) return `handler only logs: ${squash(body.getText(sf), 80)}`;
		return undefined;
	};

	const visit = (node: TS.Node) => {
		// ---------- JSX ----------
		if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
			const open = ts.isJsxElement(node) ? node.openingElement : node;
			const tag = open.tagName.getText(sf);
			const text = ts.isJsxElement(node) ? jsxText(node) : "";
			const src = imports.get(tag.split(".")[0]);
			if (HEADING_TAGS.has(tag) && text) f.headings.push(text.replace(/^\{(\w+)\}$/, "(dynamic: $1)"));
			if (BUTTON_TAGS.has(tag)) {
				const label = text || attr(open, "aria-label") || attr(open, "title") || (ts.isJsxElement(node) ? iconChild(node) : undefined) || "(unlabelled)";
				f.buttons.push(label);
				const stub = isStubHandler(attrNode(open, "onClick")) ?? isStubHandler(attrNode(open, "onSelect"));
				if (stub) f.stubs.push(`"${label}" ${stub}`);
				if (attr(open, "disabled") === "true") f.stubs.push(`"${label}" is permanently disabled`);
			} else if (tag !== "form") {
				const stub = isStubHandler(attrNode(open, "onClick"));
				if (stub) f.stubs.push(`<${tag}> "${text || tag}" ${stub}`);
			}
			if (tag === "form" || tag === "Form") {
				const stub = isStubHandler(attrNode(open, "onSubmit"));
				if (stub) f.stubs.push(`form submit ${stub}`);
			}
			if (LABEL_TAGS.has(tag) && text) f.labels.push(text);
			if (OPTION_TAGS.has(tag)) f.options.push(text || attr(open, "value") || "?");
			if (tag === "TabsTrigger") f.tabs.push(text || attr(open, "value") || "?");
			const ph = attr(open, "placeholder");
			if (ph && !ph.startsWith("{")) f.placeholders.push(ph);
			if (tag === "FormField" || tag === "Controller") {
				const name = attr(open, "name");
				if (name) f.formFields.push(name);
			}
			if (tag === "Input" || tag === "input" || tag === "Textarea" || tag === "textarea" || tag === "Checkbox" || tag === "Switch" || tag === "Select" || tag === "RadioGroup" || tag === "Slider" || tag === "Calendar" || tag === "InputOTP") {
				const name = attr(open, "name") ?? attr(open, "id");
				const type = attr(open, "type");
				const req = attr(open, "required") ? " required" : "";
				const phx = !name && ph && !ph.startsWith("{") ? ` "${ph}"` : "";
				if (name || type || phx || req) f.formFields.push(`${tag}${name ? ` ${name}` : ""}${phx}${type && !type.startsWith("{") ? ` (${type})` : ""}${req}`);
			}
			if (LINK_TAGS.has(tag)) {
				const to = attr(open, "to") ?? attr(open, "href");
				if (to && !to.startsWith("{")) f.navigations.push(to);
			}
			if (src && !src.startsWith(".") && !src.startsWith("@/") && !src.startsWith("~/") && src !== "lucide-react" && /^[A-Z]/.test(tag) && !/^react(-dom)?$/.test(src) && !/^react-router/.test(src) && !/^@tanstack\/react-router/.test(src)) {
				f.widgets.push(`${src}:${tag}`);
			}
			if (/^(p|span|li|td|Badge|CardDescription|AlertDescription|DialogDescription|small|strong|Alert|AlertTitle)$/.test(tag) && text && text.replace(/\{[^}]*\}/g, "").trim().length > 3) {
				f.texts.push(text);
			}
		}

		// ---------- Calls ----------
		if (ts.isCallExpression(node)) {
			const callee = node.expression;
			const calleeText = callee.getText(sf);
			const arg0 = node.arguments[0];
			const strArg = (a?: TS.Expression) =>
				a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) ? a.text : a && ts.isTemplateExpression(a) ? templateToPattern(ts, a) : undefined;

			if (/^navigate$|^router\.(push|navigate)$|^navigate\(/.test(calleeText) || calleeText === "redirect") {
				const s = strArg(arg0);
				if (s) f.navigations.push(s);
				else if (arg0 && ts.isObjectLiteralExpression(arg0)) {
					const to = arg0.properties.find((p) => p.name?.getText(sf) === "to");
					if (to && ts.isPropertyAssignment(to)) {
						const s2 = strArg(to.initializer);
						if (s2) f.navigations.push(s2);
					}
				}
			}
			if (calleeText === "fetch" || /^axios(\.(get|post|put|patch|delete))?$/.test(calleeText)) {
				const s = strArg(arg0) ?? (arg0 ? `{${squash(arg0.getText(sf), 60)}}` : "?");
				f.fetches.push(`${calleeText} ${s}`);
			}
			if (/^toast(\.(success|error|info|warning|message|promise))?$/.test(calleeText) || calleeText === "sonnerToast") {
				let msg = strArg(arg0);
				if (!msg && arg0 && ts.isObjectLiteralExpression(arg0)) {
					msg = arg0.properties
						.filter((p): p is TS.PropertyAssignment => ts.isPropertyAssignment(p) && /^(title|description)$/.test(p.name.getText(sf)))
						.map((p) => strArg(p.initializer) ?? `{${squash(p.initializer.getText(sf), 30)}}`)
						.join(" — ");
				}
				const variant = arg0 && ts.isObjectLiteralExpression(arg0) && /variant:\s*["']destructive/.test(arg0.getText(sf)) ? "error: " : calleeText.includes(".") ? `${calleeText.split(".")[1]}: ` : "";
				if (msg) {
					f.toasts.push(`${variant}${msg}`);
					if (STUB_TEXT.test(msg)) f.stubs.push(`toast says "${msg}"`);
				}
			}
			if (ts.isPropertyAccessExpression(callee)) {
				const method = callee.name.text;
				const chainRoot = rootIdentifier(ts, callee);
				if (chainRoot === "supabase") {
					const desc = describeSupabaseCall(ts, sf, node, method, strArg);
					if (desc) f.supabase.push(desc);
				}
				if (method === "object" && /^z$/.test(callee.expression.getText(sf)) && arg0 && ts.isObjectLiteralExpression(arg0)) {
					f.zodSchemas.push({ name: declName(ts, node) ?? "(inline schema)", fields: zodFields(ts, sf, arg0) });
				}
			}
			if (calleeText === "useState" || calleeText === "React.useState") {
				const nm = declName(ts, node);
				if (nm) f.state.push(nm);
				if (arg0 && ts.isArrayLiteralExpression(unwrap(ts, arg0))) {
					const m = mockFromArray(ts, sf, unwrap(ts, arg0) as TS.ArrayLiteralExpression, nm ?? "state");
					if (m) f.mockData.push(m);
				}
			}
			if (calleeText === "useQuery" || calleeText === "useSuspenseQuery" || calleeText === "useMutation" || calleeText === "useInfiniteQuery") {
				const key = arg0 && ts.isObjectLiteralExpression(arg0) ? arg0.properties.find((p) => /^(queryKey|mutationKey)$/.test(p.name?.getText(sf) ?? "")) : undefined;
				f.queries.push(`${calleeText}${key ? ` ${squash(key.getText(sf), 80)}` : ""}`);
			}
			if (calleeText === "createServerFn" || calleeText.startsWith("createServerFn(")) {
				f.serverFns.push(declName(ts, node) ?? "(anonymous server fn)");
			}
		}

		// ---------- mock arrays declared as constants ----------
		if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
			const init = unwrap(ts, node.initializer);
			if (ts.isArrayLiteralExpression(init)) {
				const m = mockFromArray(ts, sf, init, node.name.text);
				if (m) f.mockData.push(m);
			}
		}

		// ---------- string literals hinting at stubs ----------
		if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isJsxText(node)) && STUB_TEXT.test(node.text) && node.text.trim().length < 200) {
			const t = squash(node.text, 100);
			if (!f.stubs.some((x) => x.includes(t))) f.stubs.push(`text: "${t}"`);
		}

		// ---------- role / permission checks ----------
		if (ts.isBinaryExpression(node) && /===|!==|==/.test(node.operatorToken.getText(sf))) {
			const t = node.getText(sf);
			if (/role|admin|owner|permission|plan|tier|subscription|isPro|premium/i.test(t) && t.length < 120) f.conditions.push(squash(t, 100));
		}
		if (ts.isIdentifier(node) && /^(isAdmin|isOwner|hasRole|canEdit|canDelete|canManage|isPro|isPremium|hasPermission)$/.test(node.text)) {
			f.conditions.push(node.text);
		}
		node.forEachChild(visit);
	};
	visit(sf);

	for (const m of sf.text.matchAll(/\/\/\s*(TODO|FIXME|HACK|XXX)\b[:\s]*(.*)$/gm)) f.todos.push(`${m[1]}: ${squash(m[2], 140)}`);
	for (const m of sf.text.matchAll(/\/\*\s*(TODO|FIXME)\b[:\s]*([\s\S]*?)\*\//g)) f.todos.push(`${m[1]}: ${squash(m[2], 140)}`);

	for (const k of Object.keys(f) as (keyof FileFacts)[]) {
		const v = f[k];
		if (Array.isArray(v) && (v.length === 0 || typeof v[0] === "string")) (f as unknown as Record<string, unknown>)[k] = uniq(v as string[], 120);
	}
	return { facts: f, imports };
}

function unwrap(ts: TSModule, e: TS.Expression): TS.Expression {
	let x = e;
	while (ts.isAsExpression(x) || ts.isParenthesizedExpression(x) || ts.isSatisfiesExpression(x) || ts.isTypeAssertionExpression(x)) x = x.expression;
	return x;
}

function templateToPattern(ts: TSModule, t: TS.TemplateExpression): string {
	let s = t.head.text;
	for (const span of t.templateSpans) {
		const e = span.expression;
		const name = ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : "param";
		s += `:${name}${span.literal.text}`;
	}
	return s;
}

function rootIdentifier(ts: TSModule, e: TS.Expression): string | undefined {
	let x: TS.Expression = e;
	for (;;) {
		if (ts.isPropertyAccessExpression(x)) x = x.expression;
		else if (ts.isCallExpression(x)) x = x.expression;
		else if (ts.isNonNullExpression(x) || ts.isParenthesizedExpression(x)) x = x.expression;
		else if (ts.isAwaitExpression(x)) x = x.expression;
		else break;
	}
	return ts.isIdentifier(x) ? x.text : undefined;
}

function declName(ts: TSModule, node: TS.Node): string | undefined {
	let p: TS.Node | undefined = node.parent;
	for (let i = 0; p && i < 8; i++, p = p.parent) {
		if (ts.isVariableDeclaration(p)) {
			if (ts.isIdentifier(p.name)) return p.name.text;
			if (ts.isArrayBindingPattern(p.name)) {
				const first = p.name.elements[0];
				if (first && ts.isBindingElement(first) && ts.isIdentifier(first.name)) return first.name.text;
			}
			if (ts.isObjectBindingPattern(p.name)) return p.name.elements.map((e) => e.name.getText()).join(",");
			return undefined;
		}
		if (ts.isPropertyAssignment(p)) return p.name.getText();
	}
	return undefined;
}

function describeSupabaseCall(
	ts: TSModule,
	sf: TS.SourceFile,
	node: TS.CallExpression,
	method: string,
	strArg: (a?: TS.Expression) => string | undefined,
): string | undefined {
	const callee = node.expression as TS.PropertyAccessExpression;
	const owner = callee.expression.getText(sf).replace(/\s+/g, "");
	const a0 = strArg(node.arguments[0]);
	if (owner === "supabase" && method === "from") {
		// Walk up the chain: supabase.from('t').select('a').eq('x', y)...
		const ops: string[] = [];
		let cur: TS.Node = node;
		while (cur.parent && ts.isPropertyAccessExpression(cur.parent) && cur.parent.parent && ts.isCallExpression(cur.parent.parent)) {
			const m = cur.parent.name.text;
			const call = cur.parent.parent;
			const arg = strArg(call.arguments[0]);
			const objArg = call.arguments[0] && ts.isObjectLiteralExpression(call.arguments[0])
				? `{${call.arguments[0].properties.map((p) => p.name?.getText(sf)).filter(Boolean).join(",")}}`
				: undefined;
			ops.push(`${m}(${arg ?? objArg ?? (call.arguments[0] ? "…" : "")})`);
			cur = call;
		}
		return `from(${a0 ?? "?"}).${ops.join(".") || "?"}`;
	}
	if (owner === "supabase.auth" || owner.endsWith(".auth")) {
		let extra = "";
		const a = node.arguments[0];
		if (a && ts.isObjectLiteralExpression(a)) {
			const prov = a.properties.find((p) => p.name?.getText(sf) === "provider");
			if (prov && ts.isPropertyAssignment(prov)) extra = ` provider=${strArg(prov.initializer) ?? prov.initializer.getText(sf)}`;
			const keys = a.properties.map((p) => p.name?.getText(sf)).filter(Boolean);
			if (!extra && keys.length) extra = ` {${keys.join(",")}}`;
		}
		return `auth.${method}${extra}`;
	}
	if (owner === "supabase.functions" && method === "invoke") return `functions.invoke(${a0 ?? "?"})`;
	if (owner === "supabase" && method === "rpc") return `rpc(${a0 ?? "?"})`;
	if (owner === "supabase.storage" && method === "from") {
		const next = node.parent && ts.isPropertyAccessExpression(node.parent) ? node.parent.name.text : "?";
		return `storage.from(${a0 ?? "?"}).${next}`;
	}
	if (owner === "supabase" && method === "channel") return `realtime channel(${a0 ?? "?"})`;
	if (method === "on" && /postgres_changes/.test(node.getText(sf))) {
		const table = node.getText(sf).match(/table:\s*["'`](\w+)/)?.[1];
		return `realtime on postgres_changes${table ? ` table=${table}` : ""}`;
	}
	return undefined;
}

function zodFields(ts: TSModule, sf: TS.SourceFile, obj: TS.ObjectLiteralExpression): ZodField[] {
	return obj.properties
		.filter((p): p is TS.PropertyAssignment => ts.isPropertyAssignment(p))
		.map((p) => ({ name: p.name.getText(sf).replace(/["']/g, ""), rules: squash(p.initializer.getText(sf).replace(/^z\./, ""), 220) }));
}

function mockFromArray(
	ts: TSModule,
	sf: TS.SourceFile,
	arr: TS.ArrayLiteralExpression,
	name: string,
): FileFacts["mockData"][number] | undefined {
	const objs = arr.elements.filter((e) => ts.isObjectLiteralExpression(e)) as TS.ObjectLiteralExpression[];
	if (objs.length < 2) return undefined;
	const fields = uniq(objs.flatMap((o) => o.properties.map((p) => p.name?.getText(sf).replace(/["']/g, "") ?? "")).filter(Boolean), 40);
	// Navigation/config arrays (label+href/icon) are not "data"
	const isNav = fields.every((x) => /^(title|label|name|href|url|to|path|icon|id|key|value|description|badge|items|children)$/.test(x)) && fields.some((x) => /^(href|url|to|path|icon)$/.test(x));
	return { name: isNav ? `${name} (navigation/config)` : name, count: objs.length, fields, sample: squash(objs[0].getText(sf), 200) };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function extractReactRouterRoutes(
	ts: TSModule,
	sf: TS.SourceFile,
	resolveSpec: (spec: string) => string | undefined,
	imports: Map<string, string> | undefined,
): RouteInfo[] {
	const out: RouteInfo[] = [];
	const lazyMap = new Map<string, string>();
	for (const m of sf.text.matchAll(/(?:const|let)\s+(\w+)\s*=\s*(?:React\.)?lazy\(\s*\(\)\s*=>\s*import\(\s*["'`]([^"'`]+)["'`]/g)) lazyMap.set(m[1], m[2]);
	const fileFor = (comp?: string) => {
		if (!comp) return undefined;
		const spec = imports?.get(comp) ?? lazyMap.get(comp);
		if (!spec) return sf.fileName.endsWith("x") && new RegExp(`function\\s+${comp}\\b|const\\s+${comp}\\s*=`).test(sf.text) ? "(same file)" : undefined;
		return resolveSpec(spec);
	};
	const join = (base: string, p?: string) => {
		if (p === undefined) return base || "/";
		if (p.startsWith("/")) return p;
		return `${base.replace(/\/$/, "")}/${p}`.replace(/\/+/g, "/");
	};
	const elementInfo = (expr?: TS.Node): { component?: string; guards: string[] } => {
		const guards: string[] = [];
		let component: string | undefined;
		const rec = (n: TS.Node) => {
			if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) {
				const tag = (ts.isJsxElement(n) ? n.openingElement : n).tagName.getText(sf);
				if (/^[A-Z]/.test(tag) && !/^(Suspense|Fragment|React\.Fragment|ErrorBoundary)$/.test(tag)) {
					if (ts.isJsxElement(n) && n.children.some((c) => ts.isJsxElement(c) || ts.isJsxSelfClosingElement(c))) guards.push(tag);
					else component = component ?? tag;
				}
			}
			n.forEachChild(rec);
		};
		if (expr) rec(expr);
		return { component, guards };
	};

	const visitJsx = (node: TS.Node, base: string, guards: string[], layout?: string) => {
		if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
			const open = ts.isJsxElement(node) ? node.openingElement : node;
			const tag = open.tagName.getText(sf);
			if (tag === "Route") {
				let path: string | undefined;
				let index = false;
				let elementExpr: TS.Node | undefined;
				for (const p of open.attributes.properties) {
					if (!ts.isJsxAttribute(p)) continue;
					const n = p.name.getText(sf);
					if (n === "path" && p.initializer && ts.isStringLiteral(p.initializer)) path = p.initializer.text;
					if (n === "path" && p.initializer && ts.isJsxExpression(p.initializer) && p.initializer.expression && ts.isStringLiteral(p.initializer.expression)) path = p.initializer.expression.text;
					if (n === "index") index = true;
					if ((n === "element" || n === "Component" || n === "component") && p.initializer) elementExpr = p.initializer;
				}
				const full = index ? base || "/" : join(base, path);
				const info = elementInfo(elementExpr);
				let comp = info.component;
				if (!comp && elementExpr && ts.isJsxExpression(elementExpr) && elementExpr.expression && ts.isIdentifier(elementExpr.expression)) comp = elementExpr.expression.text;
				const hasChildren = ts.isJsxElement(node) && node.children.some((c) => ts.isJsxElement(c) || ts.isJsxSelfClosingElement(c));
				const allGuards = [...guards, ...info.guards];
				if (hasChildren) {
					if (comp) out.push({ path: full, component: comp, file: fileFor(comp), guards: allGuards, source: "react-router", layout: "layout route" });
					for (const c of (node as TS.JsxElement).children) visitJsx(c, full, comp && !path ? [...allGuards, comp] : allGuards, comp);
				} else {
					out.push({ path: full, component: comp, file: fileFor(comp), guards: allGuards, source: "react-router", index, layout });
				}
				return;
			}
			// Wrapper elements around <Route>s (e.g. <ProtectedRoutes>) act as guards
			const childGuards = /^[A-Z]/.test(tag) && !/^(Routes|BrowserRouter|HashRouter|Router|MemoryRouter|QueryClientProvider|TooltipProvider|Suspense|Fragment|React\.Fragment|ThemeProvider|AuthProvider)$/.test(tag) && /<Route\b/.test(node.getText(sf))
				? [...guards, tag]
				: guards;
			node.forEachChild((c) => visitJsx(c, base, childGuards, layout));
			return;
		}
		node.forEachChild((c) => visitJsx(c, base, guards, layout));
	};
	visitJsx(sf, "", []);

	// Object-style config: createBrowserRouter([{ path, element, children }])
	const visitObj = (node: TS.Node, base: string, guards: string[]) => {
		if (ts.isObjectLiteralExpression(node)) {
			const get = (k: string) => node.properties.find((p): p is TS.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText(sf) === k);
			const pathP = get("path");
			const indexP = get("index");
			const elP = get("element") ?? get("Component") ?? get("component");
			if (pathP || indexP || (elP && get("children"))) {
				const path = pathP && ts.isStringLiteral(pathP.initializer) ? pathP.initializer.text : undefined;
				const full = indexP ? base || "/" : join(base, path);
				const info = elementInfo(elP?.initializer);
				let comp = info.component;
				if (!comp && elP && ts.isIdentifier(elP.initializer)) comp = elP.initializer.text;
				out.push({ path: full, component: comp, file: fileFor(comp), guards: [...guards, ...info.guards], source: "react-router", index: !!indexP });
				const kids = get("children");
				if (kids && ts.isArrayLiteralExpression(kids.initializer)) for (const k of kids.initializer.elements) visitObj(k, full, comp && !path ? [...guards, comp] : guards);
				return;
			}
		}
		node.forEachChild((c) => visitObj(c, base, guards));
	};
	if (/create(Browser|Hash|Memory)Router|useRoutes\(/.test(sf.text)) visitObj(sf, "", []);
	return out;
}

// ---------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------

function parseSupabaseTypes(ts: TSModule, sf: TS.SourceFile, tables: TableInfo[], enums: Record<string, string[]>, fns: string[]) {
	const members = (t?: TS.TypeNode): TS.PropertySignature[] =>
		t && ts.isTypeLiteralNode(t) ? (t.members.filter((m) => ts.isPropertySignature(m)) as TS.PropertySignature[]) : [];
	const prop = (t: TS.TypeNode | undefined, name: string) => members(t).find((m) => m.name.getText(sf).replace(/["']/g, "") === name)?.type;

	const visit = (node: TS.Node) => {
		if (ts.isTypeAliasDeclaration(node) && node.name.text === "Database") {
			for (const schema of members(node.type)) {
				const schemaName = schema.name.getText(sf).replace(/["']/g, "");
				if (schemaName === "__InternalSupabase" || schemaName === "graphql_public") continue;
				for (const kind of ["Tables", "Views"]) {
					for (const tbl of members(prop(schema.type, kind))) {
						const name = tbl.name.getText(sf).replace(/["']/g, "");
						const row = prop(tbl.type, "Row");
						const insert = prop(tbl.type, "Insert");
						const optionalOnInsert = new Set(members(insert).filter((m) => m.questionToken).map((m) => m.name.getText(sf)));
						const columns = members(row).map((c) => {
							const cn = c.name.getText(sf).replace(/["']/g, "");
							const tt = c.type?.getText(sf).replace(/\s+/g, " ") ?? "?";
							return {
								name: cn,
								type: tt.replace(/Database\["public"\]\["Enums"\]\["(\w+)"\]/g, "enum:$1"),
								nullable: /\|\s*null/.test(tt),
								default: optionalOnInsert.has(cn) && !/\|\s*null/.test(tt) ? "has default" : undefined,
							};
						});
						const rels: string[] = [];
						const relT = prop(tbl.type, "Relationships");
						if (relT) {
							for (const m of relT.getText(sf).matchAll(/columns:\s*\[([^\]]*)\][\s\S]*?referencedRelation:\s*"(\w+)"[\s\S]*?referencedColumns:\s*\[([^\]]*)\]/g)) {
								rels.push(`${m[1].replace(/["\s]/g, "")} → ${m[2]}.${m[3].replace(/["\s]/g, "")}`);
							}
						}
						tables.push({ name: `${schemaName === "public" ? "" : `${schemaName}.`}${name}${kind === "Views" ? " (view)" : ""}`, columns, relations: rels, source: "types.ts" });
					}
				}
				for (const en of members(prop(schema.type, "Enums"))) {
					enums[en.name.getText(sf).replace(/["']/g, "")] = [...(en.type?.getText(sf) ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
				}
				for (const fn of members(prop(schema.type, "Functions"))) {
					const args = prop(fn.type, "Args");
					fns.push(`${fn.name.getText(sf).replace(/["']/g, "")}(${members(args).map((a) => a.name.getText(sf)).join(", ")})`);
				}
			}
			return;
		}
		node.forEachChild(visit);
	};
	visit(sf);
}

function parseMigration(
	sql: string,
	acc: {
		tables: TableInfo[];
		enums: Record<string, string[]>;
		dbFunctions: string[];
		policies: SourceMap["policies"];
		rlsTables: string[];
		triggers: string[];
		storageBuckets: string[];
	},
) {
	const clean = sql.replace(/--.*$/gm, "");
	for (const m of clean.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?(\w+)"?\s*\(([\s\S]*?)\);/gi)) {
		const name = m[1];
		if (acc.tables.some((t) => t.name === name && t.source === "types.ts")) continue; // types.ts is authoritative
		const cols: TableInfo["columns"] = [];
		const rels: string[] = [];
		let depth = 0;
		let cur = "";
		const parts: string[] = [];
		for (const ch of m[2]) {
			if (ch === "(") depth++;
			if (ch === ")") depth--;
			if (ch === "," && depth === 0) {
				parts.push(cur);
				cur = "";
			} else cur += ch;
		}
		parts.push(cur);
		for (const raw of parts) {
			const line = raw.trim().replace(/\s+/g, " ");
			if (!line) continue;
			if (/^(constraint|primary key|unique|foreign key|check)\b/i.test(line)) {
				const fk = line.match(/foreign key\s*\(([^)]+)\)\s*references\s+(?:public\.)?(\w+)/i);
				if (fk) rels.push(`${fk[1]} → ${fk[2]}`);
				continue;
			}
			const cm = line.match(/^"?(\w+)"?\s+([\w.]+(?:\s*\([^)]*\))?(?:\[\])?)(.*)$/);
			if (!cm) continue;
			const ref = cm[3].match(/references\s+(?:public\.|auth\.)?"?(\w+)"?(?:\s*\((\w+)\))?/i);
			if (ref) rels.push(`${cm[1]} → ${ref[1]}${ref[2] ? `.${ref[2]}` : ""}`);
			cols.push({
				name: cm[1],
				type: cm[2],
				nullable: !/not null|primary key/i.test(cm[3]),
				default: cm[3].match(/default\s+([^\s,]+(?:\([^)]*\))?)/i)?.[1],
			});
		}
		const existing = acc.tables.find((t) => t.name === name);
		if (existing) Object.assign(existing, { columns: cols, relations: rels });
		else acc.tables.push({ name, columns: cols, relations: rels, source: "migration" });
	}
	for (const m of clean.matchAll(/alter\s+table\s+(?:public\.)?"?(\w+)"?\s+add\s+column\s+(?:if\s+not\s+exists\s+)?"?(\w+)"?\s+([\w.]+)([^;]*);/gi)) {
		const t = acc.tables.find((x) => x.name === m[1]);
		if (t && t.source === "migration" && !t.columns.some((c) => c.name === m[2])) t.columns.push({ name: m[2], type: m[3], nullable: !/not null/i.test(m[4]) });
	}
	for (const m of clean.matchAll(/create\s+type\s+(?:public\.)?"?(\w+)"?\s+as\s+enum\s*\(([^)]*)\)/gi)) {
		if (!acc.enums[m[1]]) acc.enums[m[1]] = [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]);
	}
	for (const m of clean.matchAll(/alter\s+table\s+(?:public\.)?"?(\w+)"?\s+enable\s+row\s+level\s+security/gi)) acc.rlsTables.push(m[1]);
	for (const m of clean.matchAll(/create\s+policy\s+"([^"]+)"\s+on\s+(?:public\.)?"?([\w.]+)"?\s*(?:as\s+\w+\s+)?(?:for\s+(\w+))?\s*(?:to\s+([\w, ]+?))?\s*(?:using\s*\(([\s\S]*?)\))?\s*(?:with\s+check\s*\(([\s\S]*?)\))?\s*;/gi)) {
		acc.policies.push({
			name: m[1],
			table: m[2],
			command: `${(m[3] ?? "all").toUpperCase()}${m[4] ? ` to ${m[4].trim()}` : ""}`,
			using: m[5] ? squash(m[5], 200) : undefined,
			check: m[6] ? squash(m[6], 200) : undefined,
		});
	}
	for (const m of clean.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?"?(\w+)"?\s*\(([^)]*)\)/gi)) acc.dbFunctions.push(`${m[1]}(${squash(m[2], 80)})`);
	for (const m of clean.matchAll(/create\s+(?:or\s+replace\s+)?trigger\s+"?(\w+)"?\s+(before|after|instead of)\s+([\w\s]+?)\s+on\s+(?:public\.|auth\.)?"?(\w+)"?[\s\S]*?execute\s+(?:function|procedure)\s+(?:public\.)?(\w+)/gi)) {
		acc.triggers.push(`${m[1]}: ${m[2]} ${m[3].trim()} on ${m[4]} → ${m[5]}()`);
	}
	for (const m of clean.matchAll(/insert\s+into\s+storage\.buckets\s*\([^)]*\)\s*values\s*\(\s*'([^']+)'[^)]*?(true|false)?\s*\)/gi)) {
		acc.storageBuckets.push(`${m[1]}${m[2] === "true" ? " (public)" : ""}`);
	}
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderSourceMap(sm: SourceMap): string {
	const L: string[] = [];
	const list = (label: string, xs: string[], max = 30) => {
		if (!xs.length) return;
		L.push(`- **${label}:** ${xs.slice(0, max).join(" · ")}${xs.length > max ? ` · …(+${xs.length - max})` : ""}`);
	};
	L.push(`# Source map — ${sm.product.title ?? sm.product.name ?? basename(sm.repo)}`, "");
	L.push(`Scanned ${sm.files} code files in \`${sm.repo}\` at ${sm.scannedAt}.`, "");
	if (sm.product.description) L.push(`> ${sm.product.description}`, "");
	list("Stack", sm.stack);
	list("Capabilities implied by dependencies", sm.capabilities);
	if (sm.uiKit.length) L.push(`- **UI kit:** ${sm.uiKit.length} shadcn/ui primitives (not requirements in themselves)`);
	for (const w of sm.warnings) L.push(`- ⚠ ${w}`);
	L.push("");

	L.push(`## Routes (${sm.routes.length})`, "", "| Path | Component | File | Guards / layout |", "|---|---|---|---|");
	for (const r of sm.routes) L.push(`| \`${r.path}\` | ${r.component ?? ""} | ${r.file ?? ""} | ${[...r.guards, r.layout ?? ""].filter(Boolean).join(", ")} |`);
	L.push("");

	L.push("## Screens", "");
	for (const s of sm.screens) {
		const f = s.facts;
		L.push(`### \`${s.route}\``, `Files: ${s.files.join(", ")}`, "");
		list("Headings", f.headings);
		list("Tabs", f.tabs);
		list("Buttons / actions", f.buttons, 40);
		list("Form fields", f.formFields, 40);
		list("Labels", f.labels, 40);
		list("Placeholders", f.placeholders);
		list("Options", f.options, 40);
		for (const z of f.zodSchemas) L.push(`- **Validation \`${z.name}\`:** ${z.fields.map((x) => `\`${x.name}\`: ${x.rules}`).join("; ")}`);
		list("Navigates to", f.navigations);
		list("Supabase", f.supabase);
		list("Fetch/HTTP", f.fetches);
		list("Server-state", f.queries);
		list("Server functions", f.serverFns);
		list("User feedback (toasts)", f.toasts);
		list("Component UI state", f.state);
		list("Widgets", f.widgets);
		list("Permission checks", f.conditions);
		for (const m of f.mockData) L.push(`- **Hard-coded data \`${m.name}\`:** ${m.count} items, fields: ${m.fields.join(", ")}`);
		list("⚠ Stubs / unfinished", f.stubs);
		list("TODOs", f.todos);
		list("Copy", f.texts, 15);
		L.push("");
	}
	if (sm.sharedComponents.length) {
		L.push("## Shared components", "");
		for (const c of sm.sharedComponents.slice(0, 30)) L.push(`- ${c.file} (used by ${c.usedBy} screens)`);
		L.push("");
	}

	L.push(`## Data model (${sm.tables.length} tables/views)`, "");
	if (!sm.tables.length) L.push("No Supabase types or migrations found – data is probably mocked in the front end (see Hard-coded data).", "");
	for (const t of sm.tables) {
		L.push(`### ${t.name}  _(from ${t.source})_`, "", "| Column | Type | Nullable | Default |", "|---|---|---|---|");
		for (const c of t.columns) L.push(`| ${c.name} | \`${c.type.replace(/\|/g, "\\|")}\` | ${c.nullable ? "yes" : "no"} | ${c.default ?? ""} |`);
		if (t.relations.length) L.push("", `Relations: ${t.relations.join("; ")}`);
		const pol = sm.policies.filter((p) => p.table === t.name);
		if (pol.length) {
			L.push("", "Row-level security policies:");
			for (const p of pol) L.push(`- "${p.name}" ${p.command}${p.using ? ` USING (${p.using})` : ""}${p.check ? ` CHECK (${p.check})` : ""}`);
		} else if (sm.rlsTables.includes(t.name)) L.push("", "RLS enabled (no policies parsed).");
		L.push("");
	}
	if (Object.keys(sm.enums).length) {
		L.push("## Enums", "");
		for (const [k, v] of Object.entries(sm.enums)) L.push(`- **${k}:** ${v.join(", ")}`);
		L.push("");
	}
	if (sm.dbFunctions.length || sm.triggers.length || sm.storageBuckets.length) {
		L.push("## Database logic", "");
		list("Functions / RPC", sm.dbFunctions);
		list("Triggers", sm.triggers);
		list("Storage buckets", sm.storageBuckets);
		L.push("");
	}
	if (sm.edgeFunctions.length || sm.serverFunctions.length) {
		L.push("## Backend functions", "");
		for (const e of sm.edgeFunctions) {
			L.push(`- **edge fn \`${e.name}\`** inputs: ${e.inputs.join(", ") || "?"}; env: ${e.env.join(", ") || "none"}; calls: ${e.externalHosts.join(", ") || "none"}; invoked from: ${e.calledFrom.join(", ") || "?"}`);
		}
		for (const s of sm.serverFunctions) L.push(`- **server fns** in ${s.file}: ${s.names.join(", ")}`);
		L.push("");
	}
	if (sm.auth.length) {
		L.push("## Auth & permissions", "");
		for (const a of sm.auth) L.push(`- ${a}`);
		L.push("");
	}
	if (sm.envVars.length) L.push("## Environment variables (names only)", "", sm.envVars.map((e) => `\`${e}\``).join(", "), "");
	if (sm.mockData.length) {
		L.push("## Hard-coded / mock data", "");
		for (const m of sm.mockData) L.push(`- \`${m.name}\` in ${m.file}: ${m.count} items, fields ${m.fields.join(", ")}  e.g. \`${m.sample.replace(/`/g, "'")}\``);
		L.push("");
	}
	if (sm.stubs.length || sm.todos.length) {
		L.push("## Unfinished / stubbed behaviour", "");
		for (const s of sm.stubs) L.push(`- ${s.file}: ${s.note}`);
		for (const t of sm.todos) L.push(`- ${t.file}: ${t.note}`);
		L.push("");
	}
	if (sm.designTokens.length) {
		L.push("## Design tokens", "", sm.designTokens.map((d) => `\`${d}\``).join(", "), "");
	}
	return L.join("\n");
}
