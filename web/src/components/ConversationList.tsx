import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useRef } from "react";
import { formatTime } from "../lib/format";
import type { ListItem } from "../types";

interface ConversationListProps {
  items: ListItem[];
  selectedName: string | null;
  onSelect: (name: string) => void;
}

// 纯平铺列表 —— 不做树形分组，按服务端返回的顺序（mtime desc）直接展示。
// Flat list — no tree grouping; rendered in server order (mtime desc).
export default function ConversationList({ items, selectedName, onSelect }: ConversationListProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 52,
    overscan: 10,
    getItemKey: (i) => items[i]?.name ?? `__gap_${i}`,
  });

  return (
    <div ref={parentRef} className="file-list">
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((vRow) => (
          <RequestRow
            key={vRow.key}
            item={items[vRow.index]}
            selectedName={selectedName}
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

// tag → 小色点 class。
// tag → small colored dot class.
function tagDotClass(tag?: string): string {
  switch (tag) {
    case "subagent": return "dot-sub";
    case "explore":  return "dot-explore";
    case "utility":  return "dot-util";
    default:         return "";  // main — 无标记
  }
}

function fmtTokens(n?: number): string {
  if (!n) return "—";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

interface RequestRowProps {
  item: ListItem;
  selectedName: string | null;
  onSelect: (name: string) => void;
  vStart: number;
  vIndex: number;
  measureRef: (el: HTMLElement | null) => void;
}

const RequestRow = memo(function RequestRow({
  item,
  selectedName,
  onSelect,
  vStart,
  vIndex,
  measureRef,
}: RequestRowProps) {
  const isActive = item.name === selectedName;
  const badgeCls = item.status === 200 ? "ok" : item.status ? "err" : "neutral";
  const dotCls = tagDotClass(item.tag);
  const style: React.CSSProperties = {
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    transform: `translateY(${vStart}px)`,
  };

  return (
    <div
      ref={measureRef}
      className={`file-item${isActive ? " active" : ""}`}
      style={style}
      onClick={() => onSelect(item.name)}
      data-index={vIndex}
    >
      <div className="req-row-top">
        {dotCls && <span className={`req-dot ${dotCls}`} />}
        <span className="req-preview">{item.preview}</span>
      </div>
      <div className="req-row-meta">
        <span className={`badge ${badgeCls}`}>{item.status || "—"}</span>
        <span className="req-tokens">
          {fmtTokens(item.inputTokens)} → {fmtTokens(item.outputTokens)}
        </span>
        <span>{(item.size / 1024).toFixed(1)}k</span>
        <span>{formatTime(item.mtime)}</span>
      </div>
    </div>
  );
});
