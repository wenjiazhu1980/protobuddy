import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api, getOwnerToken } from '../api.js';
import { useOwnerAuth } from '../components/OwnerAuthContext.jsx';
import { useToast } from '../components/ToastContext.jsx';

const STATUS_OPTIONS = [
  { value: 'todo', label: '待办' },
  { value: 'in_progress', label: '进行中' },
  { value: 'done', label: '已完成' }
];

const PRIORITY_OPTIONS = [
  { value: 'P0', label: 'P0 紧急' },
  { value: 'P1', label: 'P1 高' },
  { value: 'P2', label: 'P2 普通' }
];

export default function TaskDetail() {
  const { id, taskId } = useParams();
  const navigate = useNavigate();
  const { guard } = useOwnerAuth();
  // The route /project/:id/tasks/new is a static segment, so taskId is undefined
  // there. The route /project/:id/tasks/:taskId is used for real task ids.
  const isNew = !taskId;

  const [project, setProject] = useState(null);
  const [task, setTask] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const { showToast } = useToast();

  const [form, setForm] = useState({
    title: '',
    description: '',
    status: 'todo',
    priority: 'P2',
    estimate_hours: 1,
    labels: [],
    module_path: []
  });

  // split modal
  const [showSplit, setShowSplit] = useState(false);
  const [splitParts, setSplitParts] = useState([{ title: '', description: '', estimate_hours: 0 }]);

  useEffect(() => {
    (async () => {
      try {
        const p = await api.getProject(id);
        setProject(p);
        if (!isNew) {
          const t = await api.getTask(id, taskId);
          setTask(t);
          setForm({
            title: t.title,
            description: t.description || '',
            status: t.status,
            priority: t.priority,
            estimate_hours: t.estimate_hours,
            labels: t.labels || [],
            module_path: t.module_path || []
          });
        }
      } catch (err) {
        showToast('加载失败: ' + err.message, 'error');
      } finally {
        setLoading(false);
      }
    })();
  }, [id, taskId, isNew]);

  const handleSave = async () => {
    if (!form.title.trim()) {
      showToast('标题不能为空', 'error');
      return;
    }
    setSaving(true);
    try {
      if (isNew) {
        await guard(id, () => api.createTask(id, {
          ...form,
          labels: form.labels.join(','),
          estimate_hours: Number(form.estimate_hours) || 1
        }, getOwnerToken(id)));
        showToast('任务已创建');
        navigate(`/project/${id}/tasks`);
      } else {
        await guard(id, () => api.updateTask(id, taskId, {
          ...form,
          labels: form.labels.join(','),
          estimate_hours: Number(form.estimate_hours) || 0
        }, getOwnerToken(id)));
        showToast('任务已保存');
        const t = await api.getTask(id, taskId);
        setTask(t);
      }
    } catch (err) {
      if (err.message !== 'owner verification cancelled') showToast('保存失败: ' + err.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm(`确定删除任务「${task.title}」？此操作不可恢复。`)) return;
    try {
      await guard(id, () => api.deleteTask(id, taskId, getOwnerToken(id)));
      showToast('任务已删除');
      navigate(`/project/${id}/tasks`);
    } catch (err) {
      if (err.message !== 'owner verification cancelled') showToast('删除失败: ' + err.message, 'error');
    }
  };

  const handleSplit = async () => {
    const parts = splitParts.filter(p => p.title.trim());
    if (parts.length < 2) {
      showToast('至少填写 2 个子任务标题', 'error');
      return;
    }
    try {
      const r = await guard(id, () => api.splitTask(id, taskId, parts.map(p => ({
        title: p.title,
        description: p.description,
        estimate_hours: Number(p.estimate_hours) || 0
      })), getOwnerToken(id)));
      showToast(`已拆分为 ${r.children.length} 个子任务`);
      setShowSplit(false);
      const t = await api.getTask(id, taskId);
      setTask(t);
    } catch (err) {
      if (err.message !== 'owner verification cancelled') showToast('拆分失败: ' + err.message, 'error');
    }
  };

  const handleMergeInto = async (otherId) => {
    if (!confirm(`确定将任务「${task.title}」合并到所选任务？本任务将被删除。`)) return;
    try {
      await guard(id, () => api.mergeTasks(id, otherId, [taskId], getOwnerToken(id)));
      showToast('合并成功');
      navigate(`/project/${id}/tasks`);
    } catch (err) {
      if (err.message !== 'owner verification cancelled') showToast('合并失败: ' + err.message, 'error');
    }
  };

  if (loading) {
    return <div className="main-content"><div className="loading-container"><div className="spinner" /><span>加载中...</span></div></div>;
  }

  return (
    <div className="main-content" style={{ maxWidth: 860, paddingTop: 16 }}>
      <div style={{ marginBottom: 16 }}>
        <Link to={`/project/${id}/tasks`} className="back-link">← 返回任务清单</Link>
        <h1 className="page-title">{isNew ? '新建任务' : '任务详情'}</h1>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-header">
          <span className="card-title">{isNew ? '创建任务' : `#${task.id} ${task.title}`}</span>
          {!isNew && task.gitlab?.url && (
            <a href={task.gitlab.url} target="_blank" rel="noopener noreferrer" className="btn btn-sm btn-secondary">GitLab Issue #{task.gitlab.iid} ↗</a>
          )}
        </div>
        <div className="card-body">
          {!isNew && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
              <span className={`badge ${task.priority === 'P0' ? 'badge-red' : task.priority === 'P1' ? 'badge-blue' : 'badge-gray'}`}>{task.priority}</span>
              <span className="badge badge-gray">{task.source === 'auto' ? '自动拆解' : '手动创建'}</span>
              <span className="badge badge-gray">{task.estimate_hours}h</span>
              <span className="badge badge-gray">{new Date(task.created_at).toLocaleString('zh-CN')}</span>
              {task.gitlab?.synced_at && <span className="badge badge-green">GitLab 同步于 {new Date(task.gitlab.synced_at).toLocaleString('zh-CN')}</span>}
              {task.annotation_sync && (
                <span
                  className="badge badge-orange"
                  title={task.annotation_sync.detail || '批注同步已更新此任务的内容'}
                >
                  批注同步更新于 {new Date(task.annotation_sync.at).toLocaleString('zh-CN')}
                </span>
              )}
            </div>
          )}

          <div className="form-group">
            <label className="form-label">标题 *</label>
            <input className="form-input" value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} placeholder="任务标题" />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
            <div className="form-group">
              <label className="form-label">状态</label>
              <select className="form-input" value={form.status} onChange={e => setForm({ ...form, status: e.target.value })}>
                {STATUS_OPTIONS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">优先级</label>
              <select className="form-input" value={form.priority} onChange={e => setForm({ ...form, priority: e.target.value })}>
                {PRIORITY_OPTIONS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">预估工时（小时）</label>
              <input className="form-input" type="number" min="0" step="0.5" value={form.estimate_hours} onChange={e => setForm({ ...form, estimate_hours: e.target.value })} />
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">标签（逗号分隔）</label>
            <input className="form-input" value={form.labels.join(', ')} onChange={e => setForm({ ...form, labels: e.target.value.split(/[,，]/).map(s => s.trim()).filter(Boolean) })} placeholder="frontend, api, bug" />
          </div>

          <div className="form-group">
            <label className="form-label">模块路径（层级，如 首页 / 商品列表）</label>
            <input className="form-input" value={form.module_path.join(' / ')} onChange={e => setForm({ ...form, module_path: e.target.value.split('/').map(s => s.trim()).filter(Boolean) })} placeholder="首页 / 商品列表" />
          </div>

          <div className="form-group">
            <label className="form-label">描述</label>
            <textarea className="form-textarea" style={{ minHeight: 180, fontFamily: 'inherit' }} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="验收标准、交互说明、实现要点…（Markdown 支持）" />
          </div>

          {!isNew && task?.annotations?.length > 0 && (
            <div className="form-group">
              <label className="form-label">关联批注（{task.resolved_annotation_count}/{task.annotation_total} 已解决）</label>
              <div className="annotation-link-list">
                {task.annotations.map(a => (
                  <div key={a.id} className={`annotation-link-item ${a.status === 'resolved' ? 'resolved' : ''}`}>
                    <span className="badge" style={{ background: a.status === 'resolved' ? 'var(--green, #16a34a)' : 'var(--orange)', color: '#fff' }}>
                      {a.status === 'resolved' ? '已解决' : '未解决'}
                    </span>
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{a.page}</span>
                    <span style={{ fontSize: 12, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.content}</span>
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                提示：批注状态与任务状态相互独立。同步批注只更新任务的关联清单与描述明细；若任务已完成且内容发生变动，会自动回退为「进行中」，但不会自动变为「已完成」。
              </div>
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', marginTop: 8 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              {!isNew && (
                <>
                  <button className="btn btn-sm btn-secondary" onClick={() => setShowSplit(true)}>拆分</button>
                  <button className="btn btn-sm btn-secondary" onClick={() => navigate(`/project/${id}/tasks?merge=1&target=${taskId}`)}>合并到其他任务</button>
                </>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {!isNew && <button className="btn btn-sm btn-danger" onClick={handleDelete}>删除</button>}
              <button className="btn btn-sm btn-secondary" onClick={() => navigate(`/project/${id}/tasks`)}>取消</button>
              <button className="btn btn-sm btn-primary" onClick={handleSave} disabled={saving}>{saving ? '保存中...' : '保存'}</button>
            </div>
          </div>
        </div>
      </div>

      {/* split modal */}
      {showSplit && (
        <div className="modal-overlay" onClick={() => setShowSplit(false)}>
          <div className="modal" style={{ width: 640 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">拆分任务「{task.title}」</span>
              <button className="modal-close" onClick={() => setShowSplit(false)}>×</button>
            </div>
            <div className="modal-body">
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
                原任务将成为父任务（状态变为进行中），子任务可独立跟踪。关联批注会自动分发到各子任务。
              </div>
              {splitParts.map((p, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)', width: 20 }}>{i + 1}.</span>
                  <input
                    className="form-input"
                    style={{ flex: 1 }}
                    placeholder="子任务标题"
                    value={p.title}
                    onChange={e => {
                      const next = [...splitParts];
                      next[i] = { ...next[i], title: e.target.value };
                      setSplitParts(next);
                    }}
                  />
                  <input
                    className="form-input"
                    style={{ width: 70 }}
                    type="number"
                    min="0"
                    step="0.5"
                    placeholder="工时"
                    value={p.estimate_hours}
                    onChange={e => {
                      const next = [...splitParts];
                      next[i] = { ...next[i], estimate_hours: e.target.value };
                      setSplitParts(next);
                    }}
                  />
                  <button className="btn btn-sm btn-secondary" onClick={() => setSplitParts(splitParts.filter((_, j) => j !== i))} disabled={splitParts.length <= 2}>×</button>
                </div>
              ))}
              <button className="btn btn-sm btn-secondary" onClick={() => setSplitParts([...splitParts, { title: '', description: '', estimate_hours: 0 }])}>+ 添加子任务</button>
            </div>
            <div className="modal-footer">
              <button className="btn btn-sm btn-secondary" onClick={() => setShowSplit(false)}>取消</button>
              <button className="btn btn-sm btn-primary" onClick={handleSplit}>确认拆分</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
