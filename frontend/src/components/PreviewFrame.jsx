import { useRef, useState, useEffect, useCallback } from 'react';
import { API_BASE } from '../api.js';

/**
 * Convert a nav pathname (e.g. "/api/projects/1/preview/04-商家控制台.html")
 * to a page identifier relative to the preview root ("04-商家控制台.html").
 * The preview root maps to the entry page ("index.html").
 */
function pageFromPath(raw) {
  let s = decodeURIComponent(String(raw || ''));
  s = s.split('?')[0].split('#')[0];
  const i = s.indexOf('/preview');
  if (i !== -1) s = s.slice(i + '/preview'.length);
  s = s.replace(/^\/+/, '');
  if (!s || s === '') return 'index.html';
  if (s.endsWith('/')) s += 'index.html';
  return s;
}

/** Normalize a stored annotation page field for comparison. */
function normalizePage(p) {
  let s = String(p || 'index.html').replace(/^\.\//, '');
  if (!s) s = 'index.html';
  return s;
}

/**
 * PreviewFrame - renders the prototype in an iframe.
 * The overlay sits ON TOP of the iframe (not inside it) to avoid cross-domain issues.
 * Clicks on the overlay are converted to percentage coordinates.
 *
 * Scroll sync: the backend injects a small script into the prototype HTML that
 * reports iframe scroll position via postMessage. Anchors offset by the scroll
 * delta so they follow the page content as it scrolls (up/down/left/right).
 *
 * Sub-page navigation: the same injected script intercepts relative/same-origin
 * link clicks (keeping them inside the iframe) and reports the current page via
 * {__protoNav}. This component tracks the current page so annotation pins are
 * filtered per page and new annotations record which page they belong to.
 */
export default function PreviewFrame({ projectId, version, annotateMode, onAnnotate, annotations, activeAnnotationId, onAnnotationClick, onPageChange }) {
  const containerRef = useRef(null);
  const iframeRef = useRef(null);
  const probeRef = useRef({ nextId: 0, results: {} });
  const [iframeKey, setIframeKey] = useState(0);
  const [scrollPos, setScrollPos] = useState({ x: 0, y: 0 });
  const [currentPage, setCurrentPage] = useState('index.html');

  // Construct preview URL - use relative path so it works in both dev and prod
  const previewUrl = `${API_BASE}/projects/${projectId}/preview/`;

  // Reload iframe when version changes, reset scroll offset
  useEffect(() => {
    setIframeKey(k => k + 1);
    setScrollPos({ x: 0, y: 0 });
    setCurrentPage('index.html');
  }, [version]);

  // Listen for scroll position reports, page-navigation reports, and element
  // probe responses from the injected prototype script
  const handleScrollMessage = useCallback((e) => {
    const d = e.data;
    if (!d) return;
    if (d.__protoScroll) {
      setScrollPos({
        x: typeof d.x === 'number' ? d.x : 0,
        y: typeof d.y === 'number' ? d.y : 0
      });
    } else if (d.__protoNav) {
      const page = pageFromPath(d.path);
      setCurrentPage(page);
      // New page starts at scroll 0; discard stale offset
      setScrollPos({ x: 0, y: 0 });
      onPageChange?.(page);
    } else if (d.__protoElement) {
      // store element probe result keyed by request id
      probeRef.current.results[d.id] = d;
    }
  }, [onPageChange]);

  useEffect(() => {
    window.addEventListener('message', handleScrollMessage);
    return () => window.removeEventListener('message', handleScrollMessage);
  }, [handleScrollMessage]);

  const handleClick = (e) => {
    if (!annotateMode) return;
    if (!containerRef.current) return;

    const rect = containerRef.current.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    const viewportX = e.clientX - rect.left;
    const viewportY = e.clientY - rect.top;

    // Probe the DOM element under the click point via the injected iframe script.
    // The user then types in the prompt, which gives the probe plenty of time
    // to report back before we create the annotation.
    const probeId = ++probeRef.current.nextId;
    probeRef.current.results[probeId] = null;
    try {
      iframeRef.current?.contentWindow?.postMessage(
        { __protoProbe: 1, id: probeId, x: viewportX, y: viewportY },
        '*'
      );
    } catch (_) {
      // iframe not ready or cross-origin blocked; ignore and fall back to coordinates only
    }

    // Prompt for annotation content
    const content = window.prompt('请输入批注内容：');
    if (content && content.trim()) {
      const elementInfo = probeRef.current.results[probeId];
      onAnnotate({
        x: Math.round(x * 10) / 10,
        y: Math.round(y * 10) / 10,
        content: content.trim(),
        page: currentPage,
        element_info: elementInfo && elementInfo.found ? elementInfo : undefined
      });
    }
  };

  // Only show pins for annotations on the currently displayed page
  const visibleAnnotations = annotations.filter(a => normalizePage(a.page) === currentPage);

  return (
    <div className="preview-iframe-wrapper" ref={containerRef} onClick={handleClick}>
      <iframe
        ref={iframeRef}
        key={iframeKey}
        src={previewUrl}
        className="preview-iframe"
        title="Prototype Preview"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      />
      {/* Transparent overlay - sits on top of iframe, same size */}
      <div
        className={`annotation-overlay ${annotateMode ? 'mode-annotate' : ''}`}
        style={{ pointerEvents: annotateMode ? 'auto' : 'none' }}
      >
        {visibleAnnotations.map((ann, idx) => {
          const statusClass = ann.status === 'resolved' ? 'resolved' : ann.status === 'rejected' ? 'rejected' : '';
          const pinColor = ann.status === 'resolved' ? '#16a34a' : ann.status === 'rejected' ? '#94a3b8' : '#f97316';
          return (
            <div
              key={ann.id}
              className={`annotation-pin ${statusClass} ${activeAnnotationId === ann.id ? 'active' : ''}`}
              style={{
                left: `${ann.x}%`,
                top: `${ann.y}%`,
                pointerEvents: 'auto',
                // Offset by iframe scroll so the anchor follows the page content
                transform: `translate(-50%, -100%) translate(${-scrollPos.x}px, ${-scrollPos.y}px)`
              }}
              onClick={(e) => {
                e.stopPropagation();
                onAnnotationClick?.(ann);
              }}
            >
              <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path
                  d="M12 0C7.58 0 4 3.58 4 8c0 5.25 8 16 8 16s8-10.75 8-16c0-4.42-3.58-8-8-8z"
                  fill={pinColor}
                />
                <circle cx="12" cy="8" r="3.5" fill="white" />
              </svg>
              <span className="annotation-pin-number" style={{ color: pinColor }}>
                {idx + 1}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
