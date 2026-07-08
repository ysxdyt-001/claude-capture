export type TabId = "conv" | "sse" | "req" | "res" | "raw";

interface TabsProps {
  active: TabId;
  onChange: (tab: TabId) => void;
}

const TABS: { id: TabId; label: string }[] = [
  { id: "conv", label: "Conversation" },
  { id: "sse", label: "SSE Timeline" },
  { id: "req", label: "Request" },
  { id: "res", label: "Response" },
  { id: "raw", label: "Raw JSON" },
];

export default function Tabs({ active, onChange }: TabsProps) {
  return (
    <div className="tabs">
      {TABS.map((t) => (
        <div
          key={t.id}
          className={`tab${t.id === active ? " active" : ""}`}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </div>
      ))}
    </div>
  );
}
