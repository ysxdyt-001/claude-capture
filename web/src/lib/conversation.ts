import type { ContentBlock, Message, ToolResultBlock, ToolUseBlock } from "../types";

export type ConversationItem =
  | { kind: "system"; message: Message }
  | { kind: "user"; message: Message; idx: number }
  | {
      kind: "assistant";
      message: Message;
      blocks: ContentBlock[];
      idx: number;
    }
  | {
      kind: "tool-pair";
      toolUse: ToolUseBlock;
      toolResult: ToolResultBlock | null;
    }
  | { kind: "other"; message: Message; idx: number };

// 遍历消息列表，输出渲染项。tool_use 块与匹配的 tool_result（按 tool_use_id）配对为一张卡片；
// 仅含 tool_result 的 user 消息被吸收，不单独渲染。
// Walk the message list and emit render-items. tool_use blocks are paired
// with their matching tool_result (by tool_use_id) so they render as one card;
// pure-tool-result user messages are absorbed and not rendered standalone.
export function buildConversationItems(messages: Message[]): ConversationItem[] {
  const resultsById = new Map<string, ToolResultBlock>();
  for (const m of messages) {
    if (Array.isArray(m?.content)) {
      for (const b of m.content as ContentBlock[]) {
        if (
          b &&
          (b as ToolResultBlock).type === "tool_result" &&
          (b as ToolResultBlock).tool_use_id
        ) {
          resultsById.set((b as ToolResultBlock).tool_use_id, b as ToolResultBlock);
        }
      }
    }
  }

  const items: ConversationItem[] = [];
  let turnIdx = 0;
  const bump = () => {
    turnIdx += 1;
    return turnIdx;
  };

  for (const m of messages) {
    if (m.role === "system") {
      items.push({ kind: "system", message: m });
      continue;
    }
    if (m.role === "user") {
      const c = m.content;
      if (
        Array.isArray(c) &&
        c.length > 0 &&
        c.every((b) => b && (b as ToolResultBlock).type === "tool_result")
      ) {
        continue;
      }
      items.push({ kind: "user", message: m, idx: bump() });
      continue;
    }
    if (m.role === "assistant") {
      const c = Array.isArray(m.content) ? (m.content as ContentBlock[]) : null;
      if (!c || c.length === 0) {
        items.push({
          kind: "assistant",
          message: m,
          blocks: [],
          idx: bump(),
        });
        continue;
      }
      // 把 assistant 内容拆成 prose-group 与 tool_use 调用交错出现。
      // Split assistant content into prose-groups interleaved with tool_use calls.
      let buf: ContentBlock[] = [];
      const flush = () => {
        if (buf.length > 0) {
          items.push({
            kind: "assistant",
            message: m,
            blocks: buf,
            idx: bump(),
          });
          buf = [];
        }
      };
      for (const b of c) {
        if (b && (b as ToolUseBlock).type === "tool_use") {
          flush();
          const tu = b as ToolUseBlock;
          const result = tu.id ? (resultsById.get(tu.id) ?? null) : null;
          items.push({ kind: "tool-pair", toolUse: tu, toolResult: result });
        } else {
          buf.push(b);
        }
      }
      flush();
      continue;
    }
    items.push({ kind: "other", message: m, idx: bump() });
  }
  return items;
}
