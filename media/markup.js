/* PDFDisplay markup tools. Talks to the webview via window.__pdfDisplay. */
(function () {
    const SWATCHES = ['#1c1c1e', '#c45c5c', '#3d5a80', '#4a7c59', '#f0d675', '#e8a0a0', '#8bb4d4', '#f4f1ea'];
    const PRESETS = {
        select: { color: '#1c1c1e', opacity: 1, width: 2 },
        highlight: { color: '#f0d675', opacity: 0.42, width: 2 },
        underline: { color: '#3d5a80', opacity: 0.95, width: 2 },
        strikeout: { color: '#c45c5c', opacity: 0.95, width: 2 },
        ink: { color: '#c45c5c', opacity: 1, width: 2.6 },
        pencil: { color: '#1c1c1e', opacity: 0.82, width: 1.45 },
        eraser: { color: '#1c1c1e', opacity: 1, width: 18 },
        sticky: { color: '#f0d675', opacity: 1, width: 2 },
        text: { color: '#1c1c1e', opacity: 1, width: 2 },
        rect: { color: '#3d5a80', opacity: 1, width: 2.2 },
        ellipse: { color: '#3d5a80', opacity: 1, width: 2.2 },
        arrow: { color: '#c45c5c', opacity: 1, width: 2.2 },
        signature: { color: '#1c1c1e', opacity: 1, width: 2 }
    };
    const TEXT_TOOLS = { highlight: 1, underline: 1, strikeout: 1 };
    const DRAW_TOOLS = { ink: 1, pencil: 1, eraser: 1, rect: 1, ellipse: 1, arrow: 1, sticky: 1, text: 1, signature: 1 };
    /* [tool, title, svg path contents] — simple 24-viewBox stroke icons */
    const ICONS = [
        ['select', 'Select (V)', '<path d="M4 4l7 16 2-7 7-2z"/>'],
        ['highlight', 'Highlight (H)', '<path d="M4 18h16"/><path d="M7 15l3-9h4l3 9"/><path d="M8.5 12h7"/>'],
        ['underline', 'Underline (U)', '<path d="M7 5v7a5 5 0 0 0 10 0V5"/><path d="M5 19h14"/>'],
        ['strikeout', 'Strikeout (K)', '<path d="M6 12h12"/><path d="M8 7h8a3 3 0 0 1 0 6H9a3 3 0 0 0 0 6h8"/>'],
        null,
        ['ink', 'Ink (D)', '<path d="M4 20l1.5-1.5 10-10 2 2-10 10L4 20z"/><path d="M14 7l2 2"/>'],
        ['pencil', 'Pencil (P)', '<path d="M12 19l7-7-3-3-7 7v3h3z"/><path d="M14 11l3 3"/>'],
        ['eraser', 'Eraser (E)', '<path d="M7 17l-3-3 8-8 5 5-8 8H7z"/><path d="M4 20h16"/>'],
        null,
        ['sticky', 'Sticky note (N)', '<path d="M6 4h9l5 5v11H6z"/><path d="M15 4v5h5"/>'],
        ['text', 'Text comment (T)', '<path d="M5 7h14"/><path d="M12 7v12"/><path d="M8 19h8"/>'],
        null,
        ['rect', 'Rectangle (R)', '<rect x="5" y="6" width="14" height="12" rx="1"/>'],
        ['ellipse', 'Circle (C)', '<circle cx="12" cy="12" r="7"/>'],
        ['arrow', 'Arrow (A)', '<path d="M5 19L19 5"/><path d="M10 5h9v9"/>'],
        ['signature', 'Signature (G)', '<path d="M4 16c2-4 3-4 5-2s3 3 5 1 3-5 6-4"/>']
    ];
    const HINTS = {
        select: 'Click a mark to select · drag to move · Backspace to delete',
        highlight: 'Drag across text to highlight',
        underline: 'Drag across text to underline',
        strikeout: 'Drag across text to strike',
        ink: 'Draw a stroke',
        pencil: 'Draw with a thinner pencil',
        eraser: 'Drag over ink or pencil to remove it',
        sticky: 'Click the page to pin a note',
        text: 'Click or drag to place a typed comment',
        rect: 'Click and drag a rectangle',
        ellipse: 'Click and drag a circle',
        arrow: 'Click and drag an arrow',
        signature: 'Click or drag to stamp your signature'
    };
    const KEYS = { v: 'select', h: 'highlight', u: 'underline', k: 'strikeout', d: 'ink', p: 'pencil', e: 'eraser', n: 'sticky', t: 'text', r: 'rect', c: 'ellipse', a: 'arrow', g: 'signature' };

    const state = {
        tool: 'select',
        color: PRESETS.highlight.color,
        opacity: PRESETS.highlight.opacity,
        width: 2.6,
        selectedId: null,
        editingId: null,
        history: [],
        future: [],
        signatureSrc: null,
        draft: null,
        drag: null
    };

    function host() {
        return window.__pdfDisplay || null;
    }

    function list() {
        const h = host();
        return h && Array.isArray(h.annotations) ? h.annotations : [];
    }

    function normalize(ann) {
        if (!ann || typeof ann !== 'object') return ann;
        if (ann.kind) return ann;
        return {
            kind: 'sticky',
            id: ann.id,
            pageNum: ann.pageNum,
            x: ann.xRatio,
            y: ann.yRatio,
            text: ann.text || '',
            color: '#f0d675',
            opacity: 1,
            createdAt: ann.createdAt
        };
    }

    function uid() {
        const h = host();
        if (h && typeof h.createAnnotationId === 'function') return h.createAnnotationId();
        return 'ann_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    }

    function snapshot() {
        state.history.push(JSON.parse(JSON.stringify(list())));
        if (state.history.length > 60) state.history.shift();
        state.future = [];
    }

    function commit(next) {
        const h = host();
        if (!h) return;
        if (typeof h.setAnnotations === 'function') h.setAnnotations(next);
        else {
            h.annotations.splice(0, h.annotations.length, ...next);
            if (typeof h.persistAnnotations === 'function') h.persistAnnotations();
        }
        renderAll();
    }

    function undo() {
        if (!state.history.length) return;
        state.future.unshift(JSON.parse(JSON.stringify(list())));
        commit(state.history.pop());
    }

    function redo() {
        if (!state.future.length) return;
        state.history.push(JSON.parse(JSON.stringify(list())));
        commit(state.future.shift());
    }

    function clamp01(n) {
        return Math.min(1, Math.max(0, n));
    }

    function toPage(ev, pageEl) {
        const r = pageEl.getBoundingClientRect();
        return { x: clamp01((ev.clientX - r.left) / r.width), y: clamp01((ev.clientY - r.top) / r.height) };
    }

    function dist(a, b) {
        return Math.hypot(a.x - b.x, a.y - b.y);
    }

    function distSeg(p, a, b) {
        const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
        if (!l2) return dist(p, a);
        let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
        t = Math.max(0, Math.min(1, t));
        return dist(p, { x: a.x + t * dx, y: a.y + t * dy });
    }

    function hit(ann, p, pageW) {
        const a = normalize(ann);
        const pad = 8 / Math.max(pageW, 1);
        switch (a.kind) {
            case 'highlight':
            case 'underline':
            case 'strikeout':
                return (a.rects || []).some(function (r) {
                    return p.x >= r.x - pad && p.x <= r.x + r.w + pad && p.y >= r.y - pad && p.y <= r.y + r.h + pad;
                });
            case 'ink':
            case 'pencil': {
                const pts = a.points || [];
                const tol = Math.max((a.width || 2) / pageW, 0.012);
                for (let i = 1; i < pts.length; i++) if (distSeg(p, pts[i - 1], pts[i]) <= tol) return true;
                return false;
            }
            case 'sticky':
                return p.x >= a.x && p.x <= a.x + 0.22 && p.y >= a.y && p.y <= a.y + 0.16;
            case 'text':
            case 'rect':
            case 'ellipse':
            case 'signature':
                return p.x >= a.x - pad && p.x <= a.x + (a.w || 0) + pad && p.y >= a.y - pad && p.y <= a.y + (a.h || 0) + pad;
            case 'arrow':
                return distSeg(p, { x: a.x1, y: a.y1 }, { x: a.x2, y: a.y2 }) <= 0.02;
            default:
                return false;
        }
    }

    function translate(ann, dx, dy) {
        const a = JSON.parse(JSON.stringify(normalize(ann)));
        a.id = ann.id;
        function c(n) { return clamp01(n); }
        switch (a.kind) {
            case 'highlight':
            case 'underline':
            case 'strikeout':
                a.rects = (a.rects || []).map(function (r) { return { x: c(r.x + dx), y: c(r.y + dy), w: r.w, h: r.h }; });
                break;
            case 'ink':
            case 'pencil':
                a.points = (a.points || []).map(function (pt) { return { x: c(pt.x + dx), y: c(pt.y + dy) }; });
                break;
            case 'sticky':
                a.x = c(a.x + dx); a.y = c(a.y + dy);
                a.xRatio = a.x; a.yRatio = a.y;
                break;
            case 'text':
            case 'rect':
            case 'ellipse':
            case 'signature':
                a.x = c(a.x + dx); a.y = c(a.y + dy);
                break;
            case 'arrow':
                a.x1 = c(a.x1 + dx); a.y1 = c(a.y1 + dy); a.x2 = c(a.x2 + dx); a.y2 = c(a.y2 + dy);
                break;
        }
        return a;
    }

    function strokeHits(points, eraserPts, radius) {
        for (let i = 0; i < eraserPts.length; i++) {
            const e = eraserPts[i];
            for (let j = 1; j < points.length; j++) {
                if (distSeg(e, points[j - 1], points[j]) <= radius) return true;
            }
        }
        return false;
    }

    function simplify(points) {
        if (points.length < 3) return points;
        const out = [points[0]];
        for (let i = 1; i < points.length - 1; i++) {
            if (dist(out[out.length - 1], points[i]) >= 0.002) out.push(points[i]);
        }
        out.push(points[points.length - 1]);
        return out;
    }

    function normRect(x0, y0, x1, y1) {
        return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
    }

    function arrowHead(x1, y1, x2, y2) {
        const angle = Math.atan2(y2 - y1, x2 - x1);
        const size = 0.018;
        const a = angle + Math.PI * 0.82;
        const b = angle - Math.PI * 0.82;
        return x2 + ',' + y2 + ' ' + (x2 + Math.cos(a) * size) + ',' + (y2 + Math.sin(a) * size) + ' ' + (x2 + Math.cos(b) * size) + ',' + (y2 + Math.sin(b) * size);
    }

    function captureMarkup(pageEl, pageNum, kind) {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) return null;
        const pageRect = pageEl.getBoundingClientRect();
        const rects = [];
        for (let i = 0; i < sel.rangeCount; i++) {
            const range = sel.getRangeAt(i);
            const list = range.getClientRects();
            for (let j = 0; j < list.length; j++) {
                const r = list[j];
                if (r.bottom < pageRect.top || r.top > pageRect.bottom) continue;
                const x = (r.left - pageRect.left) / pageRect.width;
                const y = (r.top - pageRect.top) / pageRect.height;
                const w = r.width / pageRect.width;
                const h = r.height / pageRect.height;
                if (w < 0.004 || h < 0.004) continue;
                rects.push({ x: x, y: y, w: w, h: h });
            }
        }
        const quote = sel.toString().replace(/\s+/g, ' ').trim();
        sel.removeAllRanges();
        if (!rects.length) return null;
        return {
            id: uid(),
            kind: kind,
            pageNum: pageNum,
            rects: rects,
            quote: quote,
            color: state.color,
            opacity: state.opacity,
            createdAt: Date.now()
        };
    }

    function svgFor(pageAnns, draft) {
        const ns = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('viewBox', '0 0 1 1');
        svg.setAttribute('preserveAspectRatio', 'none');
        function strokePx(width) {
            // vector-effect:non-scaling-stroke uses CSS pixels, not viewBox units
            return String(Math.max(1.25, Number(width) || 2));
        }
        function addPath(pts, color, opacity, width) {
            if (!pts || pts.length < 2) return;
            const p = document.createElementNS(ns, 'path');
            let d = '';
            for (let i = 0; i < pts.length; i++) d += (i ? ' L ' : 'M ') + pts[i].x + ' ' + pts[i].y;
            p.setAttribute('d', d);
            p.setAttribute('fill', 'none');
            p.setAttribute('stroke', color);
            p.setAttribute('stroke-opacity', String(opacity == null ? 1 : opacity));
            p.setAttribute('stroke-width', strokePx(width));
            p.setAttribute('stroke-linecap', 'round');
            p.setAttribute('stroke-linejoin', 'round');
            p.setAttribute('vector-effect', 'non-scaling-stroke');
            svg.appendChild(p);
        }
        pageAnns.forEach(function (raw) {
            const a = normalize(raw);
            if (a.kind === 'highlight') {
                (a.rects || []).forEach(function (r) {
                    const el = document.createElementNS(ns, 'rect');
                    el.setAttribute('x', r.x); el.setAttribute('y', r.y);
                    el.setAttribute('width', r.w); el.setAttribute('height', r.h);
                    el.setAttribute('fill', a.color);
                    el.setAttribute('opacity', String(a.opacity));
                    svg.appendChild(el);
                });
            } else if (a.kind === 'underline' || a.kind === 'strikeout') {
                (a.rects || []).forEach(function (r) {
                    const y = a.kind === 'underline' ? r.y + r.h * 0.88 : r.y + r.h * 0.5;
                    const el = document.createElementNS(ns, 'line');
                    el.setAttribute('x1', r.x); el.setAttribute('x2', r.x + r.w);
                    el.setAttribute('y1', y); el.setAttribute('y2', y);
                    el.setAttribute('stroke', a.color);
                    el.setAttribute('stroke-opacity', String(a.opacity));
                    el.setAttribute('stroke-width', String(Math.max(0.004, r.h * 0.12)));
                    el.setAttribute('stroke-linecap', 'round');
                    svg.appendChild(el);
                });
            } else if (a.kind === 'ink' || a.kind === 'pencil') {
                addPath(a.points, a.color, a.opacity, a.width || 2);
            } else if (a.kind === 'rect') {
                const el = document.createElementNS(ns, 'rect');
                el.setAttribute('x', a.x); el.setAttribute('y', a.y);
                el.setAttribute('width', Math.max(a.w || 0, 0.001)); el.setAttribute('height', Math.max(a.h || 0, 0.001));
                el.setAttribute('fill', 'none');
                el.setAttribute('stroke', a.color || '#3d5a80');
                el.setAttribute('stroke-opacity', String(a.opacity == null ? 1 : a.opacity));
                el.setAttribute('stroke-width', strokePx(a.width));
                el.setAttribute('vector-effect', 'non-scaling-stroke');
                svg.appendChild(el);
            } else if (a.kind === 'ellipse') {
                const el = document.createElementNS(ns, 'ellipse');
                el.setAttribute('cx', a.x + a.w / 2); el.setAttribute('cy', a.y + a.h / 2);
                el.setAttribute('rx', Math.max(a.w / 2, 0.001)); el.setAttribute('ry', Math.max(a.h / 2, 0.001));
                el.setAttribute('fill', 'none');
                el.setAttribute('stroke', a.color || '#3d5a80');
                el.setAttribute('stroke-opacity', String(a.opacity == null ? 1 : a.opacity));
                el.setAttribute('stroke-width', strokePx(a.width));
                el.setAttribute('vector-effect', 'non-scaling-stroke');
                svg.appendChild(el);
            } else if (a.kind === 'arrow') {
                const line = document.createElementNS(ns, 'line');
                line.setAttribute('x1', a.x1); line.setAttribute('y1', a.y1);
                line.setAttribute('x2', a.x2); line.setAttribute('y2', a.y2);
                line.setAttribute('stroke', a.color || '#c45c5c');
                line.setAttribute('stroke-opacity', String(a.opacity == null ? 1 : a.opacity));
                line.setAttribute('stroke-width', strokePx(a.width));
                line.setAttribute('stroke-linecap', 'round');
                line.setAttribute('vector-effect', 'non-scaling-stroke');
                svg.appendChild(line);
                const poly = document.createElementNS(ns, 'polygon');
                poly.setAttribute('points', arrowHead(a.x1, a.y1, a.x2, a.y2));
                poly.setAttribute('fill', a.color || '#c45c5c');
                poly.setAttribute('fill-opacity', String(a.opacity == null ? 1 : a.opacity));
                svg.appendChild(poly);
            }
        });
        if (draft) {
            if (draft.kind === 'ink' || draft.kind === 'pencil') addPath(draft.points, state.color, state.opacity, state.width);
            if (draft.kind === 'rect' || draft.kind === 'box') {
                const el = document.createElementNS(ns, 'rect');
                el.setAttribute('x', draft.x); el.setAttribute('y', draft.y);
                el.setAttribute('width', Math.max(draft.w || 0, 0.001)); el.setAttribute('height', Math.max(draft.h || 0, 0.001));
                el.setAttribute('fill', draft.kind === 'box' ? 'rgba(200,204,212,0.08)' : 'none');
                el.setAttribute('stroke', state.color);
                el.setAttribute('stroke-opacity', String(state.opacity));
                el.setAttribute('stroke-width', strokePx(state.width));
                el.setAttribute('vector-effect', 'non-scaling-stroke');
                svg.appendChild(el);
            }
            if (draft.kind === 'ellipse') {
                const el = document.createElementNS(ns, 'ellipse');
                el.setAttribute('cx', draft.x + draft.w / 2); el.setAttribute('cy', draft.y + draft.h / 2);
                el.setAttribute('rx', Math.max(draft.w / 2, 0.001)); el.setAttribute('ry', Math.max(draft.h / 2, 0.001));
                el.setAttribute('fill', 'none');
                el.setAttribute('stroke', state.color);
                el.setAttribute('stroke-opacity', String(state.opacity));
                el.setAttribute('stroke-width', strokePx(state.width));
                el.setAttribute('vector-effect', 'non-scaling-stroke');
                svg.appendChild(el);
            }
            if (draft.kind === 'arrow') {
                const line = document.createElementNS(ns, 'line');
                line.setAttribute('x1', draft.x1); line.setAttribute('y1', draft.y1);
                line.setAttribute('x2', draft.x2); line.setAttribute('y2', draft.y2);
                line.setAttribute('stroke', state.color);
                line.setAttribute('stroke-opacity', String(state.opacity));
                line.setAttribute('stroke-width', strokePx(state.width));
                line.setAttribute('stroke-linecap', 'round');
                line.setAttribute('vector-effect', 'non-scaling-stroke');
                svg.appendChild(line);
            }
            if (draft.kind === 'eraser') {
                const c = document.createElementNS(ns, 'circle');
                c.setAttribute('cx', draft.x); c.setAttribute('cy', draft.y);
                c.setAttribute('r', '0.02');
                c.setAttribute('fill', 'none');
                c.setAttribute('stroke', 'currentColor');
                c.setAttribute('stroke-width', '0.004');
                svg.appendChild(c);
            }
        }
        return svg;
    }

    function updateDraftSvg(pageEl, pageNum) {
        const layer = pageEl.querySelector('.markup-layer');
        if (!layer) {
            renderPage(pageEl, pageNum);
            return;
        }
        const anns = list().filter(function (a) { return Number(a.pageNum) === Number(pageNum); });
        const existingSvg = layer.querySelector('svg');
        const nextSvg = svgFor(anns, state.drag && Number(state.drag.pageNum) === Number(pageNum) ? state.draft : null);
        if (existingSvg) layer.replaceChild(nextSvg, existingSvg);
        else layer.insertBefore(nextSvg, layer.firstChild);
    }

    function renderPage(pageEl, pageNum) {
        const anns = list().filter(function (a) { return Number(a.pageNum) === Number(pageNum); });
        let layer = pageEl.querySelector('.markup-layer');
        if (!layer) {
            layer = document.createElement('div');
            layer.className = 'markup-layer';
            pageEl.appendChild(layer);
        }
        layer.innerHTML = '';
        const oldPin = pageEl.querySelector('.annotation-layer');
        if (oldPin) oldPin.remove();
        layer.appendChild(svgFor(anns, state.drag && Number(state.drag.pageNum) === Number(pageNum) ? state.draft : null));

        anns.forEach(function (raw) {
            const a = normalize(raw);
            if (a.kind === 'sticky') {
                const el = document.createElement('div');
                el.className = 'markup-note' + (state.selectedId === a.id ? ' selected' : '');
                el.style.left = (a.x * 100) + '%';
                el.style.top = (a.y * 100) + '%';
                el.style.background = a.color || '#f0d675';
                if (state.editingId === a.id) {
                    const ta = document.createElement('textarea');
                    ta.value = a.text || '';
                    ta.placeholder = 'Write a note';
                    ta.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
                    ta.addEventListener('input', function () {
                        raw.text = ta.value;
                        raw.kind = 'sticky';
                        const h = host();
                        if (h && typeof h.persistAnnotations === 'function') h.persistAnnotations();
                    });
                    ta.addEventListener('blur', function () {
                        if (!String(raw.text || '').trim()) remove(raw.id);
                        state.editingId = null;
                    });
                    el.appendChild(ta);
                    setTimeout(function () { ta.focus(); }, 0);
                } else {
                    const p = document.createElement('p');
                    p.textContent = a.text || 'Note';
                    el.appendChild(p);
                }
                layer.appendChild(el);
            } else if (a.kind === 'text') {
                const el = document.createElement('div');
                el.className = 'markup-text' + (state.selectedId === a.id ? ' selected' : '');
                el.style.left = (a.x * 100) + '%';
                el.style.top = (a.y * 100) + '%';
                el.style.width = (Math.max(a.w || 0.12, 0.12) * 100) + '%';
                el.style.color = a.color;
                el.style.fontSize = (a.fontSize || 14) + 'px';
                el.style.opacity = String(a.opacity || 1);
                if (state.editingId === a.id) {
                    const ta = document.createElement('textarea');
                    ta.value = a.text || '';
                    ta.placeholder = 'Comment';
                    ta.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
                    ta.addEventListener('input', function () {
                        raw.text = ta.value;
                        const h = host();
                        if (h && typeof h.persistAnnotations === 'function') h.persistAnnotations();
                    });
                    ta.addEventListener('blur', function () {
                        if (!String(raw.text || '').trim()) remove(raw.id);
                        state.editingId = null;
                    });
                    el.appendChild(ta);
                    setTimeout(function () { ta.focus(); }, 0);
                } else {
                    const p = document.createElement('p');
                    p.textContent = a.text || '';
                    el.appendChild(p);
                }
                layer.appendChild(el);
            } else if (a.kind === 'signature' && a.src) {
                const img = document.createElement('img');
                img.className = 'markup-sign' + (state.selectedId === a.id ? ' selected' : '');
                img.src = a.src;
                img.alt = '';
                img.draggable = false;
                img.style.left = (a.x * 100) + '%';
                img.style.top = (a.y * 100) + '%';
                img.style.width = ((a.w || 0.28) * 100) + '%';
                img.style.height = ((a.h || 0.1) * 100) + '%';
                layer.appendChild(img);
            }
        });

        let catcher = pageEl.querySelector('.markup-catcher');
        if (!catcher) {
            catcher = document.createElement('div');
            catcher.className = 'markup-catcher';
            bindCatcher(catcher, pageEl);
        }
        // Always last so, when active, it sits above text/link layers
        pageEl.appendChild(catcher);
        // Select + text-markup tools must NOT cover the page — otherwise the
        // normal cursor and text selection (Define / Translate) never work.
        const isTextTool = !!TEXT_TOOLS[state.tool];
        const isDrawTool = !!DRAW_TOOLS[state.tool];
        const catcherActive = isDrawTool;
        catcher.classList.toggle('is-text', isTextTool || state.tool === 'select');
        catcher.classList.toggle('is-draw', catcherActive);
        catcher.style.pointerEvents = catcherActive ? 'auto' : 'none';
        catcher.style.cursor = catcherActive ? 'crosshair' : 'default';
        document.body.classList.toggle('markup-drawing', catcherActive);
        pageEl.querySelectorAll('.link-layer').forEach(function (el) {
            el.style.pointerEvents = catcherActive ? 'none' : '';
        });
        pageEl.querySelectorAll('.markup-note, .markup-text').forEach(function (el) {
            el.style.pointerEvents = state.tool === 'select' ? 'auto' : 'none';
        });
        pageEl.querySelectorAll('.markup-note textarea, .markup-text textarea').forEach(function (el) {
            el.style.pointerEvents = 'auto';
        });
    }

    let hintTimer = null;
    function showHint(text) {
        const hint = document.getElementById('markup-hint');
        if (!hint) return;
        hint.textContent = text || '';
        if (!text) {
            hint.classList.remove('visible');
            return;
        }
        hint.classList.add('visible');
        clearTimeout(hintTimer);
        hintTimer = setTimeout(function () { hint.classList.remove('visible'); }, 2800);
    }

    function renderAll() {
        document.querySelectorAll('.page-container').forEach(function (pageEl) {
            const n = Number(pageEl.dataset.pageNumber);
            if (n) renderPage(pageEl, n);
        });
        syncBar();
    }

    function remove(id) {
        snapshot();
        commit(list().filter(function (a) { return a.id !== id; }));
        state.selectedId = null;
        state.editingId = null;
    }

    function bindCatcher(catcher, pageEl) {
        catcher.addEventListener('pointerdown', function (e) {
            if (e.button !== 0) return;
            if (TEXT_TOOLS[state.tool]) return;
            e.preventDefault();
            e.stopPropagation();
            const pageNum = Number(pageEl.dataset.pageNumber);
            const p = toPage(e, pageEl);
            if (state.tool === 'select') {
                const hits = list().filter(function (a) { return Number(a.pageNum) === pageNum && hit(a, p, pageEl.clientWidth); });
                const found = hits[hits.length - 1];
                if (found) {
                    state.selectedId = found.id;
                    const n = normalize(found);
                    if (n.kind === 'sticky' || n.kind === 'text') state.editingId = found.id;
                    state.drag = { tool: 'select', start: p, last: p, points: [p], moved: false, pageNum: pageNum, annId: found.id };
                    try { catcher.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
                    renderPage(pageEl, pageNum);
                } else {
                    state.selectedId = null;
                    state.editingId = null;
                    renderPage(pageEl, pageNum);
                }
                return;
            }
            if (state.tool === 'signature' && !state.signatureSrc) {
                openSig();
                return;
            }
            state.drag = { tool: state.tool, start: p, last: p, points: [p], moved: false, pageNum: pageNum, annId: null };
            try { catcher.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
            if (state.tool === 'ink' || state.tool === 'pencil') state.draft = { kind: state.tool, points: [p] };
            else if (state.tool === 'eraser') state.draft = { kind: 'eraser', x: p.x, y: p.y };
            else if (state.tool === 'rect' || state.tool === 'ellipse') state.draft = { kind: state.tool, x: p.x, y: p.y, w: 0, h: 0 };
            else if (state.tool === 'arrow') state.draft = { kind: 'arrow', x1: p.x, y1: p.y, x2: p.x, y2: p.y };
            else if (state.tool === 'text' || state.tool === 'signature') state.draft = { kind: 'box', x: p.x, y: p.y, w: 0, h: 0 };
            else if (state.tool === 'sticky') state.draft = null;
            // Live preview without rebuilding the catcher / rebinding listeners
            updateDraftSvg(pageEl, pageNum);
        });

        catcher.addEventListener('pointermove', function (e) {
            const drag = state.drag;
            if (!drag) return;
            e.preventDefault();
            const p = toPage(e, pageEl);
            if (dist(p, drag.start) > 0.004) drag.moved = true;
            const dx = p.x - drag.last.x, dy = p.y - drag.last.y;
            drag.last = p;
            drag.points.push(p);
            if (drag.tool === 'select' && drag.annId) {
                const next = list().map(function (a) { return a.id === drag.annId ? translate(a, dx, dy) : a; });
                const h = host();
                if (h) {
                    if (typeof h.setAnnotations === 'function') h.setAnnotations(next, true);
                    else if (Array.isArray(h.annotations)) {
                        h.annotations.splice(0, h.annotations.length, ...next);
                    }
                }
                updateDraftSvg(pageEl, drag.pageNum);
                return;
            }
            if (drag.tool === 'ink' || drag.tool === 'pencil') state.draft = { kind: drag.tool, points: drag.points.slice() };
            else if (drag.tool === 'eraser') state.draft = { kind: 'eraser', x: p.x, y: p.y };
            else if (drag.tool === 'rect' || drag.tool === 'ellipse') state.draft = Object.assign({ kind: drag.tool }, normRect(drag.start.x, drag.start.y, p.x, p.y));
            else if (drag.tool === 'arrow') state.draft = { kind: 'arrow', x1: drag.start.x, y1: drag.start.y, x2: p.x, y2: p.y };
            else if (drag.tool === 'text' || drag.tool === 'signature' || drag.tool === 'sticky') state.draft = Object.assign({ kind: 'box' }, normRect(drag.start.x, drag.start.y, p.x, p.y));
            updateDraftSvg(pageEl, drag.pageNum);
        });

        catcher.addEventListener('pointerup', function (e) {
            const drag = state.drag;
            state.drag = null;
            const draft = state.draft;
            state.draft = null;
            const pageNum = Number(pageEl.dataset.pageNumber);
            if (!drag) return;
            const p = toPage(e, pageEl);
            if (drag.tool === 'select') {
                const h = host();
                if (h && typeof h.persistAnnotations === 'function') h.persistAnnotations();
                renderPage(pageEl, pageNum);
                return;
            }
            if (drag.tool === 'eraser') {
                const radius = Math.max(0.012, state.width / 900);
                const next = list().filter(function (raw) {
                    const a = normalize(raw);
                    if (a.pageNum !== pageNum) return true;
                    if (a.kind === 'ink' || a.kind === 'pencil') return !strokeHits(a.points || [], drag.points, radius);
                    return true;
                });
                if (next.length !== list().length) {
                    snapshot();
                    commit(next);
                } else renderPage(pageEl, pageNum);
                return;
            }
            if (drag.tool === 'ink' || drag.tool === 'pencil') {
                const pts = simplify(drag.points);
                if (pts.length < 2) { renderPage(pageEl, pageNum); return; }
                snapshot();
                commit(list().concat([{
                    id: uid(), kind: drag.tool, pageNum: pageNum, points: pts,
                    width: state.width, color: state.color, opacity: state.opacity, createdAt: Date.now()
                }]));
                return;
            }
            if (drag.tool === 'rect' || drag.tool === 'ellipse') {
                const r = normRect(drag.start.x, drag.start.y, p.x, p.y);
                if (r.w < 0.01 && r.h < 0.01) { renderPage(pageEl, pageNum); return; }
                snapshot();
                commit(list().concat([{
                    id: uid(), kind: drag.tool, pageNum: pageNum, x: r.x, y: r.y, w: r.w, h: r.h,
                    width: state.width, color: state.color, opacity: state.opacity, createdAt: Date.now()
                }]));
                return;
            }
            if (drag.tool === 'arrow') {
                if (dist(p, drag.start) < 0.01) { renderPage(pageEl, pageNum); return; }
                snapshot();
                commit(list().concat([{
                    id: uid(), kind: 'arrow', pageNum: pageNum,
                    x1: drag.start.x, y1: drag.start.y, x2: p.x, y2: p.y,
                    width: state.width, color: state.color, opacity: state.opacity, createdAt: Date.now()
                }]));
                return;
            }
            if (drag.tool === 'sticky') {
                snapshot();
                const id = uid();
                state.selectedId = id;
                state.editingId = id;
                commit(list().concat([{
                    id: id, kind: 'sticky', pageNum: pageNum, x: drag.start.x, y: drag.start.y,
                    xRatio: drag.start.x, yRatio: drag.start.y, text: '',
                    color: state.color, opacity: 1, createdAt: Date.now()
                }]));
                return;
            }
            if (drag.tool === 'text') {
                const r = drag.moved ? normRect(drag.start.x, drag.start.y, p.x, p.y) : { x: drag.start.x, y: drag.start.y, w: 0.28, h: 0.06 };
                snapshot();
                const id = uid();
                state.selectedId = id;
                state.editingId = id;
                commit(list().concat([{
                    id: id, kind: 'text', pageNum: pageNum, x: r.x, y: r.y, w: r.w, h: r.h,
                    text: '', fontSize: 14, color: state.color, opacity: state.opacity, createdAt: Date.now()
                }]));
                return;
            }
            if (drag.tool === 'signature' && state.signatureSrc) {
                const r = drag.moved ? normRect(drag.start.x, drag.start.y, p.x, p.y) : { x: drag.start.x, y: drag.start.y, w: 0.28, h: 0.1 };
                snapshot();
                commit(list().concat([{
                    id: uid(), kind: 'signature', pageNum: pageNum, x: r.x, y: r.y, w: Math.max(r.w, 0.12), h: Math.max(r.h, 0.05),
                    src: state.signatureSrc, color: state.color, opacity: 1, createdAt: Date.now()
                }]));
                return;
            }
            void draft;
            renderPage(pageEl, pageNum);
        });

        pageEl.addEventListener('pointerup', function () {
            if (!TEXT_TOOLS[state.tool]) return;
            const pageNum = Number(pageEl.dataset.pageNumber);
            setTimeout(function () {
                const ann = captureMarkup(pageEl, pageNum, state.tool);
                if (ann) {
                    snapshot();
                    commit(list().concat([ann]));
                }
            }, 0);
        });
    }

    function setTool(tool) {
        state.tool = tool || 'select';
        // Cancel any in-progress stroke when switching tools
        state.drag = null;
        state.draft = null;
        const preset = PRESETS[state.tool];
        if (preset) {
            state.color = preset.color;
            state.opacity = preset.opacity;
            state.width = preset.width;
        }
        if (state.tool !== 'select') {
            state.selectedId = null;
            state.editingId = null;
        }
        if (state.tool === 'signature' && !state.signatureSrc) openSig();
        renderAll();
        showHint(HINTS[state.tool] || '');
        const h = host();
        const container = h && h.container;
        if (container) {
            // Crosshair only while actively drawing/placing — not on Select
            container.classList.toggle('annotate-cursor', !!DRAW_TOOLS[state.tool]);
            container.style.cursor = '';
        }
        document.body.classList.toggle('markup-drawing', !!DRAW_TOOLS[state.tool]);
        const stickyBtn = document.getElementById('toggle-annotate');
        if (stickyBtn) stickyBtn.classList.toggle('active', state.tool === 'sticky');
    }

    function syncBar() {
        document.querySelectorAll('#markup-bar .mk-btn[data-tool]').forEach(function (btn) {
            btn.classList.toggle('active', btn.getAttribute('data-tool') === state.tool);
        });
        document.querySelectorAll('#markup-bar .mk-swatch').forEach(function (btn) {
            btn.classList.toggle('active', btn.getAttribute('data-color') === state.color);
        });
        const colorInput = document.getElementById('mk-color');
        if (colorInput) colorInput.value = state.color;
        const op = document.getElementById('mk-opacity');
        if (op) op.value = String(state.opacity);
        const opVal = document.getElementById('mk-opacity-val');
        if (opVal) opVal.textContent = Math.round(state.opacity * 100) + '%';
        const w = document.getElementById('mk-width');
        if (w) w.value = String(state.width);
        const wVal = document.getElementById('mk-width-val');
        if (wVal) wVal.textContent = Number(state.width).toFixed(1);
    }

    function iconSvg(paths) {
        return '<svg viewBox="0 0 24 24" aria-hidden="true">' + paths + '</svg>';
    }

    function setBarCollapsed(collapsed) {
        const bar = document.getElementById('markup-bar');
        const tab = document.getElementById('markup-tab');
        if (!bar) return;
        bar.classList.toggle('collapsed', collapsed);
        document.body.classList.toggle('markup-bar-open', !collapsed);
        if (tab) {
            tab.classList.toggle('hidden', !collapsed);
            tab.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        }
        try { sessionStorage.setItem('pdfDisplay.markupBarCollapsed', collapsed ? '1' : '0'); } catch (e) { /* ignore */ }
    }

    function buildRail() {
        if (document.getElementById('markup-bar')) return;

        const bar = document.createElement('div');
        bar.id = 'markup-bar';
        bar.setAttribute('role', 'toolbar');
        bar.setAttribute('aria-label', 'Annotation tools');

        const collapseBtn = document.createElement('button');
        collapseBtn.type = 'button';
        collapseBtn.className = 'mk-btn mk-collapse';
        collapseBtn.title = 'Hide annotation bar';
        collapseBtn.setAttribute('aria-label', 'Hide annotation bar');
        collapseBtn.innerHTML = iconSvg('<path d="M6 9l6 6 6-6"/>');
        collapseBtn.addEventListener('click', function () { setBarCollapsed(true); });
        bar.appendChild(collapseBtn);

        const collapseSep = document.createElement('div');
        collapseSep.className = 'mk-sep';
        bar.appendChild(collapseSep);

        let group = document.createElement('div');
        group.className = 'mk-group';

        function flushGroup() {
            if (group.childNodes.length) bar.appendChild(group);
            group = document.createElement('div');
            group.className = 'mk-group';
        }

        ICONS.forEach(function (item) {
            if (!item) {
                flushGroup();
                const sep = document.createElement('div');
                sep.className = 'mk-sep';
                bar.appendChild(sep);
                return;
            }
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'mk-btn';
            btn.setAttribute('data-tool', item[0]);
            btn.title = item[1];
            btn.setAttribute('aria-label', item[1]);
            btn.innerHTML = iconSvg(item[2]);
            btn.addEventListener('click', function () { setTool(item[0]); });
            group.appendChild(btn);
        });
        flushGroup();

        const sep2 = document.createElement('div');
        sep2.className = 'mk-sep';
        bar.appendChild(sep2);

        const colors = document.createElement('div');
        colors.className = 'mk-group';
        const sw = document.createElement('div');
        sw.className = 'mk-swatches';
        SWATCHES.forEach(function (c) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'mk-swatch';
            b.setAttribute('data-color', c);
            b.style.background = c;
            b.title = c;
            b.setAttribute('aria-label', 'Color ' + c);
            b.addEventListener('click', function () { state.color = c; syncBar(); });
            sw.appendChild(b);
        });
        colors.appendChild(sw);
        const color = document.createElement('input');
        color.type = 'color';
        color.id = 'mk-color';
        color.className = 'mk-color';
        color.title = 'Custom color';
        color.addEventListener('input', function () { state.color = color.value; syncBar(); });
        colors.appendChild(color);
        bar.appendChild(colors);

        const sep3 = document.createElement('div');
        sep3.className = 'mk-sep';
        bar.appendChild(sep3);

        function prop(id, label, min, max, step, getVal, onInput) {
            const wrap = document.createElement('label');
            wrap.className = 'mk-prop';
            wrap.htmlFor = id;
            const name = document.createElement('span');
            name.textContent = label;
            const input = document.createElement('input');
            input.type = 'range';
            input.id = id;
            input.min = min;
            input.max = max;
            input.step = step;
            input.addEventListener('input', onInput);
            const val = document.createElement('span');
            val.className = 'mk-prop-val';
            val.id = id + '-val';
            val.textContent = getVal();
            wrap.appendChild(name);
            wrap.appendChild(input);
            wrap.appendChild(val);
            bar.appendChild(wrap);
        }
        prop('mk-opacity', 'Opacity', '0.15', '1', '0.05',
            function () { return Math.round(state.opacity * 100) + '%'; },
            function (e) {
                state.opacity = Number(e.target.value);
                const el = document.getElementById('mk-opacity-val');
                if (el) el.textContent = Math.round(state.opacity * 100) + '%';
            });
        prop('mk-width', 'Width', '1', '12', '0.5',
            function () { return Number(state.width).toFixed(1); },
            function (e) {
                state.width = Number(e.target.value);
                const el = document.getElementById('mk-width-val');
                if (el) el.textContent = Number(state.width).toFixed(1);
            });

        const spacer = document.createElement('div');
        spacer.className = 'mk-spacer';
        bar.appendChild(spacer);

        const history = document.createElement('div');
        history.className = 'mk-group';
        const undoBtn = document.createElement('button');
        undoBtn.type = 'button';
        undoBtn.className = 'mk-btn';
        undoBtn.title = 'Undo (Ctrl/Cmd+Z)';
        undoBtn.setAttribute('aria-label', 'Undo');
        undoBtn.innerHTML = iconSvg('<path d="M9 14l-4-4 4-4"/><path d="M5 10h9a5 5 0 0 1 0 10h-3"/>');
        undoBtn.addEventListener('click', undo);
        history.appendChild(undoBtn);
        const redoBtn = document.createElement('button');
        redoBtn.type = 'button';
        redoBtn.className = 'mk-btn';
        redoBtn.title = 'Redo (Ctrl/Cmd+Shift+Z)';
        redoBtn.setAttribute('aria-label', 'Redo');
        redoBtn.innerHTML = iconSvg('<path d="M15 14l4-4-4-4"/><path d="M19 10H10a5 5 0 0 0 0 10h3"/>');
        redoBtn.addEventListener('click', redo);
        history.appendChild(redoBtn);
        bar.appendChild(history);

        document.body.appendChild(bar);

        const tab = document.createElement('button');
        tab.type = 'button';
        tab.id = 'markup-tab';
        tab.className = 'hidden';
        tab.title = 'Show annotation tools';
        tab.setAttribute('aria-label', 'Show annotation tools');
        tab.setAttribute('aria-expanded', 'true');
        tab.innerHTML = iconSvg('<path d="M12 5v14"/><path d="M5 12h14"/><path d="M8 8h8v8H8z"/>') + '<span>Annotate</span>';
        tab.addEventListener('click', function () { setBarCollapsed(false); });
        document.body.appendChild(tab);

        let startCollapsed = false;
        try { startCollapsed = sessionStorage.getItem('pdfDisplay.markupBarCollapsed') === '1'; } catch (e) { /* ignore */ }
        setBarCollapsed(startCollapsed);

        const hint = document.createElement('div');
        hint.id = 'markup-hint';
        document.body.appendChild(hint);
        if (!startCollapsed) showHint(HINTS.select);
    }

    function openSig() {
        let modal = document.getElementById('markup-sig-modal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'markup-sig-modal';
            modal.innerHTML = '<div class="mk-dialog"><h2>Signature</h2><p>Draw with a pointer, then place it on the page.</p><canvas></canvas><div class="mk-actions"><button type="button" class="toolbar-btn text-btn" data-act="clear">Clear</button><button type="button" class="toolbar-btn text-btn" data-act="cancel">Cancel</button><button type="button" class="toolbar-btn text-btn" data-act="use">Use signature</button></div></div>';
            document.body.appendChild(modal);
            const canvas = modal.querySelector('canvas');
            const ctx = canvas.getContext('2d');
            let drawing = false, blank = true;
            function size() {
                const dpr = Math.min(window.devicePixelRatio || 1, 2);
                const w = canvas.clientWidth, h = canvas.clientHeight;
                canvas.width = w * dpr; canvas.height = h * dpr;
                ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
                ctx.strokeStyle = '#1c1c1e';
                ctx.lineWidth = 2.2;
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';
                blank = true;
            }
            size();
            canvas.addEventListener('pointerdown', function (e) {
                drawing = true;
                const r = canvas.getBoundingClientRect();
                ctx.beginPath();
                ctx.moveTo(e.clientX - r.left, e.clientY - r.top);
                canvas.setPointerCapture(e.pointerId);
            });
            canvas.addEventListener('pointermove', function (e) {
                if (!drawing) return;
                const r = canvas.getBoundingClientRect();
                ctx.lineTo(e.clientX - r.left, e.clientY - r.top);
                ctx.stroke();
                blank = false;
            });
            canvas.addEventListener('pointerup', function () { drawing = false; });
            modal.addEventListener('click', function (e) {
                const act = e.target.getAttribute && e.target.getAttribute('data-act');
                if (act === 'clear') { ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight); blank = true; }
                if (act === 'cancel') { modal.classList.add('hidden'); setTool('select'); }
                if (act === 'use') {
                    if (blank) return;
                    state.signatureSrc = canvas.toDataURL('image/png');
                    modal.classList.add('hidden');
                    setTool('signature');
                }
            });
        }
        modal.classList.remove('hidden');
    }

    document.addEventListener('keydown', function (e) {
        const t = e.target;
        const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
        const mod = e.metaKey || e.ctrlKey;
        if (mod && e.key.toLowerCase() === 'z') {
            e.preventDefault();
            if (e.shiftKey) redo(); else undo();
            return;
        }
        if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
        if (typing) return;
        if (e.key === 'Escape') { setTool('select'); return; }
        if ((e.key === 'Backspace' || e.key === 'Delete') && state.selectedId) {
            e.preventDefault();
            remove(state.selectedId);
            return;
        }
        const tool = KEYS[e.key.toLowerCase()];
        if (tool) { e.preventDefault(); setTool(tool); }
    });

    window.PdfMarkup = {
        renderPage: renderPage,
        renderAll: renderAll,
        setTool: setTool,
        undo: undo,
        redo: redo,
        get tool() { return state.tool; }
    };

    function boot() {
        buildRail();
        syncBar();
        renderAll();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
