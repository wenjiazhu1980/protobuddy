import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api, getOwnerToken, buildRegenerateCmd } from '../api.js';
import { useOwnerAuth } from '../components/OwnerAuthContext.jsx';

export default function PlanReview() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { guard } = useOwnerAuth();
  const [project, setProject] = useState(null);
  const [plans, setPlans] = useState([]);
  const [selectedPlan, setSelectedPlan] = useState(null);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [toast, setToast] = useState(null);
  const [regenerateBanner, setRegenerateBanner] = useState(null);
  const [rollingBack, setRollingBack] = useState(false);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const load = useCallback(async () => {
    try {
      const [p, planList] = await Promise.all([
        api.getProject(id),
        api.listPlans(id).catch(() => [])
      ]);
      setProject(p);
      setPlans(planList);
      if (planList.length > 0 && !selectedPlan) {
        setSelectedPlan(planList[0]);
      }
    } catch (err) {
      showToast('加载失败: ' + err.message, 'error');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const handleApproveChange = async (changeId) => {
    try {
      // Plan review is an owner operation (one-time password per session)
      await guard(id, () => api.approveChange(selectedPlan.id, changeId, getOwnerToken(id)));
      // Update local state
      const updated = {
        ...selectedPlan,
        changes: selectedPlan.changes.map(c =>
          c.id === changeId ? { ...c, status: 'approved' } : c
        )
      };
      setSelectedPlan(updated);
      setPlans(plans.map(p => p.id === updated.id ? updated : p));
    } catch (err) {
      if (err.message !== 'owner verification cancelled') showToast('操作失败: ' + err.message, 'error');
    }
  };

  const handleRejectChange = async (changeId) => {
    try {
      await guard(id, () => api.rejectChange(selectedPlan.id, changeId, getOwnerToken(id)));
      const updated = {
        ...selectedPlan,
        changes: selectedPlan.changes.map(c =>
          c.id === changeId ? { ...c, status: 'rejected' } : c
        )
      };
      setSelectedPlan(updated);
      setPlans(plans.map(p => p.id === updated.id ? updated : p));
    } catch (err) {
      if (err.message !== 'owner verification cancelled') showToast('操作失败: ' + err.message, 'error');
    }
  };

  const handleApplyPlan = async () => {
    const approved = selectedPlan.changes?.filter(c => c.status === 'approved') || [];
    if (approved.length === 0) {
      showToast('请先批准至少一条修改建议', 'error');
      return;
    }
    // Dry-run precheck heads-up: approved changes that already failed the
    // generation-time match check will fail at apply time too.
    const badApproved = approved.filter(c => c.validation?.status === 'error');
    const warnText = badApproved.length > 0
      ? `\n\n⚠ 注意：${badApproved.length} 条已批准的修改未通过预检（${badApproved.map(c => c.validation.message).join('；')}），应用时将失败，建议先驳回。`
      : '';
    if (!confirm(`确定应用 ${approved.length} 条已批准的修改？这将修改原型文件并自动重新部署。${warnText}`)) return;

    setApplying(true);
    try {
      // Applying a plan rewrites prototype files and redeploys — owner operation.
      // Failure semantics: if any change cannot be applied, the backend answers
      // HTTP 409 and this falls into the catch below — we stay on the page,
      // show the concrete error and let the owner fix/reject the failing change
      // and retry. If only the redeploy failed (HTTP 200 + success:false) the
      // files WERE changed, so we report the deploy issue distinctly.
      const result = await guard(id, () => api.applyPlan(selectedPlan.id, getOwnerToken(id)));
      if (result.regenerateRequired) {
        // 方案 A：修改已写入存储，但项目含 Python 生成器脚本，线上无法执行 →
        // 保留本页并展示外部执行指引，不误报"部署成功"。
        setRegenerateBanner(result.regenerateRequired);
        showToast(`修改已应用（${result.appliedCount} 条），需执行生成器重新生成 HTML 后再部署`, 'error');
        load();
      } else if (result.success) {
        showToast(`成功应用 ${result.appliedCount} 条修改，原型已重新部署`);
        load();
        navigate(`/project/${id}`);
      } else if ((result.appliedCount || 0) > 0) {
        showToast(`修改已应用，但重新部署失败: ${result.deployError || result.errors?.[0] || '未知错误'}`, 'error');
        load();
      } else {
        showToast(`应用失败: ${result.errors?.join('; ') || '未知错误'}`, 'error');
        load();
      }
    } catch (err) {
      if (err.message !== 'owner verification cancelled') {
        showToast(`应用失败: ${err.message}${err.errors?.length ? `（${err.errors.length} 条建议未通过）` : ''}。已创建快照，可点「回滚到应用前」恢复`, 'error');
        // 失败后刷新：失败的修改会回退为「已通过」，可修正/驳回后重试；
        // 快照已生成，rollback_available 会置真并显示回滚按钮
        load();
      }
    } finally {
      setApplying(false);
    }
  };

  // Roll back to the pre-apply snapshot (regression snapshot). Restores every
  // file the apply touched, resets applied changes to approved and redeploys.
  const handleRollback = async () => {
    if (!confirm('⚠ 确定回滚？\n\n将把该方案上次应用时修改的所有文件恢复到应用前状态（快照），已应用的修改建议会回到「已通过」状态、相关批注重新打开，然后自动重新部署。此操作不可撤销回滚本身。')) return;
    setRollingBack(true);
    try {
      const result = await guard(id, () => api.rollbackPlan(selectedPlan.id, getOwnerToken(id)));
      if (result.regenerateRequired) {
        setRegenerateBanner(result.regenerateRequired);
        showToast(`已回滚 ${result.restoredCount} 个文件，需执行生成器重新生成 HTML 后再部署`, 'error');
        load();
      } else if (result.success) {
        showToast(`已回滚 ${result.restoredCount} 个文件、重置 ${result.changesReset} 条修改建议，原型已重新部署`);
        load();
      } else {
        showToast(`文件已回滚，但重新部署失败: ${result.deployError || result.errors?.[0] || '未知错误'}`, 'error');
        load();
      }
    } catch (err) {
      if (err.message !== 'owner verification cancelled') showToast('回滚失败: ' + err.message, 'error');
    } finally {
      setRollingBack(false);
    }
  };

  const statusBadge = (status) => {
    const map = {
      pending: { cls: 'badge-yellow', text: '待审核' },
      approved: { cls: 'badge-green', text: '已通过' },
      rejected: { cls: 'badge-red', text: '已驳回' },
      applied: { cls: 'badge-blue', text: '已应用' },
    };
    const s = map[status] || { cls: 'badge-gray', text: status };
    return <span className={`badge ${s.cls}`}>{s.text}</span>;
  };

  // Dry-run precheck badge: generated by the backend right after plan generation
  // (old_code unique-match verification against real file content).
  const validationBadge = (validation) => {
    if (!validation) return null;
    if (validation.status === 'ok') {
      return (
        <span className="badge badge-green" title={validation.message || ''}>
          ✓ 预检通过{validation.match_count === 1 ? '（唯一匹配）' : ''}
        </span>
      );
    }
    if (validation.status === 'warn') {
      return (
        <span className="badge badge-yellow" title={validation.message}>
          ⚠ 预检警告
        </span>
      );
    }
    return (
      <span className="badge badge-red" title={validation.message}>
        ✕ 预检未通过
      </span>
    );
  };

  const planStatusBadge = (status) => {
    const map = {
      draft: { cls: 'badge-yellow', text: '草稿' },
      approved: { cls: 'badge-green', text: '已批准' },
      rejected: { cls: 'badge-red', text: '已驳回' },
      applied: { cls: 'badge-blue', text: '已应用' },
    };
    const s = map[status] || { cls: 'badge-gray', text: status };
    return <span className={`badge ${s.cls}`}>{s.text}</span>;
  };

  if (loading) {
    return <div className="main-content"><div className="loading-container"><div className="spinner" /><span>加载中...</span></div></div>;
  }

  return (
    <div className="main-content" style={{ paddingTop: 16 }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <Link to={`/project/${id}`} style={{ fontSize: 13 }}>← 返回仪表盘</Link>
          <h1 style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>{project?.name} · 方案审核</h1>
        </div>
        <button className="btn btn-secondary" onClick={() => navigate(`/project/${id}/review`)}>← 返回评审</button>
      </div>

      {/* 方案 A：生成器外部执行提示条 */}
      {regenerateBanner && (
        <div className="regenerate-banner" style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>
            ⚠ 修改已应用，但需要重新生成原型后再部署
          </div>
          <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--text-muted)' }}>
            {regenerateBanner.message}
          </div>
          {regenerateBanner.hint && (() => {
            const cmd = buildRegenerateCmd(id, regenerateBanner.hint);
            return (
              <div className="regenerate-cmd">
                <code>{cmd}</code>
                <button
                  className="btn btn-sm btn-secondary"
                  onClick={() => {
                    navigator.clipboard?.writeText(cmd);
                    showToast('命令已复制');
                  }}
                >
                  复制命令
                </button>
              </div>
            );
          })()}
        </div>
      )}

      {/* Plan selector */}
      {plans.length > 1 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-header">
            <span className="card-title">方案列表</span>
          </div>
          <div className="card-body" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {plans.map(p => (
              <button
                key={p.id}
                className={`btn btn-sm ${selectedPlan?.id === p.id ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setSelectedPlan(p)}
              >
                方案 #{p.id} · {planStatusBadge(p.status)} · {new Date(p.created_at).toLocaleDateString('zh-CN')}
              </button>
            ))}
          </div>
        </div>
      )}

      {plans.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: 64, height: 64, margin: '0 auto 16px', opacity: 0.4 }}>
              <path d="M9 11l3 3L22 4" />
              <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
            </svg>
            <div className="empty-state-title">还没有修改方案</div>
            <div className="empty-state-desc">在评审页面添加批注后，点击「生成修改方案」让 Agent 生成结构化建议</div>
            <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={() => navigate(`/project/${id}/review`)}>前往评审 →</button>
          </div>
        </div>
      ) : selectedPlan ? (
        <div>
          {/* Plan summary */}
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span className="card-title">方案 #{selectedPlan.id}</span>
                {planStatusBadge(selectedPlan.status)}
                <span className={`badge ${selectedPlan.method === 'makers' ? 'badge-blue' : 'badge-yellow'}`}>
                  {selectedPlan.method === 'makers' ? `Makers Models${selectedPlan.model ? ` · ${selectedPlan.model}` : ''}` : '规则引擎'}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                {selectedPlan.rollback_available && (
                  <button
                    className="btn btn-secondary"
                    style={{ color: 'var(--red)' }}
                    onClick={handleRollback}
                    disabled={rollingBack || applying}
                    title="恢复该方案上次应用前的文件内容（快照回滚）"
                  >
                    {rollingBack ? '回滚中...' : '↩ 回滚到应用前'}
                  </button>
                )}
                <button className="btn btn-primary" onClick={handleApplyPlan} disabled={applying || selectedPlan.status === 'applied'}>
                  {applying ? '应用中...' : '应用已批准的修改'}
                </button>
              </div>
            </div>
            <div className="card-body">
              <div style={{ marginBottom: 12 }}>
                <strong>摘要：</strong> {selectedPlan.summary}
              </div>
              {selectedPlan.method !== 'makers' && selectedPlan.fallback_reason && (
                <div style={{ marginBottom: 12, padding: 10, background: '#fff7ed', border: '1px solid #fdba74', borderRadius: 6, fontSize: 12, color: '#7c2d12' }}>
                  <strong>⚠ 本次使用了规则引擎兜底：</strong> {selectedPlan.fallback_reason}
                </div>
              )}
              {selectedPlan.precheck && !selectedPlan.precheck.passed && (
                <div style={{ marginBottom: 12, padding: 10, background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 6, fontSize: 12, color: '#7f1d1d' }}>
                  <strong>✕ 预检未通过：</strong> {selectedPlan.precheck.error_count} 条修改建议的 old_code 无法在目标文件中唯一匹配（应用时会失败）。
                  {selectedPlan.precheck.retried && ' 已自动带错误反馈重新生成一次，仍未通过。'}
                  建议驳回未通过的条目后重新生成方案。
                </div>
              )}
              {selectedPlan.precheck && selectedPlan.precheck.passed && selectedPlan.precheck.retried && (
                <div style={{ marginBottom: 12, padding: 10, background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 6, fontSize: 12, color: '#14532d' }}>
                  <strong>✓ 预检通过：</strong> 首次生成未通过自动校验，已带错误反馈重新生成并通过（{selectedPlan.precheck.checked} 条修改均唯一匹配）。
                </div>
              )}
              {selectedPlan.consistency && (
                <div style={{
                  marginBottom: 12, padding: 10, borderRadius: 6, fontSize: 12,
                  background: selectedPlan.consistency.uncovered_count > 0 ? '#fef2f2' : '#f0fdf4',
                  border: `1px solid ${selectedPlan.consistency.uncovered_count > 0 ? '#fca5a5' : '#86efac'}`,
                  color: selectedPlan.consistency.uncovered_count > 0 ? '#7f1d1d' : '#14532d'
                }}>
                  <strong>
                    {selectedPlan.consistency.uncovered_count > 0 ? '✕ 批注一致性未通过：' : '✓ 批注一致性通过：'}
                  </strong>
                  {' '}共 {selectedPlan.consistency.checked} 条批注，
                  已回应 {selectedPlan.consistency.covered_count} 条
                  {selectedPlan.consistency.weak_count > 0 && `、回应较弱 ${selectedPlan.consistency.weak_count} 条`}
                  {selectedPlan.consistency.uncovered_count > 0 && `、未回应 ${selectedPlan.consistency.uncovered_count} 条`}
                  {(selectedPlan.consistency.results || []).filter(r => r.status !== 'covered').map(r => (
                    <div key={r.annotation_id} style={{ marginTop: 6, paddingLeft: 8, borderLeft: '2px solid currentColor' }}>
                      {r.status === 'uncovered' ? '✕' : '⚠'} 批注 #{r.annotation_id}
                      {r.page ? `（${r.page}）` : ''}：{r.content}
                      {r.matched_changes?.length > 0 && ` → 关联修改 #${r.matched_changes.join('、#')}`}
                      {r.status === 'uncovered' && ' —— 方案未覆盖该批注诉求，建议驳回后补充批注重新生成'}
                    </div>
                  ))}
                </div>
              )}
              <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                基于批注: {selectedPlan.annotations?.length || 0} 条 ·
                修改建议: {selectedPlan.changes?.length || 0} 条 ·
                生成时间: {new Date(selectedPlan.created_at).toLocaleString('zh-CN')}
              </div>
            </div>
          </div>

          {/* Change list */}
          <div>
            <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>修改建议 ({selectedPlan.changes?.length || 0})</h3>
            {selectedPlan.changes?.map((change, idx) => (
              <div key={change.id} className="plan-change-card">
                <div className="plan-change-header">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 600 }}>#{idx + 1}</span>
                    {statusBadge(change.status)}
                    {validationBadge(change.validation)}
                    {change.annotation_id && (
                      <span className="badge badge-gray" title="该修改针对的批注">批注 #{change.annotation_id}</span>
                    )}
                    <span style={{ fontSize: 13, fontFamily: 'monospace', color: 'var(--text-muted)' }}>{change.file_path}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {change.status === 'pending' && (
                      <>
                        <button className="btn btn-sm btn-secondary" style={{ color: 'var(--red)' }} onClick={() => handleRejectChange(change.id)}>驳回</button>
                        <button className="btn btn-sm btn-primary" onClick={() => handleApproveChange(change.id)}>通过</button>
                      </>
                    )}
                    {change.status === 'approved' && (
                      <span style={{ fontSize: 12, color: 'var(--green)' }}>✓ 已通过，等待应用</span>
                    )}
                    {change.status === 'rejected' && (
                      <span style={{ fontSize: 12, color: 'var(--red)' }}>✕ 已驳回</span>
                    )}
                    {change.status === 'applied' && (
                      <span style={{ fontSize: 12, color: 'var(--primary)' }}>✓ 已应用</span>
                    )}
                  </div>
                </div>
                <div className="plan-change-body">
                  <div style={{ marginBottom: 8 }}>{change.description}</div>
                  {change.validation?.status === 'error' && (
                    <div style={{ marginBottom: 8, padding: 8, background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 6, fontSize: 12, color: '#7f1d1d' }}>
                      ✕ 预检未通过：{change.validation.message}
                    </div>
                  )}
                  {change.validation?.status === 'warn' && change.validation.message && (
                    <div style={{ marginBottom: 8, padding: 8, background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 6, fontSize: 12, color: '#78350f' }}>
                      ⚠ {change.validation.message}
                    </div>
                  )}
                  {change.old_code && (
                    <div>
                      <div className="code-label">原代码</div>
                      <pre className="code-block">{change.old_code}</pre>
                    </div>
                  )}
                  {change.new_code && (
                    <div>
                      <div className="code-label" style={{ color: 'var(--green)' }}>新代码</div>
                      <pre className="code-block" style={{ background: '#0f172a', borderLeft: '3px solid var(--green)' }}>{change.new_code}</pre>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {toast && <div className={`toast toast-${toast.type}`}>{toast.msg}</div>}
    </div>
  );
}
