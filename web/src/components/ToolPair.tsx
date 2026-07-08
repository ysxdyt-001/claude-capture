import type { ToolResultBlock, ToolUseBlock } from "../types";
import { highlightJSON } from "../lib/json";
import { escapeHtml } from "../lib/format";
import ToolResult from "./ToolResult";

interface ToolPairProps {
  toolUse: ToolUseBlock;
  toolResult: ToolResultBlock | null;
}

export default function ToolPair({ toolUse, toolResult }: ToolPairProps) {
  const input = toolUse.input ?? {};
  const inputJson = JSON.stringify(input, null, 2);
  const isCompact = !inputJson.includes("\n") && inputJson.length <= 80;
  const inputInner = isCompact ? (
    <code
      className="j-inline"
      dangerouslySetInnerHTML={{ __html: highlightJSON(inputJson) }}
    />
  ) : (
    <pre
      className="j-block flat"
      dangerouslySetInnerHTML={{ __html: highlightJSON(inputJson) }}
    />
  );

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
      <div className="tool-pair-input">{inputInner}</div>
      {toolResult && <ToolResult toolResult={toolResult} variant="pair" />}
    </div>
  );
}
