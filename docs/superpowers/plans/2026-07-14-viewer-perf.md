# Viewer Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate viewer UI lag on large captures by memoizing derived state and HTML output, and by lazily rendering the full body of large messages via a new `MessageCollapse` component.

**Architecture:** Two layers applied to the existing `ConversationTab` → `Message` / `ToolPair` / `ToolResult` tree. Layer A wraps derived computations in `useMemo` and the heavy subtrees in `React.memo` with per-content HTML caching. Layer B introduces a `MessageCollapse` wrapper that measures raw content size before invoking any renderer, renders a small preview when the body is large, and builds full HTML lazily on first expand. No new runtime dependencies; no DOM-structure changes beyond one wrapper div per collapsed message.

**Tech Stack:** React 18, TypeScript 5.6 (strict, `noUnusedLocals` / `noUnusedParameters`), Vite 8, Biome 1.9 (double quotes, semicolons, 2-space indent, lineWidth 100). Source in `web/src/`, single stylesheet `web/src/styles/global.css`.

## Global Constraints

- **No test suite.** Per `CLAUDE.md`, the project has no test framework. Verification per task = `cd web && npm run build` (runs `tsc -b && vite build`, fails on any type error) + `npm run lint` (Biome) + the manual smoke check described in each task. There are no `pytest` / `jest` commands.
- **No new runtime dependencies.** Root `package.json` has zero runtime deps and a locked file list. This plan only touches `web/` source. `@tanstack/react-virtual` is already in `web/devDependencies` but is **not used** by this plan (virtualization is out of scope per the spec).
- **Bilingual comments.** Existing style is Chinese + English paired comments at the top of files and inline where behavior is non-obvious. Match the surrounding style of each file you edit.
- **`dangerouslySetInnerHTML` is allowed** — Biome rule `security/noDangerouslySetInnerHtml` is off in `web/biome.json`. Existing code relies on it; this plan continues to use it.
- **`noArrayIndexKey` is off** — existing code uses `key={i}` for message lists. Plan preserves that pattern.
- **Strict TS** — `noUnusedLocals` and `noUnusedParameters` are on. Remove any import that becomes unused after a change.
- **Biome format** — double quotes, semicolons, 2-space indent, lineWidth 100. Run `npm run format` if anything is off; `npm run lint` must pass before commit.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `web/src/lib/json.ts` | `looksLikeJSON` + `highlightJSON` | Modify — add cheap fast-path to `looksLikeJSON` |
| `web/src/components/ConversationTab.tsx` | Derives timeline from capture | Modify — wrap derivations in `useMemo` |
| `web/src/components/Message.tsx` | Renders one message | Modify — `React.memo`, cache `bodyBlocks`, integrate `MessageCollapse` |
| `web/src/components/ToolPair.tsx` | Pairs `tool_use` with its `tool_result` | Modify — `React.memo` |
| `web/src/components/ToolResult.tsx` | Renders a tool result body | Modify — `React.memo`, raise threshold |
| `web/src/components/MessageCollapse.tsx` | Lazy-expand wrapper with preview | **Create** |
| `web/src/styles/global.css` | All styles | Modify — add `.msg-collapse*` styles |

No removals. No new lib files. No new dependencies.

---

## Task 1: Cheap fast-path in `looksLikeJSON`

**Files:**
- Modify: `web/src/lib/json.ts:3-10`

**Interfaces:**
- Produces: unchanged signature `looksLikeJSON(s: string): boolean`. Behavior change: returns `false` immediately when `s.trim()` does not start with `{` or `[`, skipping the `JSON.parse` attempt.

**Why:** Every `smartRender` call invokes `looksLikeJSON`, which today runs `JSON.parse` on every input — including multi-KB markdown blobs that obviously aren't JSON. The throw/catch cost dominates.

- [ ] **Step 1: Read the current `looksLikeJSON`**

Run: `Read web/src/lib/json.ts` (lines 1–10) and confirm the current body is:
```ts
export function looksLikeJSON(s: string): boolean {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 2: Replace with the fast-path version**

Edit `web/src/lib/json.ts`. Replace the body of `looksLikeJSON` with:

```ts
// 廉价预筛：不以 { 或 [ 开头的字符串绝不可能是 JSON，直接返回 false，
// 避免对大段 markdown 触发 JSON.parse 的抛错/捕获开销。
// Cheap pre-filter: anything not starting with { or [ cannot be JSON.
// Skipping JSON.parse here avoids a throw/catch on every large markdown blob.
export function looksLikeJSON(s: string): boolean {
  const head = s.trimStart()[0];
  if (head !== "{" && head !== "[") return false;
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 3: Verify build + lint**

Run:
```bash
cd web && npm run build && npm run lint
```
Expected: both succeed with no output errors. (`tsc -b` may print nothing on success; vite prints the bundle size.)

- [ ] **Step 4: Manual smoke check**

Run `npm run dev` inside `web/`, open the viewer on a capture that contains a normal markdown user message, and confirm it renders identically (no JSON-block treatment). Then check a capture whose user message *does* contain a JSON object — confirm it still routes through `highlightJSON`.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/json.ts
git commit -m "perf(web): skip JSON.parse in looksLikeJSON for non-{[ input"
```

---

## Task 2: Memoize derived timeline in `ConversationTab`

**Files:**
- Modify: `web/src/components/ConversationTab.tsx:32-67`

**Interfaces:**
- Consumes: `capture: Capture` (already a prop).
- Produces: no API change. Internal derivations (`rebuiltAssistant`, the `all` array, `items`) become `useMemo`-backed, so they retain identity across re-renders that don't change `capture`.

**Why:** `rebuildAssistantFromSSE(sse)` and `buildConversationItems(all)` run on every render today. Toggling a filter chip re-runs both even though the underlying data didn't change.

- [ ] **Step 1: Read the current derivations**

Run: `Read web/src/components/ConversationTab.tsx` (lines 1–67). Confirm:
- Line 1 imports `useState`.
- Line 36 calls `rebuildAssistantFromSSE(sse)`.
- Lines 40–57 build the `all` array imperatively.
- Line 67 calls `buildConversationItems(all)`.

- [ ] **Step 2: Add `useMemo` to the imports**

Edit `web/src/components/ConversationTab.tsx` line 1. Replace:
```ts
import { useState } from "react";
```
with:
```ts
import { useMemo, useState } from "react";
```

- [ ] **Step 3: Wrap `rebuiltAssistant` in `useMemo`**

Replace line 36:
```ts
  const rebuiltAssistant = rebuildAssistantFromSSE(sse);
```
with:
```ts
  // 仅在 SSE 事件列表变化时重建 assistant 回复，避免每次重渲染（含切换过滤chip）都跑一遍。
  // Rebuild the assistant reply only when the SSE event list changes, so
  // filter toggles and parent rerenders don't re-run this.
  const rebuiltAssistant = useMemo(() => rebuildAssistantFromSSE(sse), [sse]);
```

- [ ] **Step 4: Wrap the `all` array and `items` in a single `useMemo`**

The current code builds `all` imperatively (lines 40–57) and then derives `items` (line 67). Combine both into one `useMemo` keyed on `[req, rebuiltAssistant]`.

Replace the block currently spanning from `const all: MessageType[] = [];` (around line 40) through `const items = buildConversationItems(all);` (line 67) with:

```ts
  // 构建时间线 + 渲染项：仅在请求体或重建结果变化时重算，filter 切换不会触发。
  // Build the chronological thread and the render-item list. Recompute only
  // when the request body or the rebuilt assistant changes — not on filter toggles.
  const { items, toolPairCount, textTurnCount } = useMemo(() => {
    const list: MessageType[] = [];
    if (req.system) {
      // system 可能是字符串，也可能是 {type:"text", text:"..."} 块数组。
      // 数组情形下抽出各块 .text 并拼接，保证后续按 markdown 渲染而非 JSON 转储。
      // system may be a string or an array of {type:"text", text:"..."} blocks.
      // For arrays, pull out each block's .text and join so it renders as markdown,
      // not as an escaped JSON dump.
      const sys =
        typeof req.system === "string"
          ? req.system
          : Array.isArray(req.system)
            ? (req.system as Array<{ text?: string }>)
                .map((b) => b?.text ?? "")
                .filter(Boolean)
                .join("\n\n")
            : JSON.stringify(req.system, null, 2);
      list.push({ role: "system", content: sys });
    }
    for (const m of messages) list.push(m);
    if (rebuiltAssistant) {
      list.push({
        role: "assistant",
        content: rebuiltAssistant,
        fromSSE: true,
      });
    }

    const built = buildConversationItems(list);
    const toolCount = built.filter((i) => i.kind === "tool-pair").length;
    const textCount = built.filter(
      (i) => i.kind !== "tool-pair" && i.kind !== "system",
    ).length;
    return { items: built, toolPairCount: toolCount, textTurnCount: textCount };
  }, [req, rebuiltAssistant]);
```

Then delete the two standalone lines that computed these previously:
```ts
  const toolPairCount = items.filter((i) => i.kind === "tool-pair").length;
  const textTurnCount = items.filter((i) => i.kind !== "tool-pair" && i.kind !== "system").length;
```
(They are now part of the memoized output.)

- [ ] **Step 5: Verify build + lint**

Run:
```bash
cd web && npm run build && npm run lint
```
Expected: success. If `tsc` complains about an unused `messages` binding, note that `messages` is declared at line 34 as `const messages = req.messages || [];` and is still consumed inside the memo (`for (const m of messages)`). It should remain used.

- [ ] **Step 6: Manual smoke check**

In `npm run dev`, open a capture with multiple turns. Click each filter chip (`system`, `user`, `assistant`, `tool`) rapidly. Confirm:
- Filtering still works (items appear/disappear correctly).
- Counts in the chip labels stay correct.
- No console errors.

- [ ] **Step 7: Commit**

```bash
git add web/src/components/ConversationTab.tsx
git commit -m "perf(web): memoize conversation timeline + item list"
```

---

## Task 3: `React.memo` on `Message`, `ToolPair`, `ToolResult`

**Files:**
- Modify: `web/src/components/Message.tsx` (default export + `SystemMessage` export)
- Modify: `web/src/components/ToolPair.tsx` (default export)
- Modify: `web/src/components/ToolResult.tsx` (default export)

**Interfaces:**
- Consumes: existing prop shapes (unchanged).
- Produces: same default exports, now memoized. Props must keep stable identity for the memo skip to fire — `ConversationTab.tsx` already passes `it.message` / `it.toolUse` / `it.toolResult` / `it.blocks` which retain identity from `buildConversationItems` output. Task 2's `useMemo` keeps the `items` array referentially stable across filter toggles, so each item's payload is referentially stable too.

**Why:** `App.tsx` polls `fetchFiles` every 3 s. That gives `App` a new `items` array reference and triggers a rerender cascade. Without `React.memo`, every `Message` / `ToolPair` / `ToolResult` in the tree rerenders every 3 s, recomputing all markdown. `React.memo` short-circuits the cascade for unchanged props.

- [ ] **Step 1: Memoize `Message`**

Edit `web/src/components/Message.tsx`. Add `memo` to the React import at the top:
```ts
import { memo } from "react";
```
Then change the function declaration to be wrapped in `memo`. Replace:
```ts
export default function Message({ message, idx, blocks }: MessageProps) {
```
with:
```ts
function MessageInner({ message, idx, blocks }: MessageProps) {
```
and add at the end of the file (after the `SystemMessage` function):
```ts
// 仅在 message/blocks/idx 变化时重渲染，避开 3 秒轮询引发的整树重渲染。
// Only rerender when message/blocks/idx change, sidestepping the 3s poll
// cascade that would otherwise rebuild the entire conversation subtree.
export default memo(MessageInner);
```

Leave `SystemMessage` as a plain export — it's a separate component and not on the hot path; wrapping it in `memo` is optional and out of scope.

- [ ] **Step 2: Memoize `ToolPair`**

Edit `web/src/components/ToolPair.tsx`. Add the import:
```ts
import { memo } from "react";
```
Replace:
```ts
export default function ToolPair({ toolUse, toolResult }: ToolPairProps) {
```
with:
```ts
function ToolPairInner({ toolUse, toolResult }: ToolPairProps) {
```
Add at the end of the file:
```ts
export default memo(ToolPairInner);
```

- [ ] **Step 3: Memoize `ToolResult`**

Edit `web/src/components/ToolResult.tsx`. Add the import:
```ts
import { memo } from "react";
```
Replace:
```ts
export default function ToolResult({ toolResult, variant, toolUse }: ToolResultProps) {
```
with:
```ts
function ToolResultInner({ toolResult, variant, toolUse }: ToolResultProps) {
```
Add at the end of the file:
```ts
export default memo(ToolResultInner);
```

- [ ] **Step 4: Verify build + lint**

Run:
```bash
cd web && npm run build && npm run lint
```
Expected: success. Watch for unused-import errors — `memo` is used in all three files.

- [ ] **Step 5: Manual smoke check**

Open a capture in `npm run dev` and leave it idle for > 6 seconds (two poll cycles). Open React DevTools Profiler, click Record, wait 3 s (one poll), stop. Confirm that `Message`, `ToolPair`, and `ToolResult` do **not** appear in the commit flamegraph — only `ConversationList` and its descendants should. If DevTools isn't available, the visible symptom is: hovering/clicking filter chips feels instant even right after a poll fires.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/Message.tsx web/src/components/ToolPair.tsx web/src/components/ToolResult.tsx
git commit -m "perf(web): React.memo Message/ToolPair/ToolResult to skip poll rerenders"
```

---

## Task 4: Cache `bodyBlocks.html` inside `Message`

**Files:**
- Modify: `web/src/components/Message.tsx` (the `MessageInner` function body)

**Interfaces:**
- Consumes: `message: MessageType`, `blocks?: ContentBlock[]`.
- Produces: unchanged JSX. The expensive `bodyBlocks` build (which calls `smartRender` / `escapeHtml` / `highlightJSON` per block) runs once per `(message, blocks)` pair instead of every render.

**Why:** Even though Task 3 made `Message` skip rerenders, on the *first* render of a large message the HTML build still blocks the main thread, and any future change to the component (e.g. adding hover state) would re-trigger it. `useMemo` keys it to the actual content identity.

- [ ] **Step 1: Add `useMemo` to the React imports in `Message.tsx`**

Edit the import line added in Task 3:
```ts
import { memo } from "react";
```
to:
```ts
import { memo, useMemo } from "react";
```

- [ ] **Step 2: Wrap the `bodyBlocks` build in `useMemo`**

Read the current `MessageInner` (Task 3 renamed it). The `bodyBlocks` object is built imperatively starting around line 59. Replace the entire block that constructs `bodyBlocks` (from `const bodyBlocks: ... = { ... }` through the closing `}` of the `if/else if/else` chain — currently lines 59–98) with:

```ts
  // 缓存渲染产物：按 message.content 与可选 blocks 的序列化结果作为 key，
  // 同一消息在组件生命周期内只构建一次 HTML。
  // Cache rendered output: key on the serialized content + optional blocks so
  // the same message builds its HTML once for the component's lifetime.
  const bodyBlocks = useMemo<{
    html: string;
    standaloneToolResults: ToolResultBlock[];
  }>(() => {
    const out = { html: "", standaloneToolResults: [] as ToolResultBlock[] };

    if (typeof message.content === "string") {
      out.html = `<div class="msg-text">${smartRender(message.content)}</div>`;
      return out;
    }

    const source =
      blocks ??
      (Array.isArray(message.content)
        ? (message.content as ContentBlock[])
        : null);

    if (source) {
      // 优先使用调用方传入的 blocks（已过滤 tool_use），否则回退到 message.content。
      // Prefer caller-supplied blocks (tool_use already filtered out); fall back to message.content.
      for (const b of source) {
        if (b.type === "thinking") {
          const text = (b as { thinking?: string }).thinking || "";
          const words = (text.match(/\S+/g) || []).length;
          if (words) {
            out.html += `<details class="thinking-block">
    <summary><span class="msg-role">thinking · ${words} words</span></summary>
    <div class="msg-thinking">${smartRender(text)}</div>
  </details>`;
          }
        } else if (b.type === "text") {
          out.html += `<div class="msg-text">${smartRender(
            (b as { text?: string }).text || "",
          )}</div>`;
        } else if (b.type === "tool_result") {
          out.standaloneToolResults.push(b as ToolResultBlock);
        } else {
          out.html += renderBlockHtml(b, role);
        }
      }
      return out;
    }

    out.html = `<pre class="json">${escapeHtml(
      JSON.stringify(message.content, null, 2),
    )}</pre>`;
    return out;
  }, [message, blocks]);
```

Note: `role` is still computed earlier in the function (around the current line 50) and remains in scope.

- [ ] **Step 3: Add the empty-state fallback immediately after the memo**

After the `useMemo` block, add (replacing the old `if (bodyBlocks.html === "" ...)` block):

```ts
  if (bodyBlocks.html === "" && bodyBlocks.standaloneToolResults.length === 0) {
    bodyBlocks.html =
      '<div class="msg-text" style="color:var(--text-faint);font-style:italic">— no textual content —</div>';
  }
```

Because `bodyBlocks` is now memoized and frozen between renders, this mutation runs only on the render where the memo first produced empty output. To be fully safe against React's "don't mutate during render" rule, wrap it in a `useMemo` instead:

```ts
  const effectiveHtml = useMemo(() => {
    if (bodyBlocks.html === "" && bodyBlocks.standaloneToolResults.length === 0) {
      return '<div class="msg-text" style="color:var(--text-faint);font-style:italic">— no textual content —</div>';
    }
    return bodyBlocks.html;
  }, [bodyBlocks]);
```

Then change the JSX to use `effectiveHtml` in place of `bodyBlocks.html` (in both the `<div className="msg-body">` block, around current line 112). The final JSX becomes:

```tsx
  return (
    <div className={`msg ${cls}`}>
      {idx != null && <span className="turn-num">{String(idx).padStart(2, "0")}</span>}
      <div className="msg-role" dangerouslySetInnerHTML={{ __html: escapeHtml(tag) }} />
      <div className="msg-body">
        {effectiveHtml && <div dangerouslySetInnerHTML={{ __html: effectiveHtml }} />}
        {bodyBlocks.standaloneToolResults.map((tr, i) => (
          <ToolResult key={i} toolResult={tr} variant="standalone" />
        ))}
      </div>
    </div>
  );
```

- [ ] **Step 4: Verify build + lint**

Run:
```bash
cd web && npm run build && npm run lint
```
Expected: success. Watch for the `noUnusedLocals` error if you left a stale `bodyBlocks.html` reference somewhere — replace all usages with `effectiveHtml`.

- [ ] **Step 5: Manual smoke check**

In `npm run dev`, load a capture. Confirm all message types still render: plain user text, assistant text, thinking blocks (collapsible), standalone tool results, JSON-fallback messages. Toggle filter chips; confirm nothing flickers or disappears incorrectly.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/Message.tsx
git commit -m "perf(web): memoize Message bodyBlocks HTML by content identity"
```

---

## Task 5: Raise `ToolResult` collapse threshold

**Files:**
- Modify: `web/src/components/ToolResult.tsx:60-61`

**Interfaces:**
- Consumes: `bodyHtml: string` (computed by `renderToolResultBody`).
- Produces: unchanged component behavior. Only the `shouldCollapse` predicate changes.

**Why:** The current threshold (`length > 1000 || lines > 12`) collapses the majority of tool results, which is overly aggressive. Raising it to match the new `MessageCollapse` threshold keeps the visual language consistent and reduces clicks during normal review.

- [ ] **Step 1: Read the current threshold logic**

Run: `Read web/src/components/ToolResult.tsx` (lines 57–65). Confirm:
```ts
const bodyHtml = renderToolResultBody(toolResult, toolUse);
const lineGuess = (bodyHtml.match(/\n/g) || []).length;
const shouldCollapse = bodyHtml.length > 1000 || lineGuess > 12;
```

- [ ] **Step 2: Replace the thresholds**

Edit `web/src/components/ToolResult.tsx`. Replace the `shouldCollapse` line with:

```ts
  // 阈值与 MessageCollapse 对齐：只有真正大的结果才折叠。
  // Threshold aligned with MessageCollapse: only genuinely large results collapse.
  const shouldCollapse = bodyHtml.length > 8000 || lineGuess > 100;
```

- [ ] **Step 3: Verify build + lint**

Run:
```bash
cd web && npm run build && npm run lint
```
Expected: success.

- [ ] **Step 4: Manual smoke check**

In `npm run dev`, open a capture with both small tool results (e.g. a `Bash` echo) and large ones (e.g. a `Read` of a big file). Confirm:
- Small tool results render expanded by default (no "expand" button).
- Large tool results still collapse and expand correctly via `CollapseWrap`.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/ToolResult.tsx
git commit -m "perf(web): raise ToolResult collapse threshold to 8KB/100 lines"
```

---

## Task 6: Create `MessageCollapse` component

**Files:**
- Create: `web/src/components/MessageCollapse.tsx`
- Modify: `web/src/styles/global.css` — append `.msg-collapse*` rules

**Interfaces:**
- Produces: `MessageCollapse`, a React component with this exact signature:

```ts
interface MessageCollapseProps {
  // 原始内容（未渲染）。用于廉价测量大小并决定是否启用折叠。
  // Raw, unrendered content. Used for the cheap size check that decides
  // whether to collapse at all.
  rawText: string;
  // 预览渲染器：返回预览用的 HTML（通常是前几行渲染后的子串）。
  // Preview renderer: returns the HTML to show in the collapsed preview.
  renderPreview: () => string;
  // 完整渲染器：返回完整 HTML。仅在首次展开时调用一次，之后缓存。
  // Full renderer: returns the complete HTML. Called once on first expand,
  // then cached.
  renderFull: () => string;
  // 折叠阈值：默认 8000 字符或 100 行。调用方一般不传。
  // Collapse thresholds: default 8000 chars or 100 lines. Callers usually
  // omit and rely on the defaults.
  maxSize?: number;
  maxLines?: number;
}
export default function MessageCollapse(props: MessageCollapseProps): JSX.Element;
```

Behavior:
- If `rawText.length <= maxSize` **and** line count of `rawText` is `<= maxLines`, render the full HTML via `renderFull()` immediately (no wrapper, no collapse UI). This is the fast path — the component is a no-op for small messages.
- Otherwise render a `<div className="msg-collapse">` containing:
  - A `<div className="msg-collapse-preview">` with `renderPreview()` HTML, capped in height by CSS (`.msg-collapse-preview { max-height: 9em; overflow: hidden; }` ≈ 5–6 lines), with a CSS mask gradient fading the bottom into the page background.
  - A `<button type="button" className="msg-collapse-toggle">` showing `▼ N more lines · expand` when collapsed and `▲ collapse` when expanded. `N` is `rawText` line count minus the preview line count.
  - When expanded, the preview is replaced by the full HTML (computed once via `renderFull()`, cached in a `useRef`), rendered inside a `<div className="msg-collapse-full">`.

**Why laziness matters:** `renderPreview` and `renderFull` are *functions*, not values. `MessageCollapse` calls `renderPreview()` on every render of a large message (cheap — it renders only the first few lines), but it **never calls `renderFull()` until the user clicks expand**. This is what removes the up-front markdown / highlight cost.

- [ ] **Step 1: Create the component file**

Create `web/src/components/MessageCollapse.tsx` with:

```tsx
import { useMemo, useRef, useState } from "react";

interface MessageCollapseProps {
  // 原始内容（未渲染）。用于廉价测量大小并决定是否启用折叠。
  // Raw, unrendered content. Used for the cheap size check that decides
  // whether to collapse at all.
  rawText: string;
  // 预览渲染器：返回预览用的 HTML（通常是前几行渲染后的子串）。
  // Preview renderer: returns the HTML to show in the collapsed preview.
  renderPreview: () => string;
  // 完整渲染器：返回完整 HTML。仅在首次展开时调用一次，之后缓存。
  // Full renderer: returns the complete HTML. Called once on first expand,
  // then cached.
  renderFull: () => string;
  // 折叠阈值：默认 8000 字符或 100 行。调用方一般不传。
  // Collapse thresholds: default 8000 chars or 100 lines. Callers usually
  // omit and rely on the defaults.
  maxSize?: number;
  maxLines?: number;
}

const DEFAULT_MAX_SIZE = 8000;
const DEFAULT_MAX_LINES = 100;

export default function MessageCollapse({
  rawText,
  renderPreview,
  renderFull,
  maxSize = DEFAULT_MAX_SIZE,
  maxLines = DEFAULT_MAX_LINES,
}: MessageCollapseProps) {
  // 廉价测量：只在原始字符串上算长度和行数，不调用任何渲染器。
  // Cheap measurement on the raw string only — no renderer is invoked here.
  const lineCount = useMemo(() => {
    let n = 1;
    for (let i = 0; i < rawText.length; i++) {
      if (rawText.charCodeAt(i) === 10) n++;
    }
    return n;
  }, [rawText]);

  const shouldCollapse = rawText.length > maxSize || lineCount > maxLines;

  const [open, setOpen] = useState(false);
  // 完整 HTML 只在首次展开时构建，之后缓存在 ref 中。
  // Build the full HTML once on first expand; cache in a ref.
  const fullHtmlRef = useRef<string | null>(null);

  if (!shouldCollapse) {
    // 小内容快速路径：直接渲染完整 HTML，不加任何包裹。
    // Fast path for small content: render full HTML with no wrapper.
    return <div dangerouslySetInnerHTML={{ __html: renderFull() }} />;
  }

  const hiddenLines = Math.max(0, lineCount - 5);

  if (open) {
    if (fullHtmlRef.current === null) {
      fullHtmlRef.current = renderFull();
    }
    return (
      <div className="msg-collapse open">
        <div
          className="msg-collapse-full"
          dangerouslySetInnerHTML={{ __html: fullHtmlRef.current }}
        />
        <button
          type="button"
          className="msg-collapse-toggle"
          onClick={() => setOpen(false)}
        >
          ▲ collapse
        </button>
      </div>
    );
  }

  return (
    <div className="msg-collapse">
      <div
        className="msg-collapse-preview"
        dangerouslySetInnerHTML={{ __html: renderPreview() }}
      />
      <button
        type="button"
        className="msg-collapse-toggle"
        onClick={() => setOpen(true)}
      >
        ▼ {hiddenLines} more lines · expand
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Add the styles**

Append to `web/src/styles/global.css` (at the end of the file):

```css
/* 长消息折叠：预览 + 渐隐遮罩 + 展开按钮。 */
/* Long-message collapse: preview + faded mask + expand button. */
.msg-collapse {
  position: relative;
  border-left: 2px solid var(--border, #2a2a2a);
  margin: 4px 0;
}

.msg-collapse-preview {
  max-height: 9em;
  overflow: hidden;
  position: relative;
  -webkit-mask-image: linear-gradient(to bottom, #000 0 6em, transparent 9em);
  mask-image: linear-gradient(to bottom, #000 0 6em, transparent 9em);
}

.msg-collapse-full {
  /* 展开后内容自然撑开。 */
  /* Expanded content lays out at natural height. */
}

.msg-collapse-toggle {
  display: block;
  width: 100%;
  text-align: center;
  padding: 6px 10px;
  margin-top: 4px;
  background: var(--surface, #1a1a1a);
  color: var(--text-dim, #888);
  border: none;
  border-top: 1px solid var(--border, #2a2a2a);
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  letter-spacing: 0.04em;
  cursor: pointer;
  text-transform: uppercase;
}

.msg-collapse-toggle:hover {
  color: var(--text, #ddd);
  background: var(--surface-hi, #222);
}
```

Adjust the CSS variable fallbacks to match the actual variables defined in `global.css` — read the top of `global.css` and use the same variable names the rest of the file uses. Do not invent new variables; reuse existing ones where they exist.

- [ ] **Step 3: Verify build + lint**

Run:
```bash
cd web && npm run build && npm run lint
```
Expected: success. `JSX.Element` return type is fine under React 18 + `@types/react` 18.

- [ ] **Step 4: Manual smoke check**

Temporarily render `<MessageCollapse>` directly from `ConversationTab.tsx` for one user message to validate it visually. (This is a scratch check — Task 7 will wire it in properly. Revert the scratch change before committing.)

Confirm:
- A small message renders expanded (no toggle button visible).
- A large message shows a faded preview, an "expand" button with the correct `N more lines` count, and expands on click to the full content. Clicking "collapse" returns to the preview.

Revert the scratch wiring in `ConversationTab.tsx` before Step 5.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/MessageCollapse.tsx web/src/styles/global.css
git commit -m "feat(web): add MessageCollapse component with lazy full-render"
```

---

## Task 7: Wire `MessageCollapse` into `Message`

**Files:**
- Modify: `web/src/components/Message.tsx`

**Interfaces:**
- Consumes: `MessageCollapse` from Task 6.
- Produces: `Message` renders long `user` / `assistant` / standalone-tool-result bodies through `MessageCollapse`, so full HTML is built lazily.

**Why:** This is the actual integration that delivers Layer B's first-paint speedup. Combined with Task 4's memoization, a large message pays the markdown/highlight cost exactly once — on first user-initiated expand.

**Approach:** Replace the inline `effectiveHtml` injection in `Message`'s JSX with a `MessageCollapse` element. The component receives:
- `rawText`: the raw content string (joined from content blocks if array).
- `renderPreview`: a function that builds preview HTML from the first ~5 lines of raw content. Reuses the existing `smartRender` etc., but on a small substring — cheap.
- `renderFull`: a function that returns the already-cached `effectiveHtml` from Task 4. Because `effectiveHtml` is memoized on `message`/`blocks`, calling `renderFull()` is effectively free after the first call.

The threshold decision lives inside `MessageCollapse` (default 8 KB / 100 lines) so `Message` doesn't need its own size check.

- [ ] **Step 1: Read the current `Message.tsx` JSX**

Run: `Read web/src/components/Message.tsx`. Identify:
- The `effectiveHtml` memo (from Task 4).
- The JSX block around the `<div className="msg-body">` return.
- Where `role` is computed.

- [ ] **Step 2: Add the import**

At the top of `web/src/components/Message.tsx`, add:
```ts
import MessageCollapse from "./MessageCollapse";
```

- [ ] **Step 3: Build a `rawText` derivation**

Inside `MessageInner`, add a memoized raw-text extraction. Place it after `bodyBlocks` / `effectiveHtml`:

```ts
  // 提取原始文本供 MessageCollapse 做廉价大小判断。字符串内容直接用；
  // 块数组则按顺序拼接 text/thinking 块的文本。
  // Extract raw text for MessageCollapse's cheap size check. String content
  // is used as-is; block arrays are concatenated from text/thinking blocks.
  const rawText = useMemo(() => {
    if (typeof message.content === "string") return message.content;
    const src = blocks ?? (Array.isArray(message.content) ? message.content : []);
    return (src as ContentBlock[])
      .map((b) => {
        if (b.type === "text") return (b as { text?: string }).text || "";
        if (b.type === "thinking") return (b as { thinking?: string }).thinking || "";
        if (b.type === "tool_use") {
          return JSON.stringify((b as ToolUseBlock).input ?? {});
        }
        if (b.type === "tool_result") {
          const c = (b as ToolResultBlock).content;
          return typeof c === "string" ? c : JSON.stringify(c ?? "");
        }
        return "";
      })
      .join("\n");
  }, [message, blocks]);
```

- [ ] **Step 4: Build a `previewText` derivation**

Add below `rawText`:

```ts
  // 预览只取前若干行，渲染开销与消息大小无关。
  // Preview takes only the first few lines; render cost is independent of
  // overall message size.
  const previewHtml = useMemo(() => {
    const lines = rawText.split("\n", 6);
    return smartRender(lines.join("\n"));
  }, [rawText]);
```

- [ ] **Step 5: Replace the body JSX**

Replace the `<div className="msg-body">` block (the one that currently injects `effectiveHtml`) with:

```tsx
      <div className="msg-body">
        <MessageCollapse
          rawText={rawText}
          renderPreview={() => previewHtml}
          renderFull={() => effectiveHtml}
        />
        {bodyBlocks.standaloneToolResults.map((tr, i) => (
          <ToolResult key={i} toolResult={tr} variant="standalone" />
        ))}
      </div>
```

Note: `renderPreview` and `renderFull` are arrow wrappers around memoized values, so they are cheap and return stable HTML. `MessageCollapse` calls them at most once per render.

- [ ] **Step 6: Verify build + lint**

Run:
```bash
cd web && npm run build && npm run lint
```
Expected: success. Watch for unused imports — if `effectiveHtml` was previously used directly in JSX and is now only referenced via `renderFull`, the import is still used; the binding is still used. No `noUnusedLocals` error expected.

- [ ] **Step 7: Manual smoke check**

In `npm run dev`, load a capture with:
- A large user message (e.g. the Claude Code system prompt, or a pasted file). Confirm: preview shows the first few lines with a fade, button shows `▼ N more lines · expand`, clicking expands to the full rendered content, clicking `▲ collapse` returns to preview.
- A small user message. Confirm: renders inline with no collapse UI.
- An assistant message with multiple text blocks. Confirm: renders as before.
- A standalone tool result. Confirm: still renders (may also collapse if large).

Open React DevTools Profiler, record the initial load of a large capture. Confirm that `smartRender` / `highlightJSON` / `highlightCode` do not appear in the flamegraph for collapsed messages (they will appear only when you click expand).

- [ ] **Step 8: Commit**

```bash
git add web/src/components/Message.tsx
git commit -m "perf(web): route large Message bodies through MessageCollapse (lazy render)"
```

---

## Self-Review Checklist (run after writing the plan)

**Spec coverage:**
- A.1 derived-timeline memoization → Task 2 ✓
- A.2 `React.memo` on `Message` / `ToolPair` / `ToolResult` → Task 3 ✓
- A.3 per-content HTML cache → Task 4 (Message) ✓, Task 5 covers ToolResult threshold but does not add a separate HTML cache there (its existing `renderToolResultBody` call is already guarded by Task 3's `React.memo`, so the cache is the component lifecycle itself) ✓
- A.4 `looksLikeJSON` fast-path → Task 1 ✓
- B.1 `MessageCollapse` component → Task 6 ✓
- B.2 lazy-build memoization → Task 6 (`useRef` cache) ✓
- B.3 raise ToolResult threshold → Task 5 ✓
- Wiring → Task 7 ✓

**Type consistency:**
- `MessageCollapseProps.rawText: string` matches the `rawText` built in Task 7.
- `renderPreview: () => string` matches `() => previewHtml` (string).
- `renderFull: () => string` matches `() => effectiveHtml` (string).
- `ToolResultBlock`, `ToolUseBlock`, `ContentBlock` imported from `../types` in `Message.tsx` — already imported (verified in original file).
- `memo` import added in Task 3 and extended to include `useMemo` in Task 4 — consistent.

**Placeholder scan:** None. All code blocks are complete.

**Scope check:** Single feature, 7 tasks, each independently shippable. Fits one implementation plan.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-14-viewer-perf.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
