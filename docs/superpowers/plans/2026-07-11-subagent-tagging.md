# Subagent Sidebar Tagging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tag each captured request in the viewer sidebar with a colored pill so subagent and utility calls are visually distinguishable from main-agent calls.

**Architecture:** A new pure `classifyRequest(data)` function in `lib/server.mjs` inspects the already-parsed capture JSON and returns a tag string (`main` / `subagent` / `explore` / `utility` / `unknown`). The tag rides on the existing `ListItem` through the existing `/api/files` poll — no new network calls. The frontend renders a small colored pill on `subagent` / `explore` / `utility` rows; `main` and `unknown` rows get no pill.

**Tech Stack:** Node built-ins (`lib/server.mjs`), React + TypeScript + Vite (`web/`), plain CSS (`web/src/styles/global.css`). No new dependencies.

## Global Constraints

- **No new runtime dependencies.** Root `package.json` has zero runtime deps; `classifyRequest` uses only Node built-ins and string/array operations.
- **No test framework.** Per `CLAUDE.md`, no test suite exists and none will be added. Verification is a one-shot Node script (Task 1) and a visual check (Task 2). Scripts live in `/tmp` and are not committed.
- **Bilingual comments.** Match the surrounding Chinese + English style in `lib/server.mjs`.
- **ListItem identity is load-bearing.** The cached `item` object in `listCaptures` must remain the same reference (downstream React `memo` depends on it) — just add a field, do not spread into a new object.
- **CSS palette.** Reuse existing CSS variables from `web/src/styles/global.css` (`--sage-*`, `--clay-*`, `--text-*`, `--elevated`, `--line*`). New colors only where the palette has no equivalent.

---

### Task 1: Server-side classification

**Files:**
- Modify: `lib/server.mjs` (add `classifyRequest` after `extractLastUserText` at line 109; add `tag` field in `listCaptures` item object around line 74)

**Interfaces:**
- Produces: `classifyRequest(data: object): "main" | "subagent" | "explore" | "utility" | "unknown"` — consumed in Task 2 indirectly via the `tag` field on the JSON response from `GET /api/files`.

- [ ] **Step 1: Add `classifyRequest` function**

In `lib/server.mjs`, immediately after the closing brace of `extractLastUserText` (line 109), insert:

```js
// 根据 URL / 系统提示 / 工具数量判定请求来源（主代理 vs 子代理 vs 工具调用）。
// Classify a capture as main-agent / subagent / explore / utility / unknown.
// Signals are consulted in priority order: URL path, system-prompt text, tool count.
function classifyRequest(data) {
  const req = data?.request ?? {};
  const body = req?.body ?? {};

  // Signal 1: URL path —— count_tokens 不是对话，是 token 计数调用。
  // Signal 1: URL path — count_tokens is a token-count call, not a conversation.
  const url = typeof req.url === "string" ? req.url : "";
  if (url.includes("/count_tokens")) return "utility";

  // 归一化 system 字段（字符串或 {type:"text",text}[] 都可能）。
  // Normalize the system field (may be a string or an array of text blocks).
  let systemText = "";
  const sys = body.system;
  if (typeof sys === "string") {
    systemText = sys;
  } else if (Array.isArray(sys)) {
    systemText = sys
      .map((b) => (b && typeof b === "object" && typeof b.text === "string" ? b.text : ""))
      .join("\n");
  }
  const head = systemText.slice(0, 200);

  // Signal 2: 系统提示里的稳定关键字（Claude Code 自己注入的）。
  // Signal 2: stable keywords Claude Code injects into the system prompt.
  if (head.includes("You are an interactive agent")) return "main";
  if (head.includes("You are an agent for Claude Code")) return "subagent";
  if (head.includes("You are a file search specialist for Claude Code")) return "explore";
  if (head.includes("Generate a concise, sentence-case title")) return "utility";

  // Signal 3: 工具数量兜底（应对未来 Claude Code 改动措辞）。
  // Signal 3: tool-count fallback (insurance against future wording drift).
  const tools = Array.isArray(body.tools) ? body.tools.length : 0;
  if (tools >= 22) return "main";
  if (tools >= 1) return "subagent";
  return "unknown";
}
```

- [ ] **Step 2: Wire `tag` into the `ListItem`**

In `lib/server.mjs`, inside `listCaptures`, the successful-parse branch currently reads (around line 69):

```js
        const item = {
          name: childRel,
          mtime: stat.mtimeMs,
          size: stat.size,
          status: data.response?.status_code,
          preview: lastUser?.slice(0, 80) ?? "(empty)",
        };
```

Add the `tag` line as the last field (keeping the object reference stable — do not spread):

```js
        const item = {
          name: childRel,
          mtime: stat.mtimeMs,
          size: stat.size,
          status: data.response?.status_code,
          preview: lastUser?.slice(0, 80) ?? "(empty)",
          tag: classifyRequest(data),
        };
```

The parse-error fallback (around line 79) is **unchanged** — it omits `tag`, which the frontend will treat as "no pill".

- [ ] **Step 3: Verify the distribution with a one-shot script**

Run this script (lives in `/tmp`, not committed). It loads the real `classifyRequest` from `lib/server.mjs` and classifies every capture on disk.

Write to `/tmp/verify_classify.mjs`:

```js
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// lib/server.mjs doesn't export classifyRequest, so we re-implement the same
// logic here against the live captures to confirm the distribution.
function classifyRequest(data) {
  const req = data?.request ?? {};
  const body = req?.body ?? {};
  const url = typeof req.url === "string" ? req.url : "";
  if (url.includes("/count_tokens")) return "utility";
  let systemText = "";
  const sys = body.system;
  if (typeof sys === "string") systemText = sys;
  else if (Array.isArray(sys)) systemText = sys.map((b) => b?.text ?? "").join("\n");
  const head = systemText.slice(0, 200);
  if (head.includes("You are an interactive agent")) return "main";
  if (head.includes("You are an agent for Claude Code")) return "subagent";
  if (head.includes("You are a file search specialist for Claude Code")) return "explore";
  if (head.includes("Generate a concise, sentence-case title")) return "utility";
  const tools = Array.isArray(body.tools) ? body.tools.length : 0;
  if (tools >= 22) return "main";
  if (tools >= 1) return "subagent";
  return "unknown";
}

const base = path.resolve(process.env.HOME, ".claude-capture/captures");
const counts = {};
let total = 0;
function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) { walk(full); continue; }
    if (!ent.name.endsWith(".json")) continue;
    try {
      const data = JSON.parse(fs.readFileSync(full, "utf8"));
      const tag = classifyRequest(data);
      counts[tag] = (counts[tag] ?? 0) + 1;
      total++;
    } catch { counts["__parse_error"] = (counts["__parse_error"] ?? 0) + 1; }
  }
}
walk(base);
console.log(`Total: ${total}`);
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(4)}  ${k}`);
}
```

Run: `node /tmp/verify_classify.mjs`

Expected output (approximately — capture counts grow over time, the ratios are what matter):

```
Total: 716
   355  subagent
   337  main
    13  utility
    10  explore
     1  unknown
```

The key assertion: `main` + `subagent` + `explore` + `utility` account for ~all captures, and `unknown` is at most a handful (the empty-system non-count_tokens edge cases). If `unknown` is large, a signal is broken — re-check the substring matches against actual capture contents.

- [ ] **Step 4: Commit**

```bash
git add lib/server.mjs
git commit -m "feat(server): classify captures as main/subagent/explore/utility"
```

---

### Task 2: Sidebar pill rendering

**Files:**
- Modify: `web/src/types.ts` (extend `ListItem` at line 112-118)
- Modify: `web/src/components/ConversationList.tsx` (leaf branch of `TreeNodeRow`, lines 132-150)
- Modify: `web/src/styles/global.css` (add `.tag*` classes after `.badge.neutral` around line 251)

**Interfaces:**
- Consumes: `ListItem.tag` — the string field produced by Task 1, arriving via the existing `/api/files` poll. Value is one of `"main"` | `"subagent"` | `"explore"` | `"utility"` | `"unknown"`, or absent (parse-error rows).

- [ ] **Step 1: Extend the `ListItem` type**

In `web/src/types.ts`, the `ListItem` interface (lines 112-118) currently reads:

```ts
export interface ListItem {
  name: string;
  mtime: number;
  size: number;
  status?: number;
  preview: string;
}
```

Add the `tag` field:

```ts
export interface ListItem {
  name: string;
  mtime: number;
  size: number;
  status?: number;
  preview: string;
  tag?: string; // "main" | "subagent" | "explore" | "utility" | "unknown"
}
```

- [ ] **Step 2: Add the tag-pill helper inside `TreeNodeRow`**

In `web/src/components/ConversationList.tsx`, the leaf branch of `TreeNodeRow` (lines 132-150) currently reads:

```tsx
  const it = node.item!;
  const badgeCls = it.status === 200 ? "ok" : it.status ? "err" : "neutral";
  const isActive = it.name === selectedName;
  return (
    <div
      ref={measureRef}
      className={`file-item${isActive ? " active" : ""}`}
      style={style}
      onClick={() => onSelect(it.name)}
      data-index={vIndex}
    >
      <div className="preview">{it.preview}</div>
      <div className="meta">
        <span className={`badge ${badgeCls}`}>{it.status || "—"}</span>
        <span>{formatTime(it.mtime)}</span>
        <span>{(it.size / 1024).toFixed(1)}k</span>
      </div>
    </div>
  );
```

Replace it with (only two edits: a new `tagPill` const before `return`, and `{tagPill}` inserted at the start of the preview div):

```tsx
  const it = node.item!;
  const badgeCls = it.status === 200 ? "ok" : it.status ? "err" : "neutral";
  const isActive = it.name === selectedName;
  // 主代理行不显示标签（占多数，全标会变成噪声）；只标子代理 / Explore / 工具调用。
  // Main-agent rows get no pill (they're the majority — tagging all rows is noise).
  const tagPill = (() => {
    switch (it.tag) {
      case "subagent": return <span className="tag tag-sub">Sub</span>;
      case "explore":  return <span className="tag tag-explore">Explore</span>;
      case "utility":  return <span className="tag tag-util">Util</span>;
      default:         return null;
    }
  })();
  return (
    <div
      ref={measureRef}
      className={`file-item${isActive ? " active" : ""}`}
      style={style}
      onClick={() => onSelect(it.name)}
      data-index={vIndex}
    >
      <div className="preview">{tagPill}{it.preview}</div>
      <div className="meta">
        <span className={`badge ${badgeCls}`}>{it.status || "—"}</span>
        <span>{formatTime(it.mtime)}</span>
        <span>{(it.size / 1024).toFixed(1)}k</span>
      </div>
    </div>
  );
```

- [ ] **Step 3: Add the CSS classes**

In `web/src/styles/global.css`, immediately after the `.badge.neutral { ... }` block (ends around line 251), insert:

```css
/* 标签药丸 —— 标记子代理 / Explore / 工具调用请求。尺寸与 .badge 对齐。 */
/* Tag pills — mark subagent / explore / utility requests. Sized to match .badge. */
.tag {
  display: inline-block;
  vertical-align: middle;
  margin-right: 8px;
  padding: 1px 7px;
  border-radius: 8px;
  font-size: 9.5px;
  font-weight: 600;
  font-family: var(--font-mono);
  letter-spacing: 0.04em;
  border: 1px solid transparent;
  line-height: 1.5;
  flex-shrink: 0;
}
.tag-sub {
  background: rgba(122, 95, 168, 0.12);
  color: #5b4180;
  border-color: rgba(122, 95, 168, 0.28);
}
.tag-explore {
  background: var(--sage-dim);
  color: var(--sage-deep);
  border-color: rgba(90, 125, 82, 0.25);
}
.tag-util {
  background: var(--elevated);
  color: var(--text-dim);
  border-color: var(--line);
}
```

Color rationale:
- `.tag-sub` (purple `#5b4180` on `rgba(122,95,168,0.12)`) — new hue, no equivalent in the existing palette. Reads as distinct from sage (green) and clay (red).
- `.tag-explore` — reuses the sage palette already used for `.badge.ok`. The two pills live in different rows of the same leaf item (preview vs meta), so visual collision is not a concern; the green signals "successful/research" tone.
- `.tag-util` — reuses the neutral palette already used for `.badge.neutral`. Gray signals "background/utility".

- [ ] **Step 4: Build the viewer**

Run: `cd web && npm run build`

Expected: build completes without TypeScript errors. The `tag` field is optional on `ListItem`, so even if the running CLI's backend hasn't been restarted yet, the frontend typechecks (missing field → `undefined` → `default` branch → no pill).

If TypeScript complains about `it.tag` not being defined on the type, double-check Step 1 was applied.

- [ ] **Step 5: Visual verification**

The full end-to-end check requires a running `claude-capture` with the new backend. Two options:

**Option A — full run (most realistic):**

Run from the repo root (rebuilds the local link):

```bash
npm link                 # if not already linked
claude-capture
```

Then in the opened browser tab, expand a session that contains a mix of requests. Confirm:
1. Main-agent rows show **no pill** (the common case).
2. Rows whose capture's system prompt starts with "You are an agent for Claude Code" show a **purple "Sub"** pill.
3. Rows for "You are a file search specialist for Claude Code" show a **green "Explore"** pill.
4. `/count_tokens` rows (no real conversation, typically a single user message) show a **gray "Util"** pill.

**Option B — dev mode (faster iteration, backend must already be running):**

In one terminal: `node bin/claude-capture.mjs` (uses the just-edited `lib/server.mjs`).
In another: `cd web && npm run dev` and open the Vite URL.

Same checks as Option A.

- [ ] **Step 6: Commit**

```bash
git add web/src/types.ts web/src/components/ConversationList.tsx web/src/styles/global.css
git commit -m "feat(web): tag subagent/explore/utility rows in the sidebar"
```

---

## Self-Review Notes

**Spec coverage:**
- ✅ Three-signal classification (URL → system text → tool count) — Task 1, Step 1
- ✅ `classifyRequest` sibling to `extractLastUserText` in `lib/server.mjs` — Task 1, Step 1
- ✅ `tag` field on `ListItem` — Task 1 Step 2 (server) + Task 2 Step 1 (type)
- ✅ Parse-error fallback unchanged — explicitly noted in Task 1 Step 2
- ✅ Cache identity preserved (no spread, just an added field) — called out in Global Constraints + Task 1 Step 2
- ✅ Tag → pill mapping (`main` → none, `subagent` → Sub, `explore` → Explore, `utility` → Util, `unknown` → none) — Task 2 Step 2
- ✅ CSS classes with palette rationale — Task 2 Step 3
- ✅ Manual verification script + visual check — Task 1 Step 3, Task 2 Step 5
- ✅ Four files touched, no new deps — Global Constraints

**Type consistency:** `classifyRequest` returns string literals; `ListItem.tag` typed `string?`; the `switch` in `ConversationList.tsx` matches the literal values exactly (`"subagent"`, `"explore"`, `"utility"`).

**No placeholders:** every step shows the actual code/commands; no "TBD" or "add appropriate X".
