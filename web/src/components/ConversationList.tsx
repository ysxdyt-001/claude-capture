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

  // 折叠的 key 集合（session / context / utility 桶共用）。
  // Collapsed keys (shared across sessions, contexts, and utility buckets).
  const [collapsedKeys, setCollapsedKeys] = useState<Set<string>>(new Set());

  // 默认折叠：非最新 session 全折；最新 session 内折叠除第一条外的所有 context；utility 桶全折。
  // Default: collapse all sessions except newest; within newest, collapse all contexts except the
  // first; utility buckets always collapsed.
  const didInit = useRef(false);
  useEffect(() => {
    if (didInit.current || tree.length === 0) return;
    didInit.current = true;
    const collapsed = new Set<string>();
    for (const node of tree) {
      if (node.type !== "session") continue;
      if (node !== tree[0]) {
        collapsed.add(node.key);
        for (const conv of node.conversations) collapsed.add(conv.key);
      } else {
        for (let i = 1; i < node.conversations.length; i++) collapsed.add(node.conversations[i].key);
      }
      collapsed.add(node.utilityKey);
    }
    setCollapsedKeys(collapsed);
  }, [tree]);

  // 选中项落在折叠的 context / utility 桶 / session 里时，自动展开。
  // Auto-expand the ancestor of a selected capture so it's visible.
  useEffect(() => {
    if (!selectedName) return;
    setCollapsedKeys((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const session of tree) {
        if (session.type !== "session") continue;
        const keysToOpen = new Set<string>();
        for (const conv of session.conversations) {
          if (
            conv.anchorItem.name === selectedName ||
            conv.turns.some((t) => t.name === selectedName)
          ) {
            keysToOpen.add(session.key);
            keysToOpen.add(conv.key);
          }
        }
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

  const visibleRowsRef = useRef(visibleRows);
  visibleRowsRef.current = visibleRows;

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
    estimateSize: () => 56,
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

// context header 左侧色条（tag → CSS 类）。
// Context-header left stripe (tag → CSS class).
function conversationStripe(tag?: string): string {
  switch (tag) {
    case "subagent": return "tagged-sub";
    case "explore":  return "tagged-explore";
    case "utility":  return "tagged-util";
    default:         return "";
  }
}

// context header 的类型标签。
// Context-header type label.
function contextLabel(tag?: string, isBranch?: boolean): string {
  if (isBranch) {
    if (tag === "explore") return "↳ Explore";
    return "↳ Sub";
  }
  if (tag === "subagent") return "Sub";
  if (tag === "explore") return "Explore";
  return "Main";
}

// 格式化 token 数：1000 → 1k，1500 → 1.5k。
// Format token counts: 1000 → 1k, 1500 → 1.5k.
function fmtTokens(n?: number): string {
  if (!n) return "—";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
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
        <span className="session-meta">started {formatTime(node.startTime)}</span>
        <span className="session-count">[{node.captureCount}]</span>
      </button>
    );
  }

  if (node.type === "conversation") {
    const stripe = conversationStripe(node.tag);
    const label = contextLabel(node.tag, node.isBranch);
    return (
      <div
        ref={measureRef}
        className={`conversation-header${stripe ? ` ${stripe}` : ""}`}
        style={style}
        onClick={() => onToggle(node.key)}
        data-index={vIndex}
      >
        <span className="caret">{collapsed ? "▸" : "▾"}</span>
        <span className="context-label">{label}</span>
        <span className="conversation-preview">{node.anchorItem.preview}</span>
        <span className="conversation-meta">
          {node.turnCount} req · {formatTime(node.startTime)}
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

  // leaf: 一个 HTTP 请求（POST /messages）。显示编号 + 状态 + 时间 + token 用量。
  // Leaf: one HTTP request (POST /messages). Shows number + status + time + token usage.
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
      <div className="preview">
        <span className="req-number">{node.label}</span>
      </div>
      <div className="meta">
        <span className={`badge ${badgeCls}`}>{it.status || "—"}</span>
        <span className="req-tokens" title="input → output tokens">
          <span className="tok-in">{fmtTokens(it.inputTokens)}</span>
          <span className="tok-arrow">→</span>
          <span className="tok-out">{fmtTokens(it.outputTokens)}</span>
        </span>
        <span>{formatTime(it.mtime)}</span>
      </div>
    </div>
  );
});
