/*
 * OpenAI-spec capture 适配层。
 *
 * 抓包层面 addon 已经记录了 /chat/completions 与 /completions 的原始字节，
 * 但 viewer 的内部模型（Message / ContentBlock / ToolUseBlock）是按 Anthropic
 * /messages 的形状设计的。本模块在 /api/file 加载时做形状嗅探与归一化翻译，
 * 让下游组件（ConversationTab / buildConversationItems / Message / ToolPair）零改动。
 *
 * Boundary adapter for OpenAI-spec captures. The addon already records raw bytes
 * for /chat/completions and /completions, but the viewer's internal model follows
 * Anthropic's /messages shape. This module sniffs and translates at /api/file
 * load time so downstream components stay unchanged.
 *
 * 翻译映射见 docs/superpowers/specs/2026-07-15-openai-completions-support-design.md
 * See the design doc for the full mapping table.
 */
import type {
  Capture,
  ContentBlock,
  Message,
  RequestBody,
  SseEvent,
  TextBlock,
  ToolUseBlock,
} from "../types";

/**
 * 嗅探 capture 形状，判定是 OpenAI 规范还是 Anthropic 原生。
 * 三条件任一命中即判 OpenAI；都不命中则默认 Anthropic（历史行为）。
 *
 * Sniff the capture shape. Any one of three conditions → "openai".
 * Otherwise default to "anthropic" (historical behavior — better to under-classify
 * than to mistranslate a known shape).
 */
export function detectFormat(capture: Capture): "openai" | "anthropic" {
  const res = capture.response;
  const reqBody = capture.request?.body;

  // 1. 非流式响应体含 choices[]。
  //    Non-streaming response body contains a choices[] array.
  const bodyObj =
    res?.body && typeof res.body === "object" ? (res.body as Record<string, unknown>) : null;
  if (bodyObj && Array.isArray(bodyObj.choices)) return "openai";

  // 2. SSE 事件里有 data.choices[]。
  //    Any SSE event has data.choices[].
  const sse = res?.sse_events;
  if (sse && sse.length > 0) {
    for (const ev of sse) {
      const d = ev.data;
      if (d && typeof d === "object" && Array.isArray((d as Record<string, unknown>).choices)) {
        return "openai";
      }
    }
  }

  // 3. 请求体有 messages[].tool_calls 或 tool_call_id，且没有顶层 system。
  //    Request body has messages[].tool_calls / tool_call_id but no top-level system.
  if (reqBody && Array.isArray(reqBody.messages) && reqBody.system === undefined) {
    for (const m of reqBody.messages) {
      if (m && typeof m === "object") {
        if ("tool_calls" in m || "tool_call_id" in m) return "openai";
      }
    }
  }

  return "anthropic";
}

// 把 OpenAI 的 tool_calls（arguments 是 JSON 字符串）转成 Anthropic 的 tool_use 块。
// Convert OpenAI tool_calls (where arguments is a JSON string) to Anthropic tool_use blocks.
function translateToolCalls(toolCalls: unknown[]): ToolUseBlock[] {
  const out: ToolUseBlock[] = [];
  for (const raw of toolCalls) {
    if (!raw || typeof raw !== "object") continue;
    const tc = raw as Record<string, unknown>;
    const fn = tc.function as Record<string, unknown> | undefined;
    const id = typeof tc.id === "string" ? tc.id : "";
    const name = typeof fn?.name === "string" ? fn.name : "";
    // arguments 通常是 JSON 字符串；解析失败时保留原始字符串，ToolPair 仍能渲染。
    // arguments is normally a JSON string; on parse failure keep the raw string
    // so ToolPair still renders something.
    const argsRaw = typeof fn?.arguments === "string" ? fn.arguments : "";
    let input: unknown = argsRaw;
    if (argsRaw) {
      try {
        input = JSON.parse(argsRaw);
      } catch {
        /* 保留原始字符串 / keep raw string */
      }
    }
    out.push({ type: "tool_use", id, name, input });
  }
  return out;
}

// 规范化 user.content：字符串原样保留；parts[] 只取 {type:"text"} 块。
// Normalize user.content: keep strings as-is; from parts[] only carry {type:"text"} blocks.
function translateUserContent(content: unknown): Message["content"] {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const blocks: TextBlock[] = [];
    for (const p of content) {
      if (p && typeof p === "object" && (p as Record<string, unknown>).type === "text") {
        const text = (p as Record<string, { text?: unknown }>).text;
        if (typeof text === "string") blocks.push({ type: "text", text });
      }
    }
    return blocks.length > 0 ? blocks : null;
  }
  return null;
}

/**
 * 翻译 OpenAI 请求体为 Anthropic-shape：
 *   - role=system 的消息抽出来拼成顶层 system 字符串
 *   - role=tool 的消息合成 user + tool_result 块（让 buildConversationItems 的配对逻辑生效）
 *   - assistant.tool_calls → tool_use 块
 * 详见 design doc 中的 mapping table。
 *
 * Translate the OpenAI request body to Anthropic-shape:
 *   - role=system messages are pulled out and concatenated into top-level `system`
 *   - role=tool messages are synthesized as user + tool_result blocks (so
 *     buildConversationItems pairing works unchanged)
 *   - assistant.tool_calls → tool_use blocks
 */
export function translateOpenAIRequest(reqBody: RequestBody): RequestBody {
  const msgs = Array.isArray(reqBody.messages) ? reqBody.messages : [];
  const outMessages: Message[] = [];
  const systemParts: string[] = [];

  for (const m of msgs) {
    if (!m || typeof m !== "object") continue;
    const role = (m as Message).role;
    if (role === "system") {
      // system 消息内容拼成字符串，进顶层 system。
      // Concatenate system message contents into the top-level system string.
      const c = (m as Message).content;
      const text = typeof c === "string" ? c : c == null ? "" : safeStringify(c);
      if (text) systemParts.push(text);
      continue;
    }
    if (role === "tool") {
      // role=tool 的消息合成 user + tool_result 块。tool_call_id ↔ tool_use_id。
      // Synthesize a user message with a tool_result block. tool_call_id ↔ tool_use_id.
      const toolCallId = typeof (m as { tool_call_id?: unknown }).tool_call_id === "string"
        ? ((m as unknown as { tool_call_id: string }).tool_call_id)
        : "";
      outMessages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolCallId,
            content: (m as Message).content ?? null,
          },
        ],
      });
      continue;
    }
    if (role === "assistant") {
      const toolCalls = (m as { tool_calls?: unknown[] }).tool_calls;
      const blocks: ContentBlock[] = [];
      const text = translateUserContent((m as Message).content);
      if (typeof text === "string" && text.length > 0) {
        blocks.push({ type: "text", text });
      } else if (Array.isArray(text)) {
        for (const b of text) blocks.push(b);
      }
      if (Array.isArray(toolCalls)) {
        for (const tu of translateToolCalls(toolCalls)) blocks.push(tu);
      }
      outMessages.push({
        role: "assistant",
        content: blocks.length > 0 ? blocks : null,
      });
      continue;
    }
    // user / 其他：直接透传 content 规范化结果。
    // user / other: pass through with normalized content.
    outMessages.push({
      role: (role as string) || "user",
      content: translateUserContent((m as Message).content),
    });
  }

  // tools: [{type:"function", function:{name, parameters}}] → [{name, ...}]
  // 保留原始 function.parameters 以便 Raw JSON 仍可查看。
  // Rewrite tools so the "declared" counter keeps working; preserve parameters for Raw JSON.
  let tools = reqBody.tools;
  if (Array.isArray(tools)) {
    tools = tools.map((t) => {
      const fn = (t as { function?: Record<string, unknown> })?.function;
      if (fn && typeof fn.name === "string") {
        return { name: fn.name, ...(t as object) };
      }
      return t;
    });
  }

  const out: RequestBody = { ...reqBody, messages: outMessages, tools };
  if (systemParts.length > 0) {
    out.system = systemParts.join("\n\n");
  } else {
    delete out.system;
  }
  return out;
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

// 流式片段里的 tool_call 增量：按 index 聚合 id/name/arguments 片段。
// Streaming tool_call deltas: aggregate id/name/arguments fragments by index.
interface _StreamingToolCall {
  index: number;
  id?: string;
  name?: string;
  argsBuf: string;
  firstSeen: number; // 用于输出排序 / for output ordering
}

/**
 * 从 OpenAI 的 SSE chunk 序列重建 assistant 的 content blocks。
 *
 * Reconstruct assistant content blocks from an OpenAI SSE chunk sequence.
 *
 * 规则 / Rules:
 *   - 所有 delta.content 片段拼到一个 TextBlock
 *   - delta.tool_calls[] 按 index 聚合：首个片段带 id+name，后续片段只带 arguments 片段
 *   - data === "[DONE]" 是终止符，忽略
 *   - 输出顺序固定：[TextBlock?, ...ToolUseBlocks by first-seen index]
 *     （OpenAI 实际流式里 content 先于 tool_calls，这里固定顺序，Raw JSON tab 是真相）
 *
 * Output order is fixed (text-then-tools) regardless of arrival order; the Raw JSON
 * tab preserves the original chunk sequence as ground truth.
 */
export function rebuildAssistantFromOpenAISSE(
  events: SseEvent[] | undefined,
): ContentBlock[] | null {
  if (!events || events.length === 0) return null;

  let textBuf = "";
  let textSeen = false;
  const tcByIndex = new Map<number, _StreamingToolCall>();
  const order: number[] = [];
  let seq = 0;

  for (const ev of events) {
    const d = ev.data;
    // [DONE] 终止符：data 是字符串 "[DONE]"。
    // [DONE] terminator: data is the string "[DONE]".
    if (typeof d === "string") {
      if (d.trim() === "[DONE]") continue;
      // 其它字符串 data 忽略（OpenAI 不应该出现，但兜底）。
      // Ignore other string data (shouldn't happen for OpenAI, but be safe).
      continue;
    }
    if (!d || typeof d !== "object") continue;

    const choices = (d as Record<string, unknown>).choices;
    if (!Array.isArray(choices) || choices.length === 0) continue;
    const choice0 = choices[0] as Record<string, unknown> | undefined;
    const delta = choice0?.delta as Record<string, unknown> | undefined;
    if (!delta) continue;

    if (typeof delta.content === "string" && delta.content.length > 0) {
      textBuf += delta.content;
      textSeen = true;
    }

    const tcs = delta.tool_calls;
    if (Array.isArray(tcs)) {
      for (const raw of tcs) {
        if (!raw || typeof raw !== "object") continue;
        const tc = raw as Record<string, unknown>;
        const idx = typeof tc.index === "number" ? tc.index : 0;
        let entry = tcByIndex.get(idx);
        if (!entry) {
          entry = { index: idx, argsBuf: "", firstSeen: seq++ };
          tcByIndex.set(idx, entry);
          order.push(idx);
        }
        const fn = tc.function as Record<string, unknown> | undefined;
        if (typeof tc.id === "string") entry.id = tc.id;
        if (fn && typeof fn.name === "string") entry.name = fn.name;
        if (fn && typeof fn.arguments === "string") entry.argsBuf += fn.arguments;
      }
    }
  }

  const blocks: ContentBlock[] = [];
  if (textSeen) {
    blocks.push({ type: "text", text: textBuf });
  }
  // 按 first-seen 顺序输出 tool_use 块；解析失败的 arguments 保留原始字符串。
  // Emit tool_use blocks in first-seen order; on parse failure keep raw args string.
  const sorted = [...tcByIndex.values()].sort((a, b) => a.firstSeen - b.firstSeen);
  for (const entry of sorted) {
    let input: unknown = entry.argsBuf;
    if (entry.argsBuf) {
      try {
        input = JSON.parse(entry.argsBuf);
      } catch {
        /* 保留原始字符串 / keep raw */
      }
    }
    blocks.push({
      type: "tool_use",
      id: entry.id ?? "",
      name: entry.name ?? "",
      input,
    });
  }

  if (blocks.length === 0) return null;
  return blocks;
}
