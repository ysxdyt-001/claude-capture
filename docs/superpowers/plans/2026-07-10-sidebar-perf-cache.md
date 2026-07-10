# Sidebar Performance Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the dominant sidebar performance bottleneck (server reads + parses all 973 capture JSONs on every 3-second poll) and stop the React virtualizer from re-rendering unchanged rows on every poll.

**Architecture:** Two coordinated changes. Task 1 adds a module-level in-memory `Map<fullPath, {mtime, size, item}>` cache to `lib/server.mjs`'s `listCaptures` so cache hits return the SAME `ListItem` object reference for unchanged files (only stat per file in steady state, parse only on new/modified files). Task 2 makes `memo()` on `TreeNodeRow` actually work by stabilizing all of its props: `useCallback` on `toggle` and `onSelect`, plus a leaf-wrapper cache in `flattenVisible` keyed by `ListItem.name` that reuses the same `TreeNode` object when the underlying `ListItem` reference is unchanged.

**Tech Stack:** Node built-ins (`fs`, `path`) on the server. React 18 `useCallback` + existing `memo()` on the client. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-10-sidebar-perf-cache-design.md`

## Global Constraints

- **No tests required.** Build (`tsc -b && vite build`) and lint (`biome check src`) are the gates; runtime verification is manual via DevTools Network/Profiler.
- **No new dependencies.** Server uses only Node built-ins; client uses React's existing `useCallback` + `memo`.
- **`lib/addon.py` and `bin/claude-capture.mjs` unchanged.**
- **Bilingual comments** where surrounding code has them (server.mjs has them; client files follow the established pattern).
- **Server cache is module-level, in-memory only.** No disk persistence. First poll after CLI restart rebuilds — that's intentional.
- **Parse errors are NOT cached.** Bad files retry on every poll so they can self-heal when the writer completes.
- **`ListItem` object identity is load-bearing.** The server's cache-hit path MUST push the cached `item` directly (not spread into a new object) — downstream client memoization depends on referential equality.
- **Polling cadence stays at 3 s.** Do not change.
- **Existing behavior preserved:** initial-collapse logic, dirname+`[N]` session label, resizable sidebar bounds, virtualizer's `data-index` numeric fix, `getItemKey` ref guard.

---

## File Structure

### Files modified

| Path | Change |
|---|---|
| `lib/server.mjs` | Rewrite `listCaptures`: add module-level `listCache` Map; cache-hit returns same `ListItem` reference; cache-miss reads+parses+stores; GC entries for deleted files; parse errors intentionally not cached. |
| `web/src/lib/groupSessions.ts` | Add module-level `leafCache` Map; `flattenVisible` reuses wrapper when `ListItem` reference unchanged. |
| `web/src/components/ConversationList.tsx` | Wrap `toggle` in `useCallback` with `[]` deps. |
| `web/src/App.tsx` | Wrap `onSelect` in `useCallback` with `[]` deps. |

### Files NOT touched

- `lib/addon.py`, `bin/claude-capture.mjs`
- `web/src/lib/api.ts`, `web/src/types.ts`, `web/src/components/SidebarResizeHandle.tsx`
- `web/src/styles/global.css`

---

## Task Sequence

- [Task 1: Server-side per-file mtime cache (`lib/server.mjs`)](#task-1)
- [Task 2: Client-side memoization (`groupSessions.ts` + `ConversationList.tsx` + `App.tsx`)](#task-2)

---

<a id="task-1"></a>
### Task 1: Server-side per-file mtime cache (`lib/server.mjs`)

**Files:**
- Modify: `lib/server.mjs:14-55` (the `listCaptures` function)

**Interfaces:**
- Consumes: nothing new (existing `extractLastUserText` helper still used on cache misses).
- Produces: `listCaptures(capturesDir)` still returns `ListItem[]` sorted by mtime desc. The SAME `ListItem` object reference is returned across calls for unchanged files. Downstream consumers (the `/api/files` route handler) see no API change.

- [ ] **Step 1: Replace `listCaptures` with the cached version**

Open `lib/server.mjs`. Add a module-level `listCache` declaration just above the `listCaptures` function (around line 13, between the `MIME` constant and the existing function). Then replace the entire `listCaptures` function body with the cached version.

The new code (replacing existing lines 14–55):

```js
// 模块级缓存：进程级，CLI 重启失效。键为文件绝对路径。
// Module-level cache: process-scoped, dies with the CLI. Keyed by absolute file path.
const listCache = new Map();  // full-path -> { mtime, size, item }

async function listCaptures(capturesDir) {
  // 递归扫描 capturesDir，包括 session-* 子目录。返回的 name 是相对路径
  // （如 "session-20260708-143022-1234/xxx.json"），前端直接拼到 /api/file?name=。
  // 缓存命中时复用上次的 ListItem 对象引用 —— 下游 React memo 依赖这个引用稳定性。
  // Recursive scan of capturesDir including session-* subdirs. `name` is the relative path
  // (e.g. "session-20260708-143022-1234/xxx.json") that the frontend appends to /api/file?name=.
  // Cache hits reuse the previous ListItem object reference — downstream React memo relies on this identity.
  const items = [];
  const stack = [""];
  const seen = new Set();

  while (stack.length) {
    const rel = stack.pop();
    const dir = path.join(capturesDir, rel);
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        stack.push(childRel);
        continue;
      }
      if (!ent.name.endsWith(".json")) continue;

      const full = path.join(dir, ent.name);
      let stat;
      try {
        stat = await fs.stat(full);
      } catch {
        continue;
      }
      seen.add(full);

      // 命中：mtime 与 size 都未变 → 复用同一 ListItem 引用（不要展开成新对象！）。
      // Hit: mtime and size unchanged → reuse the same ListItem reference (do NOT spread into a new object!).
      const cached = listCache.get(full);
      if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) {
        items.push(cached.item);
        continue;
      }

      // 未命中：读取并解析。解析失败故意不缓存（下次 poll 重试，让坏文件能自愈）。
      // Miss: read and parse. Parse failures are intentionally NOT cached so bad files self-heal.
      try {
        const raw = await fs.readFile(full, "utf8");
        const data = JSON.parse(raw);
        const lastUser = extractLastUserText(data);
        const item = {
          name: childRel,
          mtime: stat.mtimeMs,
          size: stat.size,
          status: data.response?.status_code,
          preview: lastUser?.slice(0, 80) ?? "(empty)",
        };
        listCache.set(full, { mtime: stat.mtimeMs, size: stat.size, item });
        items.push(item);
      } catch {
        items.push({ name: childRel, mtime: 0, size: 0, status: 0, preview: "(parse error)" });
      }
    }
  }

  // 清理已删除文件的缓存项，避免内存泄漏。
  // Drop cache entries for deleted files to avoid memory leaks.
  for (const key of listCache.keys()) {
    if (!seen.has(key)) listCache.delete(key);
  }

  items.sort((a, b) => b.mtime - a.mtime);
  return items;
}
```

**Critical implementation notes for the implementer:**
- The cache-hit branch MUST push `cached.item` directly — NOT `items.push({ ...cached.item })` or `items.push({ name: childRel, ...cached.item })`. Spreading would create a new object and break downstream React memoization.
- The cache-miss branch stores `{ mtime, size, item }` (where `item` already includes `mtime` and `size` inlined for the response — this duplication is intentional; the wrapper holds the cache-invalidation key, the inner `item` is what gets pushed to the response).
- `seen` Set is built per-call from successful `stat` calls; deleted files won't appear in `seen` and get pruned at the end.
- `extractLastUserText` stays untouched (existing helper further down the file).

- [ ] **Step 2: Verify the server still works (no build step — plain JS)**

The CLI's `lib/` directory has no build step. Verify by running the server briefly and hitting the endpoint:

```bash
node -e "
import('./lib/server.mjs').then(async ({ startServer }) => {
  const srv = await startServer({
    capturesDir: process.env.HOME + '/.claude-capture/captures',
    port: 7811,
    publicDir: require('path').resolve('dist'),
  });
  const fetch = (p) => new Promise(r => {
    require('http').get('http://127.0.0.1:7811' + p, res => {
      let b=''; res.on('data',c=>b+=c); res.on('end',()=>{ r({status:res.statusCode, len:b.length}); });
    });
  });
  const t0 = Date.now();
  const first = await fetch('/api/files');
  const t1 = Date.now();
  const second = await fetch('/api/files');
  const t2 = Date.now();
  console.log('first  poll:', first.status, first.len, 'bytes,', (t1-t0)+'ms');
  console.log('second poll:', second.status, second.len, 'bytes,', (t2-t1)+'ms');
  srv.close();
  process.exit(0);
});
"
```

Expected:
- First poll: 200, large body (size depends on capture count), time depends on file count — for 973 files this is the cold-cache cost (~1-2 s).
- Second poll: 200, same body length, **much faster** — should be tens of ms (only `stat` calls, no JSON parsing for unchanged files).

If the second poll isn't dramatically faster, the cache isn't being hit. Check that the cache-hit branch pushes `cached.item` directly (not a spread).

- [ ] **Step 3: Manual smoke test against running CLI (optional if Step 2 passes)**

If you want a fuller end-to-end check:
```bash
node bin/claude-capture.mjs
```
Open the viewer URL. The first load takes ~1-2 s (cold cache); subsequent sidebar refreshes (every 3 s) should be visually instant. If you have captures, the sidebar should populate normally.

- [ ] **Step 4: Commit**

```bash
git add lib/server.mjs
git commit -m "perf(server): cache listCaptures by mtime+size, reuse ListItem refs"
```

---

<a id="task-2"></a>
### Task 2: Client-side memoization (`groupSessions.ts` + `ConversationList.tsx` + `App.tsx`)

**Files:**
- Modify: `web/src/lib/groupSessions.ts` (add `leafCache` Map; stabilize leaf identity in `flattenVisible`)
- Modify: `web/src/components/ConversationList.tsx` (wrap `toggle` in `useCallback`)
- Modify: `web/src/App.tsx` (wrap `onSelect` in `useCallback`)

**Interfaces:**
- Consumes:
  - From Task 1: stable `ListItem` object references from `/api/files` for unchanged files. Without this, the leaf cache in `flattenVisible` won't help because every poll's `ListItem` references change.
  - From existing code: `TreeNode` type and `flattenVisible` in `groupSessions.ts`; `setCollapsedKeys` state setter in `ConversationList.tsx`; `setSelectedName`, `setCapture`, `fetchFile` in `App.tsx`.
- Produces: No interface changes. `flattenVisible(tree, collapsedKeys)` signature unchanged; `ConversationList` and `App` exports unchanged. Internal memoization only.

- [ ] **Step 1: Add leaf cache to `flattenVisible` in `web/src/lib/groupSessions.ts`**

Open the file. Locate the `flattenVisible` function (currently creates new leaf objects on every call). Add a module-level `leafCache` Map just ABOVE the function declaration, then rewrite the function body to consult and populate the cache.

Add the module-level cache declaration (place it just above `export function flattenVisible`):

```ts
// 模块级叶子缓存：相同 ListItem.name 且 ListItem 引用未变 → 复用同一个 TreeNode 对象。
// 下游 TreeNodeRow 的 memo() 依赖这个引用稳定性来跳过未变行的重渲染。
// Module-level leaf cache: same ListItem.name AND same ListItem reference → reuse the same TreeNode object.
// Downstream TreeNodeRow's memo() relies on this identity stability to skip re-rendering unchanged rows.
const leafCache = new Map<string, TreeNode>();
```

Replace the body of `flattenVisible` with:

```ts
export function flattenVisible(tree: TreeNode[], collapsedKeys: Set<string>): TreeNode[] {
  const out: TreeNode[] = [];
  for (const node of tree) {
    out.push(node);
    if (node.type === "session" && !collapsedKeys.has(node.key) && node.captures) {
      for (const c of node.captures) {
        let leaf = leafCache.get(c.name);
        // 只有当 ListItem 引用变了才重建 wrapper；否则复用上次的 TreeNode 对象。
        // Rebuild the wrapper only when the ListItem reference changed; otherwise reuse the previous TreeNode.
        if (!leaf || leaf.item !== c) {
          leaf = { type: "leaf", depth: node.depth + 1, key: c.name, name: c.name, item: c };
          leafCache.set(c.name, leaf);
        }
        out.push(leaf);
      }
    }
  }
  return out;
}
```

**Critical implementation note:** The comparison is `leaf.item !== c` — referential equality on the `ListItem` itself, NOT a deep content check. This only works because Task 1 makes the server return the same `ListItem` reference for unchanged files. If Task 1 isn't merged first, this change is a no-op.

- [ ] **Step 2: Wrap `toggle` in `useCallback` in `web/src/components/ConversationList.tsx`**

Open the file. Find the existing `toggle` declaration:

```tsx
const toggle = (key: string) => {
  setCollapsedKeys((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });
};
```

Replace with:

```tsx
// useCallback 保证 toggle 引用稳定，让 TreeNodeRow 的 memo() 生效。
// useCallback keeps toggle's identity stable so TreeNodeRow's memo() actually works.
const toggle = useCallback((key: string) => {
  setCollapsedKeys((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });
}, []);
```

Also update the React import at the top of the file. It currently reads (approximately):

```tsx
import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useEffect, useMemo, useRef, useState } from "react";
```

Add `useCallback` to the React import:

```tsx
import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
```

(Insert `useCallback` in alphabetical order between `memo` and `useEffect`.)

- [ ] **Step 3: Wrap `onSelect` in `useCallback` in `web/src/App.tsx`**

Open the file. Find the existing `onSelect` declaration:

```tsx
const onSelect = async (name: string) => {
  setSelectedName(name);
  try {
    const data = await fetchFile(name);
    setCapture(data);
  } catch {
    setCapture(null);
  }
};
```

Replace with:

```tsx
// useCallback 保证 onSelect 引用稳定，让 ConversationList → TreeNodeRow 的 memo() 生效。
// useCallback keeps onSelect's identity stable so ConversationList → TreeNodeRow's memo() actually works.
const onSelect = useCallback(async (name: string) => {
  setSelectedName(name);
  try {
    const data = await fetchFile(name);
    setCapture(data);
  } catch {
    setCapture(null);
  }
}, []);
```

Update the React import at the top of the file. It currently reads:

```tsx
import { useCallback, useEffect, useState } from "react";
```

`useCallback` is already imported (the existing `load` function uses it). No import change needed.

- [ ] **Step 4: Verify build + lint**

Run from `web/`:
```bash
npm run build
```
Expected: success. Same module count as before this task.

Run:
```bash
npm run format && npm run lint
```
Expected: 0 errors after format.

- [ ] **Step 5: Manual smoke test — verify memo actually skips re-renders**

This is the most important verification step. The whole point of Task 2 is to reduce React reconciliation work. Two ways to verify:

**Option A: React DevTools Profiler (preferred if available):**
1. Build and launch: `(cd web && npm run build) && node bin/claude-capture.mjs`
2. Open the viewer URL in Chrome.
3. Open React DevTools → Profiler tab.
4. Click "Record".
5. Wait 10 seconds without interacting with the sidebar (no clicks, no selection changes, no scrolling — just let it poll).
6. Stop recording.
7. Inspect the commit log. Between polls (every 3 s), there should be **zero or minimal** re-renders of `TreeNodeRow` components. Only `App` itself should re-render when `items` updates (and only if items actually changed).

**Option B: Console log canary (if React DevTools isn't available):**
Temporarily add a `console.log("render", node.key)` at the top of `TreeNodeRow`'s function body. Reload, wait 10 seconds without interaction. The console should NOT flood with render logs every 3 s. If it does, memoization isn't working — check that `toggle` and `onSelect` are wrapped in `useCallback`, and that the leaf cache in `flattenVisible` is reusing objects (set a breakpoint or log in the cache-miss branch — it should only fire on the first poll, not subsequent ones).

**Remove the `console.log` canary before committing if you used Option B.**

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/groupSessions.ts web/src/components/ConversationList.tsx web/src/App.tsx
git commit -m "perf(web): useCallback + stable leaf TreeNode refs for memoized rows"
```

---

## Self-Review

**Spec coverage:**
- Spec §3 (server per-file mtime cache, same-ListItem-reference on hit, GC deleted files, parse errors not cached) → Task 1 Step 1 ✓
- Spec §4.1 (`useCallback` on `toggle`) → Task 2 Step 2 ✓
- Spec §4.2 (leaf cache in `flattenVisible` keyed by `name`, rebuild only when `ListItem` ref changes) → Task 2 Step 1 ✓
- Spec §4.3 (`useCallback` on `onSelect` in App.tsx) → Task 2 Step 3 ✓
- Spec §5 files touched → matches exactly: `lib/server.mjs`, `groupSessions.ts`, `ConversationList.tsx`, `App.tsx`. No other files. ✓
- Spec §6 acceptance (Network tab shows faster polls; React Profiler shows zero re-renders between polls when no captures written; no regression on initial-collapse / selection / resize / virtualization) → Task 1 Step 2 (Network timing) + Task 2 Step 5 (Profiler / canary) + smoke tests cover all five items ✓
- Spec §7 out-of-scope (SSE/WebSocket, filesystem watch, disk-persisted cache, hash verification, cadence change) → respected; none of the tasks add these ✓

**Placeholder scan:** No TBDs / TODOs / "implement later" / "similar to Task N". Every step contains complete code or commands.

**Type consistency:**
- `listCache` stores `{ mtime, size, item }` where `item` is the full `ListItem`. Cache-hit pushes `cached.item` directly. Consumer (`/api/files` handler) sees the same shape as before.
- `leafCache` stores `TreeNode` (the leaf wrapper). Comparison `leaf.item !== c` uses the `item` field on `TreeNode` (defined in `groupSessions.ts`'s `TreeNode` interface as `item?: ListItem`). Type matches.
- `useCallback` deps `[]` for both `toggle` and `onSelect` — correct because `setCollapsedKeys` / `setSelectedName` / `setCapture` / `fetchFile` are all stable references (useState setters are stable by spec; `fetchFile` is a module-level import).

**Scope check:** Two focused tasks with clear ordering dependency (Task 2 depends on Task 1's stable `ListItem` references). Each task has an independent gate — Task 1 verifies via Network timing; Task 2 verifies via Profiler / canary.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-10-sidebar-perf-cache.md`. Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session via executing-plans, batch execution with checkpoints.

Which approach?
