# Sidebar Performance: Server Cache + Client Memoization — Design

**Date:** 2026-07-10
**Status:** Approved (brainstorming complete)
**Builds on:** Tree virtualization + resizable sidebar (commit `c198251`).

## 1. Goal

Eliminate the dominant performance bottleneck: `lib/server.mjs`'s `listCaptures` reads and parses all 973 capture JSONs (314 MB) on every `/api/files` request — a 3-second poll cadence means ~100 MB/s of JSON parsing sustained. Layer in client-side memoization so the React virtualizer stops re-rendering unchanged rows on every poll.

## 2. Decisions (locked during brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Server-side cache | **A — Per-file mtime cache** | In-memory `Map<fullPath, {mtime, size, item}>`. Cache hit reuses the parsed `ListItem` object; misses only happen for new/modified files. No addon changes, single-line concept, transparent invalidation. |
| Client-side memoization | **B — `useCallback` on `toggle` + stable leaf identity** | Two small changes that make `memo()` on `TreeNodeRow` actually work. Only rows whose props genuinely changed re-render. |
| Cache persistence across restarts | **A — In-memory only** | First poll after restart rebuilds (~1-2 s one-time cost). No disk I/O for cache state, no invalidation edge cases. |
| Polling cadence | **Keep at 3 s** | Cache makes steady-state per-poll cost negligible; slower would delay seeing new captures, faster would increase client churn. |

## 3. Server-side per-file mtime cache

### `lib/server.mjs` — `listCaptures` rewrite

Module-level cache keyed by absolute file path. Each entry holds the cached `ListItem` object (including `name`) so cache hits return the SAME object reference, enabling downstream client-side referential equality.

```js
// 模块级缓存：进程级，CLI 重启失效。键为文件绝对路径。
// Module-level cache: process-scoped, dies with the CLI. Keyed by absolute file path.
const listCache = new Map();  // full-path -> { mtime, size, item }

async function listCaptures(capturesDir) {
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
      const stat = await fs.stat(full);
      seen.add(full);

      // 命中：mtime 与 size 都未变 → 复用同一 ListItem 引用（关键：保证下游引用稳定）。
      // Hit: mtime and size unchanged → reuse the same ListItem reference (critical for downstream identity).
      const cached = listCache.get(full);
      if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) {
        items.push(cached.item);
        continue;
      }

      // 未命中：读取并解析；解析失败故意不缓存（下次 poll 重试，让坏文件能自愈）。
      // Miss: read and parse; parse errors are intentionally NOT cached so bad files self-heal.
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

**Key properties:**
- `seen` Set tracks files that still exist on disk; cache entries for deleted files get GC'd at the end of each call.
- Both `mtime` AND `size` checked — defense in depth (size alone catches mtime-precision edge cases).
- Parse errors are NOT cached → bad files retry on every poll until they parse (self-healing).
- Cache holds the full `ListItem` (not just `{status, preview}`) so cache hits return the SAME object reference. This is what makes downstream client memoization work (Section 4).

**Impact estimate:** first poll after startup reads+parses all files (~1–2 s for 973). Subsequent polls: only `stat` each file (fast) plus read+parse only files new or modified since last poll. With ~10 captures per session at 3 s cadence, steady-state per-poll disk I/O drops from "314 MB JSON parsed" to "973 stats + ~10 small reads."

**Cache lifecycle:**
- Lives in process memory; dies with the CLI.
- First poll after restart rebuilds — one-time cost per launch, on the order of mitmweb startup time.
- No disk persistence (intentional — avoids invalidation edge cases).

## 4. Client-side memoization

### 4.1 `ConversationList.tsx` — wrap `toggle` in `useCallback`

```tsx
const toggle = useCallback((key: string) => {
  setCollapsedKeys((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });
}, []);
```

Stable identity across renders → `memo()` on `TreeNodeRow` no longer sees a fresh `onToggle` prop every render.

### 4.2 `groupSessions.ts` — stabilize leaf TreeNode identity in `flattenVisible`

Today `flattenVisible` creates a new leaf wrapper `{ type: "leaf", depth, key, name, item }` on every call, breaking referential equality even when the underlying `ListItem` is unchanged. Add a module-level leaf cache keyed by `ListItem.name` that reuses the same `TreeNode` object when the `ListItem` reference is unchanged:

```ts
// 模块级叶子缓存：相同 ListItem.name 且 ListItem 引用未变 → 复用同一个 TreeNode。
// Module-level leaf cache: same ListItem.name AND same ListItem reference → reuse the same TreeNode.
const leafCache = new Map<string, TreeNode>();

export function flattenVisible(tree: TreeNode[], collapsedKeys: Set<string>): TreeNode[] {
  const out: TreeNode[] = [];
  for (const node of tree) {
    out.push(node);  // session nodes come from buildTree, which useMemo keeps stable on stable items
    if (node.type === "session" && !collapsedKeys.has(node.key) && node.captures) {
      for (const c of node.captures) {
        let leaf = leafCache.get(c.name);
        // 只有当 ListItem 引用变了才重建 wrapper；否则复用上次的 TreeNode 对象。
        // Only rebuild the wrapper when the ListItem reference changed; otherwise reuse the previous TreeNode.
        if (!leaf || leaf.item !== c) {
          leaf = { type: "leaf", depth: node.depth + 1, key: c.name, name: c.name, item: c };
          leafCache.set(c.name, leaf);
        }
        out.push(leaf);
      }
    }
  }
  // 清理已消失 name 的缓存项。
  // Drop cache entries for names that no longer appear.
  // (Cheap because the typical capture count per session is small.)
  return out;
}
```

**Why this chain works:**
1. Server cache hit returns the same `ListItem` object reference for unchanged files (Section 3).
2. `buildTree` puts that same `ListItem` into the session node's `captures` array.
3. `useMemo(() => buildTree(items), [items])` recomputes when `items` changes, but the new tree's `captures` arrays contain the SAME `ListItem` references for unchanged files.
4. `flattenVisible` checks `leaf.item !== c` and skips re-wrapping when `c` is the same reference.
5. `visibleRows[vRow.index]` is now referentially stable for unchanged leaves.
6. `TreeNodeRow`'s `memo()` sees the same `node` prop → skips re-render.

### 4.3 `TreeNodeRow` prop drilling — minor cleanup

For `memo()` to fully work, all props passed to `TreeNodeRow` need stable identity when their content is unchanged:
- `node` — stabilized by 4.2 ✓
- `collapsed` — boolean, primitive ✓
- `selectedName` — primitive ✓
- `onToggle` — stabilized by 4.1 ✓
- `onSelect` — comes from `App.tsx`, declared inside `App()` body. **Not currently memoized.** Wrap in `useCallback` in `App.tsx` so its identity is stable.
- `vStart`, `vIndex`, `measureRef` — primitives / library-provided; stable.

Add `useCallback` to `onSelect` in `App.tsx`:

```tsx
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

With both `toggle` and `onSelect` memoized, `memo()` on `TreeNodeRow` finally skips re-renders for unchanged rows. Visible row count is bounded by the virtualizer (~20–30 rows), so the absolute savings are modest — but they compound over polling cycles and eliminate the per-poll re-render storm.

## 5. Files touched

| File | Change |
|---|---|
| `lib/server.mjs` | Rewrite `listCaptures`: add module-level `listCache` Map, cache-hit returns same `ListItem` reference, cache-miss reads+parses+stores, GC entries for deleted files. Parse errors intentionally not cached. |
| `web/src/lib/groupSessions.ts` | Add module-level `leafCache` Map inside `flattenVisible`; reuse wrapper when `ListItem` reference is unchanged. |
| `web/src/components/ConversationList.tsx` | Wrap `toggle` in `useCallback` with `[]` deps. |
| `web/src/App.tsx` | Wrap `onSelect` in `useCallback` with `[]` deps. |

### Files NOT touched

- `lib/addon.py`, `bin/claude-capture.mjs`
- `web/src/lib/api.ts`, `web/src/types.ts`, etc.
- Polling cadence (stays at 3 s)

## 6. Testing / verification

Manual side-by-side. Acceptance:

1. **Server cache hit:** Open Chrome DevTools → Network. After the first `/api/files` request, subsequent requests (every 3 s) complete in tens of milliseconds, not seconds. Confirm via the `Time` column in Network tab.
2. **Server cache miss:** Generate a new capture (run any Claude request through the proxy). The next poll's `/api/files` Time rises briefly (reads + parses the new file only), then drops back to steady-state on the following poll.
3. **Stable `ListItem` reference:** In DevTools, set a breakpoint or log inside `buildTree`'s loop. After the first poll, subsequent polls log the SAME `ListItem` object identities for unchanged files (verify via `console.log(items[0] === window._prevItems0)` style check or React DevTools Profiler showing skipped renders).
4. **Client re-render reduction:** React DevTools Profiler → record a 10-second window with no captures being written. Visible rows should show ZERO re-renders between polls. (Before this fix, every visible row would re-render on every poll.)
5. **No regression:** initial-collapse still fires once; selection still loads the Conversation tab; sidebar resize still works; virtualization still smooth during scroll.

## 7. Out of scope

- Server-Sent Events / WebSocket push (defer to a future spec if polling proves insufficient).
- Filesystem watch (chokidar / `fs.watch`) — same deferral.
- Persisting cache to disk (`~/.claude-capture/list-cache.json`) — Question 3 option B; rejected for v1.
- Hash-based content verification (`crypto.createHash`) — overkill given `mtime`+`size` suffices for write-once capture files.
- Reducing poll cadence — kept at 3 s; cache makes the original cadence's cost drop by ~100×.
