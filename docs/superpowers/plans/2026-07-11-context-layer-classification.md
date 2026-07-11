# Context-Layer Classification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the session's context architecture in the sidebar by (1) nesting subagent conversations under the specific main-agent turn that spawned them, and (2) detecting context-compression boundaries with a future-proofing hook that renders a divider when compaction eventually occurs.

**Architecture:** Server-side adds two passes — `linkSubagents(items)` matches each subagent's first-user-message against `Agent` tool_use prompts to emit a `parentId`, and `detectCompressions(items)` overwrites `kind` to `"compressed"` on message-count drops. Frontend grouping pulls matched subagent conversations into a `nestedByParent` map on `SessionNode`; `flattenVisible` emits them inline after their parent turn at depth 3, and emits a `DividerNode` before any compressed turn.

**Tech Stack:** Node built-ins (`lib/server.mjs`), React + TypeScript + Vite + `@tanstack/react-virtual` (`web/`), plain CSS (`web/src/styles/global.css`). No new dependencies.

## Global Constraints

- **No new runtime dependencies.** Root `package.json` has zero runtime deps; all new logic uses Node built-ins or existing frontend deps.
- **No test framework.** Per `CLAUDE.md`. Verification is one-shot Node scripts (live in `/tmp`, not committed) and a final visual check.
- **Bilingual comments.** Match the surrounding Chinese + English style in `lib/server.mjs`, `groupSessions.ts`, and `ConversationList.tsx`.
- **ListItem object identity is load-bearing.** Server's `listCache` returns the same reference for unchanged files; `detectCompressions` mutates `kind` in-place (idempotent — same input produces same kind, so cache hits stay correct). Never spread a ListItem into a new object.
- **Node-cache identity is load-bearing.** `groupSessions.ts` reuses wrapper objects across polls when underlying refs are unchanged. The new `nestedByParent` map and `DividerNode` type must participate in the same identity-stability chain.
- **Virtualizer keys must be stable.** Derived from names, never array indices.
- **Compression detection is inert today.** The user is on a 1M-context model; no compaction fires. The logic ships now and activates when they switch models. Expect zero `"compressed"` classifications in verification.

---

### Task 1: Server-side linkage + compression detection

**Files:**
- Modify: `lib/server.mjs` (extend `classifyKind` ~line 220; add `linkSubagents` + `detectCompressions` after `classifyKind`; add `messageCount` to the item literal ~line 72; wire passes into the `/api/files` handler ~line 245)
- Modify: `web/src/types.ts` (extend `ListItem`)

**Interfaces:**
- Produces: `ListItem.parentId?: string` (the parent main-agent capture filename for matched subagents), `ListItem.kind` extended to `"anchor" | "continuation" | "compressed"`, and `ListItem.messageCount: number` (length of the messages array, used by compression detection). Task 2 consumes `parentId` and `kind: "compressed"`; Task 2 does NOT need `messageCount` (server-internal).

- [ ] **Step 1: Add `messageCount` to the item literal**

In `lib/server.mjs`, inside `listCaptures`'s successful-parse branch (~line 67-80), the item object currently reads:

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

Replace with (adds `messageCount` computed from the parsed messages array):

```js
        const data = JSON.parse(raw);
        const kind = classifyKind(data);
        const preview = kind === "continuation"
          ? extractAssistantAction(data)
          : extractLastUserText(data);
        const msgs = data?.request?.body?.messages;
        const item = {
          name: childRel,
          mtime: stat.mtimeMs,
          size: stat.size,
          status: data.response?.status_code,
          preview: preview?.slice(0, 80) ?? "(empty)",
          tag: classifyRequest(data),
          kind,
          messageCount: Array.isArray(msgs) ? msgs.length : 0,
        };
```

- [ ] **Step 2: Extend `classifyKind` with compression signals 2 and 3**

In `lib/server.mjs`, the `classifyKind` function (~line 220-237) currently returns `"anchor"` or `"continuation"`. Replace its entire body with a version that also returns `"compressed"` when signal 2 (summary-style first user message) or signal 3 (API field) fire:

```js
// 压缩指示短语 —— 出现在首条 user 消息开头时，可能是上下文压缩摘要。
// Compression-indicator phrases — when present at the start of the first user message,
// the capture is likely a post-compaction re-send.
const COMPRESSION_PHRASES = [
  "summary of",
  "previously, on",
  "conversation so far",
  "the user and assistant have been discussing",
];

function classifyKind(data) {
  const body = data?.request?.body ?? {};
  const msgs = body.messages;

  // Signal 3: API 字段 —— 未来 Anthropic 若加 is_compact / compacted_until 等字段。
  // Signal 3: API field — if Anthropic later adds is_compact / compacted_until etc.
  if (body && typeof body === "object") {
    for (const k of Object.keys(body)) {
      if (k.toLowerCase().includes("compact")) return "compressed";
    }
  }

  if (!Array.isArray(msgs)) return "anchor";

  // 找最后一条 user 消息，决定 anchor vs continuation（原逻辑保留）。
  // Find the last user message to decide anchor vs continuation (original logic).
  let lastUserIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "user") { lastUserIdx = i; break; }
  }
  if (lastUserIdx === -1) return "anchor";
  const lastUser = msgs[lastUserIdx];
  const lastContent = lastUser.content;
  let lastIsAnchor = false;
  if (typeof lastContent === "string") lastIsAnchor = true;
  else if (Array.isArray(lastContent)) {
    let hasToolResult = false;
    for (const c of lastContent) {
      if (c && typeof c === "object" && c.type === "tool_result") { hasToolResult = true; break; }
    }
    lastIsAnchor = !hasToolResult;
  } else {
    lastIsAnchor = true;
  }

  // Signal 2: 首条 user 消息像压缩摘要 —— 仅当最后一条 user 是 anchor（文本）时才检查。
  // Signal 2: first user message looks like a compaction summary — only check when
  // the last user message is text (anchor-shaped), so we don't misclassify tool flows.
  if (lastIsAnchor) {
    const firstUser = msgs.find((m) => m.role === "user");
    if (firstUser) {
      let firstText = "";
      const fc = firstUser.content;
      if (typeof fc === "string") firstText = fc;
      else if (Array.isArray(fc)) {
        for (const c of fc) {
          if (c && typeof c === "object" && c.type === "text" && typeof c.text === "string") {
            firstText = c.text;
            break;
          }
        }
      }
      const head = firstText.slice(0, 300).toLowerCase();
      for (const phrase of COMPRESSION_PHRASES) {
        if (head.includes(phrase)) return "compressed";
      }
    }
  }

  return lastIsAnchor ? "anchor" : "continuation";
}
```

Place the `COMPRESSION_PHRASES` const immediately above the `classifyKind` function (replacing the old function header comment). The old function body is fully replaced.

- [ ] **Step 3: Add `detectCompressions(items)` after `classifyKind`**

Immediately after `classifyKind`'s closing brace (~line 260 after the Step 2 edit), insert:

```js
// Signal 1: 主代理 capture 序列里 messageCount 骤降 → 标记为 compressed。
// 需要 cross-capture 状态，所以作为 listCaptures 之后的独立 pass 运行。
// 直接在已缓存的 ListItem 上原地改 kind —— 幂等，下次 poll 缓存命中仍正确。
// Signal 1: a sharp drop in messageCount across the main-agent capture sequence →
// mark as compressed. Needs cross-capture state, so it runs as a separate pass after
// listCaptures. Mutates the already-cached ListItem.kind in-place — idempotent, so
// subsequent poll cache hits remain correct.
function detectCompressions(items) {
  // 按 session 分组。
  // Group by session.
  const bySession = new Map();
  for (const it of items) {
    const slashIdx = it.name.indexOf("/");
    const session = slashIdx === -1 ? "ungrouped" : it.name.slice(0, slashIdx);
    if (!bySession.has(session)) bySession.set(session, []);
    bySession.get(session).push(it);
  }

  for (const [, sessionItems] of bySession) {
    // 只要 main-agent 的 anchor（compressed 还没被标记，所以这里是 anchor）。
    // Only main-agent anchors (compressed isn't set yet, so these are still anchor).
    const mainAnchors = sessionItems
      .filter((it) => it.tag === "main" && it.kind === "anchor")
      .sort((a, b) => a.mtime - b.mtime);
    for (let i = 1; i < mainAnchors.length; i++) {
      const prev = mainAnchors[i - 1];
      const curr = mainAnchors[i];
      const drop = prev.messageCount - curr.messageCount;
      const threshold = Math.max(prev.messageCount * 0.2, 10);
      if (drop > threshold) {
        curr.kind = "compressed";
      }
    }
  }
}
```

- [ ] **Step 4: Add `linkSubagents(items)` after `detectCompressions`**

Immediately after `detectCompressions`'s closing brace, insert:

```js
// 把每个子代理 / Explore 对话锚点，连到派生它的那条主代理 capture。
// 主代理 capture 的「最后一条 assistant 消息」里的 Agent/Task tool_use 带 prompt 字段；
// 子代理首条 user 消息包含这段 prompt 作为子串。匹配上就写 parentId。
// Link each subagent / explore conversation anchor to the main-agent capture that
// dispatched it. The main-agent capture's LAST assistant turn contains an Agent/Task
// tool_use with a prompt field; the subagent's first user message includes that prompt
// as a substring. On match, write parentId.
function linkSubagents(items) {
  // 按 session 分组。
  // Group by session.
  const bySession = new Map();
  for (const it of items) {
    const slashIdx = it.name.indexOf("/");
    const session = slashIdx === -1 ? "ungrouped" : it.name.slice(0, slashIdx);
    if (!bySession.has(session)) bySession.set(session, []);
    bySession.get(session).push(it);
  }

  for (const [, sessionItems] of bySession) {
    // 1. 从主代理 capture 收集派生指纹（只看最后一条 assistant 消息，自然去重）。
    // 1. Collect dispatch fingerprints from main-agent captures (last assistant msg only — dedupes naturally).
    const fingerprints = [];
    for (const it of sessionItems) {
      if (it.tag !== "main") continue;
      const msgs = it.__messages; // see note below — attached during listCaptures
      if (!Array.isArray(msgs)) continue;
      // 找最后一条 assistant。
      // Find the last assistant message.
      let lastAssistant = null;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === "assistant") { lastAssistant = msgs[i]; break; }
      }
      if (!lastAssistant) continue;
      const content = Array.isArray(lastAssistant.content) ? lastAssistant.content : [];
      for (const b of content) {
        if (!b || typeof b !== "object") continue;
        if (b.type !== "tool_use") continue;
        if (b.name !== "Agent" && b.name !== "Task") continue;
        const prompt = (b.input && typeof b.input === "object" && typeof b.input.prompt === "string") ? b.input.prompt : "";
        if (prompt.length < 20) continue; // too short to be a reliable signal
        fingerprints.push({
          parentCapture: it.name,
          promptHead: prompt.slice(0, 100),
          dispatchedAt: it.mtime,
        });
      }
    }

    // 2. 把每个子代理锚点的首条 user 文本和指纹做子串匹配。
    // 2. Match each subagent anchor's first-user-text against fingerprints via substring.
    for (const it of sessionItems) {
      if (it.tag !== "subagent" && it.tag !== "explore") continue;
      if (it.kind !== "anchor") continue; // only anchors are conversation starts
      const msgs = it.__messages;
      if (!Array.isArray(msgs)) continue;
      const firstUser = msgs.find((m) => m.role === "user");
      if (!firstUser) continue;
      let firstText = "";
      const fc = firstUser.content;
      if (typeof fc === "string") firstText = fc;
      else if (Array.isArray(fc)) {
        for (const c of fc) {
          if (c && typeof c === "object" && c.type === "text" && typeof c.text === "string") {
            firstText = c.text;
            break;
          }
        }
      }
      if (!firstText) continue;

      // 找匹配的指纹：子串命中 + 时间在子代理之前。取最近的。
      // Find matching fingerprint: substring hit + dispatched before the subagent. Pick nearest.
      let best = null;
      let bestDelta = Infinity;
      for (const fp of fingerprints) {
        if (firstText.includes(fp.promptHead) && fp.dispatchedAt <= it.mtime) {
          const delta = it.mtime - fp.dispatchedAt;
          if (delta < bestDelta) { best = fp; bestDelta = delta; }
        }
      }
      if (best) it.parentId = best.parentCapture;
    }
  }
}
```

**Important — `__messages` field.** The linkage needs access to each capture's parsed `messages` array, but `ListItem` doesn't carry it (too heavy for the wire). The cleanest path: in `listCaptures` (Step 5 below), attach the parsed messages to the item as a non-enumerable-or-just-extra field `__messages` that stays on the server and gets stripped before the response. Since `JSON.stringify` (used by `json()` helper at line 290) serializes own enumerable properties, we must delete `__messages` before returning. Step 5 wires this.

- [ ] **Step 5: Wire `__messages`, `detectCompressions`, and `linkSubagents` into `listCaptures` + `/api/files`**

In `lib/server.mjs` `listCaptures`, the successful-parse branch (after Step 1's edit) currently builds the item literal. Add `__messages` to the item so the post-passes can read it:

```js
        const item = {
          name: childRel,
          mtime: stat.mtimeMs,
          size: stat.size,
          status: data.response?.status_code,
          preview: preview?.slice(0, 80) ?? "(empty)",
          tag: classifyRequest(data),
          kind,
          messageCount: Array.isArray(msgs) ? msgs.length : 0,
          __messages: msgs, // server-internal; stripped before /api/files response
        };
```

Then in the `/api/files` handler (~line 244-247), which currently reads:

```js
      if (url.pathname === "/api/files") {
        const items = await listCaptures(capturesDir);
        return json(res, items);
      }
```

Replace with:

```js
      if (url.pathname === "/api/files") {
        const items = await listCaptures(capturesDir);
        detectCompressions(items);
        linkSubagents(items);
        // 剥离服务端内部字段，避免泄漏到前端响应。
        // Strip server-internal fields so they don't leak into the response.
        for (const it of items) {
          if (it.__messages) delete it.__messages;
        }
        return json(res, items);
      }
```

Note: `detectCompressions` runs BEFORE `linkSubagents` so that compression-overwritten `kind` values are visible when `linkSubagents` checks `it.kind !== "anchor"` to decide which subagent captures are conversation starts (a compressed capture shouldn't be treated as a subagent conversation anchor). Order matters.

- [ ] **Step 6: Extend the `ListItem` type**

In `web/src/types.ts`, the `ListItem` interface currently reads:

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

Replace with:

```ts
export interface ListItem {
  name: string;
  mtime: number;
  size: number;
  status?: number;
  preview: string;
  tag?: string; // "main" | "subagent" | "explore" | "utility" | "unknown"
  kind?: "anchor" | "continuation" | "compressed";
  parentId?: string; // main-agent capture filename that dispatched this subagent; absent = top-level
  messageCount?: number; // server-internal, used for compression detection; not rendered
}
```

- [ ] **Step 7: Verify linkage + compression with a one-shot script**

Write `/tmp/verify_linkage.mjs`:

```js
import fs from "node:fs";
import path from "node:path";

const base = path.resolve(process.env.HOME, ".claude-capture/captures");

// Re-implement the server-side logic against raw captures on disk.
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
  return "unknown";
}

function classifyKind(data) {
  const body = data?.request?.body ?? {};
  if (body && typeof body === "object") {
    for (const k of Object.keys(body)) if (k.toLowerCase().includes("compact")) return "compressed";
  }
  const msgs = body.messages;
  if (!Array.isArray(msgs)) return "anchor";
  let lastUserIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === "user") { lastUserIdx = i; break; }
  if (lastUserIdx === -1) return "anchor";
  const lu = msgs[lastUserIdx];
  let lastIsAnchor = false;
  if (typeof lu.content === "string") lastIsAnchor = true;
  else if (Array.isArray(lu.content)) {
    let hr = false;
    for (const c of lu.content) if (c?.type === "tool_result") { hr = true; break; }
    lastIsAnchor = !hr;
  } else lastIsAnchor = true;
  return lastIsAnchor ? "anchor" : "continuation";
}

// Walk captures, build items with __messages attached
const bySession = new Map();
function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) { walk(full); continue; }
    if (!ent.name.endsWith(".json")) continue;
    try {
      const data = JSON.parse(fs.readFileSync(full, "utf8"));
      const session = path.basename(dir);
      const item = {
        name: `${session}/${ent.name}`,
        mtime: fs.statSync(full).mtimeMs,
        tag: classifyTag(data),
        kind: classifyKind(data),
        messageCount: data?.request?.body?.messages?.length ?? 0,
        __messages: data?.request?.body?.messages ?? [],
      };
      if (!bySession.has(session)) bySession.set(session, []);
      bySession.get(session).push(item);
    } catch {}
  }
}
walk(base);

// detectCompressions
for (const [, items] of bySession) {
  const mainAnchors = items.filter((i) => i.tag === "main" && i.kind === "anchor").sort((a, b) => a.mtime - b.mtime);
  for (let i = 1; i < mainAnchors.length; i++) {
    const drop = mainAnchors[i - 1].messageCount - mainAnchors[i].messageCount;
    const threshold = Math.max(mainAnchors[i - 1].messageCount * 0.2, 10);
    if (drop > threshold) mainAnchors[i].kind = "compressed";
  }
}

// linkSubagents
let linked = 0, unlinked = 0, compressed = 0;
for (const [, items] of bySession) {
  const fingerprints = [];
  for (const it of items) {
    if (it.tag !== "main") continue;
    const msgs = it.__messages;
    if (!Array.isArray(msgs)) continue;
    let lastA = null;
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === "assistant") { lastA = msgs[i]; break; }
    if (!lastA) continue;
    const content = Array.isArray(lastA.content) ? lastA.content : [];
    for (const b of content) {
      if (b?.type !== "tool_use" || (b.name !== "Agent" && b.name !== "Task")) continue;
      const prompt = b.input?.prompt;
      if (typeof prompt !== "string" || prompt.length < 20) continue;
      fingerprints.push({ parentCapture: it.name, promptHead: prompt.slice(0, 100), dispatchedAt: it.mtime });
    }
  }
  for (const it of items) {
    if ((it.tag !== "subagent" && it.tag !== "explore") || it.kind !== "anchor") continue;
    const firstUser = it.__messages.find((m) => m.role === "user");
    if (!firstUser) continue;
    let firstText = "";
    const fc = firstUser.content;
    if (typeof fc === "string") firstText = fc;
    else if (Array.isArray(fc)) for (const c of fc) if (c?.type === "text" && typeof c.text === "string") { firstText = c.text; break; }
    let best = null, bestDelta = Infinity;
    for (const fp of fingerprints) {
      if (firstText.includes(fp.promptHead) && fp.dispatchedAt <= it.mtime) {
        const d = it.mtime - fp.dispatchedAt;
        if (d < bestDelta) { best = fp; bestDelta = d; }
      }
    }
    if (best) { it.parentId = best.parentCapture; linked++; }
    else unlinked++;
  }
  compressed += items.filter((i) => i.kind === "compressed").length;
}

console.log(`Subagent linkage: ${linked} linked, ${unlinked} unlinked (stay top-level siblings)`);
console.log(`Compression detections: ${compressed} (expected 0 today)`);
```

Run: `node /tmp/verify_linkage.mjs`

Expected: a majority of subagent/explore anchors link successfully (the exact ratio depends on the corpus, but linked should be significantly higher than unlinked — e.g. 500+ linked, <50 unlinked). Compression detections should be **0** (today, on the 1M model, no compaction fires). If compression > 0, investigate — signal 2's phrase matching may be over-broad; tighten the phrase list.

- [ ] **Step 8: Commit**

```bash
git add lib/server.mjs web/src/types.ts
git commit -m "feat(server): link subagents to parent turn + detect compression boundaries"
```

---

### Task 2: Nested subagent grouping + divider nodes

**Files:**
- Modify: `web/src/lib/groupSessions.ts` (add `DividerNode` type, `nestedByParent` on SessionNode, update `buildTree` walk condition + nesting extraction, update `flattenVisible` to emit nested + dividers, update caches)

**Interfaces:**
- Consumes: `ListItem.parentId` and `ListItem.kind === "compressed"` from Task 1.
- Produces: `SessionNode.nestedByParent: Map<string, ConversationHeaderNode[]>`, new `DividerNode` in the `TreeNode` union, updated `buildTree` and `flattenVisible` signatures (unchanged from outside — same `(items) => TreeNode[]` and `(tree, collapsedKeys) => TreeNode[]`).

- [ ] **Step 1: Add `DividerNode` to the type union and `nestedByParent` to `SessionNode`**

In `web/src/lib/groupSessions.ts`, extend `SessionNode` (currently lines 8-18) by adding the `nestedByParent` field:

```ts
export interface SessionNode {
  type: "session";
  depth: number;            // 0
  key: string;              // session key (directory prefix)
  name: string;             // session dirname
  conversations: ConversationHeaderNode[]; // top-level conversations, newest-first by endTime
  nestedByParent: Map<string, ConversationHeaderNode[]>; // parent capture name → nested subagent conversations
  utilityBucket: ListItem[];               // utility-tagged captures, oldest-first
  utilityKey: string;       // `${key}#utility` — collapse key for the utility bucket
  newestMtime: number;      // for cross-session sort
  captureCount: number;     // conversations + nested + utility, for the header badge
}
```

Add `DividerNode` after `LeafNode` (currently lines 39-45) and before the `TreeNode` union:

```ts
export interface DividerNode {
  type: "divider";
  depth: number;            // matches the turn-leaf depth where the divider sits (2 for main thread)
  key: string;              // `${captureName}#divider`
  label: string;            // "context compressed"
}

export type TreeNode = SessionNode | ConversationHeaderNode | UtilityBucketNode | LeafNode | DividerNode;
```

- [ ] **Step 2: Add a divider cache and update `getOrCreateSession` signature**

Add a module-level divider cache alongside the others (~line 58):

```ts
const dividerCache = new Map<string, DividerNode>();
```

Add a `getOrCreateDivider` helper after `getOrCreateUtility`:

```ts
function getOrCreateDivider(captureName: string, depth: number, label: string): DividerNode {
  const key = `${captureName}#divider`;
  const cached = dividerCache.get(key);
  if (cached && cached.depth === depth && cached.label === label) return cached;
  const divider: DividerNode = { type: "divider", depth, key, label };
  dividerCache.set(key, divider);
  return divider;
}
```

Update `getOrCreateSession` (currently lines 115-144) to accept and compare `nestedByParent`. Replace its signature and body:

```ts
function getOrCreateSession(
  key: string,
  conversations: ConversationHeaderNode[],
  nestedByParent: Map<string, ConversationHeaderNode[]>,
  utilityBucket: ListItem[],
  newestMtime: number,
  captureCount: number
): SessionNode {
  const cached = sessionCache.get(key);
  if (
    cached &&
    itemsEqualSessions(cached.conversations, conversations) &&
    nestedMapsEqual(cached.nestedByParent, nestedByParent) &&
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
    nestedByParent,
    utilityBucket,
    utilityKey: `${key}#utility`,
    newestMtime,
    captureCount,
  };
  sessionCache.set(key, session);
  return session;
}

// nestedMapsEqual: 比较 nestedByParent 两个 Map —— 键相同 + 每个键下的对话数组引用一致。
// nestedMapsEqual: compare two nestedByParent Maps — same keys + reference-identical conversation arrays.
function nestedMapsEqual(
  a: Map<string, ConversationHeaderNode[]>,
  b: Map<string, ConversationHeaderNode[]>
): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const bv = b.get(k);
    if (!bv || !itemsEqualSessions(v, bv)) return false;
  }
  return true;
}
```

- [ ] **Step 3: Update `buildTree` — change walk condition + extract nested conversations**

In `web/src/lib/groupSessions.ts`, replace the body of `buildTree` (currently lines 160-221). The three changes vs. the current body: (a) the walk's continuation condition changes from `c.kind === "continuation"` to `c.kind !== "anchor"`; (b) after building all conversations, pull subagent conversations whose anchor has `parentId` into `nestedByParent`; (c) pass `nestedByParent` to `getOrCreateSession`.

```ts
export function buildTree(items: ListItem[]): TreeNode[] {
  // 1. 按 session key 分桶。
  // 1. Bucket by session key.
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
    // 2. 分离 utility。
    // 2. Pull utility aside.
    const conversational = captures.filter((c) => c.tag !== "utility");
    const utility = captures.filter((c) => c.tag === "utility");

    // 3. 对话用 capture 按 mtime 升序。
    // 3. Conversational captures oldest-first.
    const sorted = [...conversational].sort((a, b) => a.mtime - b.mtime);

    // 4. 走 anchor/continuation/compressed 分组。
    //    关键：continuation 和 compressed 都追加到当前对话；只有 anchor 开新对话。
    // 4. Walk anchor/continuation/compressed grouping.
    //    Key: both continuation and compressed append to the current conversation;
    //    only anchor starts a new conversation.
    const allConversations: ConversationHeaderNode[] = [];
    let current: { anchor: ListItem; turns: ListItem[] } | null = null;
    for (const c of sorted) {
      const isAnchor = c.kind === "anchor" || c.kind === undefined;
      if (isAnchor) {
        if (current) allConversations.push(getOrCreateConversation(key, current.anchor, current.turns));
        current = { anchor: c, turns: [] };
      } else {
        // continuation OR compressed → 都追加到当前对话。
        // continuation OR compressed → both append to the current conversation.
        if (!current) current = { anchor: c, turns: [] };
        else current.turns.push(c);
      }
    }
    if (current) allConversations.push(getOrCreateConversation(key, current.anchor, current.turns));

    // 5. 把带 parentId 的子代理对话从顶层挪到 nestedByParent。
    // 5. Move subagent conversations whose anchor has parentId out of top-level into nestedByParent.
    const nestedByParent = new Map<string, ConversationHeaderNode[]>();
    const topLevel: ConversationHeaderNode[] = [];
    for (const conv of allConversations) {
      const parentId = conv.anchorItem.parentId;
      if (parentId) {
        const arr = nestedByParent.get(parentId);
        if (arr) arr.push(conv);
        else nestedByParent.set(parentId, [conv]);
      } else {
        topLevel.push(conv);
      }
    }

    // 6. 顶层对话按 endTime 降序；nestedByParent 内每个键下也按 endTime 降序。
    // 6. Top-level conversations newest-first by endTime; each nestedByParent bucket too.
    topLevel.sort((a, b) => b.endTime - a.endTime);
    for (const arr of nestedByParent.values()) {
      arr.sort((a, b) => a.startTime - b.startTime); // nested: oldest-first (dispatch order)
    }

    // 7. Utility 桶按 mtime 升序。
    // 7. Utility bucket oldest-first.
    const sortedUtility = [...utility].sort((a, b) => a.mtime - b.mtime);

    let newest = 0;
    for (const c of captures) if (c.mtime > newest) newest = c.mtime;

    sessions.push(
      getOrCreateSession(key, topLevel, nestedByParent, sortedUtility, newest, captures.length)
    );
  }

  sessions.sort((a, b) => b.newestMtime - a.newestMtime);
  return sessions;
}
```

Note the ordering choice for nested conversations: oldest-first within a parent (dispatch order), so if a single main-agent turn dispatches 3 parallel subagents, they appear in the order they were spawned.

- [ ] **Step 4: Update `flattenVisible` — emit nested + dividers**

Replace the entire `flattenVisible` function (currently lines 227-258):

```ts
export function flattenVisible(tree: TreeNode[], collapsedKeys: Set<string>): TreeNode[] {
  const out: TreeNode[] = [];
  for (const node of tree) {
    out.push(node);
    if (node.type !== "session") continue;
    if (collapsedKeys.has(node.key)) continue;

    // 顶层对话（最新在前）。
    // Top-level conversations (newest-first).
    for (const conv of node.conversations) {
      out.push(conv);
      if (collapsedKeys.has(conv.key)) continue;
      emitTurns(out, conv, node.nestedByParent, collapsedKeys);
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

// emitTurns: 把一个对话的 turns 展开成 leaf 行；在 compressed turn 前插 divider；
// 在派生了子代理的 turn 后插嵌套子代理对话。
// emitTurns: expand a conversation's turns into leaf rows; insert a divider before
// compressed turns; insert nested subagent conversations after a turn that spawned them.
function emitTurns(
  out: TreeNode[],
  conv: ConversationHeaderNode,
  nestedByParent: Map<string, ConversationHeaderNode[]>,
  collapsedKeys: Set<string>
): void {
  const convDepth = conv.depth;
  const leafDepth = convDepth + 1;
  for (const turn of conv.turns) {
    // compressed turn 前插一条 divider（深度与 leaf 一致）。
    // Insert a divider before a compressed turn (same depth as the leaf).
    if (turn.kind === "compressed") {
      out.push(getOrCreateDivider(turn.name, leafDepth, "context compressed"));
    }
    out.push(getOrCreateLeaf(turn, leafDepth));

    // 该 turn 派生了子代理？插嵌套对话（默认折叠）。
    // Did this turn spawn subagents? Insert nested conversations (collapsed by default).
    const nested = nestedByParent.get(turn.name);
    if (nested) {
      for (const subConv of nested) {
        out.push(subConv);
        if (collapsedKeys.has(subConv.key)) continue;
        // 嵌套对话的 turns 深度 +1。
        // Nested conversation's turns are one depth deeper.
        emitTurns(out, subConv, nestedByParent, collapsedKeys);
      }
    }
  }
}
```

The recursion in `emitTurns` naturally handles subagent-of-subagent nesting (a subagent that dispatches its own subagent). The depth propagates via `convDepth + 1`.

**Wait — nested conversation headers themselves need a depth.** The current `ConversationHeaderNode` has `depth: 1` hardcoded in `getOrCreateConversation`. For nested subagent conversations, depth must be `parentLeafDepth + 1 = 3` (or deeper for recursion). Update `getOrCreateConversation` to accept a `depth` parameter.

Update `getOrCreateConversation` (currently lines 75-98) signature and body:

```ts
function getOrCreateConversation(
  sessionKey: string,
  anchor: ListItem,
  turns: ListItem[],
  depth: number
): ConversationHeaderNode {
  const key = `${sessionKey}#${anchor.name}`;
  const cached = conversationCache.get(key);
  if (cached && cached.anchorItem === anchor && itemsEqual(cached.turns, turns) && cached.depth === depth) {
    return cached;
  }
  const conv: ConversationHeaderNode = {
    type: "conversation",
    depth,
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
```

And update the two call sites in `buildTree` (Step 3 above) to pass `depth: 1` for top-level conversations. The nested ones are created with the same `getOrCreateConversation` call at depth 1 first, then... wait, that's a problem. The nested conversations are built in the same walk as top-level ones, before we know they're nested. They get depth 1, then we pull them into `nestedByParent`. Their depth is wrong.

**Fix:** After pulling into `nestedByParent`, rebuild nested conversations at the correct depth. But that thrashes the cache. Alternative: make depth a render-time concern — compute it during `flattenVisible` from the parent's depth, not stored on the node.

Actually, the cleanest fix: don't store `depth` on conversation headers at all for nesting purposes. Instead, have `emitTurns` pass the right depth when emitting leaves and nested headers. The `depth` on `ConversationHeaderNode` is only used for the `paddingLeft` calculation in the renderer. We can set it during emission.

Hmm, but the node object is cached and shared. If we mutate `depth` during emission, we break the cache identity.

**Cleanest resolution:** Remove `depth` from `ConversationHeaderNode` entirely; instead, have `flattenVisible` wrap each node with an emission-depth. But that's a big refactor of the existing structure.

**Pragmatic resolution:** Since nested conversations are always at depth `parentLeafDepth + 1`, and `parentLeafDepth = parentConvDepth + 1`, we get `nestedDepth = parentConvDepth + 2`. For top-level conversations, depth is 1; leaves are 2; nested headers are 3; nested leaves are 4. Compute this in `emitTurns` and pass it through.

Update the approach: `getOrCreateConversation` takes a `depth` parameter. When `buildTree` creates conversations in the walk, it doesn't yet know whether each will be top-level or nested. **So build them all at depth 1 first, then after the nested-extraction step, recreate the nested ones at the correct depth (3).** The cache will store both the depth-1 version (which gets discarded since nothing references it) and the depth-3 version. Actually the cache key is `${sessionKey}#${anchor.name}` — depth-independent. So the second `getOrCreateConversation` call at depth 3 will overwrite the cache entry. That's fine — the depth-1 version is no longer referenced.

But wait, this means the conversation object that lands in `nestedByParent` is the depth-3 one (good), and the topLevel array never contained it (it was pulled out). So:

After Step 5's nested-extraction loop, add a rebuild pass for depth:

```ts
// 重建嵌套对话到正确深度（depth 3 = parent leaf depth 2 + 1）。
// Rebuild nested conversations at the correct depth (depth 3 = parent leaf depth 2 + 1).
const NESTED_DEPTH = 3;
const fixedNestedByParent = new Map<string, ConversationHeaderNode[]>();
for (const [parentId, arr] of nestedByParent) {
  const fixed = arr.map((conv) =>
    getOrCreateConversation(key, conv.anchorItem, conv.turns, NESTED_DEPTH)
  );
  fixedNestedByParent.set(parentId, fixed);
}
```

And topLevel conversations are created at depth 1 (their original creation depth). But in Step 3's walk, we called `getOrCreateConversation(key, ...)` without a depth — now it requires one. Update both call sites in the walk to pass `depth: 1`:

```ts
      if (isAnchor) {
        if (current) allConversations.push(getOrCreateConversation(key, current.anchor, current.turns, 1));
        current = { anchor: c, turns: [] };
      }
```

And:

```ts
    if (current) allConversations.push(getOrCreateConversation(key, current.anchor, current.turns, 1));
```

This is getting intricate. Let me write it cleanly into the plan as a single coherent Step 3 replacement that handles depth correctly from the start. I'll consolidate: the walk creates conversations at depth 1; after extraction, nested ones are rebuilt at depth 3.

- [ ] **Step 5: Verify build + grouping with one-shot script**

The grouping logic is TypeScript; verify the build compiles. Run: `cd web && npm run build`.

If `ConversationList.tsx` (Task 3) reports type errors against the new `TreeNode` union (the renderer hasn't learned about `DividerNode` yet), apply the same stub strategy as the prior feature: temporarily stub `TreeNodeRow`'s body to `<div ref={measureRef} style={style} />` so Task 2's grouping can be verified in isolation. **Note this in the report if applied.** Task 3 replaces the stub.

Then run a grouping-sanity check via the Task 1 verification script's linked count: a session with N linked subagent conversations should show N fewer top-level conversations than before (they moved into `nestedByParent`).

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/groupSessions.ts
git commit -m "feat(web): nest subagent conversations under parent turn + emit compression dividers"
```

---

### Task 3: Render divider + extend auto-expand ancestry

**Files:**
- Modify: `web/src/components/ConversationList.tsx` (add `DividerNode` render branch; extend auto-expand effect to walk `nestedByParent`)
- Modify: `web/src/styles/global.css` (add `.divider` styles)

**Interfaces:**
- Consumes: the `DividerNode` from Task 2's union and `SessionNode.nestedByParent` from Task 2.

- [ ] **Step 1: Add the divider render branch to `TreeNodeRow`**

In `web/src/components/ConversationList.tsx`, inside `TreeNodeRow` (the memoized component that switches on `node.type`), add a divider branch. The divider is non-interactive — no caret, no click, no hover. Insert this branch before the leaf fallthrough:

```tsx
  if (node.type === "divider") {
    return (
      <div
        ref={measureRef}
        className="sidebar-divider"
        style={style}
        data-index={vIndex}
      >
        <span className="divider-line" />
        <span className="divider-label">{node.label}</span>
        <span className="divider-line" />
      </div>
    );
  }
```

The `style` object (computed at the top of `TreeNodeRow`) applies the standard absolute-positioning + `paddingLeft` transform, so the divider sits at the right depth.

- [ ] **Step 2: Extend the auto-expand-on-active effect to walk `nestedByParent`**

The current effect (~lines 45-74) walks `session.conversations` and `session.utilityBucket` looking for `selectedName`. It must also walk `session.nestedByParent` so that selecting a turn inside a nested subagent expands the nested conversation AND its parent main-agent conversation.

Replace the effect body with:

```tsx
  useEffect(() => {
    if (!selectedName) return;
    setCollapsedKeys((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const session of tree) {
        if (session.type !== "session") continue;
        // 收集本 session 里所有需要展开的 key（session / 顶层对话 / 嵌套对话 / utility）。
        // Collect every key in this session that needs expanding.
        const keysToOpen = new Set<string>();
        // 顶层对话 + 嵌套对话。
        // Top-level + nested conversations.
        for (const conv of session.conversations) {
          const hitTop =
            conv.anchorItem.name === selectedName ||
            conv.turns.some((t) => t.name === selectedName);
          if (hitTop) {
            keysToOpen.add(session.key);
            keysToOpen.add(conv.key);
          }
        }
        // 嵌套子代理对话：选中落在嵌套对话里 → 同时展开父 turn 所属的顶层对话。
        // Nested subagent conversations: a hit inside a nested one also expands
        // the parent top-level conversation that contains the spawning turn.
        for (const [, nestedArr] of session.nestedByParent) {
          for (const subConv of nestedArr) {
            const hit =
              subConv.anchorItem.name === selectedName ||
              subConv.turns.some((t) => t.name === selectedName);
            if (hit) {
              keysToOpen.add(session.key);
              keysToOpen.add(subConv.key);
              // 找到派生这个嵌套对话的父 turn 属于哪个顶层对话。
              // Find which top-level conversation contains the parent turn.
              const parentCapture = subConv.anchorItem.parentId;
              if (parentCapture) {
                for (const topConv of session.conversations) {
                  if (
                    topConv.anchorItem.name === parentCapture ||
                    topConv.turns.some((t) => t.name === parentCapture)
                  ) {
                    keysToOpen.add(topConv.key);
                    break;
                  }
                }
              }
            }
          }
        }
        // Utility 桶。
        // Utility bucket.
        for (const u of session.utilityBucket) {
          if (u.name === selectedName) {
            keysToOpen.add(session.key);
            keysToOpen.add(session.utilityKey);
          }
        }
        for (const k of keysToOpen) {
          if (next.has(k)) { next.delete(k); changed = true; }
        }
      }
      return changed ? next : prev;
    });
  }, [selectedName, tree]);
```

- [ ] **Step 3: Add `.sidebar-divider` styles**

In `web/src/styles/global.css`, after the `.utility-header .utility-label { ... }` block (the last sidebar-related style before `.badge`), insert:

```css
/* 压缩边界分隔条 —— 非交互的视觉缝隙，仅出现在 compressed turn 之前。*/
/* Compression-boundary divider — a non-interactive visual seam that appears only
   before a compressed turn. */
.sidebar-divider {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  color: var(--text-faint);
  font-size: 10px;
  font-family: var(--font-mono);
  font-style: italic;
  letter-spacing: 0.04em;
  pointer-events: none; /* 非交互 —— 不阻挡下层点击 / non-interactive — doesn't block clicks */
}
.sidebar-divider .divider-line {
  flex: 1;
  height: 1px;
  background: var(--line-faint);
}
.sidebar-divider .divider-label {
  flex-shrink: 0;
  text-transform: lowercase;
}
```

- [ ] **Step 4: Build + visually verify**

Run: `cd web && npm run build`. Expected: clean build, no TypeScript errors.

Then run `claude-capture` (or `node bin/claude-capture.mjs` + `cd web && npm run dev`). In the browser:

1. **Nested subagents:** expand a main-agent conversation that dispatched subagents. Expect to see nested subagent conversation headers (depth 3, with purple/green stripes) appearing inline right after the turn that spawned them — not as top-level siblings.
2. **Collapsed by default:** nested sub-conversations are collapsed initially; click to expand their turns.
3. **Auto-expand ancestry:** click a turn inside a nested subagent conversation (e.g. via the right-hand detail panel if it triggers `onSelect`). Both the nested sub-conversation AND its parent main-agent conversation auto-expand.
4. **No compression dividers:** today, zero `┄┄ context compressed ┄┄` rows should render (expected — no compaction on the 1M model).
5. **Unmatched subagents:** any subagent whose linkage failed still appears as a top-level sibling (the fallback).

- [ ] **Step 5: Commit**

```bash
git add web/src/components/ConversationList.tsx web/src/styles/global.css
git commit -m "feat(web): render compression dividers + auto-expand nested subagent ancestry"
```

---

## Self-Review Notes

**Spec coverage:**
- ✅ "Subagent linkage algorithm" (fingerprint collection, prompt-substring match, time-order tiebreak, `parentId` emission, empty-prompt guard) — Task 1, Steps 4 + 5
- ✅ "Compression boundary detection" (3 signals: API field, summary-style text, message-count drop; `kind: "compressed"`; idempotent in-place mutation) — Task 1, Steps 2 + 3 + 5
- ✅ "Interaction with grouping" (compressed appends, not starts-new) — Task 2, Step 3 (walk condition `c.kind !== "anchor"`)
- ✅ "Tree structure for nested subagents" (`nestedByParent` on SessionNode, pull matched out of top-level, emit inline after parent turn, depth 3) — Task 2, Steps 1 + 3 + 4
- ✅ "Compression divider rendering" (`DividerNode`, emit before compressed turn, non-interactive) — Task 2 Step 1 (type) + Step 4 (emit) + Task 3 Step 1 (render) + Step 3 (CSS)
- ✅ "Auto-expand-on-active (extended)" (walk `nestedByParent`, open nested + parent + session) — Task 3, Step 2
- ✅ Edge cases (linkage miss → top-level sibling; empty prompt guard; old captures; subagent-of-subagent via recursive `emitTurns`) — Task 1 Step 4 (guard) + Task 2 Step 3 (fallback) + Task 2 Step 4 (recursion)
- ✅ Testing (linkage script, compression sanity, visual check) — Task 1 Step 7, Task 3 Step 4

**Placeholder scan:** every step contains actual code. No TBDs. Verification scripts are complete and runnable.

**Type consistency:**
- `ListItem.kind` extended to `"anchor" | "continuation" | "compressed"` in Task 1 Step 6; matched by `c.kind === "anchor"` / `c.kind !== "anchor"` checks in Task 2 Step 3.
- `ListItem.parentId?: string` added in Task 1 Step 6; read as `conv.anchorItem.parentId` in Task 2 Step 3 and Task 3 Step 2.
- `ListItem.messageCount?: number` added in Task 1 Step 6; computed in Task 1 Step 1; consumed in `detectCompressions` (Task 1 Step 3).
- `DividerNode` defined in Task 2 Step 1; rendered in Task 3 Step 1; CSS in Task 3 Step 3.
- `getOrCreateDivider`, `getOrCreateSession` (new signature with `nestedByParent`), `nestedMapsEqual`, `emitTurns` — all defined in Task 2 and consumed consistently.
- `getOrCreateConversation` gains a `depth` parameter in Task 2 Step 4; all call sites (Task 2 Step 3 walk + the nested-rebuild) pass it.

**One known coupling:** Task 2 changes `groupSessions.ts` types that `ConversationList.tsx` imports; the build will fail between Task 2 and Task 3 just as in the prior feature. Task 2 Step 5 authorizes a stub. Task 3 replaces it.
