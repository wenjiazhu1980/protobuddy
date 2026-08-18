/**
 * EdgeOne Makers (Pages) Open API client.
 *
 * Deploys prototypes from inside the Makers Cloud Function (read-only FS, no
 * npx) by calling the same REST API the `edgeone` CLI uses:
 *   POST https://pages-api.cloud.tencent.com/v1
 *   Authorization: Bearer <api token>
 *   Body: { Action: "<Action>", ...params }
 *
 * Flow (mirrors the CLI):
 *   1. DescribePagesProjects (by Name) / CreatePagesProject
 *   2. DescribePagesCosTempToken -> COS temp credentials + TargetPath
 *   3. PUT each file to {Bucket}.cos.accelerate.myqcloud.com/{TargetPath}/{rel}
 *      (COS XML API, manual signature - no SDK)
 *   4. CreatePagesDeployment (DistType=Folder)
 *   5. Poll DescribePagesDeployments until terminal status
 *   6. DescribePagesProjects -> PresetDomain; DescribePagesEncipherToken
 *      -> eo_token for the final access URL (non-TLD domains).
 */

import crypto from 'crypto';

const API_BASES = ['https://pages-api.cloud.tencent.com/v1', 'https://pages-api.edgeone.ai/v1'];
const POLL_INTERVAL_MS = 5000;

let resolvedBase = null;

/** POST one action to the Pages API. Returns parsed JSON (Code === 0 on success). */
export async function callApi(token, action, data = {}) {
  const bases = resolvedBase ? [resolvedBase] : API_BASES;
  let lastErr = null;
  for (const base of bases) {
    try {
      const res = await fetch(base, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ Action: action, ...data })
      });
      if (!res.ok) throw new Error(`API request failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
      const json = await res.json();
      if (json.Code !== 0) {
        const respErr = json.Data?.Response?.Error;
        throw new Error(respErr?.Message ? `${respErr.Code}: ${respErr.Message}` : `API error: ${json.Message || json.Code}`);
      }
      resolvedBase = base;
      return json;
    } catch (err) {
      // Auth errors are fatal; network errors may be base-region related -> try next base
      if (/Bearer|token|auth/i.test(err.message) && bases.length === 1) throw err;
      lastErr = err;
    }
  }
  throw lastErr || new Error('Pages API unreachable');
}

/** Find a project by name, or create it. Returns { projectId, name }. */
export async function getOrCreateProject(token, name) {
  const desc = await callApi(token, 'DescribePagesProjects', {
    Filters: [{ Name: 'Name', Values: [name] }],
    Offset: 0,
    Limit: 10,
    OrderBy: 'CreatedOn'
  });
  let projects = desc.Data?.Response?.Projects || [];
  if (projects.length === 0) {
    await callApi(token, 'CreatePagesProject', {
      Name: name,
      Provider: 'Upload',
      Channel: 'Custom',
      Area: 'global',
      Source: 'protobuddy'
    });
    await new Promise(r => setTimeout(r, 2000));
    const desc2 = await callApi(token, 'DescribePagesProjects', {
      Filters: [{ Name: 'Name', Values: [name] }],
      Offset: 0,
      Limit: 10,
      OrderBy: 'CreatedOn'
    });
    projects = desc2.Data?.Response?.Projects || [];
    if (projects.length === 0) throw new Error(`Failed to create project ${name}`);
  }
  const proj = projects[0];
  if (proj.Provider && proj.Provider !== 'Upload') {
    throw new Error(`Project ${name} exists but Provider is '${proj.Provider}' (only Upload projects are supported)`);
  }
  return { projectId: proj.ProjectId, name: proj.Name };
}

// ---------------------------------------------------------------------------
// COS XML API signature (sha1/hmac-sha1, no SDK)
// ---------------------------------------------------------------------------

function sha1hex(s) { return crypto.createHash('sha1').update(s).digest('hex'); }
function hmacSha1hex(key, s) { return crypto.createHmac('sha1', key).update(s).digest('hex'); }
function camSafeUrlEncode(str) {
  return encodeURIComponent(String(str))
    .replace(/!/g, '%21').replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\*/g, '%2A');
}

/**
 * Build the COS XML API Authorization string (sha1/hmac-sha1).
 * Signs the host + x-cos-security-token headers, as the official SDK does
 * for temporary credentials. `headers` values must be strings.
 */
function cosAuthorization({ method, pathname, host, sessionToken, secretId, secretKey }) {
  const now = Math.floor(Date.now() / 1000);
  const keyTime = `${now};${now + 600}`;
  const signKey = hmacSha1hex(secretKey, keyTime);

  const headers = { host };
  if (sessionToken) headers['x-cos-security-token'] = sessionToken;

  const headerKeys = Object.keys(headers).sort();
  const headerList = headerKeys.join(';');
  // COS expects `k1=v1&k2=v2` with NO trailing separator
  const headerStr = headerKeys.map(k => `${k}=${headers[k]}`).join('&');

  // Slashes in the pathname must stay unencoded (camSafeUrlEncode(key, '/'))
  const httpString = `${method.toLowerCase()}\n${pathname}\n\n${headerStr}\n`;
  const stringToSign = `sha1\n${keyTime}\n${sha1hex(httpString)}\n`;
  const signature = hmacSha1hex(signKey, stringToSign);

  return (
    `q-sign-algorithm=sha1&q-ak=${secretId}` +
    `&q-sign-time=${keyTime}&q-key-time=${keyTime}` +
    `&q-header-list=${headerList}&q-url-param-list=&q-signature=${signature}`
  );
}

const CONTENT_TYPES = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8', js: 'application/javascript; charset=utf-8',
  mjs: 'application/javascript; charset=utf-8', json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8',
  xml: 'application/xml', mp4: 'video/mp4', mp3: 'audio/mpeg', pdf: 'application/pdf'
};

/** PUT one object into the temp COS bucket. `body` is Uint8Array. */
async function cosPut(bucket, key, body, contentType, creds) {
  const host = `${bucket}.cos.accelerate.myqcloud.com`;
  // Signature uses the DECODED path (Chinese filenames sign as raw UTF-8),
  // while the request URL uses the percent-encoded path.
  const rawPath = '/' + key;
  const encPath = '/' + key.split('/').map(camSafeUrlEncode).join('/');
  const authorization = cosAuthorization({
    method: 'PUT',
    pathname: rawPath,
    host,
    sessionToken: creds.Token,
    secretId: creds.TmpSecretId,
    secretKey: creds.TmpSecretKey
  });
  const headers = {
    Authorization: authorization,
    'Content-Type': contentType,
    'Content-Length': String(body.byteLength)
  };
  if (creds.Token) headers['x-cos-security-token'] = creds.Token;
  const res = await fetch(`https://${host}${encPath}`, { method: 'PUT', headers, body });
  if (!(res.status >= 200 && res.status < 300)) {
    throw new Error(`COS PUT ${key} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
}

/**
 * Upload files and create a deployment.
 * @param {object} opts
 * @param {string} opts.token Makers API token
 * @param {string} opts.projectName target Makers project name
 * @param {Array<{path:string, body:Uint8Array}>} opts.files relative paths -> content
 * @returns {Promise<{projectId:string, deploymentId:string}>}
 */
export async function uploadAndDeploy({ token, projectName, files }) {
  if (!files || files.length === 0) throw new Error('No files to deploy');

  const { projectId } = await getOrCreateProject(token, projectName);

  const tokRes = await callApi(token, 'DescribePagesCosTempToken', { ProjectId: projectId });
  const cos = tokRes.Data?.Response || {};
  const { Bucket, Region, TargetPath, Credentials } = cos;
  if (!Bucket || !Region || !TargetPath || !Credentials) {
    throw new Error('COS temp token response missing Bucket/Region/TargetPath/Credentials');
  }

  // Sequential upload with limited concurrency (prototypes are small)
  const CONCURRENCY = 5;
  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const batch = files.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(f => {
      const ext = (f.path.split('.').pop() || '').toLowerCase();
      return cosPut(Bucket, `${TargetPath}/${f.path}`, f.body, CONTENT_TYPES[ext] || 'application/octet-stream', Credentials);
    }));
  }

  const depRes = await callApi(token, 'CreatePagesDeployment', {
    ProjectId: projectId,
    ViaMeta: 'Upload',
    Provider: 'Upload',
    Env: 'Production',
    DistType: 'Folder',
    TempBucketPath: TargetPath,
    BuildFrom: 'CLI'
  });
  const deploymentId = depRes.Data?.Response?.DeploymentId;
  if (!deploymentId) throw new Error('CreatePagesDeployment returned no DeploymentId');
  return { projectId, deploymentId };
}

/**
 * Poll a deployment until terminal status or budget exhausted.
 * @returns {Promise<{done:boolean, status:string}>}
 */
export async function pollDeployment({ token, projectId, deploymentId, budgetMs = 50000 }) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    try {
      const res = await callApi(token, 'DescribePagesDeployments', {
        ProjectId: projectId, Offset: 0, Limit: 50, OrderBy: 'CreatedOn', Order: 'Desc'
      });
      const dep = (res.Data?.Response?.Deployments || []).find(d => d.DeploymentId === deploymentId);
      if (dep && !['Process', 'Pending'].includes(dep.Status)) {
        return { done: true, status: dep.Status };
      }
    } catch { /* transient - keep polling */ }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  return { done: false, status: 'deploying' };
}

/** Single status check (for the frontend polling endpoint). */
export async function checkDeployment({ token, projectId, deploymentId }) {
  const res = await callApi(token, 'DescribePagesDeployments', {
    ProjectId: projectId, Offset: 0, Limit: 50, OrderBy: 'CreatedOn', Order: 'Desc'
  });
  const dep = (res.Data?.Response?.Deployments || []).find(d => d.DeploymentId === deploymentId);
  if (!dep) return { done: false, status: 'deploying' };
  if (['Process', 'Pending'].includes(dep.Status)) return { done: false, status: 'deploying' };
  return { done: true, status: dep.Status };
}

/**
 * Resolve the public URL of a finished deployment (mirrors the CLI):
 * preferred custom domain > any custom domain (Pass) > preset domain (IsTld=1, no token) > preset domain + eo_token.
 *
 * @param {string} token Makers API token
 * @param {string} projectId EdgeOne Pages project ID
 * @param {object} [opts]
 * @param {string} [opts.preferredDomain] - User-configured custom domain to prioritise
 * @returns {Promise<{url:string, customDomainBound?:boolean, customDomainStatus?:string}>}
 */
export async function getProjectUrl(token, projectId, opts = {}) {
  const res = await callApi(token, 'DescribePagesProjects', {
    Filters: [{ Name: 'ProjectId', Values: [projectId] }], Offset: 0, Limit: 10, OrderBy: 'CreatedOn'
  });
  const proj = (res.Data?.Response?.Projects || [])[0];
  if (!proj) throw new Error('Failed to describe project after deploy');

  const allCustom = proj.CustomDomains || [];

  // 1. If user configured a preferred domain, try to match it first
  if (opts.preferredDomain) {
    const norm = opts.preferredDomain.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
    const matched = allCustom.find(d =>
      (d.Domain || '').toLowerCase() === norm && d.Status === 'Pass'
    );
    if (matched) return { url: `https://${matched.Domain}`, customDomainBound: true };

    // Domain configured but not yet Pass — report status so frontend can show guidance
    const pending = allCustom.find(d => (d.Domain || '').toLowerCase() === norm);
    if (pending) {
      // Fall through to other domains / preset, but include status info
      const fallback = await resolvePresetOrAnyCustom(token, proj, allCustom);
      return { ...fallback, customDomainBound: false, customDomainStatus: pending.Status };
    }
    // Domain not found in EdgeOne at all — user hasn't bound it yet
    const fallback = await resolvePresetOrAnyCustom(token, proj, allCustom);
    return { ...fallback, customDomainBound: false, customDomainStatus: 'not_bound' };
  }

  // 2. No preferred domain — use any Pass custom domain, then preset
  const fallback = await resolvePresetOrAnyCustom(token, proj, allCustom);
  return fallback;
}

/** Resolve URL from any Pass custom domain or preset domain (extracted helper). */
async function resolvePresetOrAnyCustom(token, proj, allCustom) {
  const anyPass = allCustom.find(d => d.Status === 'Pass');
  if (anyPass) return { url: `https://${anyPass.Domain}` };

  const domain = proj.PresetDomain;
  if (!domain) throw new Error('Project has no PresetDomain');

  if (proj.IsTld === 1) return { url: `https://${domain}` };

  const enc = await callApi(token, 'DescribePagesEncipherToken', { Text: domain });
  const { Token, Timestamp } = enc.Data?.Response || {};
  if (!Token || !Timestamp) throw new Error('DescribePagesEncipherToken returned no token');
  return { url: `https://${domain}?eo_token=${Token}&eo_time=${Timestamp}` };
}
