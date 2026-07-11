import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type TreeNode, buildTree, flattenVisible } from "../lib/groupSessions";
import { formatTime } from "../lib/format";
import type { ListItem } from "../types";

interface ConversationListProps {
  items: ListItem[];
  selectedName: string | null;
  onSelect: (name: string) => void;
}

export default function ConversationList({ items, selectedName, onSelect }: ConversationListProps) {
  const tree = useMemo(() => buildTree(items), [items]);

  // 折叠的 session key 集合。空集合 = 全展开。
  // Collapsed-session keys. Empty set = all expanded.
  const [collapsedKeys, setCollapsedKeys] = useState<Set<string>>(new Set());

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

  const visibleRows = useMemo(() => flattenVisible(tree, collapsedKeys), [tree, collapsedKeys]);

  // 把最新 visibleRows 放进 ref：measureElement 的 ResizeObserver 是异步回调，
  // 触发时 visibleRows 可能已变（轮询/折叠），需要读到最新数组才能正确映射 key。
  // Mirror visibleRows into a ref: measureElement's ResizeObserver fires async,
  // by which time visibleRows may have changed (poll/collapse). It must read the
  // latest array to map the DOM element back to the correct key.
  const visibleRowsRef = useRef(visibleRows);
  visibleRowsRef.current = visibleRows;

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

  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: visibleRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 60,
    overscan: 8,
    getItemKey: (i) => {
      const row = visibleRowsRef.current[i];
      return row ? row.key : `__gap_${i}`;
    },
  });

  return (
    <div ref={parentRef} className="file-list">
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((vRow) => (
          <TreeNodeRow
            key={vRow.key}
            node={visibleRows[vRow.index]}
            collapsed={collapsedKeys.has(visibleRows[vRow.index].key)}
            selectedName={selectedName}
            onToggle={toggle}
            onSelect={onSelect}
            vStart={vRow.start}
            vIndex={vRow.index}
            measureRef={virtualizer.measureElement}
          />
        ))}
      </div>
    </div>
  );
}

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

  // STUB: Task 2 — renderer 尚未学习嵌套布局（depth-based indentation 对嵌套子代理）。
  // Task 3 会增强渲染：嵌套缩进、divider 样式、子代理 ancestry 标记。
  // STUB: Task 2 — renderer hasn't learned nested layout yet (depth-based indentation for
  // nested subagents). Task 3 enhances rendering: nested indent, divider style, subagent ancestry.

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
