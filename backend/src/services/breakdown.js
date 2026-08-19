/**
 * Prototype → developer issues breakdown engine.
 *
 * Reads a project's prototype files (HTML pages) + annotations and decomposes
 * them into developer-facing issues based on a configurable granularity:
 *
 *   - page        : one issue per HTML page
 *   - feature     : one issue per page section/heading (h1-h3, nav items, cards)
 *   - interaction : one issue per interaction point (form, button, anchor nav)
 *
 * Each generated issue carries: title, description (acceptance-oriented),
 * priority (P0/P1/P2), estimated hours, labels, module path, source ref and
 * linked annotation ids. Everything is computed locally (no model calls).
 */
import { readFileContent } from './fileStorage.js';

export const PRIORITIES = ['P0', 'P1', 'P2'];
export const STATUSES = ['todo', 'in_progress', 'done'];

/** Default breakdown configuration (per project overridable). */
export function defaultBreakdownConfig() {
  return {
    granularity: 'page',            // 'page' | 'feature' | 'interaction'
    auto_estimate: true,            // estimate hours from DOM complexity
    include_annotations: true,      // fold unresolved annotations into issues
    default_labels: ['prototype', 'frontend'],
    priority_annotation_threshold: { p0: 5, p1: 2 },  // #annotations → P0 / P1
    max_pages: 200                  // safety cap on pages to parse
  };
}

/* ------------------------------ HTML parsing ------------------------------ */

// Strip tags, collapse whitespace, unescape common entities.
function plainText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTitle(html) {
  const m = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? plainText(m[1]) : '';
}

// h1-h3 headings as feature points
function extractHeadings(html) {
  const out = [];
  const re = /<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  let m;
  while ((m = re.exec(String(html || ''))) !== null) {
    const text = plainText(m[2]);
    if (text && text.length <= 80 && !out.some(x => x.name === text)) {
      out.push({ level: Number(m[1]), name: text });
    }
  }
  return out;
}

// interaction points: forms / inputs / buttons / nav links
function extractInteractions(html) {
  const interactions = [];
  const src = String(html || '');

  // forms
  let m;
  const formRe = /<form\b[^>]*>([\s\S]*?)<\/form>/gi;
  let formIdx = 0;
  while ((m = formRe.exec(src)) !== null) {
    formIdx++;
    const attrs = m[0];
    const action = (attrs.match(/action\s*=\s*["']([^"']*)["']/i) || [])[1] || '';
    const method = (attrs.match(/method\s*=\s*["']([^"']*)["']/i) || [])[1] || 'get';
    const inputs = (m[1].match(/<input\b[^>]*>/gi) || []).length;
    const selects = (m[1].match(/<select\b[^>]*>/gi) || []).length;
    const textareas = (m[1].match(/<textarea\b[^>]*>/gi) || []).length;
    const submit = (m[1].match(/<button\b[^>]*type\s*=\s*["']submit["']/i) || []).length
      || /<button\b[^>]*>/i.test(m[1]) ? 1 : 0;
    interactions.push({
      type: 'form',
      name: `表单${formIdx}` + (action ? `（提交至 ${action}）` : ''),
      detail: `${inputs} 个输入框 / ${selects} 个下拉 / ${textareas} 个文本域`
    });
  }

  // nav links (excluding pure anchor jumps)
  const seen = new Set();
  const linkRe = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  while ((m = linkRe.exec(src)) !== null) {
    const href = m[1].trim();
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) continue;
    const text = plainText(m[2]);
    if (!text || text.length > 60) continue;
    const key = href + '|' + text;
    if (seen.has(key)) continue;
    seen.add(key);
    interactions.push({ type: 'nav', name: text, detail: `跳转 ${href}` });
  }

  // standalone buttons with text
  const btnRe = /<button\b[^>]*>([\s\S]*?)<\/button>/gi;
  while ((m = btnRe.exec(src)) !== null) {
    const text = plainText(m[1]);
    if (text && text.length <= 20) {
      const key = 'btn|' + text;
      if (!seen.has(key)) {
        seen.add(key);
        interactions.push({ type: 'button', name: text, detail: '点击交互' });
      }
    }
  }

  return interactions.slice(0, 80);
}

// rough DOM complexity weight for hour estimation
function complexityOf(html) {
  const src = String(html || '');
  const inputCount = (src.match(/<input\b/gi) || []).length;
  const imgCount = (src.match(/<img\b/gi) || []).length;
  const sectionCount = (src.match(/<section\b/gi) || []).length + (src.match(/<div\b[^>]*class=/gi) || []).length;
  return { inputCount, imgCount, sectionCount };
}

/* ---------------------------- hour estimation ----------------------------- */

function estimatePageHours(page) {
  const { inputCount, imgCount, sectionCount } = page.complexity;
  return Math.max(2, Math.round((2 + sectionCount * 0.4 + inputCount * 0.2 + imgCount * 0.1) * 2) / 2);
}

function estimateFeatureHours(feature, page) {
  const base = 1 + feature.interactions.length * 0.5;
  return Math.max(0.5, Math.round(base * 2) / 2);
}

function estimateInteractionHours(interaction) {
  let h = 0.5;
  if (interaction.type === 'form') h += 1;
  if (interaction.type === 'nav') h += 0.5;
  if (interaction.type === 'button') h += 0.5;
  return Math.max(0.5, Math.round(h * 2) / 2);
}

/* ------------------------------ issue builder ------------------------------ */

function buildIssue({ projectName, title, description, page, sourceRef, annotations = [], labels = [], extra = {} }) {
  const count = annotations.length;
  const priority = count >= 5 ? 'P0' : count >= 2 ? 'P1' : 'P2';
  const baseLabels = ['prototype', 'frontend'];
  if (page && page.path) baseLabels.push(page.path.split('/').pop());
  if (page && /\.html?$/i.test(page.path || '') && page.name) baseLabels.push('page');

  // Resolved annotations folded in as acceptance hints
  const openAnns = annotations.filter(a => a.status !== 'resolved');
  let body = [
    description,
    '',
    '---',
    `**来源**：原型功能模块自动拆解`,
    projectName ? `**项目**：${projectName}` : '',
    page ? `**页面**：${page.path}${page.name ? '（' + page.name + '）' : ''}` : '',
    sourceRef.type === 'feature' ? `**功能点**：${sourceRef.name}` : '',
    sourceRef.type === 'interaction' ? `**交互**：${sourceRef.name}` : '',
    `**模块路径**：${(extra.modulePath || []).join(' / ') || '—'}`,
    openAnns.length ? `**关联批注**：${openAnns.length} 条未解决` : '**关联批注**：无',
    ''
  ].filter(Boolean).join('\n');

  if (openAnns.length) {
    body += '\n**未解决批注**：\n' + openAnns.map(a => `- [${a.page || ''}] ${a.content}`).join('\n');
  }

  return {
    title,
    description: body,
    priority,
    estimate_hours: 0,           // filled by estimator
    labels: [...new Set([...baseLabels, ...labels])],
    source: 'auto',
    source_ref: { type: sourceRef.type, name: sourceRef.name, path: page ? page.path : '', annotation_ids: annotations.map(a => a.id) },
    annotation_ids: annotations.map(a => a.id),
    module_path: extra.modulePath || [],
    status: 'todo'
  };
}

/* ------------------------------ main pipeline ----------------------------- */

/**
 * Parse a prototype and generate issues.
 *
 * @param {object} ctx
 * @param {string} ctx.projectId
 * @param {string} [ctx.projectName]
 * @param {object} ctx.config            breakdown config (see defaultBreakdownConfig)
 * @param {Array}  ctx.annotations       annotations for the project (rows from db)
 * @returns {Promise<Array>} generated issue drafts (no ids yet)
 */
export async function breakdownPrototype(ctx) {
  const { projectId, projectName = '', config = {}, annotations = [] } = ctx;
  const cfg = { ...defaultBreakdownConfig(), ...config };
  const granularity = cfg.granularity || 'page';

  // 1. Collect HTML pages from the file store
  const files = await import('./fileStorage.js').then(m => m.listProjectFiles(projectId)).catch(() => []);
  const htmlFiles = files.filter(f => /\.html?$/i.test(f)).sort((a, b) => {
    const ai = a === 'index.html' ? -1 : 0;
    const bi = b === 'index.html' ? -1 : 0;
    return ai - bi || a.localeCompare(b);
  }).slice(0, cfg.max_pages || 200);

  const pages = [];
  for (const path of htmlFiles) {
    try {
      const content = await readFileContent(projectId, path);
      if (!content || content.binary) continue;
      const html = String(content.data || '');
      const page = {
        path,
        name: extractTitle(html) || path.split('/').pop().replace(/\.html?$/i, '') || path,
        headings: extractHeadings(html),
        interactions: extractInteractions(html),
        complexity: complexityOf(html)
      };
      page.estimate = estimatePageHours(page);
      pages.push(page);
    } catch (e) {
      console.error(`[breakdown] failed to read ${path}:`, e.message);
    }
  }

  // 2. Group annotations by page (normalize leading ./ and subdirs for matching)
  const annByPage = new Map();
  for (const a of annotations || []) {
    const key = normalizePageKey(a.page);
    if (!annByPage.has(key)) annByPage.set(key, []);
    annByPage.get(key).push(a);
  }
  const pageKeyOf = (path) => normalizePageKey(path);

  // 3. Generate issues per granularity
  const issues = [];
  const usedModulePaths = new Set();

  const emit = (draft) => {
    // dedupe by title+module
    const sig = `${draft.title}::${draft.module_path.join('/')}`;
    if (usedModulePaths.has(sig)) return;
    usedModulePaths.add(sig);
    issues.push(draft);
  };

  for (const page of pages) {
    const pageAnns = annByPage.get(pageKeyOf(page.path)) || [];

    if (granularity === 'page') {
      const draft = buildIssue({
        projectName,
        title: `实现「${page.name}」页面`,
        description: `开发页面 ${page.path}，按原型实现布局、样式与基础交互。`,
        page,
        sourceRef: { type: 'page', name: page.name },
        annotations: pageAnns,
        extra: { modulePath: [page.name] }
      });
      draft.estimate_hours = cfg.auto_estimate ? page.estimate : 1;
      emit(draft);
      continue;
    }

    if (granularity === 'feature') {
      const features = page.headings.length ? page.headings : page.interactions.length ? [
        { name: page.name, interactions: page.interactions }
      ] : [{ name: page.name, interactions: [] }];

      for (const f of features) {
        const featAnns = pageAnns.filter(a => mentions(a.content, f.name) || pageAnns.length <= 2);
        const draft = buildIssue({
          projectName,
          title: `实现「${page.name}」- ${f.name}`,
          description: `实现功能点「${f.name}」（页面 ${page.path}），包含相关交互与状态。`,
          page,
          sourceRef: { type: 'feature', name: f.name },
          annotations: featAnns,
          extra: { modulePath: [page.name, f.name] }
        });
        draft.estimate_hours = cfg.auto_estimate
          ? estimateFeatureHours({ interactions: page.interactions.filter(i => mentions(i.name, f.name)) }, page)
          : 1;
        emit(draft);
      }
      continue;
    }

    // granularity === 'interaction'
    const interactions = page.interactions.length ? page.interactions : [{ type: 'nav', name: '页面加载', detail: '初始渲染' }];
    for (const it of interactions) {
      const itAnns = pageAnns.filter(a => mentions(a.content, it.name) || mentions(a.content, it.type));
      const draft = buildIssue({
        projectName,
        title: `实现「${page.name}」- ${it.name}（${it.type}）`,
        description: `实现交互「${it.name}」${it.detail ? '：' + it.detail : ''}，确保在页面 ${page.path} 上可正常触发与反馈。`,
        page,
        sourceRef: { type: 'interaction', name: it.name },
        annotations: itAnns,
        extra: { modulePath: [page.name, it.name] }
      });
      draft.estimate_hours = cfg.auto_estimate ? estimateInteractionHours(it) : 0.5;
      emit(draft);
    }
  }

  // 4. Fold orphan annotations (no matching page) into a dedicated issue
  const orphanAnns = (annotations || []).filter(a => !pages.some(p => pageKeyOf(p.path) === normalizePageKey(a.page)));
  if (orphanAnns.length) {
    const draft = buildIssue({
      projectName,
      title: '处理未定位批注',
      description: `原型中存在 ${orphanAnns.length} 条无法定位到具体页面的批注，需要人工确认归属后处理。`,
      page: null,
      sourceRef: { type: 'annotation', name: 'orphan' },
      annotations: orphanAnns,
      extra: { modulePath: ['未定位批注'] }
    });
    draft.estimate_hours = Math.max(0.5, Math.round(orphanAnns.length * 0.5 * 2) / 2);
    emit(draft);
  }

  return issues;
}

function normalizePageKey(page) {
  let p = String(page || '');
  p = p.replace(/^\.\//, '');
  const parts = p.split('/');
  return parts[parts.length - 1];  // match on filename (subdir differences tolerated)
}

function mentions(text, kw) {
  if (!text || !kw) return false;
  const t = String(text).toLowerCase();
  const k = String(kw).toLowerCase();
  return k.length >= 2 && t.includes(k);
}
