interface EmptyStateProps {
  big: string;
  small?: string;
  arrow?: boolean;
  style?: React.CSSProperties;
}

export default function EmptyState({
  big,
  small,
  arrow = false,
  style,
}: EmptyStateProps) {
  return (
    <div className="empty" style={style}>
      <div className="big">{big}</div>
      {small && (
        <div className="small">
          {arrow && <span className="arrow">←</span>}
          {small}
        </div>
      )}
    </div>
  );
}
