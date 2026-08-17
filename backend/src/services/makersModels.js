/**
 * Makers Models proxy service.
 * Calls Makers Models (@makers/* built-in models) via the official AI Gateway,
 * OpenAI-compatible chat completions API.
 * Falls back to rule-based plan generation if API is unavailable.
 *
 * Official endpoint: https://ai-gateway.edgeone.link/v1/chat/completions
 *   Authorization: Bearer <MAKERS_MODELS_KEY>
 *   model: "@makers/hy3" | "@makers/hy3-preview" | "@makers/deepseek-v4-pro"
 *          | "@makers/deepseek-v4-flash" | "@makers/minimax-m3" | ...
 *
 * Security: API key is never sent to frontend. All calls go through backend.
 */

const MAKERS_MODELS_ENDPOINT = 'https://ai-gateway.edgeone.link/v1/chat/completions';
// Default built-in model (Hunyuan 3.0). Can be overridden via project.makers_model.
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
export async function generatePlanWithMakers(apiKey, annotations, files, model = DEFAULT_MODEL, agentsRules = '') {
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

    const filesText = files.slice(0, 10).map(f => {
      const content = f.content?.binary ? '[binary file]' : (f.content?.data || '').slice(0, 2000);
      return `--- File: ${f.path} ---\n${content}`;
    }).join('\n\n');

    // Optional project rules from the prototype's agents.md (injected into the system prompt)
    const rulesBlock = agentsRules
      ? `\n## Project Rules (from the prototype's agents.md — MUST follow these when generating changes):\n${agentsRules}\n`
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
- file_path must be one of the provided file paths (e.g. 原型设计/index.html). Keep the exact subdirectory prefix if present.
- old_code must be a substring that actually exists in the current file, so it can be replaced.
- Every annotation should map to one change.
- CRITICAL precision rule: if an annotation includes "Target element" info, you MUST modify ONLY that exact element. Use the element's tag name, id, class, and path to build a unique old_code snippet. The old_code must include the target element's opening tag (with id/class attributes) and enough parent context so it matches EXACTLY ONCE in the file. Do NOT perform plain text replacements that could hit other parts of the page.
- If no element info is provided, infer the target from the coordinate position (y≈top means header/hero, y≈bottom means footer) and still include the surrounding HTML context in old_code.
- NEVER use a bare text snippet (e.g. just the text being changed) as old_code. The old_code must always contain the HTML tag and enough surrounding context.
- When the annotation is about opening prototype sub-pages in the current page/tab instead of a new tab, fix BOTH forms of same-origin navigation:
  1. <a href="relative.html" target="_blank"> → change target to "_self" (or remove the target attribute).
  2. onclick handlers or scripts calling window.open('relative.html', '_blank') → change to window.location.href = 'relative.html'.
- Do NOT change external absolute links (http:// or https://) unless the annotation explicitly asks for it.
${rulesBlock}`
    const userPrompt = `## Annotations:
${annotationsText}

## Current Files:
${filesText}

Generate a modification plan in JSON format.`;

    console.log(`[makersModels] Calling Makers Models API (model=${model})...`);

    const response = await fetch(MAKERS_MODELS_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.3,
        max_tokens: 4000,
        response_format: { type: 'json_object' }
      }),
      signal: AbortSignal.timeout(60000)
    });

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
      // Extract JSON from possible markdown code blocks
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      planData = JSON.parse(jsonMatch ? jsonMatch[0] : content);
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
