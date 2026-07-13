import { escapeHtml } from "./format";
import { highlightJSON } from "./json";
import { smartRender } from "./markdown";
import { highlightShell } from "./shell";

// 允许渲染为 markdown 的"散文型"字段名。按键名匹配，跨工具通用。
// Prose-shaped field names allowed to render as markdown. Matched by leaf
// key name so the rule generalizes across tools without per-tool config.
export const MARKDOWN_FIELDS = new Set([
  "description",
  "preview",
  "subject",
  "question",
  "reason",
  "comment",
  "message",
  "prompt",
  "summary",
  "body",
  "explanation",
  "note",
  "notes",
]);

// 按 shell 语法高亮的字段名（命令/脚本）。优先级高于 markdown 与 JSON。
// Field names highlighted as shell syntax (commands/scripts). Checked before
// the markdown and JSON branches in renderScalar.
export const SHELL_FIELDS = new Set(["command", "script", "cmd", "shell"]);

// 判断字符串是否含有 markdown 信号：换行、标题、强调、代码、列表、引用、表格。
// Detect markdown signals so we only invoke the markdown renderer when relevant.
function hasMarkdownSignal(s: string): boolean {
  return (
    s.includes("\n") ||
    /(^|\s)#{1,6}\s/.test(s) ||
    /(^|\s)\*[^*\n]/.test(s) ||
    /(^|\s)_[^_\n]/.test(s) ||
    s.includes("`") ||
    /(^|\s)[-*+]\s/.test(s) ||
    /^>\s?/.test(s) ||
    s.includes("|") ||
    s.length > 80
  );
}

function renderScalar(value: string, keyHint?: string): string {
  // shell 命令字段 → 走 highlightShell，保留真实换行与语法高亮。
  // Shell command fields → highlightShell, preserving real newlines and
  // syntax highlighting instead of JSON-escaping into one quoted line.
  if (keyHint && SHELL_FIELDS.has(keyHint)) {
    return `<pre class="sh-block">${highlightShell(value)}</pre>`;
  }
  // allowlist 命中且含 markdown 信号 → 走 smartRender（内部自动 JSON/markdown 分流）。
  // Allowlist hit with markdown signals → smartRender (auto JSON/markdown split).
  if (keyHint && MARKDOWN_FIELDS.has(keyHint) && hasMarkdownSignal(value)) {
    return `<div class="msg-text">${smartRender(value)}</div>`;
  }
  // 短的单行字符串 → 内联 code；长或多行 → <pre> 中保留真实换行（仅转义，不 JSON 化）。
  // Short single-line strings render inline; long/multiline render in a <pre>
  // with real newlines preserved (escaped, not JSON-escaped into "\n").
  if (!value.includes("\n") && value.length <= 80) {
    return `<code class="j-inline">${escapeHtml(value)}</code>`;
  }
  return `<div class="j-block-wrap"><pre class="j-block">${escapeHtml(value)}</pre></div>`;
}

// 选项数组判定：元素都是带 label + description 的对象（AskUserQuestion.options 形态）。
// 用结构而非工具名判定，自动覆盖 label+description 形态的字段，无需 per-tool 配置。
// Detect an options-shaped array: every element is an object with label + description
// (the AskUserQuestion.options shape). Structural — not tool-named — so it generalizes
// to any label+description field without per-tool config.
function _isOptionArray(value: unknown[]): boolean {
  if (value.length === 0) return false;
  return value.every(
    (el) =>
      !!el &&
      typeof el === "object" &&
      !Array.isArray(el) &&
      "label" in (el as object) &&
      "description" in (el as object)
  );
}

// 递归渲染工具输入。object → 字段行；array → 元素卡片；标量 → 内联或 markdown。
// Recursively render a tool input. object → field rows; array → element cards;
// scalars → inline or markdown depending on allowlist + signals.
export function renderToolInput(value: unknown, keyHint?: string): string {
  if (value == null) {
    return `<code class="j-inline">${escapeHtml(String(value))}</code>`;
  }
  if (typeof value === "string") {
    return renderScalar(value, keyHint);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return `<code class="j-inline">${highlightJSON(JSON.stringify(value))}</code>`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return `<code class="j-inline">[]</code>`;
    }
    // 选项数组特例：元素形如 {label, description}（AskUserQuestion.options 等）。
    // 渲染成横向 wrap 的 chip 卡片，而非默认的竖向编号行，对齐 Claude Code 原生 UI。
    // Option-array special case: elements shaped like {label, description}
    // (AskUserQuestion.options, etc.) render as a horizontal wrap of chips to
    // mirror Claude Code's native UI instead of the default vertical numbered rows.
    if (_isOptionArray(value)) {
      const chips = value
        .map((el) => {
          const opt = el as { label?: unknown; description?: unknown };
          const labelHtml = renderToolInput(opt.label ?? "", "label");
          const descHtml =
            opt.description == null
              ? ""
              : `<div class="input-option-desc">${renderToolInput(opt.description, "description")}</div>`;
          return `<div class="input-option"><div class="input-option-label">${labelHtml}</div>${descHtml}</div>`;
        })
        .join("");
      return `<div class="input-options">${chips}</div>`;
    }
    const items = value
      .map((el, i) => {
        const inner = renderToolInput(el, "");
        // 元素是对象时编号成卡片，便于阅读嵌套 description / preview。
        // Number object elements as cards so nested prose surfaces cleanly.
        if (el && typeof el === "object" && !Array.isArray(el)) {
          return `<div class="input-row"><div class="input-key">#${i + 1}</div><div class="input-val">${inner}</div></div>`;
        }
        return `<div class="input-val">${inner}</div>`;
      })
      .join("");
    return `<div class="input-array">${items}</div>`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      return `<code class="j-inline">{}</code>`;
    }
    const rows = entries
      .map(([k, v]) => {
        const inner = renderToolInput(v, k);
        return `<div class="input-row"><div class="input-key">${escapeHtml(k)}</div><div class="input-val">${inner}</div></div>`;
      })
      .join("");
    return `<div class="input-obj">${rows}</div>`;
  }
  return `<code class="j-inline">${escapeHtml(String(value))}</code>`;
}
