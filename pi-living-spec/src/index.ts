import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { SpecBrowser, type BrowseAction, type BrowseResult, shortUrl } from "./browser.js";
import { crawl, routeMatches } from "./crawl.js";
import { scanSource, renderSourceMap, type SourceMap } from "./source-scan.js";
import { Workspace } from "./workspace.js";
import { Ledger } from "./ledger.js";
import { exportAll } from "./export.js";
import { registerModelTools } from "./model-tools.js";
import { enumOf } from "./schema.js";
import { clip } from "./text.js";
const actions = ["open", "snapshot", "click", "fill", "select", "check", "uncheck", "hover", "press", "upload", "back", "forward", "reload", "scroll", "wait", "screenshot", "viewport"] as const;
const text = (s: string) => [{ type: "text" as const, text: s }];
export default function livingSpec(pi: ExtensionAPI) {
  let state: { ws: Workspace; browser: SpecBrowser } | undefined;
  const get = (cwd: string) => {
    if (!state || state.ws.cwd !== cwd) {
      void state?.browser.close();
      const ws = new Workspace(cwd); state = { ws, browser: new SpecBrowser(ws) };
    }
    return state;
  };
  const guard = (browser: SpecBrowser, ws: Workspace) => {
    if (ws.loadConfig().writeGuard === "off") throw new Error("V2 trial refuses writeGuard=off. Set /spec-writes fake or block");
    browser.refreshConfig();
  };
  pi.on("session_start", async (_e, ctx) => { const counts = new Ledger(new Workspace(ctx.cwd)).counts(); if (counts.requirements) ctx.ui.setStatus("living-spec-v2", `spec: ${counts.requirements} requirements, ${counts.questions} questions`); });
  pi.on("session_shutdown", async () => { await state?.browser.close(); });
  registerModelTools(pi);
  pi.registerTool({
    name: "spec_scan_source", label: "Scan prototype source",
    description: "Statically analyse prototype source without executing it. Extract routes/screens/forms/validation, tables/RLS/enums, auth calls, mocks and stubs. Writes .living-spec/source-map.json and source-map.md. Capture is evidence, not confirmed intent. Do not publish raw source samples without review.",
    promptSnippet: "Analyse prototype source into an evidence source map",
    promptGuidelines: ["Run spec_scan_source first when prototype source is available. Read its source map before proposing requirements."],
    parameters: Type.Object({ repoPath: Type.Optional(Type.String()) }),
    async execute(_id, p, _signal, onUpdate, ctx) {
      const s = get(ctx.cwd), repo = s.ws.resolveRepo(p.repoPath);
      if (!repo) throw new Error("Provide repoPath or configure /spec");
      if (p.repoPath) s.ws.saveConfig({ repoPath: p.repoPath.replace(/^@/, "") });
      onUpdate?.({ content: text("Scanning source"), details: undefined });
      const sm = await scanSource(repo); s.ws.writeJson("source-map.json", sm);
      const path = s.ws.writeText("source-map.md", renderSourceMap(sm));
      return { content: text(clip(`Source map: ${s.ws.rel(path)}\n${renderSourceMap(sm)}`, { savedAt: s.ws.rel(path) })), details: undefined };
    },
  });
  pi.registerTool({
    name: "spec_crawl", label: "Crawl prototype", executionMode: "sequential",
    description: "Visit reachable same-origin screens and source-map routes. Capture screenshots/outlines/API calls/errors/redirects under .living-spec/crawl. Logout links are not followed. Mutations are fake or blocked with existing auth exceptions. Captures are unapproved for publication by default. Propose records and add evidence, never overwrite confirmed intent from a new crawl.",
    promptSnippet: "Crawl prototype screens into local evidence captures",
    promptGuidelines: ["After spec_crawl read every relevant outline and screenshot before proposing requirements. Keep observations separate from intended behaviour."],
    parameters: Type.Object({ url: Type.Optional(Type.String()), maxPages: Type.Optional(Type.Number()), include: Type.Optional(Type.String()), exclude: Type.Optional(Type.String()), mobile: Type.Optional(Type.Boolean()), useSourceRoutes: Type.Optional(Type.Boolean()) }),
    async execute(_id, p, signal, onUpdate, ctx) {
      const s = get(ctx.cwd); if (p.url && !s.ws.loadConfig().baseUrl) s.ws.saveConfig({ baseUrl: p.url }); guard(s.browser, s.ws);
      const sm = p.useSourceRoutes === false ? undefined : s.ws.readJson<SourceMap | undefined>("source-map.json", undefined);
      const map = await crawl(s.browser, s.ws, { startUrl: p.url, maxPages: p.maxPages, include: p.include, exclude: p.exclude, mobile: p.mobile, seeds: sm?.routes.map(r => r.path).filter(p => p.startsWith("/")) ?? [], signal, onProgress: m => onUpdate?.({ content: text(`Crawling ${m}`), details: undefined }) });
      const unvisited = sm?.routes.filter(r => r.path !== "/*" && !map.pages.some(p => routeMatches(r.path, p.requested) || routeMatches(r.path, p.path)));
      return { content: text(clip(JSON.stringify({ pages: map.pages.map(p => ({ path: p.requested, title: p.title, outline: p.outlineFile, redirect: p.redirectedTo, error: p.error })), unvisited, sitemap: ".living-spec/crawl/sitemap.json", api: ".living-spec/crawl/api-inventory.md" }, null, 2))), details: undefined };
    },
  });
  pi.registerTool({
    name: "spec_browse", label: "Browse prototype", executionMode: "sequential",
    description: "Drive the prototype using latest outline refs eN, visible text or selectors. fill/select/press/upload/scroll/wait/viewport use value. Mutating calls are intercepted under the existing guard, with auth exceptions. Capture is evidence of UI and payload shape, not proof of persistence. Screenshots are not proposed wireframes.",
    promptSnippet: "Exercise prototype flows with guarded writes and local evidence",
    promptGuidelines: ["Use spec_browse end to end to exercise empty/invalid/valid forms, dialogs, tabs and menus. Refresh stale refs with snapshot.", "Treat intercepted spec_browse writes as mocked persistence. Never claim a real backend accepted them."],
    parameters: Type.Object({ action: enumOf(actions), url: Type.Optional(Type.String()), target: Type.Optional(Type.String()), value: Type.Optional(Type.String()), screenshot: Type.Optional(Type.Boolean()), fullPage: Type.Optional(Type.Boolean()), full: Type.Optional(Type.Boolean()) }),
    async execute(_id, p, _signal, _update, ctx) {
      const s = get(ctx.cwd); guard(s.browser, s.ws);
      const r = await s.browser.perform({ ...p, action: p.action as BrowseAction });
      const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = text(clip(formatBrowse(r, s.browser.origin)));
      if (r.screenshotJpeg) content.push({ type: "image", data: r.screenshotJpeg.toString("base64"), mimeType: "image/jpeg" });
      return { content, details: { url: r.url, ok: r.ok, screenshot: r.screenshotPath }, isError: !r.ok };
    },
  });
  pi.registerCommand("spec", { description: "Extract candidate requirements: /spec <url> [repo-path]", handler: async (args, ctx) => {
    const s = get(ctx.cwd), parts = args.trim().split(/\s+/).filter(Boolean), cfg = s.ws.loadConfig();
    let url = parts.find(p => /^https?:\/\//i.test(p)) ?? cfg.baseUrl;
    let repo = parts.find(p => !/^https?:\/\//i.test(p)) ?? cfg.repoPath;
    if (!url && !repo && ctx.hasUI) url = (await ctx.ui.input("Prototype URL (blank for source only)"))?.trim() || undefined;
    if (!repo && ctx.hasUI) repo = (await ctx.ui.input("Prototype source path (blank if unavailable)"))?.trim() || undefined;
    if (!url && !repo) { ctx.ui.notify("Provide URL or source path", "warning"); return; }
    s.ws.saveConfig({ ...(url ? { baseUrl: url } : {}), ...(repo ? { repoPath: repo } : {}) });
    await ctx.waitForIdle();
    pi.sendUserMessage(`/skill:living-spec Extract candidate requirements. Running app: ${url ?? "unavailable"}. Source: ${repo ?? "unavailable"}. Offer /spec-clarify at the end, do not start it automatically.`, { expandPromptTemplates: true });
  } });
  pi.registerCommand("spec-clarify", { description: "Resume optional persistent clarification without crawling", handler: async (args, ctx) => {
    await ctx.waitForIdle(); pi.sendUserMessage(`/skill:spec-clarify Resume the persistent question frontier. ${args}`, { expandPromptTemplates: true });
  } });
  pi.registerCommand("spec-status", { description: "Show V2 specification progress", handler: async (_args, ctx) => {
    const l = new Ledger(new Workspace(ctx.cwd)); ctx.ui.notify(JSON.stringify({ ...l.counts(), readyQuestions: l.frontier().ready.length, reviews: l.data.impacts.filter(i => !i.resolution).length, baselines: l.data.baselines.length }), "info");
  } });
  pi.registerCommand("spec-export", { description: "Publish portable specification: /spec-export [md csv json]", handler: async (args, ctx) => {
    const ws = new Workspace(ctx.cwd), formats = args.split(/\s+/).filter((f): f is "md" | "csv" | "json" => ["md", "csv", "json"].includes(f));
    ctx.ui.notify(exportAll(ws, new Ledger(ws).data, undefined, formats.length ? formats : undefined).join("\n"), "info");
  } });
  pi.registerCommand("spec-writes", { description: "Write guard: fake or block. V2 trial refuses off", handler: async (args, ctx) => {
    if (args.trim() !== "fake" && args.trim() !== "block") { ctx.ui.notify("Use /spec-writes fake or block. Real writes are disabled in V2 trial", "warning"); return; }
    const s = get(ctx.cwd); s.ws.saveConfig({ writeGuard: args.trim() as "fake" | "block" }); s.browser.refreshConfig();
  } });
  pi.registerCommand("spec-login", { description: "Log in through a visible browser, preserve local auth state", handler: async (args, ctx) => {
    if (!ctx.hasUI) throw new Error("Login requires interactive UI");
    const s = get(ctx.cwd); guard(s.browser, s.ws);
    const path = await s.browser.interactiveLogin(args.trim(), () => ctx.ui.confirm("Log in", "Complete login in the browser, then confirm to save the session locally"));
    ctx.ui.notify(`Saved ${s.ws.rel(path)}. Never publish or commit auth state`, "info");
  } });
  pi.registerCommand("spec-close", { description: "Close prototype browser", handler: async (_args, ctx) => { await state?.browser.close(); ctx.ui.notify("Browser closed", "info"); } });
}
function formatBrowse(r: BrowseResult, origin?: string) {
  const lines = [`${r.ok ? "OK" : "Failed"}: ${r.summary}${r.error ? `. ${r.error}` : ""}`, `Page: ${shortUrl(r.url, origin)} · ${r.title}`];
  for (const e of r.events.net) lines.push(`${e.intercepted ? "INTERCEPTED, not persisted" : "Observed API"}: ${e.method} ${shortUrl(e.url, origin)} -> ${e.intercepted ?? e.status}${e.postData ? ` body=${e.postData.slice(0, 600)}` : ""}`);
  if (r.snapshot?.toasts.length) lines.push(`Toasts: ${r.snapshot.toasts.join(" | ")}`);
  lines.push(...r.events.dialogs, ...r.events.console, r.outline ?? "");
  if (r.screenshotPath) lines.push(`Screenshot: ${r.screenshotPath}`);
  return lines.join("\n");
}
