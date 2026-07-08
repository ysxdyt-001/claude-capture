import { escapeHtml } from "../lib/format";
import { highlightJSON } from "../lib/json";
import { smartRender } from "../lib/markdown";
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
    return `<div class="msg-thinking">${escapeHtml(
      (b as { thinking?: string }).thinking || "",
    )}</div>`;
  }
  if (b.type === "tool_use") {
    const tu = b as ToolUseBlock;
    const input = tu.input ?? {};
    const inputJson = JSON.stringify(input, null, 2);
    const isCompact = !inputJson.includes("\n") && inputJson.length <= 80;
    const inputHtml = isCompact
      ? `<code class="j-inline">${highlightJSON(inputJson)}</code>`
      : `<div class="j-block-wrap"><pre class="j-block">${highlightJSON(inputJson)}</pre></div>`;
    return `<div class="tool-call">
      <div class="tool-head">
        <span class="name">${escapeHtml(tu.name || "")}</span>
        <span class="tool-id">${escapeHtml(tu.id || "")}</span>
      </div>
      <div class="tool-input">${inputHtml}</div>
    </div>`;
  }
  if (b.type === "tool_result") {
    // Standalone tool_result rendered via ToolResult component below.
    return ""; // handled by caller
  }
  return `<pre class="json">${escapeHtml(JSON.stringify(b, null, 2))}</pre>`;
}

export default function Message({ message, idx, blocks }: MessageProps) {
  const role = message.role;
  const cls =
    role === "user"
      ? "user"
      : role === "assistant"
        ? "assistant"
        : role === "system"
          ? "system"
          : "tool";

  const bodyBlocks: { html: string; standaloneToolResults: ToolResultBlock[] } = {
    html: "",
    standaloneToolResults: [],
  };

  if (typeof message.content === "string") {
    bodyBlocks.html = `<div class="msg-text">${smartRender(message.content)}</div>`;
  } else if (
    blocks ??
    (Array.isArray(message.content) ? (message.content as ContentBlock[]) : null)
  ) {
    // 优先使用调用方传入的 blocks（已过滤 tool_use），否则回退到 message.content。
    // Prefer caller-supplied blocks (tool_use already filtered out); fall back to message.content.
    const source = blocks ?? (message.content as ContentBlock[]);
    for (const b of source) {
      if (b.type === "thinking") {
        // thinking handled by component below in assistant rendering path
        bodyBlocks.html += `<div class="msg-thinking">${escapeHtml(
          (b as { thinking?: string }).thinking || "",
        )}</div>`;
      } else if (b.type === "text") {
        bodyBlocks.html += `<div class="msg-text">${smartRender(
          (b as { text?: string }).text || "",
        )}</div>`;
      } else if (b.type === "tool_result") {
        bodyBlocks.standaloneToolResults.push(b as ToolResultBlock);
      } else {
        bodyBlocks.html += renderBlockHtml(b, role);
      }
    }
  } else {
    bodyBlocks.html = `<pre class="json">${escapeHtml(
      JSON.stringify(message.content, null, 2),
    )}</pre>`;
  }

  if (bodyBlocks.html === "" && bodyBlocks.standaloneToolResults.length === 0) {
    bodyBlocks.html =
      '<div class="msg-text" style="color:var(--text-faint);font-style:italic">— no textual content —</div>';
  }

  const tag = message.fromSSE ? `${role} · from SSE` : role;

  return (
    <div className={`msg ${cls}`}>
      {idx != null && <span className="turn-num">{String(idx).padStart(2, "0")}</span>}
      <div className="msg-role" dangerouslySetInnerHTML={{ __html: escapeHtml(tag) }} />
      <div className="msg-body">
        {bodyBlocks.html && <div dangerouslySetInnerHTML={{ __html: bodyBlocks.html }} />}
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
