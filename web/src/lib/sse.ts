import type { ContentBlock, SseEvent } from "../types";

interface RebuildBlock {
  type?: string;
  text?: string;
  thinking?: string;
  input?: unknown;
  _raw_input?: string;
  [k: string]: unknown;
}

// 从 SSE 事件序列重建 assistant 的 content blocks。
// Reconstruct assistant content blocks from the SSE event stream.
export function rebuildAssistantFromSSE(
  events: SseEvent[] | undefined,
): ContentBlock[] | null {
  if (!events || events.length === 0) return null;
  const blocks = new Map<number, RebuildBlock>();
  const order: number[] = [];
  for (const ev of events) {
    const d = ev.data;
    if (!d || typeof d === "string") continue;
    const data = d as Record<string, unknown>;
    if (ev.event === "content_block_start" && typeof data.index === "number") {
      if (!blocks.has(data.index)) {
        const cb = (data.content_block || {}) as Record<string, unknown>;
        blocks.set(data.index, { ...cb });
        order.push(data.index);
      }
    }
    if (ev.event === "content_block_delta" && typeof data.index === "number") {
      const blk = blocks.get(data.index);
      if (!blk) continue;
      const delta = (data.delta || {}) as Record<string, unknown>;
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        blk.text = (blk.text || "") + delta.text;
      } else if (
        delta.type === "thinking_delta" &&
        typeof delta.thinking === "string"
      ) {
        blk.thinking = (blk.thinking || "") + delta.thinking;
      } else if (
        delta.type === "input_json_delta" &&
        typeof delta.partial_json === "string"
      ) {
        blk._raw_input = (blk._raw_input || "") + delta.partial_json;
      }
    }
  }
  if (order.length === 0) return null;
  return order.map((i) => {
    const blk = blocks.get(i)!;
    if (blk.type === "tool_use" && blk._raw_input) {
      try {
        blk.input = JSON.parse(blk._raw_input);
      } catch {
        /* leave input undefined */
      }
      delete blk._raw_input;
    }
    return blk as unknown as ContentBlock;
  });
}
