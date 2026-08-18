import { useRef, useState, useEffect, useCallback, useMemo } from 'react';
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
 * Element anchoring: when an annotation is created, the iframe probe also
 * records the DOM element under the click point (tag/id/class/path/rect). On
 * every scroll, the parent asks the iframe for the current bounding rect of
 * that element and repositions the pin so it stays glued to the corresponding
 * content. If the element scrolls out of view, the pin fades out.
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
  const pendingQueryRef = useRef(null);
  const rafRef = useRef(null);

  const [iframeKey, setIframeKey] = useState(0);
  const [scrollPos, setScrollPos] = useState({ x: 0, y: 0 });
  const [currentPage, setCurrentPage] = useState('index.html');
  // Map annotation id -> latest __protoElementPos result for that element
  const [elementPositions, setElementPositions] = useState({});

  // Construct preview URL - use relative path so it works in both dev and prod
  const previewUrl = `${API_BASE}/projects/${projectId}/preview/`;

  // Reload iframe when version changes, reset scroll offset and cached positions
  useEffect(() => {
    setIframeKey(k => k + 1);
    setScrollPos({ x: 0, y: 0 });
    setCurrentPage('index.html');
    setElementPositions({});
  }, [version]);

  // Only show pins for annotations on the currently displayed page
  const visibleAnnotations = useMemo(() => {
    return annotations.filter(a => normalizePage(a.page) === currentPage);
  }, [annotations, currentPage]);

  const visibleAnnotationIds = useMemo(() => {
    return visibleAnnotations.map(a => a.id).join(',');
  }, [visibleAnnotations]);

  // Ask the iframe for the current position of every anchored annotation.
  const queryElementPositions = useCallback(() => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;

    const targets = visibleAnnotations
      .filter(ann => ann.element_info?.found && ann.element_info?.path)
      .map(ann => ({
        __protoQuery: 1,
        id: ann.id,
        elementId: ann.element_info.id || '',
        path: ann.element_info.path,
        text: (ann.element_info.text || '').slice(0, 120)
      }));

    if (targets.length === 0) return;

    targets.forEach(t => {
      try {
        win.postMessage(t, '*');
      } catch (_) {
        // iframe may have navigated away; ignore
      }
    });
  }, [visibleAnnotations]);

  // Throttle element position queries so rapid scroll events don't flood the iframe.
  const scheduleElementQuery = useCallback(() => {
    if (pendingQueryRef.current) return;
    pendingQueryRef.current = setTimeout(() => {
      pendingQueryRef.current = null;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        queryElementPositions();
        rafRef.current = null;
      });
    }, 100);
  }, [queryElementPositions]);

  // Listen for scroll position reports, page-navigation reports, element
  // probe responses, and element position query responses from the iframe.
  const handleScrollMessage = useCallback((e) => {
    const d = e.data;
    if (!d) return;
    if (d.__protoScroll) {
      setScrollPos({
        x: typeof d.x === 'number' ? d.x : 0,
        y: typeof d.y === 'number' ? d.y : 0
      });
      // Re-anchor pins after scrolling. The iframe reports scroll position
      // frequently, so throttle the DOM queries.
      scheduleElementQuery();
    } else if (d.__protoNav) {
      const page = pageFromPath(d.path);
      setCurrentPage(page);
      // New page starts at scroll 0; discard stale offset and positions
      setScrollPos({ x: 0, y: 0 });
      setElementPositions({});
      onPageChange?.(page);
      scheduleElementQuery();
    } else if (d.__protoElement) {
      // store element probe result keyed by request id
      probeRef.current.results[d.id] = d;
    } else if (d.__protoElementPos) {
      // store latest bounding rect for this annotation's anchor element
      setElementPositions(prev => ({ ...prev, [d.id]: d.found ? d : null }));
    }
  }, [onPageChange, scheduleElementQuery]);

  useEffect(() => {
    window.addEventListener('message', handleScrollMessage);
    return () => window.removeEventListener('message', handleScrollMessage);
  }, [handleScrollMessage]);

  // When the page or the visible annotation list changes, refresh element positions
  // once the new iframe page has had time to render.
  useEffect(() => {
    const t = setTimeout(() => scheduleElementQuery(), 300);
    return () => clearTimeout(t);
  }, [currentPage, visibleAnnotationIds, scheduleElementQuery]);

  // Clean up timers and rAF on unmount
  useEffect(() => {
    return () => {
      if (pendingQueryRef.current) clearTimeout(pendingQueryRef.current);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

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

  // Compute pin style for an annotation.
  // Prefer element-based anchoring; fall back to legacy percentage + scroll offset.
  const getPinStyle = (ann) => {
    const pos = elementPositions[ann.id];
    const hasElement = ann.element_info?.found && pos?.found;

    if (hasElement) {
      const container = containerRef.current;
      if (!container) {
        return { left: `${ann.x}%`, top: `${ann.y}%`, transform: 'translate(-50%, -100%)', opacity: 0 };
      }

      const containerRect = container.getBoundingClientRect();
      const rect = pos.rect;
      const offsetX = typeof ann.element_info.offsetX === 'number' ? ann.element_info.offsetX : 0.5;
      const offsetY = typeof ann.element_info.offsetY === 'number' ? ann.element_info.offsetY : 0;

      // Pin tip sits at the anchor point inside the element
      const x = rect.left + rect.width * offsetX;
      const y = rect.top + rect.height * offsetY;

      const leftPct = (x / containerRect.width) * 100;
      const topPct = (y / containerRect.height) * 100;

      // Hide the pin if its anchor point is well outside the visible viewport
      // (kept in DOM so it can reappear smoothly when scrolled back).
      const buffer = 32;
      const inViewport = y >= -buffer && y <= containerRect.height + buffer
        && x >= -buffer && x <= containerRect.width + buffer;

      return {
        left: `${leftPct}%`,
        top: `${topPct}%`,
        transform: 'translate(-50%, -100%)',
        opacity: inViewport ? 1 : 0,
        pointerEvents: inViewport ? 'auto' : 'none',
        transition: 'opacity 0.15s ease, top 0.1s ease-out, left 0.1s ease-out'
      };
    }

    // Legacy fallback: annotations created before element anchoring
    return {
      left: `${ann.x}%`,
      top: `${ann.y}%`,
      transform: `translate(-50%, -100%) translate(${-scrollPos.x}px, ${-scrollPos.y}px)`,
      opacity: 1,
      pointerEvents: 'auto',
      transition: 'opacity 0.15s ease'
    };
  };

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
          const style = getPinStyle(ann);
          return (
            <div
              key={ann.id}
              className={`annotation-pin ${statusClass} ${activeAnnotationId === ann.id ? 'active' : ''}`}
              style={style}
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
