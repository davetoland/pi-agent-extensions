import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Workspace } from "./workspace.js";
import { AnswerSchema, BaselineInputSchema, PatchSchema, RecordInputSchema, StateSchema, attribution, checked,
  type Answer, type Attribution, type Baseline, type BaselineInput, type Patch, type RecordInput, type SpecRecord, type SpecState } from "./schema.js";
import { archiveReference, atomicWrite, digest, json, locked, noSymlinks } from "./storage.js";
export { KINDS, STATUSES, PRIORITIES } from "./schema.js";
export type { SpecRecord, SpecState, RecordInput, Patch, Attribution } from "./schema.js";
const clone = <T>(v: T): T => structuredClone(v);
const current = (s: SpecState) => s.records.map(r => r.revisions.at(-1)!);
const prefixes: Record<RecordInput["type"], string> = { requirement: "REQ", question: "Q", decision: "DEC", scope: "SCP", goal: "GOAL", persona: "PER", journey: "JNY", screen: "SCR", component: "CMP", interface: "API", entity: "ENT", "work-package": "WP", constraint: "CON" };
const blank = (): SpecState => ({ schemaVersion: 2, sequence: 0, counters: {}, project: {}, records: [], baselines: [], impacts: [], events: [] });
const referenceIds = (r: SpecRecord) => [...(r.home ? [r.home] : []), ...(r.links ?? []).map(l => l.to), ...(r.relations ?? []).map(l => l.to), ...r.answers.flatMap(a => a.affectedIds), ...(r.estimate?.appliesTo ?? []).map(a => a.id)];
function validateRecord(r: SpecRecord): void {
  attribution(r.attribution);
  if (!/^[A-Z][A-Z0-9]*-\d{3,}$/.test(r.id)) throw new Error(`Invalid ID ${r.id}`);
  if (r.confirmation) {
    attribution(r.confirmation);
    if (r.confirmation.revision !== r.revision || r.intent !== "confirmed") throw new Error("Confirmation must apply to this exact revision");
  } else if (r.intent === "confirmed") throw new Error("Confirmed intent needs explicit attribution");
  if (r.perspective === "solution" && ["screenshot", "observed-api"].includes(r.representation ?? "")) throw new Error("Solution cannot be labelled as observed");
  if (r.perspective === "evidence" && ["wireframe", "proposed-contract"].includes(r.representation ?? "")) throw new Error("Proposed artefacts must not be labelled evidence");
  if (r.type === "requirement" && !r.statement?.trim()) throw new Error("Requirement needs statement");
  if (r.type === "question") {
    if (!r.assumption?.trim()) throw new Error("Question needs working assumption");
    if (["deferred", "blocked"].includes(r.questionState ?? "") && (!r.deferral?.reason.trim() || !r.deferral.condition.trim())) throw new Error("Deferral needs reason and condition");
    if (["partial", "answered"].includes(r.questionState ?? "") && !r.answers.length) throw new Error("Use explicit answer operation");
    for (const a of r.answers) attribution(a);
    if (r.questionState === "answered" && r.answers.at(-1)?.remainingUncertainty.length) throw new Error("An answer with remaining uncertainty is partial");
  } else if (r.questionState || r.deferral || r.options || r.answers.length) throw new Error("Question fields belong to questions");
  if (r.type !== "decision" && (r.alternatives || r.consequences)) throw new Error("Decision fields belong to decisions");
  if (r.type === "decision" && (!r.rationale?.trim() || !r.statement?.trim())) throw new Error("Decision needs statement and rationale");
  if (r.type !== "entity" && (r.fields || r.relations || r.rules)) throw new Error("Entity fields belong to entities");
  if (r.estimate) {
    if (r.type !== "work-package") throw new Error("Only shared work packages carry estimates");
    if (r.estimate.high < r.estimate.low || !r.estimate.appliesTo.length) throw new Error("Estimate needs ordered range and revision applicability");
  }
}
export function validateState(s: SpecState): void {
  checked<SpecState>(StateSchema, s, "specification");
  const ids = new Set<string>();
  const all = current(s), byId = new Map(all.map(r => [r.id, r]));
  const claim = (id: string) => {
    if (ids.has(id)) throw new Error(`Duplicate ID ${id}`);
    ids.add(id);
    const match = /^([A-Z][A-Z0-9]*)-(\d{3,})$/.exec(id);
    if (!match || (s.counters[match[1]] ?? 0) < Number(match[2])) throw new Error(`Counter behind ${id}`);
  };
  for (const row of s.records) {
    claim(row.id);
    row.revisions.forEach((r, i) => {
      if (r.id !== row.id || r.revision !== i + 1 || r.type !== row.revisions[0].type) throw new Error(`Invalid history ${row.id}`);
      validateRecord(r);
      for (const id of referenceIds(r)) if (!byId.has(id)) throw new Error(`Unresolved reference ${r.id} -> ${id}`);
      for (const a of r.estimate?.appliesTo ?? []) if (!s.records.find(x => x.id === a.id)?.revisions[a.revision - 1]) throw new Error(`Unknown estimate revision ${a.id}@${a.revision}`);
      if (r.home && byId.get(r.home)?.type !== "scope") throw new Error("Home must be a scope ID");
      for (const rel of r.relations ?? []) if (byId.get(rel.to)?.type !== "entity") throw new Error(`Entity relation ${r.id} -> ${rel.to} must target an entity record`);
      for (const l of r.links ?? []) {
        if (l.to === r.id) throw new Error("Self links not allowed");
        const target = byId.get(l.to)!;
        if (l.type === "contains" && (r.type !== "scope" || target.type !== "scope")) throw new Error("contains joins scope nodes. Use home for artefacts");
        if (["supersedes", "superseded-by"].includes(l.type) && (r.type !== "decision" || target.type !== "decision")) throw new Error("Only decisions supersede decisions");
      }
    });
  }
  const children = new Map<string, string[]>();
  for (const r of all) {
    children.set(r.id, [...(r.links ?? []).filter(l => l.type === "contains").map(l => l.to), ...all.filter(c => c.type === "scope" && c.home === r.id).map(c => c.id)]);
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error("Scope containment cycle");
    if (visited.has(id)) return;
    visiting.add(id); for (const next of children.get(id) ?? []) visit(next);
    visiting.delete(id); visited.add(id);
  };
  for (const r of all) visit(r.id);
  for (const b of s.baselines) {
    claim(b.id); attribution(b.attribution);
    if (b.state === "approved" && !b.approvers.length) throw new Error("Approved baseline needs named authority");
    for (const a of b.approvers) { attribution(a); if (!a.authority.trim()) throw new Error("Missing approval authority"); }
    const selected = new Set<string>();
    for (const x of b.records) {
      if (selected.has(x.record.id)) throw new Error("Duplicate baseline record"); selected.add(x.record.id);
      const frozen = s.records.find(r => r.id === x.record.id)?.revisions[x.record.revision - 1];
      if (json(frozen) !== json(x.record)) throw new Error("Baseline must contain exact immutable revisions");
    }
    for (const x of b.records) for (const id of referenceIds(x.record)) if (!selected.has(id)) throw new Error(`Baseline missing linked context ${id}`);
  }
  for (const i of s.impacts) {
    claim(i.id);
    if (!byId.has(i.target) || !s.records.find(r => r.id === i.cause)?.revisions[i.causeRevision - 1]) throw new Error("Invalid impact reference");
    if (i.resolution) attribution(i.resolution.attribution);
  }
  if (s.events.length !== s.sequence || s.events.some((e, i) => e.sequence !== i + 1)) throw new Error("Invalid transaction sequence");
}

function expectRevision(current: SpecRecord, expected: number | undefined): void {
  if (expected !== undefined && current.revision !== expected) throw new Error(`Stale record ${current.id}: expected revision ${expected}, current is ${current.revision}. Re-read it and reconsider before retrying`);
}

export class Ledger {
  private state: SpecState;
  private fingerprint: string | undefined;
  readonly file: string;
  constructor(readonly ws: Workspace) { this.file = join(ws.root, "specification.json"); this.state = blank(); this.reload(); }
  get data(): SpecState { return clone(this.state); }
  reload(): this {
    noSymlinks(this.file);
    const bytes = existsSync(this.file) ? readFileSync(this.file, "utf8") : undefined;
    const next = bytes === undefined ? blank() : JSON.parse(bytes);
    validateState(next); this.state = next; this.fingerprint = bytes === undefined ? undefined : digest(bytes);
    return this;
  }
  list(filter: { type?: string; home?: string; query?: string; retired?: boolean } = {}): SpecRecord[] {
    return clone(current(this.state).filter(r => (filter.retired || !r.retired) && (!filter.type || r.type === filter.type) && (!filter.home || r.home === filter.home) && (!filter.query || json(r).toLowerCase().includes(filter.query.toLowerCase()))));
  }
  get(id: string, revision?: number): SpecRecord {
    const row = this.state.records.find(r => r.id === id);
    const r = revision ? row?.revisions[revision - 1] : row?.revisions.at(-1);
    if (!r) throw new Error(`Unknown record/revision ${id}@${revision ?? "current"}`);
    return clone(r);
  }
  counts() { const rows = this.list(); return { requirements: rows.filter(r => r.type === "requirement").length, questions: rows.filter(r => r.type === "question" && r.questionState !== "answered").length, entities: rows.filter(r => r.type === "entity").length, areas: rows.filter(r => r.type === "scope").length, mocked: rows.filter(r => r.status === "mocked").length }; }
  private allocate(s: SpecState, prefix: string): string { s.counters[prefix] = (s.counters[prefix] ?? 0) + 1; return `${prefix}-${String(s.counters[prefix]).padStart(3, "0")}`; }
  private transaction<T>(action: string, who: Attribution, fn: (s: SpecState, touched: string[], notes: string[]) => T): T {
    who = attribution(who);
    return locked(this.file + ".lock", () => {
      const actual = existsSync(this.file) ? digest(readFileSync(this.file)) : undefined;
      if (actual !== this.fingerprint) throw new Error("Stale specification. Reload and reconsider changes before retrying");
      const next = clone(this.state), touched: string[] = [], notes: string[] = [];
      const result = fn(next, touched, notes);
      next.sequence++;
      next.events.push({ sequence: next.sequence, action, attribution: clone(who), ids: [...new Set(touched)], notes });
      validateState(next);
      const bytes = json(next); atomicWrite(this.file, bytes);
      this.state = clone(next); this.fingerprint = digest(bytes);
      return clone(result);
    });
  }
  private impacts(s: SpecState, cause: SpecRecord, reason: string) {
    const all = current(s), reached = new Set([cause.id]), queue = [cause.id];
    while (queue.length) {
      const id = queue.shift()!;
      const source = all.find(r => r.id === id)!;
      for (const target of all) {
        if (target.retired || reached.has(target.id)) continue;
        if (referenceIds(source).includes(target.id) || referenceIds(target).includes(id)) {
          reached.add(target.id); queue.push(target.id);
        }
      }
    }
    for (const target of reached) {
      if (target === cause.id || s.impacts.some(i => i.target === target && i.cause === cause.id && i.causeRevision === cause.revision)) continue;
      s.impacts.push({ id: this.allocate(s, "REV"), target, cause: cause.id, causeRevision: cause.revision, reason });
    }
  }
  private insert(s: SpecState, input: RecordInput, who: Attribution, id?: string): SpecRecord {
    checked<RecordInput>(RecordInputSchema, input, "record input");
    if (input.questionState && !["unanswered", "deferred", "blocked"].includes(input.questionState)) throw new Error("Use answer operation");
    if (input.links?.some(l => ["supersedes", "superseded-by"].includes(l.type))) throw new Error("Use supersede operation");
    const r: SpecRecord = { ...clone(input), id: id ?? this.allocate(s, prefixes[input.type]), revision: 1,
      status: input.status ?? "assumed", priority: input.priority ?? "unknown", perspective: input.perspective ?? "intent",
      links: input.links ?? [], evidence: input.evidence ?? [], acceptance: input.acceptance ?? [],
      ...(input.type === "question" ? { questionState: input.questionState ?? "unanswered" } : {}),
      intent: "candidate", retired: false, attribution: clone(who), answers: [],
      archives: (input.evidence ?? []).map(e => archiveReference(this.ws.root, e, input.publishEvidence?.includes(e))),
    };
    s.records.push({ id: r.id, revisions: [r] });
    return r;
  }
  create(input: RecordInput, who: Attribution): SpecRecord {
    return this.transaction("create", who, (s, ids) => { const r = this.insert(s, input, who); ids.push(r.id); this.impacts(s, r, "New connected record"); return r; });
  }
  private revise(s: SpecState, id: string, patch: Patch, who: Attribution, confirm = false, expected?: number): SpecRecord {
    who = attribution(who);
    checked<Patch>(PatchSchema, patch, "record patch");
    const row = s.records.find(r => r.id === id); if (!row) throw new Error(`Unknown record ${id}`);
    const old = row.revisions.at(-1)!;
    expectRevision(old, expected);
    if (old.retired) throw new Error("Retired records cannot be edited");
    if (old.type === "decision" && Object.keys(patch).length) throw new Error("Supersede decisions instead of rewriting content");
    if (patch.links?.some(l => ["supersedes", "superseded-by"].includes(l.type))) throw new Error("Use supersede operation");
    if (patch.questionState === "answered" || patch.questionState === "partial") throw new Error("Use explicit answer operation");
    const r = { ...clone(old), ...clone(patch), revision: old.revision + 1, attribution: clone(who) };
    delete r.confirmation;
    r.intent = old.intent === "candidate" ? "candidate" : "review-needed";
    if (confirm) { r.intent = "confirmed"; r.confirmation = { ...clone(who), revision: r.revision }; }
    if (patch.evidence || patch.publishEvidence) r.archives = (r.evidence ?? []).map(e => {
      const approved = r.publishEvidence?.includes(e);
      return (approved && old.archives.find(a => a.reference === e && a.availability === "archived")) || archiveReference(this.ws.root, e, approved);
    });
    row.revisions.push(r);
    this.impacts(s, r, confirm ? "Explicit confirmation" : "Record revision changed");
    return r;
  }
  /** expected, when given, must equal the current revision the caller read. Model tools always supply it. */
  update(id: string, patch: Patch, who: Attribution, confirmation?: Attribution, expected?: number): SpecRecord {
    return this.transaction("update", who, (s, ids) => {
      const r = this.revise(s, id, patch, who, false, expected);
      if (confirmation) { attribution(confirmation); r.intent = "confirmed"; r.confirmation = { ...confirmation, revision: r.revision }; }
      ids.push(id); return r;
    });
  }
  confirm(id: string, who: Attribution, expected?: number): SpecRecord { return this.transaction("confirm", who, (s, ids) => { const r = this.revise(s, id, {}, who, true, expected); ids.push(id); return r; }); }
  retire(id: string, reason: string, who: Attribution, expected?: number): SpecRecord {
    if (!reason.trim()) throw new Error("Retirement needs a reason");
    return this.transaction("retire", who, (s, ids, notes) => {
      const r = this.revise(s, id, {}, who, false, expected); r.retired = true; ids.push(id); notes.push(reason); return r;
    });
  }
  answer(id: string, answer: Answer, patches: { id: string; patch: Patch; reason: string; confirmation?: Attribution; expectedRevision?: number }[] = [], expected?: number): SpecRecord {
    checked<Answer>(AnswerSchema, answer, "answer"); attribution(answer);
    return this.transaction("answer", answer, (s, ids, notes) => {
      const old = current(s).find(r => r.id === id); if (old?.type !== "question") throw new Error("Not a question");
      if (!answer.text.trim() || !answer.rationale.trim()) throw new Error("Answer needs text and rationale");
      if (old.answers.some(a => json(a) === json(answer))) throw new Error("Duplicate answer");
      const r = this.revise(s, id, {}, answer, false, expected);
      r.answers.push(clone(answer)); r.questionState = answer.remainingUncertainty.length ? "partial" : "answered"; delete r.deferral;
      this.impacts(s, r, "Answer affects connected records");
      for (const p of patches) {
        if (!p.reason.trim() || !answer.affectedIds.includes(p.id)) throw new Error("Each necessary patch needs a reason and an affected ID");
        if (current(s).find(r => r.id === p.id)?.type !== "requirement") throw new Error("Atomic answer patches are requirement-only");
        const changed = this.revise(s, p.id, p.patch, answer, false, p.expectedRevision);
        if (p.confirmation) { attribution(p.confirmation); changed.intent = "confirmed"; changed.confirmation = { ...p.confirmation, revision: changed.revision }; }
        ids.push(p.id); notes.push(p.reason);
      }
      ids.push(id); return r;
    });
  }
  frontier() {
    const questions = this.list({ type: "question" });
    const ready: SpecRecord[] = [], waiting: { record: SpecRecord; blockers: string[]; condition?: string }[] = [];
    for (const q of questions) {
      if (["answered", "deferred"].includes(q.questionState ?? "")) continue;
      const blockers = (q.links ?? []).filter(l => l.type === "depends-on").map(l => this.get(l.to)).filter(r => r.type === "question" ? r.questionState !== "answered" : r.intent !== "confirmed").map(r => r.id);
      // An explicit block stays until an explicit resume, even when its dependencies are satisfied.
      if (q.questionState === "blocked") waiting.push({ record: q, blockers, condition: q.deferral?.condition });
      else if (blockers.length) waiting.push({ record: q, blockers });
      else ready.push(q);
    }
    return { ready, waiting, deferred: questions.filter(q => q.questionState === "deferred") };
  }
  supersede(id: string, replacement: RecordInput, who: Attribution, expected?: number): SpecRecord {
    return this.transaction("supersede", who, (s, ids) => {
      const row = s.records.find(r => r.id === id), old = row?.revisions.at(-1);
      if (!old || old.type !== "decision" || old.retired || old.links?.some(l => l.type === "superseded-by")) throw new Error("Need a current decision");
      expectRevision(old, expected);
      if (replacement.type !== "decision") throw new Error("Replacement must be a decision");
      const next = this.insert(s, replacement, who);
      next.links!.push({ type: "supersedes", to: old.id });
      const previous = clone(old); previous.revision++; previous.attribution = clone(who); delete previous.confirmation; previous.intent = "review-needed";
      previous.links = [...(previous.links ?? []), { type: "superseded-by", to: next.id }]; row!.revisions.push(previous);
      this.impacts(s, next, `Decision supersedes ${old.id}`); ids.push(old.id, next.id); return next;
    });
  }
  resolveReview(id: string, outcome: "reviewed" | "no-change", reason: string, who: Attribution) {
    return this.transaction("review", who, (s, ids) => {
      const impact = s.impacts.find(x => x.id === id); if (!impact || impact.resolution) throw new Error("Need an open review");
      if (!reason.trim()) throw new Error("Review needs reason");
      impact.resolution = { outcome, reason, attribution: clone(who) }; ids.push(impact.target); return impact;
    });
  }
  setProject(project: SpecState["project"], who: Attribution) { return this.transaction("project", who, (s) => { s.project = { ...s.project, ...project }; return s.project; }); }
  baseline(input: BaselineInput, who: Attribution): Baseline {
    checked<BaselineInput>(BaselineInputSchema, input, "baseline");
    return this.transaction("baseline", who, (s, ids) => {
      if (!input.selection.length || s.baselines.some(b => b.name === input.name)) throw new Error("Baseline needs selections and a unique name");
      const chosen = new Map<string, Baseline["records"][number]>();
      const add = (id: string, revision?: number, role: "binding" | "supporting" = "supporting") => {
        if (chosen.has(id)) {
          if (revision && chosen.get(id)!.record.revision !== revision) throw new Error(`Conflicting baseline revisions for ${id}. Select compatible revisions or separate baselines`);
          return;
        }
        const row = s.records.find(r => r.id === id); const r = revision ? row?.revisions[revision - 1] : row?.revisions.at(-1);
        if (!r || r.retired) throw new Error(`Cannot baseline ${id}`);
        chosen.set(id, { role, record: clone(r) });
      };
      for (const pick of input.selection) { if (chosen.has(pick.id)) throw new Error("Duplicate selection"); add(pick.id, pick.revision, pick.role); }
      let changed = true;
      while (changed) {
        const before = chosen.size;
        for (const { record: r } of [...chosen.values()]) {
          for (const a of r.estimate?.appliesTo ?? []) add(a.id, a.revision);
          for (const id of referenceIds(r).filter(id => !(r.estimate?.appliesTo ?? []).some(a => a.id === id))) add(id);
          for (const incoming of current(s).filter(x => ["question", "decision"].includes(x.type) && referenceIds(x).includes(r.id))) add(incoming.id);
        }
        changed = before !== chosen.size;
      }
      const b: Baseline = { ...clone(input), id: this.allocate(s, "BL"), project: clone(s.project), attribution: clone(who), records: [...chosen.values()].sort((a, b) => a.record.id.localeCompare(b.record.id)) };
      s.baselines.push(b); ids.push(...chosen.keys()); return b;
    });
  }
  diff(id: string) {
    const b = this.state.baselines.find(b => b.id === id); if (!b) throw new Error("Unknown baseline");
    const frozen = new Map(b.records.map(x => [x.record.id, x.record]));
    const working = this.list();
    return {
      baseline: id, comparison: "Entire current working specification against baseline selection. Added may be outside baseline scope.",
      added: working.filter(r => !frozen.has(r.id)).map(r => r.id),
      removed: b.records.filter(x => !working.some(r => r.id === x.record.id)).map(x => x.record.id),
      revised: working.filter(r => frozen.has(r.id) && json(r) !== json(frozen.get(r.id))).map(r => {
        const old = frozen.get(r.id)!;
        return { id: r.id, from: old.revision, to: r.revision, fields: [...new Set([...Object.keys(old), ...Object.keys(r)])].filter(k => json((old as any)[k]) !== json((r as any)[k])).map(field => ({ field, before: (old as any)[field], after: (r as any)[field] })) };
      }),
      projectChanged: json(b.project) !== json(this.state.project),
      estimateApplicability: working.filter(r => r.estimate).map(r => ({ id: r.id, stale: r.estimate!.appliesTo.filter(a => this.get(a.id).revision !== a.revision).map(a => a.id) })),
    };
  }
  importV1(who: Attribution) {
    const path = join(this.ws.root, "ledger.json"); noSymlinks(path);
    const bytes = readFileSync(path, "utf8"), legacy = JSON.parse(bytes);
    if (legacy.version !== 1 || !Array.isArray(legacy.areas) || !Array.isArray(legacy.requirements) || !Array.isArray(legacy.entities)) throw new Error("Unsupported or malformed V1 ledger");
    return this.transaction("import-v1", who, (s, ids, notes) => {
      if (s.records.length || s.baselines.length || s.sequence) throw new Error("Legacy ledger import requires an empty specification");
      const warnings = ["Legacy observation does not confirm intent. All imported records are candidates.", "Legacy removal history is unavailable. Counters cover IDs present in the source only."];
      const scope = new Map<string, string>(), entities = new Map<string, string>();
      for (const r of legacy.requirements) {
        if (typeof r.id !== "string" || !/^[A-Z][A-Z0-9]*-\d{3,}$/.test(r.id) || typeof r.statement !== "string" || typeof r.title !== "string") throw new Error("Malformed V1 requirement");
        const [prefix, number] = r.id.split("-"); s.counters[prefix] = Math.max(s.counters[prefix] ?? 0, Number(number));
      }
      for (const a of legacy.areas) {
        if (typeof a.code !== "string" || typeof a.name !== "string") throw new Error("Malformed V1 area");
        const r = this.insert(s, { type: "scope", title: a.name, statement: a.description, notes: `Legacy area code: ${a.code}. Order: ${a.order ?? "unknown"}` }, who); scope.set(a.code, r.id);
      }
      for (const e of legacy.entities) {
        if (typeof e.name !== "string") throw new Error("Malformed V1 entity");
        const r = this.insert(s, { type: "entity", title: e.name, statement: e.description, fields: e.fields, rules: e.rules, evidence: e.evidence, status: e.status ?? "inferred", perspective: "evidence" }, who); entities.set(e.name, r.id);
      }
      const known = new Set([...legacy.requirements.map((r: any) => r.id), ...current(s).map(r => r.id)]);
      for (const r of legacy.requirements) {
        const related: string[] = r.related ?? [];
        const unresolved = related.filter(id => !known.has(id));
        warnings.push(...unresolved.map(id => `${r.id}: unresolved related ${id}`));
        if (r.area && !scope.has(r.area)) warnings.push(`${r.id}: unknown area ${r.area}, imported without scope home`);
        this.insert(s, { type: r.kind === "question" ? "question" : "requirement", kind: r.kind, title: r.title, statement: r.statement, home: scope.get(r.area), acceptance: r.acceptance, evidence: r.evidence, status: r.status ?? "assumed", priority: r.priority, notes: [r.notes, unresolved.length ? `Unresolved legacy links: ${unresolved.join(", ")}` : "", `Legacy timestamps: ${r.createdAt ?? "unknown"}, ${r.updatedAt ?? "unknown"}`].filter(Boolean).join("\n"), assumption: r.assumption || (r.kind === "question" ? "Unknown. Legacy question has no working assumption" : undefined), links: related.filter(id => known.has(id)).map(to => ({ type: "relates-to", to })) }, who, r.id);
      }
      for (const e of legacy.entities) {
        const r = current(s).find(r => r.id === entities.get(e.name))!;
        r.relations = [];
        for (const rel of e.relations ?? []) {
          if (entities.has(rel.to)) r.relations.push({ ...rel, to: entities.get(rel.to)! });
          else { warnings.push(`${r.id}: unresolved entity relation ${rel.to}`); r.notes = (r.notes ?? "") + `\nUnresolved legacy relation: ${json(rel)}`; }
        }
      }
      s.project = legacy.project ?? {};
      s.legacyImport = { hash: digest(bytes), warnings }; ids.push(...current(s).map(r => r.id)); notes.push(...warnings); return s.legacyImport;
    });
  }
}
