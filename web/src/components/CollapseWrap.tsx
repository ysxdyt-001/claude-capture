import { useState, type ReactNode } from "react";

interface CollapseWrapProps {
  bodyHtml: string;
  bodyNode?: ReactNode;
}

// 长内容渐进展开：默认折叠，点击切换。
// Progressive disclosure: collapsed by default, toggle on click.
export default function CollapseWrap({ bodyHtml, bodyNode }: CollapseWrapProps) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`collapse-wrap${open ? " open" : ""}`}>
      <div className="collapse-body">
        {bodyNode ?? (
          <div dangerouslySetInnerHTML={{ __html: bodyHtml }} />
        )}
      </div>
      <button
        type="button"
        className="collapse-toggle"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="show-more">▼ expand</span>
        <span className="show-less">▲ collapse</span>
      </button>
    </div>
  );
}
