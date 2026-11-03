/** Keep tool output inside pi's recommended budget (~50KB / 2000 lines). */
export const MAX_BYTES = 48 * 1024;
export const MAX_LINES = 1800;

export function clip(text: string, opts: { maxBytes?: number; maxLines?: number; savedAt?: string } = {}): string {
	const maxBytes = opts.maxBytes ?? MAX_BYTES;
	const maxLines = opts.maxLines ?? MAX_LINES;
	const lines = text.split("\n");
	let out: string[] = [];
	let bytes = 0;
	let cut = false;
	for (const l of lines) {
		const b = Buffer.byteLength(l, "utf8") + 1;
		if (out.length >= maxLines || bytes + b > maxBytes) {
			cut = true;
			break;
		}
		out.push(l);
		bytes += b;
	}
	if (!cut) return text;
	out = out.concat([
		"",
		`[Output truncated: showing ${out.length} of ${lines.length} lines.${opts.savedAt ? ` Full output: ${opts.savedAt} (use read with offset/limit).` : ""}]`,
	]);
	return out.join("\n");
}
