import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, matchesGlob, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir, isReadToolResult, isToolCallEventType } from "@earendil-works/pi-coding-agent";

interface Instruction {
	path: string;
	description: string;
	applyTo: string[];
	content: string;
}

function stripQuotes(value: string): string {
	const trimmed = value.trim();

	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		return trimmed.slice(1, -1);
	}

	return trimmed;
}

function parseInstruction(absolutePath: string): Instruction | undefined {
	let source: string;

	try {
		source = readFileSync(absolutePath, "utf8");
	} catch {
		// One unreadable file must not stop the others loading.
		return undefined;
	}

	const match = source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/);

	if (!match) {
		return undefined;
	}

	const [, frontmatter, body] = match;

	let description = "";
	let applyTo = "";

	for (const line of frontmatter.split(/\r?\n/)) {
		const separator = line.indexOf(":");

		if (separator < 0) {
			continue;
		}

		const key = line.slice(0, separator).trim();
		const value = stripQuotes(line.slice(separator + 1));

		if (key === "description") {
			description = value;
		}

		if (key === "applyTo") {
			applyTo = value;
		}
	}

	if (!applyTo) {
		return undefined;
	}

	return {
		path: absolutePath,
		description,
		applyTo: applyTo
			.split(",")
			.map((pattern) => pattern.trim())
			.filter(Boolean),
		content: body.trim(),
	};
}

// Instructions are user-level, shared by every project and worktree.
function discoverInstructions(): Instruction[] {
	const root = join(getAgentDir(), "instructions");

	if (!existsSync(root)) {
		return [];
	}

	const instructions: Instruction[] = [];

	function walk(directory: string): void {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);

			if (entry.isDirectory()) {
				walk(path);
				continue;
			}

			if (!entry.isFile() || !entry.name.endsWith(".md")) {
				continue;
			}

			const instruction = parseInstruction(path);

			if (instruction) {
				instructions.push(instruction);
			}
		}
	}

	walk(root);

	return instructions;
}

function toAbsolutePath(path: string, cwd: string): string {
	// Pi's built-in tools tolerate @path, so mirror that here.
	const clean = path.startsWith("@") ? path.slice(1) : path;

	return isAbsolute(clean) ? clean : resolve(cwd, clean);
}

/*
 * applyTo patterns are relative to the repository that contains the file,
 * which is not the session cwd when the file is in another worktree.
 * A worktree has a .git file, a main checkout a .git directory.
 */
function toRepoPath(absolute: string, cwd: string): string {
	let directory = dirname(absolute);

	while (!existsSync(join(directory, ".git"))) {
		const parent = dirname(directory);

		if (parent === directory) {
			directory = cwd;
			break;
		}

		directory = parent;
	}

	return relative(directory, absolute).split(sep).join("/");
}

function matches(filePath: string, instruction: Instruction): boolean {
	return instruction.applyTo.some((pattern) => matchesGlob(filePath, pattern));
}

export default function conditionalInstructions(pi: ExtensionAPI) {
	let cwd = "";
	let instructions: Instruction[] = [];

	// Tracks instructions already placed into this session's model context.
	const loaded = new Set<string>();

	pi.on("session_start", async (_event, ctx) => {
		cwd = ctx.cwd;
		instructions = discoverInstructions();
		loaded.clear();
	});

	/*
	 * Give the model a very small index rather than injecting every instruction.
	 *
	 * This is similar to Pi's own claude-rules example: advertise what rules
	 * exist, then load the actual content only when relevant.
	 */
	pi.on("before_agent_start", async (event) => {
		if (instructions.length === 0) {
			return;
		}

		const index = instructions
			.map((instruction) => {
				const description = instruction.description ? ` — ${instruction.description}` : "";

				return `- ${instruction.path} [${instruction.applyTo.join(", ")}]${description}`;
			})
			.join("\n");

		return {
			systemPrompt:
				event.systemPrompt +
				`

## Conditional repository instructions

Repository instructions exist for particular file types:

${index}

Before modifying a file matching one of these patterns, ensure the
corresponding instruction file has been read and followed.
`,
		};
	});

	/*
	 * When Pi reads a source file, automatically append any applicable
	 * instructions to that tool result.
	 *
	 * Therefore reading Foo.jsx gives the model:
	 *
	 *   Foo.jsx contents
	 *   +
	 *   React/JavaScript repository instructions
	 *
	 * without putting those instructions into every model request.
	 */
	pi.on("tool_result", async (event) => {
		// Nested reads (for example from a codemode script) return to the script,
		// not the model, and a failed read shows the model no file contents.
		// Neither puts instructions into context.
		if (!isReadToolResult(event) || event.isError || event.parentToolCallId) {
			return;
		}

		const path = event.input.path;

		if (typeof path !== "string") {
			return;
		}

		const absolute = toAbsolutePath(path, cwd);

		// If the model explicitly read an instruction file, consider it loaded.
		for (const instruction of instructions) {
			if (absolute === instruction.path) {
				loaded.add(instruction.path);
			}
		}

		const requestedPath = toRepoPath(absolute, cwd);

		const applicable = instructions.filter(
			(instruction) => matches(requestedPath, instruction) && !loaded.has(instruction.path),
		);

		if (applicable.length === 0) {
			return;
		}

		for (const instruction of applicable) {
			loaded.add(instruction.path);
		}

		const ruleText = applicable
			.map((instruction) => `## Instructions from ${instruction.path}\n\n${instruction.content}`)
			.join("\n\n");

		return {
			content: [
				...event.content,
				{
					type: "text",
					text: `\n\n---\n\nApplicable repository instructions:\n\n${ruleText}`,
				},
			],
		};
	});

	/*
	 * Prevent the model jumping straight to edit/write without first getting
	 * the relevant instructions into context.
	 */
	pi.on("tool_call", async (event) => {
		if (!isToolCallEventType("edit", event) && !isToolCallEventType("write", event)) {
			return;
		}

		const requestedPath = toRepoPath(toAbsolutePath(event.input.path, cwd), cwd);

		const missing = instructions.filter(
			(instruction) => matches(requestedPath, instruction) && !loaded.has(instruction.path),
		);

		if (missing.length === 0) {
			return;
		}

		return {
			block: true,
			reason:
				`Repository instructions must be loaded before modifying ` +
				`${requestedPath}. Read the following first:\n` +
				missing.map((instruction) => `- ${instruction.path}`).join("\n"),
		};
	});

	/*
	 * After compaction, don't assume the actual instruction bodies remain
	 * present in model context. Re-load them when next needed.
	 */
	pi.on("session_compact", async () => {
		loaded.clear();
	});
}
