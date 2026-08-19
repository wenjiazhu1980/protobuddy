/**
 * Task list module routes.
 *
 * Mounted at /api/projects/:id/tasks*.
 * Provides:
 *   - task CRUD (manual create/edit/delete, owner-gated for mutations)
 *   - auto breakdown from prototype (POST /generate) with configurable
 *     granularity + manual adjust (merge / split)
 *   - breakdown config get/put (owner)
 *   - export (JSON / CSV / GitLab push)
 *   - annotation sync: when prototype annotations are resolved, linked issues
 *     update progress / status (POST /sync-annotations)
 */
import { Router } from 'express';
import { getById, query, insert, update, remove, getSetting, setSetting } from '../db.js';
import { requireOwnerAuth } from '../services/ownerAuth.js';
import { breakdownPrototype, defaultBreakdownConfig } from '../services/breakdown.js';
import {
  exportTasksJSON, exportTasksCSV, pushTasksToGitlab, testGitlabConnection, defaultGitlabConfig
} from '../services/gitlabIssues.js';

const router = Router();

const TASK_STATUSES = ['todo', 'in_progress', 'done'];
const TASK_PRIORITIES = ['P0', 'P1', 'P2'];

/* -------------------------------- helpers -------------------------------- */

const configKey = (projectId) => `taskBreakdownConfig:${projectId}`;
const gitlabKey = (projectId) => `gitlabConfig:${projectId}`;

async function getProjectTasks(projectId) {
  const rows = await query('tasks', t => String(t.project_id) === String(projectId));
  return rows.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
}

function cleanTask(t) {
  return {
    ...t,
    project_id: String(t.project_id),
    annotation_ids: t.annotation_ids || [],
    labels: t.labels || [],
    module_path: t.module_path || [],
    children_ids: t.children_ids || []
  };
}

/* ------------------------------ CRUD routes ------------------------------ */

// List tasks (optionally filtered by status / source)
router.get('/:id/tasks', async (req, res) => {
  const project = await getById('projects', req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  let tasks = await getProjectTasks(req.params.id);
  if (req.query.status) tasks = tasks.filter(t => t.status === req.query.status);
  if (req.query.source) tasks = tasks.filter(t => t.source === req.query.source);
  if (req.query.priority) tasks = tasks.filter(t => t.priority === req.query.priority);

  // Resolve annotations count for progress display
  const anns = await query('annotations', a => String(a.project_id) === String(req.params.id));
  const annById = new Map(anns.map(a => [String(a.id), a]));

  res.json(tasks.map(t => {
    const clean = cleanTask(t);
    const linked = (clean.annotation_ids || []).filter(id => annById.has(String(id)));
    const resolved = linked.filter(id => annById.get(String(id)).status === 'resolved').length;
    clean.resolved_annotation_count = resolved;
    clean.annotation_total = linked.length;
    clean.progress = linked.length ? Math.round((resolved / linked.length) * 100) : (clean.status === 'done' ? 100 : 0);
    return clean;
  }));
});

// Create manual task — owner operation
router.post('/:id/tasks', requireOwnerAuth, async (req, res) => {
  const project = await getById('projects', req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { title, description, status, priority, estimate_hours, labels, module_path } = req.body;
  if (!title || !String(title).trim()) {
    return res.status(400).json({ error: '任务标题不能为空' });
  }

  const tasks = await getProjectTasks(req.params.id);
  const task = await insert('tasks', {
    project_id: String(req.params.id),
    title: String(title).trim(),
    description: description || '',
    status: TASK_STATUSES.includes(status) ? status : 'todo',
    priority: TASK_PRIORITIES.includes(priority) ? priority : 'P2',
    estimate_hours: estimate_hours != null ? Number(estimate_hours) : 1,
    labels: Array.isArray(labels) ? labels : (labels ? String(labels).split(',').map(s => s.trim()).filter(Boolean) : []),
    module_path: Array.isArray(module_path) ? module_path : [],
    source: 'manual',
    source_ref: null,
    annotation_ids: [],
    parent_id: null,
    children_ids: [],
    sort_order: tasks.length + 1
  });
  res.status(201).json(cleanTask(task));
});

/* ------------------------------ auto breakdown ------------------------------ */

// Generate issues from prototype — owner operation
router.post('/:id/tasks/generate', requireOwnerAuth, async (req, res) => {
  const project = await getById('projects', req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const cfg = req.body?.config || (await getSetting(configKey(req.params.id), null)) || defaultBreakdownConfig();
  const annotations = await query('annotations', a => String(a.project_id) === String(req.params.id));

  try {
    const drafts = await breakdownPrototype({
      projectId: req.params.id,
      projectName: project.name,
      config: cfg,
      annotations
    });

    // Persist generated issues
    const tasks = await getProjectTasks(req.params.id);
    const created = [];
    for (const d of drafts) {
      const task = await insert('tasks', {
        project_id: String(req.params.id),
        title: d.title,
        description: d.description,
        status: 'todo',
        priority: d.priority,
        estimate_hours: d.estimate_hours,
        labels: d.labels,
        module_path: d.module_path,
        source: 'auto',
        source_ref: d.source_ref,
        annotation_ids: d.annotation_ids || [],
        parent_id: null,
        children_ids: [],
        sort_order: tasks.length + created.length + 1
      });
      created.push(cleanTask(task));
    }

    await setSetting(configKey(req.params.id), cfg); // remember last-used config
    res.json({ success: true, count: created.length, tasks: created, config: cfg });
  } catch (err) {
    console.error('[tasks] generate failed:', err);
    res.status(500).json({ error: `自动拆解失败: ${err.message}` });
  }
});

// Dry-run preview without persisting — returns what WOULD be generated
router.post('/:id/tasks/generate/preview', async (req, res) => {
  const project = await getById('projects', req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const cfg = req.body?.config || defaultBreakdownConfig();
  const annotations = await query('annotations', a => String(a.project_id) === String(req.params.id));
  try {
    const drafts = await breakdownPrototype({
      projectId: req.params.id,
      projectName: project.name,
      config: cfg,
      annotations
    });
    res.json({ count: drafts.length, drafts });
  } catch (err) {
    res.status(500).json({ error: `预览失败: ${err.message}` });
  }
});

/* ------------------------------ merge / split ------------------------------ */

// Merge other tasks INTO this task (keep this one, delete others) — owner
router.post('/:id/tasks/:taskId/merge', requireOwnerAuth, async (req, res) => {
  const task = await getById('tasks', req.params.taskId);
  if (!task || String(task.project_id) !== String(req.params.id)) {
    return res.status(404).json({ error: 'Task not found' });
  }
  const { task_ids } = req.body || {};
  const ids = Array.isArray(task_ids) ? task_ids : [];
  if (!ids.length) return res.status(400).json({ error: 'task_ids 不能为空' });

  const mergedAnns = [...(task.annotation_ids || [])];
  let mergedLabels = [...(task.labels || [])];
  const extraDesc = [];

  for (const id of ids) {
    if (String(id) === String(req.params.taskId)) continue;
    const other = await getById('tasks', id);
    if (!other || String(other.project_id) !== String(req.params.id)) continue;
    mergedAnns.push(...(other.annotation_ids || []));
    mergedLabels.push(...(other.labels || []));
    if (other.description) extraDesc.push(`> 合并自任务 #${other.id}「${other.title}」：\n${other.description}`);
    await remove('tasks', id);
  }

  const patch = {
    annotation_ids: [...new Set(mergedAnns)],
    labels: [...new Set(mergedLabels)],
    description: task.description + (extraDesc.length ? '\n\n---\n' + extraDesc.join('\n\n') : '')
  };
  const updated = await update('tasks', req.params.taskId, patch);
  res.json(cleanTask(updated));
});

// Split a task into sub-tasks — owner
router.post('/:id/tasks/:taskId/split', requireOwnerAuth, async (req, res) => {
  const task = await getById('tasks', req.params.taskId);
  if (!task || String(task.project_id) !== String(req.params.id)) {
    return res.status(404).json({ error: 'Task not found' });
  }
  const { parts } = req.body || {};
  if (!Array.isArray(parts) || parts.length < 2) {
    return res.status(400).json({ error: '拆分至少需要 2 个子任务' });
  }

  const tasks = await getProjectTasks(req.params.id);
  const childIds = [];
  const children = [];
  const annChunks = distribute(task.annotation_ids || [], parts.length);

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const child = await insert('tasks', {
      project_id: String(req.params.id),
      title: String(part.title || `子任务 ${i + 1}`).trim(),
      description: part.description || `由任务 #${task.id}「${task.title}」拆分而来。`,
      status: 'todo',
      priority: task.priority,
      estimate_hours: part.estimate_hours != null ? Number(part.estimate_hours) : Math.max(0.5, Math.round((task.estimate_hours || 1) / parts.length * 2) / 2),
      labels: [...(task.labels || [])],
      module_path: [...(task.module_path || []), `拆分-${i + 1}`],
      source: task.source,
      source_ref: task.source_ref,
      annotation_ids: annChunks[i],
      parent_id: task.id,
      children_ids: [],
      sort_order: tasks.length + i + 1
    });
    childIds.push(child.id);
    children.push(cleanTask(child));
  }

  const updated = await update('tasks', req.params.taskId, {
    children_ids: childIds,
    status: 'in_progress',  // parent becomes in_progress while children are split out
    annotation_ids: []
  });
  res.json({ parent: cleanTask(updated), children });
});

function distribute(arr, n) {
  const out = Array.from({ length: n }, () => []);
  arr.forEach((v, i) => out[i % n].push(v));
  return out;
}

/* ------------------------------ config routes ------------------------------ */

// Get breakdown config
router.get('/:id/tasks/config', async (req, res) => {
  const project = await getById('projects', req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const config = await getSetting(configKey(req.params.id), null) || defaultBreakdownConfig();
  res.json(config);
});

// Update breakdown config — owner
router.put('/:id/tasks/config', requireOwnerAuth, async (req, res) => {
  const project = await getById('projects', req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { granularity, auto_estimate, include_annotations, default_labels } = req.body || {};
  const current = await getSetting(configKey(req.params.id), null) || defaultBreakdownConfig();
  const next = { ...current };

  if (granularity !== undefined) {
    if (!['page', 'feature', 'interaction'].includes(granularity)) {
      return res.status(400).json({ error: '非法拆解粒度（page/feature/interaction）' });
    }
    next.granularity = granularity;
  }
  if (auto_estimate !== undefined) next.auto_estimate = !!auto_estimate;
  if (include_annotations !== undefined) next.include_annotations = !!include_annotations;
  if (default_labels !== undefined) next.default_labels = Array.isArray(default_labels) ? default_labels : [];

  await setSetting(configKey(req.params.id), next);
  res.json(next);
});

// Get GitLab integration config (token masked)
router.get('/:id/tasks/gitlab-config', async (req, res) => {
  const project = await getById('projects', req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const cfg = await getSetting(gitlabKey(req.params.id), null) || defaultGitlabConfig();
  res.json({
    ...cfg,
    private_token: cfg.private_token ? '***' : ''
  });
});

// Update GitLab integration config — owner
router.put('/:id/tasks/gitlab-config', requireOwnerAuth, async (req, res) => {
  const project = await getById('projects', req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { base_url, private_token, project_id, enabled } = req.body || {};
  const current = await getSetting(gitlabKey(req.params.id), null) || defaultGitlabConfig();
  const next = {
    ...current,
    base_url: base_url !== undefined ? String(base_url).trim() : current.base_url,
    project_id: project_id !== undefined ? String(project_id).trim() : current.project_id,
    enabled: enabled !== undefined ? !!enabled : current.enabled
  };
  // Never overwrite a stored token with the masked placeholder
  if (private_token !== undefined && private_token !== '***') {
    next.private_token = String(private_token).trim();
  }

  await setSetting(gitlabKey(req.params.id), next);
  res.json({ ...next, private_token: next.private_token ? '***' : '' });
});

// Test GitLab connection
router.post('/:id/tasks/gitlab-test', requireOwnerAuth, async (req, res) => {
  const project = await getById('projects', req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const cfg = await getSetting(gitlabKey(req.params.id), null) || defaultGitlabConfig();
  try {
    const info = await testGitlabConnection(cfg);
    res.json({ ok: true, info });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

/* ------------------------------ export routes ------------------------------ */

// Export tasks: format = json | csv (file download)
router.get('/:id/tasks/export', async (req, res) => {
  const project = await getById('projects', req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const tasks = await getProjectTasks(req.params.id);
  const format = (req.query.format || 'json').toLowerCase();
  const slug = project.slug || project.id;

  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="tasks-${slug}.csv"`);
    return res.send('\uFEFF' + exportTasksCSV(tasks));
  }

  res.setHeader('Content-Disposition', `attachment; filename="tasks-${slug}.json"`);
  res.json(exportTasksJSON(tasks));
});

// Push selected tasks to GitLab — owner
router.post('/:id/tasks/export/gitlab', requireOwnerAuth, async (req, res) => {
  const project = await getById('projects', req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const cfg = await getSetting(gitlabKey(req.params.id), null) || defaultGitlabConfig();
  const { task_ids } = req.body || {};
  const all = await getProjectTasks(req.params.id);
  const selected = Array.isArray(task_ids) && task_ids.length
    ? all.filter(t => task_ids.includes(t.id))
    : all.filter(t => !t.gitlab);  // default: push only not-yet-pushed

  if (!selected.length) return res.status(400).json({ error: '没有可推送的任务' });

  try {
    const results = await pushTasksToGitlab(cfg, selected);
    // Persist the gitlab link back onto tasks
    for (const r of results) {
      if (r.ok) {
        await update('tasks', r.taskId, {
          gitlab: { iid: r.iid, url: r.url, state: r.state || 'opened', synced_at: new Date().toISOString(), last_error: '' }
        });
      } else {
        await update('tasks', r.taskId, {
          gitlab: { ...(all.find(t => t.id === r.taskId)?.gitlab || {}), last_error: r.error, synced_at: new Date().toISOString() }
        });
      }
    }
    const okCount = results.filter(r => r.ok).length;
    res.json({ success: okCount > 0, pushed: okCount, failed: results.length - okCount, results });
  } catch (err) {
    res.status(500).json({ error: `GitLab 推送失败: ${err.message}` });
  }
});

/* ---------------------------- annotation sync ---------------------------- */

/**
 * Sync issues with the prototype's annotations:
 *  - link tasks that cover a page to annotations on that page (auto-link)
 *  - recompute resolved counts; when ALL linked annotations are resolved,
 *    transition the task to 'done' (prototype updated → issue done)
 *  - reopen task if an annotation is re-opened
 * Returns a summary of what changed.
 */
router.post('/:id/tasks/sync-annotations', async (req, res) => {
  const project = await getById('projects', req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const tasks = await getProjectTasks(req.params.id);
  const anns = await query('annotations', a => String(a.project_id) === String(req.params.id));
  const annById = new Map(anns.map(a => [String(a.id), a]));
  const changes = [];
  const byPage = (page) => {
    const key = String(page || '').split('/').pop();
    return anns.filter(a => String(a.page || '').split('/').pop() === key);
  };

  for (const task of tasks) {
    if (task.source !== 'auto' && !(task.annotation_ids || []).length) continue;
    let ids = [...(task.annotation_ids || [])];

    // auto-link: task covers a page → attach its open annotations
    const pagePath = task.source_ref?.path;
    if (pagePath) {
      const pageAnns = byPage(pagePath);
      for (const a of pageAnns) {
        if (!ids.includes(a.id)) {
          ids.push(a.id);
          changes.push({ taskId: task.id, action: 'link', annotation_id: a.id });
        }
      }
    }

    const linked = ids.filter(id => annById.has(String(id)));
    const resolved = linked.filter(id => annById.get(String(id)).status === 'resolved');
    const patch = { annotation_ids: ids };

    if (resolved.length === linked.length && linked.length > 0 && task.status !== 'done') {
      patch.status = 'done';
      changes.push({ taskId: task.id, action: 'done', resolved: linked.length, total: linked.length });
    } else if (resolved.length < linked.length && resolved.length > 0 && task.status === 'done') {
      patch.status = 'in_progress';
      changes.push({ taskId: task.id, action: 'reopen', resolved: resolved.length, total: linked.length });
    } else if (resolved.length === 0 && linked.length > 0 && task.status === 'done') {
      patch.status = 'todo';
      changes.push({ taskId: task.id, action: 'reopen_to_todo' });
    }

    if (Object.keys(patch).length) await update('tasks', task.id, patch);
  }

  res.json({ success: true, changed: changes.length, changes });
});

/* --------------------------- :taskId routes (LAST — static paths above must
   win: /export, /config, /gitlab-config would otherwise be swallowed by the
   :taskId param) --------------------------- */

// Get single task (with linked annotations)
router.get('/:id/tasks/:taskId', async (req, res) => {
  const task = await getById('tasks', req.params.taskId);
  if (!task || String(task.project_id) !== String(req.params.id)) {
    return res.status(404).json({ error: 'Task not found' });
  }
  const clean = cleanTask(task);
  const linked = await query('annotations', a =>
    String(a.project_id) === String(req.params.id) && (clean.annotation_ids || []).includes(a.id)
  );
  const resolved = linked.filter(a => a.status === 'resolved').length;
  clean.annotations = linked;
  clean.resolved_annotation_count = resolved;
  clean.annotation_total = linked.length;
  clean.progress = linked.length ? Math.round((resolved / linked.length) * 100) : (clean.status === 'done' ? 100 : 0);

  const children = clean.children_ids?.length
    ? await query('tasks', t => clean.children_ids.includes(t.id))
    : [];
  clean.children = children;
  if (clean.parent_id) {
    clean.parent = await getById('tasks', clean.parent_id);
  }
  res.json(clean);
});

// Update task — owner operation
router.put('/:id/tasks/:taskId', requireOwnerAuth, async (req, res) => {
  const task = await getById('tasks', req.params.taskId);
  if (!task || String(task.project_id) !== String(req.params.id)) {
    return res.status(404).json({ error: 'Task not found' });
  }

  const patch = {};
  const { title, description, status, priority, estimate_hours, labels, module_path } = req.body;
  if (title !== undefined && String(title).trim()) patch.title = String(title).trim();
  if (description !== undefined) patch.description = description;
  if (status !== undefined) {
    if (!TASK_STATUSES.includes(status)) return res.status(400).json({ error: '非法状态' });
    patch.status = status;
  }
  if (priority !== undefined) {
    if (!TASK_PRIORITIES.includes(priority)) return res.status(400).json({ error: '非法优先级' });
    patch.priority = priority;
  }
  if (estimate_hours !== undefined) patch.estimate_hours = Number(estimate_hours);
  if (labels !== undefined) patch.labels = Array.isArray(labels) ? labels : [];
  if (module_path !== undefined) patch.module_path = Array.isArray(module_path) ? module_path : [];

  const updated = await update('tasks', req.params.taskId, patch);
  res.json(cleanTask(updated));
});

// Delete task — owner operation
router.delete('/:id/tasks/:taskId', requireOwnerAuth, async (req, res) => {
  const task = await getById('tasks', req.params.taskId);
  if (!task || String(task.project_id) !== String(req.params.id)) {
    return res.status(404).json({ error: 'Task not found' });
  }
  await remove('tasks', req.params.taskId);
  res.json({ success: true });
});

export default router;
