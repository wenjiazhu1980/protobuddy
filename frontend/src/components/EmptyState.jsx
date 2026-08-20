/**
 * 统一空态组件：icon / title / desc / action。
 * 复用现有 .empty-state* 样式。
 */
export default function EmptyState({ icon, title, desc, action }) {
  return (
    <div className="empty-state">
      {icon && <div className="empty-state-icon">{icon}</div>}
      {title && <div className="empty-state-title">{title}</div>}
      {desc && <div className="empty-state-desc">{desc}</div>}
      {action && <div style={{ marginTop: 16 }}>{action}</div>}
    </div>
  );
}
