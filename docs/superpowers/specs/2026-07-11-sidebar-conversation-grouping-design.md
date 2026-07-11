# Sidebar conversation grouping — design

**Date:** 2026-07-11
**Scope:** Viewer sidebar. Restructures the capture list from a flat per-session list of HTTP calls into a 3-level tree (session → conversation → turns) so the user can find and trace conversations instead of hunting for "where did this conversation start" among dozens of identical-preview rows.

## Problem

The user's primary workflow is **tracing a conversation flow**: following how a single user request turned into a multi-turn main-agent ↔ Claude exchange. The current sidebar defeats this workflow for a specific, structural reason.

`extractLastUserText` in `lib/server.mjs` walks back past `tool_result` messages to find the last real text user message. For a 5-turn conversation, all 5 captures therefore show the **same preview** — the user's original question — because every continuation turn's "last text user message" is still that original question. A session with 48 captures might contain only 6 conversations; the sidebar lists 48 rows whose previews repeat in blocks of ~8.

The user cannot spot where a conversation starts, cannot tell which captures are continuation turns of which conversation, and cannot collapse conversations they don't care about. Adding visual weight to "anchor" rows doesn't help, because every row already shows the anchor's text. The fix has to be structural.

## Approach

Group captures into conversations at the presentation layer. The server classifies each capture as an **anchor** (new human turn) or a **continuation** (tool-result feedback), and computes a kind-appropriate preview. The frontend walks captures in chronological order within each session, starting a new conversation on every anchor and appending continuations. The sidebar becomes a 3-level tree: session → conversation → turns. Conversation headers carry the user's original message; nested turn rows carry a summary of what the assistant did.

This matches the workflow's mental model: the findable unit is the conversation, and reading a conversation top-to-bottom follows the flow.

## Design

### Classification: anchor vs continuation

A new pure function `classifyKind(data)` in `lib/server.mjs`, sibling to `classifyRequest`. Returns `"anchor"` or `"continuation"`.

Algorithm:
1. Get `messages` from `data.request.body.messages`. If missing or not an array → `"anchor"` (safe default — a parse-error row becomes a one-turn conversation).
2. Walk from the end of `messages`, find the last entry with `role === "user"`. If none → `"anchor"`.
3. Inspect that message's `content`:
   - Plain string → `"anchor"`.
   - Array containing any block with `type === "tool_result"` → `"continuation"`.
   - Array with only `type === "text"` (or other non-tool-result) blocks → `"anchor"`.

The `kind` field is added to `ListItem` alongside the existing `tag` field (from the prior subagent-tagging feature).

### Preview extraction

The `preview` field remains the single display-ready string per row, but its derivation now branches on `kind`:

- **Anchor** → `extractLastUserText(data)` (existing function, unchanged). Returns the user's original message text.
- **Continuation** → new `extractAssistantAction(data)` function. Returns a summary of what the assistant did on this turn.

`extractAssistantAction` algorithm:
1. Get `messages`. Walk from the end, find the last entry with `role === "assistant"`. If none → `"(no assistant turn)"`.
2. Inspect content blocks, skipping `type === "thinking"`.
3. Collect `tool_use` blocks. If present:
   - Format each as `ToolName · brief_input` using the field-extraction map below.
   - Single tool call: emit the formatted string.
   - Multiple tool calls: emit the first formatted string + ` + N more` where N is the remaining count.
4. Else if `text` blocks exist: emit a quoted snippet of the first text block, truncated to 60 chars. E.g. `"I'll start by examining..."`.
5. Else: `"(empty assistant turn)"`.

**Field-extraction map** (which input field to show per well-known tool, with truncation to ~40 chars):

| Tool name | Field | Example output |
|---|---|---|
| `Read`, `Edit`, `Write` | `file_path` | `Read · src/auth.ts` |
| `Bash` | `command` | `Bash · npm test` |
| `Grep`, `Glob` | `pattern` | `Grep · "signup"` |
| `Agent`, `Task` | `description` | `Agent · explore the auth module` |
| `WebFetch` | `url` | `WebFetch · https://example.com/...` |
| `WebSearch` | `query` | `WebSearch · mitmproxy addon api` |
| (unknown tool) | (none) | `SomeToolName` |

The map is a plain object lookup; unknown tools fall through to name-only. No open-ended parsing — bounded logic.

**Wiring in `listCaptures`** (lib/server.mjs):

```js
const kind = classifyKind(data);
const preview = kind === "continuation"
  ? extractAssistantAction(data)
  : extractLastUserText(data);
const item = {
  name: childRel,
  mtime: stat.mtimeMs,
  size: stat.size,
  status: data.response?.status_code,
  preview: preview?.slice(0, 80) ?? "(empty)",
  tag: classifyRequest(data),
  kind,
};
```

The existing cache identity guarantee (ListItem object reference stability for downstream React `memo`) is preserved: the cached object simply carries two more fields (`tag` already exists, `kind` is new).

### Tree structure & grouping

The sidebar grows from 2 levels to 3: **session → conversation → turns**.

Grouping lives in `web/src/lib/groupSessions.ts` (extended, not a new module — it already owns tree-building for the sidebar).

**Types:**

```ts
export interface ConversationNode {
  type: "conversation";
  key: string;              // namespaced: `${sessionKey}#${anchorCaptureName}`
  anchorItem: ListItem;     // the anchor capture (rendered as the conversation header)
  turns: ListItem[];        // continuation captures only, oldest-first
  turnCount: number;        // turns.length + 1 (the anchor)
  startTime: number;        // anchorItem.mtime
  endTime: number;          // last turn's mtime (or anchor's if no turns)
  tag?: string;             // inherited from anchorItem.tag — whole conversation shares one category
}

export interface SessionNode {
  type: "session";
  key: string;
  name: string;
  conversations: ConversationNode[];  // sorted newest-first by endTime
  utilityBucket: ListItem[];          // utility-tagged captures, oldest-first; not conversations
  newestMtime: number;                // max endTime across conversations (utility ignored)
  captureCount: number;               // conversations + utility, for the header badge
}
```

**Utility captures bypass conversation grouping.** A `count_tokens` or title-generation request has a text user message, so `classifyKind` returns `"anchor"` — but it is not a real conversation. If treated normally, every utility call would spawn its own single-turn "conversation," producing 15+ garbage headers per busy session. Instead, `buildConversations` filters items with `tag === "utility"` into the session's `utilityBucket` *before* the walk; they never become conversations.

**Grouping algorithm** (new `buildConversations(items)` helper, called per session):

1. Partition items: `conversational = items.filter(i => i.tag !== "utility")`, `utility = items.filter(i => i.tag === "utility")`. Return both.
2. Sort `conversational` by mtime ascending (oldest-first).
3. Walk in order, maintaining `current: ConversationNode | null`:
   - `kind === "anchor"` (or `kind` missing, for backward compat): push `current` to the results if set, then start a new `current` with this item as anchor and `turns = []`.
   - `kind === "continuation"`: append to `current.turns`. If `current` is null (orphan continuation — e.g. anchor had a parse error and fell back to `"anchor"` anyway, so this branch shouldn't fire in practice), synthesize a conversation treating this item as the anchor.
4. After the loop, push the trailing `current`.
5. Sort results by `endTime` descending (most recent conversation on top).
6. `utility` stays oldest-first; no further grouping.

`buildTree` then assembles `SessionNode[]` by:
1. Splitting items by session key (existing logic).
2. Per session, calling `buildConversations`.
3. Sorting sessions by `newestMtime` descending (existing logic).

**`flattenVisible` emits four row types:**
- Session header (existing).
- Conversation header (new) — keyed by `conversation.key`.
- Turn leaf (continuation only) — keyed by capture name (existing).
- Utility bucket header + utility leaves — keyed by `${sessionKey}#utility` for the header; utility leaves keyed by capture name. Only emitted when `utilityBucket.length > 0`.

The existing `collapsedKeys: Set<string>` in `ConversationList.tsx` already handles arbitrary keys; conversation and utility-bucket keys are namespaced (`${sessionKey}#${anchorCaptureName}`, `${sessionKey}#utility`) to avoid collision with session keys. No new state structure.

### Rendering & default expansion

Four row types in the virtualized list:

| Row type | Content | Visual weight |
|---|---|---|
| Session header | Caret + session key + total capture count | Unchanged from today |
| **Conversation header** (new) | Caret + anchor preview (bold) + meta (`N turns · HH:mm:ss`) + left-edge stripe by `tag` | Heavy — the new "findable" unit |
| Turn leaf | Assistant-action preview (smaller, lighter) + meta (status · time · size) | Light — indented, scannable when expanded |
| Utility bucket header | Caret + `Utility calls` + count badge (e.g. `[15]`); rendered at the bottom of the session | Muted — collapsed by default, expands to a flat list of utility captures |

**The anchor IS the conversation header.** It does not also render as a leaf. A 1-turn conversation (anchor only, no continuations) shows just the header with no nested rows.

**Stripe migration:** the left-edge stripe introduced for the tag feature moves from per-row to per-conversation-header. The whole conversation shares the anchor's `tag`, so the stripe belongs on the header. Individual turn leaves have no stripe — keeps them visually quiet and lets the headers stand out.

**Default expansion** (initial state on first data arrival):
1. Newest session expanded.
2. Within the newest session, newest conversation expanded.
3. All utility buckets collapsed.
4. Everything else collapsed.

This opens the viewer directly to "what just happened" without drowning in old turns or utility noise.

**Active row** (currently selected capture) still uses the existing sage-bright stripe + gradient background. If the active capture is a continuation leaf inside a collapsed conversation (or a utility leaf inside a collapsed bucket), the frontend auto-expands its ancestor on the next render by removing the ancestor's key from `collapsedKeys`. This generalizes the existing session-auto-expand logic to the conversation and utility levels.

### Sort order summary

| Level | Order | Rationale |
|---|---|---|
| Sessions | Newest-first | "What session did I just run" at the top — existing behavior |
| Conversations within session | Newest-first | Most recent conversation at the top, same chat-app pattern |
| Turns within conversation | Oldest-first | Chronological top-to-bottom reading for tracing the flow |

## Edge cases & error handling

- **Parse-error rows** (`server.mjs` fallback): omit `kind`; frontend treats missing `kind` as `"anchor"`, so the row becomes a single-turn conversation. No crash.
- **Orphan continuation** (kind is continuation but no preceding anchor): the grouping algorithm synthesizes a conversation with the orphan as anchor. Should not fire in practice (Section 1's fallback defaults unknowns to anchor).
- **Missing `messages` / missing assistant message**: `classifyKind` returns `"anchor"`; `extractAssistantAction` returns `"(no assistant turn)"`. Graceful.
- **`content` as string vs array**: both handled by `classifyKind` (string → anchor; array → inspect block types).
- **Subagent conversations**: a subagent's first `/messages` call has a text user message (its task description), classifying as anchor. The subagent's conversation appears as a sibling to main-agent conversations in the same session, visually distinguished by its `tag` stripe (purple/green). No parent-child nesting — see "Out of scope".
- **Old capture files (without `kind`)**: frontend treats missing `kind` as `"anchor"`; each becomes its own single-turn conversation. No migration needed.
- **Conversation with 0 continuations** (1-turn): header renders, no nested leaves. The caret still toggles (to no effect) for consistency, or could be hidden — implementation detail.

## Testing

Per `CLAUDE.md`: no test suite exists, no test framework will be added. Verification is manual:

1. **Classification correctness** — one-shot Node script over every capture in `~/.claude-capture/captures/` that imports the new logic and prints: distribution of `kind` values, plus per-session breakdown (conversation count vs. utility count vs. total captures). Expect: anchor count ≈ conversation count + utility count; continuation count ≈ total − anchors; utility count matches the earlier `tag === "utility"` population (~15 in the observed corpus).
2. **Preview sanity** — sample 5 continuation captures and eyeball that `extractAssistantAction` produces useful summaries (e.g. `Read · src/auth.ts`, not garbage).
3. **Visual verification** — rebuild the viewer, run `claude-capture`, expand a session with mixed main + subagent traffic, confirm:
   - Conversations are grouped with headers showing the user's original message.
   - Turn leaves show assistant-action summaries, not the user's repeated question.
   - Default expansion opens to the newest conversation; utility bucket stays collapsed at the bottom.
   - Stripe appears on conversation headers, not on turn leaves.
   - Subagent conversations are visually distinguishable via stripe color.
   - Utility captures are sequestered in the bucket, not scattered as single-turn conversations.

Scripts live in `/tmp` and are not committed.

## Out of scope

These are explicitly excluded to keep the change focused. They may be future extensions.

- **Subagent nesting under parent turn.** A subagent's conversation appears as a sibling, not nested under the main-agent turn that spawned it. Correlating them needs a fragile heuristic (main-agent turn containing `Agent` tool_use → next subagent conversation in time order) that can mismatch. The stripe distinguishes subagent conversations without nesting.
- **Search / text filter / tag filter.** The grouping itself is the navigation improvement; filters are a separate feature.
- **Diff view (side-by-side capture comparison).**
- **Changes to `bin/claude-capture.mjs` or `lib/addon.py`.** Pure viewer-side change.

## Files touched

| File | Change |
|---|---|
| `lib/server.mjs` | Add `classifyKind(data)` and `extractAssistantAction(data)`; branch preview on kind; emit `kind` field on `ListItem` |
| `web/src/types.ts` | Extend `ListItem` with `kind?: "anchor" \| "continuation"` |
| `web/src/lib/groupSessions.ts` | Add `ConversationNode` type, `buildConversations` helper, 3-level `buildTree`, updated `flattenVisible` to emit conversation-header rows |
| `web/src/components/ConversationList.tsx` | Render three row types; default expansion (newest session + newest conversation); collapse keys namespaced per conversation; auto-expand ancestor on active |
| `web/src/styles/global.css` | Conversation-header styles (bold preview, turn-count meta, left-edge stripe migrated from per-row); turn-leaf styles (smaller, lighter, indented, no stripe) |

Five files, all small surgical edits. No new dependencies. No build changes. No changes to `bin/`, `lib/addon.py`, or `package.json`.
