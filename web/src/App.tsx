import { useCallback, useEffect, useState } from "react";
import ConversationList from "./components/ConversationList";
import DetailPane from "./components/DetailPane";
import { fetchFile, fetchFiles } from "./lib/api";
import type { Capture, ListItem } from "./types";

export default function App() {
  const [items, setItems] = useState<ListItem[]>([]);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [capture, setCapture] = useState<Capture | null>(null);

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

  const onSelect = async (name: string) => {
    setSelectedName(name);
    try {
      const data = await fetchFile(name);
      setCapture(data);
    } catch {
      setCapture(null);
    }
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="eyebrow">
            <span className="dot" />
            Capture Inspector
          </div>
          <h1>
            Claude Code
            <br />
            <em>traffic archive</em>
          </h1>
          <div className="sub" id="count">
            {items.length === 0
              ? "— scanning —"
              : `${items.length} capture${items.length === 1 ? "" : "s"} on record`}
          </div>
        </div>
        <ConversationList items={items} selectedName={selectedName} onSelect={onSelect} />
      </aside>
      <DetailPane capture={capture} filename={selectedName} onRefresh={load} />
    </div>
  );
}
