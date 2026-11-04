import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";

const S = () => Type.String({ minLength: 1 });
const Strings = () => Type.Array(Type.String());
export const enumOf = <T extends string>(values: readonly T[]) => Type.Enum([...values]);
const Obj = <T extends Parameters<typeof Type.Object>[0]>(properties: T) => Type.Object(properties, { additionalProperties: false });
export const TYPES = ["requirement", "question", "decision", "scope", "goal", "persona", "journey", "screen", "component", "interface", "entity", "work-package", "constraint"] as const;
export const LINK_TYPES = ["contains", "informed-by", "depends-on", "appears-in", "fulfilled-by", "uses", "relates-to", "supersedes", "superseded-by"] as const;
export const KINDS = ["functional", "ui", "data", "integration", "auth", "business-rule", "nfr", "question"] as const;
export const STATUSES = ["observed", "inferred", "mocked", "assumed"] as const;
export const PRIORITIES = ["must", "should", "could", "wont", "unknown"] as const;
export const AttributionSchema = Obj({ contributor: S(), date: S(), source: S() });
export const LinkSchema = Obj({ type: enumOf(LINK_TYPES), to: S(), rationale: Type.Optional(Type.String()) });
export const FieldSchema = Obj({ name: S(), type: S(), required: Type.Optional(Type.Boolean()), notes: Type.Optional(Type.String()) });
export const RelationSchema = Obj({ to: S(), kind: enumOf(["one-to-one", "one-to-many", "many-to-one", "many-to-many"]), via: Type.Optional(Type.String()), notes: Type.Optional(Type.String()) });
export const EstimateSchema = Obj({
  unit: S(), low: Type.Number({ minimum: 0 }), high: Type.Number({ minimum: 0 }), basis: S(),
  assumptions: Strings(), exclusions: Strings(), appliesTo: Type.Array(Obj({ id: S(), revision: Type.Integer({ minimum: 1 }) })),
});
export const AnswerSchema = Obj({ ...AttributionSchema.properties, text: S(), rationale: S(), remainingUncertainty: Strings(), affectedIds: Strings() });
export const DeferralSchema = Obj({ reason: S(), condition: S() });
export const RecordInputSchema = Obj({
  type: enumOf(TYPES), title: S(), statement: Type.Optional(Type.String()), home: Type.Optional(S()),
  perspective: Type.Optional(enumOf(["evidence", "intent", "solution"])),
  rationale: Type.Optional(Type.String()), notes: Type.Optional(Type.String()), assumption: Type.Optional(Type.String()),
  links: Type.Optional(Type.Array(LinkSchema)), evidence: Type.Optional(Strings()),
  publishEvidence: Type.Optional(Strings()),
  status: Type.Optional(enumOf(STATUSES)), priority: Type.Optional(enumOf(PRIORITIES)), kind: Type.Optional(enumOf(KINDS)),
  acceptance: Type.Optional(Strings()),
  questionState: Type.Optional(enumOf(["unanswered", "partial", "answered", "deferred", "blocked"])),
  deferral: Type.Optional(DeferralSchema), options: Type.Optional(Strings()),
  alternatives: Type.Optional(Strings()), consequences: Type.Optional(Strings()),
  fields: Type.Optional(Type.Array(FieldSchema)), relations: Type.Optional(Type.Array(RelationSchema)), rules: Type.Optional(Strings()),
  route: Type.Optional(Type.String()), representation: Type.Optional(enumOf(["screenshot", "wireframe", "observed-api", "proposed-contract", "description"])),
  contract: Type.Optional(Type.String()), steps: Type.Optional(Strings()), responsibilities: Type.Optional(Strings()),
  exclusions: Type.Optional(Strings()), successMeasures: Type.Optional(Strings()), estimate: Type.Optional(EstimateSchema),
});
export const PatchSchema = Type.Partial(Type.Omit(RecordInputSchema, ["type"]), { additionalProperties: false });
export const ArchiveSchema = Obj({ reference: S(), availability: enumOf(["archived", "external", "unavailable"]), hash: Type.Optional(S()), extension: Type.Optional(S()), reason: Type.Optional(S()) });
export const RevisionSchema = Obj({
  ...RecordInputSchema.properties, id: S(), revision: Type.Integer({ minimum: 1 }),
  intent: enumOf(["candidate", "confirmed", "review-needed"]), retired: Type.Boolean(),
  attribution: AttributionSchema, confirmation: Type.Optional(Obj({ ...AttributionSchema.properties, revision: Type.Integer({ minimum: 1 }) })),
  answers: Type.Array(AnswerSchema), archives: Type.Array(ArchiveSchema),
});
export const ProjectSchema = Obj({ name: Type.Optional(Type.String()), summary: Type.Optional(Type.String()), users: Type.Optional(Strings()), goals: Type.Optional(Strings()) });
export const BaselineInputSchema = Obj({
  name: S(), purpose: S(), state: enumOf(["draft", "estimating", "approved"]),
  selection: Type.Array(Obj({ id: S(), revision: Type.Optional(Type.Integer({ minimum: 1 })), role: enumOf(["binding", "supporting"]) })), 
  approvers: Type.Array(Obj({ ...AttributionSchema.properties, authority: S() })),
  acceptanceArrangements: S(), responsibilities: Strings(), dependencies: Strings(), exclusions: Strings(), assumptions: Strings(),
});
export const BaselineSchema = Obj({ ...BaselineInputSchema.properties, id: S(), project: ProjectSchema,
  records: Type.Array(Obj({ role: enumOf(["binding", "supporting"]), record: RevisionSchema })), attribution: AttributionSchema,
});
export const ImpactSchema = Obj({ id: S(), target: S(), cause: S(), causeRevision: Type.Integer({ minimum: 1 }), reason: S(),
  resolution: Type.Optional(Obj({ outcome: enumOf(["reviewed", "no-change"]), reason: S(), attribution: AttributionSchema })),
});
export const StateSchema = Obj({ schemaVersion: Type.Literal(2), sequence: Type.Integer({ minimum: 0 }),
  counters: Type.Record(Type.String(), Type.Integer({ minimum: 0 })), project: ProjectSchema,
  records: Type.Array(Obj({ id: S(), revisions: Type.Array(RevisionSchema, { minItems: 1 }) })),
  baselines: Type.Array(BaselineSchema), impacts: Type.Array(ImpactSchema),
  events: Type.Array(Obj({ sequence: Type.Integer({ minimum: 1 }), action: S(), attribution: AttributionSchema, ids: Strings(), notes: Strings() })),
  legacyImport: Type.Optional(Obj({ hash: S(), warnings: Strings() })),
});
export type Attribution = Static<typeof AttributionSchema>;
export type RecordInput = Static<typeof RecordInputSchema>;
export type Patch = Static<typeof PatchSchema>;
export type SpecRecord = Static<typeof RevisionSchema>;
export type SpecState = Static<typeof StateSchema>;
export type Answer = Static<typeof AnswerSchema>;
export type BaselineInput = Static<typeof BaselineInputSchema>;
export type Baseline = Static<typeof BaselineSchema>;
export type Archive = Static<typeof ArchiveSchema>;
export function checked<T>(schema: TSchema, value: unknown, label: string): asserts value is T {
  if (!Check(schema, value)) throw new Error(`Malformed ${label}. Check the documented fields and types.`);
}
export function attribution(a: Attribution): Attribution {
  const value = { contributor: a?.contributor, date: a?.date, source: a?.source };
  checked<Attribution>(AttributionSchema, value, "attribution");
  if (![value.contributor, value.source].every(x => x.trim()) || !/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(value.date) || !Number.isFinite(Date.parse(value.date))) throw new Error("Attribution needs contributor, valid date, and source");
  return value;
}
