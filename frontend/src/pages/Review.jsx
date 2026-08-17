import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../api.js';
import PreviewFrame from '../components/PreviewFrame.jsx';
import AnnotationLayer from '../components/AnnotationLayer.jsx';

export default function Review() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState(null);
  const [annotations, setAnnotations] = useState([]);
  const [annotateMode, setAnnotateMode] = useState(false);
  const [activeAnnotationId, setActiveAnnotationId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [latestPlan, setLatestPlan] = useState(null);
  const [currentPage, setCurrentPage] = useState('index.html');
  const [toast, setToast] = useState(null);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4000);
  };

  const load = useCallback(async () => {
    try {
      const [p, anns] = await Promise.all([
        api.getProject(id),
        api.listAnnotations(id)
      ]);
      setProject(p);
      setAnnotations(anns);
    } catch (err) {
      showToast('加载失败: ' + err.message, 'error');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const handleAnnotate = async ({ x, y, content, page }) => {
    try {
      const ann = await api.createAnnotation(id, {
        x, y,
        page: page || 'index.html',
        author: 'Reviewer',
        content
      });
      setAnnotations([...annotations, ann]);
      setAnnotateMode(false);
      showToast('批注已添加，可在右侧手动生成修改方案');
    } catch (err) {
      showToast('添加批注失败: ' + err.message, 'error');
    }
  };

  const handleResolve = async (annId) => {
    try {
      await api.updateAnnotation(id, annId, { status: 'resolved' });
      setAnnotations(annotations.map(a => a.id === annId ? { ...a, status: 'resolved' } : a));
      showToast('已标记为已解决');
    } catch (err) {
      showToast('操作失败: ' + err.message, 'error');
    }
  };

  const handleReject = async (annId) => {
    try {
      await api.updateAnnotation(id, annId, { status: 'rejected' });
      setAnnotations(annotations.map(a => a.id === annId ? { ...a, status: 'rejected' } : a));
      showToast('已标记为不采纳');
    } catch (err) {
      showToast('操作失败: ' + err.message, 'error');
    }
  };

  const handleReopen = async (annId) => {
    try {
      await api.updateAnnotation(id, annId, { status: 'open' });
      setAnnotations(annotations.map(a => a.id === annId ? { ...a, status: 'open' } : a));
      showToast('已重新打开');
    } catch (err) {
      showToast('操作失败: ' + err.message, 'error');
    }
  };

  const handleDelete = async (annId) => {
    if (!confirm('确定删除此批注？')) return;
    try {
      await api.deleteAnnotation(id, annId);
      setAnnotations(annotations.filter(a => a.id !== annId));
      showToast('批注已删除');
    } catch (err) {
      showToast('删除失败: ' + err.message, 'error');
    }
  };

  const handleGeneratePlan = async () => {
    setGenerating(true);
    try {
      const plan = await api.generatePlan(id);
      setLatestPlan(plan);
      showToast(`方案已生成: ${plan.changes?.length || 0} 条修改建议 (${plan.method === 'makers' ? 'Makers Models' : '规则引擎'})`);
      navigate(`/project/${id}/plan`);
    } catch (err) {
      showToast('生成方案失败: ' + err.message, 'error');
    } finally {
      setGenerating(false);
    }
  };

  if (loading) {
    return <div className="main-content"><div className="loading-container"><div className="spinner" /><span>加载中...</span></div></div>;
  }

  if (!project) {
    return <div className="main-content"><div className="card"><div className="card-body">项目不存在</div></div></div>;
  }

  const hasPreview = project.current_url || project.status === 'uploaded' || project.status === 'deployed';

  return (
    <div className="main-content" style={{ paddingTop: 16 }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <Link to={`/project/${id}`} style={{ fontSize: 13 }}>← 返回仪表盘</Link>
          <h1 style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>{project.name} · 评审</h1>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className={`btn ${annotateMode ? 'btn-danger' : 'btn-primary'}`}
            onClick={() => setAnnotateMode(!annotateMode)}
            disabled={!hasPreview}
          >
            {annotateMode ? '● 点击预览区添加批注（再次点击退出）' : '+ 添加批注'}
          </button>
          <button className="btn btn-secondary" onClick={() => navigate(`/project/${id}/plan`)}>查看方案</button>
        </div>
      </div>

      {/* Review layout */}
      <div className="review-layout">
        {/* Preview with annotation overlay */}
        <div className="preview-container">
          <div className="preview-toolbar">
            <span style={{ fontWeight: 500, fontSize: 13 }}>原型预览</span>
            {project.current_url && (
              <span className="preview-url">{project.current_url}</span>
            )}
            {annotateMode && (
              <span className="badge badge-orange" style={{ animation: 'pulse 1.5s infinite' }}>
                批注模式 · 点击任意位置
              </span>
            )}
            {currentPage !== 'index.html' && (
              <span className="badge badge-blue" title={currentPage}>当前页 · {currentPage.split('/').pop()}</span>
            )}
          </div>
          {hasPreview ? (
            <PreviewFrame
              projectId={id}
              version={project.version}
              annotateMode={annotateMode}
              onAnnotate={handleAnnotate}
              annotations={annotations}
              activeAnnotationId={activeAnnotationId}
              onAnnotationClick={(ann) => setActiveAnnotationId(ann.id === activeAnnotationId ? null : ann.id)}
              onPageChange={setCurrentPage}
            />
          ) : (
            <div className="empty-state" style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: 64, height: 64, margin: '0 auto 16px', opacity: 0.4 }}>
                <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" />
              </svg>
              <div className="empty-state-title">尚未部署原型</div>
              <div className="empty-state-desc">请先在仪表盘上传原型包并部署</div>
              <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={() => navigate(`/project/${id}`)}>前往仪表盘</button>
            </div>
          )}
        </div>

        {/* Annotation panel */}
        <AnnotationLayer
          annotations={annotations}
          onResolve={handleResolve}
          onReject={handleReject}
          onReopen={handleReopen}
          onDelete={handleDelete}
          onGeneratePlan={handleGeneratePlan}
          activeId={activeAnnotationId}
          onActive={(ann) => setActiveAnnotationId(ann.id === activeAnnotationId ? null : ann.id)}
          generating={generating}
        />
      </div>

      {generating && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: 360 }}>
            <div className="modal-body" style={{ textAlign: 'center', padding: 32 }}>
              <div className="spinner" style={{ width: 32, height: 32, margin: '0 auto 16px' }} />
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Agent 正在生成修改方案</div>
              <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>分析批注内容，生成结构化修改建议...</div>
            </div>
          </div>
        </div>
      )}

      {/* Plan ready floating notification */}
      {latestPlan && !generating && (
        <div className="plan-ready-banner">
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className="plan-ready-dot" />
              修改方案已生成
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
              {latestPlan.changes?.length || 0} 条修改建议 · {latestPlan.method === 'makers' ? 'Makers Models' : '规则引擎'} · 生成于 {new Date(latestPlan.created_at).toLocaleTimeString('zh-CN')}
            </div>
          </div>
          <button className="btn btn-sm btn-primary" onClick={() => navigate(`/project/${id}/plan`)}>
            查看方案 →
          </button>
          <button
            className="plan-ready-close"
            onClick={() => setLatestPlan(null)}
            title="关闭"
          >
            ×
          </button>
        </div>
      )}

      {toast && <div className={`toast toast-${toast.type}`}>{toast.msg}</div>}
    </div>
  );
}
