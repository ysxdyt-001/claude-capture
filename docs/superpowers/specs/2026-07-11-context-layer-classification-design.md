# Context-layer classification — design

**Date:** 2026-07-11
**Scope:** Viewer sidebar. Adds two classification dimensions that surface the session's context architecture: (1) **subagent nesting** — subagent conversations appear as children of the specific main-agent turn that spawned them, rather than as flat siblings; (2) **compression-boundary detection** — a future-proofing hook that renders a "context compressed" divider inside the main thread whenever Claude Code auto-compacts context. Together these make the sidebar reflect how work actually flowed: a main spine with branches, and visible seams where history was compressed.

## Problem

The prior conversation-grouping feature restructured the sidebar from a flat capture list into a session → conversation → turns tree. But two aspects of the session's real architecture are still invisible:

1. **Subagent conversations are siblings, not children.** When the main agent dispatches a subagent (via the `Agent` tool), that subagent runs its own separate `/messages` conversation. Today both the main-agent and subagent conversations appear as flat entries in the session's conversation list. A flow like "main did X → spawned subagent → subagent did Y → main continued with Z" reads as three disconnected conversations, losing the causal nesting.

2. **Context compression is undetected.** When Claude Code's context approaches the limit, it summarizes prior turns and re-sends with a shorter history. This is a meaningful structural event — the conversation's history resets — but the sidebar has no concept of it. Today this never fires (the user is on a 1M-context model, and all captured sequences grow monotonically). It will matter when the user switches to a smaller-context model.

## Approach

**Subagent nesting** uses prompt-substring matching to link each subagent conversation to the main-agent turn whose `Agent` tool_use spawned it. The `Agent` tool_use carries a `prompt` field; the spawned subagent's first user message contains that exact prompt as a substring. This deterministic match (confirmed by time-order tiebreak) produces a `parentId` on each subagent's anchor capture. The frontend's grouping logic uses `parentId` to pull matched subagent conversations out of the top-level list and nest them under the specific parent turn, rendered inline at depth 3.

**Compression detection** adds a third `kind` value (`"compressed"`) via three signals: message-count drop, summary-style first-user-message text, and API-field presence. Today none fire; the logic ships inert and activates automatically when compression eventually occurs. A compressed capture is treated as a continuation of the current conversation (not a new one), but a thin non-interactive divider row renders above it inside the turn list.

## Design

### Subagent linkage algorithm

A new server-side pass, `linkSubagents(items)`, runs after `listCaptures` has built all items but before returning them. Per session:

**Step 1 — Collect dispatch fingerprints.** Walk main-agent captures in time order. For each, scan its assistant turns for `tool_use` blocks with `name === "Agent"` or `name === "Task"`. For every one found, record:

```js
{
  toolUseId,                 // the tool_use id (e.g. "call_ccf63ada...")
  parentCapture,             // the main-agent capture filename containing this tool_use
  promptHead: prompt.slice(0, 100),   // first 100 chars of the prompt field
  description,               // the Agent tool_use's description field
  subagentType,              // e.g. "general-purpose", "Explore"
  dispatchedAt: mtime,       // for tiebreak
}
```

**Step 2 — Match subagent anchors.** For each subagent/explore anchor capture, extract the first user-role message's text content. Check whether it contains any fingerprint's `promptHead` as a substring. The match is: `subagentFirstUserText.includes(fingerprint.promptHead)`.

**Step 3 — Emit `parentId`.** On match, the subagent anchor's `ListItem` gains `parentId: fingerprint.parentCapture` (the main-agent capture filename). Unmatched subagents keep `parentId: undefined` and remain top-level siblings (the current behavior).

**Step 4 — Time-order tiebreak.** If two fingerprints both match the same subagent (unlikely but possible with reused task descriptions), pick the one whose `dispatchedAt` is closest to but before the subagent's mtime.

The `parentId` field flows through `/api/files` to the frontend. The frontend grouping uses it to nest.

**Why prompt-matching over pure time-order:** parallel subagent dispatches (two `Agent` calls in the same main-agent turn) would interleave in time order with no reliable way to tell which subagent belongs to which dispatch. Prompt-matching resolves the ambiguity deterministically.

### Compression boundary detection

The `kind` field gains a third value. `classifyKind` returns one of `"anchor" | "continuation" | "compressed"`. Three signals are consulted in order within an expanded `classifyKind`:

**Signal 1 — message-count drop.** Requires cross-capture state. Implemented as a second pass `detectCompressions(items)` that runs per session over the main-agent anchor sequence (sorted by mtime). If capture N+1's message count drops by more than 20% OR by more than 10 messages (whichever threshold is smaller) relative to capture N's count, capture N+1's `kind` is overwritten from `"anchor"` to `"compressed"`. Today: sequences grow +2 per turn monotonically; this never fires. This pass mutates the already-cached `ListItem` objects in-place — the mutation is idempotent (same input → same `kind`), so subsequent polls that hit the cache see the correct value.

**Signal 2 — summary-style first user message.** Within `classifyKind` itself: if the last user message is text (would otherwise classify as `"anchor"`) AND its first 300 chars contain any of the phrases `"summary of"`, `"previously, on"`, `"conversation so far"`, `"the user and assistant have been discussing"`, return `"compressed"`. Today: zero hits.

**Signal 3 — API field presence.** Within `classifyKind`: if the request body contains any top-level field whose name includes `"compact"` (e.g., a future `is_compact` or `compacted_until`), return `"compressed"`. Today: no such fields exist.

**Interaction with grouping.** A compressed capture is NOT a new conversation. The user didn't send a new message; Claude Code re-sent with shorter history. So in the grouping walk:

- `kind === "anchor"` → starts a new conversation (current behavior)
- `kind === "continuation"` → appends to current conversation (current behavior)
- `kind === "compressed"` → **also appends to current conversation**, but the frontend renders a divider row above this turn inside the conversation

This keeps the main thread readable as one continuous conversation with visible compression seams, rather than fragmenting into separate conversation headers at every compaction.

### Tree structure for nested subagents

`SessionNode` gains one field:

```ts
interface SessionNode {
  type: "session";
  // ...existing fields...
  nestedByParent: Map<string, ConversationHeaderNode[]>;  // parent capture name → nested subagent conversations
}
```

**Grouping change in `groupSessions.ts`:**

1. Build all conversations (main + subagent + explore) as today — **but the walk's continuation condition changes** from `c.kind === "continuation"` to `c.kind !== "anchor"`. This treats both `"continuation"` and `"compressed"` as appends to the current conversation, so a compressed capture stays in its conversation rather than starting a new one.
2. Walk the subagent/explore conversations. Any whose anchor has `parentId` set gets **pulled out** of the top-level `conversations` array and into `nestedByParent[parentId]`.
3. Main-agent conversations and unmatched subagent conversations (no `parentId`) stay top-level.

**`flattenVisible` emits nested conversations inline after their parent turn:**

```
Session header                                    (depth 0)
  Main conversation header                        (depth 1)
    Turn: Read src/auth.ts                        (depth 2)
    Turn: Agent · explore auth                    (depth 2)
      Nested subagent conversation header         (depth 3)
        Turn: Grep · "auth"                       (depth 4)
        Turn: Read · src/auth.ts                  (depth 4)
      Nested subagent conversation header         (depth 3)  ← second parallel subagent
        Turn: ...
    Turn: Edit src/auth.ts                        (depth 2)  ← main thread resumes
  Next main conversation header                   (depth 1)
```

The walker, after emitting each turn leaf, checks `nestedByParent[turn.captureName]`. If present, it emits each nested conversation header + (if expanded) that conversation's turns, indented one level deeper.

**Collapse state:** nested sub-conversations use their existing conversation key (`${sessionKey}#${anchorName}`), so the same `collapsedKeys: Set<string>` handles them. Collapsing the parent main-agent conversation hides its nested sub-conversations along with its own turns — the emit-check is inside the parent's expansion guard, so no special logic is needed.

**Default expansion:** nested sub-conversations start **collapsed** even when their parent main conversation is expanded. You see "this turn spawned 2 subagents" (two collapsed depth-3 headers) without being forced to read all their turns.

**Parallel subagent dispatches** (multiple `Agent` tool_use blocks in one main-agent turn) produce multiple entries in `nestedByParent[parentCaptureName]`, rendered as stacked depth-3 conversation headers.

**Depth & padding:** the existing `paddingLeft: ${24 + node.depth * 16}px` formula generalizes. Nested headers at depth 3 indent further than main turns at depth 2.

### Compression divider rendering

A new lightweight `DividerNode` joins the `TreeNode` union:

```ts
interface DividerNode {
  type: "divider";
  depth: number;          // matches the turn-leaf depth (2 for main thread)
  key: string;            // `${captureName}#divider`
  label: string;          // "context compressed"
}
```

`flattenVisible` emits a `DividerNode` immediately before any `LeafNode` whose `item.kind === "compressed"`. The renderer draws a thin, non-interactive row: `┄┄┄ context compressed ┄┄┄` — muted text-faint color, thin top border, no caret, no click, no hover. A visual seam only.

Today: zero dividers render. Tomorrow (smaller-context model): dividers appear at compaction boundaries inside the main thread's turn list.

### Auto-expand-on-active (extended)

The existing auto-expand effect generalizes to nested conversations. When `selectedName` matches a capture inside a nested subagent conversation, the effect must remove from `collapsedKeys`:
1. The nested conversation's own key.
2. The parent main-agent conversation's key (so the parent turns are visible).
3. The parent session's key (so the conversation is visible).

The effect walks `nestedByParent` to trace ancestry. For top-level selections (main-agent turns, unmatched subagent conversations, utility captures), the existing logic applies unchanged.

### Edge cases & error handling

- **Linkage misses (no `parentId`):** the subagent conversation stays as a top-level sibling. Current behavior preserved. No crash.
- **Linkage ambiguity (two fingerprints match):** time-order tiebreak picks the nearest preceding dispatch. If still ambiguous (same description, overlapping time), the first fingerprint wins. Deterministic.
- **`Agent` tool_use with empty/missing `prompt` field:** fingerprint's `promptHead` is empty string; every subagent's first-user-text trivially "includes" it. Guard: skip fingerprints whose `promptHead.length < 20` (too short to be a reliable signal). Such dispatches go unmatched; subagent stays top-level.
- **Compression detection false positive** (e.g., a genuine user message that happens to start with "summary of"): signal 2 could misfire. Mitigated by requiring BOTH a text first-user-message AND the phrase match. The divider rendering is reversible — a misfire shows one extra divider, not data loss.
- **Old captures (no `parentId`, no `compressed` kind):** frontend treats missing `parentId` as "top-level" and missing/unknown `kind` as `"anchor"`. No migration.
- **Subagent-of-subagent (a subagent dispatches its own subagent):** the linkage algorithm treats all `Agent` dispatches uniformly regardless of which context dispatched them. If a subagent's capture contains an `Agent` tool_use and a later sub-subagent's first message matches its prompt, the sub-subagent nests under the subagent's turn (depth 5+). The depth model supports this structurally. Not specifically tested — rare in practice.

## Testing

Per `CLAUDE.md`: no test suite exists, no test framework will be added. Verification is manual:

1. **Linkage correctness** — one-shot Node script over every capture. For each subagent/explore anchor, print whether a `parentId` was assigned and (if so) the parent capture's filename + the matched `description`. Eyeball that the linkage is sensible (e.g., the subagent whose first message mentions "Implement Task 2" links to the main-agent capture whose `Agent` tool_use description is "Implement Task 2: virtualizer"). Count unmatched subagents — should be small.
2. **Compression detection sanity** — print every capture whose `kind === "compressed"`. Expected: zero today. If any fire, investigate (likely a false positive in signal 2's phrase matching).
3. **Visual verification** — rebuild viewer, run `claude-capture`, expand a session that dispatched subagents. Confirm:
   - Subagent conversations appear nested under the dispatching main-agent turn, not as top-level siblings.
   - Nested sub-conversation headers carry the purple/green stripe and are collapsible independently.
   - Selecting a turn inside a nested subagent auto-expands the whole ancestry.
   - No compression dividers render (expected today).
   - Unmatched subagents still appear as top-level siblings.

Scripts live in `/tmp` and are not committed.

## Out of scope

- **Compression summary content rendering.** The divider says "context compressed"; we don't expand or render the actual summary text.
- **Re-linking when captures arrive out of order.** The linkage pass runs on every `listCaptures` call (every 3s poll), so it's eventually consistent. No special handling for partial sessions.
- **Subagent-of-subagent specific testing.** Supported structurally; not exercised.
- **Search / filter / diff view.**
- **Changes to `lib/addon.py` or `bin/claude-capture.mjs`.** Pure viewer-side.

## Files touched

| File | Change |
|---|---|
| `lib/server.mjs` | Add `linkSubagents(items)` pass (fingerprint collection + prompt-substring match + `parentId` emission); expand `classifyKind` with compression signals 2 and 3; add `detectCompressions(items)` pass for signal 1 |
| `web/src/types.ts` | Extend `ListItem.kind` to `"anchor" \| "continuation" \| "compressed"`; add `parentId?: string` |
| `web/src/lib/groupSessions.ts` | Add `nestedByParent` to `SessionNode`; add `DividerNode` to `TreeNode` union; pull matched subagent conversations into `nestedByParent`; `flattenVisible` emits nested + divider |
| `web/src/components/ConversationList.tsx` | Render `DividerNode`; extend auto-expand-on-active to trace ancestry via `nestedByParent` |
| `web/src/styles/global.css` | `.divider` styles (thin, muted, non-interactive). Nested headers need no new CSS — depth + existing stripe handle it. |

Five files, all small-to-moderate edits. No new dependencies. No build changes. No changes to `bin/`, `lib/addon.py`, or `package.json`.
