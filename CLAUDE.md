# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`claude-capture` is a globally-installed Node CLI that launches three coordinated services from a single command: a mitmweb proxy (with a custom addon that records Anthropic `/messages` traffic), an in-process viewer HTTP server, and the `claude` CLI itself wired to route through the proxy. The user runs it from any directory to inspect Claude Code ↔ Anthropic HTTP traffic.

There is **no build step, no test suite, no lint config**. The package is shipped as raw source (`bin/`, `lib/`, `public/`) — `npm install -g .` is the only packaging operation. Target: Node ≥ 20, mitmproxy ≥ 10.

## Running locally

```bash
# Link the local bin so `claude-capture` resolves to this checkout
npm link

# Run it (needs mitmweb + claude on PATH, and ~/.mitmproxy/mitmproxy-ca-cert.pem)
claude-capture

# Or invoke the entry directly without linking
node bin/claude-capture.mjs
```

To debug `addon.py` standalone against an already-running proxy:
```bash
mitmweb -s lib/addon.py   # addon falls back to ./captures/ when CLAUDE_CAPTURE_DIR is unset
```

## Architecture

The entire program is one orchestrator plus three sidekicks. There is no framework, no transpilation.

### `bin/claude-capture.mjs` — the orchestrator (single file, ~410 lines)
Owns the full lifecycle. Read this file first — it defines every cross-cutting concern:
- **Arg parsing** (`parseArgs`): flags + passthrough args after `--` go to `claude`. Tracks `*Explicit` booleans to distinguish user-requested ports from defaults (drives the auto-pick-vs-hard-error behavior).
- **Preflight** (`preflight`): Node version, `mitmweb`/`claude` on PATH, mitmproxy version, CA cert existence, port resolution, soft warning for missing Anthropic env vars. Hard errors call `process.exit(1)`.
- **Port logic** (`tryBind` / `isPortFree` / `findFreePort` / `resolvePort`): The subtle part. `isPortFree` checks **both** `0.0.0.0` and `127.0.0.1` because macOS `SO_REUSEADDR` is asymmetric — binding one host misses conflicts on the other. `resolvePort` uses a shared `chosen` Set so the three port picks never collide with each other.
- **Process orchestration** (`main`): spawn order is fixed — (1) start in-process viewer, (2) spawn mitmweb, (3) `probePort` until proxy answers (5s timeout → abort), (4) open browser, (5) spawn claude with `HTTPS_PROXY`/`HTTP_PROXY`/`NODE_USE_ENV_PROXY`/`NODE_EXTRA_CA_CERTS` env injected. `stdio: "inherit"` for claude so it owns the terminal.
- **Lifecycle**: `claude.on("exit")` → kill mitm. `SIGINT`/`SIGTERM` → kill claude first, then mitm after 100ms. The `shuttingDown` guard prevents re-entry.

### `lib/addon.py` — the mitmproxy addon
Loaded by mitmweb via `-s`. Writes one JSON file per `/messages` request to `$CLAUDE_CAPTURE_DIR` (CLI injects this; falls back to `./captures/` for standalone debugging). The `response` hook captures both streaming (`text/event-stream` → parsed into `sse_events[]`) and non-streaming bodies. **Only** paths containing `/messages` are captured — that filter is the entire scope of the addon. The CLI injects `CLAUDE_CAPTURE_DIR` via mitmweb's env.

### `lib/server.mjs` — the viewer backend (in-process, ~120 lines)
Plain `node:http`. Three routes: `GET /api/files` (lists + previews captures, sorted by mtime desc), `GET /api/file?name=` (serves one capture; rejects `..` and `/`), and static files from `public/` (path-joined, with a `publicDir.startsWith` guard against traversal). Listens on `127.0.0.1` only.

### `public/index.html` — the viewer frontend (single file, ~1800 lines)
Self-contained: HTML + CSS + vanilla JS, no build, no framework, no dependencies. Fetches `/api/files` and `/api/file?name=`. Renders the Conversation / SSE Timeline / Request / Response / Raw JSON tabs. API keys are redacted client-side when rendered.

### How the pieces find each other
- CLI sets `CLAUDE_CAPTURE_DIR` env → mitmweb inherits it → `addon.py` reads it.
- CLI sets `HTTPS_PROXY`/`HTTP_PROXY`/`NODE_EXTRA_CA_CERTS` env → `claude` inherits it → traffic routes through mitmweb → addon sees `/messages` → writes JSON to disk → viewer's `listCaptures` picks it up.
- The viewer and mitmweb's Web UI are independent HTTP servers; the viewer only reads files from disk, it does not talk to mitmweb.

## Conventions

- **Comments are bilingual** (Chinese + English). When editing, match the surrounding style — most explanation lives in a header comment per file, with inline comments in Chinese where the orchestrator does something non-obvious (port asymmetry, spawn order, Windows `.cmd` handling).
- **Cross-platform is load-bearing.** Every `spawn` call must consider Windows: `.cmd`/`.bat` wrappers need `shell: true` (IS_WIN). Use `os.homedir()` not `$HOME`. Browser open branches on `IS_MAC` / `IS_WIN` / else `xdg-open`.
- **No new dependencies.** `package.json` has zero runtime deps and the file list is locked (`bin`, `lib`, `public`, `README.md`). Anything new must be implementable with Node built-ins (or, for the addon, the mitmproxy API).
- **Captures may contain real API tokens and full conversation history** (including any code/secrets pasted into claude). Default capture dir lives outside any git repo for this reason. Never log capture contents to stdout; the addon prints only the filename + status + byte count.
- **The `--port-*` explicit/auto distinction matters.** Auto-pick (default) silently moves to the next free port and notes it in the banner; explicit `--port-*` must hard-error if busy rather than override the user's choice. Preserve this when touching port logic.
