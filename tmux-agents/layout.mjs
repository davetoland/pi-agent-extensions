// Plain Node module: tmux hooks can run this without Pi, a loader or a package.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const PREFIX = "@piao_";
const HOOK_INDEX = 81731;
const HOOKS = [
	"window-layout-changed",
	"window-resized",
	"window-linked",
	"pane-exited",
	"after-split-window",
	"after-kill-pane",
];
export const quote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
const runner = [process.execPath, SELF].map(quote).join(" ");
const cli = (args) => `${runner} ${args.map(quote).join(" ")}`;
// run-shell expands tmux formats even inside shell quotes.
const literal = (s) => s.replace(/#/g, "##");
const action = (...args) => `run-shell -b ${quote(literal(cli(args)))}`;

function sizes(total, count) {
	const space = total - count + 1; // A single border between adjacent cells.
	if (space < count * 2) throw new Error("Terminal is too small for this layout. Detach some agents or enlarge it.");
	return Array.from({ length: count }, (_, i) => Math.floor(space / count) + (i < space % count ? 1 : 0));
}

function cell(width, height, x, y, id) {
	return { width, height, x, y, id };
}
function column(ids, width, height, x) {
	if (ids.length === 1) return cell(width, height, x, 0, ids[0]);
	let y = 0;
	const heights = sizes(height, ids.length);
	return {
		width,
		height,
		x,
		y: 0,
		axis: "v",
		children: ids.map((id, i) => {
			const leaf = cell(width, heights[i], x, y, id);
			y += heights[i] + 1;
			return leaf;
		}),
	};
}

/** Pane order is tmux's list order, NOT the IDs embedded in a layout string. */
export function makeLayout(ids, width, height, mode = "auto", widthOverride = 0) {
	if (!ids.length || width < 2 || height < 2) throw new Error("No usable panes or terminal space.");
	if (ids.length === 1) return cell(width, height, 0, 0, ids[0]);
	const n = ids.length - 1;
	const ratio = widthOverride || (mode === "stack" ? 50 : n === 1 ? 60 : n <= 3 ? 50 : n <= 6 ? 40 : 35);
	let count =
		mode === "grid"
			? Math.ceil(Math.sqrt(ids.length))
			: mode === "stack"
				? 1
				: mode === "columns" || n >= 4
					? Math.min(2, n)
					: 1;
	// Add columns when a tall stack would make children unusably short. On a
	// narrow terminal prefer fewer columns; never generate impossible cells.
	const available = mode === "grid" ? width : width - Math.round(((width - 1) * ratio) / 100) - 1;
	if (mode === "auto") count = Math.max(count, Math.ceil(n / Math.max(1, Math.floor((height + 1) / 6))));
	count = Math.max(1, Math.min(count, Math.floor((available + 1) / 13)));
	const children = [];
	let rest = ids;
	let x = 0;
	if (mode !== "grid") {
		const mainWidth = Math.round(((width - 1) * ratio) / 100);
		if (mainWidth < 2 || width - mainWidth - 1 < 2) throw new Error("Terminal is too narrow.");
		children.push(cell(mainWidth, height, 0, 0, ids[0]));
		rest = ids.slice(1);
		x = mainWidth + 1;
	}
	const widths = sizes(width - x, count);
	const perColumn = Math.floor(rest.length / count);
	const extra = rest.length % count;
	let offset = 0;
	for (let i = 0; i < count; i++) {
		const length = perColumn + (i < extra ? 1 : 0);
		children.push(column(rest.slice(offset, offset + length), widths[i], height, x));
		offset += length;
		x += widths[i] + 1;
	}
	return children.length === 1 ? children[0] : { width, height, x: 0, y: 0, axis: "h", children };
}

export function encodeLayout(tree) {
	const encode = (c) => {
		const head = `${c.width}x${c.height},${c.x},${c.y}`;
		if (!c.children) return `${head},${c.id.replace(/^%/, "")}`;
		return head + (c.axis === "h" ? "{" : "[") + c.children.map(encode).join(",") + (c.axis === "h" ? "}" : "]");
	};
	const body = encode(tree);
	let checksum = 0;
	for (const char of body) checksum = (((checksum >>> 1) | ((checksum & 1) << 15)) + char.charCodeAt(0)) & 0xffff;
	return `${checksum.toString(16).padStart(4, "0")},${body}`;
}

export class LayoutController {
	// tmux's error output is captured, so failures surface as error messages rather than stray terminal output.
	constructor(
		call = (...args) =>
			execFileSync("tmux", args, { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] }).trim(),
	) {
		this.call = call;
	}
	optional(...args) {
		try {
			return this.call(...args);
		} catch {
			return "";
		}
	}
	get(target, key, scope = "w") {
		return this.optional("show-options", `-${scope}qv`, "-t", target, PREFIX + key);
	}
	set(target, key, value, scope = "w") {
		this.call("set-option", `-${scope}`, "-t", target, PREFIX + key, String(value));
	}
	window(pane) {
		return this.call("display-message", "-p", "-t", pane, "#{window_id}");
	}
	panes(window) {
		return this.call("list-panes", "-t", window, "-F", "#{pane_id}").split("\n").filter(Boolean);
	}

	prepare(parent) {
		const window = this.window(parent);
		this.set(parent, "member", "1", "p");
		// A nested child in the same window must not replace the original main.
		if (!this.get(window, "main")) this.set(window, "main", parent);
		this.manage(window);
	}

	manage(window) {
		this.set(window, "managed", "1");
		this.set(window, "script", SELF);
		this.set(window, "node", process.execPath);
		if (!this.get(window, "mode")) this.set(window, "mode", "auto");
	}

	attach(parent, pane, name) {
		this.prepare(parent);
		this.set(pane, "member", "1", "p");
		this.set(pane, "parent", parent, "p");
		this.call("set-option", "-p", "-t", pane, "@pi_agent_name", name);
		this.manage(this.window(pane));
		this.refresh();
	}

	refresh(forceWindow) {
		const rows = this.call("list-panes", "-a", "-F", "#{window_id}|#{pane_id}|#{@piao_member}|#{@piao_parent}");
		const windows = new Map();
		for (const row of rows.split("\n")) {
			const [window, pane, member, parent] = row.split("|");
			if (!/^@\d+$/.test(window)) continue;
			if (!windows.has(window)) windows.set(window, []);
			if (!windows.get(window).some((p) => p.id === pane)) windows.get(window).push({ id: pane, member, parent });
		}
		for (const [window, panes] of windows) {
			if (!panes.some((p) => p.member === "1")) continue;
			this.manage(window); // Also discovers ordinary tmux break-pane/join-pane.
			let main = this.get(window, "main");
			if (!panes.some((p) => p.id === main)) {
				main = panes.find((p) => p.member === "1" && !p.parent)?.id ?? panes[0].id;
				this.set(window, "main", main);
			}
			try {
				this.arrange(window, main, forceWindow === window);
			} catch (error) {
				this.optional("display-message", `Pi layout: ${error.message}`);
			}
		}
	}

	arrange(window, main, force = false) {
		this.set(
			window,
			"shape",
			this.call(
				"display-message",
				"-p",
				"-t",
				window,
				"#{window_width}x#{window_height}/#{window_panes}/#{window_zoomed_flag}",
			),
		);
		const [layout, zoomed] = this.call(
			"display-message",
			"-p",
			"-t",
			window,
			"#{window_layout}|#{window_zoomed_flag}",
		).split("|");
		if (zoomed === "1") return; // Reflow pending changes when zoom is restored.
		const dimensions = layout.match(/^[0-9a-f]{4},(\d+)x(\d+),/i);
		if (!dimensions) return;
		const width = Number(dimensions[1]),
			height = Number(dimensions[2]);
		const mode = this.get(window, "mode") || "auto";
		const override = Number(this.get(window, "width")) || 0;
		const ids = this.panes(window);
		const signature = [ids.slice().sort().join(","), width, height, main, mode, override].join(":");
		// Geometry is deliberately absent: dragging a border must not snap back.
		if (mode === "manual" || (!force && this.get(window, "signature") === signature)) return;
		const mainIndex = ids.indexOf(main);
		if (mainIndex < 0) return;
		const ordered = [...ids];
		[ordered[0], ordered[mainIndex]] = [ordered[mainIndex], ordered[0]];
		const next = encodeLayout(makeLayout(ordered, width, height, mode, override));
		if (mainIndex !== 0) this.call("swap-pane", "-d", "-s", main, "-t", ids[0]);
		// Mark before applying: select-layout itself raises a layout-changed hook.
		this.set(window, "signature", signature);
		try {
			this.call("select-layout", "-t", window, next);
		} catch (error) {
			this.set(window, "signature", "");
			throw error;
		}
	}

	install(parent) {
		this.prepare(parent);
		this.call("set-option", "-t", parent, "mouse", "on");
		// An indexed hook replaces our previous registration on /reload. No timers
		// or resident helper processes, and no replacement of another hook slot.
		// Check dimensions/count in tmux first. A mouse drag changes only geometry,
		// so it must not start one Node process for every mouse-motion event.
		const changed =
			"#{&&:#{||:#{@piao_managed},#{@piao_member}},#{!=:#{@piao_shape},#{window_width}x#{window_height}/#{window_panes}/#{window_zoomed_flag}}}";
		for (const hook of HOOKS)
			this.call(
				"set-hook",
				"-g",
				`${hook}[${HOOK_INDEX}]`,
				`if-shell -F ${quote(changed)} ${quote(action("refresh"))}`,
			);
		for (const key of ["MouseDown3Pane", "MouseDown3Border"]) {
			const old = this.optional("list-keys", "-T", "root", key);
			if (old.includes("@piao_managed")) continue;
			const fallback = old.replace(/^bind-key\s+(?:-r\s+)?-T\s+root\s+\S+\s+/, "") || "send-keys -M";
			const menu = `run-shell -b -t = ${quote(`${literal(runner)} menu #{q:client_name} #{pane_id}`)}`;
			this.call("bind-key", "-T", "root", key, "if-shell", "-F", "-t", "=", "#{@piao_managed}", menu, fallback);
		}
		this.refresh();
	}

	menu(client, pane, submenu = "main") {
		const window = this.window(pane);
		if (!this.get(window, "managed")) this.prepare(pane);
		const mode = this.get(window, "mode");
		const width = this.get(window, "width") || "0";
		const entries = [];
		const add = (label, key, ...args) => entries.push(label, key, action(...args));
		const marked = (label, active) => `${active ? "* " : ""}${label}`;
		if (submenu === "layout") {
			for (const [value, label, key] of [
				["auto", "Auto layout", "a"],
				["stack", "Main + stack (default 50%)", "s"],
				["columns", "Three columns", "c"],
				["grid", "Equal grid", "g"],
				["manual", "Keep current layout", "k"],
			]) {
				add(marked(label, mode === value), key, "mode", window, value);
			}
			entries.push("");
			add("Main width...", "w", "width-menu", client, pane);
			add("Reapply layout now", "r", "reflow", window);
			add("Back", "b", "menu", client, pane);
		} else if (submenu === "width") {
			for (const value of [0, 30, 35, 40, 50, 60, 70])
				add(marked(value ? `${value}%` : "Automatic", width === String(value)), "", "width", window, String(value));
			add("Back", "b", "layout-menu", client, pane);
		} else {
			add("Layout...", "l", "layout-menu", client, pane);
			const zoomed = this.call("display-message", "-p", "-t", pane, "#{window_zoomed_flag}") === "1";
			add(zoomed ? "Restore layout" : "Focus this agent", "f", "zoom", pane);
			add("Keep current layout (drag borders)", "k", "mode", window, "manual");
			add("Use this pane as main", "m", "main", pane);
			entries.push("");
			for (const id of this.panes(window)) {
				const name =
					this.optional("show-options", "-pqv", "-t", id, "@pi_agent_name") ||
					(id === this.get(window, "main") ? "Main" : id);
				// Labels are tmux formats too. Never let an agent name inject a format.
				add(`Switch to ${name.replace(/[\r\n\t]/g, " ").replace(/#/g, "##")}`, "", "focus", client, id);
			}
		}
		const options = [
			"-c",
			client,
			"-t",
			pane,
			"-T",
			`Agent ${submenu === "main" ? "panes" : submenu}`,
			"-x",
			"C",
			"-y",
			"C",
			...entries,
		];
		// -M and -O need a recent tmux (3.4 has no -M). Older versions show the same menu without them.
		try {
			this.call("display-menu", "-M", "-O", ...options);
		} catch (error) {
			if (!/unknown flag -[MO]/.test(String(error?.message))) throw error;
			this.call("display-menu", ...options);
		}
	}

	run(args) {
		const [command, first, second, third] = args;
		if (command === "install") return this.install(first);
		if (command === "prepare") return this.prepare(first);
		if (command === "attach") return this.attach(first, second, third);
		if (command === "refresh") return this.refresh();
		if (command === "reflow") return this.refresh(this.window(first));
		if (["menu", "layout-menu", "width-menu"].includes(command))
			return this.menu(first, second, command === "menu" ? "main" : command.split("-")[0]);
		if (command === "zoom") {
			this.call("resize-pane", "-Z", "-t", first);
			return this.refresh();
		}
		if (command === "focus") {
			const window = this.window(second);
			if (this.call("display-message", "-p", "-t", window, "#{window_zoomed_flag}") === "1")
				this.call("resize-pane", "-Z", "-t", window);
			this.call("select-pane", "-t", second);
			this.call("switch-client", "-c", first, "-t", second);
			return;
		}
		const window = this.window(first);
		if (command === "main") this.set(window, "main", first);
		else if (command === "mode" && ["auto", "stack", "columns", "grid", "manual"].includes(second))
			this.set(window, "mode", second);
		else if (command === "width" && ["0", "30", "35", "40", "50", "60", "70"].includes(second)) {
			this.set(window, "width", second);
			if (["manual", "grid"].includes(this.get(window, "mode"))) this.set(window, "mode", "auto");
		} else throw new Error("Unknown layout action or value.");
		// Explicit layout/width choices leave focus mode and take effect now.
		if (
			this.call("display-message", "-p", "-t", window, "#{window_zoomed_flag}") === "1" &&
			this.get(window, "mode") !== "manual"
		)
			this.call("resize-pane", "-Z", "-t", window);
		this.refresh(window);
	}
}

// Multiple hook processes can arrive together. Serialize their read/apply
// cycle, with dead-process recovery rather than a permanently held tmux lock.
async function locked(controller, operation) {
	const socket = controller.call("display-message", "-p", "#{socket_path}");
	const hash = createHash("sha256").update(socket).digest("hex").slice(0, 20);
	const directory = join(tmpdir(), `piao-layout-${process.getuid?.() ?? "user"}-${hash}`);
	const owner = join(directory, "pid");
	const deadline = Date.now() + 8000;
	while (true) {
		try {
			mkdirSync(directory, { mode: 0o700 });
			break;
		} catch (error) {
			if (error.code !== "EEXIST") throw error;
			try {
				const pid = Number(readFileSync(owner, "utf8"));
				if (Number.isInteger(pid) && pid > 0) process.kill(pid, 0);
			} catch (error) {
				let abandoned = error.code === "ESRCH";
				if (error.code === "ENOENT") {
					try {
						abandoned = Date.now() - statSync(directory).mtimeMs > 30000;
					} catch (missing) {
						if (missing.code === "ENOENT") continue;
						throw missing;
					}
				}
				if (abandoned) {
					rmSync(directory, { recursive: true, force: true });
					continue;
				}
			}
			if (Date.now() > deadline) throw new Error("Timed out waiting for another layout update.");
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}
	try {
		writeFileSync(owner, String(process.pid), { mode: 0o600 });
		return operation();
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) {
	const controller = new LayoutController();
	try {
		// display-menu waits until the user selects an item: never hold the layout
		// lock or impose the ordinary five-second tmux timeout on a mouse menu.
		if (["menu", "layout-menu", "width-menu"].includes(process.argv[2])) {
			controller.call = (...args) =>
				execFileSync("tmux", args, {
					encoding: "utf8",
					stdio: ["ignore", "pipe", "pipe"],
					...(args[0] === "display-menu" ? {} : { timeout: 5000 }),
				}).trim();
			controller.run(process.argv.slice(2));
		} else await locked(controller, () => controller.run(process.argv.slice(2)));
	} catch (error) {
		process.stderr.write(`Pi layout: ${error.message}\n`);
		process.exitCode = 1;
	}
}
