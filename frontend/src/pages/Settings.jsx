import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api, getOwnerToken } from '../api.js';
import { useOwnerAuth } from '../components/OwnerAuthContext.jsx';
import { useToast } from '../components/ToastContext.jsx';

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
    makers_model: '@makers/hy3',
    custom_domain: ''
  });
  const { showToast } = useToast();
  const [deleting, setDeleting] = useState(false);

  const handleDeleteProject = async () => {
    // Double confirmation: 1) warning dialog 2) type the exact project name
    const first = window.confirm(`确定要删除项目「${project.name}」吗？\n\n所有原型文件、批注、方案和任务都将被永久删除，此操作不可恢复。`);
    if (!first) return;

    const typed = window.prompt(`二次确认：请输入项目名称「${project.name}」以确认删除。`);
    if (typed === null) return;
    if (typed.trim() !== project.name) {
      showToast('项目名称不匹配，已取消删除', 'error');
      return;
    }

    setDeleting(true);
    try {
      // Owner maintenance operation: guarded by the owner password (one-time per session)
      await guard(id, () => api.deleteProject(id, getOwnerToken(id)));
      navigate('/');
    } catch (err) {
      if (err.message !== 'owner verification cancelled') showToast('删除失败: ' + err.message, 'error');
    } finally {
      setDeleting(false);
    }
  };

  // Built-in models: free, no vendor key binding required.
  const MAKERS_BUILTIN_MODELS = [
    { id: '@makers/hy3', label: '腾讯混元 3.0（默认·快）' },
    { id: '@makers/hy3-preview', label: '混元 3.0 预览（快）' },
    { id: '@makers/deepseek-v4-flash', label: 'DeepSeek V4 Flash（推理·快）' },
    { id: '@makers/deepseek-v4-pro', label: 'DeepSeek V4 Pro（推理·质量高）' },
    { id: '@makers/minimax-m3', label: 'MiniMax M3（推理）' },
    { id: '@makers/minimax-m2.7', label: 'MiniMax M2.7（推理）' },
    { id: '@makers/kimi-k2.6', label: 'Kimi K2.6（推理·慢）' }
  ];

  // Vendor models: require binding the vendor's own API key in the Makers console.
  // Same gateway endpoint & auth, just a different model id prefix (vendor/name).
  const VENDOR_MODELS = [
    { id: 'deepseek/deepseek-chat', label: 'DeepSeek Chat（厂商·非推理·快·推荐）' },
    { id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash（厂商·推理·快）' },
    { id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro（厂商·推理·质量高）' }
  ];

  useEffect(() => {
    api.getProject(id).then(p => {
      setProject(p);
      setForm({
        name: p.name || '',
        description: p.description || '',
        edgeone_project_name: p.edgeone_project_name || '',
        edgeone_token: '',  // Don't pre-fill sensitive keys
        makers_key: '',
        makers_model: p.makers_model || '@makers/hy3',
        custom_domain: p.custom_domain || ''
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
        makers_model: form.makers_model,
        custom_domain: form.custom_domain.trim().replace(/^https?:\/\//, '').replace(/\/$/, '')
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
        <Link to={`/project/${id}`} className="back-link">← 返回仪表盘</Link>
        <h1 className="page-title">项目设置</h1>
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
          <div className="form-group">
            <label className="form-label">自定义域名（可选）</label>
            <input
              className="form-input"
              value={form.custom_domain}
              onChange={e => setForm({ ...form, custom_domain: e.target.value })}
              placeholder="如 cis2.20140107.xyz"
            />
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
              部署后优先使用此域名作为原型访问地址。需先在 EdgeOne Makers 控制台绑定该域名并完成 DNS 验证：
              进入项目详情 → 域名管理 → 添加自定义域名 → 添加 CNAME 记录。
              绑定验证通过后，部署 URL 将自动切换为自定义域名。
            </div>
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
            <label className="form-label">AI 模型</label>
            <select
              className="form-input"
              value={form.makers_model}
              onChange={e => setForm({ ...form, makers_model: e.target.value })}
            >
              <optgroup label="Makers 内置模型（免费额度）">
                {MAKERS_BUILTIN_MODELS.map(m => (
                  <option key={m.id} value={m.id}>{m.id} · {m.label}</option>
                ))}
              </optgroup>
              <optgroup label="厂商模型（需绑定厂商密钥）">
                {VENDOR_MODELS.map(m => (
                  <option key={m.id} value={m.id}>{m.id} · {m.label}</option>
                ))}
              </optgroup>
            </select>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
              内置模型（@makers/* 前缀）免绑定即可调用；厂商模型（如 deepseek/* 前缀）需先在 Makers 控制台「模型与密钥」页面绑定对应厂商的 API Key。
            </div>
          </div>
          <div style={{ marginTop: 16, padding: 12, background: 'var(--primary-light)', borderRadius: 6, fontSize: 12, color: 'var(--primary-dark)' }}>
            <strong>安全说明：</strong> 密钥存储在后端服务器的数据库中，不会出现在前端代码或浏览器中。所有对 EdgeOne 和 Makers Models 的 API 调用都通过后端代理进行。
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16, borderColor: 'var(--red)' }}>
        <div className="card-header">
          <span className="card-title" style={{ color: 'var(--red)' }}>危险操作</span>
        </div>
        <div className="card-body">
          <div className="text-sm-muted" style={{ marginBottom: 12 }}>>
            删除项目「{project.name}」将永久移除所有原型文件、批注、修改方案与任务，且不可恢复。
            删除需要经过二次确认（输入项目名称）并验证 owner 密码。
          </div>
          <button
            className="btn btn-danger"
            onClick={handleDeleteProject}
            disabled={deleting || saving}
          >
            {deleting ? '删除中...' : '删除项目'}
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
        <button className="btn btn-secondary" onClick={() => navigate(`/project/${id}`)}>取消</button>
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? '保存中...' : '保存设置'}
        </button>
      </div>
    </div>
  );
}
