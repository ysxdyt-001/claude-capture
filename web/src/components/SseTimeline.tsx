import { escapeHtml } from "../lib/format";
import type { Capture } from "../types";
import EmptyState from "./EmptyState";

interface SseTimelineProps {
  capture: Capture;
}

export default function SseTimeline({ capture }: SseTimelineProps) {
  const events = capture.response?.sse_events || [];
  if (events.length === 0) {
    return (
      <div>
        <EmptyState big="No stream captured" small="RESPONSE WAS NOT SSE · SEE BODY BELOW" />
        <h3 className="section">Response body</h3>
        <pre className="json">
          {JSON.stringify(capture.response?.body ?? capture.response ?? {}, null, 2)}
        </pre>
      </div>
    );
  }
  return (
    <div>
      <div
        style={{
          marginBottom: 14,
          color: "var(--text-dim)",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
        }}
      >
        {events.length} events ·{" "}
        <span style={{ color: "var(--sage-deep)" }}>streaming timeline</span>
      </div>
      <div className="sse-list">
        {events.map((ev, i) => {
          const name = ev.event || "—";
          const cls = name.includes("delta")
            ? "delta"
            : name.includes("tool")
              ? "tool_use"
              : name.includes("error")
                ? "error"
                : "";
          const dataStr = typeof ev.data === "string" ? ev.data : JSON.stringify(ev.data);
          const preview =
            dataStr.length > 500
              ? `${dataStr.slice(0, 500)} … (+${dataStr.length - 500})`
              : dataStr;
          return (
            <div className="sse-item" key={i}>
              <div className="sse-idx">#{String(i).padStart(3, "0")}</div>
              <div
                className={`sse-event ${cls}`}
                dangerouslySetInnerHTML={{ __html: escapeHtml(name) }}
              />
              <div className="sse-data" dangerouslySetInnerHTML={{ __html: escapeHtml(preview) }} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
