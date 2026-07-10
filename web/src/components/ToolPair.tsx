import { escapeHtml } from "../lib/format";
import { renderToolInput } from "../lib/toolInput";
import type { ToolResultBlock, ToolUseBlock } from "../types";
import ToolResult from "./ToolResult";

interface ToolPairProps {
  toolUse: ToolUseBlock;
  toolResult: ToolResultBlock | null;
}

export default function ToolPair({ toolUse, toolResult }: ToolPairProps) {
  // 工具输入按字段递归渲染：allowlist 中的散文字段走 markdown，其余保持 JSON/内联。
  // Tool input renders recursively: prose fields in the allowlist go through
  // markdown; structural fields stay as JSON or inline code.
  const inputHtml = renderToolInput(toolUse.input ?? {});

  return (
    <div className="tool-pair">
      <div className="tool-pair-head">
        <span
          className="name"
          dangerouslySetInnerHTML={{ __html: escapeHtml(toolUse.name || "") }}
        />
        <span
          className="tool-id"
          dangerouslySetInnerHTML={{ __html: escapeHtml(toolUse.id || "") }}
        />
      </div>
      <div
        className="tool-pair-input"
        dangerouslySetInnerHTML={{ __html: inputHtml }}
      />
      {toolResult && <ToolResult toolResult={toolResult} variant="pair" />}
    </div>
  );
}
