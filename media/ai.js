/* Selection translate + definition assist for PDFDisplay webview */
(function () {
    const LANGS = [
        ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['hi', 'Hindi'],
        ['zh', 'Chinese'], ['ja', 'Japanese'], ['pt', 'Portuguese'], ['ar', 'Arabic'],
        ['ru', 'Russian'], ['it', 'Italian'], ['ko', 'Korean'], ['en', 'English']
    ];

    let status = { configured: false, enableAssist: false, provider: 'none', defaultTargetLang: 'es' };
    let chatHistory = [];
    let assistBusy = false;
    let lastTarget = 'es';
    let reqSeq = 0;
    let pending = {};
    let hoverTimer = null;
    let hoverWord = '';

    function vscodeApi() {
        return window.__pdfDisplayVscode || (typeof acquireVsCodeApi === 'function' ? null : null);
    }

    function post(msg) {
        try {
            if (window.__pdfDisplayPost) {
                window.__pdfDisplayPost(msg);
                return;
            }
            // fallback if host exposed vscode api on window from main script
            if (window.vscodeApi) window.vscodeApi.postMessage(msg);
        } catch (e) { /* ignore */ }
    }

    function rid() {
        reqSeq += 1;
        return 'ai_' + reqSeq + '_' + Date.now().toString(36);
    }

    function request(type, payload) {
        const requestId = rid();
        return new Promise(function (resolve, reject) {
            pending[requestId] = { resolve: resolve, reject: reject };
            post(Object.assign({ type: type, requestId: requestId }, payload));
            setTimeout(function () {
                if (pending[requestId]) {
                    pending[requestId].reject(new Error('Timed out waiting for extension host'));
                    delete pending[requestId];
                }
            }, 50000);
        });
    }

    function onHostMessage(msg) {
        if (!msg || !msg.type) return;
        if (msg.type === 'ai-status-result') {
            status = {
                configured: !!msg.configured,
                enableAssist: !!msg.enableAssist,
                provider: msg.provider || 'none',
                defaultTargetLang: msg.defaultTargetLang || 'es'
            };
            lastTarget = status.defaultTargetLang;
            updateAssistVisibility();
            return;
        }
        if (msg.type === 'ai-translate-result' || msg.type === 'ai-define-result' || msg.type === 'ai-assist-result') {
            const p = pending[msg.requestId];
            if (!p) return;
            delete pending[msg.requestId];
            if (msg.ok) p.resolve(msg);
            else p.reject(new Error(msg.error || 'Request failed'));
        }
    }

    window.PdfAi = {
        onHostMessage: onHostMessage,
        request: request,
        translateSelection: function () {
            const t = getSelectionText();
            if (t) runTranslate(t);
        },
        defineSelection: function () {
            const t = getSelectionText();
            if (t) runDefine(t);
        }
    };

    function getSelectionText() {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) return '';
        return sel.toString().replace(/\s+/g, ' ').trim();
    }

    function selectionRect() {
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount) return null;
        const r = sel.getRangeAt(0).getBoundingClientRect();
        if (!r || (!r.width && !r.height)) return null;
        return r;
    }

    function ensureUi() {
        if (document.getElementById('ai-sel-bar')) return;

        const bar = document.createElement('div');
        bar.id = 'ai-sel-bar';
        bar.innerHTML =
            '<button type="button" data-act="define" title="Define selection">Define</button>' +
            '<div class="ai-sep"></div>' +
            '<button type="button" data-act="translate" title="Translate selection">Translate</button>';
        bar.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); });
        bar.addEventListener('click', function (e) {
            const act = e.target && e.target.getAttribute && e.target.getAttribute('data-act');
            const text = getSelectionText();
            if (!text || !act) return;
            if (act === 'define') runDefine(text);
            if (act === 'translate') runTranslate(text);
        });
        document.body.appendChild(bar);

        const pop = document.createElement('div');
        pop.id = 'ai-popover';
        document.body.appendChild(pop);

        const tip = document.createElement('div');
        tip.id = 'ai-hover-tip';
        document.body.appendChild(tip);
    }

    function hideBar() {
        const bar = document.getElementById('ai-sel-bar');
        if (bar) bar.classList.remove('visible');
    }

    function showBar() {
        const text = getSelectionText();
        const rect = selectionRect();
        const bar = document.getElementById('ai-sel-bar');
        if (!bar || !text || !rect) {
            hideBar();
            return;
        }
        // Only when Select or text-markup tools — drawing tools block selection
        if (window.PdfMarkup && window.PdfMarkup.tool) {
            const t = window.PdfMarkup.tool;
            const ok = t === 'select' || t === 'highlight' || t === 'underline' || t === 'strikeout';
            if (!ok) {
                hideBar();
                return;
            }
        }
        bar.classList.add('visible');
        const bw = bar.offsetWidth || 160;
        const left = Math.min(window.innerWidth - bw - 8, Math.max(8, rect.left + rect.width / 2 - bw / 2));
        const top = Math.max(8, rect.top - 40);
        bar.style.left = left + 'px';
        bar.style.top = top + 'px';
    }

    function placePopover(anchorRect) {
        const pop = document.getElementById('ai-popover');
        if (!pop) return;
        pop.classList.add('visible');
        const pw = pop.offsetWidth || 320;
        const ph = pop.offsetHeight || 120;
        let left = 16;
        let top = 80;
        if (anchorRect) {
            left = Math.min(window.innerWidth - pw - 12, Math.max(8, anchorRect.left));
            top = anchorRect.bottom + 10;
            if (top + ph > window.innerHeight - 8) top = Math.max(8, anchorRect.top - ph - 10);
        }
        pop.style.left = left + 'px';
        pop.style.top = top + 'px';
    }

    function closePopover() {
        const pop = document.getElementById('ai-popover');
        if (pop) {
            pop.classList.remove('visible');
            pop.innerHTML = '';
        }
    }

    function renderPopover(title, meta, bodyHtml, extraFooter) {
        const pop = document.getElementById('ai-popover');
        if (!pop) return;
        pop.innerHTML =
            '<div class="ai-head"><div><div class="ai-title"></div><div class="ai-meta"></div></div>' +
            '<button type="button" class="ai-close" title="Close" aria-label="Close">&times;</button></div>' +
            '<div class="ai-body"></div>' +
            (extraFooter || '');
        pop.querySelector('.ai-title').textContent = title;
        pop.querySelector('.ai-meta').textContent = meta || '';
        pop.querySelector('.ai-body').innerHTML = bodyHtml;
        pop.querySelector('.ai-close').addEventListener('click', closePopover);
    }

    function escapeHtml(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    async function runDefine(text) {
        hideBar();
        const rect = selectionRect();
        renderPopover('Definition', 'Looking up…', '<p class="ai-loading">Fetching definition…</p>');
        placePopover(rect);
        try {
            const res = await request('ai-define', { text: text });
            let html = '';
            if (res.phonetic) html += '<p class="ai-meta">' + escapeHtml(res.phonetic) + '</p>';
            (res.meanings || []).forEach(function (m) {
                if (m.partOfSpeech) html += '<div class="ai-pos">' + escapeHtml(m.partOfSpeech) + '</div>';
                (m.definitions || []).forEach(function (d, i) {
                    html += '<p class="ai-def">' + (i + 1) + '. ' + escapeHtml(d) + '</p>';
                });
            });
            const provider = res.provider === 'dictionaryapi' ? 'Free Dictionary API' : ('AI · ' + res.provider);
            renderPopover(res.word || text, provider, html || '<p>No definition found.</p>');
            placePopover(rect);
        } catch (e) {
            renderPopover('Definition', '', '<p class="ai-error">' + escapeHtml(e.message || String(e)) + '</p>');
            placePopover(rect);
        }
    }

    async function runTranslate(text, targetLang) {
        hideBar();
        const rect = selectionRect();
        const target = targetLang || lastTarget || status.defaultTargetLang || 'es';
        lastTarget = target;

        let selectHtml = '<div class="ai-actions"><label>To <select id="ai-lang">';
        LANGS.forEach(function (pair) {
            selectHtml += '<option value="' + pair[0] + '"' + (pair[0] === target ? ' selected' : '') + '>' + pair[1] + '</option>';
        });
        selectHtml += '</select></label><button type="button" id="ai-copy">Copy</button></div>';

        renderPopover('Translate', 'Working…', '<p class="ai-loading">Translating…</p>', selectHtml);
        placePopover(rect);
        bindTranslateControls(text, rect);

        try {
            const res = await request('ai-translate', { text: text, targetLang: target });
            const provider = res.provider === 'mymemory' ? 'MyMemory (free)' : ('AI · ' + res.provider);
            renderPopover(
                'Translate',
                provider + ' → ' + target,
                '<p>' + escapeHtml(res.translated) + '</p>',
                selectHtml
            );
            placePopover(rect);
            bindTranslateControls(text, rect, res.translated);
        } catch (e) {
            renderPopover('Translate', '', '<p class="ai-error">' + escapeHtml(e.message || String(e)) + '</p>', selectHtml);
            placePopover(rect);
            bindTranslateControls(text, rect);
        }
    }

    function bindTranslateControls(sourceText, rect, translated) {
        const sel = document.getElementById('ai-lang');
        if (sel) {
            sel.value = lastTarget;
            sel.onchange = function () {
                lastTarget = sel.value;
                runTranslate(sourceText, sel.value);
            };
        }
        const copy = document.getElementById('ai-copy');
        if (copy) {
            copy.onclick = function () {
                const t = translated || (document.querySelector('#ai-popover .ai-body') || {}).textContent || '';
                if (t && navigator.clipboard) navigator.clipboard.writeText(t);
            };
        }
    }

    function wordAtPoint(x, y) {
        let range = null;
        if (document.caretRangeFromPoint) range = document.caretRangeFromPoint(x, y);
        else if (document.caretPositionFromPoint) {
            const pos = document.caretPositionFromPoint(x, y);
            if (pos) {
                range = document.createRange();
                range.setStart(pos.offsetNode, pos.offset);
                range.setEnd(pos.offsetNode, pos.offset);
            }
        }
        if (!range || !range.startContainer || range.startContainer.nodeType !== Node.TEXT_NODE) return null;
        const text = range.startContainer.textContent || '';
        let i = range.startOffset;
        if (!text || i > text.length) return null;
        const isWord = function (ch) { return /[\p{L}\p{N}'’-]/u.test(ch); };
        if (i > 0 && !isWord(text[i]) && isWord(text[i - 1])) i -= 1;
        if (!isWord(text[i] || '')) return null;
        let a = i, b = i;
        while (a > 0 && isWord(text[a - 1])) a -= 1;
        while (b < text.length && isWord(text[b])) b += 1;
        const word = text.slice(a, b).trim();
        if (!word || word.length > 40) return null;
        return word;
    }

    async function showHoverDefine(word, x, y) {
        const tip = document.getElementById('ai-hover-tip');
        if (!tip) return;
        tip.textContent = '…';
        tip.classList.add('visible');
        tip.style.left = Math.min(window.innerWidth - 290, Math.max(8, x + 12)) + 'px';
        tip.style.top = Math.min(window.innerHeight - 80, Math.max(8, y + 14)) + 'px';
        try {
            const res = await request('ai-define', { text: word });
            const first = (res.meanings && res.meanings[0] && res.meanings[0].definitions[0]) || '';
            const pos = (res.meanings && res.meanings[0] && res.meanings[0].partOfSpeech) ? res.meanings[0].partOfSpeech + ' · ' : '';
            tip.textContent = (res.word || word) + (res.phonetic ? ' ' + res.phonetic : '') + '\n' + pos + first;
        } catch (e) {
            tip.classList.remove('visible');
        }
    }

    function hideHover() {
        const tip = document.getElementById('ai-hover-tip');
        if (tip) tip.classList.remove('visible');
        hoverWord = '';
    }


    function updateAssistVisibility() {
        ensureAssistUi();
        const fab = document.getElementById('ai-fab');
        const panel = document.getElementById('ai-panel');
        if (!fab) return;
        const show = !!status.enableAssist;
        fab.classList.toggle('visible', show);
        if (!show && panel) {
            panel.classList.remove('visible');
        }
        const sub = document.getElementById('ai-panel-sub');
        if (sub) {
            sub.textContent = status.configured
                ? ((status.provider || 'ai') + (status.model ? ' · ready' : ''))
                : 'Set provider + API key in Settings';
        }
    }

    function ensureAssistUi() {
        if (document.getElementById('ai-fab')) return;

        const fab = document.createElement('button');
        fab.type = 'button';
        fab.id = 'ai-fab';
        fab.title = 'Reading Assist';
        fab.textContent = 'AI Assist';
        fab.addEventListener('click', function () {
            const panel = document.getElementById('ai-panel');
            if (!panel) return;
            panel.classList.toggle('visible');
        });
        document.body.appendChild(fab);

        const panel = document.createElement('div');
        panel.id = 'ai-panel';
        panel.innerHTML =
            '<div class="ai-panel-head">' +
            '  <div><strong>Reading Assist</strong><div class="ai-sub" id="ai-panel-sub"></div></div>' +
            '  <button type="button" class="ai-panel-close" title="Close" aria-label="Close">&times;</button>' +
            '</div>' +
            '<div class="ai-scope">Scope <select id="ai-scope">' +
            '  <option value="page">Current page</option>' +
            '  <option value="selection">Selection</option>' +
            '  <option value="doc">Whole document (smart retrieval)</option>' +
            '</select></div>' +
            '<div class="ai-actions-grid">' +
            '  <button type="button" data-act="summary">PDF summary</button>' +
            '  <button type="button" data-act="chapter-summary">Chapter summary</button>' +
            '  <button type="button" data-act="keypoints">Key points</button>' +
            '  <button type="button" data-act="simplify">Simplify</button>' +
            '  <button type="button" data-act="flashcards">Flashcards</button>' +
            '  <button type="button" data-act="quiz">Quiz</button>' +
            '  <button type="button" data-act="citation">Citations</button>' +
            '  <button type="button" data-act="qa">Ask (Q&amp;A)</button>' +
            '</div>' +
            '<div class="ai-out" id="ai-out"><span class="ai-muted">Pick an action. Only visible because Reading Assist is enabled in Settings.</span></div>' +
            '<div class="ai-chat-row">' +
            '  <input id="ai-chat-input" type="text" placeholder="Ask about this PDF…" />' +
            '  <button type="button" id="ai-chat-send">Send</button>' +
            '</div>';
        document.body.appendChild(panel);

        panel.querySelector('.ai-panel-close').addEventListener('click', function () {
            panel.classList.remove('visible');
        });
        panel.querySelector('.ai-actions-grid').addEventListener('click', function (e) {
            const btn = e.target.closest('button[data-act]');
            if (!btn || assistBusy) return;
            runAssistAction(btn.getAttribute('data-act'));
        });
        document.getElementById('ai-chat-send').addEventListener('click', function () {
            runAssistAction('chat');
        });
        document.getElementById('ai-chat-input').addEventListener('keydown', function (e) {
            if (e.key === 'Enter') runAssistAction('chat');
        });
    }

    async function gatherScopeText(action, question) {
        const host = window.__pdfDisplay;
        if (!host) return { text: '', meta: '', batches: null };
        const scopeEl = document.getElementById('ai-scope');
        let scope = scopeEl ? scopeEl.value : 'page';
        const rag = window.PdfRag;
        const budget = (rag && rag.CONTEXT_BUDGET) || 16000;

        if (action === 'simplify') {
            const sel = host.selectionText ? host.selectionText() : '';
            if (sel) return { text: sel, meta: 'selected text', batches: null };
            scope = 'page';
        }
        if (scope === 'selection') {
            const sel = host.selectionText ? host.selectionText() : '';
            if (!sel) throw new Error('Select text in the PDF first, or change scope to Current page.');
            return { text: sel, meta: 'selected text', batches: null };
        }

        // Build full-document index (all pages, chunked) — no 12-page truncation
        if (rag && typeof rag.buildIndex === 'function') {
            setAssistOut('<p class="ai-muted">Indexing document for precise retrieval…</p>');
            await rag.buildIndex(host, function (done, total) {
                setAssistOut('<p class="ai-muted">Indexing… ' + done + ' / ' + total + ' pages</p>');
            });
        }

        if (scope === 'page') {
            const page = host.currentPage || 1;
            if (rag && rag.retrieveForPages) {
                const hit = rag.retrieveForPages(page, page, question || '', budget);
                if (hit.text) {
                    return {
                        text: hit.text,
                        meta: (host.fileName || 'PDF') + ' · page ' + page + ' · ' + hit.chunkCount + ' passages',
                        batches: null
                    };
                }
            }
            const text = await host.pageTextPlain(page);
            return { text: text, meta: (host.fileName || 'PDF') + ' · page ' + page, batches: null };
        }

        // scope === 'doc' — full document via retrieval / map-reduce batches
        const needsQuery = action === 'qa' || action === 'chat' || action === 'citation';
        const coverageActions = { summary: 1, 'chapter-summary': 1, keypoints: 1, flashcards: 1, quiz: 1 };

        if (rag) {
            if (needsQuery && question) {
                const hit = rag.retrieveForQuery(question, budget);
                return {
                    text: hit.text,
                    meta: (host.fileName || 'PDF') + ' · ' + hit.meta,
                    batches: null,
                    retrieval: 'bm25'
                };
            }
            // Map-reduce for whole-doc synthesis actions when index is large
            if (coverageActions[action] && rag.coverageBatches) {
                const batches = rag.coverageBatches(budget);
                if (batches.length > 1) {
                    return {
                        text: batches[0].text,
                        meta: (host.fileName || 'PDF') + ' · map-reduce · ' + batches.length + ' batches · full document',
                        batches: batches,
                        retrieval: 'map-reduce'
                    };
                }
                if (batches.length === 1) {
                    return {
                        text: batches[0].text,
                        meta: (host.fileName || 'PDF') + ' · full document · ' + (rag.getIndexStats() || {}).chunkCount + ' chunks',
                        batches: null,
                        retrieval: 'full'
                    };
                }
            }
            const hit = rag.retrieveForCoverage(budget, 'full document');
            return {
                text: hit.text,
                meta: (host.fileName || 'PDF') + ' · ' + hit.meta,
                batches: null,
                retrieval: 'coverage'
            };
        }

        // Fallback without rag.js
        const total = host.totalPages || 1;
        const text = await host.pagesTextPlain(1, total);
        return { text: text, meta: (host.fileName || 'PDF') + ' · all ' + total + ' pages', batches: null };
    }

    function setAssistOut(html) {
        const out = document.getElementById('ai-out');
        if (out) out.innerHTML = html;
    }

    function setAssistBusy(busy) {
        assistBusy = busy;
        document.querySelectorAll('#ai-panel .ai-actions-grid button, #ai-chat-send').forEach(function (b) {
            b.disabled = !!busy;
        });
    }

    async function runAssistAction(action) {
        if (!status.enableAssist) return;
        if (!status.configured) {
            setAssistOut('<p class="ai-error">Enable an AI provider in Settings (<code>pdfDisplay.ai.provider</code>) and run <strong>PDF Display: Set AI API Key</strong>.</p>');
            return;
        }
        const input = document.getElementById('ai-chat-input');
        const question = input ? input.value.trim() : '';
        if ((action === 'qa' || action === 'chat') && !question) {
            setAssistOut('<p class="ai-error">Type a question in the box below first.</p>');
            if (input) input.focus();
            return;
        }

        setAssistBusy(true);
        setAssistOut('<p class="ai-muted">Working…</p>');
        try {
            const gathered = await gatherScopeText(action, question);
            const payload = {
                action: action,
                text: gathered.text,
                meta: gathered.meta,
                question: question || undefined,
                history: action === 'chat' ? chatHistory.slice(-6) : undefined,
                batches: gathered.batches || undefined
            };
            setAssistOut('<p class="ai-muted">Generating…' + (gathered.batches && gathered.batches.length > 1
                ? ' (full-document map-reduce, ' + gathered.batches.length + ' passes)'
                : '') + '</p>');
            const res = await request('ai-assist', payload);
            const body = escapeHtml(res.text || '');
            setAssistOut('<div class="ai-muted" style="margin-bottom:8px">' +
                escapeHtml(res.provider || '') +
                (gathered.meta ? ' · ' + escapeHtml(gathered.meta) : '') +
                (res.passes ? ' · ' + res.passes + ' passes' : '') +
                '</div><div>' + body + '</div>');
            if (action === 'chat' || action === 'qa') {
                if (question) chatHistory.push({ role: 'user', content: question });
                chatHistory.push({ role: 'assistant', content: res.text || '' });
                if (input) input.value = '';
            }
        } catch (e) {
            setAssistOut('<p class="ai-error">' + escapeHtml(e.message || String(e)) + '</p>');
        } finally {
            setAssistBusy(false);
        }
    }


    function boot() {
        ensureUi();
        ensureAssistUi();
        post({ type: 'ai-status', requestId: rid() });

        document.addEventListener('mouseup', function () {
            setTimeout(showBar, 10);
        });
        document.addEventListener('keyup', function (e) {
            if (e.key === 'Escape') {
                closePopover();
                hideBar();
                hideHover();
            } else {
                setTimeout(showBar, 10);
            }
        });
        document.addEventListener('mousedown', function (e) {
            const pop = document.getElementById('ai-popover');
            const bar = document.getElementById('ai-sel-bar');
            if (pop && pop.classList.contains('visible') && !pop.contains(e.target)) closePopover();
            if (bar && !bar.contains(e.target)) hideBar();
        });

        // Definitions on hover over the invisible text layer (English words)
        document.addEventListener('mousemove', function (e) {
            const inText = e.target && e.target.closest && e.target.closest('.text-layer');
            if (!inText) {
                clearTimeout(hoverTimer);
                hideHover();
                return;
            }
            const word = wordAtPoint(e.clientX, e.clientY);
            if (!word || word === hoverWord) return;
            hoverWord = word;
            clearTimeout(hoverTimer);
            hideHover();
            hoverTimer = setTimeout(function () {
                if (hoverWord === word) showHoverDefine(word, e.clientX, e.clientY);
            }, 550);
        });
        document.addEventListener('scroll', function () { hideHover(); hideBar(); }, true);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
