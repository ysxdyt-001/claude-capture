# Session Tree Sidebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the viewer's left sidebar as a two-level tree (session → capture) instead of a flat list, driven by the addon's new `session-<id>/<file>.json` capture layout.

**Architecture:** Pure client-side transform. The server is unchanged — `GET /api/files` still returns a flat `ListItem[]` with `name` containing the path. A new `lib/groupSessions.ts` helper buckets items by the first segment of their name. `ConversationList` becomes a tree shell with local expanded/collapsed state; newest session auto-expanded, others collapsed. CSS additions to `global.css` style the session headers.

**Tech Stack:** React 18, TypeScript, existing vanilla CSS in `web/src/styles/global.css`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-08-session-tree-sidebar-design.md`

## Global Constraints

- **No tests required.** The migration spec explicitly defers the test suite to a separate project. Verification is `npm run build` (the gate) + manual side-by-side against the live app.
- **No new dependencies.** Use built-in `Intl.RelativeTimeFormat` for relative time — do not pull in a date library.
- **Server unchanged.** Do not touch `lib/server.mjs` or `lib/addon.py`. Grouping is purely a client-side transform of the existing `/api/files` response.
- **Bilingual comments** where surrounding code has them (the existing `format.ts` and `ConversationList.tsx` are mostly comment-free; match that style — sparse comments only for non-obvious logic like the "oldest capture = opening message" derivation).
- **Biome lint clean.** Run `npm run lint` and `npm run format` from `web/` before committing each task.
- **Sidebar state is local.** Expanded/collapsed state lives inside `ConversationList` via `useState`. Do not pollute `App.tsx` or add a global store.

---

## File Structure

### Files created

| Path | Responsibility |
|---|---|
| `web/src/lib/groupSessions.ts` | Pure helper: `groupSessionsByPath(items: ListItem[]): SessionGroup[]`. Plus the `SessionGroup` type export. |

### Files modified

| Path | Change |
|---|---|
| `web/src/lib/format.ts` | Add `relativeTime(ms?: number): string` and `truncatePreview(s: string, max?: number): string` exports. Existing exports unchanged. |
| `web/src/components/ConversationList.tsx` | Rewrite to render grouped tree. Add local `collapsedKeys: Set<string>` state with mount-time auto-collapse (all but newest group). Add inline `SessionNode` sub-component (kept in the same file — small enough). |
| `web/src/styles/global.css` | Append `.session-header` and child rules (caret, time, count, preview). |

### Files NOT touched

- `lib/server.mjs`, `lib/addon.py`, `bin/claude-capture.mjs`
- `web/src/App.tsx` (sidebar state stays local to ConversationList)
- `web/src/types.ts` (no new types — `SessionGroup` lives in `groupSessions.ts`)
- `web/src/lib/api.ts`

---

## Task Sequence

- [Task 1: Add pure helpers (`groupSessions.ts` + `format.ts` additions)](#task-1)
- [Task 2: Rewrite `ConversationList` as tree + add session-header CSS](#task-2)

---

<a id="task-1"></a>
### Task 1: Add pure helpers (`groupSessions.ts` + `format.ts` additions)

**Files:**
- Create: `web/src/lib/groupSessions.ts`
- Modify: `web/src/lib/format.ts` (append two exports)

**Interfaces:**
- Consumes: `ListItem` from `web/src/types.ts` (already exists, shape `{ name: string; mtime: number; size: number; status?: number; preview: string }`).
- Produces:
  - `groupSessionsByPath(items: ListItem[]): SessionGroup[]` — buckets items by the first `/`-separated segment of `name`. Returns groups sorted by `newestMtime desc`. Items with no `/` land in a group keyed `"ungrouped"`.
  - `SessionGroup` type export: `{ key: string; captures: ListItem[]; newestMtime: number; openingPreview: string }`.
  - `relativeTime(ms?: number): string` — uses `Intl.RelativeTimeFormat('zh-CN', { numeric: "auto" })`. Returns `"—"` for falsy input. Falls back to absolute `MM-DD HH:mm` for > 7 days.
  - `truncatePreview(s: string, max?: number): string` — `s.length > max ? s.slice(0, max - 1) + "…" : s`. Default `max = 60`.

- [ ] **Step 1: Create `web/src/lib/groupSessions.ts`**

```ts
import type { ListItem } from "../types";

// 一个会话分组：同一 session-<id>/ 目录下的所有 capture。
// A session group: all captures written under the same session-<id>/ subdirectory.
export interface SessionGroup {
  key: string;            // name.split("/")[0]; "ungrouped" for flat captures
  captures: ListItem[];   // sorted by mtime desc (server order preserved within group)
  newestMtime: number;    // max mtime in the group — drives group ordering
  openingPreview: string; // oldest capture's preview — the session's first user message
}

const UNGROUPED = "ungrouped";

// 把扁平的 ListItem[] 按路径首段（session id）分桶。
// Bucket a flat ListItem[] by the first path segment (the session id).
export function groupSessionsByPath(items: ListItem[]): SessionGroup[] {
  const buckets = new Map<string, ListItem[]>();
  for (const it of items) {
    const slashIdx = it.name.indexOf("/");
    const key = slashIdx === -1 ? UNGROUPED : it.name.slice(0, slashIdx);
    const arr = buckets.get(key);
    if (arr) arr.push(it);
    else buckets.set(key, [it]);
  }

  const groups: SessionGroup[] = [];
  for (const [key, captures] of buckets) {
    // 服务器已经按 mtime desc 排序，组内顺序保留。
    // Server already sorts by mtime desc; preserve within-group order.
    let newest = 0;
    for (const c of captures) if (c.mtime > newest) newest = c.mtime;
    // captures[length-1] 是组里最旧的一条（因为 desc 排序），其 preview 即开场消息。
    // captures[length-1] is the oldest in the group (desc order); its preview is the opening message.
    const opening = captures.length > 0 ? captures[captures.length - 1].preview : "";
    groups.push({ key, captures, newestMtime: newest, openingPreview: opening });
  }

  // 组间按最新 mtime desc，确保最近的 session 排在最上面。
  // Sort groups by newest mtime desc so the most recent session is on top.
  groups.sort((a, b) => b.newestMtime - a.newestMtime);
  return groups;
}
```

- [ ] **Step 2: Append two exports to `web/src/lib/format.ts`**

Add to the end of the existing file (after `formatTime`). Do NOT modify the existing `escapeHtml`, `unescapeHtml`, or `formatTime` functions.

```ts
// 相对时间：5 分钟前 / 3 小时前 / 昨天 / 3 天前。超过 7 天回退为绝对时间 MM-DD HH:mm。
// Relative time via Intl.RelativeTimeFormat. Falls back to absolute date past 7 days.
export function relativeTime(ms?: number): string {
  if (!ms) return "—";
  const diff = ms - Date.now();
  const absSec = Math.abs(diff) / 1000;
  const rtf = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });

  if (absSec < 60) return rtf.format(Math.round(diff / 1000), "second");
  if (absSec < 3600) return rtf.format(Math.round(diff / 60000), "minute");
  if (absSec < 86400) return rtf.format(Math.round(diff / 3600000), "hour");
  if (absSec < 86400 * 7) return rtf.format(Math.round(diff / 86400000), "day");

  // 超过一周：绝对时间。
  // Past one week: absolute time.
  const d = new Date(ms);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
}

// 把预览文本截断到 max 字符（含末尾省略号）。默认 max = 60。
// Truncate a preview string to max chars (including trailing ellipsis). Default max = 60.
export function truncatePreview(s: string, max = 60): string {
  if (!s) return "";
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
```

- [ ] **Step 3: Verify build + lint**

Run from `web/`:
```bash
npm run build
```
Expected: success. `tsc -b && vite build`, no TS errors, no warnings.

Run:
```bash
npm run lint
```
Expected: `Checked N files. No fixes applied.` with 0 errors.

- [ ] **Step 4: Commit**

```bash
cd ..
git add web/src/lib/groupSessions.ts web/src/lib/format.ts
git commit -m "feat(web): add groupSessions helper + relativeTime/truncatePreview"
```

---

<a id="task-2"></a>
### Task 2: Rewrite `ConversationList` as tree + add session-header CSS

**Files:**
- Modify: `web/src/components/ConversationList.tsx` (rewrite)
- Modify: `web/src/styles/global.css` (append rules)

**Interfaces:**
- Consumes:
  - `ListItem` from `../types`
  - `groupSessionsByPath`, `SessionGroup` from `../lib/groupSessions`
  - `formatTime`, `relativeTime`, `truncatePreview` from `../lib/format`
- Produces: `ConversationList` default export with the same prop interface as before (`items`, `selectedName`, `onSelect`) — no change for consumers (`App.tsx` already passes these three).

- [ ] **Step 1: Rewrite `web/src/components/ConversationList.tsx`**

Replace the entire file contents with:

```tsx
import { useEffect, useState } from "react";
import { formatTime, relativeTime, truncatePreview } from "../lib/format";
import { groupSessionsByPath, type SessionGroup } from "../lib/groupSessions";
import type { ListItem } from "../types";

interface ConversationListProps {
  items: ListItem[];
  selectedName: string | null;
  onSelect: (name: string) => void;
}

export default function ConversationList({
  items,
  selectedName,
  onSelect,
}: ConversationListProps) {
  const groups = groupSessionsByPath(items);

  // 折叠的 session key 集合。空集合 = 全展开。
  // Collapsed-session keys. Empty set = all expanded.
  const [collapsedKeys, setCollapsedKeys] = useState<Set<string>>(new Set());

  // 挂载时折叠除最新 session 外的所有组（groups[0] 是最新，因为按 newestMtime desc 排序）。
  // On mount, collapse every group except the newest (groups[0] is newest because of desc sort).
  useEffect(() => {
    setCollapsedKeys(new Set(groups.slice(1).map((g) => g.key)));
    // 只在挂载时跑一次；后续轮询不重新折叠。
    // Only run once on mount; subsequent polls do not re-collapse.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = (key: string) => {
    setCollapsedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="file-list">
      {groups.map((g) => (
        <SessionNode
          key={g.key}
          group={g}
          collapsed={collapsedKeys.has(g.key)}
          selectedName={selectedName}
          onToggle={() => toggle(g.key)}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

interface SessionNodeProps {
  group: SessionGroup;
  collapsed: boolean;
  selectedName: string | null;
  onToggle: () => void;
  onSelect: (name: string) => void;
}

function SessionNode({
  group,
  collapsed,
  selectedName,
  onToggle,
  onSelect,
}: SessionNodeProps) {
  return (
    <div className="session-group">
      <div
        className="session-header"
        onClick={onToggle}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <span className="caret">{collapsed ? "▸" : "▾"}</span>
        <span className="session-time">{relativeTime(group.newestMtime)}</span>
        <span className="session-count">{group.captures.length} captures</span>
        <span className="session-preview">
          {truncatePreview(group.openingPreview)}
        </span>
      </div>
      {!collapsed &&
        group.captures.map((it) => {
          const badgeCls =
            it.status === 200 ? "ok" : it.status ? "err" : "neutral";
          return (
            <div
              key={it.name}
              className={`file-item${it.name === selectedName ? " active" : ""}`}
              onClick={() => onSelect(it.name)}
            >
              <div className="preview">{it.preview}</div>
              <div className="meta">
                <span className={`badge ${badgeCls}`}>
                  {it.status || "—"}
                </span>
                <span>{formatTime(it.mtime)}</span>
                <span>{(it.size / 1024).toFixed(1)}k</span>
              </div>
            </div>
          );
        })}
    </div>
  );
}
```

Key behavior notes for the implementer:
- `useEffect` with `[]` runs once on mount; subsequent polls refresh `groups` via the parent's re-render but do NOT re-collapse (the `setCollapsedKeys` is only called once).
- `SessionNode` is defined in the same file (not its own file) — the spec considered splitting it out but decided inline is fine given its size.
- The `eslint-disable-next-line react-hooks/exhaustive-deps` comment is included in case any linter flags the empty-deps array. Biome (the project's linter) typically doesn't flag this, but the comment is harmless if not triggered.

- [ ] **Step 2: Append session-header CSS to `web/src/styles/global.css`**

Open `web/src/styles/global.css` and append the following block at the very end of the file (after the existing `::selection` rule that closes the stylesheet). Do NOT modify any existing rules — pure append.

```css

/* ============ SESSION TREE SIDEBAR ============ */
.session-group {
  border-bottom: 1px solid var(--line-faint);
}

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
  display: inline-block;
  width: 10px;
}
.session-header .session-time {
  color: var(--sage-deep);
  font-weight: 500;
}
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

- [ ] **Step 3: Verify build + lint**

Run from `web/`:
```bash
npm run build
```
Expected: success. 54 modules transformed (53 prior + 1 new `groupSessions.ts`).

Run:
```bash
npm run format && npm run lint
```
Expected: 0 errors after format.

- [ ] **Step 4: Manual smoke test**

Start the viewer. From the repo root:
```bash
# Ensure dist/ is freshly built
(cd web && npm run build)
# Launch (this blocks — run in a separate terminal)
node bin/claude-capture.mjs
```

Open the viewer URL printed in the banner. Confirm:
1. Left sidebar shows session-group headers, each with a caret, relative time, capture count, and opening-message preview.
2. The **newest** session is expanded by default; older sessions are collapsed.
3. Clicking a session header toggles its collapse state.
4. Clicking a capture row selects it and loads the Conversation tab as before.
5. The selected capture's row shows the `.active` highlight (left sage bar).
6. Wait ~3 seconds (poll cadence) — relative time labels refresh without flicker.
7. If any legacy flat captures exist (no `/` in name), they appear under an "ungrouped" session header.

If any of these fail, fix before committing.

- [ ] **Step 5: Commit**

```bash
cd ..
git add web/src/components/ConversationList.tsx web/src/styles/global.css
git commit -m "feat(web): session tree sidebar with collapsible grouping"
```

---

## Self-Review

**Spec coverage:**
- Spec §3 (data model: `SessionGroup`, grouping algorithm, edge case for flat captures) → Task 1 Step 1 ✓
- Spec §4 (component structure, mount-time auto-collapse, selection unchanged) → Task 2 Step 1 ✓
- Spec §5 (relative time via `Intl.RelativeTimeFormat`, 7-day fallback to `MM-DD HH:mm`, preview truncation to 60 chars, caret glyphs `▸`/`▾`) → Task 1 Step 2 + Task 2 Step 1 ✓
- Spec §6 (CSS: `.session-header` with sticky positioning, sage palette, mono font for header / italic UI font for preview) → Task 2 Step 2 ✓
- Spec §7 (files touched) → matches exactly: `groupSessions.ts` new, `format.ts` + `ConversationList.tsx` + `global.css` modified ✓
- Spec §8 (acceptance: grouping, newest-expanded default, click-toggle, leaf selection, polling refresh, ungrouped pseudo-session) → Task 2 Step 4 covers all 7 items ✓

**Placeholder scan:** No TBDs / TODOs / "implement later" / "similar to Task N". Every step has complete code.

**Type consistency:**
- `SessionGroup` defined in Task 1 with fields `{ key, captures, newestMtime, openingPreview }`. Task 2's `SessionNode` consumes all four via props — names match exactly.
- `groupSessionsByPath(items: ListItem[]): SessionGroup[]` signature in Task 1 matches the import + call in Task 2.
- `relativeTime(ms?: number): string` and `truncatePreview(s: string, max?: number): string` signatures in Task 1 match the calls in Task 2: `relativeTime(group.newestMtime)` and `truncatePreview(group.openingPreview)`.
- `ConversationList` prop interface is unchanged from the existing version (`items`, `selectedName`, `onSelect`) — `App.tsx` consumer needs no edit.

**Scope check:** Single focused feature, two tasks. Natural split between pure data layer (Task 1) and presentation layer (Task 2). Each task has an independent `npm run build` gate.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-08-session-tree-sidebar.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session via executing-plans, batch execution with checkpoints.

Which approach?
