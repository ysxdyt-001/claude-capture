# claude-capture

Capture and inspect Claude Code ↔ Anthropic HTTP traffic through a local mitmproxy, with a built-in visualization viewer. One command spins up the proxy, mitmweb's raw flow inspector, the friendly viewer, and Claude Code itself — everything works out of the box.

## Install

```bash
npm install -g claude-capture
```

Verify:

```bash
claude-capture --help
```

## One-time setup

### 1. Install mitmproxy

| Platform | Command |
|---|---|
| macOS | `brew install mitmproxy` |
| Linux | `sudo apt install mitmproxy` (or `pip install mitmproxy`) |
| Windows | installer from <https://mitmproxy.org/downloads/> (or `pip install mitmproxy`) |

### 2. Generate the mitmproxy CA cert

```bash
mitmweb
# wait for "Proxy server listening at *:8080", then Ctrl+C
ls ~/.mitmproxy/mitmproxy-ca-cert.pem   # should exist now
```

### 3. Confirm Claude Code CLI is installed

```bash
claude --version
```

If not, install from <https://claude.ai/code>.

That's it — every other requirement is checked at runtime by the preflight.

## Daily use

From **any directory**:

```bash
cd ~/any-project
claude-capture
```

What happens:

```
  claude-capture · inspect Claude Code ↔ Anthropic HTTP traffic

  captures : /Users/you/.claude-capture/captures
  proxy    : http://127.0.0.1:8080  (mitmweb + addon)
  mitmweb  : http://127.0.0.1:8081  (raw flow inspector)
  viewer   : http://127.0.0.1:8090  (anthropic captures)
  claude   : starting
```

- **mitmweb** starts with the dump addon loaded, exposing both a proxy (default `:8080`) and its raw Web UI (default `:8081`) — use it to inspect *every* HTTP request, not just Anthropic ones
- **viewer** is served on `:8090` (browser auto-opens) — friendly UI for the captured Anthropic traffic
- **claude** launches with `HTTPS_PROXY` / `HTTP_PROXY` / `NODE_EXTRA_CA_CERTS` wired in, so every `/v1/messages` call routes through the proxy and lands in `~/.claude-capture/captures/`

`Ctrl+C` exits claude → mitmweb and viewer clean up automatically.

### Auto port-pick (no need to manage ports)

If a default port is already taken, `claude-capture` silently picks the next free one and prints it in the banner:

```
  proxy    : http://127.0.0.1:8082  (mitmweb + addon)
  mitmweb  : http://127.0.0.1:8083  (raw flow inspector)
  viewer   : http://127.0.0.1:8091  (anthropic captures)
  notes    : port 8080 (proxy) busy → using 8082; port 8081 (mitmweb-ui) busy → using 8083; port 8090 (viewer) busy → using 8091
```

This is the default behavior — you don't have to do anything. If you explicitly pass `--port-*` for a port that's busy, `claude-capture` will refuse (it won't silently override your choice).

## Options

```
claude-capture [--port-proxy <n>] [--port-mitmweb <n>] [--port-viewer <n>]
               [--captures <path>] [--no-browser] [--claude <bin>]
               [-- <claude-args>...]
```

| Flag | Default | Purpose |
|---|---|---|
| `--port-proxy` | `8080` | mitmweb proxy listen port (auto-picks next free if busy) |
| `--port-mitmweb` | `8081` | mitmweb Web UI port (auto-picks next free if busy) |
| `--port-viewer` | `8090` | viewer HTTP port (auto-picks next free if busy) |
| `--captures` | `~/.claude-capture/captures` | JSON output directory |
| `--no-browser` | off | skip auto-opening the viewer |
| `--claude <bin>` | `claude` (env: `CLAUDE_CAPTURE_CLAUDE`) | CLI to launch & capture — set this to inspect a third-party Claude-like CLI (e.g. `acme-claude`) |
| `-- <args>` | — | everything after `--` is forwarded to the launched CLI |

Examples:

```bash
# Pin specific ports (here 8081 is taken; claude-capture will refuse rather
# than silently change your explicit choice)
claude-capture --port-mitmweb 8181

# Per-project captures
claude-capture --captures ./my-captures

# Pass-through args to claude
claude-capture -- --model opus-4-6 --resume

# Suppress the browser (you'll open it manually)
claude-capture --no-browser

# Capture a third-party Claude-like CLI instead of `claude`
claude-capture --claude acme-claude
# Or set it once via env:  export CLAUDE_CAPTURE_CLAUDE=acme-claude
```

## Two inspector surfaces

`claude-capture` gives you **two complementary UIs** running at the same time:

| UI | Default port | What it's for |
|---|---|---|
| **mitmweb** | `:8081` | Every HTTP flow Claude Code makes — DNS lookups, telemetry, anything else beyond `/v1/messages`. Raw request/response inspector, no parsing. |
| **viewer** | `:8090` | Curated view of just the Anthropic traffic: reconstructed conversation, SSE timeline, request/response breakdowns, syntax-highlighted JSON. |

Open both — they refresh independently.

### Viewer tabs

| Tab | Content |
|---|---|
| **Conversation** | Reconstructed thread with role-based visual hierarchy: user (most prominent) → assistant prose → tool-pair cards (tool_use + tool_result merged) → thinking (collapsed) → system (collapsed). Long tool results auto-collapse with a gradient + expand button. |
| **SSE Timeline** | One row per SSE event: `#idx \| event name \| data preview` |
| **Request** | URL / headers (API key auto-redacted) / tool declarations / full request body |
| **Response** | Status + headers + reassembled content blocks from SSE + raw response body (when captured) |
| **Raw JSON** | Full structured JSON for easy copy/paste |

## Captures location

Default: `~/.claude-capture/captures/` — cross-project, lives outside any working tree.

Override per-invocation with `--captures <path>`.

File structure (per request):

```jsonc
{
  "timestamp": "2026-07-06_214522",
  "id": "<mitmproxy flow id>",
  "request": {
    "method": "POST",
    "url": "https://api.anthropic.com/v1/messages",
    "headers": { "x-api-key": "...", "anthropic-version": "2023-06-01", ... },
    "body": {
      "model": "...",
      "system": [...],
      "tools": [...],
      "messages": [...]
    }
  },
  "response": {
    "status_code": 200,
    "headers": { ... },
    "content_type": "text/event-stream",
    "sse_events": [
      { "event": "message_start", "data": { ... } },
      { "event": "content_block_delta", "data": { ... } },
      ...
    ]
  }
}
```

Non-streaming responses use `response.body` instead of `response.sse_events`.

## Preflight checks

Every run validates the environment before doing anything destructive:

| Check | Failure behavior |
|---|---|
| Node.js ≥ 20 | error + upgrade hint |
| `mitmweb` on PATH | error + per-platform install command |
| `claude` on PATH | error + install link |
| mitmproxy ≥ 10 | error + upgrade command |
| `~/.mitmproxy/mitmproxy-ca-cert.pem` exists | error + "run mitmweb once" hint |
| Three ports free (or auto-picked) | auto-pick next free; hard error only if you passed `--port-*` explicitly |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` env | soft warning (claude may use a config file instead) |

### Platform notes

| Platform | Browser open | Notes |
|---|---|---|
| macOS | `open` | Default well-supported |
| Linux | `xdg-open` | Available on most desktop distros |
| Windows | `cmd /c start` | claude / mitmweb usually installed as `.cmd` wrappers — handled via `shell: true` in spawn |

On Windows, the mitmproxy CA cert lives at `%USERPROFILE%\.mitmproxy\mitmproxy-ca-cert.pem` — the CLI uses `os.homedir()` so it works without modification.

## Security

⚠️ Captures contain **real API tokens, full conversation history, and any code/secrets you pasted into Claude**.

- The default `~/.claude-capture/captures/` lives outside any git repo — never accidentally committed
- Don't paste raw captures into issues / chats / 3rd-party tools
- To redact before sharing:

  ```bash
  jq 'del(.request.headers["x-api-key"], .request.headers.authorization)' \
    ~/.claude-capture/captures/xxx.json > sample.json
  ```

- Periodic cleanup:

  ```bash
  rm -rf ~/.claude-capture/captures/
  ```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `mitmproxy CA cert missing` | haven't run mitmweb yet | `mitmweb` once, Ctrl+C after the proxy starts |
| Claude Code reports TLS errors | `NODE_EXTRA_CA_CERTS` not picked up | make sure you're on Node ≥ 20 and launching via `claude-capture` (not bare `claude`) |
| No captures appearing | claude bypassing proxy | verify `echo $HTTPS_PROXY` inside claude's env |
| `mitmweb: command not found` | mitmproxy not installed | see [One-time setup](#1-install-mitmproxy) |
| Banner says `port X busy → using Y` | another process on a default port | no action needed — auto-picked. Or use the printed URL |
| `port X (Y) is already in use — free it or pick a different --port-Y` | you passed `--port-*` explicitly and that port is taken | either free the port or remove the flag (let claude-capture auto-pick) |
| `no ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN in env` (warning) | soft warning — claude may use a config file | safe to ignore if claude works; otherwise export the env var |

## License

MIT
