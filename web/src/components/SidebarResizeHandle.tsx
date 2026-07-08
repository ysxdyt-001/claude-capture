interface SidebarResizeHandleProps {
  currentWidth: number;
  onResize: (width: number) => void; // 实时更新（拖动中）
  onCommit: (width: number) => void; // mouseup 时触发一次（父组件持久化）
  min: number;
  max: number;
}

// 侧边栏拖拽分隔条：仅鼠标交互，touch 留给未来。
// Sidebar drag handle: mouse-only; touch deferred to a future iteration.
export default function SidebarResizeHandle({
  currentWidth,
  onResize,
  onCommit,
  min,
  max,
}: SidebarResizeHandleProps) {
  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = currentWidth;
    let finalWidth = startWidth;
    const onMove = (ev: MouseEvent) => {
      const next = Math.max(min, Math.min(max, startWidth + (ev.clientX - startX)));
      finalWidth = next;
      onResize(next);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      onCommit(finalWidth);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  return (
    <div
      className="sidebar-resize-handle"
      onMouseDown={onMouseDown}
      role="separator"
      tabIndex={-1}
      aria-orientation="vertical"
      aria-valuenow={currentWidth}
      aria-valuemin={min}
      aria-valuemax={max}
    />
  );
}
