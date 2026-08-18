import { useState } from 'react';

const STATUS_META = {
  open:     { label: '待处理', badge: 'badge-orange', pinClass: '' },
  resolved: { label: '已解决', badge: 'badge-green',  pinClass: 'resolved' },
  rejected: { label: '不采纳', badge: 'badge-gray',   pinClass: 'rejected' }
};

const FILTERS = [
  { key: 'all',      label: '全部' },
  { key: 'open',     label: '待处理' },
  { key: 'resolved', label: '已解决' },
  { key: 'rejected', label: '不采纳' }
];

/**
 * AnnotationLayer - panel showing all annotations for the current version.
 * Supports marking annotations as resolved (已解决) or rejected (不采纳).
 */
export default function AnnotationLayer({ annotations, onResolve, onReject, onReopen, onDelete, onGeneratePlan, activeId, onActive, generating, isOpen = true, onToggle }) {
  const [filter, setFilter] = useState('all');

  const countBy = (s) => annotations.filter(a => a.status === s).length;
  const openCount = countBy('open');
  const resolvedCount = countBy('resolved');
  const rejectedCount = countBy('rejected');

  const filtered = annotations.filter(a => {
    if (filter === 'all') return true;
    return a.status === filter;
  });

  if (!isOpen) {
    return (
      <div className="annotation-panel annotation-panel-collapsed" title="展开批注列表">
        <button
          className="annotation-panel-toggle"
          onClick={() => onToggle?.()}
          aria-label="展开批注列表"
          title="展开批注列表"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <div className="annotation-panel-collapsed-title">批注列表</div>
        <div className="annotation-panel-collapsed-counts">
          {openCount > 0 && <span className="badge badge-orange" title={`待处理 ${openCount}`}>{openCount}</span>}
          {resolvedCount > 0 && <span className="badge badge-green" title={`已解决 ${resolvedCount}`}>{resolvedCount}</span>}
          {rejectedCount > 0 && <span className="badge badge-gray" title={`不采纳 ${rejectedCount}`}>{rejectedCount}</span>}
          {annotations.length === 0 && <span className="badge badge-gray">0</span>}
        </div>
        {openCount > 0 && (
          <button
            className="annotation-panel-toggle-generate"
            onClick={() => onGeneratePlan?.()}
            disabled={generating}
            title="生成修改方案"
            aria-label="生成修改方案"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2a10 10 0 1 0 10 10H12V2z" />
              <path d="M12 2a10 10 0 0 1 10 10" />
            </svg>
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="annotation-panel">
      <div className="annotation-panel-header">
        <span>批注列表</span>
        <button
          className="annotation-panel-toggle"
          onClick={() => onToggle?.()}
          aria-label="收起批注列表"
          title="收起批注列表"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 18l6-6-6-6" />
          </svg>
        </button>
      </div>

      {/* Status filters */}
      <div className="annotation-filters">
        {FILTERS.map(f => {
          const count = f.key === 'all' ? annotations.length
            : f.key === 'open' ? openCount
            : f.key === 'resolved' ? resolvedCount : rejectedCount;
          return (
            <button
              key={f.key}
              className={`btn btn-sm ${filter === f.key ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setFilter(f.key)}
            >
              {f.label} ({count})
            </button>
          );
        })}
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {filtered.length === 0 ? (
          <div className="empty-state" style={{ padding: '32px 16px' }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
            </svg>
            <div className="empty-state-title">暂无批注</div>
            <div className="empty-state-desc">点击预览区任意位置添加批注</div>
          </div>
        ) : (
          filtered.map((ann, idx) => {
            const meta = STATUS_META[ann.status] || STATUS_META.open;
            return (
              <div
                key={ann.id}
                className={`annotation-item ${activeId === ann.id ? 'active' : ''}`}
                onClick={() => onActive?.(ann)}
              >
                <div className="annotation-item-header">
                  <div className={`annotation-pin-mini ${meta.pinClass}`}>
                    <span>{idx + 1}</span>
                  </div>
                  <span className={`badge ${meta.badge}`}>{meta.label}</span>
                </div>
                <div className="annotation-item-content">{ann.content}</div>
                <div className="annotation-item-meta">
                  {ann.author} · 位置 ({ann.x}%, {ann.y}%) · {new Date(ann.created_at).toLocaleString('zh-CN')}
                </div>
                {ann.page && ann.page !== 'index.html' && (
                  <div className="annotation-item-page" title={ann.page}>
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}>
                      <path d="M4 4h16v16H4z" /><path d="M9 2v4M15 2v4M9 12h6M9 16h4" />
                    </svg>
                    {ann.page.split('/').pop()}
                  </div>
                )}
                <div style={{ marginTop: 8, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {ann.status === 'open' && (
                    <>
                      <button className="btn btn-sm btn-secondary" onClick={(e) => { e.stopPropagation(); onResolve?.(ann.id); }}>
                        标记已解决
                      </button>
                      <button className="btn btn-sm btn-secondary" onClick={(e) => { e.stopPropagation(); onReject?.(ann.id); }}>
                        标记不采纳
                      </button>
                    </>
                  )}
                  {(ann.status === 'resolved' || ann.status === 'rejected') && (
                    <button className="btn btn-sm btn-secondary" onClick={(e) => { e.stopPropagation(); onReopen?.(ann.id); }}>
                      重新打开
                    </button>
                  )}
                  <button className="btn btn-sm btn-secondary" onClick={(e) => { e.stopPropagation(); onDelete?.(ann.id); }} style={{ color: 'var(--red)' }}>
                    删除
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {openCount > 0 && (
        <div style={{ padding: 12, borderTop: '1px solid var(--border)' }}>
          <button
            className="btn btn-primary"
            style={{ width: '100%' }}
            onClick={onGeneratePlan}
            disabled={generating}
          >
            {generating ? '正在生成方案...' : `生成修改方案 (${openCount} 条待处理批注)`}
          </button>
        </div>
      )}
    </div>
  );
}
