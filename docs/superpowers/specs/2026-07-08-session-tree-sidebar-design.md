# Session Tree Sidebar — Design

**Date:** 2026-07-08
**Status:** Approved (brainstorming complete)
**Depends on:** React migration (commit `a199fba`) for the `ConversationList` component being in TypeScript/React; the session-scoped addon (commit `8473884`) for the data shape.

## 1. Goal

Render the viewer's left sidebar as a **two-level tree** grouped by session, instead of the current flat list of full-path strings. Driven by the addon's new behavior of writing captures to `session-<id>/<file>.json` subdirectories.

## 2. Decisions (locked during brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Default expansion | Newest session expanded; all others collapsed on mount | Matches "what did I just do?" mental model; scales as sessions accumulate |
| Session node label | `[relative time] · N captures · "opening preview"` | Time + scope + topic in one line; data already in the API response |
| Tree depth | Two levels (session → capture) | Addon writes exactly one subdirectory level; arbitrary-depth recursion is YAGNI |
| Grouping location | Client-side only | Server already returns the data we need (`name`, `mtime`, `preview`); no API change |

## 3. Data model

The server is unchanged. The grouping is a pure client-side transform.

```ts
// web/src/lib/groupSessions.ts
interface SessionGroup {
  key: string;            // name.split("/")[0]; "ungrouped" for flat captures
  captures: ListItem[];   // sorted by mtime desc (server's order preserved)
  newestMtime: number;    // max mtime in group — drives group ordering
  openingPreview: string; // oldest capture's preview field — the session's first message
}
function groupSessionsByPath(items: ListItem[]): SessionGroup[];
```

**Algorithm:**
1. For each `ListItem`, compute `key = it.name.includes("/") ? it.name.split("/")[0] : "ungrouped"`.
2. Bucket items by key.
3. For each bucket: `newestMtime = max(mtime)`, `openingPreview = captures[captures.length - 1].preview` (since server sorts desc, the last item is the oldest).
4. Return groups sorted by `newestMtime desc`.

**Edge case — flat captures:** items with no `/` in `name` (legacy captures written before session-scoping) all land in the `"ungrouped"` pseudo-session, rendered with the same header styling. If empty, the group is not rendered at all.

## 4. Component structure

```
<ConversationList items={...} selectedName={...} onSelect={...}>
  state: collapsedKeys: Set<string>  (empty initial → all expanded)
  effect: on mount, collapse every key EXCEPT groups[0].key (newest)
  └── maps over groupSessionsByPath(items)
        └── <SessionNode key=session-key
                          group=sessionGroup
                          collapsed={collapsedKeys.has(key)}
                          onToggle={() => toggle(key)}
                          selectedName={selectedName}
                          onSelect={onSelect} />
              ├── <div class="session-header" onClick={onToggle}>
              │     <span class="caret">{collapsed ? "▸" : "▾"}</span>
              │     <span class="session-time">{relativeTime(group.newestMtime)}</span>
              │     <span class="session-count">{group.captures.length} captures</span>
              │     <span class="session-preview">"{truncate(group.openingPreview, 60)}"</span>
              │   </div>
              └── {!collapsed && group.captures.map(it => <div class="file-item">...</div>)}
```

**Where state lives:** local `useState` inside `ConversationList`. App doesn't need to know about expansion (no other component consumes it). `SessionNode` is a pure presentational child — receives `collapsed` and `onToggle` as props.

**Selection behavior:** clicking a leaf capture calls `onSelect(name)` exactly as before. No auto-expand-on-select (YAGNI until deep-linking exists).

## 5. Display details

**Relative time:** `Intl.RelativeTimeFormat('zh-CN', { numeric: "auto" })` — built-in, no new dep. Output examples: "5 分钟前", "3 小时前", "昨天", "3 天前". For anything older than 7 days, fall back to absolute date `MM-DD HH:mm`.

**Preview truncation:** `s.length > 60 ? s.slice(0, 57) + "…" : s`. The opening preview from the server is already capped at 80 chars, so this is just visual polish for the header.

**Indentation:** leaves get `padding-left: 24px` (existing `.file-item` uses `padding: 14px 24px`). Header sits at the parent indent. No deeper nesting (addon writes one level only).

**Caret glyph:** `▸` collapsed, `▾` expanded. Matches the `details > summary::before` pattern already used for collapsible cards in the conversation view.

**Selection highlight:** existing `.file-item.active` rule still applies. No new active styles needed.

## 6. CSS additions to `web/src/styles/global.css`

```css
.session-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 24px 8px;
  cursor: pointer;
  border-bottom: 1px solid var(--line-faint);
  background: var(--paper-2);
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--text-dim);
  letter-spacing: 0.04em;
  user-select: none;
  transition: background 0.15s ease, color 0.15s ease;
  position: sticky;
  top: 0;
  z-index: 1;
}
.session-header:hover {
  background: var(--hover);
  color: var(--text);
}
.session-header .caret {
  color: var(--sage-bright);
  font-size: 11px;
  transition: transform 0.2s ease;
}
.session-header .session-time { color: var(--sage-deep); font-weight: 500; }
.session-header .session-count {
  padding: 1px 7px;
  background: var(--sage-dim);
  border: 1px solid rgba(90, 125, 82, 0.2);
  color: var(--sage-deep);
  border-radius: 10px;
  font-size: 9.5px;
}
.session-header .session-preview {
  color: var(--text-faint);
  font-family: var(--font-ui);
  font-size: 11.5px;
  font-style: italic;
  letter-spacing: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  text-align: right;
}
```

Existing `.file-item` leaves are reused as-is; their padding already visually nests under the header.

## 7. Files touched

| File | Change |
|---|---|
| `web/src/lib/groupSessions.ts` | new — pure grouping helper + `SessionGroup` type |
| `web/src/lib/format.ts` | add `relativeTime(ms)` and `truncatePreview(s, max)` exports |
| `web/src/components/ConversationList.tsx` | rewrite to render grouped tree + local expanded/collapsed state |
| `web/src/styles/global.css` | append `.session-header` and child rules |

**Out of scope:** server changes, deep-linking, multi-level nesting, session rename, drag-to-collapse-all, per-session delete.

## 8. Testing / verification

Manual side-by-side against current flat list. Acceptance:
1. Captures group under their session header.
2. Newest session is expanded on load; others are collapsed.
3. Header shows time + count + opening preview correctly.
4. Clicking header toggles collapse.
5. Clicking a leaf selects it (existing behavior unchanged).
6. Legacy flat captures (if any) appear under an "ungrouped" pseudo-session.
7. Polling refreshes relative time naturally (no jumps or flicker).
