# Subagent request tagging in the sidebar — design

**Date:** 2026-07-11
**Scope:** Sidebar list view. Adds a small colored pill to each capture row so the user can tell at a glance which requests were dispatched by the main Claude Code agent versus a subagent (general-purpose or Explore), versus an internal utility call (e.g. title generation).

## Problem

When the main agent dispatches a subagent (via the Agent tool), Claude Code opens a fresh `/messages` conversation with a different system prompt, a reduced tool set, and no shared history. Every one of these calls is captured as its own JSON file. In the viewer's sidebar they are visually indistinguishable from main-agent turns — the only per-row signals today are preview text, HTTP status, time, and file size. The user has no way to spot which rows are subagent work without opening each file and reading the system prompt.

Evidence from 716 existing captures in `~/.claude-capture/captures/`:

| Category | Captures | Tools | System-prompt length |
|---|---|---|---|
| Main agent | 337 | 25 | ~27,500 chars |
| Subagent (general-purpose) | 355 | 19 | ~2,945 chars |
| Subagent (Explore) | 10 | 16 | ~2,500 chars |
| Utility (title generation) | 2 | 0 | short |
| Other (empty system) | 13 | 0 | 0 |

The split is clean and bimodal: the main-agent and subagent populations do not overlap on tool count or system-prompt size.

## Approach

Classify each capture server-side when building the list response, emit a `tag` field on `ListItem`, and render a small colored pill on subagent/utility rows in the sidebar. Main-agent rows get no pill — they are the majority, so a pill on every row would be visual noise. The pill marks the exception, not the rule.

Classification uses three signals, consulted in priority order: the request URL path, the system-prompt text (stable, distinctive strings Claude Code itself injects), and the tool count as a final fallback (insurance against prompt-wording drift in future Claude Code versions).

## Design

### Classification logic

A new pure function `classifyRequest(data)` in `lib/server.mjs`, sibling to `extractLastUserText`. Takes the parsed capture object (the same `data` already produced by `JSON.parse` in `listCaptures`) and returns one of: `"main"` | `"subagent"` | `"explore"` | `"utility"` | `"unknown"`.

**Normalization.** The `system` field can be a string or an array of `{ type: "text", text }` blocks (Anthropic API allows both). The classifier joins array form into a single string before matching, mirroring how `ConversationTab` already handles it.

**Signal 1 — URL path** (`data.request.url`, substring match, checked first because it is the most unambiguous):

| URL contains | Tag |
|---|---|
| `/count_tokens` | `utility` |

This catches the token-counting endpoint, which Claude Code hits to estimate context usage. These requests have empty system prompts and no tools — they are not conversations at all, and the URL is the only reliable way to distinguish them. In the observed corpus this accounts for 13 of the 15 "zero-tool" captures.

**Signal 2 — system-prompt substring match** (case-sensitive, first 200 chars of the normalized system string):

| Match | Tag |
|---|---|
| `"You are an interactive agent"` | `main` |
| `"You are an agent for Claude Code"` | `subagent` |
| `"You are a file search specialist for Claude Code"` | `explore` |
| `"Generate a concise, sentence-case title"` | `utility` |

**Signal 3 — tool count fallback** (only consulted when neither signal 1 nor signal 2 matches):

| Tools array length | Tag |
|---|---|
| `>= 22` | `main` |
| `1`–`21` | `subagent` |
| `0` | `unknown` |
| otherwise (missing/non-array) | `unknown` |

Note: the previous draft mapped the `0`-tool fallback to `utility`. That was wrong — without a positive URL or system-prompt signal we cannot know what kind of call it is, so `unknown` (rendered as no pill) is the honest label. The two legitimate `utility` categories (count_tokens, title generation) are both caught positively by signals 1 and 2.

Today signals 1 and 2 classify 100% of observed captures; signal 3 is a cheap safety net against future wording changes and costs nothing at runtime.

### Server wiring

`lib/server.mjs` `listCaptures` already opens, reads, and `JSON.parse`-es every capture file to compute `preview` and `status` (lines 65–77). The new `tag` field is computed from the same `data` object during the same pass — zero additional I/O.

The successful-parse branch adds one line:

```js
const item = {
  name: childRel,
  mtime: stat.mtimeMs,
  size: stat.size,
  status: data.response?.status_code,
  preview: lastUser?.slice(0, 80) ?? "(empty)",
  tag: classifyRequest(data),   // ← new
};
```

The parse-error fallback branch (line 79) is unchanged — it omits `tag`, which the frontend treats as "no pill".

The cache identity guarantee (CLAUDE.md notes downstream React `memo` relies on `ListItem` object identity) is preserved: the cached `item` object simply carries one more field.

### Types

`web/src/types.ts` — extend `ListItem`:

```ts
export interface ListItem {
  name: string;
  mtime: number;
  size: number;
  status?: number;
  preview: string;
  tag?: string;   // ← new: "main" | "subagent" | "explore" | "utility" | "unknown"
}
```

No other type changes. No new network calls — the existing `/api/files` poll carries the new field through unchanged.

### Sidebar rendering

`web/src/components/ConversationList.tsx`, inside `TreeNodeRow`'s leaf branch (currently lines 132–150). The row currently renders:

```
<div class="file-item">
  <div class="preview">{preview}</div>
  <div class="meta">
    <span class="badge ok/err/neutral">{status}</span>
    <span>{time}</span>
    <span>{size}k</span>
  </div>
</div>
```

**Change.** Insert a tag pill at the start of the `preview` row, before the preview text. A small inline helper in the component maps tag → label + class, returning `null` for tags that should not render a pill:

| Tag | Label | CSS class | Render? |
|---|---|---|---|
| `main` | — | — | no |
| `subagent` | `Sub` | `tag tag-sub` | yes |
| `explore` | `Explore` | `tag tag-explore` | yes |
| `utility` | `Util` | `tag tag-util` | yes |
| `unknown` / missing | — | — | no |

Sketch:

```tsx
const tagPill = (() => {
  switch (it.tag) {
    case "subagent": return <span className="tag tag-sub">Sub</span>;
    case "explore":  return <span className="tag tag-explore">Explore</span>;
    case "utility":  return <span className="tag tag-util">Util</span>;
    default:         return null;
  }
})();
// ...
<div className="preview">{tagPill}{it.preview}</div>
```

Why no `main` pill: main-agent rows are roughly half of all captures. A pill on every row would be noise; the pill should mark the exception (subagent/utility traffic), letting subagent rows pop out visually.

### Styles

New CSS classes alongside the existing `.badge.ok` / `.badge.err` / `.badge.neutral` rules. Same sizing pattern as the status badge — small pill, single line, muted background tinted by category:

- `.tag-sub` — purple tint
- `.tag-explore` — green tint
- `.tag-util` — gray tint

Exact hues picked to harmonize with the existing sidebar palette during implementation.

## Edge cases & error handling

- **Parse-error rows** (`server.mjs:79` fallback): unchanged, omit `tag`, render no pill.
- **`/count_tokens` requests**: caught by signal 1 (URL match) regardless of system/tools. Rendered as `utility`.
- **Missing or empty `system` field**: signals 1 and 2 miss → tool-count fallback (signal 3) runs → sensible tag or `unknown`.
- **Missing `tools` array**: treated as length 0 → `unknown` via fallback (only reached if URL and system also miss).
- **`system` as array vs string**: normalized by the same join used elsewhere in the viewer.
- **Future Claude Code prompt drift**: signals 1 and 2 may miss → tool-count fallback covers the common case → worst case `unknown` → no pill rendered, graceful degradation, never crashes.

## Testing

Per `CLAUDE.md`: no test suite exists, and the runtime-dependency budget is locked at zero. No test framework will be added.

Verification is manual, against the existing corpus:

1. Run a one-shot Node script over every `*.json` under `~/.claude-capture/captures/` that imports (or invokes) `classifyRequest` and prints the tag distribution.
2. Confirm the distribution matches the analysis: ~337 `main`, ~355 `subagent`, ~10 `explore`, ~15 `utility` (13 count_tokens via signal 1 + 2 title-gen via signal 2), and ~0 `unknown`.
3. Rebuild the viewer (`cd web && npm run build`), run `claude-capture`, and eyeball the sidebar: subagent/utility rows show pills, main-agent rows do not.

The verification script lives in `/tmp` and is not committed.

## Files touched

| File | Change |
|---|---|
| `lib/server.mjs` | Add `classifyRequest(data)`; add `tag` field to `ListItem` |
| `web/src/types.ts` | Add `tag?: string` to `ListItem` |
| `web/src/components/ConversationList.tsx` | Render tag pill in leaf row |
| `web/src/styles/global.css` | Add `.tag`, `.tag-sub`, `.tag-explore`, `.tag-util` (alongside existing `.badge` rules) |

Four files, small surgical edits. No new dependencies. No build changes. No changes to `lib/addon.py` or `bin/claude-capture.mjs`.
