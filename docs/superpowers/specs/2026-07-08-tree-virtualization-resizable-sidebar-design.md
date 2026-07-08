# Tree Virtualization + Resizable Sidebar — Design

**Date:** 2026-07-08
**Status:** Approved (brainstorming complete)
**Builds on:** Session tree sidebar (commit `ed33e1c`).

## 1. Goal

Three coordinated improvements to the viewer sidebar:
1. **Depth-aware tree renderer** — two-level rendering today (session → capture), but with a `depth`-prop API so deeper nesting is a config change, not a rewrite.
2. **Virtual scrolling** — only visible rows render, via `@tanstack/react-virtual`. Required for the 1000+ capture directories the addon accumulates.
3. **Resizable sidebar** — drag handle between sidebar and main pane, width persisted to `localStorage`.

## 2. Decisions (locked during brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Tree depth model | **C — Two-level now, depth-aware API** | Matches what the addon writes today (1 level deep); leaves the door open for `session/date/file.json` style nesting without a renderer rewrite. |
| Virtualization | **`@tanstack/react-virtual`** (v3+) | ~3 KB gzip; headless; handles dynamic row heights (`measureElement`) and scroll anchoring automatically. Custom rolling is risky for mixed-height trees. |
| Sidebar drag interaction | Mouse-only, persist on mouseup | Touch is YAGNI for a developer tool. Saving on mouseup (not every tick) avoids localStorage write spam. |
| Width persistence | `localStorage["claude-capture:sidebar-width"]` | Per-browser preference; standard mechanism for UI prefs. |
| Width bounds | min 240, max 600, default 340 (current) | 240 keeps preview text readable; 600 leaves main pane usable on 1280 px laptops. |

## 3. Tree data model

### `web/src/lib/groupSessions.ts` (rewrite)

Replaces the current flat `SessionGroup[]` with a recursive `TreeNode` structure that today only produces 2-level trees but exposes depth on every node.

```ts
export interface TreeNode {
  type: "session" | "leaf";
  depth: number;          // 0 = top-level session; 1 = direct leaf; 2+ = future nested
  key: string;            // unique key (React list + collapse state)
  name: string;           // full path for leaves; session dirname for sessions
  // session-only:
  captures?: ListItem[];
  newestMtime?: number;
  // leaf-only:
  item?: ListItem;
}

// Today: parses items into sessions (depth 0) and their direct leaves (depth 1).
// Tomorrow: when the addon nests captures deeper, extend the parser to recurse on
// path segments — the renderer already accepts arbitrary depth via the `depth` prop.
export function buildTree(items: ListItem[]): TreeNode[];
```

**Algorithm (current 2-level behavior, unchanged from existing `groupSessionsByPath`):**
1. For each `ListItem`, `key = it.name.includes("/") ? it.name.split("/")[0] : "ungrouped"`.
2. Bucket items by key.
3. Emit `TreeNode` of type `"session"` per bucket (depth 0), followed by its captures as `"leaf"` nodes (depth 1).
4. Sort sessions by `newestMtime desc`; within session, leaves preserve server order (already `mtime desc`).

### `flattenVisible` helper (new, same file)

Virtualizers consume flat arrays. The tree is collapsed into a visible-rows array by walking it and skipping children of collapsed sessions:

```ts
export function flattenVisible(tree: TreeNode[], collapsedKeys: Set<string>): TreeNode[] {
  const out: TreeNode[] = [];
  for (const node of tree) {
    out.push(node);
    if (node.type === "session" && !collapsedKeys.has(node.key) && node.captures) {
      for (const child of node.captures) {
        // Today's children are leaves; if future nesting adds session-children,
        // this becomes a recursive walk keyed on `child.type`.
        out.push(child);
      }
    }
  }
  return out;
}
```

Future depth-N extension changes this loop into a recursive walk; the renderer does NOT change.

## 4. Virtualization architecture

**Library:** `@tanstack/react-virtual` v3+, added as a dev dependency in `web/package.json`. Ships in the bundle; does NOT affect root `package.json` (CLI installs stay zero-runtime-deps).

**Component: `ConversationList.tsx` (rewrite):**

```tsx
const parentRef = useRef<HTMLDivElement>(null);
const visibleRows = useMemo(
  () => flattenVisible(tree, collapsedKeys),
  [tree, collapsedKeys]
);

const virtualizer = useVirtualizer({
  count: visibleRows.length,
  getScrollElement: () => parentRef.current,
  estimateSize: () => 60,       // hint; measureElement overrides with real heights
  overscan: 8,                  // buffer rows above/below viewport
  getItemKey: (i) => visibleRows[i].key,
});

return (
  <div ref={parentRef} className="file-list">
    <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
      {virtualizer.getVirtualItems().map((vRow) => (
        <TreeNodeRow
          key={vRow.key}
          node={visibleRows[vRow.index]}
          data-offset={vRow.index}
          ref={virtualizer.measureElement}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            transform: `translateY(${vRow.start}px)`,
            width: "100%",
          }}
          collapsed={collapsedKeys.has(visibleRows[vRow.index].key)}
          onToggle={toggle}
          selectedName={selectedName}
          onSelect={onSelect}
        />
      ))}
    </div>
  </div>
);
```

**`TreeNodeRow` component (new, same file or its own):**
- `React.forwardRef` so the virtualizer can measure actual DOM height.
- Renders session rows (caret + dirname + `[count]`) at `depth=0` padding.
- Renders leaf rows (preview + meta) at `depth=1` padding = `padding-left: 40px` (24 base + 16 indent).
- General formula: `paddingLeft: ${24 + depth * 16}px`.
- Click on session row → `onToggle(node.key)`; click on leaf row → `onSelect(node.name)`.

**Interaction:**
- Toggling a session updates `collapsedKeys` → `flattenVisible` recomputes → virtualizer re-renders with new count. Scroll position preserved by tanstack.
- Poll refresh: `items` changes every 3s → `tree` recomputes via `useMemo([items])` → `visibleRows` recomputes → virtualizer syncs. No flicker.
- Initial-collapse logic (from commit `a613e90`) preserved: `useRef` guard + `useEffect([tree])` fires once when `tree.length > 0`.

## 5. Resizable sidebar

### `App.tsx` layout change

Replace fixed grid template with state-driven width:

```tsx
const SIDEBAR_DEFAULT = 340;
const SIDEBAR_MIN = 240;
const SIDEBAR_MAX = 600;
const STORAGE_KEY = "claude-capture:sidebar-width";

const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
  const saved = Number(localStorage.getItem(STORAGE_KEY));
  return Number.isFinite(saved) && saved >= SIDEBAR_MIN && saved <= SIDEBAR_MAX
    ? saved
    : SIDEBAR_DEFAULT;
});

return (
  <div className="app" style={{ gridTemplateColumns: `${sidebarWidth}px 4px 1fr` }}>
    <aside className="sidebar">...</aside>
    <SidebarResizeHandle
      currentWidth={sidebarWidth}
      onResize={setSidebarWidth}
      min={SIDEBAR_MIN}
      max={SIDEBAR_MAX}
    />
    <main className="main">...</main>
  </div>
);
```

### `SidebarResizeHandle.tsx` (new component)

```tsx
interface SidebarResizeHandleProps {
  currentWidth: number;
  onResize: (width: number) => void;   // live updates during drag
  onCommit: (width: number) => void;   // fired once on mouseup — parent persists
  min: number;
  max: number;
}

export default function SidebarResizeHandle({ currentWidth, onResize, onCommit, min, max }: SidebarResizeHandleProps) {
  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = currentWidth;
    let finalWidth = startWidth;
    const onMove = (ev: MouseEvent) => {
      const next = Math.max(min, Math.min(max, startWidth + (ev.clientX - startX)));
      finalWidth = next;
      onResize(next);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      onCommit(finalWidth);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  return (
    <div
      className="sidebar-resize-handle"
      onMouseDown={onMouseDown}
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={currentWidth}
      aria-valuemin={min}
      aria-valuemax={max}
    />
  );
}
```

**Persistence contract:** `onResize(width)` fires on every mousemove during drag (updates React state for live preview). `onCommit(width)` fires once on mouseup — the parent uses this to write `localStorage.setItem(STORAGE_KEY, String(width))`. This avoids both stale-closure bugs (finalWidth tracked in the closure) and localStorage write spam (one write per drag, not per tick).

**App.tsx wires it:**

```tsx
<SidebarResizeHandle
  currentWidth={sidebarWidth}
  onResize={setSidebarWidth}
  onCommit={(w) => localStorage.setItem(STORAGE_KEY, String(w))}
  min={SIDEBAR_MIN}
  max={SIDEBAR_MAX}
/>
```

### CSS additions to `global.css`

```css
/* Sidebar resize handle — 4px hit area, invisible until hover */
.sidebar-resize-handle {
  cursor: col-resize;
  background: transparent;
  position: relative;
  z-index: 2;
  transition: background 0.15s ease;
}
.sidebar-resize-handle:hover,
.sidebar-resize-handle:active {
  background: var(--sage-bright);
  opacity: 0.6;
}
```

**Existing `.app` grid template change:** the `grid-template-columns: 340px 1fr` rule in `global.css` becomes the fallback default; the inline style on `<div className="app">` overrides it at runtime. The CSS rule can stay as `340px 4px 1fr` for no-JS consistency (though the app needs JS to run anyway).

## 6. Files touched

| File | Change |
|---|---|
| `web/package.json` | add `@tanstack/react-virtual` to devDependencies |
| `web/package-lock.json` | regenerated by `npm install` |
| `web/src/lib/groupSessions.ts` | rewrite: `buildTree(items)` + `flattenVisible(tree, collapsedKeys)` + `TreeNode` type. Existing `SessionGroup` type and `groupSessionsByPath` function removed (or kept as deprecated alias — decision: **remove**). |
| `web/src/components/ConversationList.tsx` | rewrite: virtualized render + `TreeNodeRow` sub-component (forwardRef). Initial-collapse logic preserved. |
| `web/src/components/SidebarResizeHandle.tsx` | new component (mouse drag + localStorage persist). |
| `web/src/App.tsx` | add `sidebarWidth` state + lazy init from localStorage; render `<SidebarResizeHandle>` between sidebar and main; inline `gridTemplateColumns` style. |
| `web/src/styles/global.css` | add `.sidebar-resize-handle` rules. `.app` grid template becomes 3-column `340px 4px 1fr` default. Existing `.session-header`, `.session-key`, `.session-count`, `.caret` rules unchanged. |

### Files NOT touched

- `lib/server.mjs`, `lib/addon.py`, `bin/claude-capture.mjs`
- `web/src/types.ts` (no new exported types — `TreeNode` lives in `groupSessions.ts`)
- `web/src/lib/format.ts` (existing exports still used by leaves' meta row)

## 7. Testing / verification

Manual side-by-side. Acceptance:
1. Sidebar shows session tree with **depth-aware indentation**: session headers at the left edge, capture leaves indented 16 px deeper.
2. Virtualization: with 500+ captures in one session, scrolling is smooth (no jank); DevTools Elements panel shows only ~20-30 `.file-item` nodes at a time, not 500.
3. Expand/collapse preserves scroll position (tanstack default behavior — verify no jump).
4. Drag handle: hovering the border between sidebar and main shows a subtle sage highlight; dragging resizes live; releasing persists to localStorage.
5. Reload page: sidebar width restored from localStorage.
6. Bounds respected: can't drag below 240 px or above 600 px.
7. Initial-collapse behavior preserved: newest session expanded on first data arrival; others collapsed.

## 8. Out of scope

- Touch-screen drag support (YAGNI for a dev tool; can add pointer events later).
- Keyboard resize (arrow keys on focus) — accessibility nice-to-have, defer.
- Persistance of expanded/collapsed session state across reloads — separate future feature.
- Multi-level tree rendering (data doesn't exist yet; API is ready for it).
