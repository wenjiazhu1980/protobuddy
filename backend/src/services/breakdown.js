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
 * Each generated issue carries: title, a FOUR-SECTION structured description
 * (页面功能概述 / 本任务覆盖的功能点 / 实现范围 / 验收标准), priority (P0/P1/P2),
 * estimated hours, labels, module path, source ref and linked annotation ids.
 *
 * Before decomposition, every page is profiled into feature points tagged with
 * exactly one category (核心交互 / 数据展示 / 用户操作流程 / 状态流转). Points are
 * then assigned to tasks with first-claim semantics — each point belongs to
 * exactly ONE task (no overlap), and unclaimed points always land in a
 * catch-all task (no omission). Everything is computed locally (no model calls).
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

// h1-h3 headings as feature points (pos = char offset in source, used to
// assign feature points to the heading section they live in)
function extractHeadings(html) {
  const out = [];
  const src = String(html || '');
  const re = /<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  let m;
  while ((m = re.exec(src)) !== null) {
    const text = plainText(m[2]);
    if (text && text.length <= 80 && !out.some(x => x.name === text)) {
      out.push({ level: Number(m[1]), name: text, pos: m.index });
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
      detail: `${inputs} 个输入框 / ${selects} 个下拉 / ${textareas} 个文本域（${method.toUpperCase()} → ${action || '当前页'}）`,
      method, action, inputs: inputs + selects + textareas,
      pos: m.index
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
    interactions.push({ type: 'nav', name: text, detail: `跳转 ${href}`, pos: m.index });
  }

  // standalone buttons with text
  const btnRe = /<button\b[^>]*>([\s\S]*?)<\/button>/gi;
  while ((m = btnRe.exec(src)) !== null) {
    const text = plainText(m[1]);
    if (text && text.length <= 20) {
      const key = 'btn|' + text;
      if (!seen.has(key)) {
        seen.add(key);
        interactions.push({ type: 'button', name: text, detail: '点击交互', pos: m.index });
      }
    }
  }

  return interactions.slice(0, 80);
}

/* ------------------------- page feature-point profile ------------------------- */

/**
 * Page feature-point profile (页面功能画像).
 *
 * Every page is analyzed into a flat list of feature points, each tagged with
 * exactly ONE category so that point→task assignment can guarantee:
 *   - completeness (不遗漏): every point is assigned to exactly one task
 *   - no overlap (不重叠): no point appears in two tasks
 *
 * Categories:
 *   interaction - 核心交互: forms / buttons / navigation links
 *   data        - 数据展示: tables / lists / image galleries / card grids
 *   flow        - 用户操作流程: search flow / pagination / multi-step wizard
 *   state       - 状态流转: selects / option toggles / modals / initial states
 */
const CATEGORY_LABEL = {
  interaction: '核心交互',
  data: '数据展示',
  flow: '用户操作流程',
  state: '状态流转'
};

const firstIndex = (src, re) => {
  const m = src.search(re);
  return m === -1 ? null : m;
};

function extractDataDisplays(src) {
  const out = [];
  let m;
  let tIdx = 0;
  const tableRe = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
  while ((m = tableRe.exec(src)) !== null) {
    tIdx++;
    const rows = Math.max(0, (m[1].match(/<tr\b/gi) || []).length - 1);
    const cols = (m[1].match(/<th\b/gi) || []).length || (m[1].match(/<td\b/gi) || []).length;
    out.push({ kind: 'table', name: tIdx > 1 ? `数据表格 ${tIdx}` : '数据表格', detail: `${rows} 行数据 / ${cols} 列`, pos: m.index });
  }
  const listCount = (src.match(/<[ou]l\b/gi) || []).length;
  const liCount = (src.match(/<li\b/gi) || []).length;
  if (liCount >= 3) out.push({ kind: 'list', name: '列表展示', detail: `${listCount} 个列表共 ${liCount} 个列表项`, pos: firstIndex(src, /<[ou]l\b/i) });
  const imgCount = (src.match(/<img\b/gi) || []).length;
  if (imgCount >= 3) out.push({ kind: 'images', name: '图片展示', detail: `${imgCount} 张图片`, pos: firstIndex(src, /<img\b/i) });
  const cardRe = /class\s*=\s*["'][^"']*\b(card|item|product|goods|blog|post)\b[^"']*["']/gi;
  const firstCard = cardRe.exec(src);
  const cardCount = 1 + (firstCard ? (src.match(new RegExp(cardRe.source, 'gi')) || []).length - 1 : 0);
  if (cardCount >= 2) out.push({ kind: 'cards', name: '卡片列表', detail: `${cardCount} 个卡片结构`, pos: firstCard ? firstCard.index : null });
  return out;
}

function extractFlows(src) {
  const out = [];
  // search flow: standalone keyword input not already covered by a form point
  const searchRe = /<input\b[^>]*(type\s*=\s*["']search["']|name\s*=\s*["'](q|kw|keyword|search)["'])/i;
  const hasStandaloneSearch = searchRe.test(src)
    && !/<form\b[^>]*>[\s\S]*?<input\b[^>]*(type\s*=\s*["']search["']|name\s*=\s*["'](q|kw|keyword|search)["'])/i.test(src);
  if (hasStandaloneSearch) out.push({ kind: 'search', name: '搜索流程', detail: '输入关键词 → 触发搜索 → 展示结果', pos: firstIndex(src, searchRe) });
  // pagination
  if (/class\s*=\s*["'][^"']*\b(pagination|pager)\b[^"']*["']/i.test(src) || /上一页|下一页|prev|next/i.test(plainText(src).slice(0, 4000))) {
    out.push({ kind: 'pagination', name: '分页流程', detail: '翻页控件切换数据区间', pos: firstIndex(src, /class\s*=\s*["'][^"']*\b(pagination|pager)\b/i) });
  }
  // multi-step wizard / stepper (single-step tabs are classified as state)
  const stepsRe = /class\s*=\s*["'][^"']*\b(wizard|stepper|checkout[- ]?step)\b[^"']*["']/i;
  const stepTextRe = /第\s*[1一]\s*步|step[- ]?1/i;
  if (stepsRe.test(src) || stepTextRe.test(src)) {
    out.push({ kind: 'steps', name: '多步流程', detail: '按步骤推进的操作流程，需维护步骤间状态', pos: firstIndex(src, stepsRe) ?? firstIndex(src, stepTextRe) });
  }
  return out;
}

function extractStates(src) {
  const out = [];
  const selCount = (src.match(/<select\b/gi) || []).length;
  if (selCount) out.push({ kind: 'select', name: '下拉选择联动', detail: `${selCount} 个下拉框，切换选项需联动相关区域`, pos: firstIndex(src, /<select\b/i) });
  const radioCount = (src.match(/<input\b[^>]*type\s*=\s*["']radio["']/gi) || []).length;
  const cbCount = (src.match(/<input\b[^>]*type\s*=\s*["']checkbox["']/gi) || []).length;
  if (radioCount + cbCount >= 2) out.push({ kind: 'options', name: '选项切换', detail: `${radioCount} 个单选 / ${cbCount} 个多选，选中态需正确维护`, pos: firstIndex(src, /<input\b[^>]*type\s*=\s*["'](radio|checkbox)["']/i) });
  const modalRe = /<(div|section|dialog)[^>]*\b(modal|dialog|popup|overlay|drawer)\b[^>]*>/i;
  if (modalRe.test(src)) out.push({ kind: 'modal', name: '弹层交互', detail: '弹窗/浮层打开与关闭，含遮罩层', pos: firstIndex(src, modalRe) });
  const tabsRe = /class\s*=\s*["'][^"']*\btabs?\b[^"']*["']/i;
  if (tabsRe.test(src) || /role\s*=\s*["']tablist["']/i.test(src)) {
    out.push({ kind: 'tabs', name: 'Tab 切换', detail: '页签激活态切换，各面板内容显隐', pos: firstIndex(src, tabsRe) });
  }
  const initStateRe = /\b(disabled|hidden)\b\s*[=>]/i;
  const loadingRe = /class\s*=\s*["'][^"']*\b(loading|spinner|skeleton)\b[^"']*["']/i;
  if (initStateRe.test(src) || loadingRe.test(src)) {
    out.push({ kind: 'initial-state', name: '初始/禁用状态', detail: '存在禁用项、隐藏区或加载态，需按状态正确呈现', pos: firstIndex(src, initStateRe) ?? firstIndex(src, loadingRe) });
  }
  return out;
}

/** Build the page profile: summary sentence + flat feature-point list. */
function buildPageProfile(page) {
  const points = [];
  const push = (category, p) => points.push({
    id: `${category}:${p.kind || p.type}:${points.length}`,
    category,
    kind: p.kind || p.type,
    name: p.name,
    detail: p.detail,
    pos: p.pos ?? null,
    raw: p
  });

  for (const it of page.interactions) push('interaction', it);   // forms / navs / buttons
  for (const d of extractDataDisplays(page.html)) push('data', d);
  for (const f of extractFlows(page.html)) push('flow', f);
  for (const s of extractStates(page.html)) push('state', s);

  const c = { interaction: 0, data: 0, flow: 0, state: 0 };
  for (const p of points) c[p.category]++;
  const parts = Object.entries(c).filter(([, n]) => n > 0).map(([k, n]) => `${CATEGORY_LABEL[k]} ${n} 项`);
  const traits = [];
  if (c.interaction >= 2 && c.data <= 1) traits.push('以交互操作为主');
  if (c.data >= 2 && c.interaction <= 1) traits.push('以内容展示为主');
  if (c.flow > 0) traits.push('包含完整操作流程');
  if (c.state > 0) traits.push('含状态流转');

  const summary = `「${page.name}」（${page.path}）共识别 ${points.length} 个功能点：${parts.join('、') || '仅基础静态布局'}`
    + (traits.length ? `，${traits.join('、')}` : '')
    + (page.headings.length ? `。主要区块：${page.headings.slice(0, 5).map(h => h.name).join('、')}` : '');

  return { summary, points, counts: c };
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

/* --------------------- structured description builders --------------------- */

/** One bullet line for a feature point. */
function pointLine(p) {
  return `- [${CATEGORY_LABEL[p.category]}] ${p.name}${p.detail ? `：${p.detail}` : ''}`;
}

/** Verification-oriented acceptance criterion per feature point. */
function acceptanceFor(p) {
  switch (p.kind) {
    case 'form': {
      const r = p.raw || {};
      const target = r.action ? r.action : '当前页';
      return `「${p.name}」提交时数据以 ${String(r.method || 'get').toUpperCase()} 发送至 ${target}，必填项缺失时有明确校验提示，提交后有成功/失败反馈`;
    }
    case 'nav': {
      const href = (p.detail || '').replace(/^跳转\s*/, '');
      return `点击「${p.name}」正确跳转到 ${href}，目标地址可达`;
    }
    case 'button':
      return `点击「${p.name}」产生预期行为并有可感知的反馈（状态变化或提示）`;
    case 'table':
      return `数据表格按原型渲染（${p.detail}），表头与数据列一一对应，空数据时展示空态`;
    case 'list':
      return `列表完整渲染（${p.detail}），逐项结构与原型一致，超长内容正确截断/换行`;
    case 'images':
      return `全部图片（${p.detail}）正常加载、比例与原型一致，加载失败有占位`;
    case 'cards':
      return `卡片列表（${p.detail}）渲染正确、间距一致，窄屏下响应式布局不错位`;
    case 'search':
      return `输入关键词可触发搜索并展示结果，空关键词与无结果场景有对应状态`;
    case 'pagination':
      return `翻页控件可用：切换页码后数据区正确更新，首末页边界状态正确`;
    case 'steps':
      return `多步流程可按顺序完整走通，步骤状态（已完成/当前/未到达）标识正确，可回退到已完成的步骤（如原型支持）`;
    case 'select':
      return `切换下拉选项后关联区域正确联动更新，回显选中值正确`;
    case 'options':
      return `单选/多选选中态正确维护，切换后相关区域即时响应`;
    case 'modal':
      return `弹层可正常打开与关闭（含遮罩点击/关闭按钮），打开时背景滚动锁定（如适用）`;
    case 'tabs':
      return `Tab 切换激活态正确，各面板内容按预期显示/隐藏，默认激活项与原型一致`;
    case 'initial-state':
      return `禁用/隐藏/加载等初始状态按原型呈现，状态切换后 UI 正确反映`;
    default:
      return `功能点「${p.name}」行为与原型一致且可独立验证`;
  }
}

/** Implementation-scope line per feature point. */
function scopeFor(p) {
  switch (p.kind) {
    case 'form': return `按原型实现「${p.name}」的字段布局、输入校验与提交流程（${p.detail}）`;
    case 'nav': return `实现导航入口「${p.name}」的样式与跳转（${p.detail}）`;
    case 'button': return `实现按钮「${p.name}」的样式、可点击态与点击行为`;
    case 'table': return `实现数据表格结构（${p.detail}）与数据绑定`;
    case 'list': return `实现列表渲染（${p.detail}）`;
    case 'images': return `集成图片资源（${p.detail}）并处理加载占位`;
    case 'cards': return `实现卡片组件与网格布局（${p.detail}）`;
    case 'search': return `实现搜索输入、触发方式与结果展示的完整流程`;
    case 'pagination': return `实现分页控件与数据区间切换`;
    case 'steps': return `实现多步流程的步骤推进、状态维护与回退`;
    case 'select': return `实现下拉选项及切换后的联动更新`;
    case 'options': return `实现单选/多选组件及选中态维护`;
    case 'modal': return `实现弹层结构、遮罩与开关控制`;
    case 'tabs': return `实现 Tab 结构、激活态与面板显隐`;
    case 'initial-state': return `实现各元素的初始状态与状态切换`;
    default: return `实现「${p.name}」`;
  }
}

/**
 * Four-section structured description:
 *   页面功能概述 → 本任务覆盖的功能点 → 实现范围 → 验收标准
 */
function buildStructuredDescription({ page, profile, points, scopeNote }) {
  const total = profile ? profile.points.length : 0;
  const lines = [];

  lines.push('### 页面功能概述');
  lines.push(profile ? profile.summary : `页面 ${page.path}，按原型实现布局与交互。`);
  lines.push('');

  lines.push('### 本任务覆盖的功能点');
  if (points && points.length) {
    lines.push(...points.map(pointLine));
    if (total > points.length) {
      lines.push('');
      lines.push(`> 页面共 ${total} 个功能点，本任务覆盖其中 ${points.length} 个；其余功能点由同页面的其他任务承接，请勿在本任务中重复实现。`);
    } else {
      lines.push('');
      lines.push(`> 本任务覆盖页面全部 ${total} 个功能点。`);
    }
  } else {
    lines.push('- 原型中未检出显式功能点（纯静态区块），交付以布局与文案还原为主。');
  }
  lines.push('');

  lines.push('### 实现范围');
  if (points && points.length) lines.push(...points.map(p => `- ${scopeFor(p)}`));
  else lines.push(`- 实现「${page.name}」区块的布局、样式与文案还原`);
  lines.push('- 布局、间距、字号、配色与原型保持一致');
  if (scopeNote) lines.push(`- ${scopeNote}`);
  lines.push('');

  lines.push('### 验收标准');
  if (points && points.length) lines.push(...points.map(p => `- [ ] ${acceptanceFor(p)}`));
  else lines.push(`- [ ] 区块渲染结果与原型视觉一致，文案无缺漏`);
  lines.push('- [ ] 本任务功能点可独立验证：不依赖同页面其他任务即可走通并检查上述条目');
  lines.push('- [ ] 不引入其他任务负责的功能点（避免职责重叠）');

  return lines.join('\n');
}

/* ------------------------------ issue builder ------------------------------ */

function buildIssue({ projectName, title, description, page, profile, points, scopeNote, sourceRef, annotations = [], labels = [], extra = {} }) {
  const count = annotations.length;
  const priority = count >= 5 ? 'P0' : count >= 2 ? 'P1' : 'P2';
  const baseLabels = ['prototype', 'frontend'];
  if (page && page.path) baseLabels.push(page.path.split('/').pop());
  if (page && /\.html?$/i.test(page.path || '') && page.name) baseLabels.push('page');

  // Structured four-section body (feature-point oriented) when a profile exists
  const structured = profile
    ? buildStructuredDescription({ page, profile, points, scopeNote })
    : description;

  // Resolved annotations folded in as acceptance hints
  const openAnns = annotations.filter(a => a.status !== 'resolved');
  let body = [
    structured,
    '',
    '---',
    `**来源**：原型功能模块自动拆解`,
    projectName ? `**项目**：${projectName}` : '',
    page ? `**页面**：${page.path}${page.name ? '（' + page.name + '）' : ''}` : '',
    sourceRef.type === 'feature' ? `**功能点**：${sourceRef.name}` : '',
    sourceRef.type === 'interaction' ? `**交互**：${sourceRef.name}` : '',
    `**模块路径**：${(extra.modulePath || []).join(' / ') || '—'}`,
    profile ? `**功能点覆盖**：${points.length}/${profile.points.length}` : '',
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
    feature_points: (points || []).map(p => ({ category: p.category, kind: p.kind, name: p.name })),
    page_feature_count: profile ? profile.points.length : 0,
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
        complexity: complexityOf(html),
        html
      };
      page.estimate = estimatePageHours(page);
      page.profile = buildPageProfile(page);
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

  // feature point ↔ heading matching: bidirectional substring inclusion
  const pointMatchesHeading = (point, headingName) => {
    const pn = String(point.name || '').toLowerCase();
    const hn = String(headingName || '').toLowerCase();
    return (hn.length >= 2 && pn.includes(hn)) || (pn.length >= 2 && hn.includes(pn));
  };

  /**
   * Assign feature points to heading sections by DOM position: a point belongs
   * to the heading section whose [heading.pos, nextHeading.pos) interval
   * contains point.pos. Points before the first heading (page header / global
   * nav) stay unclaimed → they end up in the catch-all task, which is the
   * right owner for page-level concerns. Name matching is used as fallback for
   * points without a usable position.
   */
  function assignPointsToHeadings(points, headings) {
    const claim = new Map();   // pointId -> heading name
    const withPos = (headings || []).filter(h => typeof h.pos === 'number').sort((a, b) => a.pos - b.pos);
    if (!withPos.length) return claim;
    for (const p of points) {
      if (typeof p.pos !== 'number' || p.pos < withPos[0].pos) continue;  // pre-header content → catch-all
      let target = withPos[withPos.length - 1];
      for (let i = 0; i < withPos.length; i++) {
        const end = i + 1 < withPos.length ? withPos[i + 1].pos : Infinity;
        if (p.pos >= withPos[i].pos && p.pos < end) { target = withPos[i]; break; }
      }
      claim.set(p.id, target.name);
    }
    return claim;
  }

  for (const page of pages) {
    const pageAnns = annByPage.get(pageKeyOf(page.path)) || [];
    const profile = page.profile;

    if (granularity === 'page') {
      const draft = buildIssue({
        projectName,
        title: `实现「${page.name}」页面`,
        page,
        profile,
        points: profile.points,
        scopeNote: '本任务为整页交付：页面全部功能点在此任务内实现并统一验收',
        sourceRef: { type: 'page', name: page.name },
        annotations: pageAnns,
        extra: { modulePath: [page.name] }
      });
      draft.estimate_hours = cfg.auto_estimate ? page.estimate : 1;
      emit(draft);
      continue;
    }

    if (granularity === 'feature') {
      const isFallbackFeatures = !page.headings.length;
      const features = page.headings.length ? page.headings : page.interactions.length ? [
        { name: page.name, interactions: page.interactions }
      ] : [{ name: page.name, interactions: [] }];

      const claimedPoints = new Set();
      const claimedAnns = new Set();
      // position-based assignment: point → heading section it lives in
      const assignMap = isFallbackFeatures ? null : assignPointsToHeadings(profile.points, features);

      for (const f of features) {
        // each point is claimed by at most one heading task (no overlap):
        // 1) DOM position inside this heading's section, or
        // 2) name-based fallback for points without position
        const featPoints = profile.points.filter(p => {
          if (claimedPoints.has(p.id)) return false;
          if (isFallbackFeatures) return true;              // single whole-page task takes all
          if (assignMap.get(p.id) === f.name) return true;
          return !assignMap.has(p.id) && pointMatchesHeading(p, f.name);
        });
        featPoints.forEach(p => claimedPoints.add(p.id));

        const featAnns = pageAnns.filter(a => mentions(a.content, f.name) || pageAnns.length <= 2);
        featAnns.forEach(a => claimedAnns.add(a));

        const draft = buildIssue({
          projectName,
          title: `实现「${page.name}」- ${f.name}`,
          page,
          profile,
          points: featPoints,
          scopeNote: `本任务聚焦区块「${f.name}」；页面级通用功能与未列出的功能点由「通用功能收尾」任务承接`,
          sourceRef: { type: 'feature', name: f.name },
          annotations: featAnns,
          extra: { modulePath: [page.name, f.name] }
        });
        draft.estimate_hours = cfg.auto_estimate
          ? estimateFeatureHours({ interactions: page.interactions.filter(i => mentions(i.name, f.name)) }, page)
          : 1;
        emit(draft);
      }

      // catch-all task: feature points not claimed by any heading (no omission)
      const leftovers = profile.points.filter(p => !claimedPoints.has(p.id));
      if (leftovers.length) {
        const restAnns = pageAnns.filter(a => !claimedAnns.has(a));
        const draft = buildIssue({
          projectName,
          title: `实现「${page.name}」- 通用功能收尾`,
          page,
          profile,
          points: leftovers,
          scopeNote: '本任务承接该页面未被区块任务覆盖的全部功能点，并负责页面级布局骨架与全局样式',
          sourceRef: { type: 'feature', name: '通用功能收尾' },
          annotations: restAnns,
          extra: { modulePath: [page.name, '通用功能收尾'] }
        });
        draft.estimate_hours = cfg.auto_estimate
          ? Math.max(1, Math.round((0.5 + leftovers.length * 0.5) * 2) / 2)
          : 1;
        emit(draft);
      }
      continue;
    }

    // granularity === 'interaction': one task per interaction point +
    // a catch-all task for data / flow / state points (no omission, no overlap)
    const interPoints = profile.points.filter(p => p.category === 'interaction');
    const otherPoints = profile.points.filter(p => p.category !== 'interaction');

    if (!interPoints.length && !otherPoints.length) {
      const draft = buildIssue({
        projectName,
        title: `实现「${page.name}」- 页面加载（nav）`,
        page,
        profile,
        points: [],
        sourceRef: { type: 'interaction', name: '页面加载' },
        annotations: pageAnns,
        extra: { modulePath: [page.name, '页面加载'] }
      });
      draft.estimate_hours = 0.5;
      emit(draft);
      continue;
    }

    for (const p of interPoints) {
      const itAnns = pageAnns.filter(a => mentions(a.content, p.name) || mentions(a.content, p.kind));
      const draft = buildIssue({
        projectName,
        title: `实现「${page.name}」- ${p.name}（${p.kind}）`,
        page,
        profile,
        points: [p],
        scopeNote: '本任务仅实现该单一交互点；页面其他功能点由其他任务承接',
        sourceRef: { type: 'interaction', name: p.name },
        annotations: itAnns,
        extra: { modulePath: [page.name, p.name] }
      });
      draft.estimate_hours = cfg.auto_estimate ? estimateInteractionHours(p.raw) : 0.5;
      emit(draft);
    }

    if (otherPoints.length) {
      const claimedAnnIds = new Set(pageAnns.filter(a => interPoints.some(p => mentions(a.content, p.name) || mentions(a.content, p.kind))).map(a => a.id));
      const restAnns = pageAnns.filter(a => !claimedAnnIds.has(a.id));
      const draft = buildIssue({
        projectName,
        title: `实现「${page.name}」- 布局与通用功能`,
        page,
        profile,
        points: otherPoints,
        scopeNote: '本任务承接数据展示、操作流程与状态流转类功能点及页面布局骨架',
        sourceRef: { type: 'interaction', name: '布局与通用功能' },
        annotations: restAnns,
        extra: { modulePath: [page.name, '布局与通用功能'] }
      });
      draft.estimate_hours = cfg.auto_estimate
        ? Math.max(1, Math.round((1 + otherPoints.length * 0.5) * 2) / 2)
        : 1;
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
