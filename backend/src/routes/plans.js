import { Router } from 'express';
import { getById, query, insert, update } from '../db.js';
import { generatePlanWithMakers } from '../services/makersModels.js';
import { readFileContent, writeFileContent, findEntryPoint } from '../services/fileStorage.js';
import { deployToEdgeOne } from '../services/edgeone.js';

const router = Router();

// Generate a plan from open annotations
router.post('/:id/plan', async (req, res) => {
  const project = await getById('projects', req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  // Get open annotations
  const annotations = await query('annotations', a =>
    String(a.project_id) === String(req.params.id) && a.status === 'open'
  );

  if (annotations.length === 0) {
    return res.status(400).json({ error: 'No open annotations to generate plan from' });
  }

  // Get current files with content
  const fileRecords = await query('files', f => String(f.project_id) === String(req.params.id));
  const filesWithContent = [];
  for (const f of fileRecords) {
    const content = await readFileContent(req.params.id, f.path);
    if (content !== null) {
      filesWithContent.push({ path: f.path, content });
    }
  }

  // Load prototype rules (agents.md) from the prototype root if present.
  // Priority: entry dir (e.g. 原型设计/agents.md) > project root (agents.md) > any nested agents.md.
  // Absent file is fine — rules are optional.
  let agentsRules = '';
  try {
    const entry = await findEntryPoint(req.params.id);
    // findEntryPoint returns the ENTRY DIRECTORY (e.g. '原型设计') or '' for root.
    // Append a slash to build the directory prefix; do NOT slice it like a file path.
    const entryDir = entry && entry !== '' ? entry + '/' : '';
    const candidates = [];
    if (entryDir) candidates.push(`${entryDir}agents.md`);
    candidates.push('agents.md');
    const anyAgents = fileRecords.find(f =>
      f.path.toLowerCase() === 'agents.md' || f.path.toLowerCase().endsWith('/agents.md')
    );
    if (anyAgents && !candidates.includes(anyAgents.path)) candidates.push(anyAgents.path);

    for (const p of candidates) {
      const content = await readFileContent(req.params.id, p);
      if (content && !content.binary) {
        agentsRules = content.data;
        console.log(`[plans] Loaded agents.md rules from ${p} (${content.data.length} chars)`);
        break;
      }
    }
  } catch (err) {
    console.warn(`[plans] Failed to load agents.md: ${err.message}`);
  }

  // Generate plan
  const result = await generatePlanWithMakers(
    project.makers_key,
    annotations,
    filesWithContent,
    project.makers_model || undefined,
    agentsRules
  );

  if (!result.success) {
    return res.status(500).json({ error: result.error || 'Failed to generate plan' });
  }

  // Create plan record
  const plan = await insert('plans', {
    project_id: req.params.id,
    annotations: annotations.map(a => ({
      id: a.id,
      x: a.x,
      y: a.y,
      page: a.page,
      content: a.content,
      author: a.author,
      element_info: a.element_info || null
    })),
    summary: result.plan.summary || '',
    status: 'draft',
    method: result.method,
    model: result.model || '',
    fallback_reason: result.fallbackReason || ''
  });

  // Create plan change records
  const changes = [];
  for (const change of (result.plan.changes || [])) {
    changes.push(await insert('planChanges', {
      plan_id: plan.id,
      project_id: req.params.id,
      annotation_id: change.annotation_id || null,
      file_path: change.file_path || '',
      description: change.description || '',
      old_code: change.old_code || '',
      new_code: change.new_code || '',
      status: 'pending'
    }));
  }

  res.json({
    ...plan,
    changes
  });
});

// List plans for a project
router.get('/:id/plans', async (req, res) => {
  const plans = await query('plans', p => String(p.project_id) === String(req.params.id));
  plans.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  // Attach changes for each plan
  const plansWithChanges = [];
  for (const plan of plans) {
    const changes = await query('planChanges', c => String(c.plan_id) === String(plan.id));
    plansWithChanges.push({ ...plan, changes });
  }

  res.json(plansWithChanges);
});

// Get a single plan with changes
router.get('/plans/:planId', async (req, res) => {
  const plan = await getById('plans', req.params.planId);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });

  const changes = await query('planChanges', c => String(c.plan_id) === String(plan.id));
  res.json({ ...plan, changes });
});

// Approve/reject a plan (overall)
router.post('/plans/:planId/approve', async (req, res) => {
  const plan = await getById('plans', req.params.planId);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });

  const updated = await update('plans', req.params.planId, { status: 'approved' });
  res.json(updated);
});

router.post('/plans/:planId/reject', async (req, res) => {
  const plan = await getById('plans', req.params.planId);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });

  const updated = await update('plans', req.params.planId, { status: 'rejected' });
  // Also reject all pending changes
  const pending = await query('planChanges', c =>
    String(c.plan_id) === String(req.params.planId) && c.status === 'pending'
  );
  for (const c of pending) {
    await update('planChanges', c.id, { status: 'rejected' });
  }

  res.json(updated);
});

// Approve/reject individual changes
router.post('/plans/:planId/changes/:changeId/approve', async (req, res) => {
  const change = await getById('planChanges', req.params.changeId);
  if (!change || String(change.plan_id) !== String(req.params.planId)) {
    return res.status(404).json({ error: 'Change not found' });
  }

  const updated = await update('planChanges', req.params.changeId, { status: 'approved' });
  res.json(updated);
});

router.post('/plans/:planId/changes/:changeId/reject', async (req, res) => {
  const change = await getById('planChanges', req.params.changeId);
  if (!change || String(change.plan_id) !== String(req.params.planId)) {
    return res.status(404).json({ error: 'Change not found' });
  }

  const updated = await update('planChanges', req.params.changeId, { status: 'rejected' });
  res.json(updated);
});

// Apply approved changes to files and trigger redeploy
router.post('/plans/:planId/apply', async (req, res) => {
  const plan = await getById('plans', req.params.planId);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });

  const changes = await query('planChanges', c =>
    String(c.plan_id) === String(req.params.planId) && c.status === 'approved'
  );

  if (changes.length === 0) {
    return res.status(400).json({ error: 'No approved changes to apply' });
  }

  const appliedChanges = [];
  const errors = [];

  for (const change of changes) {
    try {
      // Read current file content
      const current = await readFileContent(plan.project_id, change.file_path);
      if (!current) {
        errors.push(`File not found: ${change.file_path}`);
        continue;
      }

      if (current.binary) {
        errors.push(`Cannot apply changes to binary file: ${change.file_path}`);
        continue;
      }

      let content = current.data;

      // Apply the change: replace old_code with new_code. We require old_code
      // to exist and be unique in the file so we never change the wrong place.
      if (change.old_code && change.new_code) {
        if (!content.includes(change.old_code)) {
          errors.push(`old_code not found in ${change.file_path}; cannot apply. The generated change may be imprecise. Reject this change and create a more specific annotation.`);
          continue;
        }
        const occurrences = content.split(change.old_code).length - 1;
        if (occurrences > 1) {
          errors.push(`old_code matches ${occurrences} times in ${change.file_path}; cannot apply safely because the change would affect multiple locations. Reject this change and create a more specific annotation.`);
          continue;
        }
        content = content.replace(change.old_code, change.new_code);
        await writeFileContent(plan.project_id, change.file_path, content);
        await update('planChanges', change.id, { status: 'applied' });
        appliedChanges.push(change.id);
      } else if (change.new_code) {
        // If old_code doesn't match, append the new code with a comment
        const insertion = `\n\n<!-- Applied change: ${change.description} -->\n${change.new_code}\n`;
        content += insertion;
        await writeFileContent(plan.project_id, change.file_path, content);
        await update('planChanges', change.id, { status: 'applied' });
        appliedChanges.push(change.id);
      } else {
        errors.push(`No actionable code change for: ${change.file_path}`);
      }
    } catch (err) {
      errors.push(`Error applying change to ${change.file_path}: ${err.message}`);
    }
  }

  // Mark plan as applied
  await update('plans', req.params.planId, { status: 'applied' });

  // Resolve annotations that were addressed
  for (const change of changes) {
    if (change.annotation_id) {
      await update('annotations', change.annotation_id, { status: 'resolved' });
    }
  }

  // Trigger redeploy
  const project = await getById('projects', plan.project_id);
  let deployResult = null;
  if (project) {
    try {
      deployResult = await deployToEdgeOne(project);
      let previewUrl = deployResult.url;
      if (deployResult.method === 'local' || deployResult.method === 'cloud_preview' || !previewUrl) {
        const baseUrl = `${req.protocol}://${req.get('host')}`;
        // In Makers Cloud Functions the API is a plain onRequest function
        // mounted at /api (not /express); locally it is /api too.
        previewUrl = `${baseUrl}/api/projects/${plan.project_id}/preview/`;
      }

      const version = (project.version || 0) + 1;
      await insert('deployments', {
        project_id: plan.project_id,
        version,
        url: previewUrl,
        env: 'production',
        status: deployResult.success ? 'success' : 'failed',
        method: deployResult.method,
        log: `Applied plan #${plan.id}: ${appliedChanges.length} changes. ${deployResult.log || ''}`
      });

      await update('projects', plan.project_id, {
        current_url: previewUrl,
        version,
        status: 'deployed'
      });
    } catch (err) {
      errors.push(`Redeploy failed: ${err.message}`);
    }
  }

  res.json({
    success: errors.length === 0,
    appliedCount: appliedChanges.length,
    errorCount: errors.length,
    errors,
    deployResult: deployResult ? { method: deployResult.method, url: deployResult.url } : null
  });
});

export default router;
