import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { accessSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const SELF = fileURLToPath(import.meta.url);
const CHILD_DIR = "PI_TMUX_AGENT_DIR";
const CHILD_TOKEN = "PI_TMUX_AGENT_TOKEN";
const FAMILY_ROOT = "PI_TMUX_AGENT_FAMILY";
const FAMILY_NAME = "PI_TMUX_AGENT_NAME";
const RESERVED_ENDPOINT_NAMES = new Set(["parent"]);
const FORMAT = "#{pid}\t#{session_id}\t#{window_id}\t#{pane_id}\t#{pane_pid}\t#{pane_dead}\t#{pane_in_mode}";
const NOTE = "Pi context estimate, not cumulative billed tokens. Fresh sessions can undercount system/tool cost. Null means unknown, including after compaction.";
const PROCESS_STARTED_AT = new Date().toISOString();
const MENU_SCRIPT = join(dirname(SELF), "tmux-menu.sh");
const MENU_KEY = "MouseDown3Status";
const MENU_OPT_OUT = "PI_TMUX_AGENTS_MENU";

export function bounded(text: string, max = 12000): string {
  const marker = "\n[truncated; inspect the child TUI for more]";
  return text.length <= max ? text : text.slice(0, Math.max(0, max - marker.length)) + marker;
}

export function contextSummary(ctx: ExtensionContext) {
  const usage = ctx.getContextUsage();
  const tokens = usage?.tokens ?? null;
  const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? null;
  const k = (n: number | null) => n === null ? null : `${(n / 1000).toFixed(1)}k`;
  return { tokens, tokensK: k(tokens), contextWindow, contextWindowK: k(contextWindow), percent: usage?.percent ?? null };
}

export function assistantReply(entries: SessionEntry[]) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const message = entry.message;
    return {
      id: entry.id, timestamp: message.timestamp,
      text: bounded(message.content.filter(b => b.type === "text").map(b => b.text).join("\n")),
      stopReason: message.stopReason, error: message.errorMessage ? bounded(message.errorMessage, 2000) : null,
    };
  }
  return null;
}

// Linux start ticks prevent reused PIDs from making an old snapshot look live.
export function processIdentity(pid: number) {
  const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
  if (fields[0] === "Z" || !fields[19]) throw new Error("Process has exited");
  return { start: fields[19], foreground: fields[2] === fields[5] };
}

function privateDirectory(path: string) {
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) {
    throw new Error("State directory must be owner-only and must not be a symlink");
  }
}

export function atomicJSON(path: string, data: unknown) {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(data), { mode: 0o600, flag: "wx" });
  renameSync(temp, path);
}

function jsonFile<T>(path: string): T | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > 100000) {
      throw new Error("Invalid private state file");
    }
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function existingParentDirectory() {
  const path = join(tmpdir(), `pi-tmux-agents-${process.getuid?.()}`, `${process.pid}-${processIdentity(process.pid).start}`);
  if (!existsSync(path)) return undefined;
  privateDirectory(path);
  return path;
}

function parentDirectory() {
  const base = join(tmpdir(), `pi-tmux-agents-${process.getuid?.()}`);
  privateDirectory(base);
  const path = join(base, `${process.pid}-${processIdentity(process.pid).start}`);
  privateDirectory(path);
  return path;
}

export function getPiInvocation(args: string[]) {
  const script = process.argv[1];
  if (script && !script.startsWith("/$bunfs/root/") && existsSync(script)) {
    return [process.execPath, resolve(script), ...args];
  }
  return [/^(node|bun)(\.exe)?$/i.test(basename(process.execPath)) ? "pi" : process.execPath, ...args];
}

type SpawnArgs = { name: string; mode?: "window" | "pane"; cwd?: string; systemPrompt?: string; provider?: string; model?: string; thinking?: string; waitMs?: number };
type Pane = { serverPid: number; session: string; window: string; id: string; pid: number; dead: boolean; inMode: boolean };
type ChildRecord = Pane & { dir: string; token: string; socket: string; serverStart: string; start: string; name: string; mode: string; createdAt: string };
type Snapshot = {
  token: string; id: string; pid: number; start: string; sessionId: string; sessionFile: string | null;
  updatedAt: string; event: string; idle: boolean; pending: boolean; waiting: boolean; editorEmpty: boolean; stopped: boolean;
  context: ReturnType<typeof contextSummary>; model: { provider: string; id: string } | null;
  thinking: string | null; reply: ReturnType<typeof assistantReply>;
};

export type PeerEndpoint = { name: string; paneId: string | null };
export type PeerMessage = {
  messageId: string; broadcastId: string | null; familyId: string;
  from: PeerEndpoint; to: PeerEndpoint; mode: "steering" | "interrupt";
  content: string; createdAt: string;
};
export type PeerReceipt = {
  messageId: string; state: "delivered" | "notified" | "failed-interrupt-timeout" | "blocked-revoked" | "invalid-record" | "expired-stale" | "failed-injection";
  deliveredAt?: string; error?: string; attempts?: number; surfaced?: boolean; requestedMode?: "steering" | "interrupt";
};
export type PeerRead = { readAt: string; sessionId: string }; 
export type Permissions = {
  familyId: string; version: 1; updatedAt: string; edges: { from: string; to: string }[];
};

export function isAllowed(permissions: Permissions, from: string, to: string): boolean {
  return from === "parent" ? to !== "parent" : permissions.edges.some(edge => edge.from === from && edge.to === to);
}

function parsePane(text: string): Pane {
  const [serverPid, session, window, id, pid, dead, inMode] = text.trim().split("\t");
  if (!/^%\d+$/.test(id ?? "") || !/^@\d+$/.test(window ?? "") || !/^\$\d+$/.test(session ?? "") || !Number(pid) || !Number(serverPid)) {
    throw new Error("tmux returned an invalid pane identity");
  }
  return { serverPid: Number(serverPid), session, window, id, pid: Number(pid), dead: dead === "1", inMode: inMode === "1" };
}

function socketPath() {
  const socket = process.env.TMUX?.replace(/,\d+,\d+$/, "");
  if (!socket || !isAbsolute(socket) || !/^%\d+$/.test(process.env.TMUX_PANE ?? "")) throw new Error("Run the parent Pi inside tmux");
  return socket;
}

/** This process's tmux pane ID, such as %12. */
function currentPane() {
  const pane = process.env.TMUX_PANE;
  if (!pane || !/^%\d+$/.test(pane)) throw new Error("Run the parent Pi inside tmux");
  return pane;
}

/** Checks the fields the pollers rely on. Records come from files any same-user process can write. */
function isPeerMessage(value: unknown): value is PeerMessage {
  const hasName = (endpoint: unknown) =>
    typeof endpoint === "object" && endpoint !== null && "name" in endpoint && typeof endpoint.name === "string";
  return typeof value === "object" && value !== null &&
    "messageId" in value && typeof value.messageId === "string" &&
    "createdAt" in value && typeof value.createdAt === "string" &&
    "content" in value && typeof value.content === "string" &&
    "mode" in value && (value.mode === "steering" || value.mode === "interrupt") &&
    "from" in value && hasName(value.from) &&
    "to" in value && hasName(value.to);
}

export function launchArgs(params: SpawnArgs, cwd: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(params.name)) throw new Error("Name must be 1-48 letters, digits, underscores or hyphens, starting with a letter or digit");
  if (RESERVED_ENDPOINT_NAMES.has(params.name)) throw new Error(`Name ${JSON.stringify(params.name)} is reserved`);
  const dir = resolve(cwd, params.cwd ?? ".");
  if (!statSync(dir).isDirectory()) throw new Error("cwd must be a directory");
  const args = ["--name", params.name, "-e", SELF];
  if (params.systemPrompt) {
    const file = resolve(cwd, params.systemPrompt.replace(/^@/, ""));
    if (!statSync(file).isFile()) throw new Error("systemPrompt must be a readable regular file");
    accessSync(file, constants.R_OK);
    args.push("--system-prompt", file);
  }
  for (const key of ["provider", "model", "thinking"] as const) {
    const value = params[key];
    if (value) {
      if (/[\x00-\x1f\x7f]/.test(value) || value.startsWith("-")) throw new Error(`Invalid ${key}`);
      args.push(`--${key}`, value);
    }
  }
  return { cwd: dir, args };
}

/**
 * True when the right-click binding on a window tab may be replaced with this extension's menu:
 * nothing is bound, tmux's default window menu is bound, or an earlier standalone copy of the menu is.
 * Any other binding is the user's own and is kept.
 */
export function replaceableMenuBinding(listing: string): boolean {
  const binding = listing.trim();
  if (!binding) return true;
  const isDefaultMenu = /\bdisplay-menu\b/.test(binding) && binding.includes("Swap Left") && binding.includes("kill-window");
  return isDefaultMenu || binding.includes("tmux-window-menu") || binding.includes("tmux-menu.sh");
}

export type MenuInstall = "installed" | "already-installed" | "kept-custom-binding" | "unsupported-path";

/** Bind a right-click on a window tab in the status bar to tmux-menu.sh. The binding lasts for the tmux server's lifetime. */
export async function installWindowMenu(exec: ExtensionAPI["exec"], socket: string, script = MENU_SCRIPT): Promise<MenuInstall> {
  // The path is embedded in a tmux command string and a shell command, so it must need no quoting.
  if (!/^[A-Za-z0-9_./-]+$/.test(script)) return "unsupported-path";
  const command = `bash ${script} menu '#{client_name}' '#{pane_id}'`;
  const current = await exec("tmux", ["-S", socket, "list-keys", "-T", "root", MENU_KEY], { timeout: 5000 });
  const listing = current.code === 0 ? current.stdout : "";
  if (listing.includes(command)) return "already-installed";
  if (!replaceableMenuBinding(listing)) return "kept-custom-binding";
  // -t = runs the command in the context of the clicked window, so #{pane_id} is its active pane.
  const bind = await exec("tmux", ["-S", socket, "bind-key", "-n", MENU_KEY, "run-shell", "-b", "-t", "=", command], { timeout: 5000 });
  if (bind.code !== 0) throw new Error(`tmux bind-key failed (exit ${bind.code})`);
  return "installed";
}

export class TmuxAgents {
  constructor(private pi: Pick<ExtensionAPI, "exec">, private root = parentDirectory()) {}

  private async tmux(socket: string, args: string[], signal?: AbortSignal) {
    signal?.throwIfAborted();
    // tmux's argv parser consumes one backslash before a final semicolon. Escape only that character,
    // even if it already follows literal backslashes. Other semicolons and backslashes are unchanged.
    const literalArgs = args.map(arg => arg.endsWith(";") ? `${arg.slice(0, -1)}\\;` : arg);
    const result = await this.pi.exec("tmux", ["-S", socket, ...literalArgs], { signal, timeout: 10000 });
    if (result.code !== 0 || result.killed) throw new Error(`tmux ${args[0]} failed${result.killed ? " or timed out" : ` (exit ${result.code})`}`);
    return result.stdout;
  }

  private async pane(socket: string, id: string, signal?: AbortSignal) {
    return parsePane(await this.tmux(socket, ["display-message", "-p", "-t", id, FORMAT], signal));
  }

  records(): ChildRecord[] {
    return readdirSync(this.root).filter(name => name.startsWith("child-")).flatMap(name => {
      try {
        const record = jsonFile<ChildRecord>(join(this.root, name, "meta.json"));
        return record ? [record] : [];
      } catch (error) {
        console.error(`tmux agents: skipping unreadable child record. ${bounded(String(error), 300)}`);
        return [];
      }
    });
  }

  record(id: string) {
    const record = this.records().find(r => r.id === id);
    if (!record) throw new Error("Unknown managed pane ID. Use tmux_agent_list; existing unmanaged panes cannot be adopted");
    return record;
  }

  async inspect(record: ChildRecord, signal?: AbortSignal) {
    let live: Pane;
    try {
      if (processIdentity(record.serverPid).start !== record.serverStart) throw new Error("server changed");
      live = await this.pane(record.socket, record.id, signal);
      // Pane ID, PID and start time identify the agent. Session and window are not compared:
      // join-pane, break-pane and move-pane keep a pane's ID while moving it between windows.
      if (live.dead || live.serverPid !== record.serverPid || live.pid !== record.pid || processIdentity(record.pid).start !== record.start) throw new Error("pane changed");
    } catch {
      signal?.throwIfAborted();
      return { status: "unavailable" as const, snapshot: undefined, live: undefined };
    }
    const snapshot = jsonFile<Snapshot>(join(record.dir, "snapshot.json"));
    if (!snapshot) return { status: "starting" as const, snapshot, live };
    if (snapshot.token !== record.token || snapshot.id !== record.id || snapshot.pid !== record.pid || snapshot.start !== record.start) {
      return { status: "stale" as const, snapshot: undefined, live };
    }
    const status = snapshot.stopped ? "stopped" : snapshot.waiting ? "waiting-for-user" : snapshot.idle && !snapshot.pending ? "ready" : "busy";
    return { status, snapshot, live };
  }

  async spawn(params: SpawnArgs, ctx: Pick<ExtensionContext, "cwd">, signal?: AbortSignal) {
    const launch = launchArgs(params, ctx.cwd); // Validate the file before any spawn.
    const socket = socketPath();
    const parent = await this.pane(socket, currentPane(), signal);
    const names = await this.tmux(socket, ["list-windows", "-t", parent.session, "-F", "#{window_name}"], signal);
    if (names.trim().split("\n").includes(params.name) || this.records().some(r => r.name === params.name)) throw new Error("Name already exists. Choose a unique window label");
    const dir = mkdtempSync(join(this.root, "child-"));
    const token = randomUUID();
    const mode = params.mode ?? "window";
    const command = [mode === "pane" ? "split-window" : "new-window", "-d", "-P", "-F", FORMAT,
      "-t", mode === "pane" ? parent.id : `${parent.session}:`, "-c", launch.cwd,
      "-e", `${CHILD_DIR}=${dir}`, "-e", `${CHILD_TOKEN}=${token}`,
      "-e", `${FAMILY_ROOT}=${this.root}`, "-e", `${FAMILY_NAME}=${params.name}`];
    if (mode === "window") command.push("-n", params.name);
    // Multiple command arguments make tmux exec directly, without shell interpolation.
    command.push(...getPiInvocation(launch.args));
    signal?.throwIfAborted();
    let pane: Pane | undefined;
    try {
      // Once creation starts, collect the ID even if the caller cancels. Never retry a spawn.
      pane = parsePane(await this.tmux(socket, command));
      const record: ChildRecord = { ...pane, socket, dir, token, name: params.name, mode,
        serverStart: processIdentity(pane.serverPid).start, start: processIdentity(pane.pid).start, createdAt: new Date().toISOString() };
      atomicJSON(join(dir, "meta.json"), record);
      await this.tmux(socket, ["set-option", "-w", "-t", pane.window, "automatic-rename", "off"]);
      await this.tmux(socket, ["set-option", "-w", "-t", pane.window, "allow-rename", "off"]);
      await this.tmux(socket, ["rename-window", "-t", pane.window, params.name]);
      const deadline = Date.now() + (params.waitMs ?? 10000);
      let state;
      do {
        state = await this.inspect(record, signal);
        if (state.status !== "starting" || Date.now() >= deadline) break;
        await delay(100, undefined, { signal });
      } while (true);
      return { id: pane.id, window: pane.window, name: params.name, mode, status: state.status,
        note: mode === "pane" ? "Renamed the containing window, shared by all its panes." : "Created a new tmux window.",
        readiness: "Ready means child telemetry observed an idle Pi. Check the TUI for startup dialogs before sending. Starting is not a failure; read/list again, do not respawn." };
    } catch (error) {
      throw new Error(pane ? `Created pane ${pane.id} in window ${pane.window}, but setup/readiness failed. It was NOT closed. Inspect it before retrying. ${bounded(String(error), 300)}`
        : "tmux creation failed before an ID was received. Creation may have occurred; inspect tmux windows before retrying. No rollback was attempted.");
    }
  }

  async send(id: string, text: string, signal?: AbortSignal) {
    if (!text.trim() || text.length > 50000 || /[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(text)) throw new Error("Send 1-50000 characters, without terminal control characters. LF and tab are allowed");
    const record = this.record(id);
    const check = async () => {
      const state = await this.inspect(record, signal);
      if (state.status !== "ready" || !state.snapshot?.editorEmpty || state.live?.inMode || !processIdentity(record.pid).foreground) {
        throw new Error(`Pane ${id} is not ready for safe input (${state.status}). Inspect the TUI; do not clear it with Ctrl+C`);
      }
    };
    await check();
    const buffer = `pi-agent-${randomUUID()}`;
    const file = join(this.root, `${buffer}.txt`);
    writeFileSync(file, text, { mode: 0o600, flag: "wx" });
    let loaded = false;
    try {
      await this.tmux(record.socket, ["load-buffer", "-b", buffer, file], signal);
      loaded = true;
      await check();
      await this.tmux(record.socket, ["paste-buffer", "-d", "-p", "-r", "-b", buffer, "-t", id], signal);
      loaded = false;
      // Recheck identity after pasting too. A failed check skips Enter.
      await check();
      // Separate Enter prevents multiline text from being interpreted as key names.
      await this.tmux(record.socket, ["send-keys", "-t", id, "Enter"], signal);
    } catch (error) {
      throw new Error(`Send to ${id} failed and may be partially delivered. Inspect the editor before retrying. ${bounded(String(error), 300)}`);
    } finally {
      unlinkSync(file);
      if (loaded) await this.tmux(record.socket, ["delete-buffer", "-b", buffer]).catch(() => {});
    }
    return { id, delivery: "submitted-to-terminal, not confirmed by Pi", note: "Assumes a normal empty editor and no concurrent typing or dialog. Use read/context to observe the result; do not blindly resend." };
  }

  async read(id: string, terminal = false, maxChars = 12000, signal?: AbortSignal) {
    const record = this.record(id);
    const state = await this.inspect(record, signal);
    if (terminal) {
      if (!state.live || state.status === "stale") throw new Error("Refusing terminal capture from an unavailable or replaced pane");
      const output = await this.tmux(record.socket, ["capture-pane", "-p", "-J", "-t", id, "-S", "-200"], signal);
      const marker = "[truncated; last terminal characters follow]\n";
      return { id, status: state.status, terminal: output.length > maxChars ? marker + output.slice(-(maxChars - marker.length)) : output, note: "Raw visible terminal output can include prompts and sensitive text. It is not an assistant-only reply." };
    }
    return { id, status: state.status, updatedAt: state.snapshot?.updatedAt ?? null,
      reply: state.snapshot?.reply ? { ...state.snapshot.reply, text: bounded(state.snapshot.reply.text, maxChars) } : null };
  }

  async context(id: string, signal?: AbortSignal) {
    const state = await this.inspect(this.record(id), signal);
    return { id, status: state.status, updatedAt: state.snapshot?.updatedAt ?? null,
      context: state.snapshot?.context ?? null, model: state.snapshot?.model ?? null, thinking: state.snapshot?.thinking ?? null, note: NOTE };
  }

  async list(offset = 0, signal?: AbortSignal) {
    const records = this.records();
    const agents = [];
    for (const record of records.slice(offset, offset + 50)) {
      const state = await this.inspect(record, signal);
      // The pane may have moved since spawn, so report its current window when it is known.
      agents.push({ id: record.id, name: record.name, window: state.live?.window ?? record.window, mode: record.mode, status: state.status });
    }
    return { agents, nextOffset: offset + 50 < records.length ? offset + 50 : null };
  }

  messageDirectory() {
    const path = join(this.root, "messages");
    privateDirectory(path);
    return path;
  }

  private validName(name: string) {
    return name === "parent" || /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(name);
  }

  recordByName(name: string) {
    const record = this.records().find(candidate => candidate.name === name);
    if (!record) throw new Error(`Unknown family member ${JSON.stringify(name)}. Known names: ${this.records().map(candidate => candidate.name).join(", ") || "none"}`);
    return record;
  }

  private endpoint(name: string): PeerEndpoint {
    if (name === "parent") return { name, paneId: null };
    const record = this.recordByName(name);
    return { name: record.name, paneId: record.id };
  }

  permissions(): Permissions {
    return jsonFile<Permissions>(join(this.root, "permissions.json")) ?? {
      familyId: basename(this.root), version: 1, updatedAt: new Date(0).toISOString(), edges: [],
    };
  }

  private writePermissions(permissions: Permissions) {
    atomicJSON(join(this.root, "permissions.json"), permissions);
  }

  grant(from: string, to: string) {
    this.validateEdge(from, to);
    const permissions = this.permissions();
    if (!permissions.edges.some(edge => edge.from === from && edge.to === to)) permissions.edges.push({ from, to });
    permissions.updatedAt = new Date().toISOString();
    this.writePermissions(permissions);
    return { edges: permissions.edges };
  }

  revoke(from: string, to: string) {
    this.validateEdge(from, to);
    const permissions = this.permissions();
    permissions.edges = permissions.edges.filter(edge => edge.from !== from || edge.to !== to);
    permissions.updatedAt = new Date().toISOString();
    this.writePermissions(permissions);
    return { edges: permissions.edges };
  }

  private validateEdge(from: string, to: string) {
    if (!this.validName(from) || !this.validName(to)) throw new Error("Permission endpoints must be valid family names or parent");
    if (from === to) throw new Error("A permission edge cannot target its sender");
    this.endpoint(from);
    this.endpoint(to);
  }

  async peers(from: string, signal?: AbortSignal) {
    this.endpoint(from);
    const permissions = this.permissions();
    const names = this.records().map(record => record.name);
    if (from !== "parent") names.push("parent");
    const peers = [];
    for (const name of names) {
      if (name === from || !isAllowed(permissions, from, name)) continue;
      const endpoint = this.endpoint(name);
      const record = this.records().find(candidate => candidate.name === name);
      const status = record ? (await this.inspect(record, signal)).status : "parent";
      peers.push({ ...endpoint, status, modes: ["steering", "interrupt"], delivery: name === "parent" ? "ping" : "turn" });
    }
    return { peers, note: peers.length ? undefined : "No permitted peers. The parent grants communication links." };
  }

  private validateMessage(to: string, content: string, mode: string) {
    if (!content.trim() || content.length > 10000 || /[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(content)) {
      throw new Error("Message text must contain 1-10000 characters without control characters. LF and tab are allowed");
    }
    if (mode !== "steering" && mode !== "interrupt") throw new Error("Message mode must be steering or interrupt");
    return this.endpoint(to);
  }

  private writeMessage(from: string, to: string, content: string, mode: "steering" | "interrupt", broadcastId: string | null = null) {
    const recipient = this.validateMessage(to, content, mode);
    if (from === recipient.name) throw new Error("A message cannot target its sender");
    const permissions = this.permissions();
    if (!isAllowed(permissions, from, recipient.name)) throw new Error(`No permission edge from ${from} to ${recipient.name}`);
    const message: PeerMessage = {
      messageId: randomUUID(), broadcastId, familyId: basename(this.root), from: this.endpoint(from), to: recipient, mode, content, createdAt: new Date().toISOString(),
    };
    atomicJSON(join(this.messageDirectory(), `${message.messageId}.json`), message);
    return message;
  }

  messageFiles() {
    return readdirSync(this.messageDirectory()).filter(name => /^[0-9a-f-]+\.json$/i.test(name));
  }

  readMessage(filename: string) {
    return jsonFile<PeerMessage>(join(this.messageDirectory(), filename));
  }

  receipt(messageId: string) {
    return jsonFile<PeerReceipt>(join(this.messageDirectory(), `${messageId}.receipt.json`));
  }

  writeReceipt(receipt: PeerReceipt) {
    atomicJSON(join(this.messageDirectory(), `${receipt.messageId}.receipt.json`), receipt);
  }

  readMarker(messageId: string) {
    return jsonFile<PeerRead>(join(this.messageDirectory(), `${messageId}.read.json`));
  }

  writeReadMarker(messageId: string, sessionId: string) {
    const path = join(this.messageDirectory(), `${messageId}.read.json`);
    if (!existsSync(path)) atomicJSON(path, { readAt: new Date().toISOString(), sessionId } satisfies PeerRead);
    return this.readMarker(messageId);
  }

  message(from: string, to: string, content: string, mode: "steering" | "interrupt") {
    const message = this.writeMessage(from, to, content, mode);
    return { messageId: message.messageId, to: message.to.name, mode: message.mode, delivery: message.to.name === "parent" ? "ping" : "turn", state: "queued", note: "Recipient acceptance is not confirmed by this call." };
  }

  async broadcast(content: string, mode: "steering" | "interrupt", recipients?: string[], signal?: AbortSignal) {
    this.validateMessage("parent", content, mode);
    const requested = recipients ?? this.records().map(record => record.name);
    const broadcastId = randomUUID();
    const results = [];
    for (const name of requested) {
      try {
        const record = this.records().find(candidate => candidate.name === name);
        if (!record) throw new Error(`Unknown family member ${JSON.stringify(name)}`);
        if (!recipients && (await this.inspect(record, signal)).status === "unavailable") continue;
        const message = this.writeMessage("parent", name, content, mode, broadcastId);
        results.push({ to: name, messageId: message.messageId, state: "queued" });
      } catch (error) {
        results.push({ to: name, error: bounded(String(error), 300) });
      }
    }
    return { broadcastId, results };
  }

  async messages(offset = 0, peer?: string, maxChars = 12000, signal?: AbortSignal, sessionId = "unknown") {
    if (peer) this.endpoint(peer);
    const directory = join(this.root, "messages");
    if (!existsSync(directory)) return { messages: [], nextOffset: null };
    privateDirectory(directory);
    const records = readdirSync(directory).filter(name => /^[0-9a-f-]+\.json$/i.test(name)).flatMap(name => {
      const message = jsonFile<PeerMessage>(join(directory, name));
      return message && (!peer || message.from.name === peer || message.to.name === peer) ? [message] : [];
    }).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.messageId.localeCompare(right.messageId));
    const rows = [];
    for (const message of records.slice(offset, offset + 50)) {
      const receipt = this.receipt(message.messageId);
      let state = receipt?.state ?? "pending";
      let read = this.readMarker(message.messageId);
      if (message.to.name === "parent" && !read) {
        try { read = this.writeReadMarker(message.messageId, sessionId); } catch { /* Reading remains useful if badge clearing fails. */ }
      }
      if (!receipt && message.to.name !== "parent") {
        const record = this.records().find(candidate => candidate.name === message.to.name);
        if (record && (await this.inspect(record, signal)).status === "unavailable") state = "undeliverable";
      }
      rows.push({ messageId: message.messageId, broadcastId: message.broadcastId, familyId: message.familyId,
        from: message.from, to: message.to, mode: message.mode, delivery: message.to.name === "parent" ? "ping" : "turn", createdAt: message.createdAt,
        content: bounded(message.content, maxChars), state, attempts: receipt?.attempts ?? null, readAt: read?.readAt ?? null,
        deliveredAt: receipt?.deliveredAt ?? null, error: receipt?.error ?? null });
    }
    return { messages: rows, nextOffset: offset + 50 < records.length ? offset + 50 : null,
      note: records.length > 500 ? "Message store exceeds 500 records. Cleanup remains manual." : undefined };
  }
}

export default function (pi: ExtensionAPI) {
  // Children can also spawn children. Each process has its own parent directory.
  let manager: TmuxAgents | undefined;
  const agents = () => manager ??= new TmuxAgents(pi);
  const result = (data: unknown) => {
    // Large fields are bounded before serialization. JSON escaping can expand each character sixfold.
    const text = JSON.stringify(data, null, 2);
    return { content: [{ type: "text" as const, text: text.length <= 128000 ? text : JSON.stringify({
      error: "Output exceeds 128000 serialized characters. Request fewer characters or inspect the child TUI.",
    }) }], details: {} };
  };
  const id = Type.String({ pattern: "^%[0-9]+$", description: "Managed pane ID returned by spawn/list" });
  const familyRoot = process.env[FAMILY_ROOT];
  const familyName = process.env[FAMILY_NAME];
  let familyManager: TmuxAgents | undefined;
  const family = () => {
    if (!familyRoot) throw new Error("This process is not a member of a spawn family");
    return familyManager ??= new TmuxAgents(pi, familyRoot);
  };
  // Parent-scoped tools use ownership. Peer tools use membership when it exists.
  const peerAgents = () => familyRoot ? family() : agents();
  const peerName = () => familyRoot ? familyName ?? (() => { throw new Error("Family membership has no name"); })() : "parent";
  pi.registerTool({ name: "tmux_agent_spawn", label: "Spawn tmux Pi", executionMode: "sequential",
    description: "Start one interactive Pi in a NEW tmux window (default) or pane. name is the bottom window tab label. Pane mode renames the containing window for every pane. No initial prompt; use send once ready. Does not close agents or retry spawns.",
    parameters: Type.Object({ name: Type.String(), mode: Type.Optional(StringEnum(["window", "pane"] as const)), cwd: Type.Optional(Type.String()),
      systemPrompt: Type.Optional(Type.String({ description: "Replacement system prompt FILE, resolved relative to parent cwd; must exist" })),
      provider: Type.Optional(Type.String()), model: Type.Optional(Type.String()), thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const)),
      waitMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 30000 })) }),
    async execute(_id, args, signal, _update, ctx) { return result(await agents().spawn(args, ctx, signal)); } });
  pi.registerTool({ name: "tmux_agent_send", label: "Send to tmux Pi", executionMode: "sequential",
    description: "Submit text or a slash command to a ready managed Pi using bracketed paste then Enter. Assumes normal empty editor, no dialogs or concurrent typing. Does NOT confirm Pi accepted it. Control characters rejected, max 50000 characters. Never sends Ctrl+C.",
    parameters: Type.Object({ id, text: Type.String({ minLength: 1, maxLength: 50000 }) }),
    async execute(_id, args, signal) { return result(await agents().send(args.id, args.text, signal)); } });
  pi.registerTool({ name: "tmux_agent_read", label: "Read tmux Pi", executionMode: "sequential",
    description: "Read latest completed assistant reply, excluding thinking/tool calls/user prompts. terminal=true instead captures visible terminal output for slash commands/startup diagnostics; it can contain prompts and sensitive text. Output bounded to maxChars, default 12000. Poll explicitly; no automatic push.",
    parameters: Type.Object({ id, terminal: Type.Optional(Type.Boolean()), maxChars: Type.Optional(Type.Integer({ minimum: 1000, maximum: 20000 })) }),
    async execute(_id, args, signal) { return result(await agents().read(args.id, args.terminal, args.maxChars, signal)); } });
  pi.registerTool({ name: "tmux_agent_context", label: "tmux Pi context", executionMode: "sequential",
    description: "Get managed Pi's latest event or settlement snapshot of raw context tokens, decimal Xk, capacity, percent, model and thinking level. Estimates, not cumulative billing. Unknown is null; startup can undercount system/tool cost.",
    parameters: Type.Object({ id }), async execute(_id, args, signal) { return result(await agents().context(args.id, signal)); } });
  pi.registerTool({ name: "tmux_agent_list", label: "List tmux Pi agents", executionMode: "sequential",
    description: "List only children launched by this parent process, including across /reload. Returns up to 50 with IDs/status; cannot adopt existing agents.",
    parameters: Type.Object({ offset: Type.Optional(Type.Integer({ minimum: 0 })) }),
    async execute(_id, args, signal) { return result(await agents().list(args.offset, signal)); } });
  pi.registerTool({ name: "tmux_agent_permissions", label: "Manage family permissions", executionMode: "sequential",
    description: "Grant, revoke, or list directed peer-message permission edges in caller's own spawn family. Child callers manage only families they spawned.",
    parameters: Type.Object({ action: StringEnum(["grant", "revoke", "list"] as const), from: Type.Optional(Type.String()), to: Type.Optional(Type.String()) }),
    async execute(_id, args) {
      if (args.action === "list") return result(agents().permissions());
      if (!args.from || !args.to) throw new Error("from and to are required for grant and revoke");
      return result(args.action === "grant" ? agents().grant(args.from, args.to) : agents().revoke(args.from, args.to));
    } });
  pi.registerTool({ name: "tmux_agent_peers", label: "List permitted peers", executionMode: "sequential",
    description: "List only family endpoints caller may message. Address peers by name. delivery=ping means a parent-addressed message surfaces a badge and never starts a parent turn. Parent grants communication links.",
    parameters: Type.Object({}), async execute(_id, _args, signal) { return result(await peerAgents().peers(peerName(), signal)); } });
  pi.registerTool({ name: "tmux_agent_message", label: "Message family peer", executionMode: "sequential",
    description: "Send one allowed family peer a steering or interrupt message by name. Individual messaging is confined to the caller's family; broadcast reaches the caller's own children. A parent-addressed message is a ping: it surfaces a badge and never starts a parent turn. Recipient acceptance is not confirmed. An interrupt can abort recipient work and leave queued text in recipient editor, which can block tmux_agent_send until cleared. A busy interrupt can take about 15 seconds to fail.",
    parameters: Type.Object({ to: Type.String(), text: Type.String({ minLength: 1, maxLength: 10000 }), mode: StringEnum(["steering", "interrupt"] as const) }),
    async execute(_id, args) { return result(peerAgents().message(peerName(), args.to, args.text, args.mode)); } });
  pi.registerTool({ name: "tmux_agent_broadcast", label: "Broadcast to family children", executionMode: "sequential",
    description: "Send one steering or interrupt message to selected children, or all live children when recipients is omitted. Acts only on caller's own spawn family. It does not grant child-to-child permissions.",
    parameters: Type.Object({ text: Type.String({ minLength: 1, maxLength: 10000 }), mode: StringEnum(["steering", "interrupt"] as const), recipients: Type.Optional(Type.Array(Type.String())) }),
    async execute(_id, args, signal) { return result(await agents().broadcast(args.text, args.mode, args.recipients, signal)); } });
  pi.registerTool({ name: "tmux_agent_messages", label: "Inspect family messages", executionMode: "sequential",
    description: "Inspect messages in caller's own spawn family. Only family owner sees this family's records. Content is bounded by maxChars. Reading parent-addressed rows clears their unread badge.",
    parameters: Type.Object({ offset: Type.Optional(Type.Integer({ minimum: 0 })), peer: Type.Optional(Type.String()), maxChars: Type.Optional(Type.Integer({ minimum: 1000, maximum: 20000 })) }),
    async execute(_id, args, signal, _update, ctx) { return result(await agents().messages(args.offset, args.peer, args.maxChars, signal, ctx.sessionManager.getSessionId())); } });

  // The parent installs the window menu once per process. Children inherit the tmux server's binding.
  let menuChecked = false;
  pi.on("session_start", async (_event, ctx) => {
    if (menuChecked || process.env[CHILD_DIR] || !process.env.TMUX || ctx.mode !== "tui") return;
    menuChecked = true;
    if (["off", "0", "false", "no", "disabled"].includes((process.env[MENU_OPT_OUT] ?? "").trim().toLowerCase())) return;
    try {
      const outcome = await installWindowMenu(pi.exec.bind(pi), socketPath());
      if (outcome === "kept-custom-binding") {
        ctx.ui.notify(`tmux-agents: right-click window menu not installed, because ${MENU_KEY} already has a custom tmux binding.`, "info");
      } else if (outcome === "unsupported-path") {
        ctx.ui.notify("tmux-agents: right-click window menu not installed, because the extension's path contains characters that would need quoting.", "warning");
      }
    } catch (error) {
      ctx.ui.notify(`tmux-agents: could not install the right-click window menu. ${bounded(String(error), 300)}`, "warning");
    }
  });

  let parentGeneration = 0;
  let parentTimer: NodeJS.Timeout | undefined;
  const stopParentWatcher = () => { parentGeneration++; if (parentTimer) clearTimeout(parentTimer); parentTimer = undefined; };
  pi.on("session_start", (_event, ctx) => {
    stopParentWatcher();
    const root = existingParentDirectory();
    if (!root) return;
    const owner = new TmuxAgents(pi, root);
    const current = parentGeneration;
    const sessionId = ctx.sessionManager.getSessionId();
    const terminalMessages = new Set<string>();
    const writeTerminalReceipt = (receipt: PeerReceipt) => {
      if (!owner.receipt(receipt.messageId)) owner.writeReceipt(receipt);
    };
    const tick = () => {
      parentTimer = undefined;
      if (current !== parentGeneration) return;
      try {
        if (ctx.sessionManager.getSessionId() !== sessionId) return;
        const files = owner.messageFiles();
        const messages: PeerMessage[] = [];
        for (const filename of files) {
          const messageId = filename.slice(0, -5);
          if (terminalMessages.has(messageId)) continue;
          const receipt = owner.receipt(messageId);
          const read = owner.readMarker(messageId);
          if (receipt && read) {
            terminalMessages.add(messageId);
            continue;
          }
          let message: PeerMessage | undefined;
          try { message = owner.readMessage(filename); } catch (error) {
            writeTerminalReceipt({ messageId, state: "invalid-record", error: bounded(String(error), 300) });
            continue;
          }
          if (!isPeerMessage(message) || message.to.name !== "parent") continue;
          messages.push(message);
          if (owner.receipt(message.messageId)) continue;
          if (message.createdAt < PROCESS_STARTED_AT) {
            writeTerminalReceipt({ messageId: message.messageId, state: "expired-stale" });
            continue;
          }
          try {
            owner.recordByName(message.from.name);
          } catch (error) {
            writeTerminalReceipt({ messageId: message.messageId, state: "invalid-record", error: bounded(String(error), 300) });
            continue;
          }
          if (!isAllowed(owner.permissions(), message.from.name, "parent")) {
            writeTerminalReceipt({ messageId: message.messageId, state: "blocked-revoked" });
            continue;
          }
          const surfaced = !!ctx.hasUI;
          if (surfaced) ctx.ui.notify(`tmux-agents: message from ${message.from.name}: ${bounded(message.content, 120)}`, "info");
          writeTerminalReceipt({ messageId: message.messageId, state: "notified", deliveredAt: new Date().toISOString(), surfaced, requestedMode: message.mode });
        }
        const unread = messages.filter(message => owner.receipt(message.messageId)?.state === "notified" && !owner.readMarker(message.messageId));
        if (ctx.hasUI) {
          if (unread.length) ctx.ui.setStatus("tmux-agents", `${unread.length} unread: ${[...new Set(unread.map(message => message.from.name))].join(", ")}`);
          else ctx.ui.setStatus("tmux-agents", undefined);
        }
      } catch (error) {
        console.error(`tmux agents: parent watcher stopped. ${bounded(String(error), 300)}`);
        try { if (ctx.hasUI) ctx.ui.setStatus("tmux-agents", undefined); } catch { /* The captured context is already invalid. */ }
        parentGeneration++;
        return;
      }
      parentTimer = setTimeout(tick, 500);
      parentTimer.unref();
    };
    tick();
  });
  pi.on("session_shutdown", () => stopParentWatcher());

  const childDir = process.env[CHILD_DIR];
  const token = process.env[CHILD_TOKEN];
  if (!childDir || !token) return;
  let owned = false;
  let waiting = false;
  let generation = 0;
  const refreshTimers = new Set<NodeJS.Timeout>();
  let pollTimer: NodeJS.Timeout | undefined;
  let pollInFlight = false;
  const handledMessages = new Set<string>();
  const stopPoller = () => { if (pollTimer) clearTimeout(pollTimer); pollTimer = undefined; pollInFlight = false; };
  const cancelRefreshes = () => {
    generation++;
    for (const timer of refreshTimers) clearTimeout(timer);
    refreshTimers.clear();
  };
  const snapshot = (ctx: ExtensionContext, event: string, stopped = false) => {
    if (!owned) return;
    const data: Snapshot = { token, id: currentPane(), pid: process.pid, start: processIdentity(process.pid).start,
      sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile() ?? null,
      updatedAt: new Date().toISOString(), event, stopped, idle: ctx.isIdle(), pending: ctx.hasPendingMessages(), waiting,
      editorEmpty: ctx.ui.getEditorText().length === 0, context: contextSummary(ctx), thinking: ctx.thinkingLevel ?? null,
      model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null, reply: assistantReply(ctx.sessionManager.getBranch()) };
    atomicJSON(join(childDir, "snapshot.json"), data);
  };
  const refreshAfterSettlement = (ctx: ExtensionContext, event: string, recorded = () => true) => {
    if (!owned) return;
    const current = generation;
    const sessionId = ctx.sessionManager.getSessionId();
    const deadline = Date.now() + 10 * 60 * 1000;
    const schedule = () => {
      const timer = setTimeout(() => {
        refreshTimers.delete(timer);
        if (!owned || current !== generation) return;
        try {
          if (ctx.sessionManager.getSessionId() !== sessionId) return;
          if (ctx.isIdle() && !ctx.hasPendingMessages() && recorded()) {
            snapshot(ctx, `${event}_settled`);
          } else if (Date.now() < deadline) {
            schedule();
          } else {
            ctx.ui.notify("tmux agents: telemetry refresh timed out. Snapshot may be stale until the next event.", "warning");
          }
        } catch {
          console.error("tmux agents: deferred telemetry refresh failed. Inspect the child TUI.");
        }
      }, 100);
      timer.unref();
      refreshTimers.add(timer);
    };
    schedule();
  };
  const startPoller = (ctx: ExtensionContext) => {
    if (!familyRoot || !familyName || !owned || ctx.mode !== "tui") return;
    const current = generation;
    const sessionId = ctx.sessionManager.getSessionId();
    const manager = family();
    const writeReceipt = (receipt: PeerReceipt) => { if (!manager.receipt(receipt.messageId)) manager.writeReceipt(receipt); };
    type GuardResult =
      | { ok: true }
      | { ok: false; reason: "revoked" | "lifecycle" | "stale" | "invalid" | "not-mine" | "receipted" | "waiting" };
    const guarded = (message: unknown): GuardResult => {
      if (!owned || current !== generation || ctx.sessionManager.getSessionId() !== sessionId) return { ok: false, reason: "lifecycle" };
      if (waiting) return { ok: false, reason: "waiting" };
      if (!isPeerMessage(message)) return { ok: false, reason: "invalid" };
      if (message.to.name !== familyName) return { ok: false, reason: "not-mine" };
      if (message.createdAt < PROCESS_STARTED_AT) return { ok: false, reason: "stale" };
      if (manager.receipt(message.messageId)) return { ok: false, reason: "receipted" };
      try {
        if (message.from.name !== "parent") manager.recordByName(message.from.name);
      } catch {
        return { ok: false, reason: "invalid" };
      }
      return isAllowed(manager.permissions(), message.from.name, familyName) ? { ok: true } : { ok: false, reason: "revoked" };
    };
    const handleGuardFailure = (message: PeerMessage, guard: GuardResult) => {
      if (guard.ok) return;
      if (guard.reason === "revoked") writeReceipt({ messageId: message.messageId, state: "blocked-revoked" });
      else if (guard.reason === "stale") writeReceipt({ messageId: message.messageId, state: "expired-stale" });
      else if (guard.reason === "invalid") writeReceipt({ messageId: message.messageId, state: "invalid-record", error: "Message sender is not a known family member" });
    };
    const failedInjection = (message: PeerMessage, error: unknown) => {
      try {
        writeReceipt({ messageId: message.messageId, state: "failed-injection", error: bounded(String(error), 300) });
      } catch { /* The enclosing poller stops if even the terminal receipt cannot be recorded. */ }
      throw error;
    };
    const deliver = async (message: PeerMessage) => {
      let guard = guarded(message);
      if (!guard.ok) {
        handleGuardFailure(message, guard);
        return;
      }
      if (message.mode === "steering") {
        try {
          if (ctx.isIdle()) pi.sendUserMessage(message.content);
          else pi.sendUserMessage(message.content, { deliverAs: "steer" });
          writeReceipt({ messageId: message.messageId, state: "delivered", deliveredAt: new Date().toISOString() });
        } catch (error) {
          failedInjection(message, error);
        }
        return;
      }
      for (let attempts = 1; attempts <= 3; attempts++) {
        guard = guarded(message);
        if (!guard.ok) {
          handleGuardFailure(message, guard);
          return;
        }
        ctx.abort();
        const deadline = Date.now() + 5000;
        while (!ctx.isIdle() && Date.now() < deadline) await delay(100);
        guard = guarded(message);
        if (!guard.ok) {
          handleGuardFailure(message, guard);
          return;
        }
        if (ctx.isIdle()) {
          try {
            pi.sendUserMessage(message.content);
            writeReceipt({ messageId: message.messageId, state: "delivered", deliveredAt: new Date().toISOString(), attempts });
          } catch (error) {
            failedInjection(message, error);
          }
          return;
        }
      }
      writeReceipt({ messageId: message.messageId, state: "failed-interrupt-timeout", attempts: 3, error: "Recipient did not become idle after three interrupt attempts" });
    };
    const poll = async () => {
      if (pollInFlight || current !== generation || !owned) return;
      pollInFlight = true;
      try {
        const entries: { filename: string; message: PeerMessage }[] = [];
        for (const filename of manager.messageFiles().sort()) {
          const messageId = filename.slice(0, -5);
          if (handledMessages.has(messageId) || manager.receipt(messageId)) continue;
          try {
            const message: unknown = manager.readMessage(filename);
            if (!isPeerMessage(message)) {
              manager.writeReceipt({ messageId, state: "invalid-record", error: "Message record has an invalid schema" });
              continue;
            }
            entries.push({ filename, message });
          } catch (error) {
            if (!manager.receipt(messageId)) manager.writeReceipt({ messageId, state: "invalid-record", error: bounded(String(error), 300) });
          }
        }
        entries.sort((left, right) => left.message.createdAt.localeCompare(right.message.createdAt) || left.message.messageId.localeCompare(right.message.messageId));
        for (const { message } of entries) {
          if (manager.receipt(message.messageId)) continue;
          if (message.to.name !== familyName) continue;
          if (message.createdAt < PROCESS_STARTED_AT) {
            writeReceipt({ messageId: message.messageId, state: "expired-stale" });
            continue;
          }
          await deliver(message);
          if (manager.receipt(message.messageId)) handledMessages.add(message.messageId);
          break;
        }
      } catch (error) {
        console.error(`tmux agents: message poller stopped. ${bounded(String(error), 300)}`);
        generation++;
      } finally { pollInFlight = false; }
    };
    const schedule = () => {
      if (current !== generation || !owned) return;
      void poll().finally(() => {
        if (current === generation && owned) { pollTimer = setTimeout(schedule, 500); pollTimer.unref(); }
      });
    };
    schedule();
  };
  pi.on("session_start", async (_event, ctx) => {
    stopPoller();
    cancelRefreshes();
    owned = false;
    waiting = false;
    const current = generation;
    if (ctx.mode !== "tui") return;
    privateDirectory(childDir);
    const check = await pi.exec("tmux", ["-S", socketPath(), "display-message", "-p", "-t", currentPane(), "#{pane_pid}"], { timeout: 5000 });
    if (current !== generation) return;
    // A nested Pi that merely inherits our env must not publish as its parent.
    owned = check.code === 0 && Number(check.stdout.trim()) === process.pid;
    snapshot(ctx, "session_start");
    startPoller(ctx);
  });
  const update = (event: { type: string }, ctx: ExtensionContext) => { snapshot(ctx, event.type); };
  const updateAfterSettlement = (event: { type: string }, ctx: ExtensionContext) => {
    snapshot(ctx, event.type);
    // Pi clears tree/manual-compaction controllers only after all event handlers return.
    refreshAfterSettlement(ctx, event.type);
  };
  pi.on("agent_start", update);
  pi.on("turn_end", update);
  pi.on("agent_settled", update);
  pi.on("model_select", update);
  pi.on("thinking_level_select", update);
  pi.on("session_compact", updateAfterSettlement);
  pi.on("session_compact_failed", updateAfterSettlement);
  pi.on("session_tree", updateAfterSettlement);
  pi.on("user_bash", (event, ctx) => {
    if (!owned) return;
    // isIdle() excludes user bash. Wait for its saved result, including delayed extension handlers.
    const count = ctx.sessionManager.getEntries().length;
    refreshAfterSettlement(ctx, event.type, () => ctx.sessionManager.getEntries().slice(count).some(entry =>
      entry.type === "message" && entry.message.role === "bashExecution" && entry.message.command === event.command));
  });
  pi.on("session_info_changed", update);
  pi.on("ui_prompt_start", (_event, ctx) => { waiting = true; snapshot(ctx, "ui_prompt_start"); });
  pi.on("ui_prompt_end", (_event, ctx) => { waiting = false; snapshot(ctx, "ui_prompt_end"); });
  pi.on("session_shutdown", (_event, ctx) => {
    stopPoller();
    cancelRefreshes();
    try { snapshot(ctx, "session_shutdown", true); }
    finally { owned = false; }
  });
}
