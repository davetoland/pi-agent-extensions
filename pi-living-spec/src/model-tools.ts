import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Ledger } from "./ledger.js";
import { exportAll } from "./export.js";
import { Workspace } from "./workspace.js";
import { AnswerSchema, AttributionSchema, BaselineInputSchema, PatchSchema, ProjectSchema, RecordInputSchema, enumOf, type Attribution, type RecordInput } from "./schema.js";
import { clip } from "./text.js";
const optString = () => Type.Optional(Type.String());
const expectedRevision = () => Type.Optional(Type.Integer({ minimum: 1, description: "Current revision you last read. Required for stale-sensitive changes. A mismatch is rejected without writing." }));
function expected(p: { expectedRevision?: number }, action: string): number {
  if (p.expectedRevision === undefined) throw new Error(`${action} needs expectedRevision: the current revision you last read`);
  return p.expectedRevision;
}
const who = (): Attribution => ({ contributor: "spec agent", date: new Date().toISOString(), source: "extraction tool call, not client confirmation" });
export function registerModelTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "spec_record", label: "Specification record", executionMode: "sequential",
    description: "Read or revise the specification. create uses record. update uses id and patch. update, confirm and retire require expectedRevision, the current revision you last read, and reject the change if the record has moved on. confirm requires explicit attribution from the confirming person. retire requires reason. get supports revision. list supports type/home/query/retired. project uses project. New intent is candidate and evidence assumed. Decisions must be superseded, not edited. publishEvidence is an explicit user-approved list of evidence references safe to distribute, never inferred from capture availability. Output truncated at 40KB, authoritative full state is .living-spec/specification.json.",
    promptSnippet: "Read and write typed, connected specification records with immutable revisions",
    promptGuidelines: ["Use spec_record to persist findings immediately. New prototype evidence must not rewrite confirmed requirements. Add a record with perspective evidence, evidence citations and typed links instead.", "Use spec_record confirm only for explicit attributed confirmation of the current record. A solution is never automatically confirmed by requirement approval."],
    parameters: Type.Object({ action: enumOf(["create", "update", "confirm", "retire", "get", "list", "project"]), id: optString(), revision: Type.Optional(Type.Integer({ minimum: 1 })), expectedRevision: expectedRevision(), record: Type.Optional(RecordInputSchema), patch: Type.Optional(PatchSchema), attribution: Type.Optional(AttributionSchema), confirmation: Type.Optional(AttributionSchema), reason: optString(), type: optString(), home: optString(), query: optString(), retired: Type.Optional(Type.Boolean()), project: Type.Optional(ProjectSchema) }, { additionalProperties: false }),
    async execute(_id, p, _signal, _update, ctx) {
      const l = new Ledger(new Workspace(ctx.cwd)); let result: unknown;
      switch (p.action) {
        case "create": if (!p.record) throw new Error("create needs record"); result = l.create(p.record, p.attribution ?? who()); break;
        case "update": if (!p.id || !p.patch) throw new Error("update needs id and patch"); result = l.update(p.id, p.patch, p.attribution ?? who(), p.confirmation, expected(p, "update")); break;
        case "confirm": if (!p.id || !p.attribution) throw new Error("confirm needs id and explicit contributor/date/source"); result = l.confirm(p.id, p.attribution, expected(p, "confirm")); break;
        case "retire": if (!p.id || !p.reason) throw new Error("retire needs id/reason"); result = l.retire(p.id, p.reason, p.attribution ?? who(), expected(p, "retire")); break;
        case "get": if (!p.id) throw new Error("get needs id"); result = l.get(p.id, p.revision); break;
        case "list": result = l.list(p); break;
        case "project": if (!p.project) throw new Error("project needs project"); result = l.setProject(p.project, p.attribution ?? who()); break;
      }
      return output(result);
    },
  });
  pi.registerTool({
    name: "spec_clarify", label: "Persistent clarification", executionMode: "sequential",
    description: "frontier returns ready/waiting/deferred persistent questions. answer appends an attributed answer with rationale and uncertainty, atomically applying only explicit/necessary requirement patches. Each patch needs reason and affectedIds membership. defer needs reason and condition. resume explicitly returns a deferred/blocked question to unanswered. A blocked question stays waiting until resumed, even when its dependencies are answered. answer, defer and resume need the question expectedRevision. Each patch needs the target expectedRevision. Stale revisions are rejected without writing. No crawl needed. Answered questions are not automatically reasked.",
    parameters: Type.Object({ action: enumOf(["frontier", "answer", "defer", "resume"]), id: optString(), answer: Type.Optional(AnswerSchema), patches: Type.Optional(Type.Array(Type.Object({ id: Type.String(), patch: PatchSchema, reason: Type.String(), confirmation: Type.Optional(AttributionSchema), expectedRevision: Type.Integer({ minimum: 1 }) }, { additionalProperties: false }))), expectedRevision: expectedRevision(), reason: optString(), condition: optString(), attribution: Type.Optional(AttributionSchema), blocked: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
    async execute(_id, p, _signal, _update, ctx) {
      const l = new Ledger(new Workspace(ctx.cwd));
      if (p.action === "frontier") return output(l.frontier());
      if (!p.id) throw new Error("Question id required");
      if (l.get(p.id).type !== "question") throw new Error("Not a question");
      if (p.action === "answer") { if (!p.answer) throw new Error("Answer required"); for (const x of p.patches ?? []) expected(x, `Patch ${x.id}`); return output(l.answer(p.id, p.answer, p.patches, expected(p, "answer"))); }
      if (p.action === "defer") { if (!p.reason || !p.condition) throw new Error("Deferral needs reason and condition"); return output(l.update(p.id, { questionState: p.blocked ? "blocked" : "deferred", deferral: { reason: p.reason, condition: p.condition } }, p.attribution ?? who(), undefined, expected(p, "defer"))); }
      return output(l.update(p.id, { questionState: "unanswered" }, p.attribution ?? who(), undefined, expected(p, "resume")));
    },
  });
  pi.registerTool({
    name: "spec_decision", label: "Consequential decision", executionMode: "sequential",
    description: "Create a consequential decision with statement, alternatives, rationale, consequences, and typed links. supersede needs expectedRevision of the current decision and creates a new decision ID and preserves the old content with bidirectional links. Ordinary requirement confirmation uses spec_record confirm, not a decision. Decisions do not change requirements. Persist necessary requirement consequences afterwards through spec_record update with the requirement expectedRevision. These are separate writes.",
    parameters: Type.Object({ action: enumOf(["create", "supersede"]), id: optString(), expectedRevision: expectedRevision(), record: RecordInputSchema, attribution: AttributionSchema }, { additionalProperties: false }),
    async execute(_id, p, _signal, _update, ctx) { const l = new Ledger(new Workspace(ctx.cwd)); if (p.record.type !== "decision") throw new Error("record.type must be decision"); if (p.action === "supersede" && !p.id) throw new Error("supersede needs id"); return output(p.action === "create" ? l.create(p.record, p.attribution) : l.supersede(p.id!, p.record, p.attribution, expected(p, "supersede"))); },
  });
  pi.registerTool({
    name: "spec_baseline", label: "Fixed baseline", executionMode: "sequential",
    description: "create freezes exact selected revisions and linked supporting context. Selection assigns binding/supporting roles. draft and estimating allow unresolved assumptions. approved requires named approvers with authority/date/source, supplied by the user, never invented. No automatic commercial readiness claim. get/list read fixed snapshots. diff compares entire current specification with selection and reports changed fields and stale estimate applicability.",
    parameters: Type.Object({ action: enumOf(["create", "get", "list", "diff"]), id: optString(), baseline: Type.Optional(BaselineInputSchema), attribution: Type.Optional(AttributionSchema) }, { additionalProperties: false }),
    async execute(_id, p, _signal, _update, ctx) { const l = new Ledger(new Workspace(ctx.cwd)); if (p.action === "create") { if (!p.baseline || !p.attribution) throw new Error("baseline and attribution required"); return output(l.baseline(p.baseline, p.attribution)); } if (p.action === "diff") { if (!p.id) throw new Error("id required"); return output(l.diff(p.id)); } if (p.action === "get") { const b = l.data.baselines.find(b => b.id === p.id); if (!b) throw new Error("Unknown baseline"); return output(b); } return output(l.data.baselines.map(b => ({ id: b.id, name: b.name, state: b.state, purpose: b.purpose }))); },
  });
  pi.registerTool({
    name: "spec_review", label: "Connected change review", executionMode: "sequential",
    description: "list review-needed impacts with cause revision. resolve records reviewed/no-change with reason and contributor attribution. Resolving an impact does not confirm or rewrite the target record.",
    parameters: Type.Object({ action: enumOf(["list", "resolve"]), id: optString(), outcome: Type.Optional(enumOf(["reviewed", "no-change"])), reason: optString(), attribution: Type.Optional(AttributionSchema), includeResolved: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
    async execute(_id, p, _signal, _update, ctx) { const l = new Ledger(new Workspace(ctx.cwd)); if (p.action === "list") return output(l.data.impacts.filter(i => p.includeResolved || !i.resolution)); if (!p.id || !p.outcome || !p.reason || !p.attribution) throw new Error("resolve needs id/outcome/reason/attribution"); return output(l.resolveReview(p.id, p.outcome, p.reason, p.attribution)); },
  });
  pi.registerTool({
    name: "spec_import_v1", label: "Opt-in V1 import", executionMode: "sequential",
    description: "Explicit opt-in only. Import .living-spec/ledger.json into an empty .living-spec/specification.json. Preserve legacy IDs, evidence, notes, entities and source bytes. All intent remains candidate. Returns unresolved links and migration uncertainties. Never automatically migrates or rewrites the legacy ledger.",
    parameters: Type.Object({ optIn: Type.Literal(true), attribution: AttributionSchema }, { additionalProperties: false }),
    async execute(_id, p, _signal, _update, ctx) { if (p.optIn !== true) throw new Error("Explicit opt-in required"); return output(new Ledger(new Workspace(ctx.cwd)).importV1(p.attribution)); },
  });
  pi.registerTool({
    name: "spec_export", label: "Publish specification", executionMode: "sequential",
    description: "Deterministic portable Markdown index and definitive area-level requirements, linked context and fixed baselines. Default directory .living-spec/specification. CSV is requirements-only. JSON is complete specification state including questions and history. Refuses unowned/human-edited output or symlinks. Only individually publishEvidence-approved allowlisted captures are packaged. Reports unavailable links. path is an output directory, not a Markdown filename.",
    parameters: Type.Object({ formats: Type.Optional(Type.Array(enumOf(["md", "csv", "json"]))), path: optString() }, { additionalProperties: false }),
    async execute(_id, p, _signal, _update, ctx) { const ws = new Workspace(ctx.cwd); return output({ files: exportAll(ws, new Ledger(ws).data, undefined, p.formats, p.path) }); },
  });
  // Compatibility names deliberately share the spec_record fields rather than accepting ambiguous legacy updates.
  for (const [name, type] of [["spec_requirement", "requirement"], ["spec_entity", "entity"]] as const) {
    pi.registerTool({ name, label: type === "entity" ? "Entity adapter" : "Requirement adapter", executionMode: "sequential",
      description: `Compatibility name. create uses typed record with type=${type}${type === "requirement" ? " or question" : ""}. list/get/update/retire work by stable ID. update and retire need expectedRevision, the current revision you last read. Legacy area names, name-based merges, and physical removal are replaced by scope home IDs and explicit patches. Use spec_record for full operations.`,
      parameters: Type.Object({ action: enumOf(["create", "list", "get", "update", "retire"]), id: optString(), record: Type.Optional(RecordInputSchema), patch: Type.Optional(PatchSchema), expectedRevision: expectedRevision(), reason: optString(), attribution: Type.Optional(AttributionSchema) }, { additionalProperties: false }),
      async execute(_id, p, _signal, _update, ctx) {
        const l = new Ledger(new Workspace(ctx.cwd));
        const accepts = (r: { type: RecordInput["type"] }) => r.type === type || (type === "requirement" && r.type === "question");
        if (p.action === "list") return output(l.list().filter(accepts));
        if (p.action === "create") { if (!p.record || !accepts(p.record)) throw new Error(`Expected ${type} record`); return output(l.create(p.record, p.attribution ?? who())); }
        if (!p.id || !accepts(l.get(p.id))) throw new Error(`Expected ${type} id`);
        if (p.action === "get") return output(l.get(p.id));
        if (p.action === "retire") { if (!p.reason) throw new Error("Reason required"); return output(l.retire(p.id, p.reason, p.attribution ?? who(), expected(p, "retire"))); }
        if (!p.patch) throw new Error("Patch required"); return output(l.update(p.id, p.patch, p.attribution ?? who(), undefined, expected(p, "update")));
      },
    });
  }
}
function output(result: unknown) { return { content: [{ type: "text" as const, text: clip(JSON.stringify(result, null, 2), { savedAt: ".living-spec/specification.json" }) }], details: undefined }; }
