import { useCallback, useEffect, useState } from "react";
import ConversationList from "./components/ConversationList";
import DetailPane from "./components/DetailPane";
import SidebarResizeHandle from "./components/SidebarResizeHandle";
import { fetchFile, fetchFiles } from "./lib/api";
import type { Capture, ListItem } from "./types";

const SIDEBAR_DEFAULT = 340;
const SIDEBAR_MIN = 240;
const SIDEBAR_MAX = 600;
const STORAGE_KEY = "claude-capture:sidebar-width";

export default function App() {
  const [items, setItems] = useState<ListItem[]>([]);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [capture, setCapture] = useState<Capture | null>(null);

  // 侧边栏宽度：首次挂载从 localStorage 读取，越界回退默认值。
  // Sidebar width: read from localStorage on mount; fall back to default if out of bounds.
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(saved) && saved >= SIDEBAR_MIN && saved <= SIDEBAR_MAX
      ? saved
      : SIDEBAR_DEFAULT;
  });

  // 轮询 /api/files 每 3 秒；网络抖动时静默跳过。
  // Poll /api/files every 3s; silently skip on network hiccup.
  const load = useCallback(async () => {
    try {
      const list = await fetchFiles();
      setItems(list);
    } catch {
      /* skip */
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, [load]);

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

  return (
    <div className="app" style={{ gridTemplateColumns: `${sidebarWidth}px 4px 1fr` }}>
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="eyebrow">
            <span className="dot" />
            Capture Inspector
          </div>
          <div className="sub" id="count">
            {items.length === 0
              ? "— scanning —"
              : `${items.length} capture${items.length === 1 ? "" : "s"} on record`}
          </div>
        </div>
        <ConversationList items={items} selectedName={selectedName} onSelect={onSelect} />
      </aside>
      <SidebarResizeHandle
        currentWidth={sidebarWidth}
        onResize={setSidebarWidth}
        onCommit={(w) => localStorage.setItem(STORAGE_KEY, String(w))}
        min={SIDEBAR_MIN}
        max={SIDEBAR_MAX}
      />
      <DetailPane capture={capture} filename={selectedName} onRefresh={load} />
    </div>
  );
}
