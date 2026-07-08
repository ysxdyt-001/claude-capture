import type { ListItem } from "../types";
import { formatTime } from "../lib/format";

interface ConversationListProps {
  items: ListItem[];
  selectedName: string | null;
  onSelect: (name: string) => void;
}

export default function ConversationList({
  items,
  selectedName,
  onSelect,
}: ConversationListProps) {
  return (
    <div className="file-list">
      {items.map((it) => {
        const badgeCls =
          it.status === 200 ? "ok" : it.status ? "err" : "neutral";
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
