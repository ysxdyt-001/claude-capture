# Conversation Filter Mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add multi-select filter chips (system / user / assistant / tool) to the Conversation tab so the user can hide/show conversation items by type.

**Architecture:** A `Bucket` type and a pure `bucketOf(item)` mapping live in `ConversationTab.tsx`. Filter state is a `Record<Bucket, boolean>` held in `useState` (all on by default). The render path filters `items` through the active filter; chip buttons toggle entries. Chips sit inline in the existing `h3.section` header, with a small CSS adjustment to the `::after` rule.

**Tech Stack:** React + TypeScript + Vite (existing `web/` project). No new dependencies. Reuses existing CSS tokens (`--sage-dim`, `--sage-deep`, `--line`, `--text-faint`, `--paper-2`).

## Global Constraints

- Root `package.json` has **zero runtime dependencies** — only Node built-ins and existing `web/src/lib/` helpers.
- **Bilingual comments** (Chinese + English) required per `CLAUDE.md`, matching surrounding style.
- **No test suite exists** in this repo. Verification is: `cd web && npm run build` succeeds (TypeScript + Vite build), plus a manual smoke check via `npm run dev`.
- HTML injected via `dangerouslySetInnerHTML` (existing pattern) — any dynamic text must pass through `escapeHtml` (or `smartRender`/`highlightJSON`, which escape internally) before injection. For this feature, chip labels and counts are rendered as JSX text children (React auto-escapes), so no manual escaping is needed.
- `ConversationItem` and its `kind` values are defined in `web/src/lib/conversation.ts` as: `"system" | "user" | "assistant" | "tool-pair" | "other"`. Do not modify that file.

---

## File Structure

- **Edit** `web/src/components/ConversationTab.tsx` — add `Bucket` type, `bucketOf` helper, `filter` state, chip UI in the section header, filter the rendered items, empty-state branch.
- **Edit** `web/src/styles/global.css` — `.conv-filter`, `.conv-chip`, `.conv-chip.off`, `.conv-empty` rules; shrink `h3.section::after` from `flex:1` to a fixed width so chips can sit at the right.

No new modules — the bucket logic is small and local to `ConversationTab`.

---

### Task 1: `ConversationTab` — filter state, bucket mapping, and filtered render

**Files:**
- Modify: `web/src/components/ConversationTab.tsx`

**Interfaces:**
- Consumes: `ConversationItem` from `../lib/conversation` (already imported), `useState` from `react`.
- Produces: a filtered view of the conversation. Nothing exported — this task is self-contained UI work.

**Context for the implementer (you see only this task):**
- The current `ConversationTab.tsx` builds `items` via `buildConversationItems(all)` then renders them with `items.map(...)`. The `ConversationItem` union has `kind` values `"system" | "user" | "assistant" | "tool-pair" | "other"`.
- The existing `<h3 className="section">` header shows `Conversation · {textTurnCount} turns · {toolPairCount} tool calls`. It must keep that text; chips are appended inside the same `<h3>` as a trailing child.
- `toolPairCount` and `textTurnCount` already exist in the component — reuse them for chip counts. The `system` count = number of items with `kind === "system"`; the `assistant` count = number with `kind === "assistant"`; `user` count = number with `kind === "user"`. Compute these with small `.filter(...).length` calls (or count once in a loop — your choice).

- [ ] **Step 1: Read the current file**

Read `web/src/components/ConversationTab.tsx` so you can edit it precisely. The whole file is ~89 lines. Note the existing `items.map(...)` block (around lines 73-86) and the `<h3 className="section">` (around lines 68-71).

- [ ] **Step 2: Add the `react` import for `useState`**

At the top of `web/src/components/ConversationTab.tsx`, the file currently has no React import (it uses no hooks today). Add as the first import line:

```ts
import { useState } from "react";
```

- [ ] **Step 3: Add the `Bucket` type and `bucketOf` helper**

Above the component function (after the imports, before `export default function ConversationTab`), add:

```ts
// 过滤桶：每种会话项映射到一个桶（other 无桶，始终可见）。
// Filter buckets: each conversation item maps to a bucket. "other" has no
// bucket and is always visible since it has no chip to toggle it.
type Bucket = "system" | "user" | "assistant" | "tool";

function bucketOf(item: { kind: string }): Bucket | null {
  switch (item.kind) {
    case "system":
      return "system";
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "tool-pair":
      return "tool";
    default:
      return null;
  }
}
```

- [ ] **Step 4: Add filter state and derived values inside the component**

Inside `export default function ConversationTab({ capture }: ConversationTabProps)`, after the existing `const items = buildConversationItems(all);` line (and the existing `toolPairCount` / `textTurnCount` lines), add the filter state, the counts per bucket, the toggle handler, and the filtered list:

```ts
  // 过滤状态：默认全部开启。useState 保留在同一组件实例内，切换抓包时不重置。
  // Filter state: all on by default. Held in useState so switching captures
  // (same component instance) does not reset the chosen filters.
  const [filter, setFilter] = useState<Record<Bucket, boolean>>({
    system: true,
    user: true,
    assistant: true,
    tool: true,
  });
  const toggle = (b: Bucket) =>
    setFilter((prev) => ({ ...prev, [b]: !prev[b] }));

  // 每个桶的总数（与过滤状态无关，固定描述本次抓包）。
  // Per-bucket totals (independent of filter state; describe this capture).
  const counts: Record<Bucket, number> = {
    system: items.filter((it) => it.kind === "system").length,
    user: items.filter((it) => it.kind === "user").length,
    assistant: items.filter((it) => it.kind === "assistant").length,
    tool: toolPairCount,
  };

  const visibleItems = items.filter(
    (it) => bucketOf(it) === null || filter[bucketOf(it) as Bucket],
  );
```

Note: `tool` count reuses the existing `toolPairCount` (which is already `items.filter(i => i.kind === "tool-pair").length`).

- [ ] **Step 5: Render chips inside the `<h3 className="section">`**

Replace the existing `<h3 className="section">…</h3>` block. The current block is:

```tsx
      <h3 className="section">
        Conversation · {textTurnCount} turns
        {toolPairCount ? ` · ${toolPairCount} tool calls` : ""}
      </h3>
```

Replace it with:

```tsx
      <h3 className="section">
        <span className="conv-title">
          Conversation · {textTurnCount} turns
          {toolPairCount ? ` · ${toolPairCount} tool calls` : ""}
        </span>
        <div className="conv-filter">
          {(["system", "user", "assistant", "tool"] as Bucket[]).map((b) => (
            <button
              key={b}
              type="button"
              aria-pressed={filter[b]}
              className={`conv-chip${filter[b] ? "" : " off"}`}
              onClick={() => toggle(b)}
            >
              {b} · {counts[b]}
            </button>
          ))}
        </div>
      </h3>
```

The `<span className="conv-title">` wraps the text so the CSS flex layout can push `.conv-filter` to the right via `margin-left: auto` (added in Task 2).

- [ ] **Step 6: Render `visibleItems` instead of `items`, with an empty-state branch**

Replace the existing `{items.map((it, i) => { … })}` block. The current block (around lines 73-86) is:

```tsx
      {items.map((it, i) => {
        switch (it.kind) {
          case "system":
            return <SystemMessage key={i} message={it.message} />;
          case "user":
            return <Message key={i} message={it.message} idx={it.idx} />;
          case "assistant":
            return <Message key={i} message={it.message} idx={it.idx} blocks={it.blocks} />;
          case "tool-pair":
            return <ToolPair key={i} toolUse={it.toolUse} toolResult={it.toolResult} />;
          default:
            return <Message key={i} message={it.message} idx={it.idx} />;
        }
      })}
```

Replace `items.map` with a conditional that handles the all-hidden case:

```tsx
      {visibleItems.length === 0 ? (
        <div className="conv-empty">all types hidden — toggle a filter to show items</div>
      ) : (
        visibleItems.map((it, i) => {
          switch (it.kind) {
            case "system":
              return <SystemMessage key={i} message={it.message} />;
            case "user":
              return <Message key={i} message={it.message} idx={it.idx} />;
            case "assistant":
              return <Message key={i} message={it.message} idx={it.idx} blocks={it.blocks} />;
            case "tool-pair":
              return <ToolPair key={i} toolUse={it.toolUse} toolResult={it.toolResult} />;
            default:
              return <Message key={i} message={it.message} idx={it.idx} />;
          }
        })
      )}
```

- [ ] **Step 7: Type-check**

Run: `cd web && npx tsc --noEmit`
Expected: PASS, no errors. Common issues if it fails: forgetting the `import { useState } from "react";` line, or a `Bucket` typo.

- [ ] **Step 8: Commit**

```bash
git add web/src/components/ConversationTab.tsx
git commit -m "feat(web): add conversation filter chips (system/user/assistant/tool)"
```

---

### Task 2: CSS — chip styles and section header layout

**Files:**
- Modify: `web/src/styles/global.css`

**Interfaces:**
- Consumes: HTML classes emitted by Task 1: `.conv-title`, `.conv-filter`, `.conv-chip`, `.conv-chip.off`, `.conv-empty`.
- Modifies: the existing `h3.section` and `h3.section::after` rules (around lines 420-437 in the current file).

**Context for the implementer:** The `h3.section` rule today has `display: flex; align-items: center; gap: 14px;` and `h3.section::after` has `flex: 1; height: 1px; background: linear-gradient(90deg, var(--line-2), transparent);`. That `::after` currently draws a full-width gradient rule. We shorten it to a fixed-width trailing accent and give the chip group `margin-left: auto` so it parks at the right edge.

- [ ] **Step 1: Shrink the `h3.section::after` rule**

In `web/src/styles/global.css`, find:

```css
h3.section::after {
  content: "";
  flex: 1;
  height: 1px;
  background: linear-gradient(90deg, var(--line-2), transparent);
}
```

Replace the `flex: 1;` line with a fixed width so it stops consuming all remaining space:

```css
h3.section::after {
  content: "";
  width: 40px;
  height: 1px;
  background: linear-gradient(90deg, var(--line-2), transparent);
}
```

- [ ] **Step 2: Add the chip styles**

Immediately after the `h3.section::after` rule (and before the next section, `.msg {`), insert:

```css
/* ============ CONVERSATION FILTER CHIPS ============ */
.conv-title {
  /* 标题文本不拉伸，让 .conv-filter 推到最右。 */
  /* Title text doesn't grow; lets .conv-filter park at the right edge. */
  flex: none;
}
.conv-filter {
  margin-left: auto;
  display: flex;
  gap: 6px;
  align-items: center;
}
.conv-chip {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.06em;
  text-transform: lowercase;
  padding: 3px 9px;
  border-radius: 10px;
  cursor: pointer;
  background: var(--sage-dim);
  color: var(--sage-deep);
  border: 1px solid rgba(90, 125, 82, 0.25);
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}
.conv-chip:hover {
  border-color: var(--sage-bright);
}
.conv-chip.off {
  background: transparent;
  color: var(--text-faint);
  border-color: var(--line);
}
.conv-chip.off:hover {
  color: var(--text-dim);
  border-color: var(--line-2);
}
.conv-empty {
  color: var(--text-faint);
  text-align: center;
  padding: 60px 20px;
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.04em;
}
```

- [ ] **Step 3: Build the viewer UI**

Run: `cd web && npm run build`
Expected: build succeeds, outputs to `dist/`, no TypeScript or Vite errors.

- [ ] **Step 4: Commit**

```bash
git add web/src/styles/global.css
git commit -m "style(web): conversation filter chips + header layout"
```

---

### Task 3: Manual smoke verification

**Files:**
- None modified — verification only.

**Context:** The viewer serves from `dist/`. After Task 2 the build is current. Run the dev server and confirm behavior against a real capture.

- [ ] **Step 1: Run the dev server**

Run (background is fine): `cd web && npm run dev`. The dev server proxies `/api/*` to the viewer backend. If the viewer backend isn't running, start `claude-capture` once to produce/serve captures, or run `node bin/claude-capture.mjs` from the repo root.

- [ ] **Step 2: Visually confirm**

Open the dev URL in a browser. Select a capture that has a system prompt, user turns, assistant turns, AND tool calls (most real captures qualify). In the Conversation tab:

- The `Conversation · N turns · M tool calls` header shows four chips to its right: `system · 1`, `user · N`, `assistant · N`, `tool · M`. The numbers match the capture (system is usually 1; tool count matches the "M tool calls" in the header).
- All chips start in the active (sage) state. The full conversation is visible.
- Click `tool`: it goes to the `.off` (muted outline) state; all tool-pair cards disappear from the list. The chip number does NOT change.
- Click `tool` again: it returns to active; tool cards reappear.
- Click `system`, `user`, `assistant`, and `tool` all off: the list area shows the muted `all types hidden — toggle a filter to show items` placeholder.
- Toggle one back on: its items reappear.
- Switch to a different capture in the sidebar: the filter chip states persist (e.g. if `tool` was off, tool calls stay hidden in the newly-selected capture too). This confirms the `useState`-persists-across-captures behavior.

- [ ] **Step 3: Confirm no regression elsewhere**

- The meta-table (Model / Temp / Tools / Stream / Response) renders unchanged above the conversation.
- The other tabs (Request / Response / SSE Timeline / Raw JSON) are untouched.
- The `h3.section` gradient line is now a short trailing accent (40px) to the left of the chips — confirm it does not visually collide with the chips.

- [ ] **Step 4: No commit needed**

This task is verification only. If any check fails, file the issue against Task 1 or Task 2 above and fix before merging.

---

## Self-Review

**Spec coverage:**
- `Bucket` type + `bucketOf` mapping — Task 1, Step 3. ✓
- `filter` state, all on by default — Task 1, Step 4. ✓
- `visibleItems` derivation — Task 1, Step 4. ✓
- Counts per bucket (totals, independent of filter) — Task 1, Step 4 (`counts`). ✓
- Chip UI in `h3.section`, active=sage / inactive=muted — Task 1 Step 5 (JSX) + Task 2 Step 2 (CSS). ✓
- `aria-pressed` — Task 1, Step 5. ✓
- Empty state — Task 1, Step 6. ✓
- Filter persists across capture browsing — Task 1 Step 4 (`useState` in component) + verified in Task 3 Step 2. ✓
- `h3.section::after` shrunk; chip group pushed right via `margin-left:auto` — Task 2, Steps 1-2. ✓
- Header text unchanged — Task 1, Step 5 (keeps the text inside `.conv-title`). ✓
- Bilingual comments — present in Task 1 (type/helper/state/comments) and Task 2 (CSS). ✓
- No new dependencies — only `useState` from React (already a dep via the React project). ✓

**Placeholder scan:** No TBDs, no "add appropriate X". Every code step shows the complete code. ✓

**Type consistency:** `Bucket = "system" | "user" | "assistant" | "tool"` — same in Task 1 Step 3 (definition), Step 4 (`Record<Bucket, boolean>`, `Record<Bucket, number>`), and Step 5 (`Bucket[]` cast). `bucketOf(item): Bucket | null` — defined Step 3, consumed Step 4. `toggle(b: Bucket)` — defined Step 4, consumed Step 5. `counts[b]` keys match `Bucket` members. Chip classes `.conv-chip` / `.conv-chip.off` / `.conv-filter` / `.conv-title` / `.conv-empty` match between Task 1 (emitted) and Task 2 (styled). ✓
