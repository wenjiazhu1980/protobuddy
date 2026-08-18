import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api, getOwnerToken } from '../api.js';
import { useOwnerAuth } from '../components/OwnerAuthContext.jsx';

export default function Settings() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { guard } = useOwnerAuth();
  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    name: '',
    description: '',
    edgeone_project_name: '',
    edgeone_token: '',
    makers_key: '',
    makers_model: '@makers/hy3'
  });
  const [toast, setToast] = useState(null);

  const MAKERS_MODELS = [
    { id: '@makers/hy3', label: '@makers/hy3 · 腾讯混元 3.0（默认·快）' },
    { id: '@makers/hy3-preview', label: '@makers/hy3-preview · 混元 3.0 预览（快）' },
    { id: '@makers/deepseek-v4-flash', label: '@makers/deepseek-v4-flash · DeepSeek V4 Flash（推理·快）' },
    { id: '@makers/deepseek-v4-pro', label: '@makers/deepseek-v4-pro · DeepSeek V4 Pro（推理·质量高）' },
    { id: '@makers/minimax-m3', label: '@makers/minimax-m3 · MiniMax M3（推理）' },
    { id: '@makers/minimax-m2.7', label: '@makers/minimax-m2.7 · MiniMax M2.7（推理）' },
    { id: '@makers/kimi-k2.6', label: '@makers/kimi-k2.6 · Kimi K2.6（推理·慢）' }
  ];

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  useEffect(() => {
    api.getProject(id).then(p => {
      setProject(p);
      setForm({
        name: p.name || '',
        description: p.description || '',
        edgeone_project_name: p.edgeone_project_name || '',
        edgeone_token: '',  // Don't pre-fill sensitive keys
        makers_key: '',
        makers_model: p.makers_model || '@makers/hy3'
      });
      setLoading(false);
    }).catch(err => {
      showToast('加载失败: ' + err.message, 'error');
      setLoading(false);
    });
  }, [id]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const patch = {
        name: form.name,
        description: form.description,
        edgeone_project_name: form.edgeone_project_name,
        makers_model: form.makers_model
      };
      // Only update keys if user entered new values
      if (form.edgeone_token) patch.edgeone_token = form.edgeone_token;
      if (form.makers_key) patch.makers_key = form.makers_key;

      // Owner maintenance operation: guarded by the owner password (one-time per session)
      const updated = await guard(id, () => api.updateProject(id, patch, getOwnerToken(id)));
      setProject(updated);
      showToast('设置已保存');
      setForm({ ...form, edgeone_token: '', makers_key: '' });
    } catch (err) {
      if (err.message !== 'owner verification cancelled') showToast('保存失败: ' + err.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="main-content"><div className="loading-container"><div className="spinner" /><span>加载中...</span></div></div>;
  }

  if (!project) {
    return <div className="main-content"><div className="card"><div className="card-body">项目不存在</div></div></div>;
  }

  return (
    <div className="main-content" style={{ maxWidth: 640 }}>
      <div style={{ marginBottom: 16 }}>
        <Link to={`/project/${id}`} style={{ fontSize: 13 }}>← 返回仪表盘</Link>
        <h1 style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>项目设置</h1>
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-title">基本信息</span>
        </div>
        <div className="card-body">
          <div className="form-group">
            <label className="form-label">项目名称</label>
            <input className="form-input" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="form-group">
            <label className="form-label">项目描述</label>
            <input className="form-input" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} />
          </div>
          <div className="form-group">
            <label className="form-label">EdgeOne 项目名</label>
            <input className="form-input" value={form.edgeone_project_name} onChange={e => setForm({ ...form, edgeone_project_name: e.target.value })} placeholder="EdgeOne Makers 上的项目标识" />
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-header">
          <span className="card-title">密钥配置</span>
          <span className="badge badge-blue">安全存储</span>
        </div>
        <div className="card-body">
          <div className="form-group">
            <label className="form-label">
              EdgeOne API Token
              {project.edgeone_token === '***' && <span style={{ marginLeft: 8, color: 'var(--green)', fontSize: 12 }}>● 已设置</span>}
            </label>
            <input
              className="form-input"
              type="password"
              value={form.edgeone_token}
              onChange={e => setForm({ ...form, edgeone_token: e.target.value })}
              placeholder={project.edgeone_token === '***' ? '已设置（输入新值覆盖）' : '输入 EdgeOne Makers API Token'}
            />
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
              用于将原型部署到 EdgeOne Makers。获取方式：EdgeOne Makers 控制台 → API Token。
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">
              Makers Models API Key
              {project.makers_key === '***' && <span style={{ marginLeft: 8, color: 'var(--green)', fontSize: 12 }}>● 已设置</span>}
            </label>
            <input
              className="form-input"
              type="password"
              value={form.makers_key}
              onChange={e => setForm({ ...form, makers_key: e.target.value })}
              placeholder={project.makers_key === '***' ? '已设置（输入新值覆盖）' : '输入 Makers Models API Key'}
            />
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
              用于 Agent 调用 Makers Models 生成结构化修改方案。所有 API 调用经后端代理，密钥绝不下发前端。
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Makers 内置模型</label>
            <select
              className="form-input"
              value={form.makers_model}
              onChange={e => setForm({ ...form, makers_model: e.target.value })}
            >
              {MAKERS_MODELS.map(m => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
              用于生成修改方案的内置模型（免绑定厂商密钥即可调用）。可在 Makers 控制台 Models 页查看免费额度。
            </div>
          </div>
          <div style={{ marginTop: 16, padding: 12, background: 'var(--primary-light)', borderRadius: 6, fontSize: 12, color: 'var(--primary-dark)' }}>
            <strong>安全说明：</strong> 密钥存储在后端服务器的数据库中，不会出现在前端代码或浏览器中。所有对 EdgeOne 和 Makers Models 的 API 调用都通过后端代理进行。
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
        <button className="btn btn-secondary" onClick={() => navigate(`/project/${id}`)}>取消</button>
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? '保存中...' : '保存设置'}
        </button>
      </div>

      {toast && <div className={`toast toast-${toast.type}`}>{toast.msg}</div>}
    </div>
  );
}
