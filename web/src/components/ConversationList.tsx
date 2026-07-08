import { useEffect, useRef, useState } from "react";
import { formatTime, relativeTime, truncatePreview } from "../lib/format";
import { type SessionGroup, groupSessionsByPath } from "../lib/groupSessions";
import type { ListItem } from "../types";

interface ConversationListProps {
  items: ListItem[];
  selectedName: string | null;
  onSelect: (name: string) => void;
}

export default function ConversationList({ items, selectedName, onSelect }: ConversationListProps) {
  const groups = groupSessionsByPath(items);

  // 折叠的 session key 集合。空集合 = 全展开。
  // Collapsed-session keys. Empty set = all expanded.
  const [collapsedKeys, setCollapsedKeys] = useState<Set<string>>(new Set());

  // 数据首次到达后，折叠除最新 session 外的所有组（groups[0] 是最新，因为按 newestMtime desc 排序）。
  // Once data first arrives, collapse every group except the newest (groups[0] is newest because of desc sort).
  const didInit = useRef(false);
  useEffect(() => {
    if (didInit.current || groups.length === 0) return;
    didInit.current = true;
    setCollapsedKeys(new Set(groups.slice(1).map((g) => g.key)));
  }, [groups]);

  const toggle = (key: string) => {
    setCollapsedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="file-list">
      {groups.map((g) => (
        <SessionNode
          key={g.key}
          group={g}
          collapsed={collapsedKeys.has(g.key)}
          selectedName={selectedName}
          onToggle={() => toggle(g.key)}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

interface SessionNodeProps {
  group: SessionGroup;
  collapsed: boolean;
  selectedName: string | null;
  onToggle: () => void;
  onSelect: (name: string) => void;
}

function SessionNode({ group, collapsed, selectedName, onToggle, onSelect }: SessionNodeProps) {
  return (
    <div className="session-group">
      <button type="button" className="session-header" onClick={onToggle}>
        <span className="caret">{collapsed ? "▸" : "▾"}</span>
        <span className="session-time">{relativeTime(group.newestMtime)}</span>
        <span className="session-count">{group.captures.length} captures</span>
        <span className="session-preview">{truncatePreview(group.openingPreview)}</span>
      </button>
      {!collapsed &&
        group.captures.map((it) => {
          const badgeCls = it.status === 200 ? "ok" : it.status ? "err" : "neutral";
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
