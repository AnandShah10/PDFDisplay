import * as vscode from 'vscode';

export type AiProvider =
    | 'none'
    | 'openai'
    | 'azure'
    | 'ollama'
    | 'gemini'
    | 'anthropic'
    | 'grok'
    | 'custom';

export interface AiSettings {
    provider: AiProvider;
    apiKey: string;
    baseUrl: string;
    model: string;
    azureApiVersion: string;
    defaultTargetLang: string;
}

const SECRET_KEY = 'pdfDisplay.ai.apiKey';
let secretStorage: vscode.SecretStorage | undefined;

/** Call once from activate() so the API key lives in VS Code SecretStorage (never settings.json). */
export function initAiSecrets(secrets: vscode.SecretStorage): void {
    secretStorage = secrets;
}

export async function setAiApiKey(key: string | undefined): Promise<void> {
    if (!secretStorage) throw new Error('Secret storage not initialized');
    const trimmed = (key || '').trim();
    if (trimmed) await secretStorage.store(SECRET_KEY, trimmed);
    else await secretStorage.delete(SECRET_KEY);
}

export async function hasAiApiKey(): Promise<boolean> {
    if (!secretStorage) return false;
    return Boolean(await secretStorage.get(SECRET_KEY));
}

export async function getAiSettings(): Promise<AiSettings> {
    const cfg = vscode.workspace.getConfiguration('pdfDisplay.ai');
    const apiKey = secretStorage ? ((await secretStorage.get(SECRET_KEY)) || '').trim() : '';
    return {
        provider: (cfg.get<string>('provider') || 'none') as AiProvider,
        apiKey,
        baseUrl: (cfg.get<string>('baseUrl') || '').trim().replace(/\/$/, ''),
        model: (cfg.get<string>('model') || '').trim(),
        azureApiVersion: (cfg.get<string>('azureApiVersion') || '2024-06-01').trim() || '2024-06-01',
        defaultTargetLang: (cfg.get<string>('defaultTargetLang') || 'es').trim() || 'es'
    };
}

export function isAiConfigured(settings: AiSettings): boolean {
    if (settings.provider === 'none') return false;
    if (settings.provider === 'ollama') return true;
    return Boolean(settings.apiKey);
}

function timeoutSignal(ms: number): AbortSignal {
    const c = new AbortController();
    setTimeout(() => c.abort(), ms);
    return c.signal;
}

const DEFAULT_HEADERS: Record<string, string> = {
    'Accept': 'application/json',
    'User-Agent': 'PDFDisplay-VSCode/0.0.23'
};

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
    const headers = { ...DEFAULT_HEADERS, ...(init?.headers as Record<string, string> | undefined) };
    const res = await fetch(url, { ...init, headers });
    const text = await res.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!res.ok) {
        const detail = typeof body === 'string' ? body : (body?.title || body?.message || body?.error?.message || text);
        throw new Error(detail || `HTTP ${res.status}`);
    }
    return body;
}

/** Normalize a selection into a lookup word (handles PDF soft hyphens, punctuation). */
export function cleanLookupWord(raw: string): string {
    let w = String(raw || '')
        .replace(/\u00ad/g, '') // soft hyphen
        .replace(/[\u2018\u2019\u201A\uFF07]/g, "'")
        .replace(/[\u201C\u201D]/g, '')
        .trim();
    // Prefer unicode letter class; fall back for older runtimes
    try {
        w = w.replace(/[^\p{L}\p{N}'-]/gu, '');
    } catch {
        w = w.replace(/[^a-zA-Z0-9'-]/g, '');
    }
    return w.trim();
}

async function defineFromDictionaryApi(word: string) {
    const url = 'https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(word.toLowerCase());
    const data = await fetchJson(url, { signal: timeoutSignal(12000) });
    if (!Array.isArray(data) || !data[0]) throw new Error('No definition found');
    const entry = data[0];
    const meanings = (entry.meanings || []).map((m: any) => ({
        partOfSpeech: String(m.partOfSpeech || ''),
        definitions: (m.definitions || []).slice(0, 3).map((d: any) => String(d.definition || '')).filter(Boolean)
    })).filter((m: any) => m.definitions.length);
    if (!meanings.length) throw new Error('No definition found');
    return {
        word: String(entry.word || word),
        phonetic: entry.phonetic || entry.phonetics?.find((p: any) => p.text)?.text as string | undefined,
        meanings
    };
}

function stripHtml(html: string): string {
    return String(html || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ')
        .trim();
}

async function defineFromWiktionary(word: string) {
    const url = 'https://en.wiktionary.org/api/rest_v1/page/definition/' + encodeURIComponent(word.toLowerCase());
    const data = await fetchJson(url, { signal: timeoutSignal(12000) });
    // Shape: { en: [ { partOfSpeech, definitions: [ { definition: html } ] } ] }
    const groups = data?.en;
    if (!Array.isArray(groups) || !groups.length) throw new Error('No definition found');
    const meanings = groups.slice(0, 4).map((g: any) => ({
        partOfSpeech: String(g.partOfSpeech || ''),
        definitions: (g.definitions || [])
            .slice(0, 3)
            .map((d: any) => stripHtml(d.definition || d))
            .filter(Boolean)
    })).filter((m: any) => m.definitions.length);
    if (!meanings.length) throw new Error('No definition found');
    return { word, meanings };
}

/** Free open dictionary — no key required (Dictionary API, then Wiktionary). */
export async function defineFree(word: string): Promise<{
    word: string;
    phonetic?: string;
    meanings: { partOfSpeech: string; definitions: string[] }[];
    provider: string;
}> {
    const cleaned = cleanLookupWord(word);
    if (!cleaned) throw new Error('No word selected');
    if (cleaned.length > 48) throw new Error('Selection is too long for a free dictionary lookup');

    const attempts = [cleaned, cleaned.toLowerCase()];
    // simple plural/suffix fallbacks
    if (/ies$/i.test(cleaned)) attempts.push(cleaned.replace(/ies$/i, 'y'));
    if (/ses$/i.test(cleaned)) attempts.push(cleaned.replace(/es$/i, ''));
    if (/s$/i.test(cleaned) && cleaned.length > 3) attempts.push(cleaned.replace(/s$/i, ''));
    if (/ing$/i.test(cleaned) && cleaned.length > 5) attempts.push(cleaned.replace(/ing$/i, ''), cleaned.replace(/ing$/i, 'e'));
    if (/ed$/i.test(cleaned) && cleaned.length > 4) attempts.push(cleaned.replace(/ed$/i, ''), cleaned.replace(/ed$/i, 'e'));

    const tried = new Set<string>();
    let lastErr: Error | undefined;
    for (const w of attempts) {
        const key = w.toLowerCase();
        if (!key || tried.has(key)) continue;
        tried.add(key);
        try {
            const r = await defineFromDictionaryApi(w);
            return { ...r, provider: 'dictionaryapi' };
        } catch (e: any) {
            lastErr = e instanceof Error ? e : new Error(String(e));
        }
        try {
            const r = await defineFromWiktionary(w);
            return { ...r, provider: 'wiktionary' };
        } catch (e: any) {
            lastErr = e instanceof Error ? e : new Error(String(e));
        }
    }
    throw lastErr || new Error('No definition found');
}

/** Free MyMemory translation — no key required (rate-limited). */
export async function translateFree(text: string, targetLang: string, sourceLang = 'auto'): Promise<{ translated: string; detectedSource?: string }> {
    const q = text.trim();
    if (!q) throw new Error('No text to translate');
    if (q.length > 450) throw new Error('Selection too long for free translation (max ~450 chars). Configure an AI provider for longer text.');
    const langpair = sourceLang === 'auto' ? `en|${targetLang}` : `${sourceLang}|${targetLang}`;
    const url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(q) + '&langpair=' + encodeURIComponent(langpair);
    const data = await fetchJson(url, { signal: timeoutSignal(15000) });
    const translated = data?.responseData?.translatedText;
    if (!translated) throw new Error(data?.responseDetails || 'Translation failed');
    return {
        translated: String(translated),
        detectedSource: data?.responseData?.detectedLanguage
    };
}

async function chatComplete(settings: AiSettings, system: string, user: string): Promise<string> {
    const provider = settings.provider;
    const model = settings.model || defaultModel(provider);

    if (provider === 'anthropic') {
        const base = settings.baseUrl || 'https://api.anthropic.com';
        const data = await fetchJson(base + '/v1/messages', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-api-key': settings.apiKey,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model,
                max_tokens: 1024,
                system,
                messages: [{ role: 'user', content: user }]
            }),
            signal: timeoutSignal(45000)
        });
        const text = data?.content?.find((c: any) => c.type === 'text')?.text;
        if (!text) throw new Error('Empty Anthropic response');
        return String(text).trim();
    }

    if (provider === 'gemini') {
        const base = settings.baseUrl || 'https://generativelanguage.googleapis.com';
        const url = `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(settings.apiKey)}`;
        const data = await fetchJson(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: system + '\n\n' + user }] }],
                generationConfig: { temperature: 0.2, maxOutputTokens: 1024 }
            }),
            signal: timeoutSignal(45000)
        });
        const text = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).filter(Boolean).join('') || '';
        if (!text) throw new Error('Empty Gemini response');
        return String(text).trim();
    }

    let url: string;
    const headers: Record<string, string> = { 'content-type': 'application/json' };

    if (provider === 'azure') {
        if (!settings.baseUrl) throw new Error('Azure OpenAI requires pdfDisplay.ai.baseUrl (e.g. https://YOUR_RESOURCE.openai.azure.com)');
        if (!settings.model) throw new Error('Azure OpenAI requires pdfDisplay.ai.model (deployment name)');
        const apiVersion = settings.azureApiVersion || '2024-06-01';
        url = settings.baseUrl.includes('/chat/completions')
            ? (settings.baseUrl.includes('api-version=')
                ? settings.baseUrl
                : settings.baseUrl + (settings.baseUrl.includes('?') ? '&' : '?') + 'api-version=' + encodeURIComponent(apiVersion))
            : `${settings.baseUrl}/openai/deployments/${encodeURIComponent(model)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;
        headers['api-key'] = settings.apiKey;
    } else if (provider === 'ollama') {
        const base = settings.baseUrl || 'http://127.0.0.1:11434';
        url = base + '/v1/chat/completions';
        if (settings.apiKey) headers['authorization'] = 'Bearer ' + settings.apiKey;
    } else if (provider === 'grok') {
        const base = settings.baseUrl || 'https://api.x.ai';
        url = base + '/v1/chat/completions';
        headers['authorization'] = 'Bearer ' + settings.apiKey;
    } else {
        const base = settings.baseUrl || 'https://api.openai.com';
        url = base + '/v1/chat/completions';
        headers['authorization'] = 'Bearer ' + settings.apiKey;
    }

    const data = await fetchJson(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            model,
            temperature: 0.2,
            messages: [
                { role: 'system', content: system },
                { role: 'user', content: user }
            ]
        }),
        signal: timeoutSignal(45000)
    });
    const text = data?.choices?.[0]?.message?.content;
    if (!text) throw new Error('Empty model response');
    return String(text).trim();
}

function defaultModel(provider: AiProvider): string {
    switch (provider) {
        case 'anthropic': return 'claude-3-5-haiku-latest';
        case 'gemini': return 'gemini-2.0-flash';
        case 'ollama': return 'llama3.2';
        case 'grok': return 'grok-2-latest';
        case 'azure': return 'gpt-4o-mini';
        default: return 'gpt-4o-mini';
    }
}

export async function translateText(text: string, targetLang: string, sourceLang?: string): Promise<{ translated: string; provider: string }> {
    const settings = await getAiSettings();
    if (isAiConfigured(settings)) {
        const translated = await chatComplete(
            settings,
            `You are a precise translator. Translate the user's text into ${targetLang}. Return only the translation, no quotes or commentary.`,
            text
        );
        return { translated, provider: settings.provider };
    }
    const free = await translateFree(text, targetLang, sourceLang || 'auto');
    return { translated: free.translated, provider: 'mymemory' };
}

export async function defineText(text: string): Promise<{
    word: string;
    phonetic?: string;
    meanings: { partOfSpeech: string; definitions: string[] }[];
    provider: string;
}> {
    const raw = text.trim();
    if (!raw) throw new Error('No text selected');

    // Always try free dictionaries first for word-like selections (no API key needed)
    const cleaned = cleanLookupWord(raw);
    const wordLike = Boolean(cleaned) && cleaned.length <= 48 && !/\s/.test(cleaned);

    if (wordLike) {
        try {
            return await defineFree(cleaned);
        } catch (freeErr: any) {
            const settings = await getAiSettings();
            if (!isAiConfigured(settings)) {
                throw new Error(freeErr?.message || 'No definition found');
            }
            // fall through to AI for obscure words when configured
        }
    }

    const settings = await getAiSettings();
    if (isAiConfigured(settings)) {
        const reply = await chatComplete(
            settings,
            'Explain the meaning of the selected word or phrase clearly and briefly. If it is a word, give part of speech and 1-3 short definitions. Plain text only.',
            raw
        );
        return {
            word: cleaned || raw,
            meanings: [{ partOfSpeech: '', definitions: [reply] }],
            provider: settings.provider
        };
    }

    // Phrase without AI: define the longest word-like token
    const tokens = raw.split(/\s+/).map(cleanLookupWord).filter(t => t.length > 2);
    if (tokens.length) {
        try {
            return await defineFree(tokens[tokens.length - 1]);
        } catch {
            try {
                return await defineFree(tokens[0]);
            } catch { /* ignore */ }
        }
    }

    throw new Error('No definition found. Select a single English word, or set an AI provider for phrases.');
}


const ASSIST_PROMPTS: Record<string, { system: string; user: (ctx: AssistContext) => string }> = {
    summary: {
        system: 'You summarize documents clearly and accurately. Use short paragraphs and bullet points where helpful. Plain text only.',
        user: (c) => `Summarize this PDF content${c.meta ? ` (${c.meta})` : ''}:\n\n${c.text}`
    },
    'chapter-summary': {
        system: 'You write concise chapter or section summaries. Plain text only.',
        user: (c) => `Summarize this section/chapter${c.meta ? ` (${c.meta})` : ''}:\n\n${c.text}`
    },
    qa: {
        system: 'Answer questions using only the provided document text. If the answer is not in the text, say so. Plain text only.',
        user: (c) => `Document:\n${c.text}\n\nQuestion: ${c.question || ''}`
    },
    simplify: {
        system: 'Rewrite text in plain, simple language a non-expert can understand. Keep meaning. Plain text only.',
        user: (c) => `Simplify:\n\n${c.text}`
    },
    keypoints: {
        system: 'Extract the most important key points as a short bullet list. Plain text only.',
        user: (c) => `Extract key points from:\n\n${c.text}`
    },
    flashcards: {
        system: 'Create study flashcards from the text. Format each as:\nQ: ...\nA: ...\n\nAim for 5-10 cards. Plain text only.',
        user: (c) => `Create flashcards from:\n\n${c.text}`
    },
    quiz: {
        system: 'Create a short quiz (5 multiple-choice questions) from the text. For each question list options A-D and mark the correct answer. Plain text only.',
        user: (c) => `Create a quiz from:\n\n${c.text}`
    },
    citation: {
        system: 'Suggest academic citations for the provided text. Prefer APA and MLA. If metadata is incomplete, note assumptions. Plain text only.',
        user: (c) => `Generate citation suggestions for this material${c.meta ? ` (${c.meta})` : ''}:\n\n${c.text}`
    },
    chat: {
        system: 'You are a helpful reading assistant for the open PDF. Use the document context when relevant. Be concise. Plain text only.',
        user: (c) => {
            const hist = (c.history || []).slice(-6).map(h => `${h.role === 'user' ? 'User' : 'Assistant'}: ${h.content}`).join('\n');
            return `Document context:\n${c.text}\n\n${hist ? 'Conversation:\n' + hist + '\n\n' : ''}User: ${c.question || ''}`;
        }
    }
};

export interface AssistContext {
    text: string;
    question?: string;
    meta?: string;
    history?: { role: 'user' | 'assistant'; content: string }[];
}

function truncateText(text: string, maxChars = 14000): string {
    const t = text.trim();
    if (t.length <= maxChars) return t;
    return t.slice(0, maxChars) + '\n\n[…truncated…]';
}

export async function runAssist(action: string, ctx: AssistContext): Promise<{ text: string; provider: string; action: string }> {
    const settings = await getAiSettings();
    if (!isAiConfigured(settings)) {
        throw new Error('Reading Assist needs an AI provider. Set pdfDisplay.ai.provider and run "PDF Display: Set AI API Key".');
    }
    const prompt = ASSIST_PROMPTS[action];
    if (!prompt) throw new Error('Unknown assist action: ' + action);
    const text = truncateText(ctx.text || '');
    if (!text && action !== 'chat') throw new Error('No document text available for this action.');
    if ((action === 'qa' || action === 'chat') && !(ctx.question || '').trim()) {
        throw new Error('Enter a question first.');
    }
    if (action === 'simplify' && text.length < 2) throw new Error('Select text to simplify, or run on the current page.');
    const out = await chatComplete(settings, prompt.system, prompt.user({ ...ctx, text }));
    return { text: out, provider: settings.provider, action };
}

export async function handleAiMessage(
    msg: any,
    post: (payload: any) => Thenable<boolean>
): Promise<void> {
    const requestId = msg.requestId;
    try {
        if (msg.type === 'ai-translate') {
            const settings = await getAiSettings();
            const target = (msg.targetLang || settings.defaultTargetLang || 'es').toString();
            const result = await translateText(String(msg.text || ''), target, msg.sourceLang);
            await post({ type: 'ai-translate-result', requestId, ok: true, ...result, targetLang: target });
            return;
        }
        if (msg.type === 'ai-define') {
            const result = await defineText(String(msg.text || ''));
            await post({ type: 'ai-define-result', requestId, ok: true, ...result });
            return;
        }
        if (msg.type === 'ai-assist') {
            const result = await runAssist(String(msg.action || ''), {
                text: String(msg.text || ''),
                question: msg.question ? String(msg.question) : undefined,
                meta: msg.meta ? String(msg.meta) : undefined,
                history: Array.isArray(msg.history) ? msg.history : undefined
            });
            await post({ type: 'ai-assist-result', requestId, ok: true, ...result });
            return;
        }
        if (msg.type === 'ai-status') {
            const s = await getAiSettings();
            const cfg = vscode.workspace.getConfiguration('pdfDisplay.ai');
            const enableAssist = cfg.get<boolean>('enableAssist') === true;
            await post({
                type: 'ai-status-result',
                requestId,
                configured: isAiConfigured(s),
                hasApiKey: Boolean(s.apiKey),
                enableAssist,
                provider: s.provider,
                model: s.model || defaultModel(s.provider),
                defaultTargetLang: s.defaultTargetLang
            });
        }
    } catch (e: any) {
        const type =
            msg.type === 'ai-translate' ? 'ai-translate-result'
            : msg.type === 'ai-define' ? 'ai-define-result'
            : msg.type === 'ai-assist' ? 'ai-assist-result'
            : 'ai-status-result';
        await post({
            type,
            requestId,
            ok: false,
            error: e?.message ?? String(e)
        });
    }
}

/** Register Set / Clear API Key commands (password input — key never shown in Settings UI). */
export function registerAiKeyCommands(context: vscode.ExtensionContext): void {
    initAiSecrets(context.secrets);

    context.subscriptions.push(
        vscode.commands.registerCommand('pdfDisplay.setAiApiKey', async () => {
            const existing = await hasAiApiKey();
            const key = await vscode.window.showInputBox({
                title: 'PDF Display: AI API Key',
                prompt: existing
                    ? 'Enter a new API key (replaces the stored one). Leave empty to cancel.'
                    : 'Enter your AI API key. It is stored in VS Code Secret Storage and never written to settings.json.',
                password: true,
                ignoreFocusOut: true,
                placeHolder: existing ? '••••••••  (key already stored)' : 'sk-… / key…'
            });
            if (key === undefined) return; // cancelled
            if (!key.trim()) {
                vscode.window.showInformationMessage('PDF Display: API key unchanged.');
                return;
            }
            await setAiApiKey(key);
            vscode.window.showInformationMessage('PDF Display: API key saved securely.');
        }),
        vscode.commands.registerCommand('pdfDisplay.clearAiApiKey', async () => {
            const existing = await hasAiApiKey();
            if (!existing) {
                vscode.window.showInformationMessage('PDF Display: no API key is stored.');
                return;
            }
            const ok = await vscode.window.showWarningMessage(
                'Remove the stored AI API key from Secret Storage?',
                { modal: true },
                'Remove'
            );
            if (ok !== 'Remove') return;
            await setAiApiKey(undefined);
            vscode.window.showInformationMessage('PDF Display: API key removed.');
        })
    );
}
