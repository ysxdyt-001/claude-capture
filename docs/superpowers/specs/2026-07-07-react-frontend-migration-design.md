# React Frontend Migration — Design

**Date:** 2026-07-07
**Status:** Approved (brainstorming complete)
**Supersedes (in part):** CLAUDE.md rules "no build step" and "no new dependencies" (see Section 7)

## 1. Goal

Replace the 1821-line single-file viewer UI (`public/index.html`) with an engineered React + Vite + TypeScript frontend, built into `dist/` and served by the existing in-process viewer (`lib/server.mjs`).

The migration is **side-by-side, ship-when-ready**: the new source tree (`web/`) coexists with the old monolith (`public/index.html`) until a feature-parity checklist passes, then the monolith is deleted in a follow-up cleanup commit.

## 2. Decisions (locked during brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Goal | Modern tooling (TypeScript, framework, bundler, lint/format) | User-selected over pure maintainability split |
| Framework | React + Vite + TypeScript | User-selected |
| Migration strategy | Side-by-side, ship-when-ready | Keeps old UI as safety net; always shippable |
| Lint/format | Biome (single tool) | Matches project tone; one `biome.json` replaces ESLint+Prettier |

## 3. Directory layout

```
claude-capture/
├── bin/                       # unchanged
├── lib/                       # server.mjs: one-line publicDir change (Section 6)
├── public/                    # OLD monolith — kept as safety net, deleted in cleanup commit
├── web/                       # NEW React source tree (dev-only, NOT in root package.json files)
│   ├── src/
│   │   ├── main.tsx           # Vite entry
│   │   ├── App.tsx            # shell: tab state, polls /api/files, fetches /api/file
│   │   ├── components/
│   │   │   ├── ConversationList.tsx
│   │   │   ├── DetailPane.tsx
│   │   │   ├── Tabs.tsx
│   │   │   ├── ConversationTab.tsx
│   │   │   ├── SseTimeline.tsx
│   │   │   ├── RequestTab.tsx
│   │   │   ├── ResponseTab.tsx
│   │   │   └── RawJsonTab.tsx
│   │   ├── lib/
│   │   │   ├── api.ts         # fetch wrappers + types for /api/files, /api/file
│   │   │   ├── sse.ts         # SSE event parsing (pure)
│   │   │   └── redact.ts      # API-key redaction (pure)
│   │   ├── types.ts           # Capture, SseEvent, etc.
│   │   └── styles/
│   │       ├── global.css
│   │       └── tokens.css     # color/spacing variables
│   ├── index.html             # Vite HTML template (mounts <div id="root">)
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── biome.json
│   ├── package.json           # sub-package: devDependencies live here
│   └── package-lock.json      # checked in (npm ci support)
├── dist/                      # BUILD OUTPUT — gitignored, produced by web/ build
├── package.json               # ROOT: adds prepublishOnly hook, ships dist/ instead of public/
├── CLAUDE.md                  # updated (Section 7)
└── README.md
```

Key choices:
- `web/` has its own `package.json` so the root `package.json` stays at zero runtime deps for end-user installs.
- `dist/` is gitignored; rebuilt at publish time via `prepublishOnly`.
- `public/index.html` stays checked in (and is the live UI) until the parity checklist passes.

## 4. Component breakdown & state

```
<App>
  state: captures[], selectedName, capture (full), activeTab
  effects:
    - poll /api/files every Ns → setCaptures
    - on selectedName change → fetch /api/file?name=X → setCapture
  ├── <ConversationList>          props: captures, selectedName, onSelect
  └── <DetailPane>                props: capture, activeTab, onTabChange
        ├── <Tabs>
        ├── <ConversationTab>
        ├── <SseTimeline>
        ├── <RequestTab>
        ├── <ResponseTab>
        └── <RawJsonTab>
```

State model:
- Single source of truth in `App.tsx` via `useState` + `useEffect`. No Redux/Zustand.
- `ConversationList` polls; `DetailPane` reacts to selection.
- Lift state only as far as needed; pass props down.

Purity rules:
- `lib/sse.ts`, `lib/redact.ts`, `lib/api.ts` are pure — no React imports. Testable in isolation.
- Components own no business logic; they call into `lib/`.

Tab rendering:
- Lazy — only the active tab is mounted.
- SSE parsing (`lib/sse.ts`) runs once on capture load; result stored in App state, passed to whichever tab is active.

## 5. Build, dev, and publish workflow

**Dev workflow (while porting):**
```bash
cd web
npm install        # React, Vite, TS, Biome — isolated to web/
npm run dev        # vite dev server on http://localhost:5173
                   # proxies /api/* → http://127.0.0.1:<viewer-port>
```
Run `claude-capture` in a second terminal so the viewer server is reachable; vite's proxy does the rest. Hot reload, no manual refresh.

**Production build:**
```bash
cd web && npm run build    # outputs to ../dist/
```
Vite config: `build.outDir: '../dist'`, `base: './'` (relative paths).

**Publishing — root `package.json` changes:**
```jsonc
{
  "scripts": {
    "prepublishOnly": "cd web && npm ci && npm run build"
  },
  "files": [
    "bin",
    "lib",
    "dist",
    "README.md"
  ]
}
```
`public/` is dropped from `files` once `dist/` exists. `dist/` is gitignored.

**Server change — `lib/server.mjs`:**
```js
// was: publicDir = path.join(__dirname, '..', 'public')
// now: publicDir = path.join(__dirname, '..', 'dist')
```
One-line change. `/api/*` routes untouched.

**Side-by-side period:** server points at `public/` until parity passes; flip the one line + update `files` in the same commit that deletes `public/index.html`.

## 6. Feature-parity checklist (the gate)

The flip happens only when every item is verified against the old monolith (manual side-by-side comparison, old UI vs new UI, both pointed at the same `$CLAUDE_CAPTURE_DIR`):

1. `GET /api/files` — list captures sorted by mtime desc, preview fields identical
2. `GET /api/file?name=` — same JSON shape; `..` and `/` rejection preserved (server-side)
3. Conversation tab — messages, tool calls, tool results rendered identically
4. SSE Timeline tab — parse `text/event-stream` → `sse_events[]`; same event-type labels
5. Request tab — headers, body (pretty JSON), model, max_tokens, system prompt
6. Response tab — non-streaming body or aggregated streaming result; stop reason, usage
7. Raw JSON tab — verbatim capture JSON, collapsible/expandable
8. API-key redaction — same patterns redacted, same substitution markers (planted-key test)
9. Polling cadence — same refresh interval for capture list
10. Static asset serving — CSS, JS, source maps load correctly from `dist/`
11. Path-traversal guard — `lib/server.mjs` re-verified (no logic change, just re-test)

**Out of scope** (deferred to separate projects):
- New features (filtering, search, dark mode, diff view)
- Backend changes to `lib/server.mjs` beyond the `publicDir` swap
- Changes to `lib/addon.py` or `bin/claude-capture.mjs`
- Test suite (Vitest can be added later as its own project)

## 7. CLAUDE.md changes

These ship in the same PR that lands the new structure:

1. **"What this is":**
   - ~~"There is no build step, no test suite, no lint config."~~
   - → "There is no test suite. The viewer UI (`web/`) has a build step (Vite → `dist/`); the CLI itself (`bin/`, `lib/`) is still raw source with no build."

2. **"No new dependencies"** convention — clarify scope:
   - "No new **runtime** dependencies in the root `package.json`. Dev/build tooling (React, Vite, TypeScript, Biome) lives in `web/package.json` and does not affect end users installing the CLI globally — `npm install -g claude-capture` does not install dev dependencies. The `files` list now ships `dist/` (built UI) instead of `public/` (raw monolith)."

3. **"How the pieces find each other"** — add build step:
   - "`web/` source → `npm run build` → `dist/` → served by `lib/server.mjs`. The viewer backend's `publicDir` points at `dist/`."

4. **"Running locally"** — add dev workflow:
   ```bash
   # Develop the viewer UI (hot reload via Vite)
   cd web && npm install && npm run dev
   # In another terminal, run the CLI as usual; vite proxies /api/* to its viewer server

   # Build the viewer for release
   cd web && npm run build     # outputs to ../dist/
   ```

5. **File list note:** change `"bin, lib, public, README.md"` → `"bin, lib, dist, README.md"` (note that `public/` is removed in the cleanup commit and `web/` is dev-only, not shipped).

## 8. Risk register & rollback

| Risk | Mitigation |
|---|---|
| `web/package.json` confuses `npm install -g .` at root | Root `package.json` doesn't reference `web/`. `prepublishOnly` runs at publish time on the maintainer's machine, not at install time. Verify via `npm pack` — tarball must contain only `bin/`, `lib/`, `dist/`, `README.md`. |
| `prepublishOnly` fails on fresh clone | Hook runs `cd web && npm ci && npm run build`. `web/package-lock.json` is checked in. CI should run `npm publish --dry-run` per PR. |
| Bundle size regressions | Vite default code-splitting + tree-shaking. Soft target: < 200KB gzipped for the full viewer (React + app code). Compare `dist/` size in PR descriptions. |
| SSE parsing or redaction regresses silently | Feature-parity checklist (Section 6) is the gate. Both live as pure functions in `web/src/lib/`. Optional later: Vitest tests against checked-in fixture captures. |
| User forgets to rebuild `dist/` after pulling source | Vite dev server doesn't need `dist/`. Maintain publishing handled by `prepublishOnly`. Rebuild step documented in CLAUDE.md. |

**Rollback plan:** If the React port stalls, `public/index.html` is untouched — revert `lib/server.mjs` `publicDir` to `'public'`, revert root `package.json` `files`/scripts, and ship the monolith again. `web/` can sit unused at no cost.

## 9. Implementation order (high level)

The detailed step-by-step plan will be produced by the writing-plans skill after this spec is approved. High-level phases:

1. Scaffold `web/` (Vite + React + TS + Biome), wire up dev proxy, get an empty React app loading against the live viewer server.
2. Port `lib/` (api.ts, sse.ts, redact.ts) as pure functions.
3. Port components in tab order: ConversationList → ConversationTab → SseTimeline → RequestTab → ResponseTab → RawJsonTab.
4. Run parity checklist (Section 6), fix discrepancies.
5. Flip server to serve `dist/`, update root `package.json` `files` + scripts, update `CLAUDE.md` (Section 7).
6. Delete `public/index.html` in a cleanup commit.
