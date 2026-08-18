import { Router } from 'express';
import { getById, insert, update, query } from '../db.js';
import { deployToEdgeOne } from '../services/edgeone.js';
import { checkDeployment, getProjectUrl } from '../services/makersApi.js';
import { requireOwnerAuth } from '../services/ownerAuth.js';

const router = Router();

// Deploy a project — owner operation
router.post('/:id/deploy', requireOwnerAuth, async (req, res) => {
  const project = await getById('projects', req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  try {
    const result = await deployToEdgeOne(project);

    const version = (project.version || 0) + 1;
    let previewUrl = result.url;
    let method = result.method;
    let fallbackUrl = '';

    // If EdgeOne failed but CLI may have succeeded, keep local fallback available
    if (result.method === 'edgeone_failed') {
      fallbackUrl = `/api/projects/${req.params.id}/preview/`;
      previewUrl = fallbackUrl;
      method = 'local_fallback';
    }

    // If local hosting, cloud_preview or no URL returned, construct URL from request
    // (in Makers Cloud Functions mode the preview is served by this same function).
    // Use a RELATIVE path so the browser always resolves it against the current origin.
    // Serverless runtimes often report internal/loopback hostnames in req.get('host'),
    // which produced broken preview URLs like CloudStudio domains.
    if (result.method === 'local' || result.method === 'cloud_preview' || (!previewUrl && method !== 'edgeone_deploying')) {
      previewUrl = `/api/projects/${req.params.id}/preview/${version ? `?v=${version}` : ''}`;
      result.url = previewUrl;
    }

    // Record deployment
    const deployment = await insert('deployments', {
      project_id: req.params.id,
      version,
      url: previewUrl,
      env: 'production',
      status: method === 'edgeone_deploying' ? 'deploying'
        : result.success || method === 'local_fallback' ? 'success' : 'failed',
      method,
      log: result.log || result.error || '',
      makers_project_id: result.projectId || '',
      makers_deployment_id: result.deploymentId || ''
    });

    // Update project
    await update('projects', req.params.id, {
      current_url: method === 'edgeone_deploying' ? (project.current_url || '') : previewUrl,
      deploy_method: method,
      status: method === 'edgeone_deploying' ? 'deploying'
        : result.success || method === 'local_fallback' ? 'deployed' : 'deploy_failed',
      version
    });

    res.json({
      success: result.success || method === 'local_fallback',
      url: previewUrl,
      method,
      status: method === 'edgeone_deploying' ? 'deploying' : undefined,
      edgeone_url: result.method === 'edgeone' ? result.url : '',
      fallback_url: fallbackUrl,
      version,
      deployment_id: deployment.id,
      error: result.error,
      log_file: result.logFile
    });
  } catch (err) {
    console.error('[deploy] Error:', err);
    res.status(500).json({ error: `Deployment failed: ${err.message}` });
  }
});

// Poll the status of an in-flight EdgeOne deployment (frontend keeps asking
// until it leaves Process/Pending, then the URL is resolved and persisted).
router.get('/:id/deploy-status', async (req, res) => {
  const project = await getById('projects', req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const depId = req.query.dep;
  const deployment = depId
    ? (await getById('deployments', depId))
    : (await query('deployments', d => String(d.project_id) === String(req.params.id))).sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
  if (!deployment) return res.status(404).json({ error: 'Deployment not found' });

  if (deployment.status !== 'deploying') {
    return res.json({ status: deployment.status, url: deployment.url, method: deployment.method, deployment_id: deployment.id });
  }

  const token = project.edgeone_token;
  const makersProjectId = deployment.makers_project_id;
  const makersDeploymentId = deployment.makers_deployment_id;
  if (!token || !makersProjectId || !makersDeploymentId) {
    return res.json({ status: deployment.status, url: deployment.url, method: deployment.method, deployment_id: deployment.id });
  }

  try {
    const check = await checkDeployment({ token, projectId: makersProjectId, deploymentId: makersDeploymentId });
    if (!check.done) {
      return res.json({ status: 'deploying', method: deployment.method, deployment_id: deployment.id });
    }
    if (check.status !== 'Success') {
      await update('deployments', deployment.id, { status: 'failed', log: `EdgeOne deployment ended with status: ${check.status}` });
      await update('projects', req.params.id, { status: 'deploy_failed' });
      return res.json({ status: 'failed', error: `EdgeOne 部署状态: ${check.status}`, method: deployment.method, deployment_id: deployment.id });
    }
    const url = await getProjectUrl(token, makersProjectId);
    await update('deployments', deployment.id, { status: 'success', url, log: `EdgeOne deploy success: ${url}` });
    await update('projects', req.params.id, { current_url: url, deploy_method: 'edgeone', status: 'deployed' });
    return res.json({ status: 'success', url, method: 'edgeone', deployment_id: deployment.id });
  } catch (err) {
    return res.json({ status: 'deploying', method: deployment.method, deployment_id: deployment.id, error: err.message });
  }
});

// Manually set/update project preview URL — owner operation
router.post('/:id/preview-url', requireOwnerAuth, async (req, res) => {
  const project = await getById('projects', req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { url } = req.body || {};
  if (!url || !url.startsWith('http')) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  await update('projects', req.params.id, {
    current_url: url,
    deploy_method: 'edgeone_manual',
    status: 'deployed'
  });

  const deployment = await insert('deployments', {
    project_id: req.params.id,
    version: project.version || 1,
    url,
    env: 'production',
    status: 'success',
    method: 'edgeone_manual',
    log: 'Manually set EdgeOne preview URL.'
  });

  res.json({ success: true, url, deployment_id: deployment.id });
});

// List deployments for a project
router.get('/:id/deployments', async (req, res) => {
  const deployments = await query('deployments', d => String(d.project_id) === String(req.params.id));
  deployments.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json(deployments);
});

// Get deployment status
router.get('/:id/deployments/:depId', async (req, res) => {
  const dep = await getById('deployments', req.params.depId);
  if (!dep || String(dep.project_id) !== String(req.params.id)) {
    return res.status(404).json({ error: 'Deployment not found' });
  }
  res.json(dep);
});

export default router;
