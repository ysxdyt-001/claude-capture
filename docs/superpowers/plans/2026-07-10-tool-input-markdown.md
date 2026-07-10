# Tool Input Markdown Rendering — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render allowlisted prose fields inside tool inputs as formatted markdown instead of escaped JSON dumps.

**Architecture:** A new `toolInput.ts` module exports an allowlist of markdown field names and a recursive `renderToolInput(value, keyHint?)` function that returns HTML. `ToolPair.tsx` and `Message.tsx`'s orphan `tool_use` branch both call it instead of producing a JSON dump. New CSS rules style the field-row layout.

**Tech Stack:** React + TypeScript + Vite (existing `web/` project). No new runtime dependencies. Reuses existing `smartRender` (markdown/JSON detection), `highlightJSON`, and `escapeHtml` helpers.

## Global Constraints

- Root `package.json` has **zero runtime dependencies** — implementation uses only existing helpers in `web/src/lib/`.
- **Bilingual comments** (Chinese + English) required per `CLAUDE.md`, matching surrounding style.
- Target: Node ≥ 20. Viewer UI compiles via `npm run build` in `web/` (outputs to `dist/`).
- **No test suite exists** in this repo. Verification is: `cd web && npm run build` succeeds (TypeScript + Vite build), plus manual smoke check by running `npm run dev` and visually confirming an `AskUserQuestion` capture renders prose fields as markdown.
- HTML is injected via `dangerouslySetInnerHTML` (existing pattern in this codebase). All dynamic text must pass through `escapeHtml` or `smartRender`/`highlightJSON` (which escape internally) before injection.

---

## File Structure

- **New** `web/src/lib/toolInput.ts` — `MARKDOWN_FIELDS` allowlist + `renderToolInput(value: unknown, keyHint?: string): string`. Pure module, no React, no side effects. Single responsibility: decide how each leaf value renders.
- **Edit** `web/src/components/ToolPair.tsx` — drop inline JSON dump; call `renderToolInput` and inject its HTML. Removes the now-redundant `isCompact` path.
- **Edit** `web/src/components/Message.tsx` — `renderBlockHtml`'s `tool_use` branch reuses `renderToolInput` so orphan tool_use blocks stay consistent with paired ones.
- **Edit** `web/src/styles/global.css` — add `.input-row`, `.input-key`, `.input-array` rules next to existing `.tool-pair-input` block (after line 911).

---

### Task 1: `toolInput.ts` — allowlist + scalar/array branches

**Files:**
- Create: `web/src/lib/toolInput.ts`

**Interfaces:**
- Consumes: `smartRender` from `../lib/markdown`, `highlightJSON` from `../lib/json`, `escapeHtml` from `../lib/format`.
- Produces: `MARKDOWN_FIELDS: Set<string>` and `renderToolInput(value: unknown, keyHint?: string): string`. Both are consumed by Tasks 2 and 3.

- [ ] **Step 1: Create the module with allowlist and scalar handling**

Write `web/src/lib/toolInput.ts`:

```ts
import { escapeHtml } from "./format";
import { highlightJSON } from "./json";
import { smartRender } from "./markdown";

// 允许渲染为 markdown 的"散文型"字段名。按键名匹配，跨工具通用。
// Prose-shaped field names allowed to render as markdown. Matched by leaf
// key name so the rule generalizes across tools without per-tool config.
export const MARKDOWN_FIELDS = new Set([
  "description",
  "preview",
  "subject",
  "question",
  "reason",
  "comment",
  "message",
  "prompt",
  "summary",
  "body",
  "explanation",
  "note",
  "notes",
]);

// 判断字符串是否含有 markdown 信号：换行、标题、强调、代码、列表、引用、表格。
// Detect markdown signals so we only invoke the markdown renderer when relevant.
function hasMarkdownSignal(s: string): boolean {
  return (
    s.includes("\n") ||
    /(^|\s)#{1,6}\s/.test(s) ||
    /(^|\s)\*[^*\n]/.test(s) ||
    /(^|\s)_[^_\n]/.test(s) ||
    s.includes("`") ||
    /(^|\s)[-*+]\s/.test(s) ||
    /^>\s?/.test(s) ||
    s.includes("|") ||
    s.length > 80
  );
}

function renderScalar(value: string, keyHint?: string): string {
  // allowlist 命中且含 markdown 信号 → 走 smartRender（内部自动 JSON/markdown 分流）。
  // Allowlist hit with markdown signals → smartRender (auto JSON/markdown split).
  if (keyHint && MARKDOWN_FIELDS.has(keyHint) && hasMarkdownSignal(value)) {
    return `<div class="msg-text">${smartRender(value)}</div>`;
  }
  // 短的单行字符串 → 内联 code；长或多行 → JSON 块（保留转义）。
  // Short single-line strings render inline; long/multiline stay as JSON blocks.
  if (!value.includes("\n") && value.length <= 80) {
    return `<code class="j-inline">${escapeHtml(value)}</code>`;
  }
  const json = JSON.stringify(value, null, 2);
  return `<div class="j-block-wrap"><pre class="j-block">${highlightJSON(json)}</pre></div>`;
}

// 递归渲染工具输入。object → 字段行；array → 元素卡片；标量 → 内联或 markdown。
// Recursively render a tool input. object → field rows; array → element cards;
// scalars → inline or markdown depending on allowlist + signals.
export function renderToolInput(value: unknown, keyHint?: string): string {
  if (value == null) {
    return `<code class="j-inline">${escapeHtml(String(value))}</code>`;
  }
  if (typeof value === "string") {
    return renderScalar(value, keyHint);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return `<code class="j-inline">${highlightJSON(JSON.stringify(value))}</code>`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return `<code class="j-inline">[]</code>`;
    }
    const items = value
      .map((el, i) => {
        const inner = renderToolInput(el, "");
        // 元素是对象时编号成卡片，便于阅读嵌套 description / preview。
        // Number object elements as cards so nested prose surfaces cleanly.
        if (el && typeof el === "object" && !Array.isArray(el)) {
          return `<div class="input-row"><div class="input-key">#${i + 1}</div><div class="input-val">${inner}</div></div>`;
        }
        return `<div class="input-val">${inner}</div>`;
      })
      .join("");
    return `<div class="input-array">${items}</div>`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      return `<code class="j-inline">{}</code>`;
    }
    const rows = entries
      .map(([k, v]) => {
        const inner = renderToolInput(v, k);
        return `<div class="input-row"><div class="input-key">${escapeHtml(k)}</div><div class="input-val">${inner}</div></div>`;
      })
      .join("");
    return `<div class="input-obj">${rows}</div>`;
  }
  return `<code class="j-inline">${escapeHtml(String(value))}</code>`;
}
```

- [ ] **Step 2: Type-check the new module**

Run: `cd web && npx tsc --noEmit`
Expected: PASS, no errors. (If `tsc` isn't on PATH, `npm run build` in Step 4 of Task 4 also catches type errors.)

- [ ] **Step 3: Commit**

```bash
git add web/src/lib/toolInput.ts
git commit -m "feat(web): add toolInput renderer with markdown allowlist"
```

---

### Task 2: `ToolPair.tsx` — render input via `renderToolInput`

**Files:**
- Modify: `web/src/components/ToolPair.tsx`

**Interfaces:**
- Consumes: `renderToolInput` from `../lib/toolInput` (produced in Task 1).
- Produces: tool input cards now show markdown-rendered prose fields.

- [ ] **Step 1: Replace the input-rendering block**

The current `ToolPair.tsx` (lines 1-37) builds `inputJson`, `isCompact`, and `inputInner`, then renders `<div className="tool-pair-input">{inputInner}</div>`. Replace the whole component body to use `renderToolInput`.

Edit `web/src/components/ToolPair.tsx`. Replace the **entire file contents** with:

```tsx
import { escapeHtml } from "../lib/format";
import { renderToolInput } from "../lib/toolInput";
import type { ToolResultBlock, ToolUseBlock } from "../types";
import ToolResult from "./ToolResult";

interface ToolPairProps {
  toolUse: ToolUseBlock;
  toolResult: ToolResultBlock | null;
}

export default function ToolPair({ toolUse, toolResult }: ToolPairProps) {
  // 工具输入按字段递归渲染：allowlist 中的散文字段走 markdown，其余保持 JSON/内联。
  // Tool input renders recursively: prose fields in the allowlist go through
  // markdown; structural fields stay as JSON or inline code.
  const inputHtml = renderToolInput(toolUse.input ?? {});

  return (
    <div className="tool-pair">
      <div className="tool-pair-head">
        <span
          className="name"
          dangerouslySetInnerHTML={{ __html: escapeHtml(toolUse.name || "") }}
        />
        <span
          className="tool-id"
          dangerouslySetInnerHTML={{ __html: escapeHtml(toolUse.id || "") }}
        />
      </div>
      <div
        className="tool-pair-input"
        dangerouslySetInnerHTML={{ __html: inputHtml }}
      />
      {toolResult && <ToolResult toolResult={toolResult} variant="pair" />}
    </div>
  );
}
```

Note: `highlightJSON` import is removed (no longer used here — it now lives inside `toolInput.ts`). `escapeHtml` is still used for the tool name and id.

- [ ] **Step 2: Type-check**

Run: `cd web && npx tsc --noEmit`
Expected: PASS. If it complains that `highlightJSON` or `smartRender` imports are now unused, that confirms the cleanup is correct — they should NOT be present in the new file.

- [ ] **Step 3: Commit**

```bash
git add web/src/components/ToolPair.tsx
git commit -m "feat(web): render tool-pair input as structured fields with markdown"
```

---

### Task 3: `Message.tsx` — reuse `renderToolInput` for orphan `tool_use` blocks

**Files:**
- Modify: `web/src/components/Message.tsx` (the `renderBlockHtml` function's `tool_use` branch, around lines 27-42)

**Interfaces:**
- Consumes: `renderToolInput` from `../lib/toolInput` (produced in Task 1).
- Produces: orphan (unpaired) `tool_use` blocks render identically to paired ones.

- [ ] **Step 1: Add the import**

Edit `web/src/components/Message.tsx`. At the top of the file, after the existing imports (after `import ToolResult from "./ToolResult";` around line 6), add:

```ts
import { renderToolInput } from "../lib/toolInput";
```

- [ ] **Step 2: Replace the `tool_use` branch of `renderBlockHtml`**

The current `tool_use` branch (lines 27-42 in the original file) is:

```ts
  if (b.type === "tool_use") {
    const tu = b as ToolUseBlock;
    const input = tu.input ?? {};
    const inputJson = JSON.stringify(input, null, 2);
    const isCompact = !inputJson.includes("\n") && inputJson.length <= 80;
    const inputHtml = isCompact
      ? `<code class="j-inline">${highlightJSON(inputJson)}</code>`
      : `<div class="j-block-wrap"><pre class="j-block">${highlightJSON(inputJson)}</pre></div>`;
    return `<div class="tool-call">
      <div class="tool-head">
        <span class="name">${escapeHtml(tu.name || "")}</span>
        <span class="tool-id">${escapeHtml(tu.id || "")}</span>
      </div>
      <div class="tool-input">${inputHtml}</div>
    </div>`;
  }
```

Replace it with:

```ts
  if (b.type === "tool_use") {
    // 孤儿 tool_use（未配对进 ToolPair）也走结构化渲染，保持视觉一致。
    // Orphan tool_use blocks (not paired into ToolPair) reuse the same
    // structured renderer so prose fields stay consistent across views.
    const tu = b as ToolUseBlock;
    return `<div class="tool-call">
      <div class="tool-head">
        <span class="name">${escapeHtml(tu.name || "")}</span>
        <span class="tool-id">${escapeHtml(tu.id || "")}</span>
      </div>
      <div class="tool-input">${renderToolInput(tu.input ?? {})}</div>
    </div>`;
  }
```

- [ ] **Step 3: Type-check**

Run: `cd web && npx tsc --noEmit`
Expected: PASS. `highlightJSON` is still used elsewhere in this file (in the final `default` fallback return on line 47 and in `SystemMessage`), so its import must remain. `escapeHtml` import stays too.

- [ ] **Step 4: Commit**

```bash
git add web/src/components/Message.tsx
git commit -m "refactor(web): reuse renderToolInput for orphan tool_use blocks"
```

---

### Task 4: CSS — field-row layout for rendered inputs

**Files:**
- Modify: `web/src/styles/global.css` (add after the `.tool-pair-input pre.j-block.flat` block, which ends around line 911)

**Interfaces:**
- Consumes: HTML classes emitted by `renderToolInput`: `.input-obj`, `.input-row`, `.input-key`, `.input-val`, `.input-array`.

- [ ] **Step 1: Add the layout rules**

Edit `web/src/styles/global.css`. Find the block:

```css
.tool-pair-input pre.j-block.flat {
  margin: 0;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: 0;
}
```

Insert **immediately after** it:

```css
/* ============ TOOL-INPUT FIELD ROWS ============ */
.tool-pair-input .input-obj,
.tool-call .tool-input .input-obj {
  display: flex;
  flex-direction: column;
}
.tool-pair-input .input-row,
.tool-call .tool-input .input-row {
  display: grid;
  grid-template-columns: 140px 1fr;
  gap: 12px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--line-faint);
  align-items: start;
}
.tool-pair-input .input-row:last-child,
.tool-call .tool-input .input-row:last-child {
  border-bottom: none;
}
.tool-pair-input .input-key,
.tool-call .tool-input .input-key {
  font-family: var(--font-mono);
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.10em;
  color: var(--text-faint);
  padding-top: 2px;
}
.tool-pair-input .input-val,
.tool-call .tool-input .input-val {
  min-width: 0;
}
.tool-pair-input .input-array,
.tool-call .tool-input .input-array {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.tool-pair-input .input-array .input-row,
.tool-call .tool-input .input-array .input-row {
  background: var(--paper-2);
  border: 1px solid var(--line-faint);
  border-radius: 4px;
  padding: 10px 12px;
}
/* markdown 块在工具输入里字号略小，贴合周围信息密度。 */
/* Markdown blocks inside tool inputs render slightly smaller to match density. */
.tool-pair-input .msg-text,
.tool-call .tool-input .msg-text {
  font-size: 12.5px;
}
.tool-pair-input .msg-text .md-p:last-child,
.tool-call .tool-input .msg-text .md-p:last-child {
  margin-bottom: 0;
}
```

- [ ] **Step 2: Build the viewer UI**

Run: `cd web && npm run build`
Expected: Build succeeds, outputs to `dist/`. No TypeScript or Vite errors. (This is the whole-project verification step since there is no test suite.)

- [ ] **Step 3: Commit**

```bash
git add web/src/styles/global.css
git commit -m "style(web): field-row layout for structured tool inputs"
```

---

### Task 5: Manual smoke verification

**Files:**
- None modified — verification only.

**Interfaces:**
- Consumes: a capture containing an `AskUserQuestion` tool call (the current session has produced several; they live in `~/.claude-capture/captures/<session>/`).

- [ ] **Step 1: Run the dev server**

Run (background): `cd web && npm run dev`
The dev server proxies `/api/*` to the viewer backend. If the viewer backend isn't running, start it standalone against an existing capture dir, or run `claude-capture` once to produce a fresh session.

- [ ] **Step 2: Visually confirm**

Open the dev URL in a browser. Select a capture that contains an `AskUserQuestion` call. In the Conversation tab:

- The `AskUserQuestion` tool-pair card's input area shows structured rows: `questions` → numbered card(s) → each with `question`, `header`, `multiSelect`, and an `options` array → each option a numbered card with `label`, `description`, and (when present) `preview`.
- `description` and `preview` values render as **formatted markdown** (paragraphs, lists, inline code, code blocks) — not as `"\n..."` escaped JSON.
- `question` and `header` fields, if short single-line strings, render as inline `<code>` tokens.
- A `Bash` tool call shows `command` and `description`: `command` stays as an inline/JSON literal (NOT markdown), `description` renders as markdown if it has signals.
- A `TaskCreate` tool call shows `subject`, `description`, `activeForm`: `subject`/`description` render as markdown when multi-line or containing signals; `activeForm` (excluded from allowlist) stays inline.

- [ ] **Step 3: Confirm no regression on results**

Tool **result** cards (`ToolResult.tsx`) are untouched. Confirm they still render as before (markdown for string content via `smartRender`).

- [ ] **Step 4: No commit needed**

This task is verification only. If any check fails, file the issue against the relevant task above and fix before merging.

---

## Self-Review

**Spec coverage:**
- Allowlist (`MARKDOWN_FIELDS`) — Task 1, Step 1. ✓
- Recursive renderer with all 5 rules — Task 1, Step 1 (`renderToolInput` handles string/array/object/scalar/null; `renderScalar` handles the allowlist+signal test and the short-vs-long split). ✓
- `ToolPair.tsx` swap — Task 2. ✓
- `Message.tsx` orphan consistency — Task 3. ✓
- CSS `.input-row` / `.input-key` / `.input-array` — Task 4. ✓
- Bilingual comments — present in `toolInput.ts` (Task 1) and the `Message.tsx` edit (Task 3). ✓
- No new runtime deps — all imports are from existing `web/src/lib/` modules. ✓

**Placeholder scan:** No TBDs, no "add appropriate X", all code blocks are complete. ✓

**Type consistency:** `renderToolInput(value: unknown, keyHint?: string): string` — same signature in Task 1 (producer), Task 2 (ToolPair consumer), Task 3 (Message consumer). HTML class names `.input-obj`, `.input-row`, `.input-key`, `.input-val`, `.input-array` match between Task 1 (emitted) and Task 4 (styled). ✓
