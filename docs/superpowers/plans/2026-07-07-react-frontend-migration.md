# React Frontend Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 1821-line single-file viewer UI (`public/index.html`) with an engineered React + Vite + TypeScript + Biome frontend built into `dist/`, served by the existing `lib/server.mjs`.

**Architecture:** Side-by-side migration. A new `web/` source tree (own `package.json` for dev tooling) builds to a gitignored `dist/`. `lib/server.mjs` keeps serving `public/` until feature-parity is verified side-by-side, then a single PR flips the server, updates root `package.json`/`CLAUDE.md`, and deletes `public/index.html`.

**Tech Stack:** React 18, Vite 5, TypeScript 5, Biome 1.9. No new runtime dependencies at the root `package.json` — all dev tooling isolated to `web/`.

**Spec:** `docs/superpowers/specs/2026-07-07-react-frontend-migration-design.md`

## Global Constraints

- **No tests required.** Spec explicitly defers test suite (Vitest) to a separate project. Verification is manual side-by-side against the old UI per the spec's parity checklist. (TDD steps in this plan use only TypeScript types + manual verification.)
- **Root `package.json` stays zero-runtime-deps.** All dev tooling lives in `web/package.json`. End users running `npm install -g claude-capture` must never install React/Vite/etc.
- **Bilingual comments.** Match existing style — Chinese + English where surrounding code does. Most explanation in header comments.
- **Cross-platform.** No Node version bumps. Node ≥ 20 (already the floor). The CLI (`bin/`, `lib/`) is unchanged.
- **`dist/` is gitignored.** Rebuilt at publish time via `prepublishOnly`. Never commit `dist/`.
- **`public/index.html` is sacrosanct during migration.** Do not modify, rename, or delete it until Task 13.
- **Comment style.** Match CLAUDE.md tone — comments bilingual (Chinese + English) where the surrounding code is.
- **HTML-string renderers stay string-based in v1.** `renderMarkdown` and `highlightJSON` produce HTML strings; they mount via `dangerouslySetInnerHTML`. This matches existing behavior; the source is the user's own captured traffic. Converting to JSX is a separate future refactor (not in scope).
- **CSS is ported verbatim.** The 1000-line `<style>` block from `public/index.html` moves into `web/src/styles/global.css` unchanged; per-component overrides use CSS modules only when needed.

---

## File Structure

### Files created in `web/`

| Path | Responsibility |
|---|---|
| `web/package.json` | devDependencies (react, react-dom, vite, @vitejs/plugin-react, typescript, @types/react, @types/react-dom, @biomejs/biome) + scripts (`dev`, `build`, `lint`, `format`) |
| `web/package-lock.json` | committed (npm ci support) |
| `web/vite.config.ts` | Vite config: `build.outDir: '../dist'`, `base: './'`, dev server proxy `/api` → `http://127.0.0.1:7777` |
| `web/tsconfig.json` | strict TS, jsx: react-jsx, module: ESNext, target: ES2020 |
| `web/biome.json` | Biome recommended config |
| `web/index.html` | Vite HTML template, mounts `<div id="root">` |
| `web/src/main.tsx` | React root mount |
| `web/src/styles/global.css` | ported verbatim from `public/index.html` `<style>` |
| `web/src/types.ts` | TS types: `Capture`, `Message`, `ContentBlock`, `SseEvent`, `ListItem`, `ConversationItem` |
| `web/src/lib/api.ts` | `fetchFiles()`, `fetchFile(name)` — typed wrappers around `/api/files` and `/api/file` |
| `web/src/lib/redact.ts` | `redactHeaders(h)` — same regex as original |
| `web/src/lib/sse.ts` | `rebuildAssistantFromSSE(events)` — pure port |
| `web/src/lib/json.ts` | `highlightJSON(str)`, `looksLikeJSON(str)` — pure port |
| `web/src/lib/markdown.ts` | `smartRender(s)`, `renderMarkdown(src)`, `inlineFmt(s)` — pure port; produces HTML strings |
| `web/src/lib/format.ts` | `formatTime(ms)`, `escapeHtml(s)`, `unescapeHtml(s)` — pure port |
| `web/src/lib/conversation.ts` | `buildConversationItems(messages)` — pure port |
| `web/src/App.tsx` | App shell: state (`captures`, `selectedName`, `capture`, `activeTab`), polling, tab switching |
| `web/src/components/ConversationList.tsx` | sidebar file list |
| `web/src/components/Toolbar.tsx` | top toolbar (filename + refresh button) |
| `web/src/components/Tabs.tsx` | tab strip |
| `web/src/components/ConversationTab.tsx` | Conversation tab |
| `web/src/components/SseTimeline.tsx` | SSE Timeline tab |
| `web/src/components/RequestTab.tsx` | Request tab |
| `web/src/components/ResponseTab.tsx` | Response tab |
| `web/src/components/RawJsonTab.tsx` | Raw JSON tab |
| `web/src/components/DetailPane.tsx` | right pane container, renders active tab |
| `web/src/components/Message.tsx` | shared message card (user/assistant/system/tool) |
| `web/src/components/ToolPair.tsx` | tool_use + tool_result paired card |
| `web/src/components/ToolResult.tsx` | standalone tool_result card |
| `web/src/components/CollapseWrap.tsx` | progressive disclosure wrapper for long content |
| `web/src/components/JsonBlock.tsx` | renders `<pre class="j-block">` with `highlightJSON` via dangerouslySetInnerHTML |
| `web/src/components/EmptyState.tsx` | "Awaiting inspection" / "No stream captured" / "No response captured" placeholders |

### Files modified at the root (only in Tasks 11–13)

| Path | Change |
|---|---|
| `.gitignore` | add `dist/` and `web/node_modules/` |
| `package.json` | add `scripts.prepublishOnly`, change `files` list (`public` → `dist`) |
| `lib/server.mjs` | one-line change: `publicDir` default from `public` to `dist` |
| `CLAUDE.md` | documented changes per spec Section 7 |
| `public/index.html` | deleted in Task 13 |

### Files NOT touched

- `bin/claude-capture.mjs`
- `lib/addon.py`
- `lib/server.mjs` API routes (only `publicDir` resolution changes)

---

## Task Sequence

- [Task 1: Scaffold `web/` with Vite + React + TS + Biome](#task-1)
- [Task 2: Port global CSS](#task-2)
- [Task 3: Port pure utility functions](#task-3)
- [Task 4: Port conversation-item builder](#task-4)
- [Task 5: Port SSE rebuilder](#task-5)
- [Task 6: Port JSON highlighter and markdown renderer](#task-6)
- [Task 7: Build leaf display components](#task-7)
- [Task 8: Port ConversationList (sidebar)](#task-8)
- [Task 9: Port ConversationTab](#task-9)
- [Task 10: Port SseTimeline, Request, Response, Raw JSON tabs](#task-10)
- [Task 11: Wire App.tsx with state and polling](#task-11)
- [Task 12: Side-by-side parity verification](#task-12)
- [Task 13: Flip server to `dist/`, update root package.json + CLAUDE.md, delete monolith](#task-13)

---

<a id="task-1"></a>
### Task 1: Scaffold `web/` with Vite + React + TS + Biome

**Files:**
- Create: `web/package.json`, `web/vite.config.ts`, `web/tsconfig.json`, `web/biome.json`, `web/index.html`, `web/src/main.tsx`, `web/src/App.tsx`
- Modify: `.gitignore` (root)

**Interfaces:**
- Produces: a runnable Vite dev server (`cd web && npm install && npm run dev`) showing a placeholder React page at `http://localhost:5173`. The dev server proxies `/api/*` to `http://127.0.0.1:7777` (the viewer's default port).

- [ ] **Step 1: Create `.gitignore` entries**

Append to root `.gitignore` (or create it if missing):
```
node_modules/
dist/
web/node_modules/
```

- [ ] **Step 2: Create `web/package.json`**

```json
{
  "name": "claude-capture-web",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "lint": "biome check src",
    "format": "biome format --write src"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@biomejs/biome": "^1.9.4",
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.4",
    "typescript": "^5.6.3",
    "vite": "^5.4.11"
  }
}
```

- [ ] **Step 3: Create `web/vite.config.ts`**

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 开发时把 /api/* 代理到本地 viewer 服务（默认 7777 端口）。
// Dev: proxy /api/* to the in-process viewer server.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:7777",
    },
  },
});
```

- [ ] **Step 4: Create `web/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src"]
}
```

- [ ] **Step 5: Create `web/biome.json`**

```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.4/schema.json",
  "vcs": { "enabled": false, "clientKind": "git", "useIgnoreFile": false },
  "files": { "ignoreUnknown": false, "ignore": [] },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  },
  "javascript": {
    "formatter": { "quoteStyle": "double", "semicolons": "always" }
  },
  "linter": {
    "enabled": true,
    "rules": { "recommended": true }
  }
}
```

- [ ] **Step 6: Create `web/index.html`**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#f7f4ee">
  <title>Capture Inspector · Claude Code</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Geist:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/main.tsx"></script>
</body>
</html>
```

- [ ] **Step 7: Create `web/src/main.tsx`**

```tsx
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

- [ ] **Step 8: Create placeholder `web/src/App.tsx`**

```tsx
// 临时占位：等所有子模块就绪后替换。
// Placeholder — replaced once sub-components are ready.
export default function App() {
  return <div style={{ padding: 40 }}>claude-capture viewer — scaffold OK</div>;
}
```

- [ ] **Step 9: Install and verify dev server boots**

Run:
```bash
cd web && npm install
```
Expected: `node_modules/` populated, `package-lock.json` created. No errors.

Run:
```bash
npm run dev
```
Expected: Vite dev server starts, prints `http://localhost:5173`. Opening the URL shows "claude-capture viewer — scaffold OK".

- [ ] **Step 10: Verify production build works**

Run:
```bash
npm run build
```
Expected: `../dist/` populated with `index.html`, `assets/` directory. No TS errors.

- [ ] **Step 11: Commit**

```bash
cd ..  # back to repo root
git add .gitignore web/
git commit -m "feat(web): scaffold React + Vite + TS + Biome in web/"
```

---

<a id="task-2"></a>
### Task 2: Port global CSS

**Files:**
- Create: `web/src/styles/global.css`
- Modify: `web/src/main.tsx` (add import)

**Interfaces:**
- Produces: all CSS class names used by the original UI available globally.

- [ ] **Step 1: Extract CSS from `public/index.html`**

Open `public/index.html` lines 12–1016 (the content between `<style>` and `</style>`). Copy verbatim — character-for-character — into `web/src/styles/global.css`. Do not modify selectors, values, or whitespace.

- [ ] **Step 2: Import the stylesheet in `main.tsx`**

Update `web/src/main.tsx`:
```tsx
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles/global.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

- [ ] **Step 3: Verify build still passes**

Run:
```bash
cd web && npm run build
```
Expected: success. No CSS warnings.

- [ ] **Step 4: Commit**

```bash
cd .. && git add web/ && git commit -m "feat(web): port global CSS from public/index.html"
```

---

<a id="task-3"></a>
### Task 3: Port pure utility functions

**Files:**
- Create: `web/src/types.ts`, `web/src/lib/format.ts`, `web/src/lib/redact.ts`, `web/src/lib/api.ts`

**Interfaces:**
- Produces:
  - `types.ts` exports: `Capture`, `Request`, `Response`, `Message`, `ContentBlock`, `ToolUseBlock`, `ToolResultBlock`, `TextBlock`, `ThinkingBlock`, `ImageBlock`, `SseEvent`, `ListItem`, `Headers`
  - `lib/format.ts` exports: `formatTime(ms: number | undefined): string`, `escapeHtml(s: unknown): string`, `unescapeHtml(s: string): string`
  - `lib/redact.ts` exports: `redactHeaders(h: Headers | undefined): Headers`
  - `lib/api.ts` exports: `fetchFiles(): Promise<ListItem[]>`, `fetchFile(name: string): Promise<Capture>`

- [ ] **Step 1: Create `web/src/types.ts`**

```ts
// 抓包数据的 TypeScript 类型定义，对应 addon.py 的输出结构。
// Types matching the capture JSON shape produced by lib/addon.py.

export type Headers = Record<string, string>;

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultContentText {
  type: "text";
  text: string;
}

export interface ToolResultContentImage {
  type: "image";
  source?: { type?: string };
}

export interface ToolResultContentToolUse {
  type: "tool_use";
  [k: string]: unknown;
}

export type ToolResultContent =
  | ToolResultContentText
  | ToolResultContentImage
  | ToolResultContentToolUse
  | Record<string, unknown>;

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  is_error?: boolean;
  content: string | ToolResultContent[] | Record<string, unknown> | null;
}

export interface ImageBlock {
  type: "image";
  source?: { type?: string };
}

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | ToolUseBlock
  | ToolResultBlock
  | ImageBlock
  | { type: string; [k: string]: unknown };

export interface Message {
  role: "user" | "assistant" | "system" | string;
  content: string | ContentBlock[] | Record<string, unknown> | null;
  fromSSE?: boolean;
}

export interface Tool {
  name?: string;
  function?: { name?: string };
  [k: string]: unknown;
}

export interface RequestBody {
  model?: string;
  system?: string | object;
  messages?: Message[];
  tools?: Tool[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  [k: string]: unknown;
}

export interface CaptureRequest {
  url?: string;
  method?: string;
  headers?: Headers;
  body?: RequestBody;
}

export interface SseEvent {
  event?: string;
  data?: object | string;
}

export interface CaptureResponse {
  status_code?: number;
  status?: number;
  headers?: Headers;
  body?: unknown;
  sse_events?: SseEvent[];
}

export interface Capture {
  request?: CaptureRequest;
  response?: CaptureResponse;
}

export interface ListItem {
  name: string;
  mtime: number;
  size: number;
  status?: number;
  preview: string;
}
```

- [ ] **Step 2: Create `web/src/lib/format.ts`**

Direct port of `escapeHtml`, `unescapeHtml`, `formatTime` from `public/index.html` lines 1485–1487, 1702–1705, 1811–1815.

```ts
import type { Headers } from "../types";

export function escapeHtml(s: unknown): string {
  if (s == null) return "";
  return String(s).replace(
    /[&<>"']/g,
    (ch) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[ch] as string,
  );
}

export function unescapeHtml(s: string): string {
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export function formatTime(ms?: number): string {
  if (!ms) return "—";
  const d = new Date(ms);
  return d.toLocaleTimeString("zh-CN", { hour12: false });
}

// Unused-in-this-file but kept here so redact.ts can share the file or import separately.
export type { Headers };
```

- [ ] **Step 3: Create `web/src/lib/redact.ts`**

Direct port of `redactHeaders` from `public/index.html` lines 1694–1700.

```ts
import type { Headers } from "../types";

// 客户端脱敏：授权相关头只保留前 8 个字符。
// Client-side redaction: auth-related headers truncated to first 8 chars.
export function redactHeaders(h: Headers | undefined): Headers {
  const out: Headers = { ...(h || {}) };
  for (const k of Object.keys(out)) {
    if (/auth|x-api-key|authorization|token/i.test(k)) {
      const v = out[k];
      out[k] = (v != null ? String(v) : "").slice(0, 8) + "…";
    }
  }
  return out;
}
```

- [ ] **Step 4: Create `web/src/lib/api.ts`**

```ts
import type { Capture, ListItem } from "../types";

export async function fetchFiles(): Promise<ListItem[]> {
  const res = await fetch("/api/files");
  return (await res.json()) as ListItem[];
}

export async function fetchFile(name: string): Promise<Capture> {
  const res = await fetch("/api/file?name=" + encodeURIComponent(name));
  return (await res.json()) as Capture;
}
```

- [ ] **Step 5: Verify build**

Run:
```bash
cd web && npm run build
```
Expected: success. Type errors none.

- [ ] **Step 6: Commit**

```bash
cd .. && git add web/ && git commit -m "feat(web): add types + pure utility libs (format, redact, api)"
```

---

<a id="task-4"></a>
### Task 4: Port conversation-item builder

**Files:**
- Create: `web/src/lib/conversation.ts`

**Interfaces:**
- Consumes: `Message`, `ContentBlock`, `ToolResultBlock`, `ToolUseBlock` from `types.ts`
- Produces: `buildConversationItems(messages: Message[]): ConversationItem[]`

```ts
export type ConversationItem =
  | { kind: "system"; message: Message }
  | { kind: "user"; message: Message; idx: number }
  | { kind: "assistant"; message: Message; blocks: ContentBlock[]; idx: number }
  | { kind: "tool-pair"; toolUse: ToolUseBlock; toolResult: ToolResultBlock | null }
  | { kind: "other"; message: Message; idx: number };
```

- [ ] **Step 1: Create `web/src/lib/conversation.ts`**

Direct port of `buildConversationItems` from `public/index.html` lines 1195–1252. The original is in JS; this version adds TS annotations using types from `types.ts`.

```ts
import type {
  ContentBlock,
  Message,
  ToolResultBlock,
  ToolUseBlock,
} from "../types";

export type ConversationItem =
  | { kind: "system"; message: Message }
  | { kind: "user"; message: Message; idx: number }
  | {
      kind: "assistant";
      message: Message;
      blocks: ContentBlock[];
      idx: number;
    }
  | {
      kind: "tool-pair";
      toolUse: ToolUseBlock;
      toolResult: ToolResultBlock | null;
    }
  | { kind: "other"; message: Message; idx: number };

// 遍历消息列表，输出渲染项。tool_use 块与匹配的 tool_result（按 tool_use_id）配对为一张卡片；
// 仅含 tool_result 的 user 消息被吸收，不单独渲染。
// Walk the message list and emit render-items. tool_use blocks are paired
// with their matching tool_result (by tool_use_id) so they render as one card;
// pure-tool-result user messages are absorbed and not rendered standalone.
export function buildConversationItems(
  messages: Message[],
): ConversationItem[] {
  const resultsById = new Map<string, ToolResultBlock>();
  for (const m of messages) {
    if (Array.isArray(m?.content)) {
      for (const b of m.content as ContentBlock[]) {
        if (
          b &&
          (b as ToolResultBlock).type === "tool_result" &&
          (b as ToolResultBlock).tool_use_id
        ) {
          resultsById.set(
            (b as ToolResultBlock).tool_use_id,
            b as ToolResultBlock,
          );
        }
      }
    }
  }

  const items: ConversationItem[] = [];
  let turnIdx = 0;
  const bump = () => {
    turnIdx += 1;
    return turnIdx;
  };

  for (const m of messages) {
    if (m.role === "system") {
      items.push({ kind: "system", message: m });
      continue;
    }
    if (m.role === "user") {
      const c = m.content;
      if (
        Array.isArray(c) &&
        c.length > 0 &&
        c.every(
          (b) =>
            b && (b as ToolResultBlock).type === "tool_result",
        )
      ) {
        continue;
      }
      items.push({ kind: "user", message: m, idx: bump() });
      continue;
    }
    if (m.role === "assistant") {
      const c = Array.isArray(m.content) ? (m.content as ContentBlock[]) : null;
      if (!c || c.length === 0) {
        items.push({
          kind: "assistant",
          message: m,
          blocks: [],
          idx: bump(),
        });
        continue;
      }
      // 把 assistant 内容拆成 prose-group 与 tool_use 调用交错出现。
      // Split assistant content into prose-groups interleaved with tool_use calls.
      let buf: ContentBlock[] = [];
      const flush = () => {
        if (buf.length > 0) {
          items.push({
            kind: "assistant",
            message: m,
            blocks: buf,
            idx: bump(),
          });
          buf = [];
        }
      };
      for (const b of c) {
        if (b && (b as ToolUseBlock).type === "tool_use") {
          flush();
          const tu = b as ToolUseBlock;
          const result = tu.id ? resultsById.get(tu.id) ?? null : null;
          items.push({ kind: "tool-pair", toolUse: tu, toolResult: result });
        } else {
          buf.push(b);
        }
      }
      flush();
      continue;
    }
    items.push({ kind: "other", message: m, idx: bump() });
  }
  return items;
}
```

- [ ] **Step 2: Verify build**

Run:
```bash
cd web && npm run build
```
Expected: success.

- [ ] **Step 3: Commit**

```bash
cd .. && git add web/ && git commit -m "feat(web): port buildConversationItems to TS"
```

---

<a id="task-5"></a>
### Task 5: Port SSE rebuilder

**Files:**
- Create: `web/src/lib/sse.ts`

**Interfaces:**
- Consumes: `SseEvent`, `ContentBlock` from `types.ts`
- Produces: `rebuildAssistantFromSSE(events: SseEvent[] | undefined): ContentBlock[] | null`

- [ ] **Step 1: Create `web/src/lib/sse.ts`**

Direct port of `rebuildAssistantFromSSE` from `public/index.html` lines 1543–1578.

```ts
import type { ContentBlock, SseEvent } from "../types";

interface RebuildBlock {
  type?: string;
  text?: string;
  thinking?: string;
  input?: unknown;
  _raw_input?: string;
  [k: string]: unknown;
}

// 从 SSE 事件序列重建 assistant 的 content blocks。
// Reconstruct assistant content blocks from the SSE event stream.
export function rebuildAssistantFromSSE(
  events: SseEvent[] | undefined,
): ContentBlock[] | null {
  if (!events || events.length === 0) return null;
  const blocks = new Map<number, RebuildBlock>();
  const order: number[] = [];
  for (const ev of events) {
    const d = ev.data;
    if (!d || typeof d === "string") continue;
    const data = d as Record<string, unknown>;
    if (ev.event === "content_block_start" && typeof data.index === "number") {
      if (!blocks.has(data.index)) {
        const cb = (data.content_block || {}) as Record<string, unknown>;
        blocks.set(data.index, { ...cb });
        order.push(data.index);
      }
    }
    if (ev.event === "content_block_delta" && typeof data.index === "number") {
      const blk = blocks.get(data.index);
      if (!blk) continue;
      const delta = (data.delta || {}) as Record<string, unknown>;
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        blk.text = (blk.text || "") + delta.text;
      } else if (
        delta.type === "thinking_delta" &&
        typeof delta.thinking === "string"
      ) {
        blk.thinking = (blk.thinking || "") + delta.thinking;
      } else if (
        delta.type === "input_json_delta" &&
        typeof delta.partial_json === "string"
      ) {
        blk._raw_input = (blk._raw_input || "") + delta.partial_json;
      }
    }
  }
  if (order.length === 0) return null;
  return order.map((i) => {
    const blk = blocks.get(i)!;
    if (blk.type === "tool_use" && blk._raw_input) {
      try {
        blk.input = JSON.parse(blk._raw_input);
      } catch {
        /* leave input undefined */
      }
      delete blk._raw_input;
    }
    return blk as unknown as ContentBlock;
  });
}
```

- [ ] **Step 2: Verify build**

Run:
```bash
cd web && npm run build
```
Expected: success.

- [ ] **Step 3: Commit**

```bash
cd .. && git add web/ && git commit -m "feat(web): port rebuildAssistantFromSSE to TS"
```

---

<a id="task-6"></a>
### Task 6: Port JSON highlighter and markdown renderer

**Files:**
- Create: `web/src/lib/json.ts`, `web/src/lib/markdown.ts`

**Interfaces:**
- Consumes: `escapeHtml`, `unescapeHtml` from `lib/format.ts`
- Produces:
  - `lib/json.ts`: `highlightJSON(jsonStr: string | object): string` (returns HTML), `looksLikeJSON(s: string): boolean`
  - `lib/markdown.ts`: `smartRender(s: unknown): string` (returns HTML), `renderMarkdown(src: string): string`, `inlineFmt(s: string): string`

- [ ] **Step 1: Create `web/src/lib/json.ts`**

Direct port of `highlightJSON` and `looksLikeJSON` from `public/index.html` lines 1481–1483, 1490–1541.

```ts
import { escapeHtml } from "./format";

export function looksLikeJSON(s: string): boolean {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

// 基于词法分析的 JSON 高亮器。输入为原始 JSON 字符串，输出 HTML。
// Tokenizer-based JSON syntax highlighter. Input is raw JSON string; output is HTML.
export function highlightJSON(jsonStr: string | object): string {
  const json =
    typeof jsonStr === "string" ? jsonStr : JSON.stringify(jsonStr, null, 2);
  let out = "";
  let i = 0;
  const n = json.length;
  const isKey = (idx: number) => {
    let k = idx;
    while (k < n && (json[k] === " " || json[k] === "\t")) k++;
    return json[k] === ":";
  };
  while (i < n) {
    const ch = json[i];
    if (ch === '"') {
      let end = i + 1;
      while (end < n) {
        if (json[end] === "\\") {
          end += 2;
          continue;
        }
        if (json[end] === '"') break;
        end++;
      }
      const lit = json.slice(i, end + 1);
      const key = isKey(end + 1);
      out += `<span class="${key ? "j-key" : "j-str"}">${escapeHtml(lit)}</span>`;
      i = end + 1;
      continue;
    }
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      let end = i;
      while (end < n && /[-+0-9.eE]/.test(json[end])) end++;
      out += `<span class="j-num">${escapeHtml(json.slice(i, end))}</span>`;
      i = end;
      continue;
    }
    if (json.startsWith("true", i)) {
      out += '<span class="j-bool">true</span>';
      i += 4;
      continue;
    }
    if (json.startsWith("false", i)) {
      out += '<span class="j-bool">false</span>';
      i += 5;
      continue;
    }
    if (json.startsWith("null", i)) {
      out += '<span class="j-null">null</span>';
      i += 4;
      continue;
    }
    if (ch === "{" || ch === "}" || ch === "[" || ch === "]") {
      out += `<span class="j-brace">${escapeHtml(ch)}</span>`;
      i++;
      continue;
    }
    if (ch === "," || ch === ":") {
      out += `<span class="j-punct">${escapeHtml(ch)}</span>`;
      i++;
      continue;
    }
    out += escapeHtml(ch);
    i++;
  }
  return out;
}
```

- [ ] **Step 2: Create `web/src/lib/markdown.ts`**

Direct port of `smartRender`, `renderMarkdown`, `inlineFmt` from `public/index.html` lines 1467–1808. Uses `escapeHtml`/`unescapeHtml` from `lib/format.ts` and `highlightJSON`/`looksLikeJSON` from `lib/json.ts`.

```ts
import { escapeHtml, unescapeHtml } from "./format";
import { highlightJSON, looksLikeJSON } from "./json";

// 智能渲染：检测 JSON，否则走 markdown。
// Smart per-content renderer: detect JSON, otherwise fall back to markdown.
export function smartRender(s: unknown): string {
  if (s == null) return "";
  const str = String(s);
  const trimmed = str.trim();
  if (!trimmed) return "";
  if (/^[{[]/.test(trimmed) && looksLikeJSON(trimmed)) {
    return `<div class="j-block-wrap"><pre class="j-block">${highlightJSON(
      JSON.stringify(JSON.parse(trimmed), null, 2),
    )}</pre></div>`;
  }
  return renderMarkdown(str);
}

// 极简、无依赖的 markdown 渲染器。
// Minimal, dependency-free markdown renderer.
export function renderMarkdown(src: string): string {
  if (!src) return "";
  const escaped = escapeHtml(src);
  const stash: string[] = [];
  const keep = (html: string) => {
    stash.push(html);
    return `\u0000${stash.length - 1}\u0000`;
  };

  let text = escaped;
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang: string, code: string) => {
    const cleanCode = code.replace(/\n$/, "");
    const lowLang = (lang || "").toLowerCase();
    if (lowLang === "json") {
      const raw = unescapeHtml(cleanCode);
      return keep(
        `<pre class="md-code j-block" data-lang="json"><code>${highlightJSON(
          raw,
        )}</code></pre>`,
      );
    }
    return keep(`<pre class="md-code" data-lang="${lang}"><code>${cleanCode}</code></pre>`);
  });
  text = text.replace(/`([^`\n]+)`/g, (_, code: string) =>
    keep(`<code class="md-inline">${code}</code>`),
  );

  const lines = text.split("\n");
  const out: string[] = [];
  let para: string[] = [];
  let list: { type: "ul" | "ol"; items: string[] } | null = null;

  const flushPara = () => {
    if (para.length > 0) {
      out.push(`<p class="md-p">${para.join("<br>")}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      out.push(
        `<${list.type} class="md-list">${list.items
          .map((i) => `<li>${inlineFmt(i)}</li>`)
          .join("")}</${list.type}>`,
      );
      list = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trim();
    const m = line.match(/^\u0000(\d+)\u0000$/);
    if (m) {
      flushPara();
      flushList();
      out.push(stash[Number(m[1])]);
      continue;
    }
    if (line === "") {
      flushPara();
      flushList();
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara();
      flushList();
      const lvl = h[1].length;
      out.push(`<h${lvl} class="md-h md-h${lvl}">${inlineFmt(h[2])}</h${lvl}>`);
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
      flushPara();
      flushList();
      out.push(`<hr class="md-hr">`);
      continue;
    }
    if (/^&gt;\s?/.test(line)) {
      flushPara();
      flushList();
      out.push(
        `<blockquote class="md-quote">${inlineFmt(
          line.replace(/^&gt;\s?/, ""),
        )}</blockquote>`,
      );
      continue;
    }
    const ul = line.match(/^[-*+]\s+(.*)$/);
    if (ul) {
      flushPara();
      if (!list || list.type !== "ul") {
        flushList();
        list = { type: "ul", items: [] };
      }
      list.items.push(ul[1]);
      continue;
    }
    const ol = line.match(/^\d+[.)]\s+(.*)$/);
    if (ol) {
      flushPara();
      if (!list || list.type !== "ol") {
        flushList();
        list = { type: "ol", items: [] };
      }
      list.items.push(ol[1]);
      continue;
    }
    flushList();
    para.push(inlineFmt(line));
  }
  flushPara();
  flushList();

  return out.join("\n").replace(/\u0000(\d+)\u0000/g, (_, i: string) => stash[Number(i)]);
}

export function inlineFmt(s: string): string {
  return s
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_\n]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>")
    .replace(
      /\[([^\]]+)\]\(([^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>',
    )
    .replace(/\u0000(\d+)\u0000/g, (_, i: string) => `\u0000${i}\u0000`);
}
```

- [ ] **Step 3: Verify build**

Run:
```bash
cd web && npm run build
```
Expected: success.

- [ ] **Step 4: Commit**

```bash
cd .. && git add web/ && git commit -m "feat(web): port JSON highlighter and markdown renderer"
```

---

<a id="task-7"></a>
### Task 7: Build leaf display components

**Files:**
- Create: `web/src/components/JsonBlock.tsx`, `web/src/components/CollapseWrap.tsx`, `web/src/components/EmptyState.tsx`, `web/src/components/ToolResult.tsx`, `web/src/components/ToolPair.tsx`, `web/src/components/Message.tsx`

**Interfaces:**
- Consumes: types from `types.ts`, `smartRender` from `lib/markdown.ts`, `highlightJSON` from `lib/json.ts`
- Produces: reusable JSX components used by tab components in Tasks 9–10

- [ ] **Step 1: Create `web/src/components/JsonBlock.tsx`**

A thin wrapper that renders a JSON string through `highlightJSON` via dangerouslySetInnerHTML. Mirrors the `pre.j-block` and `pre.json` patterns from the original.

```tsx
import { highlightJSON } from "../lib/json";

interface JsonBlockProps {
  value: unknown;
  variant?: "block" | "raw"; // block = j-block (boxed), raw = json (plain pre)
}

export default function JsonBlock({ value, variant = "block" }: JsonBlockProps) {
  const json =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const html = highlightJSON(json);
  const cls = variant === "block" ? "json j-block" : "json";
  return <pre className={cls} dangerouslySetInnerHTML={{ __html: html }} />;
}
```

- [ ] **Step 2: Create `web/src/components/CollapseWrap.tsx`**

Reproduces the `.collapse-wrap` progressive-disclosure pattern from `public/index.html` lines 826–868, 1376–1388.

```tsx
import { useState, type ReactNode } from "react";

interface CollapseWrapProps {
  bodyHtml: string;
  bodyNode?: ReactNode;
}

// 长内容渐进展开：默认折叠，点击切换。
// Progressive disclosure: collapsed by default, toggle on click.
export default function CollapseWrap({ bodyHtml, bodyNode }: CollapseWrapProps) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`collapse-wrap${open ? " open" : ""}`}>
      <div className="collapse-body">
        {bodyNode ?? (
          <div dangerouslySetInnerHTML={{ __html: bodyHtml }} />
        )}
      </div>
      <button
        type="button"
        className="collapse-toggle"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="show-more">▼ expand</span>
        <span className="show-less">▲ collapse</span>
      </button>
    </div>
  );
}
```

- [ ] **Step 3: Create `web/src/components/EmptyState.tsx`**

Reproduces `.empty` placeholders.

```tsx
interface EmptyStateProps {
  big: string;
  small?: string;
  arrow?: boolean;
  style?: React.CSSProperties;
}

export default function EmptyState({
  big,
  small,
  arrow = false,
  style,
}: EmptyStateProps) {
  return (
    <div className="empty" style={style}>
      <div className="big">{big}</div>
      {small && (
        <div className="small">
          {arrow && <span className="arrow">←</span>}
          {small}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Create `web/src/components/ToolResult.tsx`**

Two variants:
1. The "standalone" `.tool-result` block (from `renderBlock` for `type === "tool_result"`).
2. The `.tool-pair-result` body (used inside ToolPair).

Both share the same content rendering logic. Component takes a `variant` prop.

```tsx
import type { ToolResultBlock, ToolResultContent } from "../types";
import { smartRender } from "../lib/markdown";
import { highlightJSON } from "../lib/json";
import { escapeHtml } from "../lib/format";
import CollapseWrap from "./CollapseWrap";

interface ToolResultProps {
  toolResult: ToolResultBlock;
  variant: "standalone" | "pair";
}

function renderContentSegments(c: ToolResultBlock["content"]): string {
  if (typeof c === "string") return smartRender(c);
  if (Array.isArray(c)) {
    return (c as ToolResultContent[])
      .map((seg) => {
        const s = seg as { type?: string; text?: string; source?: { type?: string } };
        if (s.type === "text") return smartRender(s.text || "");
        if (s.type === "image") {
          return `<div class="seg-image"><span class="seg-tag">image · ${escapeHtml(
            s.source?.type || "",
          )}</span></div>`;
        }
        return `<div class="j-block-wrap"><pre class="j-block">${highlightJSON(
          JSON.stringify(seg, null, 2),
        )}</pre></div>`;
      })
      .join("");
  }
  if (c && typeof c === "object") {
    return `<div class="j-block-wrap"><pre class="j-block">${highlightJSON(
      JSON.stringify(c, null, 2),
    )}</pre></div>`;
  }
  return `<div class="msg-text">${escapeHtml(String(c ?? ""))}</div>`;
}

export default function ToolResult({ toolResult, variant }: ToolResultProps) {
  const isErr = !!toolResult.is_error;
  const bodyHtml = renderContentSegments(toolResult.content);
  const lineGuess = (bodyHtml.match(/\n/g) || []).length;
  const shouldCollapse = bodyHtml.length > 1000 || lineGuess > 12;

  if (variant === "pair") {
    return (
      <div className={`tool-pair-result${isErr ? " err" : ""}`}>
        <div className="tool-pair-result-label">
          {isErr ? "error result" : "result"}
        </div>
        <div className="tool-pair-result-body">
          {shouldCollapse ? (
            <CollapseWrap bodyHtml={bodyHtml} />
          ) : (
            <div dangerouslySetInnerHTML={{ __html: bodyHtml }} />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={`tool-result${isErr ? " err" : ""}`}>
      <div className="tool-result-head">
        <span className="tool-result-label">{isErr ? "error" : "result"}</span>
        <span className="tool-id">{escapeHtml(toolResult.tool_use_id || "")}</span>
      </div>
      <div className="tool-result-body">
        {shouldCollapse ? (
          <CollapseWrap bodyHtml={bodyHtml} />
        ) : (
          <div dangerouslySetInnerHTML={{ __html: bodyHtml }} />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Create `web/src/components/ToolPair.tsx`**

Reproduces `renderToolPairItem` from `public/index.html` lines 1329–1355.

```tsx
import type { ToolResultBlock, ToolUseBlock } from "../types";
import { highlightJSON } from "../lib/json";
import { escapeHtml } from "../lib/format";
import ToolResult from "./ToolResult";

interface ToolPairProps {
  toolUse: ToolUseBlock;
  toolResult: ToolResultBlock | null;
}

export default function ToolPair({ toolUse, toolResult }: ToolPairProps) {
  const input = toolUse.input ?? {};
  const inputJson = JSON.stringify(input, null, 2);
  const isCompact = !inputJson.includes("\n") && inputJson.length <= 80;
  const inputInner = isCompact ? (
    <code
      className="j-inline"
      dangerouslySetInnerHTML={{ __html: highlightJSON(inputJson) }}
    />
  ) : (
    <pre
      className="j-block flat"
      dangerouslySetInnerHTML={{ __html: highlightJSON(inputJson) }}
    />
  );

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
      <div className="tool-pair-input">{inputInner}</div>
      {toolResult && <ToolResult toolResult={toolResult} variant="pair" />}
    </div>
  );
}
```

Note: the `.name` span uses CSS `::before` for the `⚙ ` prefix — no need to inject it from JS.

- [ ] **Step 6: Create `web/src/components/Message.tsx`**

Reproduces user/assistant/system message cards (the non-tool-pair item kinds). Mirrors `renderUserItem`, `renderAssistantItem`, `renderSystemItem`, `renderThinkingBlock`, `renderMessage` from `public/index.html` lines 1264–1326, 1392–1408.

```tsx
import type { ContentBlock, Message as MessageType } from "../types";
import { escapeHtml } from "../lib/format";
import { smartRender } from "../lib/markdown";
import { highlightJSON } from "../lib/json";
import ToolResult from "./ToolResult";
import type { ToolResultBlock, ToolUseBlock } from "../types";

interface MessageProps {
  message: MessageType;
  idx?: number;
}

function ThinkingBlock({ block }: { block: { thinking?: string } & ContentBlock }) {
  const text = block.thinking || "";
  const words = (text.match(/\S+/g) || []).length;
  if (!words) return null;
  return (
    <details className="thinking-block">
      <summary>
        <span className="msg-role">thinking · {words} words</span>
      </summary>
      <div
        className="msg-thinking"
        dangerouslySetInnerHTML={{ __html: escapeHtml(text) }}
      />
    </details>
  );
}

function renderBlockHtml(b: ContentBlock, _role: string): string {
  // 用于 fallback 的零散块（孤儿 tool_use / tool_result）。
  // Used for orphan blocks not paired into ToolPair.
  if (b.type === "text") {
    return smartRender((b as { text?: string }).text || "");
  }
  if (b.type === "thinking") {
    return `<div class="msg-thinking">${escapeHtml(
      (b as { thinking?: string }).thinking || "",
    )}</div>`;
  }
  if (b.type === "tool_use") {
    const tu = b as ToolUseBlock;
    const input = tu.input ?? {};
    const inputJson = JSON.stringify(input, null, 2);
    const isCompact = !inputJson.includes("\n") && inputJson.length <= 80;
    const inputHtml = isCompact
      ? `<code class="j-inline">${highlightJSON(inputJson)}</code>`
      : `<div class="j-block-wrap"><pre class="j-block">${highlightJSON(
          inputJson,
        )}</pre></div>`;
    return `<div class="tool-call">
      <div class="tool-head">
        <span class="name">${escapeHtml(tu.name || "")}</span>
        <span class="tool-id">${escapeHtml(tu.id || "")}</span>
      </div>
      <div class="tool-input">${inputHtml}</div>
    </div>`;
  }
  if (b.type === "tool_result") {
    // Standalone tool_result rendered via ToolResult component below.
    return ""; // handled by caller
  }
  return `<pre class="json">${escapeHtml(JSON.stringify(b, null, 2))}</pre>`;
}

export default function Message({ message, idx }: MessageProps) {
  const role = message.role;
  const cls =
    role === "user"
      ? "user"
      : role === "assistant"
        ? "assistant"
        : role === "system"
          ? "system"
          : "tool";

  const bodyBlocks: { html: string; standaloneToolResults: ToolResultBlock[] } = {
    html: "",
    standaloneToolResults: [],
  };

  if (typeof message.content === "string") {
    bodyBlocks.html = `<div class="msg-text">${smartRender(message.content)}</div>`;
  } else if (Array.isArray(message.content)) {
    for (const b of message.content as ContentBlock[]) {
      if (b.type === "thinking") {
        // thinking handled by component below in assistant rendering path
        bodyBlocks.html += `<div class="msg-thinking">${escapeHtml(
          (b as { thinking?: string }).thinking || "",
        )}</div>`;
      } else if (b.type === "text") {
        bodyBlocks.html += `<div class="msg-text">${smartRender(
          (b as { text?: string }).text || "",
        )}</div>`;
      } else if (b.type === "tool_result") {
        bodyBlocks.standaloneToolResults.push(b as ToolResultBlock);
      } else {
        bodyBlocks.html += renderBlockHtml(b, role);
      }
    }
  } else {
    bodyBlocks.html = `<pre class="json">${escapeHtml(
      JSON.stringify(message.content, null, 2),
    )}</pre>`;
  }

  if (bodyBlocks.html === "" && bodyBlocks.standaloneToolResults.length === 0) {
    bodyBlocks.html =
      '<div class="msg-text" style="color:var(--text-faint);font-style:italic">— no textual content —</div>';
  }

  const tag = message.fromSSE ? `${role} · from SSE` : role;

  return (
    <div className={`msg ${cls}`}>
      {idx != null && (
        <span className="turn-num">{String(idx).padStart(2, "0")}</span>
      )}
      <div
        className="msg-role"
        dangerouslySetInnerHTML={{ __html: escapeHtml(tag) }}
      />
      <div className="msg-body">
        {bodyBlocks.html && (
          <div dangerouslySetInnerHTML={{ __html: bodyBlocks.html }} />
        )}
        {bodyBlocks.standaloneToolResults.map((tr, i) => (
          <ToolResult key={i} toolResult={tr} variant="standalone" />
        ))}
      </div>
    </div>
  );
}

// System message renders as collapsible <details>; separate export.
export function SystemMessage({ message }: { message: MessageType }) {
  const text =
    typeof message.content === "string"
      ? message.content
      : JSON.stringify(message.content, null, 2);
  const words = (text.match(/\S+/g) || []).length;
  const body =
    typeof message.content === "string"
      ? smartRender(message.content)
      : `<div class="j-block-wrap"><pre class="j-block">${highlightJSON(
          text,
        )}</pre></div>`;
  return (
    <details className="msg system collapsible-card">
      <summary>
        <span className="msg-role">system · {words} words</span>
        <span className="collapse-hint">collapsed — click to read</span>
      </summary>
      <div className="msg-body" dangerouslySetInnerHTML={{ __html: body }} />
    </details>
  );
}
```

- [ ] **Step 7: Verify build**

Run:
```bash
cd web && npm run build
```
Expected: success.

- [ ] **Step 8: Commit**

```bash
cd .. && git add web/ && git commit -m "feat(web): leaf display components (JsonBlock, CollapseWrap, EmptyState, ToolResult, ToolPair, Message)"
```

---

<a id="task-8"></a>
### Task 8: Port ConversationList (sidebar)

**Files:**
- Create: `web/src/components/ConversationList.tsx`

**Interfaces:**
- Consumes: `ListItem` from `types.ts`, `formatTime` from `lib/format.ts`
- Produces: `<ConversationList items={...} selectedName={...} onSelect={(name) => void} />`

- [ ] **Step 1: Create `web/src/components/ConversationList.tsx`**

Reproduces the sidebar from `public/index.html` lines 1057–1066 (item layout) and 1020–1028 (sidebar shell — header kept inside App or here per design).

```tsx
import type { ListItem } from "../types";
import { formatTime } from "../lib/format";

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
  return (
    <div className="file-list">
      {items.map((it) => {
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
              <span className={`badge ${badgeCls}`}>{it.status || "—"}</span>
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

- [ ] **Step 2: Verify build**

Run:
```bash
cd web && npm run build
```
Expected: success.

- [ ] **Step 3: Commit**

```bash
cd .. && git add web/ && git commit -m "feat(web): ConversationList sidebar component"
```

---

<a id="task-9"></a>
### Task 9: Port ConversationTab

**Files:**
- Create: `web/src/components/ConversationTab.tsx`

**Interfaces:**
- Consumes:
  - `Capture` from `types.ts`
  - `buildConversationItems`, `ConversationItem` from `lib/conversation.ts`
  - `rebuildAssistantFromSSE` from `lib/sse.ts`
  - `Message`, `SystemMessage` from `./Message`
  - `ToolPair` from `./ToolPair`
  - `escapeHtml` from `lib/format.ts`
- Produces: `<ConversationTab capture={capture} />`

- [ ] **Step 1: Create `web/src/components/ConversationTab.tsx`**

Reproduces `renderConversation` from `public/index.html` lines 1157–1190.

```tsx
import type { Capture, Message as MessageType } from "../types";
import { buildConversationItems } from "../lib/conversation";
import { rebuildAssistantFromSSE } from "../lib/sse";
import Message, { SystemMessage } from "./Message";
import ToolPair from "./ToolPair";

interface ConversationTabProps {
  capture: Capture;
}

export default function ConversationTab({ capture }: ConversationTabProps) {
  const req = capture.request?.body || {};
  const messages = req.messages || [];
  const sse = capture.response?.sse_events || [];
  const rebuiltAssistant = rebuildAssistantFromSSE(sse);

  // 构建时间线：system → 请求消息 → SSE 重建的 assistant 回复。
  // Build the chronological thread: system → request messages → SSE reply.
  const all: MessageType[] = [];
  if (req.system) {
    const sys =
      typeof req.system === "string"
        ? req.system
        : JSON.stringify(req.system, null, 2);
    all.push({ role: "system", content: sys });
  }
  for (const m of messages) all.push(m);
  if (rebuiltAssistant) {
    all.push({
      role: "assistant",
      content: rebuiltAssistant,
      fromSSE: true,
    });
  }

  const items = buildConversationItems(all);
  const toolPairCount = items.filter((i) => i.kind === "tool-pair").length;
  const textTurnCount = items.filter(
    (i) => i.kind !== "tool-pair" && i.kind !== "system",
  ).length;
  const status = capture.response?.status_code;
  const statusBadgeCls = status === 200 ? "ok" : "err";

  return (
    <div>
      <div className="meta-table">
        <div className="kv">
          <div className="k">Model</div>
          <div>{req.model || "—"}</div>
        </div>
        <div className="kv">
          <div className="k">Temp / MaxTokens</div>
          <div>
            temp={req.temperature ?? "—"} · max={req.max_tokens ?? "—"}
          </div>
        </div>
        <div className="kv">
          <div className="k">Tools</div>
          <div>{req.tools?.length || 0} declared</div>
        </div>
        <div className="kv">
          <div className="k">Stream</div>
          <div>{req.stream ?? "—"}</div>
        </div>
        <div className="kv">
          <div className="k">Response</div>
          <div>
            <span className={`badge ${statusBadgeCls}`}>{status ?? "—"}</span>
          </div>
        </div>
      </div>

      <h3 className="section">
        Conversation · {textTurnCount} turns
        {toolPairCount ? ` · ${toolPairCount} tool calls` : ""}
      </h3>

      {items.map((it, i) => {
        switch (it.kind) {
          case "system":
            return <SystemMessage key={i} message={it.message} />;
          case "user":
            return <Message key={i} message={it.message} idx={it.idx} />;
          case "assistant":
            return <Message key={i} message={it.message} idx={it.idx} />;
          case "tool-pair":
            return (
              <ToolPair
                key={i}
                toolUse={it.toolUse}
                toolResult={it.toolResult}
              />
            );
          default:
            return <Message key={i} message={it.message} idx={it.idx} />;
        }
      })}
    </div>
  );
}
```

- [ ] **Step 2: Verify build**

Run:
```bash
cd web && npm run build
```
Expected: success.

- [ ] **Step 3: Commit**

```bash
cd .. && git add web/ && git commit -m "feat(web): ConversationTab component"
```

---

<a id="task-10"></a>
### Task 10: Port SseTimeline, Request, Response, Raw JSON tabs

**Files:**
- Create: `web/src/components/SseTimeline.tsx`, `web/src/components/RequestTab.tsx`, `web/src/components/ResponseTab.tsx`, `web/src/components/RawJsonTab.tsx`, `web/src/components/Tabs.tsx`, `web/src/components/Toolbar.tsx`, `web/src/components/DetailPane.tsx`

**Interfaces:**
- Consumes: `Capture` from `types.ts`, `rebuildAssistantFromSSE` from `lib/sse.ts`, `redactHeaders` from `lib/redact.ts`, `escapeHtml` from `lib/format.ts`, `highlightJSON` from `lib/json.ts`, `JsonBlock` from `./JsonBlock`, `EmptyState` from `./EmptyState`
- Produces: the four remaining tab components, plus the tab strip / toolbar / detail-pane shells

- [ ] **Step 1: Create `web/src/components/SseTimeline.tsx`**

Reproduces `renderSSE` from `public/index.html` lines 1580–1605.

```tsx
import type { Capture } from "../types";
import { escapeHtml } from "../lib/format";
import EmptyState from "./EmptyState";

interface SseTimelineProps {
  capture: Capture;
}

export default function SseTimeline({ capture }: SseTimelineProps) {
  const events = capture.response?.sse_events || [];
  if (events.length === 0) {
    return (
      <div>
        <EmptyState big="No stream captured" small="RESPONSE WAS NOT SSE · SEE BODY BELOW" />
        <h3 className="section">Response body</h3>
        <pre className="json">
          {JSON.stringify(
            capture.response?.body ?? capture.response ?? {},
            null,
            2,
          )}
        </pre>
      </div>
    );
  }
  return (
    <div>
      <div
        style={{
          marginBottom: 14,
          color: "var(--text-dim)",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
        }}
      >
        {events.length} events ·{" "}
        <span style={{ color: "var(--sage-deep)" }}>streaming timeline</span>
      </div>
      <div className="sse-list">
        {events.map((ev, i) => {
          const name = ev.event || "—";
          const cls = name.includes("delta")
            ? "delta"
            : name.includes("tool")
              ? "tool_use"
              : name.includes("error")
                ? "error"
                : "";
          const dataStr =
            typeof ev.data === "string" ? ev.data : JSON.stringify(ev.data);
          const preview =
            dataStr.length > 500
              ? dataStr.slice(0, 500) + ` … (+${dataStr.length - 500})`
              : dataStr;
          return (
            <div className="sse-item" key={i}>
              <div className="sse-idx">#{String(i).padStart(3, "0")}</div>
              <div
                className={`sse-event ${cls}`}
                dangerouslySetInnerHTML={{ __html: escapeHtml(name) }}
              />
              <div
                className="sse-data"
                dangerouslySetInnerHTML={{ __html: escapeHtml(preview) }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create `web/src/components/RequestTab.tsx`**

Reproduces `renderRequest` from `public/index.html` lines 1607–1629.

```tsx
import type { Capture } from "../types";
import { redactHeaders } from "../lib/redact";
import JsonBlock from "./JsonBlock";

interface RequestTabProps {
  capture: Capture;
}

export default function RequestTab({ capture }: RequestTabProps) {
  const req = capture.request || {};
  const tools = req.body?.tools || [];
  return (
    <div>
      <div className="meta-table">
        <div className="kv">
          <div className="k">URL</div>
          <div>{req.url || ""}</div>
        </div>
        <div className="kv">
          <div className="k">Method</div>
          <div>{req.method || ""}</div>
        </div>
      </div>

      <h3 className="section">Headers</h3>
      <JsonBlock value={redactHeaders(req.headers)} variant="raw" />

      {tools.length > 0 && (
        <>
          <h3 className="section">Tools · {tools.length} declared</h3>
          {tools.map((t, i) => {
            const name = t.name || t.function?.name || "(unnamed)";
            return (
              <details key={i}>
                <summary>{name}</summary>
                <pre className="json" style={{ marginTop: 8 }}>
                  {JSON.stringify(t, null, 2)}
                </pre>
              </details>
            );
          })}
        </>
      )}

      <h3 className="section">Request body</h3>
      <JsonBlock value={req.body} variant="raw" />
    </div>
  );
}
```

- [ ] **Step 3: Create `web/src/components/ResponseTab.tsx`**

Reproduces `renderResponse` from `public/index.html` lines 1631–1692.

```tsx
import type { Capture } from "../types";
import { redactHeaders } from "../lib/redact";
import { rebuildAssistantFromSSE } from "../lib/sse";
import JsonBlock from "./JsonBlock";
import EmptyState from "./EmptyState";

interface ResponseTabProps {
  capture: Capture;
}

export default function ResponseTab({ capture }: ResponseTabProps) {
  const res = capture.response || {};
  const sse = res.sse_events || [];
  const hasBody = res.body !== undefined && res.body !== null;
  const status = res.status_code ?? res.status;
  const badgeCls =
    status === 200 ? "ok" : status && status >= 400 ? "err" : "neutral";

  const ct = res.headers?.["content-type"] || res.headers?.["Content-Type"] || "—";

  return (
    <div>
      <div className="meta-table">
        <div className="kv">
          <div className="k">Status</div>
          <div>
            <span className={`badge ${badgeCls}`}>{status ?? "—"}</span>
          </div>
        </div>
        <div className="kv">
          <div className="k">SSE Events</div>
          <div>{sse.length}</div>
        </div>
        <div className="kv">
          <div className="k">Has Body</div>
          <div>{hasBody ? "yes" : "no"}</div>
        </div>
        <div className="kv">
          <div className="k">Content-Type</div>
          <div>{ct}</div>
        </div>
      </div>

      {res.headers && Object.keys(res.headers).length > 0 && (
        <>
          <h3 className="section">Response headers</h3>
          <JsonBlock value={redactHeaders(res.headers)} variant="raw" />
        </>
      )}

      {sse.length > 0 && (() => {
        const rebuilt = rebuildAssistantFromSSE(sse);
        if (!rebuilt) return null;
        return (
          <>
            <h3 className="section">Reassembled content blocks</h3>
            <div
              style={{
                marginBottom: 10,
                color: "var(--text-dim)",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                letterSpacing: "0.04em",
              }}
            >
              {rebuilt.length} block{rebuilt.length === 1 ? "" : "s"} reconstructed
              from {sse.length} SSE events
            </div>
            <JsonBlock value={rebuilt} />
          </>
        );
      })()}

      {hasBody && (() => {
        let bodyStr: string;
        try {
          bodyStr =
            typeof res.body === "string"
              ? res.body
              : JSON.stringify(res.body, null, 2);
        } catch {
          bodyStr = String(res.body);
        }
        const trimmed = bodyStr.trim();
        const isJson = trimmed.startsWith("{") || trimmed.startsWith("[");
        if (isJson) {
          try {
            const parsed = JSON.parse(trimmed);
            return (
              <>
                <h3 className="section">Response body</h3>
                <JsonBlock value={parsed} />
              </>
            );
          } catch {
            return (
              <>
                <h3 className="section">Response body</h3>
                <pre className="json">{bodyStr}</pre>
              </>
            );
          }
        }
        return (
          <>
            <h3 className="section">Response body</h3>
            <pre className="json">{bodyStr}</pre>
          </>
        );
      })()}

      {sse.length === 0 && !hasBody && (
        <EmptyState
          big="No response captured"
          small="NEITHER SSE EVENTS NOR A RESPONSE BODY WAS RECORDED"
          style={{ padding: "60px 20px" }}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 4: Create `web/src/components/RawJsonTab.tsx`**

```tsx
import type { Capture } from "../types";

interface RawJsonTabProps {
  capture: Capture;
}

export default function RawJsonTab({ capture }: RawJsonTabProps) {
  return <pre className="json">{JSON.stringify(capture, null, 2)}</pre>;
}
```

- [ ] **Step 5: Create `web/src/components/Tabs.tsx`**

```tsx
export type TabId = "conv" | "sse" | "req" | "res" | "raw";

interface TabsProps {
  active: TabId;
  onChange: (tab: TabId) => void;
}

const TABS: { id: TabId; label: string }[] = [
  { id: "conv", label: "Conversation" },
  { id: "sse", label: "SSE Timeline" },
  { id: "req", label: "Request" },
  { id: "res", label: "Response" },
  { id: "raw", label: "Raw JSON" },
];

export default function Tabs({ active, onChange }: TabsProps) {
  return (
    <div className="tabs">
      {TABS.map((t) => (
        <div
          key={t.id}
          className={`tab${t.id === active ? " active" : ""}`}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 6: Create `web/src/components/Toolbar.tsx`**

```tsx
interface ToolbarProps {
  filename: string | null;
  onRefresh: () => void;
}

export default function Toolbar({ filename, onRefresh }: ToolbarProps) {
  return (
    <div className="toolbar">
      <span id="currentFile">{filename || "no capture selected"}</span>
      <span style={{ flex: 1 }} />
      <button onClick={onRefresh}>↻ REFRESH</button>
    </div>
  );
}
```

- [ ] **Step 7: Create `web/src/components/DetailPane.tsx`**

Renders the right pane: empty state when no capture, or toolbar + tabs + active tab content.

```tsx
import type { Capture } from "../types";
import { useState } from "react";
import Toolbar from "./Toolbar";
import Tabs, { type TabId } from "./Tabs";
import ConversationTab from "./ConversationTab";
import SseTimeline from "./SseTimeline";
import RequestTab from "./RequestTab";
import ResponseTab from "./ResponseTab";
import RawJsonTab from "./RawJsonTab";
import EmptyState from "./EmptyState";

interface DetailPaneProps {
  capture: Capture | null;
  filename: string | null;
  onRefresh: () => void;
}

export default function DetailPane({
  capture,
  filename,
  onRefresh,
}: DetailPaneProps) {
  const [tab, setTab] = useState<TabId>("conv");

  if (!capture) {
    return (
      <main className="main">
        <Toolbar filename={null} onRefresh={onRefresh} />
        <div className="content">
          <EmptyState
            big="Awaiting inspection"
            small="SELECT A CAPTURE FROM THE ARCHIVE"
            arrow
          />
        </div>
      </main>
    );
  }

  return (
    <main className="main">
      <Toolbar filename={filename} onRefresh={onRefresh} />
      <Tabs active={tab} onChange={setTab} />
      <div className="content">
        {tab === "conv" && <ConversationTab capture={capture} />}
        {tab === "sse" && <SseTimeline capture={capture} />}
        {tab === "req" && <RequestTab capture={capture} />}
        {tab === "res" && <ResponseTab capture={capture} />}
        {tab === "raw" && <RawJsonTab capture={capture} />}
      </div>
    </main>
  );
}
```

- [ ] **Step 8: Verify build**

Run:
```bash
cd web && npm run build
```
Expected: success.

- [ ] **Step 9: Commit**

```bash
cd .. && git add web/ && git commit -m "feat(web): SseTimeline, Request/Response/Raw tabs, Tabs/Toolbar/DetailPane shells"
```

---

<a id="task-11"></a>
### Task 11: Wire App.tsx with state and polling

**Files:**
- Modify: `web/src/App.tsx` (replace placeholder)

**Interfaces:**
- Consumes: `fetchFiles`, `fetchFile` from `lib/api.ts`, `ConversationList`, `DetailPane` from `./components/*`, `ListItem`, `Capture` from `types.ts`
- Produces: the working viewer UI

- [ ] **Step 1: Replace `web/src/App.tsx`**

Reproduces the polling + selection + tab-switching logic from `public/index.html` lines 1051–1155. Polling cadence: 3 seconds (matches original `setInterval(reloadFiles, 3000)`).

```tsx
import { useEffect, useState } from "react";
import { fetchFile, fetchFiles } from "./lib/api";
import type { Capture, ListItem } from "./types";
import ConversationList from "./components/ConversationList";
import DetailPane from "./components/DetailPane";

export default function App() {
  const [items, setItems] = useState<ListItem[]>([]);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [capture, setCapture] = useState<Capture | null>(null);

  // 轮询 /api/files 每 3 秒；网络抖动时静默跳过。
  // Poll /api/files every 3s; silently skip on network hiccup.
  const load = async () => {
    try {
      const list = await fetchFiles();
      setItems(list);
    } catch {
      /* skip */
    }
  };

  useEffect(() => {
    load();
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, []);

  const onSelect = async (name: string) => {
    setSelectedName(name);
    try {
      const data = await fetchFile(name);
      setCapture(data);
    } catch {
      setCapture(null);
    }
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="eyebrow">
            <span className="dot" />
            Capture Inspector
          </div>
          <h1>
            Claude Code
            <br />
            <em>traffic archive</em>
          </h1>
          <div className="sub" id="count">
            {items.length === 0
              ? "— scanning —"
              : `${items.length} capture${items.length === 1 ? "" : "s"} on record`}
          </div>
        </div>
        <ConversationList
          items={items}
          selectedName={selectedName}
          onSelect={onSelect}
        />
      </aside>
      <DetailPane
        capture={capture}
        filename={selectedName}
        onRefresh={load}
      />
    </div>
  );
}
```

- [ ] **Step 2: Verify build**

Run:
```bash
cd web && npm run build
```
Expected: success. `../dist/` produced.

- [ ] **Step 3: Smoke-test against live viewer**

In terminal A (repo root):
```bash
node bin/claude-capture.mjs
```
Note the viewer port (default 7777).

In terminal B:
```bash
cd web && npm run dev
```

Open `http://localhost:5173`. Expected: sidebar shows captures; clicking one loads the Conversation tab; all 5 tabs render without console errors. The old `http://127.0.0.1:7777/` still works as the safety net.

- [ ] **Step 4: Run Biome lint/format**

```bash
cd web && npm run format && npm run lint
```
Expected: no errors after format.

- [ ] **Step 5: Commit**

```bash
cd .. && git add web/ && git commit -m "feat(web): wire App.tsx — polling, selection, tab switching"
```

---

<a id="task-12"></a>
### Task 12: Side-by-side parity verification

**Files:** none (verification only)

This task is the gate per spec Section 6. Do **not** proceed to Task 13 until every item passes.

- [ ] **Step 1: Set up both UIs against the same capture dir**

```bash
# Terminal A — old UI (safety net)
node bin/claude-capture.mjs
# → viewer at http://127.0.0.1:<viewer-port>/ serving public/

# Terminal B — new UI
cd web && npm run dev
# → vite at http://localhost:5173 proxying /api to the viewer
```

Open both in browser tabs. Point them at the same `$CLAUDE_CAPTURE_DIR`. If empty, generate a few captures by running `claude` through the proxy.

- [ ] **Step 2: Verify each item on the parity checklist**

For each item, compare old vs new visually. Diff any rendered HTML if useful (browser DevTools → Elements).

1. **`GET /api/files`** — capture list identical: same items, same sort order, same preview text, same badges.
2. **`GET /api/file?name=`** — same JSON shape returned; clicking a file loads it in both UIs.
3. **Conversation tab** — system (collapsible), user messages, assistant prose, thinking blocks, tool_use+tool_result pairs render identically.
4. **SSE Timeline tab** — same event order, same event-type coloring (delta / tool_use / error / message_start), same 500-char truncation marker.
5. **Request tab** — same URL/method, headers (with redaction), tool list (collapsible), request body JSON.
6. **Response tab** — same status badge, SSE event count, content-type, reassembled blocks section, response body.
7. **Raw JSON tab** — verbatim identical JSON.
8. **API-key redaction** — capture a request with a real `x-api-key` header; both UIs must show only the first 8 chars + `…` in the Request/Response tabs. Plant a fake key (`sk-ant-test1234567890`) if you don't want to use a real one.
9. **Polling cadence** — drop a new `.json` file into `$CLAUDE_CAPTURE_DIR`; both UIs pick it up within ~3 seconds.
10. **Static asset serving** — Vite dev mode uses its own assets; this item is about the built `dist/` (verify in Step 3).
11. **Path-traversal guard** — re-test in Task 13 after the server flip; for now just confirm `/api/file?name=../x` returns 400 in both UIs.

- [ ] **Step 3: Test the production build (item 10)**

Stop the dev server (terminal B). Build and serve `dist/`:
```bash
cd web && npm run build
cd ..
# Temporarily point the server at dist/ for this test ONLY — do NOT commit the change.
# Edit lib/server.mjs: publicDir default 'public' → 'dist' (or pass via opts if your bin supports it).
node bin/claude-capture.mjs
```
Open the viewer URL. All assets (JS, CSS) load; same tabs render correctly.

**Revert the `lib/server.mjs` change after the test** — Task 13 is where the flip lands:
```bash
git checkout lib/server.mjs
```

- [ ] **Step 4: Document any discrepancies**

If any item fails, file a follow-up task before proceeding. Do not pass this gate with known regressions.

- [ ] **Step 5: Commit a parity-verified marker**

No code change in this task; this is a checkpoint commit on the working branch to record that parity was reached.
```bash
git commit --allow-empty -m "chore(web): parity verification complete — ready for flip"
```

---

<a id="task-13"></a>
### Task 13: Flip server to `dist/`, update root package.json + CLAUDE.md, delete monolith

**Files:**
- Modify: `lib/server.mjs` (one-line `publicDir` change — but only if the path is hardcoded; if `publicDir` comes from `bin/claude-capture.mjs`, change it there)
- Modify: `package.json` (root)
- Modify: `CLAUDE.md`
- Modify: `web/vite.config.ts` (already targets `../dist/` — no change unless parity test surfaced an issue)
- Delete: `public/index.html`

- [ ] **Step 1: Locate the `publicDir` source**

Run:
```bash
grep -n "public" bin/claude-capture.mjs lib/server.mjs
```
Expected: find where `publicDir` is resolved. Most likely `bin/claude-capture.mjs` passes `path.join(__dirname, '..', 'public')` into `startServer`.

- [ ] **Step 2: Flip the path to `dist/`**

In `bin/claude-capture.mjs` (or wherever the resolved path lives), change:
```js
// was:  path.join(__dirname, '..', 'public')
path.join(__dirname, '..', 'dist')
```
Keep the comment style bilingual if surrounding lines are.

- [ ] **Step 3: Update root `package.json`**

Add the `prepublishOnly` script and swap `public` → `dist` in the `files` list:
```json
{
  "scripts": {
    "prepublishOnly": "cd web && npm ci && npm run build"
  },
  "files": [
    "bin",
    "lib",
    "dist",
    "README.md"
  ]
}
```
Preserve all other keys (`name`, `version`, `bin`, `engines`, etc.).

- [ ] **Step 4: Update `CLAUDE.md`**

Apply the five changes from spec Section 7:
1. **"What this is"** — replace `"There is no build step, no test suite, no lint config."` with `"There is no test suite. The viewer UI (web/) has a build step (Vite → dist/); the CLI itself (bin/, lib/) is still raw source with no build."`
2. **"No new dependencies"** — replace with the runtime/dev split clarification.
3. **"How the pieces find each other"** — add the `web/ → npm run build → dist/ → lib/server.mjs` line.
4. **"Running locally"** — add the dev workflow block (cd web && npm install && npm run dev).
5. **File list note** — change `"bin, lib, public, README.md"` → `"bin, lib, dist, README.md"`.

- [ ] **Step 5: Build `dist/` and verify the production app loads**

```bash
cd web && npm run build && cd ..
node bin/claude-capture.mjs
```
Open the viewer URL. All tabs work; no console errors; captures appear and render correctly.

- [ ] **Step 6: Verify `npm pack` contents**

```bash
npm pack --dry-run 2>&1 | grep -E "bin/|lib/|dist/|README.md|package.json"
```
Expected: only those paths listed. No `web/`, no `public/`, no `node_modules/`.

- [ ] **Step 7: Delete the monolith**

```bash
git rm public/index.html
rmdir public  # if empty
```

- [ ] **Step 8: Commit the flip**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat: ship React viewer (dist/) and retire public/index.html

- lib/server.mjs publicDir: public → dist
- package.json: add prepublishOnly hook, ship dist/ not public/
- CLAUDE.md: document build step + dev workflow
- delete public/index.html (the 1821-line monolith)

The old UI is gone; all five tabs now render from the React app in
web/ → dist/.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 9: Final smoke test**

```bash
rm -rf dist  # ensure a clean build
npm install  # at root, no-op but sanity check
(cd web && npm ci && npm run build)  # simulate prepublishOnly
node bin/claude-capture.mjs
```
Open the viewer URL. Confirm everything works from a clean state.

---

## Self-Review

**Spec coverage:**
- Spec Section 3 (directory layout) → Task 1 ✓
- Spec Section 4 (component breakdown & state) → Tasks 7–11 ✓
- Spec Section 5 (build/dev/publish workflow) → Tasks 1, 11, 13 ✓
- Spec Section 6 (feature-parity checklist) → Task 12 ✓
- Spec Section 7 (CLAUDE.md changes) → Task 13 ✓
- Spec Section 8 (risk register) → mitigated by side-by-side approach (Task 12 gate) + `npm pack` check (Task 13 Step 6) ✓
- Spec Section 9 (implementation order) → matches Task sequence ✓

**Placeholder scan:** No TBDs / TODOs / "implement later" / "similar to Task N". Every step has concrete code or commands.

**Type consistency:**
- `ListItem`, `Capture`, `Message`, `ContentBlock`, `ToolUseBlock`, `ToolResultBlock`, `SseEvent`, `ConversationItem` — used consistently across files.
- `ConversationItem` discriminated union: kinds `"system" | "user" | "assistant" | "tool-pair" | "other"` match between `lib/conversation.ts` (producer) and `ConversationTab.tsx` (consumer).
- `TabId = "conv" | "sse" | "req" | "res" | "raw"` matches between `Tabs.tsx` and `DetailPane.tsx`.
- `fetchFiles(): Promise<ListItem[]>`, `fetchFile(name: string): Promise<Capture>` — signatures match `App.tsx` usage.

**Scope check:** Single focused plan; no decomposition needed. Tasks 1–13 form one shippable migration.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-07-react-frontend-migration.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
