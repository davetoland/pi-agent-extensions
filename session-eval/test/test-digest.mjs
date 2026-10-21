// Run from the repository root: node --test session-eval/test/test-digest.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyseBundle, renderMd, commandShape, commandSegments, findLoops, selectFlags, DEFAULTS } from '../evaluate-session/scripts/digest.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, '..', 'evaluate-session', 'scripts', 'digest.mjs');
const bundle = path.join(here, 'fixtures', 'minimal');
const cfgFile = path.join(here, 'fixtures', 'minimal.config.json');
const cfg = { ...structuredClone(DEFAULTS), ...JSON.parse(fs.readFileSync(cfgFile, 'utf8')) };
const run = (...args) => execFileSync(process.execPath, [script, ...args], { encoding: 'utf8' });

const ALL_TYPES = [
  'repeated_call', 'repeated_read', 'edit_churn', 'error_then_same_call', 'error_streak', 'loop', 'loop_name_only',
  'large_output', 'discovery', 'user_correction', 'model_error', 'retry', 'context_reset', 'idle_gap', 'slow_tool',
  'context_pressure', 'unbacked_claim', 'risky_command', 'delegation_unlinked', 'parent_rereads_child_files',
  'parent_heavy_io', 'skill_reloaded', 'skill_blocked', 'user_abort',
];

const d = await analyseBundle(bundle, cfg);
const of = (type, runId) => d.flags.filter((f) => f.type === type && (!runId || f.runId === runId));

test('every flag type fires on the fixture', () => {
  const seen = new Set(d.flags.map((f) => f.type));
  for (const t of ALL_TYPES) assert.ok(seen.has(t), `missing flag ${t}`);
});

test('every flag carries location refs', () => {
  for (const f of d.flags) {
    assert.ok(['low', 'med', 'high'].includes(f.severity), f.id);
    assert.ok(f.refs.length >= 1, `${f.id} has no refs`);
    for (const r of f.refs) {
      assert.equal(typeof r.runId, 'string');
      assert.equal(typeof r.seq, 'number');
      assert.ok('ref' in r);
    }
  }
});

test('specific flag semantics', () => {
  assert.equal(of('repeated_read', 'c-root')[0].path, '/w3/README.md'); // relative path resolved against cwd
  assert.equal(of('repeated_read', 'c-root')[0].redundant, 2);
  assert.equal(of('unbacked_claim').length, 1);
  assert.equal(of('unbacked_claim')[0].runId, 'a-child'); // b-root ran npm test; c-root ran a validator; c-child has a caveat
  assert.equal(of('unbacked_claim')[0].severity, 'low');
  assert.equal(of('error_streak', 'b-root')[0].count, 3);
  assert.equal(of('loop', 'b-root')[0].reps, 3);
  assert.equal(of('slow_tool', 'a-root').length, 0); // foreground delegation wait is not a slow tool
  assert.deepEqual(of('user_correction').map((f) => f.kind).sort(), ['rewind', 'text_heuristic']);
  assert.equal(of('user_abort', 'a-root').length, 1);
  assert.ok(of('discovery').every((f) => f.heuristic));
  assert.ok(of('risky_command', 'b-root')[0].patterns.includes('git-reset-hard'));
  assert.equal(of('risky_command', 'b-root')[0].severity, 'high');
  assert.deepEqual(of('parent_rereads_child_files')[0].paths, ['/w/docs/spec.md']);
});

test('false-positive reductions', () => {
  // chunked offset/limit reads and re-reads after an edit are not repeated reads
  assert.equal(of('repeated_read', 'a-root').length, 0);
  assert.ok(!of('repeated_read', 'c-root').some((f) => f.path === '/w3/src/big.js'));
  // origin command/parent and agent-like "Orchestrator:" messages are not user corrections
  assert.equal(of('user_correction', 'c-root').length, 0);
  // discovery: setup probes count, routine CRUD does not
  const disc = of('discovery', 'c-root').map((f) => f.shape);
  assert.deepEqual(disc, ['az devops configure']);
  assert.deepEqual(of('discovery', 'c-root')[0].kinds, ['setup']);
  // risky: flags like --delete-source-branch, quoted prose and heredoc bodies do not match; /tmp deletes are low
  const risky = of('risky_command', 'c-root');
  assert.equal(risky.length, 1);
  assert.equal(risky[0].severity, 'low');
  assert.equal(risky[0].scope, 'scratch');
  // parent re-read of a file it then edits is discounted
  assert.equal(of('parent_rereads_child_files', 'c-root').length, 0);
  // error shapes skip set/mkdir and use exitCode
  const err = d.crossSession.shellShapes.topErroring.map((x) => x.shape);
  assert.ok(err.includes('foo-cli run --all'));
  assert.ok(!err.some((x) => /^(set|mkdir)/.test(x)));
  assert.deepEqual(d.crossSession.shellShapes.topErroring.find((x) => x.shape === 'foo-cli run --all').exitCodes, { 2: 1 });
});

test('impact and top leads', () => {
  for (const f of d.flags) assert.ok(f.impact && 'chars' in f.impact && 'estCost' in f.impact, f.id);
  const lo = of('large_output', 'b-root').find((f) => f.outputChars === 190000);
  assert.equal(lo.impact.chars, 190000);
  assert.ok(lo.impact.carriedTokens > 0);
  assert.equal(of('user_correction').find((f) => f.kind === 'rewind').impact.cost, 0.02);
  const q = d.leads.quantified;
  assert.ok(q.length > 0);
  for (let i = 1; i < q.length; i++) assert.ok(q[i - 1].estCost >= q[i].estCost);
  assert.equal(q[0].type, 'large_output');
  assert.equal(q.filter((x) => x.type === 'large_output' && x.target.startsWith('shell/log | bash: cat')).length, 1); // grouped
});

test('context spent by source', () => {
  const c = d.contextBySource;
  assert.equal(c.rows.reduce((a, r) => a + r.chars, 0), c.totalChars);
  const row = (k) => c.rows.find((r) => r.category === k);
  assert.equal(row('skill:review-changes').chars, 2500); // shell load reported by adapter
  assert.ok(row('skill:tdd').chars >= 6000); // read + shell cat of SKILL.md
  assert.equal(row('delegation').byKind.subagent ?? 0, 0);
  assert.ok(row('docs').byKind.subagent > 0 && row('docs').byKind.primary > 0);
  assert.ok(row('search'));
  const t = d.trees.find((x) => x.rootId === 'c-root');
  assert.ok(t.context.groups.some((g) => g.group === 'skill files'));
});

test('skills, delegation results, labels, cohorts, data quality', () => {
  const tdd = d.crossSession.skills.usage.find((x) => x.skill === 'tdd');
  assert.equal(tdd.via.shell, 1);
  assert.equal(tdd.inferredLoads, 1);
  assert.equal(d.crossSession.skills.usage.find((x) => x.skill === 'review-changes').via.shell, 1);
  const bg = d.delegations.filter((x) => x.mode === 'background');
  assert.deepEqual(bg.map((x) => x.resultChars).sort(), [5000, null].sort());
  assert.equal(bg.find((x) => x.runId === 'a-root').launchAckChars, 60);
  assert.equal(d.trees.find((x) => x.rootId === 'c-root').firstMessage, 'Tidy the config loader and add validation');
  assert.equal(d.crossSession.cohorts.time, null);
  assert.deepEqual(d.crossSession.cohorts.instructions.map((x) => x.key).sort(), ['(no hashes)', 'AGENTS.md@12345678']);
  assert.deepEqual(d.dataQuality.selection, { scanned: 5, selected: 4, excluded: 1 });
  assert.ok(d.dataQuality.zeroCounts.includes('instruction_load'));
  assert.ok(d.dataQuality.shellExitCodeNull < d.dataQuality.shellResults);
});

test('cutover cohorts', async () => {
  const d2 = await analyseBundle(bundle, { ...cfg, cutovers: ['2026-09-02T00:00:00Z', '2026-09-03T00:00:00Z'] });
  assert.deepEqual(d2.crossSession.cohorts.time.map((x) => [x.key, x.trees]), [['2026-09-02T00:00 – 2026-09-03T00:00', 1], ['< 2026-09-02T00:00', 1], ['≥ 2026-09-03T00:00', 1]]);
});

test('metrics', () => {
  const a = d.runs.find((r) => r.id === 'a-root').metrics;
  assert.equal(a.turns, 4); // abandoned assistant turn excluded
  assert.equal(a.assistantTurnsAll, 5);
  assert.equal(a.errors.failures, 0); // harness_policy is not a failure
  assert.equal(a.errors.byClass.harness_policy, 1);
  assert.equal(a.usage.cost, 0.11);
  assert.equal(a.usageActive.cost, 0.09);
  assert.equal(a.abandonedCostShare, Math.round((0.02 / 0.11) * 1e4) / 1e4);
  const u = a.usage;
  assert.equal(a.cacheHitRatio, Math.round((u.cacheRead / (u.input + u.cacheRead + u.cacheWrite)) * 1e4) / 1e4);
  const b = d.runs.find((r) => r.id === 'b-root').metrics;
  assert.equal(b.contextTokens.peak, 171000);
  assert.equal(b.errors.failures, 3);
  const ta = d.trees.find((t) => t.rootId === 'a-root');
  assert.equal(ta.usage.cost, 0.16); // includes child
  assert.equal(ta.childCostShare, Math.round((0.05 / 0.16) * 1e4) / 1e4);
});

test('cross-session sections', () => {
  assert.deepEqual(d.crossSession.shellShapes.crystallisation.map((x) => x.shape), ['git status']);
  assert.deepEqual(d.crossSession.shellShapes.primitivesHidden, ['cat <path>']);
  assert.ok(d.crossSession.skills.neverLoaded.length === 0 || !d.crossSession.skills.neverLoaded.some((x) => x.skill === 'tdd'));
  assert.ok(d.crossSession.cohorts.features.every((c) => c.insufficient));
  assert.equal(d.crossSession.delegation.unlinked, 1);
  assert.ok(d.dataGaps.counters.runs_context_skillsAvailable_null >= 1);
});

test('helpers', () => {
  assert.equal(commandShape('cd /repo && dotnet test src/Foo.Tests/Foo.Tests.csproj --no-build'), 'dotnet test <path>');
  assert.equal(commandShape('FOO=1 git log -n 20 "x y"'), 'git log -n');
  assert.equal(commandShape('/usr/bin/grep -rn "needle" ./src | head'), 'grep -rn <str>');
  assert.equal(commandShape('set -euo pipefail\nmkdir -p out\naz repos pr show --id 3'), 'az repos pr');
  assert.equal(commandShape('mkdir -p /tmp/x'), 'mkdir -p <path>');
  assert.deepEqual(commandSegments("cat <<'EOF'\nrm -rf /\nEOF\necho 'a; b'"), ['cat << <str>', 'echo <str>']);
  assert.deepEqual(findLoops(['a', 'b', 'a', 'b', 'a', 'b', 'c'], 1, 4, 3, false), [{ start: 0, end: 5, L: 2, reps: 3 }]);
  assert.deepEqual(findLoops(['a', 'a', 'a', 'a'], 1, 4, 3, false), [{ start: 0, end: 3, L: 1, reps: 4 }]);
});

test('CLI analyse is deterministic and md is bounded', () => {
  const o1 = fs.mkdtempSync(path.join(os.tmpdir(), 'dg1-'));
  const o2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dg2-'));
  const line = run('analyse', bundle, '--out', o1, '--config', cfgFile);
  assert.match(line, /^digest: 3 trees, 5 runs/);
  run('analyse', bundle, '--out', o2, '--config', cfgFile);
  for (const f of ['digest.json', 'digest.md']) assert.equal(fs.readFileSync(path.join(o1, f), 'utf8'), fs.readFileSync(path.join(o2, f), 'utf8'), f);
  const md = fs.readFileSync(path.join(o1, 'digest.md'), 'utf8');
  assert.ok(md.split('\n').length <= 400);
  for (const h of ['Overview', 'Context spent by source', 'Top leads', 'Per-tree table', 'Top flags', 'Cross-session patterns', 'Crystallisation candidates', 'Skills', 'Delegation', 'Cohorts', 'Data quality', 'Data gaps']) assert.ok(md.includes(`## ${h}\n`), h);
  assert.ok(md.indexOf('## Context spent by source') < md.indexOf('## Per-tree table'));
  assert.match(md, /By instruction content hashes:/);
  const d1 = structuredClone(d); d1.crossSession.cohorts.features = d1.crossSession.cohorts.features.slice(0, 1);
  assert.match(renderMd(d1), /By harnessFeatures \(union over tree\): one cohort only/);
  assert.match(md, /scanned 5, selected 4, excluded 1/);
  assert.equal(renderMd(d).trimEnd(), md.trimEnd());
  // cutover via CLI
  const o3 = fs.mkdtempSync(path.join(os.tmpdir(), 'dg3-'));
  run('analyse', bundle, '--out', o3, '--config', cfgFile, '--cutover', '2026-09-02T00:00:00Z');
  assert.match(fs.readFileSync(path.join(o3, 'digest.md'), 'utf8'), /By time \(--cutover\):/);
  // flags and context subcommands, reading digest.json from --out
  const fl = run('flags', bundle, '--out', o1, '--type', 'risky_command').trim().split('\n');
  assert.equal(fl.length, 3);
  assert.match(fl[0], /^F\d{4} \[(high|low)\] risky_command: .* \| impact .* \| [a-z-]+#\d+/);
  assert.match(fl.at(-1), /^\(2 of 2 matching flags\)$/);
  const ft = run('flags', bundle, '--tree', 'c-', '--limit', '2').trim().split('\n');
  assert.equal(ft.length, 3);
  assert.ok(ft.slice(0, 2).every((l) => / c-(root|child)#/.test(l)));
  const cx = run('context', bundle, '--tree', 'c-root').trim().split('\n');
  assert.match(cx[0], /^tree c-root /);
  assert.ok(cx.some((l) => l.startsWith('skill:review-changes')));
  assert.match(run('context', bundle, '--config', cfgFile), /^corpus: /);
});

test('selectFlags', () => {
  const s = selectFlags(d.flags, { type: 'large_output,discovery', limit: 1 });
  assert.equal(s.shown.length, 1);
  assert.equal(s.total, of('large_output').length + of('discovery').length);
});

test('CLI show and runs', () => {
  const s = run('show', bundle, 'b-root', '8', '9').trim().split('\n');
  assert.equal(s.length, 2);
  assert.match(s[0], /^#8 .* tool_call bash .*command="npm test"/);
  assert.match(s[1], /ERR\(tool\)/);
  const r = run('runs', bundle).split('\n');
  assert.ok(r.some((l) => /^ {4}a-child \[subagent:Explore\]/.test(l)));
  assert.ok(r.some((l) => /c-root \[primary\] “Tidy the config loader/.test(l)));
});
