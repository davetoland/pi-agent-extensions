---

name: evaluate-session
description: Evaluate completed agent sessions from their traces to find wasted effort, weak delegation, instruction and skill gaps, and work that should be deterministic, then recommend routed improvements without applying them.
disable-model-invocation: true
---

# Evaluate session

Use `evaluate-session` to answer:

> How well did the agent work, what did it cost, and what should change in the instructions, skills, tooling, or environment so the next session does better?

The subject can be one session, one session and the agents it delegated to, or many sessions examined together for recurring patterns. Evaluation is retrospective and independent. It is not a continuation of the evaluated work, and it does not resume it.

## Core rules

1. **Judge from the trace, not from memory.** Evaluate recorded evidence, even when running inside the session being evaluated. Memory of intent is not evidence of behaviour.
2. **Measure deterministically, then judge.** Run the digest script before reading any trace. Do not read raw traces end to end. Drill into the locations the digest points to.
3. **Keep the evaluator's context small.** Delegate drill-down to sub-agents when the harness supports it, and have each one return confirmed or dismissed findings with references, not transcripts.
4. **Verify what delegated investigators claim.** Sub-agent verdicts are leads too. Spot-check every quantitative claim that a recommendation depends on, and keep sampled counts separate from extrapolations.
5. **Treat flags as leads, not findings.** Digest flags are heuristic. Confirm each one against the trace before reporting it, and record dismissals that change the picture.
6. **Establish outcome before judging efficiency.** A cheap session that failed was not efficient. If the outcome cannot be established, say so on every finding that depends on it.
7. **Prefer patterns over anecdotes.** One occurrence is a hypothesis. Recurrence across sessions or agents is what justifies changing standing instructions.
8. **Attribute cause before recommending change.** Separate agent judgement from instruction, skill, tooling, harness, environment, and model causes. The fix depends on the cause.
9. **Account for change over time.** Harness features, instructions, and skills change between sessions. Compare like with like, and do not blame an agent for a problem that a later change already addresses.
10. **Make every finding actionable.** State the evidence, what it cost, the cause, and where the fix belongs.
11. **Report, do not apply.** Do not edit instructions, skills, scripts, or harness configuration as part of this skill.
12. **Protect sensitive data.** Do not copy credentials, tokens, or personal data from traces into the report, even when the trace exposes them. Report the exposure itself as a finding.

## 1. Establish scope and inputs

Agree with the user, or infer from the request:
- **subject:** a single session, a named set, or a corpus, such as all sessions in a working directory since a date
- **focus:** all dimensions, or specific concerns
- **report location:** where the harness or user wants the report written

Obtain a **trace bundle**. The bundle format is defined in `references/trace-bundle.md`, resolved from this skill's directory. The bundle is the only harness-specific input:
- If the harness has supplied an exporter, a bundle path, or a harness context message, use it.
- If a bundle already exists for the requested subject, use it.
- Otherwise, explain that a harness adapter is needed to produce a bundle from this harness's session records, and stop. Do not hand-parse a harness's raw session format as a substitute unless the user explicitly asks for that.

Exclude, or label separately, the evaluator's own run, the session that commissioned the evaluation, and sessions that built or changed the evaluation tooling. Their behaviour is not representative. If the subject must include the session currently running, note that its trace is incomplete.

For change over time, collect known change points before analysis. Examples: when a harness feature was enabled, when an instruction or skill changed (use version-control history of the governing files where available), or dates the user supplies. Pass them to the digest as `--cutover`.

## 2. Run the digest

Run, from this skill's directory:

```
node scripts/digest.mjs analyse <bundleDir> --out <reportDir> [--cutover <ISO>[,<ISO>...]]
```

Read `<reportDir>/digest.md`. Do not read `digest.json` directly; query it for detail that the summary truncates.

Record the data gaps reported in the digest, such as unknown costs, inferred links, or missing context. These limit what the evaluation can claim.

Use these for orientation and drill-down:

```
node scripts/digest.mjs runs <bundleDir>
node scripts/digest.mjs show <bundleDir> <runId> [fromSeq] [toSeq] [--full]
node scripts/digest.mjs flags <bundleDir> [--type <flag>] [--tree <id>] [--run <id>] [--limit <n>]
node scripts/digest.mjs context <bundleDir> [--tree <id>]
```

If `node` is unavailable, say so and stop. Do not reimplement the digest by hand.

## 3. Establish intent and outcome

For each session tree being judged individually:
- **Intent:** the task as first requested, plus later changes the user made. Use the first human `user` events.
- **Outcome:** what the agent claimed at the end, and what the trace shows it verified.
- **External outcome**, only when a judgement depends on it, for example whether the change was merged or reverted, or whether the work item was accepted. Obtain it through the project's work-management and source-control tools when its instructions describe them. Otherwise, ask the user. If it is not available, mark the affected findings "outcome not established".

For corpus evaluations, first group trees into families of similar work, such as the same task type, workflow step, or driver. Establish outcome for a few trees per family, chosen across the time range. Report the sample size. Only do this when patterns depend on outcome.

## 4. Investigate leads

Rank digest flags and patterns by likely cost multiplied by recurrence, plus severity. Investigate the top leads first. Stop when the remaining leads are unlikely to change the recommendations.

For each lead:
- Inspect the referenced events with `show`, widening the range only as far as needed.
- Determine what actually happened, what it cost (tokens, cost, time, or human attention), and why.
- Read the governing material that the run had in context, using the paths in the manifest's `context.instructions` and `skillsAvailable`, when the cause may lie in instructions or skills.

When delegating, give each sub-agent one tree or one cluster of related flags, the bundle path, the digest subcommands, and the questions from `references/rubric.md` that apply. Require each sub-agent to return:
- the lead
- a verdict: confirmed or dismissed
- evidence references (`runId`/`seq`/`ref`)
- the sample examined, kept separate from any extrapolation
- cost
- cause
- proposed route

Remind sub-agents that the same action can appear through different tools. For example, a file may be read with a dedicated read tool or with a shell command.

If the harness has no delegation capability available to the evaluator, investigate sequentially, narrowing `show` ranges tightly. You may use a separate non-interactive agent process only when the user permits it. Record the evaluation's own cost, including delegated work, or state that it was not recorded.

## 5. Assess each dimension

Work through the dimensions in `references/rubric.md`:
1. outcome and verification
2. efficiency
3. delegation
4. instructions
5. deterministic candidates
6. skills
7. tools and environment
8. human interaction
9. safety and scope

Skip dimensions outside the agreed focus, and say that they were skipped. Do not score a dimension the evidence cannot support.

## 6. Attribute causes and route recommendations

Assign every confirmed finding one primary cause and one route:

| Cause                                                                                                | Route                                                                                               |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Missing, conflicting, duplicated, stale, or unnecessary standing instruction                         | The standing instructions (such as `AGENTS.md`), with the proposed change stated                    |
| Repeated discovery or improvisation of something that should be fixed and known in advance           | New or improved script, CLI wrapper, configuration, or provisioning, with a sketch of the interface |
| Skill gap, poor triggering, unclear procedure, unused skill, or a missing skill the agent reinvented | Skill amendment, addition, or removal, with the proposed description or section change              |
| Harness behaviour or missing harness capability                                                      | Harness or extension change                                                                         |
| Model or reasoning-level choice                                                                      | Configuration recommendation                                                                        |
| Environment failure such as flaky services, permissions, or missing tools                            | Environment fix                                                                                     |
| Agent judgement where the guidance was adequate                                                      | Note only. Do not add instructions to correct a one-off lapse.                                      |
| Acceptable cost                                                                                      | No action                                                                                           |

Before recommending a new instruction, check whether an existing instruction already covers the issue and was ignored. If it was, the fix may be to make that instruction clearer or easier to find, not to add more text.

Before recommending a new skill or script, check whether one already exists. Reinvention is itself a finding about discoverability.

## 7. Write the report

Write `<reportDir>/report.md`, keeping the digest files beside it. Structure:
1. **Summary:** subject, scope, overall judgement, and the three to five recommendations with the highest expected value, by ID.
2. **Subject and data quality:** sessions covered, exclusions, harness and adapter, data gaps that limit conclusions, and the evaluation's own cost.
3. **Outcome:** per tree, or sampled by family for a corpus, with sample sizes.
4. **Findings by dimension:** each with an ID (`F1`, `F2`, …), evidence references, cost, cause, confidence, and recurrence.
5. **Recommendations:** each with an ID (`R1`, `R2`, …), grouped by route and ordered by expected value. Each states the concrete change and references the findings it addresses by ID instead of restating them.
6. **Dismissed leads:** only those that would otherwise mislead a reader, including digest flags with high false-positive rates.
7. **Not assessed:** dimensions or questions skipped, and why.

Write the report plainly and concisely: lead with the findings, and give each one its evidence.

## Stop condition

Stop when the report is written and every recommendation traces back to at least one confirmed finding. Do not keep investigating low-cost leads to make the report look thorough.

## Mutation boundary

This skill writes only the digest and report files. Changes to standing instructions, skills, scripts, harness extensions, and environment go to their owners under the user's authorised workflow.

Recommend the next step without starting it. Use the project's workflow where its instructions define one. Otherwise, ask the user for the next step. Do not guess it. When this skill runs inside another workflow, return the result to that workflow instead.
