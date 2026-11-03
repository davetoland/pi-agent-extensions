# Anatomy of a Lovable project

Lovable generates React + TypeScript + Tailwind + shadcn/ui apps, usually with Supabase (branded "Lovable Cloud") as the backend. Code reaches you via GitHub two-way sync (main branch) or a ZIP export.

## Two generations (check which one you have)
- **Vite SPA (projects created before ~April 2026):** `vite.config.ts`, `src/main.tsx`, routes declared in `src/App.tsx` with React Router (`<Route path=… element={<Page/>}>`), one file per screen in `src/pages/`. `src/pages/NotFound.tsx` is boilerplate.
- **TanStack Start (newer, SSR):** `app.config.ts`, file-based routes in `app/routes/` (or `src/routes/`) using `createFileRoute('/path')`, `__root.tsx` layout, `$param` segments, `_layout` pathless layouts, and server functions (`createServerFn`) in `*.server.ts` files.

## Where the requirements hide
| Location | What it tells you |
|---|---|
| `src/pages/*` / `app/routes/*` | Screens and what they render |
| `src/components/*` (not `ui/`) | Feature components: forms, tables, cards, dialogs |
| `src/components/ui/*` | shadcn/ui primitives — **ignore**, not requirements |
| `src/integrations/supabase/types.ts` | Generated DB schema: tables, columns, nullability, FKs, enums, RPC functions |
| `supabase/migrations/*.sql` | Schema history, **RLS policies** (who can see/do what), triggers (side effects like creating a profile on sign-up), storage buckets |
| `supabase/functions/*/index.ts` | Edge functions: integrations (Stripe, Resend, OpenAI…), env var names reveal providers |
| `src/hooks/*`, `src/lib/*` | Data access, business logic, calculations |
| `src/contexts/AuthContext.tsx`, `ProtectedRoute` | Auth model, guarded screens, roles |
| zod schemas (`z.object`) | Validation rules and error messages — copy into acceptance criteria |
| `toast(...)` calls | Success/failure messages and hints of stubs ("coming soon") |
| Arrays of objects in components or `src/data/*` | Hard-coded mock data → the real entity's fields, and a `mocked` gap |
| `index.html` title/meta, `README.md` | Product name and pitch (README is often Lovable boilerplate) |
| `src/index.css` CSS variables | Design tokens (brand colours, radius) — UI notes, not hard requirements |

## Typical prototype shortcuts to flag as gaps
- Dashboards and lists driven by hard-coded arrays; numbers that never change.
- Auth that is UI-only (any credentials work), or sign-up without email verification.
- Buttons that only `console.log`, show "coming soon", or are disabled.
- Edge functions that exist but return canned responses; AI features with fixed outputs.
- No pagination, no empty/loading/error states, no permissions beyond "logged in".
- Payments in test mode / Stripe links; emails never actually sent.
- Data visible across users because RLS is missing or `using (true)`.

## Preview vs published URLs
`https://<name>.lovable.app` is the published app (public unless the owner restricted it). Editor preview URLs (`id-preview--….lovable.app`) usually need the owner's Lovable session — ask for the published URL, or use `/spec-login`. If the client only shared the Lovable project, remixing it into your own workspace and connecting GitHub gives you the source.
