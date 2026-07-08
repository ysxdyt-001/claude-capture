import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { formatTime } from "../lib/format";
import { type TreeNode, buildTree, flattenVisible } from "../lib/groupSessions";
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

  // 数据首次到达后，折叠除最新 session 外的所有组（tree[0] 是最新，因为按 newestMtime desc 排序）。
  // Once data first arrives, collapse every session except the newest (tree[0] is newest because of desc sort).
  const didInit = useRef(false);
  useEffect(() => {
    if (didInit.current || tree.length === 0) return;
    didInit.current = true;
    setCollapsedKeys(new Set(tree.slice(1).map((n) => n.key)));
  }, [tree]);

  const visibleRows = useMemo(() => flattenVisible(tree, collapsedKeys), [tree, collapsedKeys]);

  const toggle = (key: string) => {
    setCollapsedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: visibleRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 60,
    overscan: 8,
    getItemKey: (i) => visibleRows[i].key,
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
    const count = node.captures?.length ?? 0;
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
        <span className="session-count">[{count}]</span>
      </button>
    );
  }

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
});
