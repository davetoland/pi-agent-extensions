# pi-living-spec

A [pi](https://pi.dev) package that turns a clickable prototype (a "living spec") into a requirements specification. It was built for Lovable apps, and it works on any web app.

It looks at the prototype in two ways:

- **The running app.** A headless Chromium crawls every screen and records an outline of what is visible and clickable, plus screenshots and the API calls each screen makes. The agent can then drive the app like a user: open dialogs, submit forms, switch tabs, try the mobile layout.
- **The source code.** If you have it (Lovable GitHub sync or ZIP export), a static scan pulls out routes, screens, form fields, zod validation rules, Supabase tables, RLS policies, edge functions, auth methods, hard-coded mock data and stubbed handlers. It never runs project code.

The agent writes what it finds into a structured ledger with stable IDs, [EARS-style statements](#ears-style-statements), Given/When/Then acceptance criteria, evidence, status and MoSCoW priority. You export that as `REQUIREMENTS.md`, a CSV for Jira or Linear, and JSON.

## Install

You need Node 20+ and pi 1.x (`@earendil-works/pi-coding-agent`).

```bash
# 1. Put the package somewhere and install its dependencies (Playwright + TypeScript)
cd pi-living-spec
npm install                      # also runs `playwright install chromium`
#   if the browser download was skipped:  npx playwright install chromium

# 2a. Install it into pi (all projects)
pi install /absolute/path/to/pi-living-spec

# 2b. …or only for the current project
pi install -l /absolute/path/to/pi-living-spec

# 2c. …or try it once without installing
pi -e /absolute/path/to/pi-living-spec
```

If you push the folder to a git repo, `pi install git:github.com/you/pi-living-spec` installs the dependencies for you.

## Get hold of the prototype

| What you have | What to do |
|---|---|
| Published URL (`https://something.lovable.app`) | Use it directly. |
| Only an editor or preview link | Ask the client for the published URL, or open it with `/spec-login` (see below). |
| Access to the Lovable project | Connect GitHub in Lovable (or remix it into your workspace first), then `git clone` it next to your work, e.g. `./prototype`. You can also use Dev Mode → download ZIP. |

The source is optional, but it makes the spec much better. It shows the validation rules, the data model, the permissions and what is faked.

## Use

Start pi in an empty working folder, the folder where you want the spec to live, and run:

```
/spec https://client-app.lovable.app ./prototype
```

This saves the URL and source path, then starts the `living-spec` skill. The skill works through five phases:

1. **Recon:** source scan and source map
2. **Inventory:** crawl, screen list, feature areas, project overview
3. **Deep-dive** each area: drive every flow and record requirements and entities as it goes
4. **Cross-cutting:** auth and roles, integrations, NFRs, prototype gaps
5. **Review and export**

You can interrupt or steer at any time ("focus on billing", "skip the marketing pages"). Everything is saved in `.living-spec/`, so you can stop, `/resume` or start a fresh session later and pick up where you left off.

### Commands

| Command | What it does |
|---|---|
| `/spec <url> [repo]` | Configure and start the guided extraction |
| `/spec-status` | Screens crawled, requirements, entities, open questions |
| `/spec-export [md\|csv\|json]` | Write the deliverables |
| `/spec-login [url]` | Open a **visible** browser so you can log in yourself. The session is saved and reused headlessly. |
| `/spec-writes fake\|block\|off` | How the browser treats POST/PUT/PATCH/DELETE (see Safety) |
| `/spec-close` | Close the browser |

### Tools the model uses

| Tool | Purpose |
|---|---|
| `spec_scan_source` | Static analysis → `.living-spec/source-map.md` / `.json` |
| `spec_crawl` | Visit every reachable screen → `crawl/pages/*.md` outlines, `crawl/screens/*.jpg`, `crawl/sitemap.json`, `crawl/api-inventory.md` |
| `spec_browse` | open / click / fill / select / check / press / upload / scroll / viewport / screenshot. Returns an outline with `[eN]` refs, a diff after each step, API calls, intercepted writes, toasts, dialogs and console errors. |
| `spec_requirement` | Requirements ledger: add (batch) / update / list / get / remove / define_area / set_project. Questions get `Q-nnn` IDs. |
| `spec_entity` | Data-model ledger: entities, fields, relations, rules |
| `spec_export` | `REQUIREMENTS.md` (with screen inventory, Mermaid ER diagram, gaps, questions, traceability), `requirements.csv`, `requirements.json` |

You can also call them yourself in conversation. For example: "crawl just /admin with mobile screenshots", or "list everything marked mocked".

## What you get

```
.living-spec/
├── REQUIREMENTS.md        ← the deliverable
├── requirements.csv       ← import into Jira/Linear/Azure DevOps
├── requirements.json
├── ledger.json            ← source of truth (requirements, entities, areas)
├── source-map.md/.json    ← what the code says
├── crawl/
│   ├── sitemap.json
│   ├── api-inventory.md
│   ├── pages/*.md         ← per-screen outlines
│   └── screens/*.jpg      ← full-page (and mobile) screenshots
├── screens/               ← screenshots taken while browsing
├── auth/                  ← saved login session (git-ignored)
└── config.json
```

Every requirement has a status:

- ✅ **observed**: seen working in the prototype.
- 🔎 **inferred**: implied by the code, schema or UI.
- 🧪 **mocked**: the UI exists but the behaviour is faked. These are listed separately as "prototype gaps" so nobody assumes they already work.
- ❓ **assumed**: needs the client to confirm.

## Safety

- **Writes are intercepted by default** (`fake` mode). A prototype is often wired to a live Supabase project. Any POST, PUT, PATCH or DELETE from the page is stopped before it leaves the browser, logged with its payload (which is good evidence for the data model) and answered with a plausible success response, so the UI flow can continue. Auth endpoints (`/auth/v1/`, `/token`, `/login`…) are let through so you can sign in. `block` aborts writes instead. `off` sends real writes and asks for confirmation first.
- Logout links are never followed during a crawl. Browser `alert` and `confirm` dialogs are accepted automatically, so the writes behind them stay faked.
- Passwords, tokens, API keys and card fields are masked in every captured request body.
- The source scan only reads files. It lists env var **names** and never their values.
- The saved login session in `.living-spec/auth/` is git-ignored automatically. Don't commit or share it.

## Tips

- **Use a vision-capable model.** The agent reads the screenshots for layout-heavy screens.
- **Large apps:** run the crawl in parts (`spec_crawl` with `include: "^/admin"`), and work through one feature area per session. The ledger persists between sessions.
- **Logins:** if the client gave you test credentials, tell the agent and it will log in through `spec_browse`. A successful login is saved and reused. For OAuth-only apps (Google, etc.), use `/spec-login`. It needs a desktop session because it opens a real browser window.
- **Configuration:** settings live in `.living-spec/config.json`. You can edit the viewport, `headless`, extra `writeAllow` URL patterns, and `projectName` for the document title.
- **Re-runs:** after the client updates the prototype, run `spec_scan_source` and `spec_crawl` again, then ask the agent to "diff against the ledger and update requirements".

## Limitations

- Outlines are heuristic. Canvas-drawn UIs (charts, maps, whiteboards) appear as images, so check the screenshots for those.
- Routes with parameters (e.g. `/projects/:id`) are only crawled when a link to them exists. The agent can still reach them by clicking through from a list.
- The source scan recognises React Router (`src/App.tsx`), TanStack Router/Start file routes (newer Lovable projects), Next.js `app/` routes, Supabase types and migrations, zod, react-hook-form and shadcn/ui. Other stacks still get a crawl, plus a lighter scan.
- `/spec-login` needs a display. On a headless server, log in through `spec_browse` with test credentials instead.

## Compatibility

Written against the pi extension API documented for `@earendil-works/pi-coding-agent` 1.5 (`registerTool` with TypeBox schemas, `registerCommand`, `sendUserMessage`, `session_shutdown`). The legacy `@mariozechner/*` import names map to the same modules. Needs Playwright ≥ 1.52.

## Glossary

### EARS-style statements

EARS stands for Easy Approach to Requirements Syntax. Alistair Mavin and colleagues at Rolls-Royce came up with it around 2009 while writing requirements for jet-engine control systems. The idea is to write every requirement in one of a few fixed sentence shapes. That gets rid of most of the vagueness in free-text requirements (“the system should handle errors gracefully”) without needing a formal language.

Every EARS requirement ends in “the system shall [response]”. What changes is the opening clause, which says when the requirement applies:

Pattern	Keyword	Template	Example
Ubiquitous (always true)	none	The system shall…	The system shall store all dates in UTC.
Event-driven	When	When [trigger], the system shall…	When a user submits the New Project form with valid data, the system shall create the project and open its detail page.
State-driven	While	While [state], the system shall…	While a project is archived, the system shall prevent edits to its tasks.
Unwanted behaviour	If … then	If [condition], then the system shall…	If the project name is shorter than 2 characters, then the system shall show “Name must be at least 2 characters” and not submit the form.
Optional feature	Where	Where [feature/role applies], the system shall…	Where the user is an admin, the system shall show the Delete project action.

You can also combine them, e.g. “While the user is offline, when they save a task, the system shall queue the change and sync it on reconnect.”

It’s a good fit for turning a prototype into a spec, which is why I had the extension use it:

It suits what you can observe. Clicking through a prototype mostly shows triggers and responses: “when I click X, Y happens”. That maps straight onto the When pattern. Validation errors map onto If…then, and role-based UI onto Where.
It makes gaps visible. If you can’t fill in the trigger or the condition, you’ve found an open question for the client rather than a vague requirement.
It pairs well with acceptance criteria. An EARS statement converts almost mechanically into a Given/When/Then test. “If the name is too short, then show the error” becomes “Given the dialog is open, When I submit an empty name, Then I see ‘Name must be at least 2 characters’”.
It’s readable by non-engineers. It’s still plain English, so your client can review and sign off on it.

A rule of thumb that goes with it: one “shall” per requirement. If a sentence has “and the system shall also…”, split it into two requirements so each can be tested and traced separately.