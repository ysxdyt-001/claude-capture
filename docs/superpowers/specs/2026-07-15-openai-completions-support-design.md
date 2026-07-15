# OpenAI-spec capture support in the viewer

**Date:** 2026-07-15
**Status:** Design — awaiting user review

## Motivation

`claude-capture` already captures OpenAI-spec traffic on disk — the addon path filter
(`lib/addon.py:33`) includes `/chat/completions` and `/completions`, and the orchestrator
supports third-party CLIs via `--claude <bin> / CLAUDE_CAPTURE_CLAUDE=<bin>`. So a
modified Claude Code variant (e.g. opencode) that talks an OpenAI-spec API produces
capture files just fine.

The **viewer**, however, was built around Anthropic's `/messages` shape. Feeding it an
OpenAI capture produces empty or broken Conversation / SSE Timeline tabs. The Raw JSON /
Request / Response tabs work (they only pretty-print bytes), but that is no better than
mitmweb's own Web UI — which defeats the point of this viewer.

Goal: make OpenAI-spec captures render with the same fidelity as Anthropic ones, across
all existing tabs, without doubling the component surface.

## Non-goals (YAGNI)

- `image_url` multimodal content parts (opencode is text-first; skip for v1).
- `logprobs`, `n > 1` multiple choices — only `choices[0]` is consumed.
- Legacy v1 `function_call` field on assistant messages (superseded by `tool_calls`).
- Addon changes (`/chat/completions` / `/completions` already captured).
- Orchestrator changes (`--claude` / `CLAUDE_CAPTURE_CLAUDE` already covers third-party CLIs).
- Session grouping for opencode — it does not send `x-claude-code-session-id`, so captures
  fall into the addon's `_FALLBACK_DIR`. Acceptable degradation for v1.

## Approach: boundary normalization + SseTimeline hint

Single adapter at the `/api/file` boundary. Sniffs the capture shape; if OpenAI-spec,
translates in memory to the existing Anthropic-shape `Capture`. All downstream components
(ConversationTab, ResponseTab, SseTimeline, buildConversationItems) keep one code path.

A `format: "openai" | "anthropic"` marker is attached so SseTimeline can label OpenAI
chunks honestly (`delta.content`, `delta.tool_calls[0]`, `[DONE]`) rather than faking
Anthropic event names.

Rejected alternatives:
- **Parallel render paths** (`detectFormat` + branch in every component): doubles
  maintenance; every future tab change has to touch two places.
- **Fake Anthropic event names in SseTimeline**: misleading when cross-referencing raw
  bytes — the whole point of that tab is ground truth.

## Shape detection

`detectFormat(capture)` returns `"openai"` when **any** of:

1. `capture.response.body` is an object with own property `choices` (array), OR
2. `capture.response.sse_events` has at least one entry whose `data` is an object with
   own property `choices` (array), OR
3. `capture.request.body` has `messages` (array) where any entry has own property
   `tool_calls` or `tool_call_id`, AND there is **no** top-level `system` field.

Otherwise `"anthropic"`. The third condition's `!system` guard prevents misclassifying an
Anthropic request that happens to use OpenAI-like nested shapes.

The check runs once per `fetchFile` call; it is O(events) at worst and trivial.

## Translation mapping

All translation lives in a new module `web/src/lib/openai.ts`. The internal model types
in `web/src/types.ts` are unchanged — OpenAI data is reshaped to fit them.

### Request side

| OpenAI shape | Internal Anthropic-shape |
|---|---|
| `messages[i]` with `role:"system"` | Pulled out and concatenated into top-level `req.system` (string). Multiple system messages join with `\n\n`. |
| `messages[i]` with `role:"user"`, `content` is string | `{role:"user", content: <string>}` (unchanged) |
| `messages[i]` with `role:"user"`, `content` is parts[] | `{role:"user", content: TextBlock[]}` — only `{type:"text"}` parts carried; unknown part types dropped |
| `messages[i]` with `role:"assistant"`, `content` + `tool_calls` | `{role:"assistant", content: ContentBlock[]}` = optional `TextBlock` (from `content` if non-empty) followed by one `ToolUseBlock` per `tool_calls[]` entry: `{type:"tool_use", id: tool_call.id, name: tool_call.function.name, input: JSON.parse(tool_call.function.arguments \|\| "{}")}`. Parse failure leaves `input` as the raw string. |
| `messages[i]` with `role:"tool"`, `tool_call_id`, `content` | Synthesized as `{role:"user", content: [{type:"tool_result", tool_use_id: tool_call_id, content: <content>}]}`. This lets `buildConversationItems` pair it with the matching `tool_use` via `tool_use_id`, rendering as one ToolPair card — identical to native Anthropic flow. |
| `messages[i]` with `role:"assistant"` and no `tool_calls` | `{role:"assistant", content: TextBlock[]}` (or string passthrough) |
| Top-level `tools: [{type:"function", function:{name, parameters}}]` | Rewritten to `req.tools: [{name: function.name, ...}]` so the "Tools declared" counter keeps working. Original `function.parameters` preserved on the object for Raw JSON. |
| `model`, `temperature`, `max_tokens`, `stream` | Passed through unchanged (same field names). |

### Response side — non-streaming

`capture.response.body.choices[0].message` is translated with the same assistant rule
above, then injected as the `rebuiltAssistant` for ConversationTab. The raw `body`
object is still available to ResponseTab.

`body.usage` (when present) maps to token counts if/where the viewer surfaces them — but
currently `inputTokens`/`outputTokens` on `ListItem` come from `lib/server.mjs`, not
the response body, so this mapping is non-load-bearing for v1.

### Response side — streaming SSE

OpenAI streams `data: {choices:[{delta:...}]}` lines with no `event:` field, terminated
by `data: [DONE]`. The addon's `_parse_sse` already produces `sse_events[]` entries; for
OpenAI chunks these have `event: undefined` and `data: {choices:[...]}`.

A new function `rebuildAssistantFromOpenAISSE(events)` walks these and produces a
`ContentBlock[]` suitable for ConversationTab:

1. Maintain a single `TextBlock` (created lazily on the first `delta.content`
   fragment) that accumulates all text fragments. It is **not** position-tracked —
   see emit order below. Tool-use blocks live in a separate `Map<index, ToolUseBlock>`
   with a parallel `order: number[]` capturing first-seen sequence.
2. For each event's `choices[0].delta`:
   - `delta.content` (string) → append to the text block.
   - `delta.tool_calls[]` → each entry has `index` (position) and optional `id`,
     `function.name`, `function.arguments` (fragment). Maintain a `Map<index, ToolUseBlock>`.
     First chunk for an index creates the block with `id` + `name`; subsequent chunks
     for that index append to `arguments` (string concat). On stream end, `JSON.parse`
     the accumulated arguments → `input`.
3. `data: "[DONE]"` (string) is recognized as terminator and ignored as content.
4. At end: emit `[TextBlock?, ...ToolUseBlocks sorted by first-seen index]`. Returns
   `null` if no content or tool_calls were seen.

The ordering decision (text-first, tools-after, in first-seen order) matches typical
OpenAI streaming (content completes before tool_calls begin) and what
`buildConversationItems` expects. Interleaved text-after-tool deltas still concatenate
into the leading TextBlock — the output order is fixed (text-then-tools) regardless of
arrival order, which is acceptable for v1 since the Raw JSON tab preserves ground truth.

### SseTimeline labeling

`SseTimeline` reads `capture._format`. When `"openai"`:

- Event name column shows a synthesized label derived from the chunk:
  - `delta.content` present → `delta.content`
  - `delta.tool_calls` present → `delta.tool_calls[${index}]`
  - `data === "[DONE]"` → `[DONE]`
  - otherwise → `—`
- Color classes reuse the existing buckets where it makes sense
  (`delta.content` → `delta` class; `delta.tool_calls[*]` → `tool_use` class).

When `"anthropic"` (or unset), behavior is unchanged.

### ResponseTab

The "Reassembled content blocks" panel calls `rebuildAssistantFromSSE` today. Extend it
to branch on `capture._format`: Anthropic path unchanged, OpenAI path calls
`rebuildAssistantFromOpenAISSE`. Both return `ContentBlock[] | null` with the same shape.

## Files touched

| File | Change |
|---|---|
| `web/src/lib/openai.ts` | **New.** `detectFormat`, `normalizeOpenAICapture`, `rebuildAssistantFromOpenAISSE`, request/response translators. |
| `web/src/lib/api.ts` | `fetchFile` post-processes the raw JSON: if `detectFormat === "openai"`, run `normalizeOpenAICapture` and set `_format`. |
| `web/src/types.ts` | Add `_format?: "openai" \| "anthropic"` to `Capture`. No other type changes. |
| `web/src/components/SseTimeline.tsx` | Read `_format`; branch on event-name labeling. |
| `web/src/components/ResponseTab.tsx` | Branch the "Reassembled content blocks" rebuild on `_format`. |
| `web/src/components/ConversationTab.tsx` | Branch the `rebuiltAssistant` useMemo on `capture._format`. |

Unchanged: buildConversationItems, Message, ToolPair, RequestTab,
RawJsonTab, all styles, the addon, the orchestrator, the server.

## Error handling

- `JSON.parse(tool_call.function.arguments)` failure → `input` falls back to the raw
  accumulated string; the block is still rendered (with a visible "parse failed" marker
  if the ToolPair component supports it, otherwise just as JSON).
- Malformed `choices[0]` (missing `delta`/`message`) → skip that event / choice; never
  throw. The Raw JSON tab is the ground-truth fallback.
- `detectFormat` ambiguity → defaults to `"anthropic"` (the historical behavior). Better
  to under-classify than to mistranslate a known shape.

## Testing strategy

No test suite exists in this repo (per `CLAUDE.md`). Verification is manual:

1. Capture an opencode session (or any OpenAI-spec CLI) via `claude-capture --claude opencode`.
2. Open the viewer; pick a capture file.
3. Confirm: Conversation tab shows system/user/assistant turns and tool pairs correctly;
   SSE Timeline labels chunks as `delta.content` / `delta.tool_calls[*]` / `[DONE]`;
   Response tab's "Reassembled content blocks" mirrors what Conversation shows.
4. Confirm Anthropic captures are unaffected (regression): open a native Claude Code
   capture and check that all four tabs render exactly as before.

If a representative OpenAI capture JSON is available offline, it can be dropped into the
captures dir directly (without running opencode) to drive step 2–3.
