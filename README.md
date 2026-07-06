# claude-capture

Capture and inspect Claude Code ↔ Anthropic HTTP traffic through a local mitmproxy, with a built-in visualization viewer. One command spins up the proxy, the viewer, and Claude Code itself — everything works out of the box.

## One-time setup

### 1. Install mitmproxy

```bash
brew install mitmproxy
```

### 2. Generate the mitmproxy CA cert

```bash
mitmweb
# wait for "Proxy server listening at *:8080", then Ctrl+C
ls ~/.mitmproxy/mitmproxy-ca-cert.pem   # should exist now
```

### 3. Install this CLI globally

From the project root:

```bash
npm install -g .
```

Verify:

```bash
claude-capture --help
```

## Daily use

From **any directory**:

```bash
cd ~/any-project
claude-capture
```

What happens:
- mitmproxy starts on `:8080` (loaded with the dump addon)
- viewer UI is served on `:8090` (browser auto-opens on macOS)
- claude launches with proxy env vars wired in

Use Claude Code normally. Every `/v1/messages` request gets dumped to `~/.claude-capture/captures/<timestamp>_<host>_<path>.json`, and shows up in the viewer (auto-refresh every 3s).

`Ctrl+C` exits claude → proxy and viewer clean up automatically.

## Options

```
claude-capture [--port-proxy <n>] [--port-viewer <n>] [--captures <path>] [--no-browser] [-- <claude-args>...]
```

| Flag | Default | Purpose |
|---|---|---|
| `--port-proxy` | `8080` | mitmproxy listen port |
| `--port-viewer` | `8090` | viewer HTTP port |
| `--captures` | `~/.claude-capture/captures` | JSON output directory |
| `--no-browser` | off | skip auto-opening the viewer |
| `-- <args>` | — | everything after `--` is forwarded to `claude` |

Examples:

```bash
# Custom ports (e.g. 8080 is taken)
claude-capture --port-proxy 9090 --port-viewer 9091

# Per-project captures
claude-capture --captures ./my-captures

# Pass-through args to claude
claude-capture -- --model opus-4-6 --resume

# Suppress the browser (you'll open it manually)
claude-capture --no-browser
```

## Viewer UI

The viewer at `http://127.0.0.1:8090` provides five tabs per capture:

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

## Requirements

- **Node.js ≥ 20**
- **mitmproxy ≥ 10** — install via:
  - macOS: `brew install mitmproxy`
  - Linux: `sudo apt install mitmproxy` (or `pip install mitmproxy`)
  - Windows: download the installer from <https://mitmproxy.org/downloads/> (or `pip install mitmproxy`)
- **Claude Code CLI** on PATH

The CLI preflights all of these on every run (Node version, binary presence, mitmproxy version, CA cert, port availability, optional Anthropic env vars) and exits with a clear hint if anything is missing.

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
| No captures appearing | claude bypassing proxy | verify `echo $HTTPS_PROXY` inside claude's env; check mitmweb isn't 8080-shadowed |
| `mitmweb: command not found` | mitmproxy not installed | `brew install mitmproxy` |
| Port already in use | another process on 8080/8090 | `claude-capture --port-proxy 9090 --port-viewer 9091` |
