import * as vscode from 'vscode';
import * as crypto from 'crypto';

export function activate(context: vscode.ExtensionContext) {
    const provider = new PdfViewerProvider(context);
    context.subscriptions.push(vscode.window.registerCustomEditorProvider(
        PdfViewerProvider.viewType,
        provider,
        {
            webviewOptions: {
                // Keep the rendered pages/scroll position alive when the tab is hidden,
                // instead of tearing down and re-decoding/re-rendering the whole PDF on every focus.
                retainContextWhenHidden: true
            },
            supportsMultipleEditorsPerDocument: false
        }
    ));

    context.subscriptions.push(vscode.commands.registerCommand('pdfDisplay.openPdf', async (uri: vscode.Uri) => {
        if (!uri) {
            const uris = await vscode.window.showOpenDialog({ filters: { 'PDFs': ['pdf'] } });
            if (uris && uris.length > 0) {
                uri = uris[0];
            } else {
                return;
            }
        }

        // Validate extension even for programmatic invocations, not just the manual dialog.
        if (!uri.fsPath.toLowerCase().endsWith('.pdf')) {
            vscode.window.showErrorMessage(`pdfDisplay: "${uri.fsPath}" is not a .pdf file.`);
            return;
        }

        vscode.commands.executeCommand('vscode.openWith', uri, PdfViewerProvider.viewType);
    }));
}

class PdfViewerProvider implements vscode.CustomReadonlyEditorProvider {
    public static readonly viewType = 'pdfDisplay.pdfViewer';

    constructor(private readonly context: vscode.ExtensionContext) {}

    public async openCustomDocument(uri: vscode.Uri): Promise<vscode.CustomDocument> {
        return { uri, dispose: () => {} };
    }

    public async resolveCustomEditor(
        document: vscode.CustomDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: []
        };

        const fileName = escapeHtml(vscode.workspace.asRelativePath(document.uri, false).split(/[\\/]/).pop() ?? 'document.pdf');
        const nonce = getNonce();

        // Load and send the PDF bytes via postMessage instead of embedding a giant
        // base64 string inline in the HTML (smaller payload, no huge string literal,
        // avoids holding the file in memory 2-3x over).
        const loadAndSend = async () => {
            try {
                const bytes = await vscode.workspace.fs.readFile(document.uri); // async, non-blocking
                webviewPanel.webview.postMessage({
                    type: 'pdf-data',
                    // NOTE: whether a Uint8Array survives postMessage as an actual
                    // TypedArray (vs. getting flattened into a plain {0: n, 1: n, ...}
                    // object) depends on the VS Code version. pdf.js rejects that
                    // plain-object shape outright ("Invalid PDF binary data..."), so
                    // send a definite plain number array instead and rebuild a real
                    // Uint8Array on the webview side - this works the same everywhere.
                    data: Array.from(bytes)
                });
            } catch (err: any) {
                webviewPanel.webview.postMessage({
                    type: 'pdf-error',
                    message: err?.message ?? String(err)
                });
            }
        };

        // IMPORTANT: register the listener BEFORE assigning webview.html. Setting
        // .html starts the webview loading and running its script, which posts a
        // 'ready' message as soon as it's up. If we attach the listener after that
        // assignment there's a race where 'ready' can arrive before we're listening
        // for it, the message is dropped, and the webview spins on "Loading..."
        // forever with no error since the failure path is also never triggered.
        webviewPanel.webview.onDidReceiveMessage(msg => {
            if (msg?.type === 'ready') {
                loadAndSend();
            }
        });

        webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview, fileName, nonce);

        // Clean up if/when we hold extension-side resources tied to this panel in the future.
        webviewPanel.onDidDispose(() => {
            // no external resources currently held; placeholder for future cleanup
        });
    }

    private getHtmlForWebview(webview: vscode.Webview, fileName: string, nonce: string): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' https://cdnjs.cloudflare.com; style-src 'nonce-${nonce}'; img-src data:; connect-src https://cdnjs.cloudflare.com; child-src blob:; worker-src blob: https://cdnjs.cloudflare.com;">
    <title>PDF Viewer - ${fileName}</title>
    <script nonce="${nonce}" src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
    <style nonce="${nonce}">
        :root {
            --bg-color: #2b2b2b;
            --toolbar-bg: #323639;
            --text-color: #ffffff;
            --shadow: 0 4px 12px rgba(0,0,0,0.5);
        }

        body, html {
            margin: 0;
            padding: 0;
            height: 100%;
            background-color: var(--bg-color);
            color: var(--text-color);
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            overflow: hidden;
        }

        #toolbar {
            height: 48px;
            background-color: var(--toolbar-bg);
            display: flex;
            align-items: center;
            padding: 0 20px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.3);
            z-index: 100;
            position: fixed;
            top: 0;
            width: 100%;
            box-sizing: border-box;
        }

        .title {
            font-size: 14px;
            font-weight: 500;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            max-width: 400px;
        }

        #viewer-container {
            height: calc(100vh - 48px);
            margin-top: 48px;
            overflow-y: auto;
            display: flex;
            flex-direction: column;
            align-items: center;
            padding: 30px 0;
            gap: 24px;
            scroll-behavior: smooth;
        }

        .page-container {
            position: relative;
            background-color: white;
            box-shadow: var(--shadow);
            border-radius: 2px;
            line-height: 0;
        }

        .page-placeholder {
            background-color: #3c3c3c;
        }

        canvas {
            max-width: 100%;
            height: auto;
            border-radius: 2px;
            display: block;
        }

        #loading-overlay {
            position: fixed;
            top: 48px;
            left: 0;
            right: 0;
            bottom: 0;
            background-color: var(--bg-color);
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            z-index: 1000;
        }

        .spinner {
            width: 40px;
            height: 40px;
            border: 4px solid rgba(255,255,255,0.1);
            border-top: 4px solid #007acc;
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin-bottom: 16px;
        }

        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }

        ::-webkit-scrollbar {
            width: 12px;
        }
        ::-webkit-scrollbar-track {
            background: #2b2b2b;
        }
        ::-webkit-scrollbar-thumb {
            background: #555;
            border: 3px solid #2b2b2b;
            border-radius: 10px;
        }
        ::-webkit-scrollbar-thumb:hover {
            background: #888;
        }
    </style>
</head>
<body>
    <div id="toolbar">
        <div class="title">📄 ${fileName}</div>
    </div>

    <div id="loading-overlay">
        <div class="spinner"></div>
        <div id="loading-text">Loading PDF document...</div>
    </div>

    <div id="viewer-container"></div>

    <script nonce="${nonce}">
        const vscodeApi = acquireVsCodeApi();

        const container = document.getElementById('viewer-container');
        const loadingOverlay = document.getElementById('loading-overlay');
        const loadingText = document.getElementById('loading-text');

        function showError(message) {
            loadingText.innerHTML = '';
            loadingText.textContent = 'Failed to load PDF: ' + message;
            loadingText.style.color = '#ff4d4d';
            const spinner = document.querySelector('.spinner');
            if (spinner) spinner.style.display = 'none';
            loadingOverlay.style.display = 'flex';
        }

        // pdf.js is loaded from a <script src="..."> tag above. If that script
        // fails to load (CDN down, wrong/unpublished version, network blocked),
        // window['pdfjs-dist/build/pdf'] won't exist. Guard against that instead
        // of letting it throw here, which would kill this whole inline script
        // before the message listener / ready handshake / timeout below ever run
        // (i.e. the tab would spin on "Loading..." forever with zero feedback).
        let pdfjsLib = null;
        try {
            pdfjsLib = window['pdfjs-dist/build/pdf'];
            if (!pdfjsLib) {
                throw new Error('pdf.js failed to load from CDN (window["pdfjs-dist/build/pdf"] is undefined).');
            }
            pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        } catch (err) {
            showError((err && err.message) || String(err));
        }

        // Lazily render pages as they scroll into view instead of rendering
        // every page up front (avoids freezing the UI on large documents).
        function setupLazyRendering(pdf) {
            const dpr = window.devicePixelRatio || 1;
            const baseScale = 1.5;

            const observer = new IntersectionObserver((entries) => {
                for (const entry of entries) {
                    if (entry.isIntersecting) {
                        const pageContainer = entry.target;
                        observer.unobserve(pageContainer);
                        renderPage(pdf, pageContainer, baseScale, dpr);
                    }
                }
            }, { root: container, rootMargin: '400px 0px' });

            return observer;
        }

        async function renderPage(pdf, pageContainer, baseScale, dpr) {
            const pageNum = Number(pageContainer.dataset.pageNumber);
            try {
                const page = await pdf.getPage(pageNum);
                const viewport = page.getViewport({ scale: baseScale });

                const canvas = document.createElement('canvas');
                const context = canvas.getContext('2d');

                // Render at device pixel ratio for crisp output on high-DPI displays,
                // scale back down with CSS so layout stays consistent.
                canvas.width = Math.floor(viewport.width * dpr);
                canvas.height = Math.floor(viewport.height * dpr);
                canvas.style.width = viewport.width + 'px';
                canvas.style.height = viewport.height + 'px';

                pageContainer.innerHTML = '';
                pageContainer.appendChild(canvas);

                const transform = dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined;
                await page.render({ canvasContext: context, viewport, transform }).promise;
            } catch (err) {
                pageContainer.textContent = 'Failed to render page ' + pageNum;
                pageContainer.style.color = '#ff4d4d';
            }
        }

        async function renderPdf(bytes) {
            try {
                // bytes arrives as a plain number array (see extension-side comment on
                // why we don't rely on Uint8Array surviving postMessage) - pdf.js
                // requires an actual TypedArray/string/array-like, so rebuild it here.
                const typedBytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
                const loadingTask = pdfjsLib.getDocument({ data: typedBytes });
                const pdf = await loadingTask.promise;

                loadingOverlay.style.display = 'none';

                const observer = setupLazyRendering(pdf);

                for (let i = 1; i <= pdf.numPages; i++) {
                    const page = await pdf.getPage(i);
                    const viewport = page.getViewport({ scale: 1.5 });

                    const pageContainer = document.createElement('div');
                    pageContainer.className = 'page-container page-placeholder';
                    pageContainer.dataset.pageNumber = String(i);
                    pageContainer.style.width = viewport.width + 'px';
                    pageContainer.style.height = viewport.height + 'px';

                    container.appendChild(pageContainer);
                    observer.observe(pageContainer);
                }
            } catch (error) {
                // Password-protected or otherwise encrypted PDFs surface here too;
                // give a clearer hint for that common case.
                const msg = (error && error.name === 'PasswordException')
                    ? 'This PDF is password-protected and cannot be previewed.'
                    : (error && error.message) || String(error);
                console.error('Error rendering PDF:', error);
                showError(msg);
            }
        }

        window.addEventListener('message', (event) => {
            const msg = event.data;
            if (msg.type === 'pdf-data') {
                pdfDataReceived = true;
                renderPdf(msg.data);
            } else if (msg.type === 'pdf-error') {
                pdfDataReceived = true;
                showError(msg.message);
            }
        });

        // Tell the extension host we're ready to receive the PDF bytes
        // (only if pdf.js itself actually loaded - no point fetching data
        // we can't render, and showError() has already fired above otherwise).
        let pdfDataReceived = false;
        if (pdfjsLib) {
            vscodeApi.postMessage({ type: 'ready' });

            // Safety net: if nothing comes back within a few seconds (dropped message,
            // extension-host exception before it could postMessage, etc.), surface an
            // error instead of spinning forever with no feedback.
            setTimeout(() => {
                if (!pdfDataReceived) {
                    showError('Timed out waiting for the PDF data from the extension. Try closing and reopening the file.');
                }
            }, 8000);
        }
    </script>
</body>
</html>`;
    }
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function getNonce(): string {
    return crypto.randomBytes(16).toString('base64');
}

export function deactivate() {}
