import { escapeHtml } from "../lib/format";
import type { Capture, SseEvent } from "../types";
import EmptyState from "./EmptyState";

// 从 OpenAI chunk 的 data 结构派生事件名 + 颜色类。
// Derive event-name + color class from the OpenAI chunk's data shape.
function labelOpenAIChunk(ev: SseEvent): { name: string; cls: string } {
  if (typeof ev.data === "string") {
    const trimmed = ev.data.trim();
    if (trimmed === "[DONE]" || trimmed === '"[DONE]"') {
      return { name: "[DONE]", cls: "" };
    }
    return { name: "—", cls: "" };
  }
  const d = ev.data as Record<string, unknown> | undefined;
  const choices = d?.choices;
  if (!Array.isArray(choices) || choices.length === 0) return { name: "—", cls: "" };
  const delta = (choices[0] as Record<string, unknown> | undefined)?.delta as
    | Record<string, unknown>
    | undefined;
  if (!delta) return { name: "—", cls: "" };
  if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
    const first = delta.tool_calls[0] as Record<string, unknown> | undefined;
    const idx = typeof first?.index === "number" ? first.index : 0;
    return { name: `delta.tool_calls[${idx}]`, cls: "tool_use" };
  }
  if (typeof delta.content === "string") {
    return { name: "delta.content", cls: "delta" };
  }
  return { name: "—", cls: "" };
}

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
          // OpenAI 的 chunk 没有 event: 字段；按 delta 结构合成一个诚实标注的名字，
          // 而不是伪造 Anthropic 事件名（避免看 raw 时被误导）。
          // OpenAI chunks carry no event: field; synthesize an honest label from the
          // delta shape instead of faking Anthropic event names (keeps raw inspection honest).
          let name: string;
          let cls: string;
          if (capture._format === "openai") {
            const derived = labelOpenAIChunk(ev);
            name = derived.name;
            cls = derived.cls;
          } else {
            name = ev.event || "—";
            cls = name.includes("delta")
              ? "delta"
              : name.includes("tool")
                ? "tool_use"
                : name.includes("error")
                  ? "error"
                  : "";
          }
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
