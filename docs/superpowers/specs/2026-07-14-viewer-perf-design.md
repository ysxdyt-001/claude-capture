# Viewer Performance Design

**Date:** 2026-07-14
**Scope:** `web/` (viewer UI only). No changes to CLI, addon, or backend.

## Problem

A single capture's request payload can be very large (Claude Code sends a
multi-KB system prompt plus the full prior conversation history, including
pasted files and tool outputs). The current viewer renders every message,
every tool call, and every tool result into the DOM at once, and recomputes
all markdown / JSON highlighting on every React render. The result is severe
scroll and interaction lag on real-world captures.

## Root Causes (confirmed by reading the code)

1. **Zero memoization.** `ConversationTab.tsx` calls
   `rebuildAssistantFromSSE(sse)` and `buildConversationItems(all)` on every
   render. `Message.tsx` calls `smartRender(content)` on every render.
   `App.tsx` polls `fetchFiles` every 3 seconds, which gives `App` a new
   `items` array reference. Because nothing in the subtree is wrapped in
   `React.memo`, **every `Message`/`ToolPair`/`ToolResult` re-renders every
   3 seconds**, recomputing all markdown and highlighting each time.

2. **Per-chunk `escapeHtml` in tight loops.** `code.ts:163-168`
   (`highlightCode`) and `json.ts:38-75` (`highlightJSON`) call `escapeHtml`
   (5 regex replaces) once per character or word. A 5000-line `Read` result
   triggers tens of thousands of `escapeHtml` calls.

3. **`looksLikeJSON` runs a full `JSON.parse` on every `smartRender` call**
   (`json.ts:3-10`), throwing and catching for every non-JSON text block,
   including large markdown blobs.

4. **No virtualization.** Hundreds of tool calls produce thousands of DOM
   nodes that all live simultaneously, causing layout thrash on scroll.

5. **`CollapseWrap` does not save compute.** `ToolResult.tsx:59-61` builds the
   full `bodyHtml` *before* deciding whether to collapse. Only layout cost
   is avoided; the expensive markdown / highlight work is still done up
   front.

## Approach

Two layers, applied together. No new runtime dependencies. No DOM-structure
changes. No new tabs.

- **Layer A — Memoization.** Eliminate redundant recompute on rerender.
- **Layer B — Progressive disclosure.** Eliminate up-front compute for large
  messages by rendering a preview and building full HTML lazily on expand.

List virtualization (a third layer using `react-window` or a custom
`IntersectionObserver` scheme) is explicitly **out of scope** for this
iteration. It can be revisited if A + B prove insufficient on pathological
captures.

## Layer A — Memoization

### A.1 Derived-timeline memoization

`ConversationTab.tsx`: wrap `rebuildAssistantFromSSE(sse)` and
`buildConversationItems(all)` in `useMemo` keyed on the `capture` object's
identity. Toggling a filter chip must not re-derive the timeline — it only
re-filters `items`.

### A.2 `React.memo` on the heavy subtrees

Wrap `Message`, `ToolPair`, and `ToolResult` in `React.memo`. Their props
(`message`, `toolUse`, `toolResult`, `blocks`) keep stable identity across
the 3-second `fetchFiles` poll as long as the selected capture does not
change, so the memo skip kicks in and the entire subtree avoids rerender.

The `App.tsx:46` `onSelect` already uses `useCallback` for the same reason
(to keep `ConversationList` rows memoizable). This is the established idiom
in the codebase.

### A.3 Per-content HTML cache inside `Message` and `ToolResult`

The HTML string built by `smartRender(...)` is recomputed on every render
today. Move the build into a cache keyed on `JSON.stringify(message.content)`
(or, for `ToolResult`, on `JSON.stringify({content, toolUseName,
inputFilePath})`). Built once per capture, reused for the component's
lifetime, reused across rerenders.

### A.4 `looksLikeJSON` fast-path

Extend the cheap pre-check in `looksLikeJSON` (`json.ts:3-10`): return
`false` without invoking `JSON.parse` unless the trimmed string starts with
`{` or `[`. This removes the throw / catch cost for every non-JSON text
block. (`smartRender:11` already gates on the same regex; push the gate
into `looksLikeJSON` for the benefit of any direct caller.)

## Layer B — Progressive Disclosure

### B.1 New `MessageCollapse` component

File: `web/src/components/MessageCollapse.tsx`.

Applies to `user`, `assistant`, and standalone `tool_result` message bodies
when the rendered HTML exceeds **8 KB** or **100 lines**.

- **Collapsed state:** the first ~5 lines of content render normally, then
  a CSS mask gradient fades the next few lines into the page background.
  A full-width button bar below reads `▼ N more lines · expand`. The user
  can see what kind of content it is (markdown heading, code block, JSON
  blob, prose) before deciding to expand.
- **Expanded state:** the full content renders, followed by a
  `▲ collapse` button.

**Critical difference from the existing `CollapseWrap`:** the HTML for the
full content is **built lazily on first expand**, not on initial render.
This is what removes the up-front compute cost. The existing `CollapseWrap`
builds first and then toggles `display: none`; that pattern is preserved
for `ToolResult` (see B.3) but is not reused here because it does not
address the compute cost.

**Threshold check must be cheap.** The "over 8 KB / 100 lines" decision is
made on the *raw* content (string length and line count of
`message.content`), not on the rendered HTML. This is what makes the
preview path actually cheap: the renderer never invokes `smartRender` /
`highlightJSON` / `highlightCode` on a large body until the user expands
it. The raw-content length is a reliable proxy because markdown and
highlighting only add characters (escape sequences, span tags).

### B.2 Lazy-build memoization

Once the user expands a `MessageCollapse`, the built HTML is cached on the
component instance (via `useMemo` keyed on expand-count, or a `useRef`
guard). Subsequent collapse and re-expand reuse the cached HTML without
recomputing.

### B.3 Raise the `ToolResult` collapse threshold

`ToolResult.tsx:60-61` currently collapses when `bodyHtml.length > 1000 ||
lineGuess > 12`. Raise to `length > 8000 || lineGuess > 100` to match the
new threshold and stop collapsing ordinary tool results. The existing
`CollapseWrap` continues to wrap `ToolResult` bodies; its build-then-hide
behavior is acceptable here because tool results are typically much smaller
than full messages.

## Components Touched

| File | Change |
|---|---|
| `web/src/components/ConversationTab.tsx` | `useMemo` on derived timeline; ensure stable prop identity for children |
| `web/src/components/Message.tsx` | `React.memo`; cache `bodyBlocks.html`; wrap body in `MessageCollapse` when over threshold |
| `web/src/components/ToolPair.tsx` | `React.memo` |
| `web/src/components/ToolResult.tsx` | `React.memo`; raise threshold to 8 KB / 100 lines |
| `web/src/components/MessageCollapse.tsx` | **New file** — lazy-expand wrapper with preview + faded mask |
| `web/src/components/CollapseWrap.tsx` | Unchanged |
| `web/src/lib/markdown.ts` | No change (smartRender's gate stays) |
| `web/src/lib/json.ts` | Cheap pre-check in `looksLikeJSON` |
| `web/src/styles/*` | Add `.msg-collapse` styles (faded mask + button bar) |

## Data Flow

### Poll rerender (every 3 s)

```
App.poll → setItems (new ref) → App rerender
  → ConversationList rerenders (cheap; list of small rows, already memoized)
  → DetailPane receives same `capture` ref → React.memo on children skips
     ConversationTab.* useMemo returns cached value
     Message / ToolPair / ToolResult subtrees: SKIPPED
```

### First paint of a giant capture

```
ConversationTab builds items (useMemo runs once)
For each Message:
  small body (under 8 KB / 100 lines) → render inline
  large body → render preview + button only (full HTML not yet computed)
User clicks expand on a large message:
  → compute full HTML (memoized after first build) → inject
```

## Error Handling

No new failure modes. All existing renderers stay in place; they are simply
called less often and lazily. If a lazy build throws, the existing catch in
`smartRender`'s callers already falls back to a `<pre>` block.

## Testing

There is no test suite in this project (per `CLAUDE.md`). Verification is
manual:

1. Load a capture with a large system prompt and many tool calls.
2. Confirm initial paint is visibly faster than before.
3. Toggle each filter chip (`system`, `user`, `assistant`, `tool`) and
   confirm the change is instant (no recompute lag).
4. Expand a collapsed message; confirm the full content renders correctly
   and that collapse / re-expand does not recompute (observable via devtools
   performance trace).
5. Leave the viewer open for > 3 seconds and confirm the 3-second poll does
   not cause visible flicker or input lag.
6. Open `ResponseTab` and `RequestTab` on the same capture to confirm no
   regression there.

## Out of Scope

- List virtualization (`react-window` or equivalent).
- Web Worker offloading of markdown / highlighting.
- Backend pagination or streaming of capture files.
- Changes to `bin/`, `lib/`, or the addon.
- Any change to the `raw` / `sse` / `req` / `res` tabs.
