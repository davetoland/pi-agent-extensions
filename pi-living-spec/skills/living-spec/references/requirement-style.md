# Writing the requirements

## Statement — EARS patterns
Use one of these shapes for `statement` (Easy Approach to Requirements Syntax):

| Pattern | Template | Example |
|---|---|---|
| Ubiquitous | The system shall … | The system shall show each project's status as Active, Paused or Archived. |
| Event-driven | When <trigger>, the system shall … | When a user submits the New Project form with valid data, the system shall create the project and open its detail page. |
| State-driven | While <state>, the system shall … | While a project is Archived, the system shall prevent edits to its tasks. |
| Unwanted behaviour | If <condition>, then the system shall … | If the project name is empty, then the system shall show "Name is required" and not submit. |
| Optional feature | Where <feature/role>, the system shall … | Where the user is an Admin, the system shall show the Delete project action. |

One behaviour per requirement. Avoid "etc.", "user-friendly", "fast" — quantify or raise a question.

## Acceptance criteria — Given/When/Then
Write as many criteria as the behaviour needs to be testable by QA without reading code. There is no fixed count.

- Given I am on /projects with at least one project, When I type "web" in Search, Then only projects whose name contains "web" are listed.
- Given the New Project dialog is open, When I submit without a name, Then I see "Name must be at least 2 characters" and the dialog stays open.

Take exact messages, limits and options from the prototype (zod rules, toasts, select options) and cite where they came from. Set `status` by how you established them (see below). Flag values that look like placeholders.

## Kinds
Set `kind` on requirement records:
- **functional** — what users can do and what the system does in response.
- **business-rule** — calculations, state transitions, limits, eligibility (e.g. "a task can't be Done while it has open sub-tasks").
- **auth** — authentication, roles, permissions, data visibility.
- **ui** — information that must be shown, layout/hierarchy that carries meaning, responsive behaviour, empty/loading/error states. Not pixel details.
- **data** — retention, uniqueness, history/audit, import/export formats. (Define entities as `type: "entity"` records with `fields`, `relations` and `rules`.)
- **integration** — external systems: payments, email, AI, storage, SSO, webhooks.
- **nfr** — accessibility, performance, security, privacy, availability, i18n, browser/device support.

Record open issues for the client as separate `type: "question"` records, not as a requirement kind. Give each a working `assumption`, and add typed `links` (for example `relates-to`) to the records it affects.

## Evidence status
`status` describes how well the evidence supports the record. It is not approval. Intent is separate: new records are `candidate`, and only explicit, attributed confirmation makes them `confirmed`.

- **observed** — you saw it work in the running prototype.
- **inferred** — the code, schema or UI implies it, but you didn't see it work end-to-end (e.g. RLS policy, an edge function, a route you couldn't reach).
- **mocked** — the UI is there but the behaviour is faked: hard-coded arrays, `console.log`/empty handlers, "coming soon" toasts, writes with no effect after reload. Put what the prototype actually does in `notes`.
- **assumed** — industry-standard expectation or your assumption; needs client confirmation.

## Priority (MoSCoW)
Leave `priority` as `unknown` unless the client stated it. What the prototype emphasises is evidence, not business priority. If priority matters, raise a question.

## Evidence strings
Use stable, identifiable citations that a reader can trace back to their source, for example:
- `/projects` (a route path exactly as in the screen inventory)
- `.living-spec/crawl/screens/…jpg`
- `src/pages/Projects.tsx`
- `POST supabase:/rest/v1/projects`
- `RLS: "Users can view own projects" on projects`

## Good vs weak

Weak: "Projects page with table and button."

Good:
- REQ-001 *List projects* — The system shall list the user's projects with name, client, status, due date and progress. AC: Given I own 3 projects, When I open /projects, Then I see 3 rows sorted by due date ascending. Evidence: `/projects`, `GET supabase:/rest/v1/projects?select=*&order=due_date.asc`. Status: observed.
- REQ-004 *Export projects to CSV* — When the user clicks Export, the system shall download a CSV of the current filtered list. Status: mocked (notes: button only shows toast "Export coming soon"). Linked with `relates-to` to question Q-007: Which columns and format does finance need?
