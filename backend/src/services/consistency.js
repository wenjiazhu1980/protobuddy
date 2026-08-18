// Annotation-to-plan consistency check (rough semantic screening).
//
// Problem: a generated plan can pass the dry-run match precheck (paths exist,
// old_code matches exactly once) yet completely miss what the annotations
// asked for — e.g. all changes target an unrelated page. That is only caught
// at human review today. This module does a cheap, local (no API) check right
// after generation:
//
//   1. Direct link: a change carries annotation_id pointing at the annotation.
//   2. Text containment: character-bigram containment score between the
//      annotation text and each change's description + new_code excerpt.
//      Chinese phrases survive paraphrase well at bigram level ("把标题改成
//      你好" vs "将页面标题修改为你好" share 标题/你好 bigrams).
//   3. Page file match: a change edits the exact file the annotation targets
//      (weak evidence — generator scripts can hit every page).
//
// Scores: linked >= 0.4; text score as computed; an exact page-file match is
// only a CONFIRMATION boost when the change already shows textual evidence
// (>= WEAK_THRESHOLD) — never evidence on its own, otherwise every annotation
// on a page with any change would look "weak/covered".
// Status: >= 0.30 covered, 0.12..0.30 weak, else uncovered.

const COVERED_THRESHOLD = 0.30;
const WEAK_THRESHOLD = 0.12;
const LINKED_SCORE = 0.40;

function bigrams(text) {
  const s = String(text || '').replace(/\s+/g, '');
  const out = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

// Asymmetric containment: what fraction of needle's bigrams appear anywhere
// in haystack. Unlike Dice this rewards long, detail-rich change text.
function containScore(needle, haystack) {
  const gs = bigrams(needle);
  if (!gs.length || !haystack) return 0;
  let hit = 0;
  for (const g of gs) if (haystack.includes(g)) hit++;
  return hit / gs.length;
}

/**
 * Check whether every annotation is actually addressed by the changes.
 *
 * @param {Array} annotations - [{ id, content, page, element_info? }]
 * @param {Array} changes - [{ annotation_id?, file_path, description, new_code }]
 * @returns {{checked, covered_count, weak_count, uncovered_count, results: Array}}
 */
export function checkConsistency(annotations, changes) {
  const results = (annotations || []).map(a => {
    const content = String(a.content || '');
    const elText = a.element_info
      ? String(a.element_info.text || a.element_info.selector || a.element_info.tag || '')
      : '';
    const annotationText = `${content}\n${elText}`.trim();

    let best = 0;
    const matched = [];
    (changes || []).forEach((c, idx) => {
      const changeText = `${c.description || ''}\n${String(c.new_code || '').slice(0, 1500)}`;
      let s = containScore(annotationText, changeText);
      const linked = c.annotation_id && String(c.annotation_id) === String(a.id);
      if (linked) s = Math.max(s, LINKED_SCORE);
      if (a.page && typeof c.file_path === 'string'
        && (c.file_path === a.page || c.file_path.endsWith('/' + a.page))
        && s >= WEAK_THRESHOLD) {
        // The change edits the annotation's page AND its text shows real
        // overlap with the request → call it addressed.
        s = Math.max(s, COVERED_THRESHOLD);
      }
      if (s > 0) matched.push(idx + 1);
      if (s > best) best = s;
    });

    const status = best >= COVERED_THRESHOLD ? 'covered'
      : best >= WEAK_THRESHOLD ? 'weak'
      : 'uncovered';

    return {
      annotation_id: a.id,
      page: a.page || '',
      content: content.slice(0, 80),
      score: Math.round(best * 100) / 100,
      matched_changes: matched,
      status
    };
  });

  const count = s => results.filter(r => r.status === s).length;
  return {
    checked: results.length,
    covered_count: count('covered'),
    weak_count: count('weak'),
    uncovered_count: count('uncovered'),
    results
  };
}

/**
 * Human-readable feedback block for the regeneration prompt: which
 * annotations the model failed to address, so it can add targeted changes.
 */
export function buildConsistencyFeedback(consistency) {
  const uncovered = (consistency?.results || []).filter(r => r.status === 'uncovered');
  if (!uncovered.length) return '';
  return uncovered.map(r =>
    `- 批注 #${r.annotation_id}（页面 ${r.page || '未知'}）未被方案回应：${r.content}`
  ).join('\n');
}
