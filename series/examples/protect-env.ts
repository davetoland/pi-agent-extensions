import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

// .env and .env.local hold secrets. .env.example is a safe template.
const isSecret = (path: string) => /^\.env(\..+)?$/.test(basename(path)) && !path.endsWith(".example");

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event) => {
		if (
			(isToolCallEventType("read", event) ||
				isToolCallEventType("edit", event) ||
				isToolCallEventType("write", event)) &&
			isSecret(event.input.path)
		) {
			return {
				block: true,
				reason: `${event.input.path} may contain secrets. Ask the user for the value you need.`,
			};
		}
	});
}
