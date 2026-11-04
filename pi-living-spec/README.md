# Pi living spec V2 trial

This alpha keeps one structured specification in `.living-spec/specification.json` and publishes portable Markdown. Prototype evidence, intended requirements, and proposed solutions remain distinct. It does not infer contractual authority from a complete specification.

The original package and V1 `ledger.json` are not modified. This directory is a separate trial, not an installed replacement.

## Run without installing the extension

Use Node.js 22 or later and a current Pi host. The package needs `playwright` and `typescript`, plus `typebox`, `@types/node`, `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` from the Pi host. No package lock, postinstall script or browser download ships with this package.

On the machine used for this trial, `node_modules` holds local symlinks with absolute paths to existing installations, not an installed dependency tree. They work only on that machine. Check them before use:

```sh
ls -l node_modules node_modules/@earendil-works node_modules/@types
```

On another machine, prepare dependencies deliberately after reviewing them. One option is to link the host's copies:

```sh
PI_ROOT="$(npm root -g)/@earendil-works/pi-coding-agent"
mkdir -p node_modules/@earendil-works node_modules/@types node_modules/.bin
ln -s "$PI_ROOT" node_modules/@earendil-works/pi-coding-agent
ln -s "$PI_ROOT/node_modules/@earendil-works/pi-ai" node_modules/@earendil-works/pi-ai
ln -s "$PI_ROOT/node_modules/typebox" node_modules/typebox
ln -s "$PI_ROOT/node_modules/@types/node" node_modules/@types/node
```

Then install or link `playwright` and `typescript`, for example with `npm install --no-save playwright@^1.52.0 typescript@^5.6.0`. That command uses the network and changes `node_modules`. Run it only when you intend to. If you link an existing TypeScript instead, also run `ln -s ../typescript/bin/tsc node_modules/.bin/tsc`.

Browser capture needs a Chromium that matches the Playwright version. This package never downloads one. If none is present, install it deliberately with `npx playwright install chromium`, which downloads a browser. Tests and the worked example do not need a browser.

From an empty scratch project, launch the local source explicitly:

```sh
pi --no-extensions --no-skills \
  -e /absolute/path/pi-living-specV2/src/index.ts \
  --skill /absolute/path/pi-living-specV2/skills/living-spec/SKILL.md \
  --skill /absolute/path/pi-living-specV2/skills/spec-clarify/SKILL.md
```

`--no-extensions` still permits explicit `-e`. `--no-skills` still permits explicit `--skill`. These flags avoid duplicate V1 tools and skills. This command does not install the package or change Pi settings. Do not use `pi install` for this trial.

The model-driven workflows use your configured Pi model. Automated tests and the worked example make no model or prototype calls.

## Try the synthetic invoice example

From this package directory:

```sh
npm run typecheck
npm test
npm run example -- /absolute/path/to/empty-scratch
```

The example creates an invoice requirement, confirms it without a decision, answers a question, chooses email, freezes an estimating baseline, adds a new fact, and supersedes email with a ticket decision. Read `/absolute/path/to/empty-scratch/.living-spec/specification/README.md`. All data and attribution are explicitly fictional.

## Commands

| Command | Action |
| --- | --- |
| `/spec <url> [repo-path]` | Start candidate extraction with the living-spec skill |
| `/spec-clarify [focus]` | Independently resume the optional persistent interview |
| `/spec-status` | Show counts, ready questions, reviews, and baselines |
| `/spec-export [md csv json]` | Publish selected formats |
| `/spec-writes fake` or `block` | Set the browser write guard |
| `/spec-login [url]` | Log in using a visible browser and local auth state |
| `/spec-close` | Close the browser |

The trial refuses `writeGuard=off`. Existing authentication exceptions remain, so login requests can reach the prototype. Do not exercise payments, logout, or account deletion against a live system. The scanner, crawler, and browser capture implementations are unchanged.

## Tools and records

| Tool | Operations |
| --- | --- |
| `spec_scan_source`, `spec_crawl`, `spec_browse` | Source and guarded browser evidence capture |
| `spec_record` | create, update, confirm, retire, get revision, list, project |
| `spec_clarify` | frontier, answer with atomic requirement patches, defer, resume |
| `spec_decision` | create or supersede with a new ID |
| `spec_review` | list impacts or resolve reviewed/no-change with attribution |
| `spec_baseline` | create, get, list, diff |
| `spec_import_v1` | Explicit opt-in import into empty V2 |
| `spec_export` | Markdown, requirements-only CSV, full-state JSON |
| `spec_requirement`, `spec_entity` | Compatibility names using V2 create/list/get/update/retire fields |

The compatibility names do not accept the old V1 action and field schema. Use `spec_record` for full capabilities. All schemas expose typed fields through Pi. `src/schema.ts` is the complete field reference.

Record types are requirement, question, decision, scope, goal, persona, journey, screen, component, interface, entity, work-package, and constraint. Use only those needed. `home` names a scope ID. `contains` links scope nodes. Other links include informed-by, depends-on, appears-in, fulfilled-by, uses, and relates-to. Supersession links are managed by the decision operation.

Requirements support EARS statement, acceptance arrays, rationale, notes, evidence, status, priority, and revision-specific confirmation. New intent is candidate and evidence is assumed. Questions carry a working assumption, state, options, append-only answers, and deferral conditions. Entities carry fields, relations by entity ID, and rules. Screens and interfaces label screenshots, wireframes, observed APIs, and proposed contracts explicitly. Work packages optionally carry estimate units, range, basis, assumptions, exclusions, and applicability revisions. No effort is inferred or totalled.

Confirmation needs an explicit contributor, valid date, and source. Ordinary confirmation creates no decision. Material edits remove current confirmation and require review unless the same operation includes a new explicit confirmation. Creating linked evidence adds review impacts without rewriting linked records.

## Persistence and migration

V2 validates authoritative state and rejects corrupt or unsupported files. Every record revision is retained. Retirement does not remove records or reuse IDs. Transactions use a local lock, stale-file digest check, and atomic rename. An interrupted process can leave a lock. Verify that no writer is running before manually removing a stale lock. Reload and reconsider a rejected stale write rather than replaying it blindly.

To import, place the original V1 `ledger.json` under the scratch project's `.living-spec`, then call `spec_import_v1` with `optIn: true` and attribution. Import requires an empty V2 history. The tool leaves the V1 bytes unchanged and reports unresolved references. Existing IDs, evidence, notes, and entities are preserved. Legacy observed status never becomes client confirmation. Removed V1 IDs cannot be recovered because V1 did not retain them.

Pi session branching does not branch this workspace specification. It is shared persistent project state.

## Publication and baselines

Default output is `.living-spec/specification/README.md`, with definitive area files and useful linked records, history, reviews, and baselines. Filenames and anchors use stable IDs. Each requirement's full detail appears once, in its current scope home's area file. When a requirement moves to another scope, its former area file keeps an anchor with the same ID that says where it moved and shows no current text. Estimate applicability links lead to the exact revision, using the history page when the revision is no longer current. Repeated exports of unchanged state produce identical bytes. CSV is explicitly requirements-only. JSON retains the complete specification, including questions, answers, links, and history.

Generated files have an ownership manifest with SHA-256 digests. Export preflights targets and refuses unknown or human-edited files and symlink paths. It never deletes stale files. The publication report lists owned files from earlier exports that this export did not regenerate. Edit manuscript content through the record tools, then export. Use a new output directory if generated files were edited manually. The `spec_export` path parameter is a directory.

Captures can contain personal data, secrets, or source literals. Evidence is not packaged by default. After human review, explicitly list approved evidence citations in a record's `publishEvidence` array. Only those references under the narrow capture allowlist are archived and copied. Auth state, source checkouts, arbitrary files, and traversal paths are excluded. Approved files are frozen by content hash at record creation or update.

Publication permission is the current approval, not the historical one. Export packages archived bytes only when the latest non-retired revision of the citing record approves those exact bytes. Approval is per record and per content hash. If a capture is retaken and approved again, only the new bytes are approved. Old bytes cited by history or baselines stay withheld until approved again. Removing a reference from `publishEvidence` withholds its bytes from every current, history, and baseline page. The frozen record text, reference, and hash remain visible, marked as withheld. Retiring a record withdraws its permission.

If an existing output directory still holds evidence bytes that are no longer approved, export fails before writing anything and leaves every file in place. Publish to a fresh output directory and dispose of the old one deliberately. A fresh export omits the withheld bytes. Copies already distributed cannot be recalled.

External, missing, unapproved, or withheld evidence is reported as not packaged. Review the publication report before sharing. Full JSON can contain sensitive human-entered text even when no assets are bundled.

Baselines are immutable named snapshots of selected exact revisions plus linked supporting context and project context. Selection distinguishes binding and supporting roles. Draft and estimating baselines allow unresolved assumptions. Approved baselines require supplied approvers and authority. The tool cannot verify that authority. Working changes leave snapshots fixed. Diff reports additions, removals, changed fields, project changes, and estimate applicability. Additions compare the entire working specification, so some may lie outside the baseline's selected scope.

## Trial boundaries

- This is local-file coordination, not a multi-user server, signed audit log, or commercial approval system.
- Record updates are atomic. Publication preflight is all-or-nothing before writing, but a process crash during multi-file output may leave a partial publication. Use a new output directory to recover.
- Impact propagation is conservative across connected records and may over-report. Reviews do not silently update targets.
- Markdown prose links are reported or resolved for supported inline forms. Arbitrary HTML and complex Markdown reference syntax are not a general document-link resolver.
- Evidence approval is a human responsibility. The allowlist is not a secret detector.
- There is no automatic estimate roll-up, diagram editor, provider integration, installation, release, or publishing step.

See [trial design](DESIGN.md) for model boundaries.
