import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, getOwnerToken } from '../api.js';
import { useOwnerAuth } from '../components/OwnerAuthContext.jsx';

export default function ProjectList() {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ name: '', description: '', edgeone_project_name: '', edgeone_token: '', makers_key: '' });
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  const { guard } = useOwnerAuth();

  const load = async () => {
    try {
      const data = await api.listProjects();
      setProjects(data);
    } catch (err) {
      console.error('Failed to load projects:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleCreate = async () => {
    if (!createForm.name.trim()) return;
    setCreating(true);
    try {
      const project = await api.createProject(createForm);
      navigate(`/project/${project.id}`);
    } catch (err) {
      alert('创建失败: ' + err.message);
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (e, id) => {
    e.stopPropagation();
    if (!confirm('确定删除此项目？所有相关文件和批注都将被删除。')) return;
    try {
      // Owner maintenance operation: guarded by the owner password (one-time per session)
      await guard(id, () => api.deleteProject(id, getOwnerToken(id)));
      load();
    } catch (err) {
      if (err.message === 'owner verification cancelled') return;
      alert('删除失败: ' + err.message);
    }
  };

  const statusBadge = (status) => {
    const map = {
      created: { cls: 'badge-gray', text: '已创建' },
      uploaded: { cls: 'badge-blue', text: '已上传' },
      deployed: { cls: 'badge-green', text: '已部署' },
      deploy_failed: { cls: 'badge-red', text: '部署失败' },
    };
    const s = map[status] || { cls: 'badge-gray', text: status };
    return <span className={`badge ${s.cls}`}>{s.text}</span>;
  };

  return (
    <div className="main-content">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700 }}>项目列表</h1>
          <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 4 }}>上传原型包 → 部署 → 协作评审 → Agent 生成方案 → 审核应用</p>
        </div>
        <button className="btn btn-primary btn-lg" onClick={() => setShowCreate(true)}>
          + 创建项目
        </button>
      </div>

      {loading ? (
        <div className="loading-container"><div className="spinner" /><span>加载中...</span></div>
      ) : projects.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
            </svg>
            <div className="empty-state-title">还没有项目</div>
            <div className="empty-state-desc">创建第一个项目，上传原型包开始协作评审</div>
            <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={() => setShowCreate(true)}>创建项目</button>
          </div>
        </div>
      ) : (
        <div className="project-grid">
          {projects.map(p => (
            <div key={p.id} className="project-card" onClick={() => navigate(`/project/${p.id}`)}>
              <div className="project-card-name">{p.name}</div>
              <div style={{ marginBottom: 8 }}>{statusBadge(p.status)}</div>
              {p.description && <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 8 }}>{p.description}</div>}
              <div className="project-card-meta">
                <span>版本 v{p.version || 0}</span>
                {p.deploy_method === 'edgeone' && <span>EdgeOne 部署</span>}
                {p.deploy_method === 'local' && <span>本地托管</span>}
                {p.current_url && <span style={{ color: 'var(--green)' }}>● 在线可预览</span>}
              </div>
              <div style={{ marginTop: 12, display: 'flex', gap: 4 }}>
                <button className="btn btn-sm btn-secondary" onClick={(e) => { e.stopPropagation(); navigate(`/project/${p.id}/review`); }}>评审</button>
                <button className="btn btn-sm btn-secondary" onClick={(e) => { e.stopPropagation(); navigate(`/project/${p.id}/plan`); }}>方案</button>
                <button className="btn btn-sm btn-secondary" onClick={(e) => { e.stopPropagation(); navigate(`/project/${p.id}/settings`); }}>设置</button>
                <button className="btn btn-sm btn-secondary" onClick={(e) => handleDelete(e, p.id)} style={{ color: 'var(--red)', marginLeft: 'auto' }}>删除</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showCreate && (
        <div className="modal-overlay" onClick={() => setShowCreate(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              创建项目
              <button className="btn btn-sm btn-secondary" onClick={() => setShowCreate(false)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label className="form-label">项目名称 *</label>
                <input className="form-input" value={createForm.name} onChange={e => setCreateForm({ ...createForm, name: e.target.value })} placeholder="例如：电商首页原型" autoFocus />
              </div>
              <div className="form-group">
                <label className="form-label">项目描述</label>
                <input className="form-input" value={createForm.description} onChange={e => setCreateForm({ ...createForm, description: e.target.value })} placeholder="简短描述（可选）" />
              </div>
              <div className="form-group">
                <label className="form-label">EdgeOne 项目名（可选）</label>
                <input className="form-input" value={createForm.edgeone_project_name} onChange={e => setCreateForm({ ...createForm, edgeone_project_name: e.target.value })} placeholder="EdgeOne Makers 上的项目标识" />
              </div>
              <div className="form-group">
                <label className="form-label">EdgeOne API Token（可选，稍后可在设置中填写）</label>
                <input className="form-input" type="password" value={createForm.edgeone_token} onChange={e => setCreateForm({ ...createForm, edgeone_token: e.target.value })} placeholder="用于部署到 EdgeOne Makers" />
              </div>
              <div className="form-group">
                <label className="form-label">Makers Models API Key（可选，稍后可在设置中填写）</label>
                <input className="form-input" type="password" value={createForm.makers_key} onChange={e => setCreateForm({ ...createForm, makers_key: e.target.value })} placeholder="用于 Agent 生成修改方案" />
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
                密钥将安全存储在后端，不会下发到前端。API 调用全部经后端代理。
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowCreate(false)}>取消</button>
              <button className="btn btn-primary" onClick={handleCreate} disabled={creating || !createForm.name.trim()}>
                {creating ? '创建中...' : '创建'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
