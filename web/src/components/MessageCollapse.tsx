import { useMemo, useRef, useState } from "react";

interface MessageCollapseProps {
  // 原始内容（未渲染）。用于廉价测量大小并决定是否启用折叠。
  // Raw, unrendered content. Used for the cheap size check that decides
  // whether to collapse at all.
  rawText: string;
  // 预览渲染器：返回预览用的 HTML（通常是前几行渲染后的子串）。
  // Preview renderer: returns the HTML to show in the collapsed preview.
  renderPreview: () => string;
  // 完整渲染器：返回完整 HTML。仅在首次展开时调用一次，之后缓存。
  // Full renderer: returns the complete HTML. Called once on first expand,
  // then cached.
  renderFull: () => string;
  // 折叠阈值：默认 8000 字符或 100 行。调用方一般不传。
  // Collapse thresholds: default 8000 chars or 100 lines. Callers usually
  // omit and rely on the defaults.
  maxSize?: number;
  maxLines?: number;
}

const DEFAULT_MAX_SIZE = 8000;
const DEFAULT_MAX_LINES = 100;

export default function MessageCollapse({
  rawText,
  renderPreview,
  renderFull,
  maxSize = DEFAULT_MAX_SIZE,
  maxLines = DEFAULT_MAX_LINES,
}: MessageCollapseProps) {
  // 廉价测量：只在原始字符串上算长度和行数，不调用任何渲染器。
  // Cheap measurement on the raw string only — no renderer is invoked here.
  const lineCount = useMemo(() => {
    let n = 1;
    for (let i = 0; i < rawText.length; i++) {
      if (rawText.charCodeAt(i) === 10) n++;
    }
    return n;
  }, [rawText]);

  const shouldCollapse = rawText.length > maxSize || lineCount > maxLines;

  const [open, setOpen] = useState(false);
  // 完整 HTML 只在首次展开时构建，之后缓存在 ref 中。
  // Build the full HTML once on first expand; cache in a ref.
  const fullHtmlRef = useRef<string | null>(null);

  if (!shouldCollapse) {
    // 小内容快速路径：直接渲染完整 HTML，不加任何包裹。
    // Fast path for small content: render full HTML with no wrapper.
    return <div dangerouslySetInnerHTML={{ __html: renderFull() }} />;
  }

  const hiddenLines = Math.max(0, lineCount - 5);

  if (open) {
    if (fullHtmlRef.current === null) {
      fullHtmlRef.current = renderFull();
    }
    return (
      <div className="msg-collapse open">
        <div
          className="msg-collapse-full"
          dangerouslySetInnerHTML={{ __html: fullHtmlRef.current }}
        />
        <button type="button" className="msg-collapse-toggle" onClick={() => setOpen(false)}>
          ▲ collapse
        </button>
      </div>
    );
  }

  return (
    <div className="msg-collapse">
      <div className="msg-collapse-preview" dangerouslySetInnerHTML={{ __html: renderPreview() }} />
      <button type="button" className="msg-collapse-toggle" onClick={() => setOpen(true)}>
        ▼ {hiddenLines} more lines · expand
      </button>
    </div>
  );
}
