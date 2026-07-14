import { memo, useCallback, useMemo } from "react";
import { escapeHtml } from "../lib/format";
import { highlightJSON } from "../lib/json";
import { smartRender } from "../lib/markdown";
import { renderToolInput } from "../lib/toolInput";
import type { ContentBlock, Message as MessageType } from "../types";
import type { ToolResultBlock, ToolUseBlock } from "../types";
import MessageCollapse from "./MessageCollapse";
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

  // 仅抽取 tool_result 块（廉价、无 smartRender 调用）。这部分在 MessageCollapse 之外
  // 渲染，必须提前可用。
  // Extract tool_result blocks only (cheap, no smartRender). These render as
  // siblings to MessageCollapse and must be available up front.
  const standaloneToolResults = useMemo<ToolResultBlock[]>(() => {
    if (typeof message.content !== "string" && Array.isArray(message.content)) {
      const src = blocks ?? (message.content as ContentBlock[]);
      return src.filter((b): b is ToolResultBlock => b?.type === "tool_result");
    }
    return [];
  }, [message, blocks]);

  // 构建完整 HTML：仅由 MessageCollapse 在快路径（小消息）或首次展开（大消息）时调用。
  // 绝不在 MessageInner 自己的渲染阶段执行 —— 这是 Layer B 延迟渲染承诺的关键。
  // Build full HTML: invoked ONLY by MessageCollapse, either in its fast path
  // (small messages) or on first expand (large messages). Never call this
  // during MessageInner's own render — that is the entirety of Layer B's
  // lazy-render promise.
  const buildFullHtml = useCallback((): string => {
    let html = "";

    if (typeof message.content === "string") {
      html = `<div class="msg-text">${smartRender(message.content)}</div>`;
      return html;
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
            html += `<details class="thinking-block">
    <summary><span class="msg-role">thinking · ${words} words</span></summary>
    <div class="msg-thinking">${smartRender(text)}</div>
  </details>`;
          }
        } else if (b.type === "text") {
          html += `<div class="msg-text">${smartRender((b as { text?: string }).text || "")}</div>`;
        } else if (b.type !== "tool_result") {
          html += renderBlockHtml(b, role);
        }
        // tool_result handled by standaloneToolResults; skip here.
      }
      if (html === "") {
        // tool_result-only message with no prose: fall back to the no-content placeholder.
        return '<div class="msg-text" style="color:var(--text-faint);font-style:italic">— no textual content —</div>';
      }
      return html;
    }

    return `<pre class="json">${escapeHtml(JSON.stringify(message.content, null, 2))}</pre>`;
  }, [message, blocks, role]);

  // 提取原始文本供 MessageCollapse 做廉价大小判断。字符串内容直接用；
  // 块数组则按顺序拼接 text/thinking/tool_use/tool_result 块的文本。
  // Extract raw text for MessageCollapse's cheap size check. String content
  // is used as-is; block arrays are concatenated from
  // text/thinking/tool_use/tool_result blocks.
  const rawText = useMemo(() => {
    if (typeof message.content === "string") return message.content;
    const src = blocks ?? (Array.isArray(message.content) ? message.content : []);
    return (src as ContentBlock[])
      .map((b) => {
        if (b.type === "text") return (b as { text?: string }).text || "";
        if (b.type === "thinking") return (b as { thinking?: string }).thinking || "";
        if (b.type === "tool_use") {
          return JSON.stringify((b as ToolUseBlock).input ?? {});
        }
        if (b.type === "tool_result") {
          const c = (b as ToolResultBlock).content;
          return typeof c === "string" ? c : JSON.stringify(c ?? "");
        }
        return "";
      })
      .join("\n");
  }, [message, blocks]);

  // 预览渲染器：取前 6 行做 smartRender。仅由 MessageCollapse 在折叠分支中调用。
  // Preview renderer: smartRender the first 6 lines. Called only by
  // MessageCollapse in its collapsed branch.
  const buildPreviewHtml = useCallback((): string => {
    const lines = rawText.split("\n", 6);
    return smartRender(lines.join("\n"));
  }, [rawText]);

  const tag = message.fromSSE ? `${role} · from SSE` : role;

  // ⚠️ MessageCollapse 的延迟渲染依赖 MessageInner 自身的 React.memo：
  //    - 小消息走快路径，buildFullHtml 立即被调用一次（等价于原来的同步渲染）。
  //    - 大消息只在用户点击展开时才调用 buildFullHtml。
  //    若移除 MessageInner 的 memo，每次父组件重渲染都会重新挂载/调用 buildFullHtml，
  //    Layer B 的延迟承诺将失效。修改前请三思。
  // ⚠️ MessageCollapse's lazy-render depends on MessageInner's own React.memo:
  //    - small messages hit the fast path, buildFullHtml is called once
  //      (equivalent to the old eager render).
  //    - large messages only call buildFullHtml on first user-initiated expand.
  //    If MessageInner's memo is removed, every parent rerender will re-invoke
  //    buildFullHtml and Layer B's lazy promise is void. Think twice before
  //    removing the memo.
  return (
    <div className={`msg ${cls}`}>
      {idx != null && <span className="turn-num">{String(idx).padStart(2, "0")}</span>}
      <div className="msg-role" dangerouslySetInnerHTML={{ __html: escapeHtml(tag) }} />
      <div className="msg-body">
        <MessageCollapse
          rawText={rawText}
          renderPreview={buildPreviewHtml}
          renderFull={buildFullHtml}
        />
        {standaloneToolResults.map((tr, i) => (
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
