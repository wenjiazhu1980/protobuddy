import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api, getOwnerToken } from '../api.js';
import { useOwnerAuth } from '../components/OwnerAuthContext.jsx';

const STATUS_META = {
  todo: { label: '待办', color: 'var(--gray, #6b7280)' },
  in_progress: { label: '进行中', color: 'var(--blue, #2563eb)' },
  done: { label: '已完成', color: 'var(--green, #16a34a)' }
};

const PRIORITY_META = {
  P0: { label: 'P0 紧急', cls: 'badge-red' },
  P1: { label: 'P1 高', cls: 'badge-blue' },
  P2: { label: 'P2 普通', cls: 'badge-gray' }
};

export default function Tasks() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { guard } = useOwnerAuth();
  const [project, setProject] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [config, setConfig] = useState(null);
  const [gitlabCfg, setGitlabCfg] = useState(null);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);

  // generate modal
  const [showGen, setShowGen] = useState(false);
  const [genGranularity, setGenGranularity] = useState('page');
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [generating, setGenerating] = useState(false);

  // settings modal
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState('breakdown');

  // merge mode
  const [mergeMode, setMergeMode] = useState(false);
  const [selected, setSelected] = useState(new Set());

  // export dropdown
  const [showExport, setShowExport] = useState(false);
  const [exporting, setExporting] = useState(false);

  const [gitlabForm, setGitlabForm] = useState({ base_url: '', private_token: '', project_id: '', enabled: false });
  const [testingGitlab, setTestingGitlab] = useState(false);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  const load = useCallback(async () => {
    try {
      const [p, t, c, g] = await Promise.all([
        api.getProject(id),
        api.listTasks(id),
        api.getTaskConfig(id).catch(() => null),
        api.getGitlabConfig(id).catch(() => null)
      ]);
      setProject(p);
      setTasks(t);
      setConfig(c || { granularity: 'page', auto_estimate: true, default_labels: [] });
      setGenGranularity(c?.granularity || 'page');
      if (g) {
        setGitlabCfg(g);
        setGitlabForm(g);
      }
    } catch (err) {
      showToast('加载失败: ' + err.message, 'error');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // Merge flow entry: /tasks?merge=1&target=<taskId> from the task detail page
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('merge') === '1' && params.get('target')) {
      setMergeMode(true);
      setSelected(new Set([Number(params.get('target'))]));
    }
  }, []);

  const grouped = {
    todo: tasks.filter(t => t.status === 'todo'),
    in_progress: tasks.filter(t => t.status === 'in_progress'),
    done: tasks.filter(t => t.status === 'done')
  };

  const openGenerate = async (granularity) => {
    setGenGranularity(granularity);
    setShowGen(true);
    setPreview(null);
    setPreviewLoading(true);
    try {
      const r = await api.generateTasksPreview(id, { ...config, granularity });
      setPreview(r);
    } catch (err) {
      showToast('预览失败: ' + err.message, 'error');
      setPreview(null);
    } finally {
      setPreviewLoading(false);
    }
  };

  const confirmGenerate = async () => {
    setGenerating(true);
    try {
      const r = await guard(id, () => api.generateTasks(id, { ...config, granularity: genGranularity }, getOwnerToken(id)));
      showToast(`已生成 ${r.count} 个开发任务`);
      setShowGen(false);
      setPreview(null);
      load();
    } catch (err) {
      if (err.message !== 'owner verification cancelled') showToast('生成失败: ' + err.message, 'error');
    } finally {
      setGenerating(false);
    }
  };

  const handleSyncAnnotations = async () => {
    try {
      const r = await api.syncTaskAnnotations(id);
      showToast(r.changed > 0 ? `批注同步完成，${r.changed} 处任务状态已更新` : '批注同步完成，无变化');
      load();
    } catch (err) {
      showToast('同步失败: ' + err.message, 'error');
    }
  };

  const handleExport = async (format) => {
    setExporting(true);
    try {
      const text = await api.exportTasks(id, format);
      const blob = format === 'csv'
        ? new Blob([text], { type: 'text/csv;charset=utf-8' })
        : new Blob([JSON.stringify(JSON.parse(text), null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `tasks-${project?.slug || id}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
      showToast('已导出 ' + format.toUpperCase());
    } catch (err) {
      showToast('导出失败: ' + err.message, 'error');
    } finally {
      setExporting(false);
      setShowExport(false);
    }
  };

  const handlePushGitlab = async () => {
    setExporting(true);
    try {
      const ids = selected.size ? [...selected] : [];
      const r = await guard(id, () => api.pushTasksToGitlab(id, ids, getOwnerToken(id)));
      showToast(`已推送 ${r.pushed} 个任务到 GitLab${r.failed ? `，${r.failed} 个失败` : ''}`, r.failed ? 'error' : 'success');
      setSelected(new Set());
      setMergeMode(false);
      load();
    } catch (err) {
      if (err.message !== 'owner verification cancelled') showToast('推送失败: ' + err.message, 'error');
    } finally {
      setExporting(false);
      setShowExport(false);
    }
  };

  const handleMergeSelected = async () => {
    if (selected.size < 2) {
      showToast('请至少选择 2 个任务合并', 'error');
      return;
    }
    const ids = [...selected];
    const target = ids[0];
    if (!confirm(`确定将 ${ids.length} 个任务合并到「${tasks.find(t => t.id === target)?.title}」？其余任务将被删除。`)) return;
    try {
      await guard(id, () => api.mergeTasks(id, target, ids.slice(1), getOwnerToken(id)));
      showToast('合并成功');
      setSelected(new Set());
      setMergeMode(false);
      load();
    } catch (err) {
      if (err.message !== 'owner verification cancelled') showToast('合并失败: ' + err.message, 'error');
    }
  };

  const toggleSelect = (taskId) => {
    const next = new Set(selected);
    if (next.has(taskId)) next.delete(taskId);
    else next.add(taskId);
    setSelected(next);
  };

  const saveSettings = async () => {
    try {
      if (settingsTab === 'breakdown') {
        await guard(id, () => api.updateTaskConfig(id, config, getOwnerToken(id)));
        showToast('拆解规则已保存');
      } else {
        await guard(id, () => api.updateGitlabConfig(id, gitlabForm, getOwnerToken(id)));
        setGitlabCfg(gitlabForm);
        showToast('GitLab 配置已保存');
      }
      setShowSettings(false);
      load();
    } catch (err) {
      if (err.message !== 'owner verification cancelled') showToast('保存失败: ' + err.message, 'error');
    }
  };

  const testGitlab = async () => {
    setTestingGitlab(true);
    try {
      await guard(id, () => api.updateGitlabConfig(id, gitlabForm, getOwnerToken(id)));
      const r = await api.testGitlab(id, getOwnerToken(id));
      showToast(`连接成功：${r.info.path_with_namespace}`);
    } catch (err) {
      if (err.message !== 'owner verification cancelled') showToast('连接失败: ' + err.message, 'error');
    } finally {
      setTestingGitlab(false);
    }
  };

  const totalEstimate = tasks.reduce((s, t) => s + (t.estimate_hours || 0), 0);

  if (loading) {
    return <div className="main-content"><div className="loading-container"><div className="spinner" /><span>加载中...</span></div></div>;
  }

  if (!project) {
    return <div className="main-content"><div className="card"><div className="card-body">项目不存在</div></div></div>;
  }

  return (
    <div className="main-content" style={{ paddingTop: 16 }}>
      {/* header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
        <div>
          <Link to={`/project/${id}`} style={{ fontSize: 13 }}>← 返回仪表盘</Link>
          <h1 style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>任务清单 <span style={{ fontSize: 13, color: 'var(--text-muted)', fontWeight: 400 }}>{project.name}</span></h1>
          <div style={{ display: 'flex', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
            <span className="badge badge-blue">{tasks.length} 个任务</span>
            <span className="badge badge-gray">预估 {totalEstimate}h</span>
            <span className="badge badge-green">{tasks.filter(t => t.status === 'done').length} 已完成</span>
            {gitlabCfg?.enabled && <span className="badge badge-gray">GitLab 已启用</span>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {mergeMode ? (
            <>
              <button className="btn btn-sm btn-secondary" onClick={() => { setMergeMode(false); setSelected(new Set()); }}>取消</button>
              <button className="btn btn-sm btn-secondary" onClick={handleMergeSelected} disabled={selected.size < 2}>合并所选 ({selected.size})</button>
              <button className="btn btn-sm btn-primary" onClick={() => { setMergeMode(false); handlePushGitlab(); }} disabled={selected.size === 0}>推送所选到 GitLab</button>
            </>
          ) : (
            <>
              <button className="btn btn-sm btn-secondary" onClick={() => setMergeMode(true)}>批量操作</button>
              <div style={{ position: 'relative' }}>
                <button className="btn btn-sm btn-secondary" onClick={() => setShowExport(!showExport)} disabled={tasks.length === 0}>
                  {exporting ? '处理中...' : '导出 ▾'}
                </button>
                {showExport && (
                  <div className="dropdown-menu">
                    <div className="dropdown-item" onClick={() => handleExport('json')}>JSON（标准格式）</div>
                    <div className="dropdown-item" onClick={() => handleExport('csv')}>CSV（GitLab 导入格式）</div>
                    <div className="dropdown-item" onClick={handlePushGitlab}>推送至 GitLab（已配置时）</div>
                  </div>
                )}
              </div>
              <button className="btn btn-sm btn-secondary" onClick={handleSyncAnnotations}>同步批注</button>
              <button className="btn btn-sm btn-secondary" onClick={() => setShowSettings(true)}>规则设置</button>
              <button className="btn btn-sm btn-primary" onClick={() => navigate(`/project/${id}/tasks/new`)}>+ 新建任务</button>
              <button className="btn btn-sm btn-primary btn-accent" onClick={() => openGenerate(config?.granularity || 'page')}>自动拆解</button>
            </>
          )}
        </div>
      </div>

      {/* board */}
      <div className="task-board">
        {Object.keys(STATUS_META).map(status => {
          const meta = STATUS_META[status];
          const list = grouped[status];
          return (
            <div className="task-column" key={status}>
              <div className="task-column-header">
                <span className="task-column-dot" style={{ background: meta.color }} />
                <span>{meta.label}</span>
                <span className="task-column-count">{list.length}</span>
              </div>
              <div className="task-column-body">
                {list.length === 0 && (
                  <div className="task-empty">暂无任务</div>
                )}
                {list.map(t => (
                  <div
                    key={t.id}
                    className={`task-card ${selected.has(t.id) ? 'task-card-selected' : ''}`}
                    onClick={() => mergeMode ? toggleSelect(t.id) : navigate(`/project/${id}/tasks/${t.id}`)}
                  >
                    <div className="task-card-top">
                      <span className={`badge ${PRIORITY_META[t.priority]?.cls || 'badge-gray'}`}>{PRIORITY_META[t.priority]?.label || t.priority}</span>
                      {t.source === 'auto' && <span className="badge badge-blue">自动</span>}
                      {t.source === 'manual' && <span className="badge badge-gray">手动</span>}
                      {t.gitlab?.url && <span className="badge badge-green">GitLab #{t.gitlab.iid}</span>}
                      <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-muted)' }}>{t.estimate_hours}h</span>
                    </div>
                    <div className="task-card-title">{t.title}</div>
                    {t.module_path?.length > 0 && (
                      <div className="task-card-module">{t.module_path.join(' / ')}</div>
                    )}
                    {(t.labels || []).length > 0 && (
                      <div className="task-card-labels">
                        {t.labels.slice(0, 4).map(l => <span className="task-label" key={l}>{l}</span>)}
                        {t.labels.length > 4 && <span className="task-label">+{t.labels.length - 4}</span>}
                      </div>
                    )}
                    {t.annotation_total > 0 && (
                      <div className="task-card-progress">
                        <div className="progress-track">
                          <div className="progress-fill" style={{ width: `${t.progress || 0}%`, background: t.progress === 100 ? 'var(--green, #16a34a)' : 'var(--blue, #2563eb)' }} />
                        </div>
                        <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 6, whiteSpace: 'nowrap' }}>
                          {t.resolved_annotation_count}/{t.annotation_total} 批注
                        </span>
                      </div>
                    )}
                    {t.gitlab?.last_error && <div className="task-card-error">⚠ {t.gitlab.last_error}</div>}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* generate modal */}
      {showGen && (
        <div className="modal-overlay" onClick={() => setShowGen(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">自动拆解原型功能模块</span>
              <button className="modal-close" onClick={() => setShowGen(false)}>×</button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label className="form-label">拆解粒度</label>
                <div className="granularity-options">
                  {[
                    { key: 'page', label: '按页面', desc: '每个 HTML 页面生成一个任务' },
                    { key: 'feature', label: '按功能点', desc: '按页内标题/区块生成任务' },
                    { key: 'interaction', label: '按交互流程', desc: '按表单/按钮/跳转拆分任务' }
                  ].map(g => (
                    <div
                      key={g.key}
                      className={`granularity-option ${genGranularity === g.key ? 'active' : ''}`}
                      onClick={() => {
                        setGenGranularity(g.key);
                        setPreview(null);
                        setPreviewLoading(true);
                        api.generateTasksPreview(id, { ...config, granularity: g.key })
                          .then(setPreview)
                          .catch(err => { showToast('预览失败: ' + err.message, 'error'); setPreview(null); })
                          .finally(() => setPreviewLoading(false));
                      }}
                    >
                      <div className="granularity-label">{g.label}</div>
                      <div className="granularity-desc">{g.desc}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="form-group">
                <label className="form-label">预览（点击粒度即时预览）</label>
                {previewLoading ? (
                  <div style={{ padding: 12, fontSize: 12, color: 'var(--text-muted)' }}>分析原型文件与批注...</div>
                ) : preview ? (
                  <div className="preview-list">
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
                      将生成 <b>{preview.count}</b> 个任务（含批注、工时与优先级估算）
                    </div>
                    {preview.drafts.slice(0, 12).map((d, i) => (
                      <div className="preview-item" key={i}>
                        <span className={`badge ${PRIORITY_META[d.priority]?.cls || 'badge-gray'}`}>{d.priority}</span>
                        <span style={{ fontSize: 12, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.title}</span>
                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{d.estimate_hours}h</span>
                        {d.annotation_ids?.length > 0 && <span className="badge badge-blue">{d.annotation_ids.length} 批注</span>}
                      </div>
                    ))}
                    {preview.count > 12 && <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '4px 0' }}>…共 {preview.count} 个</div>}
                  </div>
                ) : (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>暂无预览</div>
                )}
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-sm btn-secondary" onClick={() => setShowGen(false)}>取消</button>
              <button className="btn btn-sm btn-primary" onClick={confirmGenerate} disabled={generating || !preview}>
                {generating ? '生成中...' : `生成 ${preview?.count || 0} 个任务`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* settings modal */}
      {showSettings && (
        <div className="modal-overlay" onClick={() => setShowSettings(false)}>
          <div className="modal" style={{ width: 560 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">任务清单设置</span>
              <button className="modal-close" onClick={() => setShowSettings(false)}>×</button>
            </div>
            <div className="modal-tabs">
              <div className={`modal-tab ${settingsTab === 'breakdown' ? 'active' : ''}`} onClick={() => setSettingsTab('breakdown')}>拆解规则</div>
              <div className={`modal-tab ${settingsTab === 'gitlab' ? 'active' : ''}`} onClick={() => setSettingsTab('gitlab')}>GitLab 集成</div>
            </div>
            <div className="modal-body">
              {settingsTab === 'breakdown' ? (
                <>
                  <div className="form-group">
                    <label className="form-label">默认拆解粒度</label>
                    <select className="form-input" value={config.granularity} onChange={e => setConfig({ ...config, granularity: e.target.value })}>
                      <option value="page">按页面</option>
                      <option value="feature">按功能点</option>
                      <option value="interaction">按交互流程</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-check">
                      <input type="checkbox" checked={!!config.auto_estimate} onChange={e => setConfig({ ...config, auto_estimate: e.target.checked })} />
                      自动估算工时（基于 DOM 复杂度）
                    </label>
                    <label className="form-check">
                      <input type="checkbox" checked={!!config.include_annotations} onChange={e => setConfig({ ...config, include_annotations: e.target.checked })} />
                      将未解决批注折叠进对应任务
                    </label>
                  </div>
                  <div className="form-group">
                    <label className="form-label">默认标签（逗号分隔）</label>
                    <input className="form-input" value={(config.default_labels || []).join(', ')} onChange={e => setConfig({ ...config, default_labels: e.target.value.split(/[,，]/).map(s => s.trim()).filter(Boolean) })} placeholder="prototype, frontend" />
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                    拆解引擎会读取原型 HTML 页面标题、区块标题、表单/按钮/导航与批注，按所选粒度生成任务。生成的每个任务包含标题、描述、优先级（P0/P1/P2）、预估工时与标签，可在列表中人工增删改、合并或拆分。
                  </div>
                </>
              ) : (
                <>
                  <div className="form-group">
                    <label className="form-label">GitLab 地址</label>
                    <input className="form-input" value={gitlabForm.base_url} onChange={e => setGitlabForm({ ...gitlabForm, base_url: e.target.value })} placeholder="https://gitlab.parsec.com.cn" />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Private Token（已保存时显示 ***）</label>
                    <input className="form-input" type="password" value={gitlabForm.private_token === '***' ? '' : gitlabForm.private_token} placeholder="glpat-xxx 或项目访问令牌" onChange={e => setGitlabForm({ ...gitlabForm, private_token: e.target.value })} />
                  </div>
                  <div className="form-group">
                    <label className="form-label">GitLab 项目 ID（数字或 namespace/path）</label>
                    <input className="form-input" value={gitlabForm.project_id} onChange={e => setGitlabForm({ ...gitlabForm, project_id: e.target.value })} placeholder="如 42 或 group/project" />
                  </div>
                  <div className="form-group">
                    <label className="form-check">
                      <input type="checkbox" checked={!!gitlabForm.enabled} onChange={e => setGitlabForm({ ...gitlabForm, enabled: e.target.checked })} />
                      启用 GitLab 集成
                    </label>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn btn-sm btn-secondary" onClick={testGitlab} disabled={testingGitlab}>
                      {testingGitlab ? '测试中...' : '测试连接'}
                    </button>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6, marginTop: 8 }}>
                    推送时自动调用 GitLab REST API v4 创建 Issue，并将 issue 编号/链接回写到任务。Token 仅存于服务端。
                  </div>
                </>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-sm btn-secondary" onClick={() => setShowSettings(false)}>取消</button>
              <button className="btn btn-sm btn-primary" onClick={saveSettings}>保存</button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className={`toast toast-${toast.type}`}>{toast.msg}</div>}
    </div>
  );
}
