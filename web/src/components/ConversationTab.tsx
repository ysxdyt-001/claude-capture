import type { Capture, Message as MessageType } from "../types";
import { buildConversationItems } from "../lib/conversation";
import { rebuildAssistantFromSSE } from "../lib/sse";
import Message, { SystemMessage } from "./Message";
import ToolPair from "./ToolPair";

interface ConversationTabProps {
  capture: Capture;
}

export default function ConversationTab({ capture }: ConversationTabProps) {
  const req = capture.request?.body || {};
  const messages = req.messages || [];
  const sse = capture.response?.sse_events || [];
  const rebuiltAssistant = rebuildAssistantFromSSE(sse);

  // 构建时间线：system → 请求消息 → SSE 重建的 assistant 回复。
  // Build the chronological thread: system → request messages → SSE reply.
  const all: MessageType[] = [];
  if (req.system) {
    const sys =
      typeof req.system === "string"
        ? req.system
        : JSON.stringify(req.system, null, 2);
    all.push({ role: "system", content: sys });
  }
  for (const m of messages) all.push(m);
  if (rebuiltAssistant) {
    all.push({
      role: "assistant",
      content: rebuiltAssistant,
      fromSSE: true,
    });
  }

  const items = buildConversationItems(all);
  const toolPairCount = items.filter((i) => i.kind === "tool-pair").length;
  const textTurnCount = items.filter(
    (i) => i.kind !== "tool-pair" && i.kind !== "system",
  ).length;
  const status = capture.response?.status_code;
  const statusBadgeCls = status === 200 ? "ok" : "err";

  return (
    <div>
      <div className="meta-table">
        <div className="kv">
          <div className="k">Model</div>
          <div>{req.model || "—"}</div>
        </div>
        <div className="kv">
          <div className="k">Temp / MaxTokens</div>
          <div>
            temp={req.temperature ?? "—"} · max={req.max_tokens ?? "—"}
          </div>
        </div>
        <div className="kv">
          <div className="k">Tools</div>
          <div>{req.tools?.length || 0} declared</div>
        </div>
        <div className="kv">
          <div className="k">Stream</div>
          <div>{req.stream ?? "—"}</div>
        </div>
        <div className="kv">
          <div className="k">Response</div>
          <div>
            <span className={`badge ${statusBadgeCls}`}>{status ?? "—"}</span>
          </div>
        </div>
      </div>

      <h3 className="section">
        Conversation · {textTurnCount} turns
        {toolPairCount ? ` · ${toolPairCount} tool calls` : ""}
      </h3>

      {items.map((it, i) => {
        switch (it.kind) {
          case "system":
            return <SystemMessage key={i} message={it.message} />;
          case "user":
            return <Message key={i} message={it.message} idx={it.idx} />;
          case "assistant":
            return <Message key={i} message={it.message} idx={it.idx} />;
          case "tool-pair":
            return (
              <ToolPair
                key={i}
                toolUse={it.toolUse}
                toolResult={it.toolResult}
              />
            );
          default:
            return <Message key={i} message={it.message} idx={it.idx} />;
        }
      })}
    </div>
  );
}
