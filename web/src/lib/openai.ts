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
import type { Capture } from "../types";

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
