import { Router } from 'express';
import { getById, query, insert, update } from '../db.js';
import { generatePlanWithMakers } from '../services/makersModels.js';
import { checkConsistency, buildConsistencyFeedback } from '../services/consistency.js';
import { readFileContent, writeFileContent, findEntryPoint } from '../services/fileStorage.js';
import { deployToEdgeOne } from '../services/edgeone.js';
import { prepareForDeploy, apiBaseFromReq } from '../services/generator.js';
import { requireOwnerAuth } from '../services/ownerAuth.js';

const router = Router();

// Redeploy a project after files changed (apply or rollback). Shared so both
// paths get identical semantics: generator handling (local run vs external
// regenerateRequired vs force), deployment record, version bump.
async function triggerRedeploy(plan, req, logLine, changes = []) {
  let deployResult = null;
  let deployError = '';
  let regenerateRequired = null;
  let dualWriteSynced = null;
  const project = await getById('projects', plan.project_id);
  if (!project) return { deployResult, deployError, regenerateRequired, dualWriteSynced };
  try {
    // Option A: before redeploying, check for a Python generator. The change
    // may have touched the generator script (e.g. phase-2/_gen_pages.py), in
    // which case HTML must be regenerated first.
    // - local mode: run the generator automatically, then deploy (full loop)
    // - blob mode: Python cannot run on the platform
    //   * dual-write: if the apply also touched HTML outputs, the model
    //     already produced the newest HTML → deploy directly, skip external
    //     regenerate
    //   * otherwise: return regenerateRequired so the external CLI does it
    // - ?force=1: skip the generator check and deploy existing artifacts
    const gen = await prepareForDeploy(plan.project_id, { force: req.query.force === '1', changes });
    const doDeploy = async () => {
      deployResult = await deployToEdgeOne(project);
      let previewUrl = deployResult.url;
      if (deployResult.method === 'local' || deployResult.method === 'cloud_preview' || !previewUrl) {
        const baseUrl = `${req.protocol}://${req.get('host')}`;
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
        log: `${logLine} ${deployResult.log || ''}`
      });
      await update('projects', plan.project_id, {
        current_url: previewUrl,
        version,
        status: 'deployed'
      });
      if (!deployResult.success) {
        deployError = `重新部署失败: ${deployResult.error || 'unknown error'}`;
      }
    };
    if (gen.generator && gen.synced) {
      console.log(`[plans] Dual-write: ${gen.syncedHtmlFiles.length} HTML synced with ${gen.generator.script}, deploying directly (skip external regenerate)`);
      dualWriteSynced = { script: gen.generator.script, htmlFiles: gen.syncedHtmlFiles };
      await doDeploy();
    } else if (gen.generator && gen.needsExternal) {
      regenerateRequired = {
        script: gen.generator.script,
        message: gen.message,
        hint: `node scripts/regenerate.js --project ${plan.project_id} --api ${apiBaseFromReq(req)}`
      };
    } else if (gen.generator && gen.ran && !gen.ok) {
      deployError = `生成器执行失败，未重新部署: ${gen.error}${gen.stderr ? `\n${gen.stderr}` : ''}`;
    } else {
      await doDeploy();
    }
  } catch (err) {
    deployError = `重新部署失败: ${err.message}`;
  }
  return { deployResult, deployError, regenerateRequired, dualWriteSynced };
}

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
    if (hit !== -1) return hit;
    // Generator scripts rank above unrelated pages — agents.md conventions
    // require structural edits to go into the generator (e.g. _gen_pages.py),
    // so it must reliably make it into the model's context.
    return /\.py$/i.test(f.path) ? 500 : 999;
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

  // Path auto-heal: models sometimes copy paths from agents.md that reflect the
  // author's LOCAL machine layout (e.g. "原型设计/phase-2/x.py" while storage has
  // "phase-2/x.py"). If a change's file_path is not a known storage path, try to
  // rewrite it via unique suffix match against the project's real file paths.
  const knownPaths = new Set(fileRecords.map(f => f.path));
  const normalizePath = (p) => {
    if (!p || knownPaths.has(p)) return p;
    const suffixHits = [...knownPaths].filter(k => k.endsWith('/' + p) || p.endsWith('/' + k));
    if (suffixHits.length === 1) return suffixHits[0];
    // also try matching just the last two segments (e.g. "phase-2/_gen_pages.py")
    const segs = String(p).split('/');
    if (segs.length >= 2) {
      const tail = segs.slice(-2).join('/');
      const tailHits = [...knownPaths].filter(k => k === tail || k.endsWith('/' + tail));
      if (tailHits.length === 1) return tailHits[0];
    }
    return p; // leave as-is; apply will surface a clear error
  };

  // ---- Dry-run match precheck ---------------------------------------------
  // Immediately after generation, verify every change against the REAL file
  // content (same rules the apply endpoint enforces):
  //   - target file must exist and not be binary
  //   - old_code must be found EXACTLY ONCE (0 = hallucinated code, >1 = unsafe)
  // This catches bad plans at generation time. If any change fails and the plan
  // came from Makers Models, we regenerate ONCE with the concrete errors fed
  // back into the prompt, keeping whichever attempt has fewer errors.
  const contentMap = new Map(filesWithContent.map(f => [f.path, f.content]));
  const getContent = async (p) => {
    if (contentMap.has(p)) return contentMap.get(p);
    const c = await readFileContent(req.params.id, p);
    contentMap.set(p, c);
    return c;
  };
  const precheckChanges = async (rawChanges) => {
    const results = [];
    for (const change of rawChanges) {
      const v = { status: 'ok', match_count: null, message: '' };
      try {
        const content = await getContent(change.file_path);
        if (!content) {
          v.status = 'error';
          v.message = `文件不存在: ${change.file_path}`;
        } else if (content.binary) {
          v.status = 'error';
          v.message = `目标是二进制文件，无法应用文本修改: ${change.file_path}`;
        } else if (change.old_code && change.new_code) {
          const n = content.data.split(change.old_code).length - 1;
          v.match_count = n;
          if (n === 0) {
            v.status = 'error';
            v.message = 'old_code 未在文件中找到（代码可能为模型凭空构造）';
          } else if (n > 1) {
            v.status = 'error';
            v.message = `old_code 在文件中匹配 ${n} 次，无法安全应用（需扩大上下文至唯一匹配）`;
          }
        } else if (change.new_code) {
          v.status = 'warn';
          v.message = '未提供 old_code，应用时将追加到文件末尾';
        } else {
          v.status = 'error';
          v.message = '无可执行的代码变更';
        }
      } catch (err) {
        v.status = 'warn';
        v.message = `预检失败（应用时仍会校验）: ${err.message}`;
      }
      results.push(v);
    }
    return results;
  };
  const buildFeedback = (rawChanges, validations) => {
    return rawChanges
      .map((c, i) => {
        const v = validations[i];
        if (v.status !== 'error') return '';
        const snippet = (c.old_code || '').slice(0, 200).replace(/\n/g, '\\n');
        return `[${i + 1}] file_path: ${c.file_path}\n    error: ${v.message}${snippet ? `\n    offending old_code (first 200 chars): ${snippet}` : ''}`;
      })
      .filter(Boolean)
      .join('\n');
  };

  const normalizeChanges = (rawChanges) => (rawChanges || []).map(c => {
    const healed = normalizePath(c.file_path);
    if (healed !== c.file_path) {
      console.log(`[plans] Path auto-heal: "${c.file_path}" -> "${healed}"`);
    }
    return { ...c, file_path: healed };
  });

  // Generate plan
  let result = await generatePlanWithMakers(
    project.makers_key,
    annotations,
    filesWithContent,
    project.makers_model || undefined,
    agentsRules
  );

  if (!result.success) {
    return res.status(500).json({ error: result.error || 'Failed to generate plan' });
  }

  let rawChanges = normalizeChanges(result.plan.changes);
  let validations = await precheckChanges(rawChanges);
  let consistency = checkConsistency(annotations, rawChanges);
  let retried = false;

  // Auto-retry once (Makers path only): feed the concrete validation errors
  // AND any unaddressed annotations back to the model so it can fix paths /
  // old_code / missing coverage itself.
  const errCount = vs => vs.filter(v => v.status === 'error').length;
  if (result.method === 'makers'
    && (errCount(validations) > 0 || consistency.uncovered_count > 0)) {
    const feedback = [
      buildFeedback(rawChanges, validations),
      buildConsistencyFeedback(consistency)
    ].filter(Boolean).join('\n');
    console.log(`[plans] Precheck failed (${errCount(validations)} error(s)) / consistency uncovered ${consistency.uncovered_count}, retrying generation with feedback...`);
    try {
      const retry = await generatePlanWithMakers(
        project.makers_key,
        annotations,
        filesWithContent,
        project.makers_model || undefined,
        agentsRules,
        feedback
      );
      if (retry.success) {
        const retryChanges = normalizeChanges(retry.plan.changes);
        const retryValidations = await precheckChanges(retryChanges);
        const retryConsistency = checkConsistency(annotations, retryChanges);
        // Prefer fewer precheck errors first, then fewer uncovered annotations.
        const better = errCount(retryValidations) < errCount(validations)
          || (errCount(retryValidations) === errCount(validations)
            && retryConsistency.uncovered_count < consistency.uncovered_count);
        if (better) {
          console.log(`[plans] Retry improved (errors ${errCount(validations)} -> ${errCount(retryValidations)}, uncovered ${consistency.uncovered_count} -> ${retryConsistency.uncovered_count}), adopting retry result`);
          result = retry;
          rawChanges = retryChanges;
          validations = retryValidations;
          consistency = retryConsistency;
        } else {
          console.log(`[plans] Retry did not improve (still ${errCount(retryValidations)} error(s) / ${retryConsistency.uncovered_count} uncovered), keeping first attempt`);
        }
      }
    } catch (retryErr) {
      console.warn(`[plans] Retry generation failed: ${retryErr.message}`);
    }
    retried = true;
  }

  const errorCount = validations.filter(v => v.status === 'error').length;
  const warnCount = validations.filter(v => v.status === 'warn').length;
  const precheck = {
    checked: validations.length,
    passed: errorCount === 0,
    error_count: errorCount,
    warn_count: warnCount,
    retried
  };
  // ---- Plan scorecard -------------------------------------------------------
  // Composite quality score (0-100) computed from data we already have:
  //   path compliance (paths point at real files)          weight 20
  //   match quality (dry-run old_code unique match)        weight 30
  //   annotation consistency (covered/weak/uncovered)      weight 25
  //   description completeness (>=10 chars, actionable)    weight 10
  //   change clarity (old_code+new_code, not blind append) weight 15
  // Purely local — no extra API calls. Plans scoring below 70 (or containing
  // any precheck error) are flagged needs_review so the reviewer knows where
  // to spend attention first.
  const computeScorecard = (rawChanges, validations, consistencyData, paths) => {
    const n = rawChanges.length || 1;
    const ratio = (num) => Math.round((num / n) * 100) / 100;
    const pathScore = ratio(rawChanges.filter(c => paths.has(c.file_path)).length);
    const matchScore = ratio(validations.reduce(
      (s, v) => s + (v.status === 'ok' ? 1 : v.status === 'warn' ? 0.5 : 0), 0
    ));
    const consN = consistencyData.checked || 1;
    const consScore = Math.round((
      ((consistencyData.covered_count || 0) + 0.5 * (consistencyData.weak_count || 0)) / consN
    ) * 100) / 100;
    const descScore = ratio(rawChanges.filter(c => (c.description || '').trim().length >= 10).length);
    const clarityScore = ratio(rawChanges.filter(c => c.old_code && c.new_code).length);

    const dims = [
      { key: 'path', label: '路径合规', score: pathScore, weight: 20, detail: `${Math.round(pathScore * rawChanges.length)}/${rawChanges.length} 条修改指向真实文件` },
      { key: 'match', label: '匹配质量', score: matchScore, weight: 30, detail: `${validations.filter(v => v.status === 'ok').length} 唯一匹配 / ${validations.filter(v => v.status === 'warn').length} 警告 / ${validations.filter(v => v.status === 'error').length} 未通过` },
      { key: 'consistency', label: '批注一致性', score: consScore, weight: 25, detail: `已回应 ${consistencyData.covered_count || 0} / 较弱 ${consistencyData.weak_count || 0} / 未回应 ${consistencyData.uncovered_count || 0}` },
      { key: 'description', label: '描述完整性', score: descScore, weight: 10, detail: `${Math.round(descScore * rawChanges.length)}/${rawChanges.length} 条描述清晰（≥10字）` },
      { key: 'clarity', label: '变更明确性', score: clarityScore, weight: 15, detail: `${Math.round(clarityScore * rawChanges.length)}/${rawChanges.length} 条为精确替换（非追加）` }
    ];
    const score = Math.round(dims.reduce((s, d) => s + d.score * d.weight, 0));
    const hasError = validations.some(v => v.status === 'error');
    const grade = score >= 85 ? 'good' : score >= 70 ? 'fair' : 'poor';
    return {
      score,
      grade,
      needs_review: score < 70 || hasError,
      dimensions: dims
    };
  };
  const scorecard = computeScorecard(rawChanges, validations, consistency, knownPaths);
  console.log(`[plans] Scorecard: ${scorecard.score}/100 (${scorecard.grade}${scorecard.needs_review ? ', NEEDS REVIEW' : ''})`);

  console.log(`[plans] Dry-run precheck: ${precheck.passed ? 'PASSED' : 'FAILED'} (${errorCount} error, ${warnCount} warn, retried=${retried})`);
  console.log(`[plans] Consistency check: ${consistency.covered_count} covered / ${consistency.weak_count} weak / ${consistency.uncovered_count} uncovered`);

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
    fallback_reason: result.fallbackReason || '',
    precheck,
    consistency,
    scorecard
  });

  // Create plan change records (with per-change dry-run validation attached).
  const changes = [];
  for (let i = 0; i < rawChanges.length; i++) {
    const change = rawChanges[i];
    changes.push(await insert('planChanges', {
      plan_id: plan.id,
      project_id: req.params.id,
      annotation_id: change.annotation_id || null,
      file_path: change.file_path,
      description: change.description || '',
      old_code: change.old_code || '',
      new_code: change.new_code || '',
      status: 'pending',
      validation: validations[i] || null
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

  // Attach changes (and whether a rollback snapshot is still available) for each plan
  const plansWithChanges = [];
  for (const plan of plans) {
    const changes = await query('planChanges', c => String(c.plan_id) === String(plan.id));
    const activeSnaps = await query('snapshots', s =>
      String(s.plan_id) === String(plan.id) && s.status === 'active'
    );
    plansWithChanges.push({ ...plan, changes, rollback_available: activeSnaps.length > 0 });
  }

  res.json(plansWithChanges);
});

// Get a single plan with changes
router.get('/plans/:planId', async (req, res) => {
  const plan = await getById('plans', req.params.planId);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });

  const changes = await query('planChanges', c => String(c.plan_id) === String(plan.id));
  const activeSnaps = await query('snapshots', s =>
    String(s.plan_id) === String(req.params.planId) && s.status === 'active'
  );
  res.json({ ...plan, changes, rollback_available: activeSnaps.length > 0 });
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

  // Regression snapshot: capture the CURRENT content of every file this apply
  // will touch BEFORE any write, so the owner can roll the whole apply back
  // with one click if files end up half-applied or the visual result is wrong.
  // Best-effort per file; binary files are skipped (apply rejects them anyway).
  const targetPaths = [...new Set(changes.map(c => c.file_path))];
  const snapshotFiles = [];
  for (const p of targetPaths) {
    try {
      const c = await readFileContent(plan.project_id, p);
      if (c && !c.binary) snapshotFiles.push({ path: p, content: c.data });
    } catch (err) {
      console.warn(`[plans] Snapshot skipped for ${p}: ${err.message}`);
    }
  }
  const snapshot = snapshotFiles.length > 0
    ? await insert('snapshots', {
        plan_id: req.params.planId,
        project_id: plan.project_id,
        status: 'active',
        files: snapshotFiles
      })
    : null;
  if (snapshot) console.log(`[plans] Snapshot #${snapshot.id} created for plan #${plan.id} (${snapshotFiles.length} files)`);

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
  let dualWriteSynced = null;
  if (appliedChanges.length > 0) {
    ({ deployResult, deployError, regenerateRequired, dualWriteSynced } = await triggerRedeploy(
      plan, req, `Applied plan #${plan.id}: ${appliedChanges.length} changes.`, changes
    ));
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
    dualWriteSynced: dualWriteSynced || undefined,
    deployResult: deployResult ? { method: deployResult.method, url: deployResult.url } : null,
    snapshot_id: snapshot ? snapshot.id : undefined
  };

  if (!allChangesApplied) {
    return res.status(409).json({
      ...body,
      error: errors[0] || '应用修改失败',
      rollback_hint: snapshot
        ? `已创建快照 #${snapshot.id}，可通过 /api/plans/${req.params.planId}/rollback 一键回滚到应用前状态`
        : undefined
    });
  }
  res.json(body);
});

// Roll back to the pre-apply snapshot — owner operation. Restores every file
// captured in the plan's latest ACTIVE snapshot, flips applied changes back to
// 'approved' (so they can be fixed and re-applied), reopens annotations that
// were resolved by the apply, marks the snapshot consumed, and redeploys.
router.post('/plans/:planId/rollback', requireOwnerAuth, async (req, res) => {
  const plan = await getById('plans', req.params.planId);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });

  const snaps = await query('snapshots', s =>
    String(s.plan_id) === String(req.params.planId) && s.status === 'active'
  );
  if (snaps.length === 0) {
    return res.status(400).json({ error: '该方案没有可用的回滚快照' });
  }
  snaps.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const snapshot = snaps[0];

  // Restore file contents first — this is the core of the rollback.
  const errors = [];
  let restored = 0;
  for (const f of (snapshot.files || [])) {
    try {
      const wrote = await writeFileContent(plan.project_id, f.path, f.content);
      if (!wrote) errors.push(`写入文件失败: ${f.path}（存储驱动未确认写入）`);
      else restored++;
    } catch (err) {
      errors.push(`恢复 ${f.path} 时出错: ${err.message}`);
    }
  }
  if (restored === 0) {
    return res.status(500).json({ error: errors.join('; ') || '回滚失败：未恢复任何文件' });
  }

  // Reset state so the plan is re-workable: applied changes -> approved,
  // annotations the apply resolved -> open again, plan -> approved.
  const changed = await query('planChanges', c =>
    String(c.plan_id) === String(req.params.planId) && c.status === 'applied'
  );
  for (const c of changed) {
    await update('planChanges', c.id, { status: 'approved' });
    if (c.annotation_id) {
      await update('annotations', c.annotation_id, { status: 'open' });
    }
  }
  await update('plans', req.params.planId, { status: 'approved' });
  await update('snapshots', snapshot.id, {
    status: 'rolled_back',
    rolled_back_at: new Date().toISOString()
  });
  console.log(`[plans] Rolled back plan #${plan.id} to snapshot #${snapshot.id} (${restored}/${snapshot.files.length} files, ${changed.length} changes reset)`);

  // Redeploy the restored content (same semantics as apply, incl. generator
  // handling and ?force=1). Rollback passes no changes → no dual-write path.
  const { deployResult, deployError, regenerateRequired } = await triggerRedeploy(
    plan, req, `Rolled back plan #${plan.id} to snapshot #${snapshot.id}.`
  );

  res.json({
    success: errors.length === 0 && !deployError && !regenerateRequired,
    restoredCount: restored,
    changesReset: changed.length,
    errors,
    deployError: deployError || undefined,
    deploySkipped: !!regenerateRequired,
    regenerateRequired: regenerateRequired || undefined,
    deployResult: deployResult ? { method: deployResult.method, url: deployResult.url } : null
  });
});

export default router;
