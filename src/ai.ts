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
    defaultTargetLang: string;
}

export function getAiSettings(): AiSettings {
    const cfg = vscode.workspace.getConfiguration('pdfDisplay.ai');
    return {
        provider: (cfg.get<string>('provider') || 'none') as AiProvider,
        apiKey: (cfg.get<string>('apiKey') || '').trim(),
        baseUrl: (cfg.get<string>('baseUrl') || '').trim().replace(/\/$/, ''),
        model: (cfg.get<string>('model') || '').trim(),
        defaultTargetLang: (cfg.get<string>('defaultTargetLang') || 'es').trim() || 'es'
    };
}

export function isAiConfigured(settings: AiSettings = getAiSettings()): boolean {
    if (settings.provider === 'none') return false;
    if (settings.provider === 'ollama') return true; // local, key optional
    return Boolean(settings.apiKey);
}

function timeoutSignal(ms: number): AbortSignal {
    const c = new AbortController();
    setTimeout(() => c.abort(), ms);
    return c.signal;
}

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
    const res = await fetch(url, init);
    const text = await res.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!res.ok) {
        const detail = typeof body === 'string' ? body : (body?.error?.message || body?.message || text);
        throw new Error(detail || `HTTP ${res.status}`);
    }
    return body;
}

/** Free open dictionary — no key required. */
export async function defineFree(word: string): Promise<{ word: string; phonetic?: string; meanings: { partOfSpeech: string; definitions: string[] }[] }> {
    const cleaned = word.replace(/[^\p{L}\p{N}'-]/gu, '').trim();
    if (!cleaned) throw new Error('No word selected');
    const url = 'https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(cleaned.toLowerCase());
    const data = await fetchJson(url, { signal: timeoutSignal(12000) });
    if (!Array.isArray(data) || !data[0]) throw new Error('No definition found');
    const entry = data[0];
    const meanings = (entry.meanings || []).map((m: any) => ({
        partOfSpeech: String(m.partOfSpeech || ''),
        definitions: (m.definitions || []).slice(0, 3).map((d: any) => String(d.definition || '')).filter(Boolean)
    })).filter((m: any) => m.definitions.length);
    if (!meanings.length) throw new Error('No definition found');
    return {
        word: String(entry.word || cleaned),
        phonetic: entry.phonetic || entry.phonetics?.find((p: any) => p.text)?.text,
        meanings
    };
}

/** Free MyMemory translation — no key required (rate-limited). */
export async function translateFree(text: string, targetLang: string, sourceLang = 'auto'): Promise<{ translated: string; detectedSource?: string }> {
    const q = text.trim();
    if (!q) throw new Error('No text to translate');
    if (q.length > 450) throw new Error('Selection too long for free translation (max ~450 chars). Configure an AI provider for longer text.');
    const pair = `${sourceLang === 'auto' ? 'autodetect' : sourceLang}|${targetLang}`;
    // MyMemory uses en|es style; autodetect is not official — use auto|xx via langpair when possible
    const langpair = sourceLang === 'auto' ? `en|${targetLang}` : `${sourceLang}|${targetLang}`;
    const url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(q) + '&langpair=' + encodeURIComponent(langpair);
    const data = await fetchJson(url, { signal: timeoutSignal(15000) });
    const translated = data?.responseData?.translatedText;
    if (!translated) throw new Error(data?.responseDetails || 'Translation failed');
    // If auto-detect failed quality, still return what we got
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

    // OpenAI-compatible: openai, azure, ollama, grok, custom
    let url: string;
    const headers: Record<string, string> = { 'content-type': 'application/json' };

    if (provider === 'azure') {
        if (!settings.baseUrl) throw new Error('Azure OpenAI requires pdfDisplay.ai.baseUrl (resource endpoint)');
        // baseUrl should be full deployment chat URL or resource root
        url = settings.baseUrl.includes('/chat/completions')
            ? settings.baseUrl
            : `${settings.baseUrl}/openai/deployments/${encodeURIComponent(model)}/chat/completions?api-version=2024-06-01`;
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
    const settings = getAiSettings();
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
    aiNote?: string;
}> {
    const cleaned = text.trim();
    const isSingleWord = !/\s/.test(cleaned) && cleaned.length < 40;
    const settings = getAiSettings();

    if (isSingleWord) {
        try {
            const free = await defineFree(cleaned);
            return { ...free, provider: 'dictionaryapi' };
        } catch (e) {
            if (!isAiConfigured(settings)) throw e;
        }
    }

    if (isAiConfigured(settings)) {
        const reply = await chatComplete(
            settings,
            'Explain the meaning of the selected word or phrase clearly and briefly. If it is a word, give part of speech and 1-3 short definitions. Plain text only.',
            cleaned
        );
        return {
            word: cleaned,
            meanings: [{ partOfSpeech: '', definitions: [reply] }],
            provider: settings.provider
        };
    }

    if (isSingleWord) {
        const free = await defineFree(cleaned);
        return { ...free, provider: 'dictionaryapi' };
    }
    throw new Error('Configure an AI provider in Settings (pdfDisplay.ai) to define phrases. Single English words work without a key.');
}

export async function handleAiMessage(
    msg: any,
    post: (payload: any) => Thenable<boolean>
): Promise<void> {
    const requestId = msg.requestId;
    try {
        if (msg.type === 'ai-translate') {
            const target = (msg.targetLang || getAiSettings().defaultTargetLang || 'es').toString();
            const result = await translateText(String(msg.text || ''), target, msg.sourceLang);
            await post({ type: 'ai-translate-result', requestId, ok: true, ...result, targetLang: target });
            return;
        }
        if (msg.type === 'ai-define') {
            const result = await defineText(String(msg.text || ''));
            await post({ type: 'ai-define-result', requestId, ok: true, ...result });
            return;
        }
        if (msg.type === 'ai-status') {
            const s = getAiSettings();
            await post({
                type: 'ai-status-result',
                requestId,
                configured: isAiConfigured(s),
                provider: s.provider,
                model: s.model || defaultModel(s.provider),
                defaultTargetLang: s.defaultTargetLang
            });
        }
    } catch (e: any) {
        await post({
            type: msg.type === 'ai-translate' ? 'ai-translate-result' : msg.type === 'ai-define' ? 'ai-define-result' : 'ai-status-result',
            requestId,
            ok: false,
            error: e?.message ?? String(e)
        });
    }
}
