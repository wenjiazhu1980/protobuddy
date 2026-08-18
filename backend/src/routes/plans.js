import { Router } from 'express';
import { getById, query, insert, update } from '../db.js';
import { generatePlanWithMakers } from '../services/makersModels.js';
import { readFileContent, writeFileContent, findEntryPoint } from '../services/fileStorage.js';
import { deployToEdgeOne } from '../services/edgeone.js';
import { prepareForDeploy } from '../services/generator.js';
import { requireOwnerAuth } from '../services/ownerAuth.js';

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

  // Get current files with content.
  // IMPORTANT: only read files relevant to the annotations first (ranked by the
  // page they target), then top up with other files up to a cap of 10. Reading
  // ALL files (some >700KB) serially from blob can push the request past the
  // 120s Cloud Functions limit once combined with a slow reasoning model
  // (e.g. @makers/kimi-k2.6 takes 30-60s to think).
  const fileRecords = await query('files', f => String(f.project_id) === String(req.params.id));
  const targetPages = [...new Set(annotations.map(a => a.page).filter(Boolean))];
  const rank = f => {
    const hit = targetPages.findIndex(p => f.path === p || f.path.endsWith('/' + p));
    return hit === -1 ? 999 : hit;
  };
  const selectedFiles = [...fileRecords].sort((a, b) => rank(a) - rank(b)).slice(0, 10);
  const filesWithContent = [];
  for (const f of selectedFiles) {
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

// Approve/reject a plan (overall) — plan review is an owner operation
router.post('/plans/:planId/approve', requireOwnerAuth, async (req, res) => {
  const plan = await getById('plans', req.params.planId);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });

  const updated = await update('plans', req.params.planId, { status: 'approved' });
  res.json(updated);
});

router.post('/plans/:planId/reject', requireOwnerAuth, async (req, res) => {
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

// Approve/reject individual changes — plan review is an owner operation
router.post('/plans/:planId/changes/:changeId/approve', requireOwnerAuth, async (req, res) => {
  const change = await getById('planChanges', req.params.changeId);
  if (!change || String(change.plan_id) !== String(req.params.planId)) {
    return res.status(404).json({ error: 'Change not found' });
  }

  const updated = await update('planChanges', req.params.changeId, { status: 'approved' });
  res.json(updated);
});

router.post('/plans/:planId/changes/:changeId/reject', requireOwnerAuth, async (req, res) => {
  const change = await getById('planChanges', req.params.changeId);
  if (!change || String(change.plan_id) !== String(req.params.planId)) {
    return res.status(404).json({ error: 'Change not found' });
  }

  const updated = await update('planChanges', req.params.changeId, { status: 'rejected' });
  res.json(updated);
});

// Apply approved changes to files and trigger redeploy — owner operation.
// Failure semantics (fixed): when any change fails to apply, the plan is NOT
// marked 'applied', annotations are NOT resolved, failed changes roll back to
// 'approved' so the owner can fix and retry, and the response is HTTP 409 with
// the concrete errors. Previously the handler returned HTTP 200 with
// success:false and unconditionally set status='applied' + resolved annotations,
// which silently turned a failed apply into an un-retryable "success".
router.post('/plans/:planId/apply', requireOwnerAuth, async (req, res) => {
  const plan = await getById('plans', req.params.planId);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });

  const changes = await query('planChanges', c =>
    String(c.plan_id) === String(req.params.planId) && c.status === 'approved'
  );

  if (changes.length === 0) {
    return res.status(400).json({ error: 'No approved changes to apply' });
  }

  const appliedChanges = [];
  const failedChanges = [];
  const errors = [];

  for (const change of changes) {
    try {
      // Read current file content
      const current = await readFileContent(plan.project_id, change.file_path);
      if (!current) {
        errors.push(`文件不存在: ${change.file_path}`);
        failedChanges.push(change);
        continue;
      }

      if (current.binary) {
        errors.push(`无法对二进制文件应用修改: ${change.file_path}`);
        failedChanges.push(change);
        continue;
      }

      let content = current.data;
      let nextContent = null;

      // Apply the change: replace old_code with new_code. We require old_code
      // to exist and be unique in the file so we never change the wrong place.
      if (change.old_code && change.new_code) {
        if (!content.includes(change.old_code)) {
          errors.push(`old_code 未在 ${change.file_path} 中找到，未做任何修改。生成的修改可能不精确，请驳回该条建议并创建更精确的批注。`);
          failedChanges.push(change);
          continue;
        }
        const occurrences = content.split(change.old_code).length - 1;
        if (occurrences > 1) {
          errors.push(`old_code 在 ${change.file_path} 中匹配 ${occurrences} 次，无法安全应用（会改动多个位置）。请驳回该条建议并创建更具体的批注。`);
          failedChanges.push(change);
          continue;
        }
        nextContent = content.replace(change.old_code, change.new_code);
      } else if (change.new_code) {
        // If old_code doesn't match, append the new code with a comment
        nextContent = content + `\n\n<!-- Applied change: ${change.description} -->\n${change.new_code}\n`;
      } else {
        errors.push(`该修改建议无可执行的代码变更: ${change.file_path}`);
        failedChanges.push(change);
        continue;
      }

      // Write the file back and CHECK the driver's result (blob/local drivers
      // can return false without throwing, e.g. empty normalized path).
      const wrote = await writeFileContent(plan.project_id, change.file_path, nextContent);
      if (!wrote) {
        errors.push(`写入文件失败: ${change.file_path}（存储驱动未确认写入）`);
        failedChanges.push(change);
        continue;
      }
      await update('planChanges', change.id, { status: 'applied' });
      appliedChanges.push(change.id);
    } catch (err) {
      errors.push(`应用 ${change.file_path} 时出错: ${err.message}`);
      failedChanges.push(change);
    }
  }

  const allChangesApplied = errors.length === 0;
  if (allChangesApplied) {
    // Everything applied cleanly: finalize the plan and resolve its annotations.
    await update('plans', req.params.planId, { status: 'applied' });
    for (const change of changes) {
      if (change.annotation_id) {
        await update('annotations', change.annotation_id, { status: 'resolved' });
      }
    }
  } else {
    // Roll failed changes back to 'approved' (already-applied ones stay
    // 'applied') so the owner can fix the failing change and retry the apply.
    for (const change of failedChanges) {
      await update('planChanges', change.id, { status: 'approved' });
    }
    await update('plans', req.params.planId, { status: 'approved' });
  }

  // Trigger redeploy — only when at least one change was actually written.
  let deployResult = null;
  let deployError = '';
  let regenerateRequired = null;
  if (appliedChanges.length > 0) {
    const project = await getById('projects', plan.project_id);
    if (project) {
      try {
        // 方案 A：重新部署前检查 Python 生成器。apply 修改的可能是生成器脚本
        // （如 phase-2/_gen_pages.py），必须先重新生成 HTML 再部署。
        // - local 模式：自动执行生成器后再部署（完整闭环）
        // - blob 模式：线上无法执行 Python → 跳过部署，返回 regenerateRequired，
        //   由外部执行环境 CLI（scripts/regenerate.js）完成生成 + 部署
        // - ?force=1：跳过生成器检查，直接部署现有产物
        const gen = await prepareForDeploy(plan.project_id, { force: req.query.force === '1' });
        if (gen.generator && gen.needsExternal) {
          regenerateRequired = {
            script: gen.generator.script,
            message: gen.message,
            hint: `node scripts/regenerate.js --project ${plan.project_id} --api ${req.protocol}://${req.get('host')}`
          };
        } else if (gen.generator && gen.ran && !gen.ok) {
          deployError = `生成器执行失败，未重新部署: ${gen.error}${gen.stderr ? `\n${gen.stderr}` : ''}`;
        } else {
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

          if (!deployResult.success) {
            deployError = `重新部署失败: ${deployResult.error || 'unknown error'}`;
          }
        }
      } catch (err) {
        deployError = `重新部署失败: ${err.message}`;
      }
    }
  }

  // Response semantics:
  // - Any change that failed to apply -> HTTP 409 (conflict, retryable) with
  //   the concrete errors. The plan stayed/rolled back to 'approved'.
  // - All changes applied but redeploy failed -> HTTP 200 + success:false so
  //   the file edits are not mistaken for a failure, yet the deploy issue is
  //   clearly reported.
  // - All changes applied, project has a Python generator, and the runtime
  //   cannot execute it (blob mode) -> HTTP 200 + success:true + appliedCount,
  //   but deploySkipped:true + regenerateRequired so the UI routes the owner to
  //   the external execution environment (scripts/regenerate.js).
  // - Everything ok -> HTTP 200 + success:true.
  const body = {
    success: allChangesApplied && !deployError && !regenerateRequired,
    appliedCount: appliedChanges.length,
    errorCount: errors.length + (deployError ? 1 : 0),
    errors,
    deployError: deployError || undefined,
    deploySkipped: !!regenerateRequired,
    regenerateRequired: regenerateRequired || undefined,
    deployResult: deployResult ? { method: deployResult.method, url: deployResult.url } : null
  };

  if (!allChangesApplied) {
    return res.status(409).json({ ...body, error: errors[0] || '应用修改失败' });
  }
  res.json(body);
});

export default router;
