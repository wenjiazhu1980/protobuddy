/**
 * Makers Models proxy service.
 * Calls Makers Models via the official AI Gateway,
 * OpenAI-compatible chat completions API.
 * Falls back to rule-based plan generation if API is unavailable.
 *
 * Official endpoint: https://ai-gateway.edgeone.link/v1/chat/completions
 *   Authorization: Bearer <MAKERS_MODELS_KEY>
 *
 * Two model categories, same endpoint & auth:
 *   1. Built-in models (@makers/* prefix) — free quota, no vendor key needed.
 *      e.g. @makers/hy3, @makers/deepseek-v4-flash, @makers/kimi-k2.6
 *   2. Vendor models (vendor/name format) — requires binding the vendor's
 *      own API key in the Makers console → Models & Keys page.
 *      e.g. deepseek/deepseek-v4-flash, deepseek/deepseek-v4-pro
 *
 * Security: API key is never sent to frontend. All calls go through backend.
 */

const MAKERS_MODELS_ENDPOINT = 'https://ai-gateway.edgeone.link/v1/chat/completions';
// Default built-in model (Hunyuan 3.0). Can be overridden via project.makers_model.
// Vendor models (e.g. deepseek/deepseek-v4-pro) use the same endpoint, just a
// different model id — the user must bind the vendor API key in the Makers console.
const DEFAULT_MODEL = '@makers/hy3';

/**
 * Call Makers Models to generate a structured modification plan based on annotations.
 *
 * @param {string} apiKey - Makers Models API key
 * @param {array} annotations - Open annotations with x, y, content, page
 * @param {array} files - Current file list with content
 * @param {string} [model] - Makers built-in model id (default: @makers/hy3)
 * @param {string} [agentsRules] - Optional rules from the prototype root agents.md file.
 *   Injected into the system prompt so the model follows project-specific rules.
 * @returns {Promise<{success: boolean, plan?: object, error?: string, method: string}>}
 */
export async function generatePlanWithMakers(apiKey, annotations, files, model = DEFAULT_MODEL, agentsRules = '', retryFeedback = '') {
  if (!apiKey) {
    console.log('[makersModels] No API key provided, using rule-based fallback');
    return generateRuleBasedPlan(annotations, files);
  }

  try {
    // Build the prompt
    const annotationsText = annotations.map((a, i) => {
      const ele = a.element_info || a.elementInfo;
      let elementLine = '';
      if (ele && ele.found) {
        const tag = `<${ele.tagName}${ele.id ? ` id="${ele.id}"` : ''}${ele.className ? ` class="${ele.className}"` : ''}>`;
        const snippet = (ele.text || '').slice(0, 80).replace(/\s+/g, ' ');
        elementLine = `\n    Target element: ${tag}${snippet}</${ele.tagName}> (path: ${ele.path || ''}, isHeading: ${!!ele.isHeading}, fontSize: ${ele.fontSize || 'unknown'})`;
      }
      return `[${i + 1}] Page: ${a.page || 'index.html'}, Position: (${a.x}%, ${a.y}%), Comment: "${a.content}"${elementLine}`;
    }).join('\n');

    // Build file context. Large files (e.g. 260KB generator scripts) cannot be
    // sent whole; slicing the first N chars hides the target page's definition
    // deep in the file and makes the model HALLUCINATE functions that do not
    // exist. Strategy: head of the file + windows around occurrences of the
    // annotated page name(s) and the generator entrypoint (def main).
    //
    // TOKEN BUDGET: EdgeOne Cloud Functions have a 120s hard timeout. DeepSeek
    // reasoning models process input tokens slowly, so we cap total context at
    // ~40k chars (≈12k tokens) to keep generation under 100s.
    const pageHints = [...new Set(
      annotations
        .map(a => (a.page || '').split('/').pop())
        .filter(p => p && p.length >= 4)
    )];
    const MAX_FILE_CTX = 12000;
    const buildFileContext = (f) => {
      if (f.content?.binary) return '[binary file]';
      const data = f.content?.data || '';
      if (data.length <= 6000) return data;
      let ctx = data.slice(0, 1200);
      const hints = [...pageHints, 'def main'];
      let used = 0;
      for (const hint of hints) {
        let idx = 0;
        while (ctx.length < MAX_FILE_CTX) {
          const pos = data.indexOf(hint, idx);
          if (pos === -1) break;
          const start = Math.max(1200, pos - 400);
          const end = Math.min(data.length, pos + 2000);
          if (end > start) {
            ctx += `\n\n[... excerpt of ${f.path} around "${hint}" at offset ${pos} ...]\n` + data.slice(start, end);
            used++;
          }
          idx = pos + 1;
          if (used > 5) break;
        }
        if (used > 5) break;
      }
      return `(LARGE FILE — showing head + excerpts around the annotated page / entrypoint; offsets are approximate)\n${ctx}\n[END OF ${f.path} EXCERPTS]`;
    };
    const filesText = files.slice(0, 6).map(f => {
      return `--- File: ${f.path} ---\n${buildFileContext(f)}`;
    }).join('\n\n');

    // Optional project rules from the prototype's agents.md (injected into the system prompt)
    // NOTE: rules may embed the author's LOCAL machine paths (e.g. "原型设计/phase-2/x.py")
    // which do NOT exist in platform storage — the systemPrompt forbids using them.
    const rulesBlock = agentsRules
      ? `\n## Project Rules (from the prototype's agents.md — follow these for CONTENT decisions; but any file paths mentioned here reflect the author's local machine and are NOT valid in this project — use only the paths from the files list):\n${agentsRules}\n`
      : '';

    const systemPrompt = `You are a prototype review assistant. Based on the reviewer's annotations on a prototype, generate a structured modification plan. For each annotation, suggest specific file changes. Respond in JSON format ONLY (no markdown code fences):
{
  "summary": "Brief summary of the review feedback",
  "changes": [
    {
      "annotation_id": <id>,
      "file_path": "path/to/file.html",
      "description": "What to change",
      "old_code": "exact code snippet to find in the file",
      "new_code": "replacement code"
    }
  ]
}
Rules:
- file_path must be copied VERBATIM from the "--- File: <path>" headers of the project files list in the user message. Keep the exact subdirectory prefix as shown there.
- Paths that appear inside agents.md / project rules may come from ANOTHER machine's local folder layout (e.g. "原型设计/phase-2/..." while storage has "phase-2/..."). NEVER use paths from the rules text as file_path — always use the storage-relative path from the files list.
- old_code must be a substring that actually exists in the current file, so it can be replaced.
- NEVER invent or reconstruct code that is not shown in the provided file excerpts. If the section you need is not visible in the excerpts, still build old_code ONLY from lines that appear verbatim in the excerpts (e.g. the file's real function/definition structure). Copy old_code character-for-character from the excerpt text.
- Every annotation should map to one change.
- CRITICAL precision rule: if an annotation includes "Target element" info, you MUST modify ONLY that exact element. Use the element's tag name, id, class, and path to build a unique old_code snippet. The old_code must include the target element's opening tag (with id/class attributes) and enough parent context so it matches EXACTLY ONCE in the file. Do NOT perform plain text replacements that could hit other parts of the page.
- If no element info is provided, infer the target from the coordinate position (y≈top means header/hero, y≈bottom means footer) and still include the surrounding HTML context in old_code.
- NEVER use a bare text snippet (e.g. just the text being changed) as old_code. The old_code must always contain the HTML tag and enough surrounding context.
- GENERATOR-SCRIPT precision rule (applies when the target file is a Python generator script: _gen*.py, generate*.py, build.py, make*.py, or any .py whose content embeds HTML templates):
  1. The old_code MUST include a unique function anchor — e.g. the function definition line "def <name>(): " plus the first 1-3 lines of that function's body, or code that exists only inside the intended function. NEVER let old_code be an HTML snippet that appears in more than one page template inside the script (e.g. a shared badge/header block rendered by both the entry index and a sub-page template) — if it does, extend old_code upward/downward until it matches EXACTLY ONCE.
  2. Target the function that is actually invoked to produce the page: check how the script's main() / entrypoint writes output files and edit the function whose output reaches that file (e.g. render_index() for the root index.html). Do NOT edit a dead/duplicate function that is defined but never called — the change would silently have no effect on the deployed page.
  3. When the change is to a generator script, the description MUST note that generated HTML outputs (if any) need regeneration after the change, e.g. via the project's regeneration flow.
  4. GENERATOR DUAL-WRITE rule: when the target is a generator script, you MUST produce PAIRED changes for every affected page:
     a) One change edits the generator script (.py) — old_code MUST include a unique function anchor per rule 1 above; this keeps the source of truth consistent.
     b) One change edits the corresponding HTML output file directly — old_code and new_code MUST be copied verbatim from the HTML file's current content (NOT reconstructed from the .py template). This is the artifact that gets deployed.
     Both changes must reference each other in their description (e.g. "同步修改生成器 _gen_pages.py 的 render_m_agency() 函数" / "HTML 产物，对应生成器脚本的同步修改"). This lets the platform detect the dual-write pair and deploy the HTML directly WITHOUT needing external Python regeneration.
- When the annotation is about opening prototype sub-pages in the current page/tab instead of a new tab, fix BOTH forms of same-origin navigation:
  1. <a href="relative.html" target="_blank"> → change target to "_self" (or remove the target attribute).
  2. onclick handlers or scripts calling window.open('relative.html', '_blank') → change to window.location.href = 'relative.html'.
- Do NOT change external absolute links (http:// or https://) unless the annotation explicitly asks for it.
${rulesBlock}`
    // Dry-run precheck feedback: when a previous attempt's changes failed the
    // automated match validation (file missing / old_code not found / ambiguous),
    // the caller regenerates with the concrete errors appended here so the model
    // can fix its own mistakes instead of surfacing them at apply time.
    const feedbackBlock = retryFeedback
      ? `\n\n## VALIDATION ERRORS FROM YOUR PREVIOUS ATTEMPT
Your previously generated changes FAILED automated prechecks. Fix EVERY error below and output the FULL corrected plan.
For each error, re-read the provided file excerpts, copy old_code character-for-character from the real file content, ensure it matches EXACTLY ONCE, and use only file paths from the "--- File: <path>" headers.
${retryFeedback}`
      : '';

    const userPrompt = `## Annotations:
${annotationsText}

## Current Files:
${filesText}${feedbackBlock}

Generate a modification plan in JSON format.`;

    console.log(`[makersModels] Calling Makers Models API (model=${model})...`);

    // Kimi K2.x is a reasoning model: the Moonshot API REJECTS the `temperature`
    // parameter for it (400001 invalid_request_parameters). Reasoning models use
    // fixed sampling, so we must omit temperature for them.
    // deepseek-v4 / minimax also emit reasoning (reasoning_content / <think>),
    // so treat them as reasoning models too: more tokens + longer timeout.
    const isReasoningModel = /kimi-k2|deepseek-v4|minimax/i.test(model || '');
    const payload = {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      // Reasoning models spend tokens on `reasoning_content` first; give them
      // more room so the final JSON content is not truncated.
      max_tokens: isReasoningModel ? 6000 : 4000,
      response_format: { type: 'json_object' }
    };
    if (!isReasoningModel) {
      payload.temperature = 0.3;
    }

    // Cloud Functions have a 120s hard timeout (edgeone.json maxDuration: 120).
    // Leave 10s buffer for other processing (reading files, parsing JSON, etc.)
    // so the fetch itself doesn't exceed the platform limit and cause a 504.
    const fetchTimeoutMs = isReasoningModel ? 105000 : 50000;

    let response;
    try {
      response = await fetch(MAKERS_MODELS_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(fetchTimeoutMs)
      });
    } catch (fetchErr) {
      const isTimeout = fetchErr.name === 'TimeoutError' || fetchErr.name === 'AbortError';
      if (isTimeout) {
        throw new Error(
          `模型响应超时（${Math.round(fetchTimeoutMs / 1000)}s）。` +
          `推理模型生成方案需要较长时间，已超过平台 Cloud Function 120s 上限。` +
          `建议：① 减少批注数量后分批生成；② 换用更快的模型（如 @makers/hy3 或 @makers/deepseek-v4-flash）。`
        );
      }
      throw fetchErr;
    }

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Makers Models API returned ${response.status}: ${errText.slice(0, 300)}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    const usage = data.usage;

    // Try to parse JSON from the response
    let planData;
    try {
      // Strip reasoning/thinking tags that some models (e.g. minimax-m3) inline
      // into `content` (e.g. "<think>...</think>\n{...}"). This is a safety net —
      // kimi/deepseek put reasoning into a separate `reasoning_content` field.
      let clean = content
        .replace(/<think[\s\S]*?<\/think>/gi, '')
        .replace(/<reasoning[\s\S]*?<\/reasoning>/gi, '')
        .replace(/```(?:json)?\s*/gi, '')
        .replace(/```/g, '');
      // Extract JSON from possible markdown code blocks
      const jsonMatch = clean.match(/\{[\s\S]*\}/);
      planData = JSON.parse(jsonMatch ? jsonMatch[0] : clean);
    } catch (parseErr) {
      console.warn('[makersModels] Failed to parse JSON response, using as plain text');
      planData = {
        summary: content.slice(0, 500),
        changes: []
      };
    }

    // Normalize changes
    const changes = Array.isArray(planData.changes) ? planData.changes : [];
    if (changes.length === 0 && annotations.length > 0) {
      console.warn('[makersModels] Model returned no changes; plan may be incomplete.');
    }

    return {
      success: true,
      plan: {
        summary: planData.summary || `Generated from ${annotations.length} annotation(s).`,
        changes
      },
      model,
      usage,
      method: 'makers'
    };
  } catch (err) {
    console.warn(`[makersModels] API call failed: ${err.message}. Using rule-based fallback.`);
    const fallback = generateRuleBasedPlan(annotations, files);
    fallback.fallbackReason = `Makers Models API call failed: ${err.message}`;
    fallback.method = 'rule-based';
    return fallback;
  }
}

/**
 * Rule-based fallback plan generator.
 * Creates simple modification suggestions based on annotation content.
 */
function generateRuleBasedPlan(annotations, files) {
  const changes = annotations.map(ann => {
    // Try to guess the file from the page or default to index.html
    const filePath = ann.page || 'index.html';
    const fileRecord = files.find(f => f.path === filePath);

    let oldCode = '';
    let newCode = '';
    let description = ann.content;

    if (fileRecord && !fileRecord.content?.binary) {
      const content = fileRecord.content.data;
      const ele = ann.element_info || ann.elementInfo;
      if (ele && ele.text) {
        // Try to locate the probed element text in the file
        const idx = content.indexOf(ele.text.slice(0, 120));
        if (idx !== -1) {
          const start = Math.max(0, idx - 200);
          const end = Math.min(content.length, idx + Math.min(ele.text.length, 120) + 200);
          oldCode = content.slice(start, end);
          newCode = `<!-- TODO: Address annotation "${ann.content}" on element <${ele.tagName}> -->.\n${oldCode}`;
        }
      }
      if (!oldCode) {
        // Fallback: find a relevant snippet by line position
        const lines = content.split('\n');
        const targetLine = Math.floor((ann.y / 100) * lines.length);
        const startLine = Math.max(0, targetLine - 2);
        const endLine = Math.min(lines.length, targetLine + 3);
        oldCode = lines.slice(startLine, endLine).join('\n');
        newCode = `<!-- TODO: Address annotation: ${ann.content} -->\n${oldCode}`;
      }
    }

    return {
      annotation_id: ann.id,
      file_path: filePath,
      description: `Based on annotation "${ann.content}": Modify ${filePath} to address the reviewer's feedback.`,
      old_code: oldCode || '(auto-generated, may need manual adjustment)',
      new_code: newCode || `<!-- TODO: Address: ${ann.content} -->`,
      status: 'pending'
    };
  });

  return {
    success: true,
    plan: {
      summary: `Generated ${changes.length} modification suggestion(s) based on ${annotations.length} annotation(s). (Rule-based fallback - Makers Models API not available)`,
      changes
    },
    method: 'rule-based'
  };
}
