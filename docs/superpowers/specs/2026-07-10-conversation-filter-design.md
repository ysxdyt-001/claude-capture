# Conversation filter mode — design

**Date:** 2026-07-10
**Scope:** Conversation tab only. Adds multi-select filter chips so the user can hide/show conversation items by type (system / user / assistant / tool).

## Problem

Long captures contain many tool calls, thinking blocks, and system prompts interleaved with the actual user↔assistant dialogue. There is no way to focus on a subset — e.g. "hide all tool calls to read just the prose" requires scrolling past every tool card. A filter mode lets the user collapse the view to the item types they care about.

## Approach

Multi-select toggle chips rendered inline with the existing `Conversation · N turns` section header. All four buckets default ON; tapping a chip toggles its visibility. State lives in `ConversationTab` component state so the filter persists while browsing captures in the same session.

## Design

### Filter buckets

A new local type in `ConversationTab.tsx`:

```ts
type Bucket = "system" | "user" | "assistant" | "tool";
```

Mapping from `ConversationItem` (defined in `lib/conversation.ts`) to a bucket:

| ConversationItem kind | Bucket |
|---|---|
| `system` | `system` |
| `user` | `user` |
| `assistant` | `assistant` |
| `tool-pair` | `tool` |
| `other` | none — always visible |

The `other` kind is a rare fallback for unknown roles. It has no chip and is always shown, because the user cannot toggle it.

A pure helper `bucketOf(item): Bucket | null` encodes this mapping.

### State

```ts
const [filter, setFilter] = useState<Record<Bucket, boolean>>({
  system: true,
  user: true,
  assistant: true,
  tool: true,
});
```

Lives in `ConversationTab`. When the user switches captures, `ConversationTab` receives a new `capture` prop but its `useState` is preserved (same component instance, keyed by position in the tree), so the filter survives capture browsing. No `localStorage`, no cross-session persistence (YAGNI).

### Derived view

```ts
const visibleItems = items.filter(
  (it) => bucketOf(it) === null || filter[bucketOf(it)!],
);
```

The existing `items.map(...)` renders `visibleItems` instead of `items`.

### Counts

Each chip shows `label · count`, where `count` is the **total** number of items of that bucket in this capture (computed once from `items`, independent of the filter state). Toggling a chip does not change any chip's number — this is less confusing than counts that shift as you toggle.

### Chip UI

The chips render inline in the `h3.section` header, to the right of the existing `Conversation · N turns …` text. The `h3.section` already uses `display: flex; align-items: center; gap: 14px`. Today `h3.section::after` is a gradient line with `flex: 1`. To make room for chips: give `.conv-filter` (the chip group) `margin-left: auto` and change `h3.section::after` from `flex: 1` to a fixed width (e.g. `width: 40px`) so it becomes a short trailing accent rather than a full-width rule. The chip group is a `<div class="conv-filter">` containing four `<button class="conv-chip">` elements, appended as the last child of the `h3.section`.

Chip states:
- **Active (on):** background `--sage-dim`, text `--sage-deep`, border `rgba(90,125,82,0.25)` — matches the existing `badge.ok` look so it reads as "selected".
- **Inactive (off):** transparent background, border `--line`, text `--text-faint`.

Each chip button has `type="button"` (avoid form submit), `aria-pressed={filter[b]}`, and toggles `filter[b]` on click.

### Empty state

If `visibleItems.length === 0` (everything toggled off), render a muted placeholder instead of the list:

```tsx
<div className="conv-empty">all types hidden — toggle a filter to show items</div>
```

Styled with `--text-faint`, centered, small padding.

### Header text

The existing `Conversation · {textTurnCount} turns · {toolPairCount} tool calls` stays unchanged — it describes the capture, not the visible subset.

## Files touched

- **Edit** `web/src/components/ConversationTab.tsx` — add `Bucket` type, `bucketOf` helper, `filter` state, chip header UI, filter the rendered items, empty-state branch.
- **Edit** `web/src/styles/global.css` — `.conv-filter`, `.conv-chip`, `.conv-chip.off`, `.conv-empty` rules (~25 lines), reusing existing tokens.

No new modules; the bucket logic is small and local to `ConversationTab`. No new dependencies.

## Non-goals

- No "thinking" sub-filter (thinking blocks live inside assistant cards; folding them into assistant for v1).
- No persistence across sessions (no localStorage).
- No full-text search.
- No change to how items render — only their visibility.
- No change to other tabs (Request / Response / SSE Timeline / Raw JSON).

## Risks

- **Header layout regression:** the `h3.section::after` gradient line currently fills trailing space. Adding chips must not break that or push the heading text. Mitigation: settle the `flex`/`margin-left:auto` detail in implementation and visually verify with `npm run dev`.
- **Filter confusion:** counts that don't change when toggling could surprise users expecting live counts. Mitigation: chips clearly read as type toggles (on/off state is visually obvious), and the header turn count still describes the total.
- **`aria-pressed` correctness:** ensure the attribute reflects current state for accessibility.
