# Sidebar Conversation Grouping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the viewer sidebar from a flat per-session list of HTTP calls into a 3-level tree (session → conversation → turns) so the user can find and trace conversations instead of hunting for "where did this conversation start" among dozens of identical-preview rows.

**Architecture:** Server classifies each capture as `anchor` (new human turn) or `continuation` (tool-result feedback) and computes a kind-appropriate preview. Frontend groups consecutive captures within a session into conversations (anchor starts a new conversation; continuations append), sequesters utility captures into a per-session bucket, and renders a 4-row-type virtualized list (session header / conversation header / turn leaf / utility bucket). Object-identity caches on each node type preserve React `memo` effectiveness across polls.

**Tech Stack:** Node built-ins (`lib/server.mjs`), React + TypeScript + Vite + `@tanstack/react-virtual` (`web/`), plain CSS (`web/src/styles/global.css`). No new dependencies.

## Global Constraints

- **No new runtime dependencies.** Root `package.json` has zero runtime deps; all new logic uses Node built-ins or existing frontend deps.
- **No test framework.** Per `CLAUDE.md`. Verification is one-shot Node scripts (live in `/tmp`, not committed) and a final visual check. No test files.
- **Bilingual comments.** Match the surrounding Chinese + English style in `lib/server.mjs`, `groupSessions.ts`, and `ConversationList.tsx`.
- **ListItem object identity is load-bearing.** The server's `listCache` returns the same `ListItem` reference for unchanged files; downstream React `memo` and the frontend's node caches rely on this. Never spread a `ListItem` into a new object.
- **Node-cache identity is load-bearing.** `groupSessions.ts` must reuse the same `TreeNode` wrapper objects across polls when their underlying `ListItem` references are unchanged. Rebuilding every wrapper every poll defeats `TreeNodeRow`'s `memo()`.
- **Virtualizer keys must be stable.** `getItemKey` returns `node.key`; keys must be deterministic across polls (derived from session/capture names, never from array indices).
- **Capture filenames contain `/`** (e.g. `session-xxx/file.json`); the first `/` separates session key from filename, as in the existing `buildTree`.

---

### Task 1: Server-side classification + preview branching

**Files:**
- Modify: `lib/server.mjs` (add `classifyKind` after `classifyRequest` ~line 150; add `extractAssistantAction` after `extractLastUserText` ~line 109; branch preview + emit `kind` in `listCaptures` ~line 74)
- Modify: `web/src/types.ts` (extend `ListItem` at line 112-118)

**Interfaces:**
- Produces: `classifyKind(data: object): "anchor" | "continuation"` and `extractAssistantAction(data: object): string | null` in `lib/server.mjs`. The `ListItem` JSON from `/api/files` gains a `kind` field consumed by Task 2's grouping logic.

- [ ] **Step 1: Add `classifyKind` function**

In `lib/server.mjs`, immediately after the closing brace of `classifyRequest` (~line 150), insert:

```js
// 判定一条 capture 是「锚点」（用户真正发了新消息）还是「续轮」（工具结果回填）。
// 用于前端把 capture 聚合成对话：每个 anchor 开启新对话，continuation 追加到当前对话。
// Determine whether a capture is an "anchor" (the user sent a new message) or a
// "continuation" (a tool_result feeding back). The frontend groups captures into
// conversations using this: each anchor starts a new conversation, continuations append.
function classifyKind(data) {
  const msgs = data?.request?.body?.messages;
  if (!Array.isArray(msgs)) return "anchor";
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== "user") continue;
    const content = m.content;
    if (typeof content === "string") return "anchor";
    if (Array.isArray(content)) {
      for (const c of content) {
        if (c && typeof c === "object" && c.type === "tool_result") return "continuation";
      }
      return "anchor";
    }
    return "anchor";
  }
  return "anchor";
}
```

- [ ] **Step 2: Add `extractAssistantAction` function**

In `lib/server.mjs`, immediately after the closing brace of `extractLastUserText` (~line 109), insert. This function summarizes what the assistant did on a continuation turn — used as the preview for continuation rows instead of the repeated user message.

```js
// 已知工具名 → 取哪个 input 字段作为简短展示。
// Well-known tool names → which input field to show as the brief label.
const TOOL_INPUT_FIELD = {
  Read: "file_path",
  Edit: "file_path",
  Write: "file_path",
  Bash: "command",
  Grep: "pattern",
  Glob: "pattern",
  Agent: "description",
  Task: "description",
  WebFetch: "url",
  WebSearch: "query",
};

// 从 capture 里提取「助手这轮做了什么」作为 continuation 行的 preview。
// 优先展示工具调用（ToolName · 简短参数）；没有工具调用则展示文本回复的片段。
// Extract "what the assistant did this turn" as the preview for continuation rows.
// Prefers tool calls (ToolName · brief arg); falls back to a text-response snippet.
function extractAssistantAction(data) {
  const msgs = data?.request?.body?.messages;
  if (!Array.isArray(msgs)) return null;
  let assistant = null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "assistant") { assistant = msgs[i]; break; }
  }
  if (!assistant) return "(no assistant turn)";
  const content = Array.isArray(assistant.content) ? assistant.content : [];

  // 收集 tool_use 块（跳过 thinking 块）。
  // Collect tool_use blocks (skip thinking blocks).
  const toolUses = content.filter(
    (c) => c && typeof c === "object" && c.type === "tool_use"
  );
  if (toolUses.length > 0) {
    const fmtOne = (tu) => {
      const name = tu.name || "tool";
      const field = TOOL_INPUT_FIELD[name];
      let arg = "";
      if (field && tu.input && typeof tu.input === "object" && typeof tu.input[field] === "string") {
        arg = " · " + tu.input[field].slice(0, 40);
      }
      return name + arg;
    };
    const first = fmtOne(toolUses[0]);
    return toolUses.length === 1 ? first : first + " + " + (toolUses.length - 1) + " more";
  }

  // 没有工具调用 —— 取第一条 text 块的片段。
  // No tool calls — snippet the first text block.
  for (const c of content) {
    if (c && typeof c === "object" && c.type === "text" && typeof c.text === "string") {
      const snippet = c.text.replace(/\s+/g, " ").trim().slice(0, 60);
      return '"' + snippet + '..."';
    }
  }
  return "(empty assistant turn)";
}
```

- [ ] **Step 3: Branch preview and emit `kind` in `listCaptures`**

In `lib/server.mjs`, inside `listCaptures`, the successful-parse branch (~line 67-77) currently reads:

```js
        const data = JSON.parse(raw);
        const lastUser = extractLastUserText(data);
        const item = {
          name: childRel,
          mtime: stat.mtimeMs,
          size: stat.size,
          status: data.response?.status_code,
          preview: lastUser?.slice(0, 80) ?? "(empty)",
          tag: classifyRequest(data),
        };
```

Replace with:

```js
        const data = JSON.parse(raw);
        const kind = classifyKind(data);
        const preview = kind === "continuation"
          ? extractAssistantAction(data)
          : extractLastUserText(data);
        const item = {
          name: childRel,
          mtime: stat.mtimeMs,
          size: stat.size,
          status: data.response?.status_code,
          preview: preview?.slice(0, 80) ?? "(empty)",
          tag: classifyRequest(data),
          kind,
        };
```

The parse-error fallback branch (~line 79) is **unchanged** — it omits `kind`, which the frontend treats as `"anchor"`.

- [ ] **Step 4: Add `kind` to the `ListItem` type**

In `web/src/types.ts`, the `ListItem` interface (~line 112-118) currently reads:

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

Add the `kind` field:

```ts
export interface ListItem {
  name: string;
  mtime: number;
  size: number;
  status?: number;
  preview: string;
  tag?: string; // "main" | "subagent" | "explore" | "utility" | "unknown"
  kind?: "anchor" | "continuation";
}
```

- [ ] **Step 5: Verify classification + preview with a one-shot script**

Write `/tmp/verify_kind.mjs`:

```js
import fs from "node:fs";
import path from "node:path";

function classifyKind(data) {
  const msgs = data?.request?.body?.messages;
  if (!Array.isArray(msgs)) return "anchor";
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== "user") continue;
    const content = m.content;
    if (typeof content === "string") return "anchor";
    if (Array.isArray(content)) {
      for (const c of content) {
        if (c && typeof c === "object" && c.type === "tool_result") return "continuation";
      }
      return "anchor";
    }
    return "anchor";
  }
  return "anchor";
}

const TOOL_INPUT_FIELD = {
  Read: "file_path", Edit: "file_path", Write: "file_path",
  Bash: "command", Grep: "pattern", Glob: "pattern",
  Agent: "description", Task: "description",
  WebFetch: "url", WebSearch: "query",
};

function extractAssistantAction(data) {
  const msgs = data?.request?.body?.messages;
  if (!Array.isArray(msgs)) return null;
  let assistant = null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "assistant") { assistant = msgs[i]; break; }
  }
  if (!assistant) return "(no assistant turn)";
  const content = Array.isArray(assistant.content) ? assistant.content : [];
  const toolUses = content.filter((c) => c?.type === "tool_use");
  if (toolUses.length > 0) {
    const fmtOne = (tu) => {
      const name = tu.name || "tool";
      const field = TOOL_INPUT_FIELD[name];
      let arg = "";
      if (field && tu.input && typeof tu.input[field] === "string") arg = " · " + tu.input[field].slice(0, 40);
      return name + arg;
    };
    const first = fmtOne(toolUses[0]);
    return toolUses.length === 1 ? first : first + " + " + (toolUses.length - 1) + " more";
  }
  for (const c of content) {
    if (c?.type === "text" && typeof c.text === "string") {
      return '"' + c.text.replace(/\s+/g, " ").trim().slice(0, 60) + '..."';
    }
  }
  return "(empty assistant turn)";
}

const base = path.resolve(process.env.HOME, ".claude-capture/captures");
const kindCount = { anchor: 0, continuation: 0 };
const samples = [];
let total = 0;
function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) { walk(full); continue; }
    if (!ent.name.endsWith(".json")) continue;
    try {
      const data = JSON.parse(fs.readFileSync(full, "utf8"));
      const kind = classifyKind(data);
      kindCount[kind]++;
      total++;
      if (kind === "continuation" && samples.length < 8) {
        samples.push({ f: ent.name, action: extractAssistantAction(data) });
      }
    } catch {}
  }
}
walk(base);
console.log(`Total: ${total}`);
console.log(`  anchors:       ${kindCount.anchor}`);
console.log(`  continuations: ${kindCount.continuation}`);
console.log(`\nSample continuation previews:`);
for (const s of samples) console.log(`  ${s.action}  <- ${s.f}`);
```

Run: `node /tmp/verify_kind.mjs`

Expected: a population of both `anchor` and `continuation` (e.g. ~670 anchors + ~90 continuations in the 760-capture corpus, but ratios depend on what's been captured). Continuation samples should show readable summaries like `Read · src/auth.ts`, `Bash · npm test`, `"I'll start by..."`, NOT garbage or the user's original message.

If continuations are near-zero, the detection is broken — check that real tool-result-turn captures contain `{type:"tool_result"}` in the last user message's content.

- [ ] **Step 6: Commit**

```bash
git add lib/server.mjs web/src/types.ts
git commit -m "feat(server): classify captures as anchor/continuation + kind-aware preview"
```

---

### Task 2: 3-level tree grouping

**Files:**
- Modify: `web/src/lib/groupSessions.ts` (full rewrite of types + `buildTree` + `flattenVisible`)

**Interfaces:**
- Consumes: `ListItem.kind` (`"anchor" | "continuation" | undefined`) and `ListItem.tag` from Task 1.
- Produces: a rewritten `groupSessions.ts` exporting `buildTree(items: ListItem[]): TreeNode[]` and `flattenVisible(tree: TreeNode[], collapsedKeys: Set<string>): TreeNode[]`, where `TreeNode` is a discriminated union of `SessionNode | ConversationHeaderNode | UtilityBucketNode | LeafNode`. Task 3's renderer switches on `node.type`.

- [ ] **Step 1: Replace the type definitions at the top of the file**

Replace lines 1-15 of `web/src/lib/groupSessions.ts` (the `TreeNode` interface and the comment above it) with:

```ts
import type { ListItem } from "../types";

// 会话侧边栏的树节点：session → conversation/utility → leaf（turn 或 utility capture）。
// 用判别联合（node.type）让渲染端的类型收窄自然落地。
// Sidebar tree nodes: session → conversation/utility → leaf (turn or utility capture).
// Discriminated union (node.type) so the renderer narrows naturally.

export interface SessionNode {
  type: "session";
  depth: number;            // 0
  key: string;              // session key (directory prefix)
  name: string;             // session dirname
  conversations: ConversationHeaderNode[]; // newest-first by endTime
  utilityBucket: ListItem[];               // utility-tagged captures, oldest-first
  utilityKey: string;       // `${key}#utility` — collapse key for the utility bucket
  newestMtime: number;      // for cross-session sort
  captureCount: number;     // conversations + utility, for the header badge
}

export interface ConversationHeaderNode {
  type: "conversation";
  depth: number;            // 1
  key: string;              // `${sessionKey}#${anchorCaptureName}`
  anchorItem: ListItem;     // the anchor capture; rendered as the header
  turns: ListItem[];        // continuation captures only, oldest-first
  turnCount: number;        // turns.length + 1 (the anchor counts as turn 1)
  startTime: number;        // anchorItem.mtime
  endTime: number;          // last turn mtime, or anchor mtime if no turns
  tag?: string;             // inherited from anchorItem.tag
}

export interface UtilityBucketNode {
  type: "utility";
  depth: number;            // 1
  key: string;              // `${sessionKey}#utility`
  captures: ListItem[];     // oldest-first
}

export interface LeafNode {
  type: "leaf";
  depth: number;            // 2 (under a conversation or utility bucket)
  key: string;              // capture filename (stable across polls)
  name: string;
  item: ListItem;
}

export type TreeNode = SessionNode | ConversationHeaderNode | UtilityBucketNode | LeafNode;
```

- [ ] **Step 2: Replace `buildTree` with the conversation-grouping version**

Replace the existing `buildTree` function and the `UNGROUPED` constant (lines 17-53) with:

```ts
const UNGROUPED = "ungrouped";

// 模块级缓存：相同 key 且底层 ListItem 引用未变 → 复用同一个 wrapper 节点。
// 下游 TreeNodeRow 的 memo() 依赖这个引用稳定性来跳过未变行的重渲染。
// Module-level caches: same key AND underlying ListItem refs unchanged → reuse the same
// wrapper node. Downstream TreeNodeRow's memo() relies on this identity stability.
const sessionCache = new Map<string, SessionNode>();
const conversationCache = new Map<string, ConversationHeaderNode>();
const leafCache = new Map<string, LeafNode>();
const utilityCache = new Map<string, UtilityBucketNode>();

function itemsEqual(a: ListItem[], b: ListItem[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function getOrCreateLeaf(item: ListItem, depth: number): LeafNode {
  let leaf = leafCache.get(item.name);
  if (!leaf || leaf.item !== item || leaf.depth !== depth) {
    leaf = { type: "leaf", depth, key: item.name, name: item.name, item };
    leafCache.set(item.name, leaf);
  }
  return leaf;
}

function getOrCreateConversation(
  sessionKey: string,
  anchor: ListItem,
  turns: ListItem[]
): ConversationHeaderNode {
  const key = `${sessionKey}#${anchor.name}`;
  const cached = conversationCache.get(key);
  if (cached && cached.anchorItem === anchor && itemsEqual(cached.turns, turns)) {
    return cached;
  }
  const conv: ConversationHeaderNode = {
    type: "conversation",
    depth: 1,
    key,
    anchorItem: anchor,
    turns,
    turnCount: turns.length + 1,
    startTime: anchor.mtime,
    endTime: turns.length ? turns[turns.length - 1].mtime : anchor.mtime,
    tag: anchor.tag,
  };
  conversationCache.set(key, conv);
  return conv;
}

function getOrCreateUtility(key: string, captures: ListItem[]): UtilityBucketNode {
  const cached = utilityCache.get(key);
  if (cached && itemsEqual(cached.captures, captures)) {
    return cached;
  }
  const bucket: UtilityBucketNode = {
    type: "utility",
    depth: 1,
    key,
    captures,
  };
  utilityCache.set(key, bucket);
  return bucket;
}

function getOrCreateSession(
  key: string,
  conversations: ConversationHeaderNode[],
  utilityBucket: ListItem[],
  newestMtime: number,
  captureCount: number
): SessionNode {
  const cached = sessionCache.get(key);
  if (
    cached &&
    itemsEqualSessions(cached.conversations, conversations) &&
    itemsEqual(cached.utilityBucket, utilityBucket) &&
    cached.captureCount === captureCount
  ) {
    return cached;
  }
  const session: SessionNode = {
    type: "session",
    depth: 0,
    key,
    name: key,
    conversations,
    utilityBucket,
    utilityKey: `${key}#utility`,
    newestMtime,
    captureCount,
  };
  sessionCache.set(key, session);
  return session;
}

// itemsEqualSessions: 引用比较 conversation 节点数组（conversation 节点本身已通过缓存稳定）。
// itemsEqualSessions: reference-compare conversation node arrays (the conversation nodes
// themselves are already stabilized via the cache).
function itemsEqualSessions(a: ConversationHeaderNode[], b: ConversationHeaderNode[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// 把扁平的 ListItem[] 组织成 3 层树：session → conversation → turns，外加 utility 桶。
// 同一 session 内：按 mtime 升序遍历，anchor 开新对话，continuation 追加；utility 单独入桶。
// Organize a flat ListItem[] into a 3-level tree: session → conversation → turns, plus a
// utility bucket. Within a session: walk oldest-first, anchor starts a new conversation,
// continuation appends; utility captures go into a separate bucket.
export function buildTree(items: ListItem[]): TreeNode[] {
  // 1. 按 session key 分桶（保留第一个 '/' 切分，兼容无 '/' 的裸文件名）。
  // 1. Bucket by session key (split on first '/'; tolerate bare filenames).
  const sessionBuckets = new Map<string, ListItem[]>();
  for (const it of items) {
    const slashIdx = it.name.indexOf("/");
    const key = slashIdx === -1 ? UNGROUPED : it.name.slice(0, slashIdx);
    const arr = sessionBuckets.get(key);
    if (arr) arr.push(it);
    else sessionBuckets.set(key, [it]);
  }

  const sessions: SessionNode[] = [];
  for (const [key, captures] of sessionBuckets) {
    // 2. 把 utility 单独拎出来，不参与对话分组。
    // 2. Pull utility captures aside; they don't participate in conversation grouping.
    const conversational = captures.filter((c) => c.tag !== "utility");
    const utility = captures.filter((c) => c.tag === "utility");

    // 3. 对话用 capture 按 mtime 升序，便于按时间顺序遍历分组。
    // 3. Conversational captures oldest-first so grouping walks in chronological order.
    const sorted = [...conversational].sort((a, b) => a.mtime - b.mtime);

    const conversations: ConversationHeaderNode[] = [];
    let current: { anchor: ListItem; turns: ListItem[] } | null = null;
    for (const c of sorted) {
      const isContinuation = c.kind === "continuation";
      if (!isContinuation) {
        // anchor（或 kind 缺失 —— 旧文件向后兼容）→ 关闭上一个对话，开启新对话。
        // anchor (or missing kind — backward compat) → close previous, start new.
        if (current) conversations.push(getOrCreateConversation(key, current.anchor, current.turns));
        current = { anchor: c, turns: [] };
      } else {
        // continuation → 追加到当前对话；孤儿续轮（理论上不会出现）当作 anchor 处理。
        // continuation → append; orphan continuation (shouldn't happen) treated as anchor.
        if (!current) current = { anchor: c, turns: [] };
        else current.turns.push(c);
      }
    }
    if (current) conversations.push(getOrCreateConversation(key, current.anchor, current.turns));

    // 4. 对话按 endTime 降序（最近对话排最上）。
    // 4. Conversations newest-first by endTime.
    conversations.sort((a, b) => b.endTime - a.endTime);

    // 5. Utility 桶按 mtime 升序。
    // 5. Utility bucket oldest-first.
    const sortedUtility = [...utility].sort((a, b) => a.mtime - b.mtime);

    let newest = 0;
    for (const c of captures) if (c.mtime > newest) newest = c.mtime;

    sessions.push(
      getOrCreateSession(key, conversations, sortedUtility, newest, captures.length)
    );
  }

  // session 间按最新 mtime 降序，让最近的 session 排最上面。
  // Sessions newest-first so the most recent is on top.
  sessions.sort((a, b) => b.newestMtime - a.newestMtime);
  return sessions;
}
```

- [ ] **Step 3: Replace `flattenVisible` with the 3-level walker**

Replace the existing `flattenVisible` function (lines 65-83) with:

```ts
// 把树展平成可见行数组：跳过被折叠 session / conversation / utility 桶的子节点。
// 每个子节点通过对应缓存拿到稳定引用，保住下游 memo。
// Flatten the tree into visible rows: skip children of collapsed session / conversation /
// utility bucket. Each child is resolved through its cache to preserve identity.
export function flattenVisible(tree: TreeNode[], collapsedKeys: Set<string>): TreeNode[] {
  const out: TreeNode[] = [];
  for (const node of tree) {
    out.push(node);
    if (node.type !== "session") continue;
    if (collapsedKeys.has(node.key)) continue;

    // 对话（最新在前）。
    // Conversations (newest-first).
    for (const conv of node.conversations) {
      out.push(conv);
      if (collapsedKeys.has(conv.key)) continue;
      // 续轮叶子（最旧在前）。
      // Turn leaves (oldest-first).
      for (const turn of conv.turns) {
        out.push(getOrCreateLeaf(turn, 2));
      }
    }

    // Utility 桶（仅当非空）。
    // Utility bucket (only when non-empty).
    if (node.utilityBucket.length > 0) {
      out.push(getOrCreateUtility(node.utilityKey, node.utilityBucket));
      if (!collapsedKeys.has(node.utilityKey)) {
        for (const u of node.utilityBucket) {
          out.push(getOrCreateLeaf(u, 2));
        }
      }
    }
  }
  return out;
}
```

- [ ] **Step 4: Verify grouping with a one-shot script**

The grouping logic lives in TypeScript; the simplest verification is a build check plus a Node script that mirrors the algorithm against the live `ListItem`-shaped data.

First, typecheck + build the viewer to confirm the rewrite compiles:

Run: `cd web && npm run build`

Expected: build succeeds with no TypeScript errors. If `TreeNodeRow` in `ConversationList.tsx` reports errors accessing removed fields (e.g. `node.captures`), **stop** — Task 3 fixes the renderer, but the build must still pass. If the renderer errors block the build, temporarily stub the renderer by replacing the body of `TreeNodeRow`'s `return` with `<div ref={measureRef} style={style} />` so Task 2 can be verified in isolation; Task 3 will replace the stub.

Then write `/tmp/verify_grouping.mjs` to sanity-check the algorithm against real captures:

```js
import fs from "node:fs";
import path from "node:path";

// Mirror of classifyKind + classifyRequest (abbreviated — see Task 1 for full bodies).
function classifyKind(data) {
  const msgs = data?.request?.body?.messages;
  if (!Array.isArray(msgs)) return "anchor";
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return "anchor";
    if (Array.isArray(m.content)) {
      for (const c of content) if (c?.type === "tool_result") return "continuation";
      return "anchor";
    }
    return "anchor";
  }
  return "anchor";
}
function classifyTag(data) {
  const url = data?.request?.url ?? "";
  if (url.includes("/count_tokens")) return "utility";
  let sys = "";
  const s = data?.request?.body?.system;
  if (typeof s === "string") sys = s;
  else if (Array.isArray(s)) sys = s.map((b) => b?.text ?? "").join("\n");
  const h = sys.slice(0, 200);
  if (h.includes("You are an interactive agent")) return "main";
  if (h.includes("You are an agent for Claude Code")) return "subagent";
  if (h.includes("You are a file search specialist")) return "explore";
  if (h.includes("Generate a concise, sentence-case title")) return "utility";
  const t = Array.isArray(data?.request?.body?.tools) ? data.request.body.tools.length : 0;
  if (t >= 22) return "main";
  if (t >= 1) return "subagent";
  return "unknown";
}

const base = path.resolve(process.env.HOME, ".claude-capture/captures");
const bySession = new Map();
function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) { walk(full); continue; }
    if (!ent.name.endsWith(".json")) continue;
    try {
      const data = JSON.parse(fs.readFileSync(full, "utf8"));
      const slash = ent.name.indexOf("/");
      // captures/<session>/<file> — session is the parent dir name here
      const session = path.basename(dir);
      const item = { name: ent.name, mtime: 0, tag: classifyTag(data), kind: classifyKind(data) };
      if (!bySession.has(session)) bySession.set(session, []);
      bySession.get(session).push(item);
    } catch {}
  }
}
walk(base);

console.log("Per-session breakdown:");
for (const [session, items] of bySession) {
  const utility = items.filter((i) => i.tag === "utility");
  const conv = items.filter((i) => i.tag !== "utility").sort((a, b) => 0);
  const sortedConv = conv; // assume already time-ordered enough for a count
  const anchors = sortedConv.filter((i) => i.kind !== "continuation").length;
  const conts = sortedConv.length - anchors;
  console.log(
    `  ${session}: ${items.length} captures → ${anchors} conversations, ${conts} continuations, ${utility.length} utility`
  );
}
```

Run: `node /tmp/verify_grouping.mjs`

Expected: per-session output showing `conversations + continuations + utility = total captures`. Conversation counts should be much smaller than total capture counts (e.g. a 48-capture session becomes ~6 conversations + ~40 continuations + ~2 utility). If conversations ≈ captures, the kind detection from Task 1 is misfiring — go back and re-verify Task 1's output.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/groupSessions.ts
git commit -m "feat(web): group captures into conversations in the sidebar tree"
```

---

### Task 3: Render the 4 row types + styles

**Files:**
- Modify: `web/src/components/ConversationList.tsx` (rewrite `TreeNodeRow` to switch on all 4 node types; update default-expansion effect; add auto-expand-on-active effect)
- Modify: `web/src/styles/global.css` (add `.conversation-header`, `.utility-header`; migrate `.file-item` left-edge stripe from per-row to per-conversation-header; add turn-leaf indentation styling)

**Interfaces:**
- Consumes: the new `TreeNode` discriminated union from Task 2, with `node.type` being `"session" | "conversation" | "utility" | "leaf"`.

- [ ] **Step 1: Update the default-expansion effect to handle 3 levels**

In `web/src/components/ConversationList.tsx`, the `didInit` effect (lines 22-27) currently reads:

```tsx
  const didInit = useRef(false);
  useEffect(() => {
    if (didInit.current || tree.length === 0) return;
    didInit.current = true;
    setCollapsedKeys(new Set(tree.slice(1).map((n) => n.key)));
  }, [tree]);
```

Replace with logic that collapses all but the newest session AND, within the newest session, all but the newest conversation AND the utility bucket:

```tsx
  // 首次数据到达后：折叠除最新 session 外的所有 session；最新 session 内折叠除最新对话外的所有对话；utility 桶永远默认折叠。
  // On first data: collapse all sessions except newest; within newest, collapse all
  // conversations except the newest; utility buckets always start collapsed.
  const didInit = useRef(false);
  useEffect(() => {
    if (didInit.current || tree.length === 0) return;
    didInit.current = true;
    const collapsed = new Set<string>();
    for (let i = 1; i < tree.length; i++) {
      const n = tree[i];
      if (n.type === "session") collapsed.add(n.key);
    }
    const newest = tree[0];
    if (newest && newest.type === "session") {
      for (let i = 1; i < newest.conversations.length; i++) {
        collapsed.add(newest.conversations[i].key);
      }
      collapsed.add(newest.utilityKey);
    }
    setCollapsedKeys(collapsed);
  }, [tree]);
```

- [ ] **Step 2: Add an auto-expand-on-active effect**

Immediately after the `didInit` effect, add a new effect that expands the ancestor conversation/utility-bucket/session when `selectedName` lands inside a collapsed subtree. This replaces the implicit "user has to manually expand to find their selection" friction.

```tsx
  // 选中项落在折叠的对话 / utility 桶 / session 里时，自动展开祖先，保证选中行可见。
  // When the selected capture lives inside a collapsed conversation / utility bucket / session,
  // expand the ancestors so the selection is visible.
  useEffect(() => {
    if (!selectedName) return;
    setCollapsedKeys((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const session of tree) {
        if (session.type !== "session") continue;
        let inThisSession = false;
        for (const conv of session.conversations) {
          const hit =
            conv.anchorItem.name === selectedName ||
            conv.turns.some((t) => t.name === selectedName);
          if (hit) {
            inThisSession = true;
            if (next.has(session.key)) { next.delete(session.key); changed = true; }
            if (next.has(conv.key)) { next.delete(conv.key); changed = true; }
          }
        }
        for (const u of session.utilityBucket) {
          if (u.name === selectedName) {
            inThisSession = true;
            if (next.has(session.key)) { next.delete(session.key); changed = true; }
            if (next.has(session.utilityKey)) { next.delete(session.utilityKey); changed = true; }
          }
        }
        void inThisSession;
      }
      return changed ? next : prev;
    });
  }, [selectedName, tree]);
```

- [ ] **Step 3: Rewrite `TreeNodeRow` to handle all 4 node types**

Replace the entire `TreeNodeRow` component (lines 83-164) with a version that switches on `node.type`. The `tagInfo` helper (which mapped tag → stripe class) moves out of the leaf branch and into the conversation-header branch, since stripes now live on conversation headers, not leaves.

```tsx
interface TreeNodeRowProps {
  node: TreeNode;
  collapsed: boolean;
  selectedName: string | null;
  onToggle: (key: string) => void;
  onSelect: (name: string) => void;
  vStart: number;
  vIndex: number;
  measureRef: (el: HTMLElement | null) => void;
}

// 对话头左侧色条映射（与 Task 1 的 tag 值对应）。
// Conversation-header left-stripe class lookup (matches Task 1's tag values).
function conversationStripe(tag?: string): string {
  switch (tag) {
    case "subagent": return "tagged-sub";
    case "explore":  return "tagged-explore";
    case "utility":  return "tagged-util";
    default:         return "";
  }
}

const TreeNodeRow = memo(function TreeNodeRow({
  node,
  collapsed,
  selectedName,
  onToggle,
  onSelect,
  vStart,
  vIndex,
  measureRef,
}: TreeNodeRowProps) {
  const style: React.CSSProperties = {
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    transform: `translateY(${vStart}px)`,
    paddingLeft: `${24 + node.depth * 16}px`,
    paddingRight: "24px",
  };

  if (node.type === "session") {
    return (
      <button
        ref={measureRef as React.Ref<HTMLButtonElement>}
        type="button"
        className="session-header"
        style={style}
        onClick={() => onToggle(node.key)}
        data-index={vIndex}
      >
        <span className="caret">{collapsed ? "▸" : "▾"}</span>
        <span className="session-key">{node.name}</span>
        <span className="session-count">[{node.captureCount}]</span>
      </button>
    );
  }

  if (node.type === "conversation") {
    const stripe = conversationStripe(node.tag);
    return (
      <div
        ref={measureRef}
        className={`conversation-header${stripe ? ` ${stripe}` : ""}`}
        style={style}
        onClick={() => onToggle(node.key)}
        data-index={vIndex}
      >
        <span className="caret">{collapsed ? "▸" : "▾"}</span>
        <span className="conversation-preview">{node.anchorItem.preview}</span>
        <span className="conversation-meta">
          {node.turnCount} turn{node.turnCount === 1 ? "" : "s"} · {formatTime(node.startTime)}
        </span>
      </div>
    );
  }

  if (node.type === "utility") {
    return (
      <div
        ref={measureRef}
        className="utility-header"
        style={style}
        onClick={() => onToggle(node.key)}
        data-index={vIndex}
      >
        <span className="caret">{collapsed ? "▸" : "▾"}</span>
        <span className="utility-label">Utility calls</span>
        <span className="session-count">[{node.captures.length}]</span>
      </div>
    );
  }

  // leaf: continuation turn or utility capture
  const it = node.item;
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
});
```

Note: the leaf branch no longer carries a tag stripe — the conversation header does. The previous `tagInfo` / `tag-label` rendering (added in the prior subagent-tagging feature) is removed from the leaf branch because every continuation turn inherits its conversation's tag, and putting stripes on individual leaves would now be redundant with the header stripe.

- [ ] **Step 4: Add the conversation-header, utility-header, and turn-leaf styles**

In `web/src/styles/global.css`, locate the existing `.file-item.active::before` block (the one introduced for the subagent-tagging feature, ~lines 197-220 after recent edits) and the existing `.tag-label*` rules (~lines 253-270). The left-edge `::before` stripe system stays (it was designed to be reusable), but the tag *classes* now apply to `.conversation-header` rows instead of `.file-item` rows.

After the `.file-item .meta { ... }` block (~line 226) and before the `.badge { ... }` block, insert:

```css
/* 对话头 —— session 下方的可折叠对话单元，承载用户原始消息 + 左侧色条。*/
/* Conversation header — the collapsible conversation unit under a session. Carries the
   user's original message + the left-edge stripe. */
.conversation-header {
  padding: 10px 0;
  border-bottom: 1px solid var(--line-faint);
  cursor: pointer;
  transition: background 0.2s ease;
  position: relative;
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.conversation-header:hover {
  background: var(--panel-2);
}
.conversation-header .caret {
  color: var(--text-faint);
  font-size: 10px;
  flex-shrink: 0;
}
.conversation-header .conversation-preview {
  color: var(--text);
  font-weight: 600;
  font-size: 12.5px;
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}
.conversation-header .conversation-meta {
  color: var(--text-faint);
  font-size: 10.5px;
  font-family: var(--font-mono);
  letter-spacing: 0.02em;
  flex-shrink: 0;
}

/* 对话头的左侧色条 —— 复用 .file-item 已有的 ::before 系统。
   .conversation-header 的 ::before 规则与 .file-item::before 一致，颜色由 tagged-* 类决定。*/
/* Conversation-header left stripe — reuses the same ::before system as .file-item.
   The ::before rule mirrors .file-item::before; color comes from the tagged-* class. */
.conversation-header::before {
  content: "";
  position: absolute;
  left: 0;
  top: 8px;
  bottom: 8px;
  width: 3px;
  border-radius: 0 2px 2px 0;
  background: transparent;
}
.conversation-header.tagged-sub::before {
  background: #7a5fa8;
}
.conversation-header.tagged-explore::before {
  background: var(--sage);
}
.conversation-header.tagged-util::before {
  background: var(--text-faint);
}

/* Utility 桶头 —— 沉默样式，永远默认折叠。*/
/* Utility bucket header — muted; always starts collapsed. */
.utility-header {
  padding: 8px 0;
  border-bottom: 1px solid var(--line-faint);
  cursor: pointer;
  transition: background 0.2s ease;
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.utility-header:hover {
  background: var(--panel-2);
}
.utility-header .caret {
  color: var(--text-faint);
  font-size: 10px;
  flex-shrink: 0;
}
.utility-header .utility-label {
  color: var(--text-faint);
  font-size: 11px;
  font-style: italic;
}
```

Then remove the now-orphaned `.tag-label` / `.tag-label-sub` / `.tag-label-explore` / `.tag-label-util` rules (added in the prior feature) — the conversation header replaces them. Search for `/* 标签文字` and delete through the closing brace of `.tag-label-util`.

The `.file-item::before` / `.file-item.tagged-*::before` rules (added in the prior feature) can stay or be removed — since leaves no longer carry `tagged-*` classes, those rules become dead CSS. Remove them for cleanliness: search for `/* 左侧色条` (the comment block above `.file-item::before`) and delete through `.file-item.tagged-util::before`'s closing brace. The `.file-item.active::before` rule (the sage-bright stripe on the selected row) stays — it's still used by active leaf rows.

- [ ] **Step 5: Build and visually verify**

Run: `cd web && npm run build`

Expected: clean build, no TypeScript errors.

Then run `claude-capture` from the repo root (or `node bin/claude-capture.mjs` + `cd web && npm run dev` for hot-reload dev mode). In the browser:

1. **Conversation grouping**: expand a busy session. Expect to see conversation headers (each showing a distinct user message) instead of dozens of identical-preview rows.
2. **Turn leaves**: expand a conversation. Expect nested rows showing assistant-action summaries like `Read · src/auth.ts`, `Bash · npm test`, `"I'll examine..."` — NOT the user's original question repeated.
3. **Default expansion**: the newest session's newest conversation is expanded on first load; utility bucket is collapsed.
4. **Auto-expand on active**: click a capture inside a collapsed conversation; the conversation should expand automatically.
5. **Stripe on headers**: subagent/explore conversations carry a purple/green left-edge stripe on the header; main-agent conversations have no stripe; leaves have no stripe.
6. **Utility bucket**: at the bottom of each session that has utility captures, a single `Utility calls [N]` row appears; expanding it shows the flat list of utility captures.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/ConversationList.tsx web/src/styles/global.css
git commit -m "feat(web): render sidebar as session → conversation → turns tree"
```

---

## Self-Review Notes

**Spec coverage:**
- ✅ Section "Classification: anchor vs continuation" — Task 1, Steps 1 + 3
- ✅ Section "Preview extraction" (extractAssistantAction, field map, server wiring) — Task 1, Steps 2 + 3
- ✅ Section "Tree structure & grouping" (3-level tree, ConversationNode, utility bucket, grouping algorithm, sort order) — Task 2, Steps 2 + 3
- ✅ Section "Rendering & default expansion" (4 row types, default expansion, auto-expand-on-active, stripe migration) — Task 3, Steps 1 + 2 + 3 + 4
- ✅ Section "Edge cases" (parse-error fallback unchanged, orphan continuation, missing messages, string vs array content, subagent siblings, old captures without kind, 1-turn conversations) — handled in Task 1 Step 3 (parse-error fallback left alone), Task 2 Step 2 (orphan continuation synthesized, missing kind treated as anchor, utility filter via tag).
- ✅ Section "Testing" (one-shot scripts + visual check) — Task 1 Step 5, Task 2 Step 4, Task 3 Step 5
- ✅ Section "Files touched" — all 5 files covered: `lib/server.mjs` (T1), `web/src/types.ts` (T1), `web/src/lib/groupSessions.ts` (T2), `web/src/components/ConversationList.tsx` (T3), `web/src/styles/global.css` (T3)
- ✅ "Out of scope" items (subagent parent nesting, search/filter, diff view, addon changes) — none implemented; none claimed

**Placeholder scan:** every step contains actual code. No "TBD", "add error handling", "similar to Task N", or undescribed steps. Verification scripts are complete and runnable.

**Type consistency:**
- `classifyKind` returns `"anchor" | "continuation"` in server (Task 1 Step 1), matched by `ListItem.kind?: "anchor" | "continuation"` in `types.ts` (Task 1 Step 4), consumed by `c.kind === "continuation"` check in `buildTree` (Task 2 Step 2).
- `ConversationHeaderNode.tag` is inherited from `anchorItem.tag`; the `conversationStripe()` helper in Task 3 Step 3 switches on `"subagent" | "explore" | "utility"` matching the values produced by `classifyRequest` from the prior feature.
- `getOrCreateConversation`, `getOrCreateUtility`, `getOrCreateSession`, `getOrCreateLeaf` helper names are consistent across Task 2 Steps 2-3.
- The `TreeNode` discriminated union has exactly four cases (`"session" | "conversation" | "utility" | "leaf"`); `TreeNodeRow` in Task 3 Step 3 handles all four with `if` returns.
