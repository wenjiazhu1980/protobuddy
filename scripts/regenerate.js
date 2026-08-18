#!/usr/bin/env node
/**
 * ProtoBuddy 生成器「外部执行环境」CLI（方案 A）。
 *
 * 背景：项目部署在 EdgeOne Makers（blob 存储 + Cloud Functions）时，函数文件
 * 系统只读、无法执行 Python。若原型含 Python 生成器脚本（如 phase-2/_gen_pages.py，
 * 按 AGENTS.md 约定所有改动写入脚本并重新生成 HTML），线上只能存储脚本、无法
 * 重新生成产物 —— 直接部署出去的就是旧 HTML。
 *
 * 本 CLI 在本机充当外部执行环境，打通完整闭环：
 *
 *   1. owner 密码验证（或复用已签发的 token）→ X-Owner-Token
 *   2. 从线上 API 拉取项目全部文件 → 还原到本地临时目录
 *   3. 本地执行 python3 <生成器脚本> → 重新生成 HTML 等产物
 *   4. diff 产物变化（执行前后内容快照对比）
 *   5. 将变化文件回写线上存储（POST/DELETE /api/projects/:id/files）
 *   6. 触发线上重新部署（POST /api/projects/:id/deploy）
 *
 * 用法：
 *   node scripts/regenerate.js --project 1 --api https://protobuddy-app.edgeone.cool --password <owner密码>
 *   node scripts/regenerate.js --project 1 --api <base> --token <ownerToken>          # 复用已有 token
 *   node scripts/regenerate.js --project 1 --api <base> --password <pw> --skip-deploy # 只生成+回写，不部署
 *   node scripts/regenerate.js --project 1 --api <base> --password <pw> --force       # 跳过生成器检查强制部署
 *   node scripts/regenerate.js --project 1 --api <base> --password <pw> --keep        # 保留本地工作目录
 *
 * 环境变量替代参数：PB_API / PB_PROJECT / PB_OWNER_PASSWORD / PB_OWNER_TOKEN
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { isGeneratorFile, snapshotProject, diffSnapshots } from '../backend/src/services/generator.js';

const execAsync = promisify(exec);
const GENERATOR_TIMEOUT_MS = 120000;

const BINARY_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.svg', '.woff', '.woff2', '.ttf', '.eot', '.otf', '.mp4', '.mp3', '.pdf', '.zip', '.rar'];
function isBinaryPath(p) {
  return BINARY_EXTS.includes(path.extname(String(p)).toLowerCase());
}
function skipDir(name) {
  return ['node_modules', '.git', '.edgeone', 'dist'].includes(name);
}

/* --------------------------------- 参数解析 --------------------------------- */

function printHelp() {
  console.log(`
ProtoBuddy 生成器外部执行环境 CLI

用法:
  node scripts/regenerate.js --project <id> --api <baseURL> --password <pw> [options]
  node scripts/regenerate.js --project <id> --api <baseURL> --token <ownerToken> [options]

必填:
  --project <id>      项目 id（如 1）
  --api <baseURL>     线上 API 根地址（如 https://protobuddy-app.edgeone.cool）
  --password <pw>     owner 操作密码（与 --token 二选一；验证后签发 8h 有效 token）
  --token <token>     已签发的 owner token（与 --password 二选一）

可选:
  --skip-deploy       只拉取→生成→回写，不触发重新部署
  --force             部署时跳过生成器检查（确认产物已最新时使用）
  --workdir <dir>     本地工作目录（默认系统临时目录）
  --keep              结束后保留工作目录（默认清理）
  --verbose           打印执行细节
  --help              显示本帮助
`);
}

function parseArgs(argv) {
  const opts = {
    api: process.env.PB_API || 'http://localhost:3001',
    project: process.env.PB_PROJECT || '',
    password: process.env.PB_OWNER_PASSWORD || '',
    token: process.env.PB_OWNER_TOKEN || '',
    workdir: '',
    keep: false,
    skipDeploy: false,
    force: false,
    verbose: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--project': opts.project = next(); break;
      case '--api': opts.api = next().replace(/\/+$/, ''); break;
      case '--password': opts.password = next(); break;
      case '--token': opts.token = next(); break;
      case '--workdir': opts.workdir = next(); break;
      case '--keep': opts.keep = true; break;
      case '--skip-deploy': opts.skipDeploy = true; break;
      case '--force': opts.force = true; break;
      case '--verbose': opts.verbose = true; break;
      case '--help': case '-h': printHelp(); process.exit(0); break;
      default:
        console.error(`[regenerate] 未知参数: ${a}（--help 查看用法）`);
        process.exit(2);
    }
  }
  return opts;
}

/* --------------------------------- HTTP 工具 --------------------------------- */

async function apiFetch(url, options = {}, timeoutMs = 90000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON body */ }
    return { status: res.status, json, text };
  } catch (err) {
    throw new Error(`请求失败 ${url}: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

function encodePath(p) {
  return String(p).split('/').map(encodeURIComponent).join('/');
}

/* --------------------------------- 各阶段 --------------------------------- */

async function getOwnerToken(api, projectId, password, existingToken) {
  if (existingToken) return existingToken;
  if (!password) {
    throw new Error('需要 --password 或 --token（owner 操作密码 / 已签发的 owner token）');
  }
  const { status, json } = await apiFetch(`${api}/api/projects/${projectId}/owner-auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password })
  });
  if (status !== 200 || !json?.ok) {
    throw new Error(`owner 验证失败 (${status}): ${json?.message || JSON.stringify(json).slice(0, 300)}`);
  }
  console.log(`[regenerate] owner 验证通过，token 有效期 ${Math.round(json.expiresIn / 3600000)}h`);
  return json.token;
}

async function fetchFileList(api, projectId) {
  // 优先从存储驱动读取权威文件列表（files 表可能不完整）；
  // 失败则退回 files 表（兼容旧版本后端）。
  const stored = await apiFetch(`${api}/api/projects/${projectId}/storage-files`);
  if (stored.status === 200 && Array.isArray(stored.json?.paths)) {
    return stored.json.paths.map(p => ({ path: p }));
  }
  const legacy = await apiFetch(`${api}/api/projects/${projectId}/files`);
  if (legacy.status === 200 && Array.isArray(legacy.json)) return legacy.json;
  throw new Error(
    `拉取文件列表失败（storage-files HTTP ${stored.status} / files HTTP ${legacy.status}）: ` +
    `${(stored.json?.error || legacy.json?.error || '').slice(0, 300)}`
  );
}

async function restoreProject(workdir, api, projectId, files) {
  let count = 0;
  let skipped = 0;
  for (const f of files) {
    const rel = f?.path;
    if (!rel) continue;
    const { status, json } = await apiFetch(`${api}/api/projects/${projectId}/files/${encodePath(rel)}`);
    if (status !== 200 || !json) { skipped++; continue; }
    const full = path.join(workdir, rel);
    if (!full.startsWith(workdir + path.sep)) continue; // 防路径穿越
    fs.mkdirSync(path.dirname(full), { recursive: true });
    if (json.binary) fs.writeFileSync(full, Buffer.from(json.data, 'base64'));
    else fs.writeFileSync(full, json.data, 'utf-8');
    count++;
  }
  if (skipped > 0) console.warn(`[regenerate] ${skipped} 个文件拉取失败，已跳过`);
  return count;
}

function findGenerator(workdir) {
  const hits = [];
  (function walk(dir, relBase = '') {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (skipDir(entry.name)) continue;
        walk(path.join(dir, entry.name), relBase ? `${relBase}/${entry.name}` : entry.name);
      } else {
        const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
        if (isGeneratorFile(rel)) hits.push(rel);
      }
    }
  })(workdir);
  hits.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  return hits[0] || null;
}

async function runGenerator(workdir, script) {
  const scriptPath = path.join(workdir, script);
  const scriptDir = path.dirname(scriptPath);
  if (!fs.existsSync(scriptPath)) throw new Error(`生成器脚本不存在: ${script}`);
  console.log(`[regenerate] 执行: python3 ${script} (cwd=${path.relative(workdir, scriptDir) || '.'})`);

  const python = process.env.GENERATOR_PYTHON || 'python3';
  const { stdout, stderr } = await execAsync(`"${python}" "${scriptPath}"`, {
    cwd: scriptDir,
    timeout: GENERATOR_TIMEOUT_MS,
    maxBuffer: 1024 * 1024 * 10,
    env: { ...process.env, PYTHONUNBUFFERED: '1' }
  });
  if (stdout.trim()) console.log(`[regenerate] 生成器输出: ${stdout.trim().slice(0, 1000)}`);
  if (stderr.trim()) console.warn(`[regenerate] 生成器 stderr: ${stderr.trim().slice(0, 1000)}`);
}

async function writeBack(api, projectId, token, workdir, changes) {
  const results = [];
  for (const c of changes) {
    if (c.action === 'removed') {
      const { status } = await apiFetch(`${api}/api/projects/${projectId}/files/${encodePath(c.path)}`, {
        method: 'DELETE',
        headers: { 'X-Owner-Token': token }
      });
      results.push({ path: c.path, action: c.action, status });
      continue;
    }
    const full = path.join(workdir, c.path);
    if (!fs.existsSync(full)) { results.push({ path: c.path, action: c.action, status: 0, error: '本地文件缺失' }); continue; }
    const content = isBinaryPath(c.path) ? fs.readFileSync(full).toString('base64') : fs.readFileSync(full, 'utf-8');
    const { status, json } = await apiFetch(`${api}/api/projects/${projectId}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Owner-Token': token },
      body: JSON.stringify({ path: c.path, content })
    });
    results.push({ path: c.path, action: c.action, status, error: status === 200 ? undefined : (json?.error || '') });
  }
  return results;
}

async function deploy(api, projectId, token, force) {
  const url = `${api}/api/projects/${projectId}/deploy${force ? '?force=1' : ''}`;
  const { status, json } = await apiFetch(url, {
    method: 'POST',
    headers: { 'X-Owner-Token': token }
  });
  return { status, json };
}

/* --------------------------------- main --------------------------------- */

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.project) {
    console.error('[regenerate] 缺少 --project <id>（--help 查看用法）');
    process.exit(2);
  }

  console.log(`[regenerate] 项目 #${opts.project} @ ${opts.api}`);

  // 1. owner 验证
  const token = await getOwnerToken(opts.api, opts.project, opts.password, opts.token);

  // 2. 拉取文件
  const workdir = opts.workdir || fs.mkdtempSync(path.join(os.tmpdir(), `pb-regenerate-${opts.project}-`));
  fs.mkdirSync(workdir, { recursive: true });
  console.log(`[regenerate] 工作目录: ${workdir}`);

  const files = await fetchFileList(opts.api, opts.project);
  console.log(`[regenerate] 拉取 ${files.length} 个文件…`);
  const restored = await restoreProject(workdir, opts.api, opts.project, files);
  console.log(`[regenerate] 已还原 ${restored} 个文件`);

  // 3. 检测并执行生成器
  const before = snapshotProject(workdir);
  const generator = findGenerator(workdir);
  if (generator) {
    console.log(`[regenerate] 检测到生成器脚本: ${generator}`);
    await runGenerator(workdir, generator);
  } else {
    console.log('[regenerate] 未检测到 Python 生成器脚本，跳过生成步骤');
  }
  const after = snapshotProject(workdir);
  const changes = diffSnapshots(before, after);
  const changesToWrite = changes.filter(c => c.path !== generator || c.action !== 'modified');

  if (changesToWrite.length === 0) {
    console.log('[regenerate] 生成后无产物变化（生成器未修改任何文件，或产物已最新）');
  } else {
    console.log(`[regenerate] 生成后产物变化（${changesToWrite.length}）:`);
    for (const c of changesToWrite) console.log(`  ${c.action.padEnd(8)} ${c.path}`);
  }

  // 4. 回写变化文件
  const writeResults = await writeBack(opts.api, opts.project, token, workdir, changesToWrite);
  const failedWrites = writeResults.filter(r => r.error || (r.status !== 200 && r.status !== 204));
  if (writeResults.length > 0) {
    console.log(`[regenerate] 回写线上存储: ${writeResults.length} 个文件（失败 ${failedWrites.length}）`);
  }
  for (const r of writeResults) {
    if (r.error || (r.status !== 200 && r.status !== 204)) {
      console.error(`  ✗ ${r.action} ${r.path} -> HTTP ${r.status} ${r.error || ''}`);
    } else if (opts.verbose) {
      console.log(`  ✓ ${r.action} ${r.path} -> HTTP ${r.status}`);
    }
  }
  if (failedWrites.length > 0) {
    throw new Error(`回写失败 ${failedWrites.length} 个文件，中止部署`);
  }

  // 5. 触发重新部署
  if (opts.skipDeploy) {
    console.log('[regenerate] --skip-deploy：跳过部署，产物已回写线上存储（可在评审页手动触发部署）');
  } else {
    console.log(`[regenerate] 触发重新部署${opts.force ? '（--force 跳过生成器检查）' : ''}…`);
    const { status, json } = await deploy(opts.api, opts.project, token, opts.force);
    console.log(`[regenerate] 部署接口响应 (HTTP ${status}):`);
    console.log(`  success=${json?.success}  method=${json?.method}  version=${json?.version}`);
    if (json?.regenerateRequired) {
      console.log(`  ⚠ 线上仍要求重新生成: ${json.message || ''}`);
    }
    if (json?.url) console.log(`  预览地址: ${json.url}`);
    if (json?.edgeone_url) console.log(`  EdgeOne 地址: ${json.edgeone_url}`);
    if (json?.status === 'deploying' || json?.method === 'edgeone_deploying') {
      console.log(`  部署进行中（deployment ${json?.deployment_id}），可轮询 GET /api/projects/${opts.project}/deploy-status?dep=${json?.deployment_id}`);
    }
    if (json?.generator) {
      console.log(`  生成器: ${json.generator.script}${json.generator.ran ? '（已执行）' : ''}${json.generator.forced ? '（force 跳过）' : ''}`);
      for (const c of (json.generator.changedFiles || [])) console.log(`    ${c}`);
    }
    if (status !== 200) {
      console.error(`  部署失败: ${json?.error || json?.message || ''}`);
      process.exitCode = 1;
    }
  }

  // 6. 清理
  if (!opts.keep) {
    fs.rmSync(workdir, { recursive: true, force: true });
    console.log('[regenerate] 已清理工作目录（--keep 保留）');
  } else {
    console.log(`[regenerate] 工作目录已保留: ${workdir}`);
  }
  console.log('[regenerate] 完成');
}

main().catch(err => {
  console.error(`[regenerate] 失败: ${err.message}`);
  process.exit(1);
});
