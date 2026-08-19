/**
 * Issue export / GitLab private integration.
 *
 * Generated issues can be exported in standard formats or pushed to a private
 * GitLab instance (e.g. the company's gitlab.parsec.com.cn) via the GitLab
 * REST API v4.
 *
 * GitLab config is stored per project (settings key `gitlabConfig:{projectId}`):
 *   { base_url, private_token, project_id, enabled }
 * `base_url` is the GitLab host (e.g. https://gitlab.parsec.com.cn), `project_id`
 * the numeric GitLab project id (or URL-encoded namespace/path).
 */

export function defaultGitlabConfig() {
  return { base_url: '', private_token: '', project_id: '', enabled: false };
}

/** Build the GitLab REST base for a config. */
export function gitlabApiBase(cfg) {
  return `${String(cfg.base_url || '').replace(/\/+$/, '')}/api/v4`;
}

/* ------------------------------- exporters ------------------------------- */

/** Standard JSON export (array of issue objects). */
export function exportTasksJSON(tasks) {
  return tasks.map(t => ({
    title: t.title,
    description: t.description,
    status: t.status,
    priority: t.priority,
    estimate_hours: t.estimate_hours,
    labels: t.labels,
    module_path: t.module_path,
    source: t.source,
    source_ref: t.source_ref,
    gitlab: t.gitlab || null
  }));
}

/** CSV export (GitLab-compatible import columns). */
export function exportTasksCSV(tasks) {
  const esc = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const header = ['title', 'description', 'state', 'labels', 'weight', 'due_date', 'assignee_ids', 'milestone'];
  const rows = tasks.map(t => [
    esc(t.title),
    esc(t.description || ''),
    esc(t.status === 'done' ? 'closed' : 'opened'),
    esc((t.labels || []).join(',')),
    esc(t.estimate_hours != null ? Math.max(1, Math.round(t.estimate_hours)) : ''),
    '',
    '',
    ''
  ].join(','));
  return [header.join(','), ...rows].join('\n');
}

/**
 * Push issues to a private GitLab project via REST API v4.
 * Returns an array of { taskId, ok, iid?, url?, error? } and mutates nothing
 * itself — the caller persists the gitlab link back onto each task.
 */
export async function pushTasksToGitlab(cfg, tasks) {
  if (!cfg || !cfg.enabled) throw new Error('GitLab 集成未启用，请先在任务清单-设置中配置并启用');
  if (!cfg.base_url || !cfg.private_token || !cfg.project_id) {
    throw new Error('GitLab 配置不完整：需要 base_url、private_token、project_id');
  }

  const base = gitlabApiBase(cfg);
  const proj = encodeURIComponent(String(cfg.project_id));
  const results = [];

  for (const t of tasks) {
    const payload = {
      title: t.title,
      description: t.description || '',
      labels: (t.labels || []).join(','),
      weight: t.estimate_hours != null ? Math.max(1, Math.round(t.estimate_hours)) : undefined
    };
    try {
      const res = await fetch(`${base}/projects/${proj}/issues`, {
        method: 'POST',
        headers: {
          'PRIVATE-TOKEN': cfg.private_token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        results.push({ taskId: t.id, ok: false, error: `HTTP ${res.status}: ${data.message || data.error || 'unknown'}` });
      } else {
        results.push({
          taskId: t.id,
          ok: true,
          iid: data.iid,
          url: data.web_url || `${cfg.base_url}/-/issues/${data.iid}`,
          state: data.state
        });
      }
    } catch (err) {
      results.push({ taskId: t.id, ok: false, error: err.message });
    }
  }
  return results;
}

/** Test the GitLab connection (GET project info). */
export async function testGitlabConnection(cfg) {
  if (!cfg.base_url || !cfg.private_token || !cfg.project_id) {
    throw new Error('GitLab 配置不完整');
  }
  const base = gitlabApiBase(cfg);
  const proj = encodeURIComponent(String(cfg.project_id));
  const res = await fetch(`${base}/projects/${proj}`, {
    headers: { 'PRIVATE-TOKEN': cfg.private_token }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${data.message || data.error || '连接失败'}`);
  }
  return { name: data.name, path_with_namespace: data.path_with_namespace, web_url: data.web_url };
}
