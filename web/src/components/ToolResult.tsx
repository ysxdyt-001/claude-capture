import type { ToolResultBlock, ToolResultContent } from "../types";
import { smartRender } from "../lib/markdown";
import { highlightJSON } from "../lib/json";
import { escapeHtml } from "../lib/format";
import CollapseWrap from "./CollapseWrap";

interface ToolResultProps {
  toolResult: ToolResultBlock;
  variant: "standalone" | "pair";
}

function renderContentSegments(c: ToolResultBlock["content"]): string {
  if (typeof c === "string") return smartRender(c);
  if (Array.isArray(c)) {
    return (c as ToolResultContent[])
      .map((seg) => {
        const s = seg as { type?: string; text?: string; source?: { type?: string } };
        if (s.type === "text") return smartRender(s.text || "");
        if (s.type === "image") {
          return `<div class="seg-image"><span class="seg-tag">image · ${escapeHtml(
            s.source?.type || "",
          )}</span></div>`;
        }
        return `<div class="j-block-wrap"><pre class="j-block">${highlightJSON(
          JSON.stringify(seg, null, 2),
        )}</pre></div>`;
      })
      .join("");
  }
  if (c && typeof c === "object") {
    return `<div class="j-block-wrap"><pre class="j-block">${highlightJSON(
      JSON.stringify(c, null, 2),
    )}</pre></div>`;
  }
  return `<div class="msg-text">${escapeHtml(String(c ?? ""))}</div>`;
}

export default function ToolResult({ toolResult, variant }: ToolResultProps) {
  const isErr = !!toolResult.is_error;
  const bodyHtml = renderContentSegments(toolResult.content);
  const lineGuess = (bodyHtml.match(/\n/g) || []).length;
  const shouldCollapse = bodyHtml.length > 1000 || lineGuess > 12;

  if (variant === "pair") {
    return (
      <div className={`tool-pair-result${isErr ? " err" : ""}`}>
        <div className="tool-pair-result-label">
          {isErr ? "error result" : "result"}
        </div>
        <div className="tool-pair-result-body">
          {shouldCollapse ? (
            <CollapseWrap bodyHtml={bodyHtml} />
          ) : (
            <div dangerouslySetInnerHTML={{ __html: bodyHtml }} />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={`tool-result${isErr ? " err" : ""}`}>
      <div className="tool-result-head">
        <span className="tool-result-label">{isErr ? "error" : "result"}</span>
        <span className="tool-id">{escapeHtml(toolResult.tool_use_id || "")}</span>
      </div>
      <div className="tool-result-body">
        {shouldCollapse ? (
          <CollapseWrap bodyHtml={bodyHtml} />
        ) : (
          <div dangerouslySetInnerHTML={{ __html: bodyHtml }} />
        )}
      </div>
    </div>
  );
}
