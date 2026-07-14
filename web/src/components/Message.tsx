import { memo, useMemo } from "react";
import { escapeHtml } from "../lib/format";
import { highlightJSON } from "../lib/json";
import { smartRender } from "../lib/markdown";
import { renderToolInput } from "../lib/toolInput";
import type { ContentBlock, Message as MessageType } from "../types";
import type { ToolResultBlock, ToolUseBlock } from "../types";
import ToolResult from "./ToolResult";

interface MessageProps {
  message: MessageType;
  idx?: number;
  // 可选的过滤后块列表；assistant 项传入以避免 tool_use 重复渲染。
  // Optional pre-filtered blocks; passed by assistant items to avoid duplicate tool_use rendering.
  blocks?: ContentBlock[];
}

function renderBlockHtml(b: ContentBlock, _role: string): string {
  // 用于 fallback 的零散块（孤儿 tool_use / tool_result）。
  // Used for orphan blocks not paired into ToolPair.
  if (b.type === "text") {
    return smartRender((b as { text?: string }).text || "");
  }
  if (b.type === "thinking") {
    return `<div class="msg-thinking">${smartRender(
      (b as { thinking?: string }).thinking || "",
    )}</div>`;
  }
  if (b.type === "tool_use") {
    // 孤儿 tool_use（未配对进 ToolPair）也走结构化渲染，保持视觉一致。
    // Orphan tool_use blocks (not paired into ToolPair) reuse the same
    // structured renderer so prose fields stay consistent across views.
    const tu = b as ToolUseBlock;
    return `<div class="tool-call">
      <div class="tool-head">
        <span class="name">${escapeHtml(tu.name || "")}</span>
        <span class="tool-id">${escapeHtml(tu.id || "")}</span>
      </div>
      <div class="tool-input">${renderToolInput(tu.input ?? {})}</div>
    </div>`;
  }
  if (b.type === "tool_result") {
    // Standalone tool_result rendered via ToolResult component below.
    return ""; // handled by caller
  }
  return `<pre class="json">${escapeHtml(JSON.stringify(b, null, 2))}</pre>`;
}

function MessageInner({ message, idx, blocks }: MessageProps) {
  const role = message.role;
  const cls =
    role === "user"
      ? "user"
      : role === "assistant"
        ? "assistant"
        : role === "system"
          ? "system"
          : "tool";

  // 缓存渲染产物：按 message.content 与可选 blocks 的序列化结果作为 key，
  // 同一消息在组件生命周期内只构建一次 HTML。
  // Cache rendered output: key on the serialized content + optional blocks so
  // the same message builds its HTML once for the component's lifetime.
  const bodyBlocks = useMemo<{
    html: string;
    standaloneToolResults: ToolResultBlock[];
  }>(() => {
    const out = { html: "", standaloneToolResults: [] as ToolResultBlock[] };

    if (typeof message.content === "string") {
      out.html = `<div class="msg-text">${smartRender(message.content)}</div>`;
      return out;
    }

    const source =
      blocks ?? (Array.isArray(message.content) ? (message.content as ContentBlock[]) : null);

    if (source) {
      // 优先使用调用方传入的 blocks（已过滤 tool_use），否则回退到 message.content。
      // Prefer caller-supplied blocks (tool_use already filtered out); fall back to message.content.
      for (const b of source) {
        if (b.type === "thinking") {
          const text = (b as { thinking?: string }).thinking || "";
          const words = (text.match(/\S+/g) || []).length;
          if (words) {
            out.html += `<details class="thinking-block">
    <summary><span class="msg-role">thinking · ${words} words</span></summary>
    <div class="msg-thinking">${smartRender(text)}</div>
  </details>`;
          }
        } else if (b.type === "text") {
          out.html += `<div class="msg-text">${smartRender(
            (b as { text?: string }).text || "",
          )}</div>`;
        } else if (b.type === "tool_result") {
          out.standaloneToolResults.push(b as ToolResultBlock);
        } else {
          out.html += renderBlockHtml(b, role);
        }
      }
      return out;
    }

    out.html = `<pre class="json">${escapeHtml(JSON.stringify(message.content, null, 2))}</pre>`;
    return out;
  }, [message, blocks, role]);

  // 空内容占位符：通过独立 memo 计算，避免直接修改已缓存的 bodyBlocks。
  // Empty-state placeholder: computed via its own memo to avoid mutating the
  // already-memoized bodyBlocks object during render (React forbids that).
  const effectiveHtml = useMemo(() => {
    if (bodyBlocks.html === "" && bodyBlocks.standaloneToolResults.length === 0) {
      return `<div class="msg-text" style="color:var(--text-faint);font-style:italic">— no textual content —</div>`;
    }
    return bodyBlocks.html;
  }, [bodyBlocks]);

  const tag = message.fromSSE ? `${role} · from SSE` : role;

  return (
    <div className={`msg ${cls}`}>
      {idx != null && <span className="turn-num">{String(idx).padStart(2, "0")}</span>}
      <div className="msg-role" dangerouslySetInnerHTML={{ __html: escapeHtml(tag) }} />
      <div className="msg-body">
        {effectiveHtml && <div dangerouslySetInnerHTML={{ __html: effectiveHtml }} />}
        {bodyBlocks.standaloneToolResults.map((tr, i) => (
          <ToolResult key={i} toolResult={tr} variant="standalone" />
        ))}
      </div>
    </div>
  );
}

// System message renders as collapsible <details>; separate export.
export function SystemMessage({ message }: { message: MessageType }) {
  const text =
    typeof message.content === "string"
      ? message.content
      : JSON.stringify(message.content, null, 2);
  const words = (text.match(/\S+/g) || []).length;
  const body =
    typeof message.content === "string"
      ? smartRender(message.content)
      : `<div class="j-block-wrap"><pre class="j-block">${highlightJSON(text)}</pre></div>`;
  return (
    <details className="msg system collapsible-card">
      <summary>
        <span className="msg-role">system · {words} words</span>
        <span className="collapse-hint">collapsed — click to read</span>
      </summary>
      <div className="msg-body" dangerouslySetInnerHTML={{ __html: body }} />
    </details>
  );
}

// 仅在 message/blocks/idx 变化时重渲染，避开 3 秒轮询引发的整树重渲染。
// Only rerender when message/blocks/idx change, sidestepping the 3s poll
// cascade that would otherwise rebuild the entire conversation subtree.
export default memo(MessageInner);
