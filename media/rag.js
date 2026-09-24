/* Full-document text index + BM25-lite retrieval for PDFDisplay Reading Assist.
 * Built in the webview so pdf.js text extraction stays local and parallel. */
(function () {
    var CHUNK_TARGET = 900;   // chars per chunk (soft)
    var CHUNK_OVERLAP = 120;
    var CONTEXT_BUDGET = 16000; // max chars sent to the model per request
    var BATCH = 6;             // parallel page extracts

    /** @type {{ key: string, totalPages: number, chunks: Array<{id:number,page:number,text:string,tf:Object,len:number}>, df: Object, avgLen: number } | null} */
    var index = null;
    var building = null;

    function tokenize(text) {
        if (!text) return [];
        var m = String(text).toLowerCase().match(/[a-z0-9][a-z0-9''-]{1,}/g);
        return m || [];
    }

    function termFreq(tokens) {
        var tf = Object.create(null);
        for (var i = 0; i < tokens.length; i++) {
            var t = tokens[i];
            tf[t] = (tf[t] || 0) + 1;
        }
        return tf;
    }

    function collapseWs(s) {
        return String(s || '').replace(/[ \t\r\n\f]+/g, ' ').trim();
    }

    /** Split page text into overlapping chunks, preferring paragraph boundaries. */
    function chunkPageText(pageNum, text) {
        var clean = collapseWs(text);
        if (!clean) return [];
        if (clean.length <= CHUNK_TARGET) {
            return [{ page: pageNum, text: clean }];
        }
        var paras = clean.split(/(?<=[.!?])\s+(?=[A-Z0-9"'])|\s{2,}/);
        var chunks = [];
        var buf = '';
        function flush() {
            var t = collapseWs(buf);
            if (t) chunks.push({ page: pageNum, text: t });
            buf = '';
        }
        for (var i = 0; i < paras.length; i++) {
            var p = paras[i];
            if (!p) continue;
            if (buf.length + p.length + 1 <= CHUNK_TARGET) {
                buf = buf ? buf + ' ' + p : p;
            } else {
                if (buf) flush();
                if (p.length <= CHUNK_TARGET) {
                    buf = p;
                } else {
                    // hard-split long paragraph
                    for (var j = 0; j < p.length; j += CHUNK_TARGET - CHUNK_OVERLAP) {
                        chunks.push({ page: pageNum, text: p.slice(j, j + CHUNK_TARGET) });
                    }
                    buf = '';
                }
            }
        }
        if (buf) flush();
        // overlap: prepend tail of previous chunk to next when useful
        if (CHUNK_OVERLAP > 0 && chunks.length > 1) {
            for (var k = 1; k < chunks.length; k++) {
                if (chunks[k].page !== chunks[k - 1].page) continue;
                var prev = chunks[k - 1].text;
                var tail = prev.slice(Math.max(0, prev.length - CHUNK_OVERLAP));
                if (chunks[k].text.indexOf(tail.slice(0, 40)) !== 0) {
                    chunks[k].text = collapseWs(tail + ' ' + chunks[k].text);
                }
            }
        }
        return chunks;
    }

    function finalizeIndex(key, totalPages, rawChunks) {
        var df = Object.create(null);
        var chunks = [];
        var totalLen = 0;
        for (var i = 0; i < rawChunks.length; i++) {
            var tokens = tokenize(rawChunks[i].text);
            if (tokens.length < 3) continue;
            var tf = termFreq(tokens);
            var seen = Object.create(null);
            for (var term in tf) {
                if (!seen[term]) {
                    df[term] = (df[term] || 0) + 1;
                    seen[term] = 1;
                }
            }
            chunks.push({
                id: chunks.length,
                page: rawChunks[i].page,
                text: rawChunks[i].text,
                tf: tf,
                len: tokens.length
            });
            totalLen += tokens.length;
        }
        index = {
            key: key,
            totalPages: totalPages,
            chunks: chunks,
            df: df,
            avgLen: chunks.length ? totalLen / chunks.length : 1,
            builtAt: Date.now()
        };
        return index;
    }

    async function buildIndex(host, onProgress) {
        if (!host || !host.totalPages) throw new Error('PDF not ready');
        var total = host.totalPages;
        var key = (host.fileName || '') + '::' + total;
        if (index && index.key === key && index.chunks.length) return index;
        if (building) return building;

        building = (async function () {
            var raw = [];
            for (var start = 1; start <= total; start += BATCH) {
                var end = Math.min(total, start + BATCH - 1);
                var jobs = [];
                for (var p = start; p <= end; p++) {
                    jobs.push((function (page) {
                        return host.pageTextPlain(page).then(function (t) {
                            return { page: page, text: t || '' };
                        }).catch(function () {
                            return { page: page, text: '' };
                        });
                    })(p));
                }
                var pages = await Promise.all(jobs);
                for (var i = 0; i < pages.length; i++) {
                    var parts = chunkPageText(pages[i].page, pages[i].text);
                    for (var c = 0; c < parts.length; c++) raw.push(parts[c]);
                }
                if (typeof onProgress === 'function') {
                    onProgress(Math.min(total, end), total);
                }
            }
            var done = finalizeIndex(key, total, raw);
            building = null;
            return done;
        })();

        try {
            return await building;
        } catch (e) {
            building = null;
            throw e;
        }
    }

    /**
     * BM25-lite score for a chunk against query tokens.
     * k1=1.4, b=0.75 — good default for short technical queries.
     */
    function bm25(chunk, qTokens, df, nDocs, avgLen) {
        if (!qTokens.length) return 0;
        var k1 = 1.4;
        var b = 0.75;
        var score = 0;
        var seen = Object.create(null);
        for (var i = 0; i < qTokens.length; i++) {
            var term = qTokens[i];
            if (seen[term]) continue;
            seen[term] = 1;
            var f = chunk.tf[term] || 0;
            if (!f) continue;
            var dfT = df[term] || 0;
            var idf = Math.log(1 + (nDocs - dfT + 0.5) / (dfT + 0.5));
            var denom = f + k1 * (1 - b + b * (chunk.len / (avgLen || 1)));
            score += idf * ((f * (k1 + 1)) / denom);
        }
        return score;
    }

    function uniqueTerms(tokens) {
        var s = Object.create(null);
        var out = [];
        for (var i = 0; i < tokens.length; i++) {
            if (!s[tokens[i]]) {
                s[tokens[i]] = 1;
                out.push(tokens[i]);
            }
        }
        return out;
    }

    /**
     * Pack top-scoring chunks under a char budget with page diversity.
     * @returns {{ text: string, meta: string, pages: number[], chunkCount: number }}
     */
    function packChunks(scored, budget, label) {
        budget = budget || CONTEXT_BUDGET;
        var usedPages = Object.create(null);
        var picked = [];
        var chars = 0;
        // First pass: best chunk per high-scoring page
        var byPage = Object.create(null);
        for (var i = 0; i < scored.length; i++) {
            var s = scored[i];
            if (s.score <= 0 && i > 20) continue;
            if (!byPage[s.chunk.page] || byPage[s.chunk.page].score < s.score) {
                byPage[s.chunk.page] = s;
            }
        }
        var pageBest = [];
        for (var pg in byPage) pageBest.push(byPage[pg]);
        pageBest.sort(function (a, b) { return b.score - a.score; });

        function tryAdd(item) {
            var block = '[Page ' + item.chunk.page + ']\n' + item.chunk.text;
            var add = block.length + 2;
            if (chars + add > budget && picked.length > 0) return false;
            picked.push(item);
            chars += add;
            usedPages[item.chunk.page] = 1;
            return true;
        }

        for (var p = 0; p < pageBest.length; p++) {
            if (chars >= budget * 0.85) break;
            tryAdd(pageBest[p]);
        }
        // Second pass: more high-score chunks (allow multiple per page)
        for (var j = 0; j < scored.length; j++) {
            if (chars >= budget) break;
            var it = scored[j];
            var already = false;
            for (var k = 0; k < picked.length; k++) {
                if (picked[k].chunk.id === it.chunk.id) { already = true; break; }
            }
            if (already) continue;
            tryAdd(it);
        }

        // Sort by page order for readable context
        picked.sort(function (a, b) {
            if (a.chunk.page !== b.chunk.page) return a.chunk.page - b.chunk.page;
            return a.chunk.id - b.chunk.id;
        });

        var parts = [];
        var pages = [];
        for (var x = 0; x < picked.length; x++) {
            parts.push('[Page ' + picked[x].chunk.page + ']\n' + picked[x].chunk.text);
            if (pages.indexOf(picked[x].chunk.page) < 0) pages.push(picked[x].chunk.page);
        }
        pages.sort(function (a, b) { return a - b; });
        var meta = (label || 'retrieved') + ' · ' + picked.length + ' passages · pages ' +
            (pages.length <= 8 ? pages.join(', ') : pages.slice(0, 6).join(', ') + '…+' + (pages.length - 6));
        return {
            text: parts.join('\n\n'),
            meta: meta,
            pages: pages,
            chunkCount: picked.length
        };
    }

    /** Query-focused retrieval (Q&A, chat, citation on topic). */
    function retrieveForQuery(query, budget) {
        if (!index || !index.chunks.length) return { text: '', meta: 'empty index', pages: [], chunkCount: 0 };
        var qTokens = uniqueTerms(tokenize(query));
        var n = index.chunks.length;
        var scored = [];
        for (var i = 0; i < n; i++) {
            var c = index.chunks[i];
            var score = bm25(c, qTokens, index.df, n, index.avgLen);
            // light boost for consecutive query bigrams in text
            if (qTokens.length >= 2) {
                var lower = c.text.toLowerCase();
                for (var b = 0; b < qTokens.length - 1; b++) {
                    if (lower.indexOf(qTokens[b] + ' ' + qTokens[b + 1]) >= 0) score *= 1.15;
                }
            }
            scored.push({ chunk: c, score: score });
        }
        scored.sort(function (a, b) { return b.score - a.score; });
        // If query is weak, fall back to coverage sampling
        if (!qTokens.length || (scored[0] && scored[0].score <= 0)) {
            return retrieveForCoverage(budget, 'full document');
        }
        return packChunks(scored, budget, 'query retrieval');
    }

    /**
     * Coverage-oriented selection for summary / keypoints / flashcards / quiz.
     * Even page strata + densest chunks so the whole document is represented.
     */
    function retrieveForCoverage(budget, label) {
        if (!index || !index.chunks.length) return { text: '', meta: 'empty index', pages: [], chunkCount: 0 };
        budget = budget || CONTEXT_BUDGET;
        var chunks = index.chunks;
        var totalPages = index.totalPages || 1;
        var scored = [];

        // Strata: ~one slot per page-band across the document
        var bands = Math.min(totalPages, Math.max(8, Math.floor(budget / 1200)));
        var bandSize = totalPages / bands;
        var selectedIds = Object.create(null);

        for (var b = 0; b < bands; b++) {
            var lo = Math.floor(b * bandSize) + 1;
            var hi = Math.floor((b + 1) * bandSize);
            if (hi < lo) hi = lo;
            var best = null;
            for (var i = 0; i < chunks.length; i++) {
                var c = chunks[i];
                if (c.page < lo || c.page > hi) continue;
                // density score: longer informative chunks preferred
                var dens = c.len + Math.min(40, c.text.split(/[.!?]/).length * 2);
                if (!best || dens > best.dens) best = { chunk: c, dens: dens, score: dens };
            }
            if (best) {
                selectedIds[best.chunk.id] = 1;
                scored.push({ chunk: best.chunk, score: best.dens });
            }
        }
        // Fill remaining budget with longest remaining chunks (global coverage)
        var rest = [];
        for (var j = 0; j < chunks.length; j++) {
            if (selectedIds[chunks[j].id]) continue;
            rest.push({ chunk: chunks[j], score: chunks[j].len });
        }
        rest.sort(function (a, b) { return b.score - a.score; });
        for (var r = 0; r < rest.length; r++) scored.push(rest[r]);

        return packChunks(scored, budget, label || 'document coverage');
    }

    /** Retrieve focused on a page range (chapter / current region). */
    function retrieveForPages(fromPage, toPage, query, budget) {
        if (!index || !index.chunks.length) return { text: '', meta: 'empty index', pages: [], chunkCount: 0 };
        var subset = [];
        for (var i = 0; i < index.chunks.length; i++) {
            var c = index.chunks[i];
            if (c.page >= fromPage && c.page <= toPage) subset.push(c);
        }
        if (!subset.length) return { text: '', meta: 'no text in range', pages: [], chunkCount: 0 };

        // Temporary mini-index stats
        var df = Object.create(null);
        var totalLen = 0;
        for (var s = 0; s < subset.length; s++) {
            totalLen += subset[s].len;
            for (var term in subset[s].tf) {
                df[term] = (df[term] || 0) + 1;
            }
        }
        var avgLen = totalLen / subset.length;
        var qTokens = uniqueTerms(tokenize(query || ''));
        var scored = subset.map(function (c) {
            var score = qTokens.length
                ? bm25(c, qTokens, df, subset.length, avgLen)
                : c.len;
            return { chunk: c, score: score };
        });
        scored.sort(function (a, b) { return b.score - a.score; });
        return packChunks(scored, budget, 'pages ' + fromPage + '-' + toPage);
    }

    /**
     * Stratified map-reduce batches (max 5) spanning the whole document.
     * Avoids dozens of sequential API calls on long PDFs.
     */
    function coverageBatches(batchBudget, maxBatches) {
        batchBudget = batchBudget || Math.floor(CONTEXT_BUDGET * 0.9);
        maxBatches = maxBatches || 5;
        if (!index || !index.chunks.length) return [];
        var totalPages = index.totalPages || 1;
        var chunks = index.chunks;
        if (chunks.length <= 8) {
            // Small doc: single batch
            var all = [];
            var pages = [];
            for (var i = 0; i < chunks.length; i++) {
                all.push('[Page ' + chunks[i].page + ']\n' + chunks[i].text);
                if (pages.indexOf(chunks[i].page) < 0) pages.push(chunks[i].page);
            }
            return [{ text: all.join('\n\n'), pages: pages, meta: 'full document · ' + chunks.length + ' chunks' }];
        }
        var bands = Math.min(maxBatches, totalPages, Math.max(2, Math.ceil(chunks.length / 12)));
        var bandSize = totalPages / bands;
        var batches = [];
        for (var b = 0; b < bands; b++) {
            var lo = Math.floor(b * bandSize) + 1;
            var hi = Math.floor((b + 1) * bandSize);
            if (hi < lo) hi = lo;
            var bandChunks = [];
            for (var c = 0; c < chunks.length; c++) {
                if (chunks[c].page >= lo && chunks[c].page <= hi) bandChunks.push(chunks[c]);
            }
            // Prefer denser chunks within the band under budget
            bandChunks.sort(function (a, b2) { return b2.len - a.len; });
            var parts = [];
            var chars = 0;
            var pgs = [];
            for (var k = 0; k < bandChunks.length; k++) {
                var block = '[Page ' + bandChunks[k].page + ']\n' + bandChunks[k].text;
                if (chars + block.length > batchBudget && parts.length) break;
                parts.push(block);
                chars += block.length + 2;
                if (pgs.indexOf(bandChunks[k].page) < 0) pgs.push(bandChunks[k].page);
            }
            // restore reading order
            parts.sort(function (a, b2) {
                var pa = parseInt(a.match(/\[Page (\d+)\]/)[1], 10);
                var pb = parseInt(b2.match(/\[Page (\d+)\]/)[1], 10);
                return pa - pb;
            });
            if (parts.length) {
                pgs.sort(function (a, b2) { return a - b2; });
                batches.push({
                    text: parts.join('\n\n'),
                    pages: pgs,
                    meta: 'section ' + (b + 1) + '/' + bands + ' · pages ' + lo + '-' + hi
                });
            }
        }
        return batches;
    }

    function getIndexStats() {
        if (!index) return null;
        return {
            totalPages: index.totalPages,
            chunkCount: index.chunks.length,
            key: index.key
        };
    }

    function invalidate() {
        index = null;
        building = null;
    }

    window.PdfRag = {
        buildIndex: buildIndex,
        retrieveForQuery: retrieveForQuery,
        retrieveForCoverage: retrieveForCoverage,
        retrieveForPages: retrieveForPages,
        coverageBatches: coverageBatches,
        getIndexStats: getIndexStats,
        invalidate: invalidate,
        CONTEXT_BUDGET: CONTEXT_BUDGET
    };
})();
