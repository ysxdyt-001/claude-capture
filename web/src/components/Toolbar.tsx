interface ToolbarProps {
  filename: string | null;
  onRefresh: () => void;
}

export default function Toolbar({ filename, onRefresh }: ToolbarProps) {
  return (
    <div className="toolbar">
      <span id="currentFile">{filename || "no capture selected"}</span>
      <span style={{ flex: 1 }} />
      <button onClick={onRefresh}>↻ REFRESH</button>
    </div>
  );
}
