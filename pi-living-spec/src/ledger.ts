import type { Workspace } from "./workspace.js";

export const KINDS = ["functional", "ui", "data", "integration", "auth", "business-rule", "nfr", "question"] as const;
export const STATUSES = ["observed", "inferred", "mocked", "assumed"] as const;
export const PRIORITIES = ["must", "should", "could", "wont", "unknown"] as const;

export type Kind = (typeof KINDS)[number];
export type Status = (typeof STATUSES)[number];
export type Priority = (typeof PRIORITIES)[number];

export interface Requirement {
	id: string;
	area: string;
	kind: Kind;
	title: string;
	/** The requirement itself, e.g. "When X, the system shall Y". For questions: the question. */
	statement: string;
	acceptance: string[];
	/** Where this came from: routes, screenshot paths, source file:line, API calls. */
	evidence: string[];
	/** observed = seen working in the prototype; inferred = implied by code/data/UI but not seen working; mocked = UI exists but behaviour is faked; assumed = our assumption, needs confirmation. */
	status: Status;
	priority: Priority;
	notes?: string;
	/** For questions/assumptions: what we'll assume if the client doesn't answer. */
	assumption?: string;
	related?: string[];
	createdAt: string;
	updatedAt: string;
}

export interface Field {
	name: string;
	type: string;
	required?: boolean;
	notes?: string;
}

export interface Relation {
	to: string;
	kind: "one-to-one" | "one-to-many" | "many-to-one" | "many-to-many";
	via?: string;
	notes?: string;
}

export interface Entity {
	name: string;
	description: string;
	fields: Field[];
	relations: Relation[];
	rules: string[];
	evidence: string[];
	status: Status;
	updatedAt: string;
}

export interface Area {
	code: string;
	name: string;
	description?: string;
	order?: number;
}

export interface LedgerData {
	version: 1;
	project?: { name?: string; summary?: string; users?: string[]; goals?: string[] };
	areas: Area[];
	requirements: Requirement[];
	entities: Entity[];
}

const FILE = "ledger.json";

export function areaCode(raw: string): string {
	const c = raw.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, 8);
	return c || "GEN";
}

export class Ledger {
	data: LedgerData;

	constructor(private ws: Workspace) {
		this.data = ws.readJson<LedgerData>(FILE, { version: 1, areas: [], requirements: [], entities: [] });
		this.data.areas ??= [];
		this.data.requirements ??= [];
		this.data.entities ??= [];
	}

	reload(): this {
		this.data = this.ws.readJson<LedgerData>(FILE, this.data);
		return this;
	}

	save(): string {
		return this.ws.writeJson(FILE, this.data);
	}

	nextId(area: string, kind: Kind): string {
		const prefix = kind === "question" ? "Q" : areaCode(area);
		const nums = this.data.requirements
			.filter((r) => r.id.startsWith(`${prefix}-`))
			.map((r) => Number(r.id.slice(prefix.length + 1)))
			.filter((n) => Number.isFinite(n));
		const n = (nums.length ? Math.max(...nums) : 0) + 1;
		return `${prefix}-${String(n).padStart(3, "0")}`;
	}

	defineArea(a: { code: string; name: string; description?: string; order?: number }): Area {
		const code = areaCode(a.code);
		const existing = this.data.areas.find((x) => x.code === code);
		if (existing) {
			Object.assign(existing, { ...a, code });
			return existing;
		}
		const area: Area = { ...a, code, order: a.order ?? this.data.areas.length + 1 };
		this.data.areas.push(area);
		return area;
	}

	/** Map an area given as code or display name onto an existing area code. */
	resolveArea(raw: string): string {
		const code = areaCode(raw);
		const hit = this.data.areas.find((a) => a.code === code || a.name.toLowerCase() === raw.trim().toLowerCase());
		return hit ? hit.code : code;
	}

	/** Near-duplicate guard: same area and same normalised title. */
	findDuplicate(area: string, title: string): Requirement | undefined {
		const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
		const code = this.resolveArea(area);
		return this.data.requirements.find((r) => r.area === code && norm(r.title) === norm(title));
	}

	add(input: Partial<Requirement> & { area: string; title: string; statement: string; kind: Kind }): { req: Requirement; duplicateOf?: string } {
		const now = new Date().toISOString();
		const dup = this.findDuplicate(input.area, input.title);
		if (dup) return { req: dup, duplicateOf: dup.id };
		const code = this.resolveArea(input.area);
		if (input.kind !== "question" && !this.data.areas.some((a) => a.code === code)) this.defineArea({ code, name: input.area });
		const req: Requirement = {
			id: this.nextId(code, input.kind),
			area: input.kind === "question" ? code : code,
			kind: input.kind,
			title: input.title.trim(),
			statement: input.statement.trim(),
			acceptance: input.acceptance ?? [],
			evidence: input.evidence ?? [],
			status: input.status ?? (input.kind === "question" ? "assumed" : "observed"),
			priority: input.priority ?? "unknown",
			notes: input.notes,
			assumption: input.assumption,
			related: input.related,
			createdAt: now,
			updatedAt: now,
		};
		this.data.requirements.push(req);
		return { req };
	}

	update(id: string, patch: Partial<Requirement> & { appendEvidence?: string[]; appendAcceptance?: string[] }): Requirement {
		const r = this.data.requirements.find((x) => x.id.toUpperCase() === id.toUpperCase());
		if (!r) throw new Error(`No requirement ${id}`);
		const { appendEvidence, appendAcceptance, id: _ignore, createdAt: _c, ...rest } = patch;
		for (const [k, v] of Object.entries(rest)) if (v !== undefined) (r as unknown as Record<string, unknown>)[k] = v;
		if (rest.area) r.area = this.resolveArea(rest.area);
		if (appendEvidence?.length) r.evidence = [...new Set([...r.evidence, ...appendEvidence])];
		if (appendAcceptance?.length) r.acceptance = [...r.acceptance, ...appendAcceptance];
		r.updatedAt = new Date().toISOString();
		return r;
	}

	remove(id: string): boolean {
		const before = this.data.requirements.length;
		this.data.requirements = this.data.requirements.filter((x) => x.id.toUpperCase() !== id.toUpperCase());
		return this.data.requirements.length < before;
	}

	upsertEntity(e: Partial<Entity> & { name: string }): { entity: Entity; created: boolean } {
		const now = new Date().toISOString();
		const existing = this.data.entities.find((x) => x.name.toLowerCase() === e.name.toLowerCase());
		if (existing) {
			if (e.description) existing.description = e.description;
			if (e.status) existing.status = e.status;
			if (e.fields) {
				for (const f of e.fields) {
					const i = existing.fields.findIndex((x) => x.name === f.name);
					if (i >= 0) existing.fields[i] = { ...existing.fields[i], ...f };
					else existing.fields.push(f);
				}
			}
			if (e.relations) {
				for (const r of e.relations) {
					const i = existing.relations.findIndex((x) => x.to === r.to && (x.via ?? "") === (r.via ?? ""));
					if (i >= 0) existing.relations[i] = r;
					else existing.relations.push(r);
				}
			}
			if (e.rules) existing.rules = [...new Set([...existing.rules, ...e.rules])];
			if (e.evidence) existing.evidence = [...new Set([...existing.evidence, ...e.evidence])];
			existing.updatedAt = now;
			return { entity: existing, created: false };
		}
		const entity: Entity = {
			name: e.name,
			description: e.description ?? "",
			fields: e.fields ?? [],
			relations: e.relations ?? [],
			rules: e.rules ?? [],
			evidence: e.evidence ?? [],
			status: e.status ?? "inferred",
			updatedAt: now,
		};
		this.data.entities.push(entity);
		return { entity, created: true };
	}

	removeEntity(name: string): boolean {
		const before = this.data.entities.length;
		this.data.entities = this.data.entities.filter((x) => x.name.toLowerCase() !== name.toLowerCase());
		return this.data.entities.length < before;
	}

	counts() {
		const r = this.data.requirements;
		return {
			requirements: r.filter((x) => x.kind !== "question").length,
			questions: r.filter((x) => x.kind === "question").length,
			mocked: r.filter((x) => x.status === "mocked").length,
			entities: this.data.entities.length,
			areas: this.data.areas.length,
		};
	}

	/** Compact listing for the model. */
	list(filter: { area?: string; kind?: string; status?: string; query?: string } = {}): string {
		const q = filter.query?.toLowerCase();
		const rows = this.data.requirements.filter(
			(r) =>
				(!filter.area || r.area === this.resolveArea(filter.area)) &&
				(!filter.kind || r.kind === filter.kind) &&
				(!filter.status || r.status === filter.status) &&
				(!q || `${r.title} ${r.statement}`.toLowerCase().includes(q)),
		);
		const lines = rows.map((r) => `${r.id} [${r.kind}/${r.status}/${r.priority}] ${r.title}`);
		const c = this.counts();
		return [
			`${c.requirements} requirements, ${c.questions} open questions, ${c.entities} entities, ${c.areas} areas. Showing ${rows.length}.`,
			this.data.areas.length ? `Areas: ${this.data.areas.map((a) => `${a.code}=${a.name}`).join(", ")}` : "",
			...lines,
			filter.area || filter.kind || filter.status || filter.query
				? ""
				: this.data.entities.length
					? `Entities: ${this.data.entities.map((e) => `${e.name}(${e.fields.length} fields)`).join(", ")}`
					: "",
		]
			.filter(Boolean)
			.join("\n");
	}
}
