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
2–5 per functional requirement, testable by QA without reading code:

- Given I am on /projects with at least one project, When I type "web" in Search, Then only projects whose name contains "web" are listed.
- Given the New Project dialog is open, When I submit without a name, Then I see "Name must be at least 2 characters" and the dialog stays open.

Take exact messages, limits and options from the prototype (zod rules, toasts, select options) and mark them as observed; flag ones that look like placeholders.

## Kinds
- **functional** — what users can do and what the system does in response.
- **business-rule** — calculations, state transitions, limits, eligibility (e.g. "a task can't be Done while it has open sub-tasks").
- **auth** — authentication, roles, permissions, data visibility.
- **ui** — information that must be shown, layout/hierarchy that carries meaning, responsive behaviour, empty/loading/error states. Not pixel details.
- **data** — retention, uniqueness, history/audit, import/export formats. (Entity definitions go in `spec_entity`.)
- **integration** — external systems: payments, email, AI, storage, SSO, webhooks.
- **nfr** — accessibility, performance, security, privacy, availability, i18n, browser/device support.
- **question** — open issue for the client; always add `assumption` and `related` IDs it blocks.

## Status
- **observed** — you saw it work in the running prototype.
- **inferred** — the code, schema or UI implies it, but you didn't see it work end-to-end (e.g. RLS policy, an edge function, a route you couldn't reach).
- **mocked** — the UI is there but the behaviour is faked: hard-coded arrays, `console.log`/empty handlers, "coming soon" toasts, writes with no effect after reload. Put what the prototype actually does in `notes`.
- **assumed** — industry-standard expectation or your assumption; needs client confirmation.

## Priority (MoSCoW)
Default `unknown`. Use `must` for the core flows the prototype is clearly built around (the happy path of its main screens), `should`/`could` for secondary or partially built features, `wont` only if the client said so. Don't invent business priority beyond that — raise a question if it matters.

## Evidence strings
Prefer these forms so the export can cross-reference screens:
- `/projects` (a route path exactly as in the screen inventory)
- `.living-spec/crawl/screens/…jpg`
- `src/pages/Projects.tsx`
- `POST supabase:/rest/v1/projects`
- `RLS: "Users can view own projects" on projects`

## Good vs weak

Weak: "Projects page with table and button."

Good:
- PROJ-001 *List projects* — The system shall list the user's projects with name, client, status, due date and progress. AC: Given I own 3 projects, When I open /projects, Then I see 3 rows sorted by due date ascending. Evidence: `/projects`, `GET supabase:/rest/v1/projects?select=*&order=due_date.asc`. Status: observed.
- PROJ-004 *Export projects to CSV* — When the user clicks Export, the system shall download a CSV of the current filtered list. Status: mocked (notes: button only shows toast "Export coming soon"). Related question Q-007: Which columns and format does finance need?
