import { useState } from "react";
import type { Capture } from "../types";
import ConversationTab from "./ConversationTab";
import EmptyState from "./EmptyState";
import RawJsonTab from "./RawJsonTab";
import RequestTab from "./RequestTab";
import ResponseTab from "./ResponseTab";
import SseTimeline from "./SseTimeline";
import Tabs, { type TabId } from "./Tabs";
import Toolbar from "./Toolbar";

interface DetailPaneProps {
  capture: Capture | null;
  filename: string | null;
  onRefresh: () => void;
}

export default function DetailPane({ capture, filename, onRefresh }: DetailPaneProps) {
  const [tab, setTab] = useState<TabId>("conv");

  if (!capture) {
    return (
      <main className="main">
        <Toolbar filename={null} onRefresh={onRefresh} />
        <div className="content">
          <EmptyState big="Awaiting inspection" small="SELECT A CAPTURE FROM THE ARCHIVE" arrow />
        </div>
      </main>
    );
  }

  return (
    <main className="main">
      <Toolbar filename={filename} onRefresh={onRefresh} />
      <Tabs active={tab} onChange={setTab} />
      <div className="content">
        {tab === "conv" && <ConversationTab capture={capture} />}
        {tab === "sse" && <SseTimeline capture={capture} />}
        {tab === "req" && <RequestTab capture={capture} />}
        {tab === "res" && <ResponseTab capture={capture} />}
        {tab === "raw" && <RawJsonTab capture={capture} />}
      </div>
    </main>
  );
}
