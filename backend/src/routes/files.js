import { Router } from 'express';
import { getById, query, insert, update, remove } from '../db.js';
import { readFileContent, writeFileContent, deleteFile, findEntryPoint, isBinaryFile } from '../services/fileStorage.js';

const router = Router();

// List files for a project
router.get('/:id/files', async (req, res) => {
  const project = await getById('projects', req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const files = await query('files', f => String(f.project_id) === String(req.params.id));
  res.json(files);
});

// Read a single file's content
router.get('/:id/files/*', async (req, res) => {
  const project = await getById('projects', req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const filePath = req.params[0];
  const content = await readFileContent(req.params.id, filePath);
  if (!content) return res.status(404).json({ error: 'File not found' });

  res.json({ path: filePath, ...content });
});

// Write/update a file's content
router.post('/:id/files', async (req, res) => {
  const project = await getById('projects', req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { path: filePath, content } = req.body;
  if (!filePath) return res.status(400).json({ error: 'File path is required' });

  await writeFileContent(req.params.id, filePath, content);

  // Upsert file record
  const existing = await query('files', f => String(f.project_id) === String(req.params.id) && f.path === filePath);
  if (existing.length > 0) {
    await update('files', existing[0].id, { version: (existing[0].version || 1) + 1 });
  } else {
    await insert('files', {
      project_id: req.params.id,
      path: filePath,
      version: 1
    });
  }

  res.json({ success: true, path: filePath });
});

// Delete a file
router.delete('/:id/files/*', async (req, res) => {
  const project = await getById('projects', req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const filePath = req.params[0];
  await deleteFile(req.params.id, filePath);

  const existing = await query('files', f => String(f.project_id) === String(req.params.id) && f.path === filePath);
  for (const f of existing) await remove('files', f.id);

  res.json({ success: true });
});

/**
 * Inject a client script into prototype HTML that:
 *  1. Reports iframe scroll position to the parent window via postMessage,
 *     so annotation anchors can follow the page as it scrolls.
 *  2. Intercepts <a> clicks: relative / same-origin links navigate INSIDE the
 *     iframe (overriding target="_blank" and <base target>), so prototype
 *     sub-pages stay within the review frame. External absolute links keep
 *     opening in a new tab.
 *  3. Reports the current page path to the parent ({__protoNav:1, path}),
 *     so the review UI can filter annotations per page.
 * Idempotent: skips if already injected (marker in the HTML).
 */
function injectScrollSyncScript(html) {
  if (!html || html.indexOf('__protoScrollInjected') !== -1) return html;

  const script = '<script>/*proto-scroll-sync*/!function(){if(window.__protoScrollInjected)return;window.__protoScrollInjected=1;' +
    // 1. scroll sync
    'function s(){try{window.parent.postMessage({__protoScroll:1,x:window.scrollX||0,y:window.scrollY||0},"*")}catch(e){}}' +
    'window.addEventListener("scroll",s,{capture:true,passive:true});window.addEventListener("resize",s,{passive:true});' +
    // 2. page navigation reporting
    'function nav(){try{window.parent.postMessage({__protoNav:1,path:location.pathname+location.search},"*")}catch(e){}}' +
    'window.addEventListener("load",function(){nav();s()});' +
    // 3. link interception
    'function findA(t){for(var n=t;n&&n!==document;n=n.parentNode){if(n.tagName==="A")return n}return null}' +
    'document.addEventListener("click",function(e){' +
    'var a=findA(e.target);if(!a)return;' +
    'var href=a.getAttribute("href");if(!href)return;' +
    'if(href.charAt(0)==="#")return;' +
    'if(/^(javascript:|mailto:|tel:)/i.test(href))return;' +
    'var abs;try{abs=new URL(href,location.href)}catch(_){return}' +
    // external link: force a new tab (default target may be _self)
    'if(abs.origin!==location.origin){a.setAttribute("target","_blank");return}' +
    // same-page hash jump: let the browser handle it
    'if(abs.href.split("#")[0]===location.href.split("#")[0]&&abs.hash)return;' +
    'e.preventDefault();' +
    'if(abs.href!==location.href)location.href=abs.href' +
    '},true);' +
    // 4. override window.open so JS-driven same-origin popups stay inside the iframe
    'var _wopen=window.open;window.open=function(url,target,features){' +
    'if(url){try{var u=new URL(url,location.href);if(u.origin===location.origin){var t=(target||"").toLowerCase();if(t==="_blank"||t===""){location.href=u.href;return window;}}}catch(_){}}' +
    'return _wopen.apply(this,arguments)};' +
    // 5. probe the DOM element under a viewport point (used by the annotation overlay)
    'window.addEventListener("message",function(e){' +
    'var d=e.data;if(!d||d.__protoProbe!==1)return;' +
    'var info={__protoElement:1,id:d.id,found:false};' +
    'try{' +
    'var el=document.elementFromPoint(d.x,d.y);' +
    'if(!el)return window.parent.postMessage(info,"*");' +
    'info.found=true;info.tagName=el.tagName;info.id=el.id||"";info.className=el.className||"";' +
    'info.text=(el.innerText||el.textContent||"").slice(0,300);' +
    'info.isHeading=/^H[1-6]$/i.test(el.tagName);' +
    'try{info.fontSize=window.getComputedStyle(el).fontSize}catch(_){}' +
    'var path=[];var p=el;' +
    'while(p&&p!==document.body){' +
    'var seg=p.tagName?p.tagName.toLowerCase():"";' +
    'if(p.id&&p.id.trim)seg+="#"+p.id.trim();' +
    'else if(p.className&&typeof p.className==="string"){var c=p.className.trim().split(/\\s+/).slice(0,2);if(c.length&&c[0])seg+="."+c.join(".");}' +
    'path.unshift(seg);p=p.parentNode;' +
    '}' +
    'info.path=path.join(" > ");' +
    'var parent=el.parentNode;' +
    'if(parent){info.parentTag=parent.tagName||"";info.parentText=(parent.innerText||parent.textContent||"").slice(0,300);}' +
    '}catch(err){info.error=err.message;}' +
    'window.parent.postMessage(info,"*");' +
    '});' +
    'nav();document.readyState!=="loading"&&s()}();</script>';

  if (html.toLowerCase().indexOf('</body>') !== -1) {
    return html.replace(/<\/body>/i, script + '</body>');
  }
  return html + script;
}

// Send content with proper content-type; HTML gets scroll-sync injection
function sendContent(res, filePath, content) {
  const ext = (filePath.split('.').pop() || '').toLowerCase();

  if (isBinaryFile(filePath)) {
    const buf = Buffer.from(content.data, 'base64');
    res.type(ext).send(buf);
    return;
  }

  let text = content.data;
  if (ext === 'html' || ext === 'htm') {
    text = injectScrollSyncScript(text);
    res.type('html').send(text);
  } else {
    res.type(ext || 'text/plain').send(text);
  }
}

// Serve static prototype files (local hosting fallback + iframe source).
// Shared by both /:id/preview/* and /:id/preview (no trailing slash) — the
// old "set params[0] then next()" trick falls through because the wildcard
// route requires a slash after /preview, dropping the request into the
// app-level 404 catch-all.
async function servePreview(req, res, next) {
  try {
    const project = await getById('projects', req.params.id);
    if (!project) return res.status(404).send('Project not found');

    // Get the requested file path (after /preview/)
    let reqPath = req.params[0] || '';
    if (!reqPath || reqPath === '' || reqPath === '/') {
      // Use the storage driver's entry point discovery: root index.html first,
      // otherwise the index.html inside a subdirectory (e.g. ZIPs that wrap
      // everything in a top-level folder).
      const entry = await findEntryPoint(req.params.id);
      reqPath = entry ? `${entry}/index.html` : 'index.html';
    }

  // Guard against traversal (the storage drivers normalize paths, but be explicit)
  if (reqPath.split('/').some(seg => seg === '..')) {
    return res.status(403).send('Forbidden');
  }

  // Try the requested path, then as a directory (index.html inside)
  let content = await readFileContent(req.params.id, reqPath);
  if (!content) {
    content = await readFileContent(req.params.id, `${reqPath}/index.html`);
  }
  // ZIP-wrapped projects: the entry index.html lives in a subdirectory (e.g.
  // "原型设计/") but the iframe root URL is /preview/, so relative sub-page
  // links resolve against the root (e.g. /preview/04-商家控制台.html). Retry
  // with the entry directory prefix so those links serve correctly.
  if (!content) {
    const entry = await findEntryPoint(req.params.id);
    const entryDir = entry && entry.includes('/') ? entry.slice(0, entry.lastIndexOf('/') + 1) : '';
    if (entryDir && !reqPath.startsWith(entryDir)) {
      content = await readFileContent(req.params.id, entryDir + reqPath);
      if (!content) {
        content = await readFileContent(req.params.id, `${entryDir}${reqPath}/index.html`);
      }
    }
  }
  if (!content) {
    return res.status(404).send('File not found');
  }

  sendContent(res, reqPath, content);
  } catch (err) {
    next(err);
  }
}

router.get('/:id/preview/*', servePreview);

// Preview root (no file specified, no trailing slash)
router.get('/:id/preview', servePreview);

export default router;
