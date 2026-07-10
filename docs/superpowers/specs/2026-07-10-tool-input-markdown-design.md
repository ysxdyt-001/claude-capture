# Tool input markdown rendering — design

**Date:** 2026-07-10
**Scope:** Conversation tab only. Fixes the UX issue where markdown-bearing string fields inside tool inputs render as escaped JSON text instead of formatted markdown.

## Problem

`ToolPair.tsx` renders every tool input as one JSON dump:

```tsx
const inputJson = JSON.stringify(input, null, 2);
<pre className="j-block flat" dangerouslySetInnerHTML={{ __html: highlightJSON(inputJson) }} />
```

Several Claude Code tools carry prose in their inputs that is semantically markdown:

- `AskUserQuestion` — `questions[].question`, `questions[].options[].description`, `questions[].options[].preview`
- `TaskCreate` — `subject`, `description`
- `Bash` — `description`

In the JSON dump these show with literal `\n`, `*`, and `` ` `` characters, which is the UX complaint: *"some fields in json is markdown type, but display in text"*.

Tool **results** already pass string content through `smartRender` (`ToolResult.tsx` → `renderContentSegments`), so they are not affected.

## Approach

Per-field allowlist (chosen over heuristic detection to avoid misrendering `command`/`file_path`/code strings; chosen over a per-field toggle because the default experience is the actual complaint).

## Design

### Allowlist

New module `web/src/lib/toolInput.ts` exports:

```ts
export const MARKDOWN_FIELDS = new Set([
  "description", "preview", "subject", "question", "reason",
  "comment", "message", "prompt", "summary", "body",
  "explanation", "note", "notes",
]);
```

These are semantically prose field names. Structural / identifier / code field names are deliberately excluded:

- Code/file content: `content`, `new_string`, `old_string`, `command`
- Identifiers / paths: `file_path`, `pattern`, `skill`, `taskId`, `id`, `label`, `header`, `activeForm`

The list is keyed by **leaf field name**, not by tool name, so it generalizes to new tools without code changes.

### Recursive renderer

`renderToolInput(value: unknown, keyHint?: string): string` returns HTML. Rules, evaluated top-down:

1. **String + `keyHint` ∈ MARKDOWN_FIELDS + contains a markdown signal** (`\n`, `#`, `*`, `` ` ``, `-`, `>`, `|`, or length > 80) → `smartRender(value)` wrapped in `<div class="msg-text">`.
2. **String** (otherwise) →
   - Single-line AND length ≤ 80 → `<code class="j-inline">${escapeHtml(value)}</code>`.
   - Else → `<div class="j-block-wrap"><pre class="j-block">${highlightJSON(JSON.stringify(value, null, 2))}</pre></div>` (long strings stay quoted/escaped, but at least pretty-printed).
3. **Array** → each element rendered via `renderToolInput(element, "")`, wrapped in a `.input-array` list. Each element of an array-of-objects gets a numbered `.input-row` card so nested prose fields surface naturally.
4. **Object** → a stack of `.input-row` rows; each row is `[key label] + renderToolInput(value, key)`. Recursion carries the key as `keyHint` so leaf strings are checked against the allowlist by their real field name.
5. **number / boolean / null** → inline token via `highlightJSON(JSON.stringify(value))`.

The `keyHint` threading is what lets `AskUserQuestion.questions[0].options[1].preview` be detected: the leaf string's key is `preview`, which is in the allowlist.

### ToolPair changes

`ToolPair.tsx` replaces its inline `inputJson` / `highlightJSON` block with:

```tsx
<div
  className="tool-pair-input"
  dangerouslySetInnerHTML={{ __html: renderToolInput(toolUse.input ?? {}) }}
/>
```

The `isCompact` short-string fast path is removed — it's now handled inside `renderToolInput` (rule 2).

### Message.tsx consistency

`renderBlockHtml`'s `tool_use` branch (used for orphan tool_use blocks that aren't paired into a `ToolPair`) currently duplicates the JSON-dump logic. It switches to `renderToolInput` so standalone rendering matches paired rendering.

### CSS

Add to `web/src/styles/global.css` (next to existing `.tool-pair-input` rules):

```css
.tool-pair-input .input-row {
  display: grid;
  grid-template-columns: 140px 1fr;
  gap: 12px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--line-faint);
  align-items: start;
}
.tool-pair-input .input-row:last-child { border-bottom: none; }
.tool-pair-input .input-key {
  font-family: var(--font-mono);
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.10em;
  color: var(--text-faint);
  padding-top: 2px;
}
.tool-pair-input .input-array {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.tool-pair-input .input-array .input-row {
  background: var(--paper-2);
  border: 1px solid var(--line-faint);
  border-radius: 4px;
  padding: 10px 12px;
}
.tool-pair-input .msg-text { font-size: 12.5px; }
.tool-pair-input .msg-text .md-p:last-child { margin-bottom: 0; }
```

No new color tokens, no new fonts. Reuses the `.k`-style visual language already in `.meta-table .kv`.

## Files touched

- **New** `web/src/lib/toolInput.ts` — allowlist + `renderToolInput`.
- **Edit** `web/src/components/ToolPair.tsx` — call `renderToolInput`, drop inline JSON dump and `isCompact` path.
- **Edit** `web/src/components/Message.tsx` — `tool_use` branch of `renderBlockHtml` reuses `renderToolInput`.
- **Edit** `web/src/styles/global.css` — `.input-row` / `.input-key` / `.input-array` rules.

## Non-goals

- No change to tool result rendering (already markdown-aware via `smartRender`).
- No change to meta-table, message roles, SSE tab, or sidebar.
- No new runtime dependencies (root `package.json` stays empty).
- No syntax highlighting for non-JSON fenced code in markdown (existing `md-code` plain `<pre>` is unchanged).
- Bilingual comment style preserved in touched files (Chinese + English, per `CLAUDE.md`).

## Risks

- **False negatives**: a prose field not in the allowlist stays JSON-escaped. Mitigation: the allowlist is the obvious prose names; easy to extend later.
- **False positives**: a markdown-named field containing non-markdown gets rendered as markdown. Mitigation: markdown renderer is conservative — plain prose passes through unchanged inside `<p class="md-p">`.
- **`dangerouslySetInnerHTML`**: already used throughout this codebase; `smartRender`/`renderMarkdown` escape input before formatting, and `escapeHtml` covers literal paths. No new attack surface.
