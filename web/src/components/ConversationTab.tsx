import { useMemo, useState } from "react";
import { buildConversationItems } from "../lib/conversation";
import { rebuildAssistantFromSSE } from "../lib/sse";
import type { Capture, Message as MessageType } from "../types";
import Message, { SystemMessage } from "./Message";
import ToolPair from "./ToolPair";

interface ConversationTabProps {
  capture: Capture;
}

// 过滤桶：每种会话项映射到一个桶（other 无桶，始终可见）。
// Filter buckets: each conversation item maps to a bucket. "other" has no
// bucket and is always visible since it has no chip to toggle it.
type Bucket = "system" | "user" | "assistant" | "tool";

function bucketOf(item: { kind: string }): Bucket | null {
  switch (item.kind) {
    case "system":
      return "system";
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "tool-pair":
      return "tool";
    default:
      return null;
  }
}

export default function ConversationTab({ capture }: ConversationTabProps) {
  const req = capture.request?.body || {};
  const sse = capture.response?.sse_events || [];
  // 仅在 SSE 事件列表变化时重建 assistant 回复，避免每次重渲染（含切换过滤chip）都跑一遍。
  // Rebuild the assistant reply only when the SSE event list changes, so
  // filter toggles and parent rerenders don't re-run this.
  const rebuiltAssistant = useMemo(() => rebuildAssistantFromSSE(sse), [sse]);

  // 构建时间线 + 渲染项：仅在请求体或重建结果变化时重算，filter 切换不会触发。
  // Build the chronological thread and the render-item list. Recompute only
  // when the request body or the rebuilt assistant changes — not on filter toggles.
  const { items, toolPairCount, textTurnCount } = useMemo(() => {
    const list: MessageType[] = [];
    if (req.system) {
      // system 可能是字符串，也可能是 {type:"text", text:"..."} 块数组。
      // 数组情形下抽出各块 .text 并拼接，保证后续按 markdown 渲染而非 JSON 转储。
      // system may be a string or an array of {type:"text", text:"..."} blocks.
      // For arrays, pull out each block's .text and join so it renders as markdown,
      // not as an escaped JSON dump.
      const sys =
        typeof req.system === "string"
          ? req.system
          : Array.isArray(req.system)
            ? (req.system as Array<{ text?: string }>)
                .map((b) => b?.text ?? "")
                .filter(Boolean)
                .join("\n\n")
            : JSON.stringify(req.system, null, 2);
      list.push({ role: "system", content: sys });
    }
    for (const m of req.messages || []) list.push(m);
    if (rebuiltAssistant) {
      list.push({
        role: "assistant",
        content: rebuiltAssistant,
        fromSSE: true,
      });
    }

    const built = buildConversationItems(list);
    const toolCount = built.filter((i) => i.kind === "tool-pair").length;
    const textCount = built.filter(
      (i) => i.kind !== "tool-pair" && i.kind !== "system",
    ).length;
    return { items: built, toolPairCount: toolCount, textTurnCount: textCount };
  }, [req, rebuiltAssistant]);

  // 过滤状态：默认全部开启。useState 保留在同一组件实例内，切换抓包时不重置。
  // Filter state: all on by default. Held in useState so switching captures
  // (same component instance) does not reset the chosen filters.
  const [filter, setFilter] = useState<Record<Bucket, boolean>>({
    system: true,
    user: true,
    assistant: true,
    tool: true,
  });
  const toggle = (b: Bucket) =>
    setFilter((prev) => ({ ...prev, [b]: !prev[b] }));

  // 每个桶的总数（与过滤状态无关，固定描述本次抓包）。
  // Per-bucket totals (independent of filter state; describe this capture).
  const counts: Record<Bucket, number> = {
    system: items.filter((it) => it.kind === "system").length,
    user: items.filter((it) => it.kind === "user").length,
    assistant: items.filter((it) => it.kind === "assistant").length,
    tool: toolPairCount,
  };

  const visibleItems = items.filter(
    (it) => bucketOf(it) === null || filter[bucketOf(it) as Bucket],
  );
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

      <h3 className="section conv-header">
        <span className="conv-title">
          Conversation · {textTurnCount} turns
          {toolPairCount ? ` · ${toolPairCount} tool calls` : ""}
        </span>
        <div className="conv-filter" role="group" aria-label="Filter by type">
          {(["system", "user", "assistant", "tool"] as Bucket[]).map((b) => (
            <button
              key={b}
              type="button"
              aria-pressed={filter[b]}
              className={`conv-chip${filter[b] ? "" : " off"}`}
              onClick={() => toggle(b)}
            >
              {b} · {counts[b]}
            </button>
          ))}
        </div>
      </h3>

      {visibleItems.length === 0 ? (
        <div className="conv-empty">all types hidden — toggle a filter to show items</div>
      ) : (
        visibleItems.map((it, i) => {
          switch (it.kind) {
            case "system":
              return <SystemMessage key={i} message={it.message} />;
            case "user":
              return <Message key={i} message={it.message} idx={it.idx} />;
            case "assistant":
              return <Message key={i} message={it.message} idx={it.idx} blocks={it.blocks} />;
            case "tool-pair":
              return <ToolPair key={i} toolUse={it.toolUse} toolResult={it.toolResult} />;
            default:
              return <Message key={i} message={it.message} idx={it.idx} />;
          }
        })
      )}
    </div>
  );
}
