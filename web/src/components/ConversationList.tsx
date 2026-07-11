import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
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

const TreeNodeRow = memo(function TreeNodeRow({
  node,
  collapsed: _collapsed,
  selectedName: _selectedName,
  onToggle: _onToggle,
  onSelect: _onSelect,
  vStart,
  vIndex: _vIndex,
  measureRef,
}: TreeNodeRowProps) {
  // TEMPORARY STUB (Task 2): renderer disabled so the new grouping logic can build in
  // isolation. Task 3 replaces this stub with the real multi-type renderer.
  const style: React.CSSProperties = {
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    transform: `translateY(${vStart}px)`,
    paddingLeft: `${24 + node.depth * 16}px`,
    paddingRight: "24px",
  };
  return <div ref={measureRef} style={style} />;
});
