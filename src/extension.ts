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

    // ---- Command Palette integration ---------------------------------------
    // All of the actual behavior (zoom, page nav, search, etc.) lives inside the
    // webview's own JS, so these commands just forward an action to whichever PDF
    // panel is currently focused (tracked via PdfViewerProvider.activePanel).
    function postToActivePanel(action: string, payload?: unknown) {
        const panel = PdfViewerProvider.activePanel;
        if (!panel) {
            vscode.window.showInformationMessage('Open a PDF first.');
            return;
        }
        panel.webview.postMessage({ type: 'command', action, payload });
    }

    context.subscriptions.push(
        vscode.commands.registerCommand('pdfDisplay.zoomIn', () => postToActivePanel('zoom-in')),
        vscode.commands.registerCommand('pdfDisplay.zoomOut', () => postToActivePanel('zoom-out')),
        vscode.commands.registerCommand('pdfDisplay.zoomFitWidth', () => postToActivePanel('fit-width')),
        vscode.commands.registerCommand('pdfDisplay.nextPage', () => postToActivePanel('next-page')),
        vscode.commands.registerCommand('pdfDisplay.prevPage', () => postToActivePanel('prev-page')),
        vscode.commands.registerCommand('pdfDisplay.find', () => postToActivePanel('open-search')),
        vscode.commands.registerCommand('pdfDisplay.toggleSidebar', () => postToActivePanel('toggle-sidebar')),
        vscode.commands.registerCommand('pdfDisplay.toggleAnnotate', () => postToActivePanel('toggle-annotate')),
        vscode.commands.registerCommand('pdfDisplay.toggleBookmarks', () => postToActivePanel('toggle-bookmarks')),
        vscode.commands.registerCommand('pdfDisplay.bookmarkCurrentPage', () => postToActivePanel('bookmark-current-page')),
        vscode.commands.registerCommand('pdfDisplay.goToPage', async () => {
            if (!PdfViewerProvider.activePanel) {
                vscode.window.showInformationMessage('Open a PDF first.');
                return;
            }
            const value = await vscode.window.showInputBox({
                prompt: 'Go to page number',
                validateInput: v => (/^\d+$/.test(v.trim()) && Number(v) > 0) ? undefined : 'Enter a page number'
            });
            if (value) {
                postToActivePanel('go-to-page', Number(value));
            }
        })
    );
}

class PdfViewerProvider implements vscode.CustomReadonlyEditorProvider {
    public static readonly viewType = 'pdfDisplay.pdfViewer';

    // Tracks whichever PDF panel is currently focused, so Command Palette actions
    // (registered once in activate()) know which webview to forward them to.
    public static activePanel: vscode.WebviewPanel | undefined;

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

        // Load and send the PDF bytes (+ any previously saved annotations, last
        // page/zoom, and bookmarks) via postMessage instead of embedding a giant
        // base64 string inline in the HTML (smaller payload, no huge string literal,
        // avoids holding the file in memory 2-3x over).
        const loadAndSend = async () => {
            try {
                const bytes = await vscode.workspace.fs.readFile(document.uri); // async, non-blocking
                const storedViewState = getStoredViewState(this.context, document.uri);
                console.log('[pdfDisplay] loadAndSend for', document.uri.toString(), 'storedViewState=', storedViewState);
                webviewPanel.webview.postMessage({
                    type: 'pdf-data',
                    // NOTE: whether a Uint8Array survives postMessage as an actual
                    // TypedArray (vs. getting flattened into a plain {0: n, 1: n, ...}
                    // object) depends on the VS Code version. pdf.js rejects that
                    // plain-object shape outright ("Invalid PDF binary data..."), so
                    // send a definite plain number array instead and rebuild a real
                    // Uint8Array on the webview side - this works the same everywhere.
                    data: Array.from(bytes),
                    annotations: getStoredAnnotations(this.context, document.uri),
                    viewState: storedViewState,
                    bookmarks: getStoredBookmarks(this.context, document.uri)
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
            } else if (msg?.type === 'save-annotations') {
                // Sticky-note annotations, persisted in the extension's own
                // storage (VS Code globalState) rather than a sidecar file or
                // the PDF itself, keyed per-document so they survive reloads.
                storeAnnotations(this.context, document.uri, Array.isArray(msg.annotations) ? msg.annotations : []);
            } else if (msg?.type === 'save-view-state') {
                // Last-viewed page + zoom, saved (debounced) as the user scrolls/zooms,
                // so reopening the document resumes where they left off.
                console.log('[pdfDisplay] onDidReceiveMessage save-view-state', msg.page, msg.scale, 'for', document.uri.toString());
                if (typeof msg.page === 'number' && typeof msg.scale === 'number') {
                    storeViewState(this.context, document.uri, { page: msg.page, scale: msg.scale });
                }
            } else if (msg?.type === 'save-bookmarks') {
                storeBookmarks(this.context, document.uri, Array.isArray(msg.bookmarks) ? msg.bookmarks : []);
            }
        });

        webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview, fileName, nonce);

        // Command Palette routing: keep track of whichever panel currently has
        // focus so commands registered once in activate() know where to send actions.
        if (webviewPanel.active) {
            PdfViewerProvider.activePanel = webviewPanel;
        }
        webviewPanel.onDidChangeViewState(e => {
            if (e.webviewPanel.active) {
                PdfViewerProvider.activePanel = e.webviewPanel;
            } else if (PdfViewerProvider.activePanel === e.webviewPanel) {
                PdfViewerProvider.activePanel = undefined;
            }
        });

        webviewPanel.onDidDispose(() => {
            if (PdfViewerProvider.activePanel === webviewPanel) {
                PdfViewerProvider.activePanel = undefined;
            }
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
            /* VS Code injects --vscode-* custom properties into every webview and
               updates them live when the user switches themes/color schemes - no
               reload or JS needed. Falling back to our original dark palette keeps
               this looking identical to before if any variable is ever unavailable. */
            --bg-color: var(--vscode-editor-background, #2b2b2b);
            --toolbar-bg: var(--vscode-titleBar-activeBackground, var(--vscode-sideBar-background, #323639));
            --text-color: var(--vscode-editor-foreground, #ffffff);
            --muted-text-color: var(--vscode-descriptionForeground, #cccccc);
            --border-color: var(--vscode-panel-border, #444444);
            --input-bg: var(--vscode-input-background, #3c3f41);
            --input-border: var(--vscode-input-border, #555555);
            --hover-bg: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.12));
            --accent-color: var(--vscode-progressBar-background, #007acc);
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
            max-width: 300px;
        }

        .toolbar-spacer {
            flex: 1;
        }

        .toolbar-group {
            display: flex;
            align-items: center;
            gap: 6px;
            margin-left: 18px;
        }

        .toolbar-btn {
            background: transparent;
            border: none;
            color: var(--text-color);
            width: 28px;
            height: 28px;
            border-radius: 4px;
            font-size: 15px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 0;
        }

        .toolbar-btn:hover:not(:disabled) {
            background-color: var(--hover-bg);
        }

        .toolbar-btn:disabled {
            opacity: 0.35;
            cursor: default;
        }

        .toolbar-btn.text-btn {
            width: auto;
            padding: 0 10px;
            font-size: 12px;
        }

        #page-input {
            width: 40px;
            background-color: var(--input-bg);
            border: 1px solid var(--input-border);
            color: var(--text-color);
            border-radius: 3px;
            text-align: center;
            font-size: 12px;
            padding: 4px 2px;
        }
        /* hide number input spin arrows for a cleaner toolbar look */
        #page-input::-webkit-outer-spin-button,
        #page-input::-webkit-inner-spin-button {
            -webkit-appearance: none;
            margin: 0;
        }
        #page-input {
            -moz-appearance: textfield;
        }

        .page-sep, #zoom-level {
            font-size: 12px;
            color: var(--muted-text-color);
            white-space: nowrap;
            min-width: 40px;
            text-align: center;
        }

        #content {
            display: flex;
            height: calc(100vh - 48px);
            margin-top: 48px;
        }

        #thumbnail-sidebar {
            width: 132px;
            flex-shrink: 0;
            background-color: var(--vscode-sideBar-background, #252526);
            border-right: 1px solid var(--border-color);
            overflow-y: auto;
            padding: 14px 0;
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 12px;
            transition: width 0.15s ease, padding 0.15s ease, border 0.15s ease;
        }

        #thumbnail-sidebar.collapsed {
            width: 0;
            padding: 0;
            border-right: none;
            overflow: hidden;
        }

        .thumb-container {
            position: relative;
            cursor: pointer;
            background-color: white;
            box-shadow: 0 2px 6px rgba(0,0,0,0.4);
            border: 2px solid transparent;
            border-radius: 2px;
            line-height: 0;
            flex-shrink: 0;
        }

        .thumb-container:hover {
            border-color: #666;
        }

        .thumb-container.active {
            border-color: var(--accent-color);
        }

        .thumb-placeholder {
            background-color: var(--vscode-editorWidget-background, #3c3c3c);
        }

        .thumb-page-number {
            position: absolute;
            bottom: 3px;
            right: 4px;
            font-size: 10px;
            line-height: 1.4;
            background: rgba(0,0,0,0.65);
            color: #fff;
            padding: 0 4px;
            border-radius: 2px;
            pointer-events: none;
        }

        #viewer-container {
            flex: 1;
            height: 100%;
            overflow-y: auto;
            display: flex;
            flex-direction: column;
            align-items: center;
            padding: 30px 0;
            gap: 24px;
            scroll-behavior: smooth;
            /* Disable the browser's automatic scroll-anchoring for this container.
               Without this, when a page near the top (often page 1, since it starts
               near-visible before any restore-scroll happens) has its placeholder
               swapped for its real rendered canvas shortly after we jump to a
               different page, the browser "helpfully" compensates by yanking the
               scroll position back toward that changed content - which is exactly
               what was undoing the last-viewed-page restoration. */
            overflow-anchor: none;
        }

        .page-container {
            position: relative;
            background-color: white;
            box-shadow: var(--shadow);
            border-radius: 2px;
            line-height: 0;
        }

        .page-placeholder {
            background-color: var(--vscode-editorWidget-background, #3c3c3c);
        }

        canvas {
            max-width: 100%;
            height: auto;
            border-radius: 2px;
            display: block;
        }

        .text-layer {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            overflow: hidden;
            line-height: 1;
            user-select: text;
            /* pointer-events left at the default 'auto' so text is actually
               selectable/copyable - see the annotate-mode override below, which
               turns this back off so it doesn't fight with placing sticky notes. */
        }

        #viewer-container:not(.annotate-cursor) .text-layer {
            cursor: text;
        }

        #viewer-container.annotate-cursor .text-layer {
            pointer-events: none;
        }

        .text-layer ::selection {
            background: var(--vscode-editor-selectionBackground, rgba(0, 120, 215, 0.35));
        }

        .text-layer > span {
            position: absolute;
            color: transparent;
            white-space: pre;
            transform-origin: 0% 0%;
        }

        .text-layer span.search-match {
            background-color: var(--vscode-editor-findMatchHighlightBackground, rgba(255, 224, 0, 0.4));
            border-radius: 2px;
        }

        .text-layer span.search-match-current {
            background-color: var(--vscode-editor-findMatchBackground, rgba(255, 140, 0, 0.85));
            border-radius: 2px;
        }

        .toolbar-btn.active {
            background-color: var(--vscode-list-activeSelectionBackground, rgba(0, 122, 204, 0.45));
        }

        #viewer-container.annotate-cursor {
            cursor: crosshair;
        }

        .annotation-layer {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
        }

        .annotation-pin {
            position: absolute;
            transform: translate(-50%, -100%);
            font-size: 20px;
            line-height: 1;
            cursor: pointer;
            pointer-events: auto;
            user-select: none;
            filter: drop-shadow(0 1px 2px rgba(0,0,0,0.6));
        }

        .annotation-popup {
            position: fixed;
            z-index: 500;
            width: 220px;
            box-sizing: border-box;
            background-color: var(--toolbar-bg);
            border: 1px solid var(--border-color);
            border-radius: 6px;
            box-shadow: var(--shadow);
            padding: 10px;
            font-size: 12px;
            color: var(--text-color);
        }

        .annotation-popup-text {
            white-space: pre-wrap;
            word-break: break-word;
            max-height: 160px;
            overflow-y: auto;
            margin-bottom: 8px;
        }

        .annotation-popup-textarea {
            width: 100%;
            box-sizing: border-box;
            min-height: 60px;
            background-color: var(--input-bg);
            border: 1px solid var(--input-border);
            color: var(--text-color);
            border-radius: 3px;
            padding: 6px;
            font-size: 12px;
            font-family: inherit;
            resize: vertical;
            margin-bottom: 8px;
        }

        .annotation-popup-actions {
            display: flex;
            justify-content: flex-end;
            gap: 6px;
        }

        .annotation-popup-actions .toolbar-btn.text-btn {
            background-color: rgba(255,255,255,0.08);
        }

        #search-bar {
            position: fixed;
            top: 56px;
            right: 20px;
            background-color: var(--toolbar-bg);
            border: 1px solid var(--border-color);
            border-radius: 6px;
            box-shadow: var(--shadow);
            padding: 6px 8px;
            display: flex;
            align-items: center;
            gap: 4px;
            z-index: 200;
        }

        #search-bar.hidden {
            display: none;
        }

        #search-input {
            background-color: var(--input-bg);
            border: 1px solid var(--input-border);
            color: var(--text-color);
            border-radius: 3px;
            padding: 5px 8px;
            font-size: 12px;
            width: 180px;
        }

        #search-counter {
            font-size: 12px;
            color: var(--muted-text-color);
            min-width: 56px;
            text-align: center;
            white-space: nowrap;
        }

        #bookmarks-panel {
            position: fixed;
            top: 56px;
            right: 20px;
            width: 240px;
            max-height: 320px;
            background-color: var(--toolbar-bg);
            border: 1px solid var(--border-color);
            border-radius: 6px;
            box-shadow: var(--shadow);
            padding: 10px;
            z-index: 200;
            display: flex;
            flex-direction: column;
            gap: 8px;
        }

        #bookmarks-panel.hidden {
            display: none;
        }

        .bookmarks-header {
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .bookmarks-header .toolbar-btn.text-btn {
            flex: 1;
            text-align: left;
            background-color: var(--hover-bg);
        }

        #bookmarks-list {
            overflow-y: auto;
            display: flex;
            flex-direction: column;
            gap: 4px;
        }

        .bookmark-item {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 6px 8px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            color: var(--text-color);
        }

        .bookmark-item:hover {
            background-color: var(--hover-bg);
        }

        .bookmark-item .bookmark-label {
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .bookmark-remove {
            background: transparent;
            border: none;
            color: var(--muted-text-color);
            cursor: pointer;
            font-size: 14px;
            line-height: 1;
            padding: 0 2px;
        }

        .bookmark-remove:hover {
            color: var(--text-color);
        }

        .bookmarks-empty {
            font-size: 12px;
            color: var(--muted-text-color);
            text-align: center;
            padding: 12px 0;
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
            border-top: 4px solid var(--accent-color);
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
            background: var(--bg-color);
        }
        ::-webkit-scrollbar-thumb {
            background: var(--vscode-scrollbarSlider-background, #555);
            border: 3px solid var(--bg-color);
            border-radius: 10px;
        }
        ::-webkit-scrollbar-thumb:hover {
            background: var(--vscode-scrollbarSlider-hoverBackground, #888);
        }
    </style>
</head>
<body>
    <div id="toolbar">
        <button id="toggle-sidebar" class="toolbar-btn" title="Toggle thumbnails" disabled>&#9776;</button>
        <button id="toggle-search" class="toolbar-btn" title="Find in document (Ctrl/Cmd+F)" disabled>&#128269;</button>
        <button id="toggle-annotate" class="toolbar-btn" title="Add a sticky note" disabled>&#128204;</button>
        <button id="toggle-bookmarks" class="toolbar-btn" title="Bookmarks" disabled>&#128278;</button>
        <div class="title">📄 ${fileName}</div>
        <div class="toolbar-spacer"></div>
        <div class="toolbar-group" id="page-nav">
            <button id="prev-page" class="toolbar-btn" title="Previous page" disabled>&#9650;</button>
            <input id="page-input" type="number" min="1" value="1" disabled />
            <span class="page-sep">/ <span id="page-count">&ndash;</span></span>
            <button id="next-page" class="toolbar-btn" title="Next page" disabled>&#9660;</button>
        </div>
        <div class="toolbar-group" id="zoom-controls">
            <button id="zoom-out" class="toolbar-btn" title="Zoom out" disabled>&minus;</button>
            <span id="zoom-level">100%</span>
            <button id="zoom-in" class="toolbar-btn" title="Zoom in" disabled>&plus;</button>
            <button id="zoom-fit-width" class="toolbar-btn text-btn" title="Fit width" disabled>Fit Width</button>
        </div>
    </div>

    <div id="search-bar" class="hidden">
        <input id="search-input" type="text" placeholder="Find in document" />
        <span id="search-counter"></span>
        <button id="search-prev" class="toolbar-btn" title="Previous match">&#9650;</button>
        <button id="search-next" class="toolbar-btn" title="Next match">&#9660;</button>
        <button id="search-close" class="toolbar-btn" title="Close">&times;</button>
    </div>

    <div id="bookmarks-panel" class="hidden">
        <div class="bookmarks-header">
            <button id="bookmark-toggle-current" class="toolbar-btn text-btn">&#9734; Bookmark this page</button>
            <button id="bookmarks-close" class="toolbar-btn" title="Close">&times;</button>
        </div>
        <div id="bookmarks-list"></div>
    </div>

    <div id="loading-overlay">
        <div class="spinner"></div>
        <div id="loading-text">Loading PDF document...</div>
    </div>

    <div id="content">
        <div id="thumbnail-sidebar"></div>
        <div id="viewer-container"></div>
    </div>

    <script nonce="${nonce}">
        const vscodeApi = acquireVsCodeApi();

        const container = document.getElementById('viewer-container');
        const loadingOverlay = document.getElementById('loading-overlay');
        const loadingText = document.getElementById('loading-text');

        const toggleSidebarBtn = document.getElementById('toggle-sidebar');
        const thumbnailSidebar = document.getElementById('thumbnail-sidebar');

        const toggleSearchBtn = document.getElementById('toggle-search');
        const searchBar = document.getElementById('search-bar');
        const searchInput = document.getElementById('search-input');
        const searchCounterEl = document.getElementById('search-counter');
        const searchPrevBtn = document.getElementById('search-prev');
        const searchNextBtn = document.getElementById('search-next');
        const searchCloseBtn = document.getElementById('search-close');

        const toggleAnnotateBtn = document.getElementById('toggle-annotate');

        const toggleBookmarksBtn = document.getElementById('toggle-bookmarks');
        const bookmarksPanel = document.getElementById('bookmarks-panel');
        const bookmarksListEl = document.getElementById('bookmarks-list');
        const bookmarkToggleCurrentBtn = document.getElementById('bookmark-toggle-current');
        const bookmarksCloseBtn = document.getElementById('bookmarks-close');

        const prevPageBtn = document.getElementById('prev-page');
        const nextPageBtn = document.getElementById('next-page');
        const pageInput = document.getElementById('page-input');
        const pageCountEl = document.getElementById('page-count');
        const zoomOutBtn = document.getElementById('zoom-out');
        const zoomInBtn = document.getElementById('zoom-in');
        const zoomFitWidthBtn = document.getElementById('zoom-fit-width');
        const zoomLevelEl = document.getElementById('zoom-level');

        function showError(message) {
            loadingText.innerHTML = '';
            loadingText.textContent = 'Failed to load PDF: ' + message;
            loadingText.style.color = 'var(--vscode-errorForeground, #ff4d4d)';
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

        // ---- Shared state -------------------------------------------------
        let pdfDoc = null;          // the loaded PDFDocumentProxy, reused across zoom re-renders
        let totalPages = 0;
        let currentPage = 1;
        let currentScale = 1.5;     // pdf.js viewport scale; BASE_SCALE below maps this to "100%"
        const BASE_SCALE = 1.5;
        const MIN_SCALE = 0.375;    // ~25%
        const MAX_SCALE = 6.0;      // ~400%
        const ZOOM_STEP = BASE_SCALE * 0.1; // 10% per click

        let lazyRenderObserver = null;
        let currentPageObserver = null;
        let thumbRenderObserver = null;
        const THUMB_WIDTH = 100;

        // Reused for measuring how wide the text layer's browser-rendered spans
        // come out, so they can be horizontally corrected to match the actual
        // on-canvas glyph widths (see buildTextLayer) - the invisible text layer's
        // font never exactly matches the PDF's embedded font, so without this,
        // selection boundaries would drift from the visible text as strings get longer.
        const measureCtx = document.createElement('canvas').getContext('2d');

        // ---- Search state ---------------------------------------------------
        const pageTextCache = new Map(); // pageNum -> pdf.js textContent, extracted once per page
        let searchQuery = '';
        let searchToken = 0;             // race-guard: a stale in-flight search checks this before continuing
        let searchInProgress = false;
        let matches = [];                // { pageNum, itemIndex }[]
        let currentMatchIndex = -1;

        // ---- Annotation state -------------------------------------------------
        let annotations = [];            // { id, pageNum, xRatio, yRatio, text, createdAt }[], from extension storage
        let annotateMode = false;
        let activeAnnotationPopup = null;

        // ---- Bookmarks + last-viewed-position state ----------------------------
        let bookmarks = [];              // { pageNum, label, createdAt }[], from extension storage
        let pendingViewState = null;     // { page, scale } to restore once the doc has loaded, then discarded
        let isRestoringView = false;     // true while renderPdf is applying pendingViewState; suppresses saves so the intersection-observer's page-1 blip during initial layout can't clobber the state we're mid-restore of
        let viewStateSaveTimer = null;

        function updateZoomLabel() {
            zoomLevelEl.textContent = Math.round((currentScale / BASE_SCALE) * 100) + '%';
        }

        // Debounced save of the current page + zoom, so rapid scrolling/zooming
        // doesn't spam the extension host with a message per intermediate step -
        // it settles ~400ms after the last change before persisting normally.
        //
        // That debounce alone isn't enough for "resume where I left off" though:
        // if the tab is closed before the timer fires, the pending save is lost
        // and the last *persisted* state is stale (often still page 1). There's no
        // hook for the extension host to pull final state from a webview that's
        // already being torn down, so instead we flush immediately (bypassing the
        // debounce) the moment this document becomes hidden or is about to unload -
        // both of which reliably fire when a tab is closed or switched away from,
        // even with retainContextWhenHidden keeping the script alive in the background.
        function scheduleViewStateSave() {
            if (!pdfDoc || isRestoringView) return;
            clearTimeout(viewStateSaveTimer);
            viewStateSaveTimer = setTimeout(flushViewStateSave, 400);
        }

        function flushViewStateSave() {
            if (!pdfDoc || isRestoringView) {
                console.log('[pdfDisplay] flushViewStateSave skipped', { hasPdfDoc: !!pdfDoc, isRestoringView });
                return;
            }
            clearTimeout(viewStateSaveTimer);
            console.log('[pdfDisplay] sending save-view-state', { page: currentPage, scale: currentScale });
            vscodeApi.postMessage({ type: 'save-view-state', page: currentPage, scale: currentScale });
        }

        document.addEventListener('visibilitychange', () => {
            console.log('[pdfDisplay] visibilitychange, state=', document.visibilityState);
            if (document.visibilityState === 'hidden') {
                flushViewStateSave();
            }
        });
        window.addEventListener('pagehide', () => {
            console.log('[pdfDisplay] pagehide fired');
            flushViewStateSave();
        });

        function updatePageControls() {
            pageInput.value = String(currentPage);
            pageCountEl.textContent = String(totalPages);
            prevPageBtn.disabled = currentPage <= 1;
            nextPageBtn.disabled = currentPage >= totalPages;
            updateActiveThumbnail();
            updateBookmarkToggleLabel();
            scheduleViewStateSave();
        }

        function enableToolbar() {
            [prevPageBtn, nextPageBtn, pageInput, zoomOutBtn, zoomInBtn, zoomFitWidthBtn, toggleSidebarBtn, toggleSearchBtn, toggleAnnotateBtn, toggleBookmarksBtn].forEach(el => el.disabled = false);
        }

        toggleSidebarBtn.addEventListener('click', () => {
            thumbnailSidebar.classList.toggle('collapsed');
        });

        // Builds the thumbnail strip once per document (independent of zoom level -
        // thumbnails always render at a small fixed width). Lazily renders each
        // thumbnail as it scrolls into view within the sidebar, same pattern as
        // the main page viewer.
        async function buildThumbnails() {
            thumbnailSidebar.innerHTML = '';
            if (thumbRenderObserver) thumbRenderObserver.disconnect();

            thumbRenderObserver = new IntersectionObserver((entries) => {
                for (const entry of entries) {
                    if (entry.isIntersecting) {
                        const el = entry.target;
                        thumbRenderObserver.unobserve(el);
                        renderThumbnail(el);
                    }
                }
            }, { root: thumbnailSidebar, rootMargin: '300px 0px' });

            for (let i = 1; i <= totalPages; i++) {
                const page = await pdfDoc.getPage(i);
                const naturalViewport = page.getViewport({ scale: 1 });
                const scale = THUMB_WIDTH / naturalViewport.width;
                const viewport = page.getViewport({ scale });

                const thumb = document.createElement('div');
                thumb.className = 'thumb-container thumb-placeholder';
                thumb.dataset.pageNumber = String(i);
                thumb.style.width = viewport.width + 'px';
                thumb.style.height = viewport.height + 'px';
                thumb.title = 'Page ' + i;
                thumb.addEventListener('click', () => scrollToPage(i));

                const label = document.createElement('span');
                label.className = 'thumb-page-number';
                label.textContent = String(i);
                thumb.appendChild(label);

                thumbnailSidebar.appendChild(thumb);
                thumbRenderObserver.observe(thumb);
            }

            updateActiveThumbnail();
        }

        async function renderThumbnail(thumbEl) {
            const pageNum = Number(thumbEl.dataset.pageNumber);
            try {
                const page = await pdfDoc.getPage(pageNum);
                const naturalViewport = page.getViewport({ scale: 1 });
                const scale = THUMB_WIDTH / naturalViewport.width;
                const viewport = page.getViewport({ scale });
                const dpr = window.devicePixelRatio || 1;

                const canvas = document.createElement('canvas');
                const context = canvas.getContext('2d');
                canvas.width = Math.floor(viewport.width * dpr);
                canvas.height = Math.floor(viewport.height * dpr);
                canvas.style.width = viewport.width + 'px';
                canvas.style.height = viewport.height + 'px';

                const label = thumbEl.querySelector('.thumb-page-number');
                thumbEl.innerHTML = '';
                thumbEl.appendChild(canvas);
                if (label) thumbEl.appendChild(label);

                const transform = dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined;
                await page.render({ canvasContext: context, viewport, transform }).promise;
            } catch (err) {
                // A failed thumbnail shouldn't disrupt the main viewer; leave the placeholder as-is.
            }
        }

        function updateActiveThumbnail() {
            const thumbs = thumbnailSidebar.querySelectorAll('.thumb-container');
            let activeThumb = null;
            thumbs.forEach(t => {
                const isActive = Number(t.dataset.pageNumber) === currentPage;
                t.classList.toggle('active', isActive);
                if (isActive) activeThumb = t;
            });
            if (activeThumb) {
                activeThumb.scrollIntoView({ block: 'nearest' });
            }
        }

        function clampScale(scale) {
            return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
        }

        // Lazily render pages as they scroll into view instead of rendering
        // every page up front (avoids freezing the UI on large documents).
        function setupLazyRendering() {
            const dpr = window.devicePixelRatio || 1;
            const observer = new IntersectionObserver((entries) => {
                for (const entry of entries) {
                    if (entry.isIntersecting) {
                        const pageContainer = entry.target;
                        observer.unobserve(pageContainer);
                        renderPage(pageContainer, dpr);
                    }
                }
            }, { root: container, rootMargin: '400px 0px' });
            return observer;
        }

        // Tracks which page is most visible so the toolbar's page indicator
        // stays in sync while the user scrolls (not just when they click nav buttons).
        function setupCurrentPageTracking() {
            const observer = new IntersectionObserver((entries) => {
                // While a saved page/zoom is being restored, ignore intersection
                // reports entirely - not just their downstream save. The page-build
                // loop yields to the event loop on every page (each getPage() call
                // round-trips to pdf.js's worker), so the browser can queue several
                // of these notifications reflecting the *pre-restore-scroll* layout
                // (page 1 still visible, since the restore scroll hasn't happened
                // yet). Those can arrive at any point, including after the restore
                // scroll - guarding only the save (as before) still let a stale
                // notification silently overwrite currentPage itself.
                if (isRestoringView) return;

                let best = null;
                for (const entry of entries) {
                    if (entry.isIntersecting && (!best || entry.intersectionRatio > best.intersectionRatio)) {
                        best = entry;
                    }
                }
                if (best) {
                    currentPage = Number(best.target.dataset.pageNumber);
                    updatePageControls();
                }
            }, { root: container, threshold: [0, 0.25, 0.5, 0.75, 1] });
            return observer;
        }

        async function renderPage(pageContainer, dpr) {
            const pageNum = Number(pageContainer.dataset.pageNumber);
            try {
                const page = await pdfDoc.getPage(pageNum);
                const viewport = page.getViewport({ scale: currentScale });

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

                // Invisible text layer, positioned to match the canvas at this scale,
                // used for search highlighting (not wired up for text selection yet).
                const textContent = await getPageText(pageNum);
                buildTextLayer(pageContainer, textContent, viewport);
                if (searchQuery) {
                    applyHighlightForPage(pageNum);
                }

                // Sticky-note pins for this page, positioned from their stored
                // ratio-of-page coordinates so they land correctly at any zoom level.
                buildAnnotationLayer(pageContainer, pageNum, viewport);
            } catch (err) {
                pageContainer.textContent = 'Failed to render page ' + pageNum;
                pageContainer.style.color = 'var(--vscode-errorForeground, #ff4d4d)';
            }
        }

        function buildTextLayer(pageContainer, textContent, viewport) {
            const textLayerDiv = document.createElement('div');
            textLayerDiv.className = 'text-layer';

            textContent.items.forEach((item, idx) => {
                if (!item.str) return;
                // Standard pdf.js text-layer math: combine the item's own transform
                // with the page viewport transform to get its on-screen position.
                // (Assumes an unrotated page, which covers the vast majority of PDFs.)
                const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
                const fontHeight = Math.hypot(tx[2], tx[3]);
                const left = tx[4];
                const top = tx[5] - fontHeight;

                const span = document.createElement('span');
                span.textContent = item.str;
                span.dataset.itemIndex = String(idx);
                span.style.left = left + 'px';
                span.style.top = top + 'px';
                span.style.fontSize = fontHeight + 'px';

                // Horizontally stretch/shrink the span so its rendered width matches
                // the glyph run's true on-canvas width (item.width, in the same
                // pre-viewport text space as item.transform) - our sans-serif stand-in
                // font otherwise measures differently than whatever font the PDF
                // actually embeds, which would make selection drift from the visible
                // text on longer lines.
                if (measureCtx && typeof item.width === 'number' && item.width > 0) {
                    const expectedWidth = item.width * viewport.scale;
                    measureCtx.font = fontHeight + 'px sans-serif';
                    const measuredWidth = measureCtx.measureText(item.str).width;
                    if (measuredWidth > 0) {
                        span.style.transform = 'scaleX(' + (expectedWidth / measuredWidth) + ')';
                    }
                }

                textLayerDiv.appendChild(span);
            });

            pageContainer.appendChild(textLayerDiv);
        }

        // Builds (or rebuilds, on zoom change) the placeholder containers for every
        // page at the current scale and wires up lazy-render + current-page tracking.
        async function layoutPages() {
            if (lazyRenderObserver) lazyRenderObserver.disconnect();
            if (currentPageObserver) currentPageObserver.disconnect();
            container.innerHTML = '';

            lazyRenderObserver = setupLazyRendering();
            currentPageObserver = setupCurrentPageTracking();

            for (let i = 1; i <= totalPages; i++) {
                const page = await pdfDoc.getPage(i);
                const viewport = page.getViewport({ scale: currentScale });

                const pageContainer = document.createElement('div');
                pageContainer.className = 'page-container page-placeholder';
                pageContainer.dataset.pageNumber = String(i);
                pageContainer.style.width = viewport.width + 'px';
                pageContainer.style.height = viewport.height + 'px';

                container.appendChild(pageContainer);
                lazyRenderObserver.observe(pageContainer);
                currentPageObserver.observe(pageContainer);
            }
        }

        function scrollToPage(pageNum) {
            pageNum = Math.min(totalPages, Math.max(1, pageNum));
            const target = container.querySelector('.page-container[data-page-number="' + pageNum + '"]');
            if (target) {
                target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                currentPage = pageNum;
                updatePageControls();
            }
        }

        async function applyZoom(newScale) {
            currentScale = clampScale(newScale);
            updateZoomLabel();
            scheduleViewStateSave();
            const pageToRestore = currentPage;
            await layoutPages();
            // Re-center on roughly the same page after rebuilding at the new scale.
            const target = container.querySelector('.page-container[data-page-number="' + pageToRestore + '"]');
            if (target) target.scrollIntoView({ behavior: 'auto', block: 'start' });
        }

        prevPageBtn.addEventListener('click', () => scrollToPage(currentPage - 1));
        nextPageBtn.addEventListener('click', () => scrollToPage(currentPage + 1));
        pageInput.addEventListener('change', () => {
            const n = parseInt(pageInput.value, 10);
            if (!isNaN(n)) {
                scrollToPage(n);
            } else {
                pageInput.value = String(currentPage);
            }
        });
        pageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') pageInput.blur();
        });

        zoomInBtn.addEventListener('click', () => applyZoom(currentScale + ZOOM_STEP));
        zoomOutBtn.addEventListener('click', () => applyZoom(currentScale - ZOOM_STEP));
        zoomFitWidthBtn.addEventListener('click', async () => {
            if (!pdfDoc) return;
            const firstPage = await pdfDoc.getPage(1);
            const naturalViewport = firstPage.getViewport({ scale: 1 });
            const availableWidth = container.clientWidth - 48; // leave a little breathing room
            applyZoom(availableWidth / naturalViewport.width);
        });

        // ---- Search -----------------------------------------------------------

        async function getPageText(pageNum) {
            if (pageTextCache.has(pageNum)) return pageTextCache.get(pageNum);
            const page = await pdfDoc.getPage(pageNum);
            const textContent = await page.getTextContent();
            pageTextCache.set(pageNum, textContent);
            return textContent;
        }

        function clearAllHighlights() {
            // Rebuild every rendered span back to its plain source text (this also
            // undoes the word-level <span> wrapping used for highlighting below).
            container.querySelectorAll('.text-layer span[data-item-index]').forEach(span => {
                const pageContainer = span.closest('.page-container');
                const pageNum = pageContainer && Number(pageContainer.dataset.pageNumber);
                const textContent = pageNum && pageTextCache.get(pageNum);
                const idx = Number(span.dataset.itemIndex);
                const itemStr = (textContent && textContent.items[idx] && textContent.items[idx].str);
                span.textContent = itemStr !== undefined ? itemStr : span.textContent;
            });
        }

        // Wraps just the matched substring(s) of a text item in their own inline
        // <span class="search-match">, leaving the rest of the item as plain text -
        // so the highlight box only covers the searched word, not the whole line.
        function renderSpanWithHighlights(span, itemStr, occurrences) {
            span.innerHTML = '';
            let cursor = 0;
            occurrences.forEach(occ => {
                if (occ.charStart > cursor) {
                    span.appendChild(document.createTextNode(itemStr.slice(cursor, occ.charStart)));
                }
                const mark = document.createElement('span');
                mark.className = 'search-match' + (occ.isCurrent ? ' search-match-current' : '');
                mark.textContent = itemStr.slice(occ.charStart, occ.charEnd);
                span.appendChild(mark);
                cursor = occ.charEnd;
            });
            if (cursor < itemStr.length) {
                span.appendChild(document.createTextNode(itemStr.slice(cursor)));
            }
        }

        // Applies highlight spans to whatever text-layer spans currently exist for
        // a page (only rendered pages have a text layer at all - unrendered pages
        // get caught up automatically since renderPage() calls this itself once
        // its text layer is built, see renderPage above). Fully deterministic: every
        // span on the page is reset from source text and only matched items are
        // re-wrapped, so calling this is always safe even if a previous search left
        // different spans highlighted.
        function applyHighlightForPage(pageNum) {
            const pageContainer = container.querySelector('.page-container[data-page-number="' + pageNum + '"]');
            const textLayer = pageContainer && pageContainer.querySelector('.text-layer');
            const textContent = pageTextCache.get(pageNum);
            if (!textLayer || !textContent) return;

            const byItem = new Map();
            matches.forEach((m, i) => {
                if (m.pageNum !== pageNum) return;
                if (!byItem.has(m.itemIndex)) byItem.set(m.itemIndex, []);
                byItem.get(m.itemIndex).push({ charStart: m.charStart, charEnd: m.charEnd, isCurrent: i === currentMatchIndex });
            });

            textLayer.querySelectorAll('span[data-item-index]').forEach(span => {
                const idx = Number(span.dataset.itemIndex);
                const itemStr = (textContent.items[idx] && textContent.items[idx].str) || '';
                const occurrences = byItem.get(idx);
                if (occurrences) {
                    renderSpanWithHighlights(span, itemStr, occurrences.sort((a, b) => a.charStart - b.charStart));
                } else {
                    span.textContent = itemStr;
                }
            });
        }

        // Re-applies highlighting to every page that's currently rendered (has a
        // text layer), based on the current matches / currentMatchIndex state.
        function refreshAllHighlights() {
            container.querySelectorAll('.page-container').forEach(pageContainer => {
                if (pageContainer.querySelector('.text-layer')) {
                    applyHighlightForPage(Number(pageContainer.dataset.pageNumber));
                }
            });
        }

        function updateSearchCounter() {
            if (!searchQuery) {
                searchCounterEl.textContent = '';
            } else if (matches.length === 0) {
                searchCounterEl.textContent = searchInProgress ? 'Searching…' : 'No results';
            } else {
                searchCounterEl.textContent = (currentMatchIndex + 1) + ' of ' + matches.length + (searchInProgress ? '+' : '');
            }
        }

        // Forces a specific (possibly not-yet-scrolled-to) page to render immediately,
        // bypassing the lazy IntersectionObserver, so a search match on it can be
        // highlighted and scrolled to right away.
        async function ensurePageRendered(pageNum) {
            const pageContainer = container.querySelector('.page-container[data-page-number="' + pageNum + '"]');
            if (!pageContainer || pageContainer.querySelector('canvas')) return;
            if (lazyRenderObserver) lazyRenderObserver.unobserve(pageContainer);
            const dpr = window.devicePixelRatio || 1;
            await renderPage(pageContainer, dpr);
        }

        async function goToMatch(index) {
            if (matches.length === 0) return;
            currentMatchIndex = ((index % matches.length) + matches.length) % matches.length;
            updateSearchCounter();

            const match = matches[currentMatchIndex];
            await ensurePageRendered(match.pageNum);
            refreshAllHighlights();

            const pageContainer = container.querySelector('.page-container[data-page-number="' + match.pageNum + '"]');
            const textLayer = pageContainer && pageContainer.querySelector('.text-layer');
            const currentMark = textLayer && textLayer.querySelector('.search-match-current');
            if (currentMark) {
                currentMark.scrollIntoView({ behavior: 'smooth', block: 'center' });
            } else {
                scrollToPage(match.pageNum);
            }
        }

        async function runSearch(query) {
            const myToken = ++searchToken;
            searchQuery = query.trim();
            matches = [];
            currentMatchIndex = -1;
            clearAllHighlights();
            updateSearchCounter();

            if (!searchQuery || !pdfDoc) return;

            searchInProgress = true;
            const lowerQuery = searchQuery.toLowerCase();

            for (let p = 1; p <= totalPages; p++) {
                if (myToken !== searchToken) return; // a newer search superseded this one
                const textContent = await getPageText(p);
                textContent.items.forEach((item, idx) => {
                    if (!item.str) return;
                    const lowerItem = item.str.toLowerCase();
                    let searchFrom = 0;
                    while (true) {
                        const foundAt = lowerItem.indexOf(lowerQuery, searchFrom);
                        if (foundAt === -1) break;
                        matches.push({ pageNum: p, itemIndex: idx, charStart: foundAt, charEnd: foundAt + lowerQuery.length });
                        searchFrom = foundAt + lowerQuery.length;
                    }
                });
                applyHighlightForPage(p); // no-op if page isn't rendered yet
                updateSearchCounter();
            }

            if (myToken !== searchToken) return;
            searchInProgress = false;

            if (matches.length > 0) {
                goToMatch(0);
            } else {
                updateSearchCounter();
            }
        }

        let searchDebounceTimer = null;
        searchInput.addEventListener('input', () => {
            clearTimeout(searchDebounceTimer);
            searchDebounceTimer = setTimeout(() => runSearch(searchInput.value), 300);
        });
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                clearTimeout(searchDebounceTimer);
                if (searchQuery === searchInput.value.trim() && matches.length > 0) {
                    goToMatch(currentMatchIndex + (e.shiftKey ? -1 : 1));
                } else {
                    runSearch(searchInput.value);
                }
            } else if (e.key === 'Escape') {
                closeSearch();
            }
        });
        searchPrevBtn.addEventListener('click', () => goToMatch(currentMatchIndex - 1));
        searchNextBtn.addEventListener('click', () => goToMatch(currentMatchIndex + 1));
        searchCloseBtn.addEventListener('click', closeSearch);

        function openSearch() {
            closeBookmarksPanel();
            searchBar.classList.remove('hidden');
            searchInput.focus();
            searchInput.select();
        }

        function closeSearch() {
            searchBar.classList.add('hidden');
            searchInput.value = '';
            runSearch('');
        }

        toggleSearchBtn.addEventListener('click', () => {
            if (searchBar.classList.contains('hidden')) {
                openSearch();
            } else {
                closeSearch();
            }
        });

        // Ctrl/Cmd+F opens the in-document search instead of the browser's own find.
        window.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && !toggleSearchBtn.disabled) {
                e.preventDefault();
                openSearch();
            } else if (e.key === 'Escape' && activeAnnotationPopup) {
                closeAnnotationPopup();
            }
        });

        // ---- Sticky-note annotations -------------------------------------------
        // Persisted via postMessage to the extension host, which stores them in
        // VS Code's globalState keyed per-document (see storeAnnotations in
        // extension.ts), so they survive closing and reopening the file.

        function createAnnotationId() {
            return 'ann_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
        }

        function persistAnnotations() {
            vscodeApi.postMessage({ type: 'save-annotations', annotations });
        }

        function pinPosition(annotation, viewport) {
            return {
                left: annotation.xRatio * viewport.width,
                top: annotation.yRatio * viewport.height
            };
        }

        function createPinElement(annotation, viewport) {
            const pin = document.createElement('div');
            pin.className = 'annotation-pin';
            pin.dataset.annotationId = annotation.id;
            const pos = pinPosition(annotation, viewport);
            pin.style.left = pos.left + 'px';
            pin.style.top = pos.top + 'px';
            pin.textContent = '📌';
            pin.title = annotation.text;
            pin.addEventListener('click', (e) => {
                e.stopPropagation();
                openAnnotationPopup(annotation, pin, 'view');
            });
            return pin;
        }

        // Rebuilt every time a page renders (including on zoom changes), same
        // pattern as the text layer - pins are positioned from a page-relative
        // ratio so they land correctly at any scale.
        function buildAnnotationLayer(pageContainer, pageNum, viewport) {
            const layer = document.createElement('div');
            layer.className = 'annotation-layer';
            annotations
                .filter(a => a.pageNum === pageNum)
                .forEach(a => layer.appendChild(createPinElement(a, viewport)));
            pageContainer.appendChild(layer);
            return layer;
        }

        function closeAnnotationPopup() {
            if (activeAnnotationPopup) {
                activeAnnotationPopup.remove();
                activeAnnotationPopup = null;
            }
        }

        function deleteAnnotation(id) {
            const idx = annotations.findIndex(a => a.id === id);
            if (idx !== -1) annotations.splice(idx, 1);
            document.querySelectorAll('.annotation-pin[data-annotation-id="' + id + '"]').forEach(p => p.remove());
            persistAnnotations();
            closeAnnotationPopup();
        }

        // mode: 'view' (read existing note) | 'edit' (editing existing note) | 'new' (creating one)
        function openAnnotationPopup(annotation, pinEl, mode) {
            closeAnnotationPopup();

            const rect = pinEl.getBoundingClientRect();
            const popup = document.createElement('div');
            popup.className = 'annotation-popup';
            popup.style.left = Math.max(8, Math.min(window.innerWidth - 236, rect.left)) + 'px';
            popup.style.top = (rect.bottom + 6) + 'px';
            popup.addEventListener('click', (e) => e.stopPropagation());

            if (mode === 'view') {
                const textEl = document.createElement('div');
                textEl.className = 'annotation-popup-text';
                textEl.textContent = annotation.text;
                popup.appendChild(textEl);

                const actions = document.createElement('div');
                actions.className = 'annotation-popup-actions';

                const editBtn = document.createElement('button');
                editBtn.className = 'toolbar-btn text-btn';
                editBtn.textContent = 'Edit';
                editBtn.addEventListener('click', () => openAnnotationPopup(annotation, pinEl, 'edit'));

                const deleteBtn = document.createElement('button');
                deleteBtn.className = 'toolbar-btn text-btn';
                deleteBtn.textContent = 'Delete';
                deleteBtn.addEventListener('click', () => deleteAnnotation(annotation.id));

                actions.appendChild(editBtn);
                actions.appendChild(deleteBtn);
                popup.appendChild(actions);
            } else {
                const textarea = document.createElement('textarea');
                textarea.className = 'annotation-popup-textarea';
                textarea.placeholder = 'Add a note…';
                textarea.value = mode === 'edit' ? annotation.text : '';
                popup.appendChild(textarea);

                const actions = document.createElement('div');
                actions.className = 'annotation-popup-actions';

                const saveBtn = document.createElement('button');
                saveBtn.className = 'toolbar-btn text-btn';
                saveBtn.textContent = 'Save';
                saveBtn.addEventListener('click', () => {
                    const value = textarea.value.trim();
                    if (!value) {
                        if (mode === 'new') pinEl.remove(); // discard empty note, never persisted
                        closeAnnotationPopup();
                        return;
                    }
                    annotation.text = value;
                    pinEl.title = value;
                    if (mode === 'new') annotations.push(annotation);
                    persistAnnotations();
                    closeAnnotationPopup();
                });

                const cancelBtn = document.createElement('button');
                cancelBtn.className = 'toolbar-btn text-btn';
                cancelBtn.textContent = 'Cancel';
                cancelBtn.addEventListener('click', () => {
                    if (mode === 'new') pinEl.remove(); // was never added to the annotations array, just drop the pin
                    closeAnnotationPopup();
                });

                actions.appendChild(saveBtn);
                actions.appendChild(cancelBtn);
                popup.appendChild(actions);
                setTimeout(() => textarea.focus(), 0);
            }

            document.body.appendChild(popup);
            activeAnnotationPopup = popup;
        }

        // Click anywhere outside the popup dismisses it (pin clicks stopPropagation
        // above, so re-opening a pin's own popup doesn't immediately close it here).
        document.addEventListener('click', (e) => {
            if (activeAnnotationPopup && !activeAnnotationPopup.contains(e.target)) {
                closeAnnotationPopup();
            }
        });

        function setAnnotateMode(value) {
            annotateMode = value;
            toggleAnnotateBtn.classList.toggle('active', value);
            container.classList.toggle('annotate-cursor', value);
        }

        toggleAnnotateBtn.addEventListener('click', () => setAnnotateMode(!annotateMode));

        // Delegated click handler: placing a new note. Pins themselves stopPropagation
        // so this only fires for clicks on empty page area while annotate mode is on.
        container.addEventListener('click', async (e) => {
            if (!annotateMode) return;
            const pageContainer = e.target.closest('.page-container');
            if (!pageContainer) return;

            const pageNum = Number(pageContainer.dataset.pageNumber);
            await ensurePageRendered(pageNum);

            const rect = pageContainer.getBoundingClientRect();
            const xRatio = (e.clientX - rect.left) / rect.width;
            const yRatio = (e.clientY - rect.top) / rect.height;

            const annotation = { id: createAnnotationId(), pageNum, xRatio, yRatio, text: '', createdAt: Date.now() };
            const page = await pdfDoc.getPage(pageNum);
            const viewport = page.getViewport({ scale: currentScale });

            let layer = pageContainer.querySelector('.annotation-layer');
            if (!layer) {
                layer = document.createElement('div');
                layer.className = 'annotation-layer';
                pageContainer.appendChild(layer);
            }
            const pin = createPinElement(annotation, viewport);
            layer.appendChild(pin);
            openAnnotationPopup(annotation, pin, 'new');

            setAnnotateMode(false); // one note per activation keeps this predictable
            e.stopPropagation(); // don't let the document-level "click outside" listener close the popup we just opened
        });

        // ---- Bookmarks ----------------------------------------------------------
        // Persisted the same way as annotations: postMessage to the extension host,
        // which stores them in globalState keyed per-document (see storeBookmarks
        // in extension.ts).

        function persistBookmarks() {
            vscodeApi.postMessage({ type: 'save-bookmarks', bookmarks });
        }

        function isPageBookmarked(pageNum) {
            return bookmarks.some(b => b.pageNum === pageNum);
        }

        function updateBookmarkToggleLabel() {
            if (!bookmarkToggleCurrentBtn) return;
            bookmarkToggleCurrentBtn.innerHTML = isPageBookmarked(currentPage)
                ? '&#9733; Remove bookmark'
                : '&#9734; Bookmark this page';
        }

        function renderBookmarksList() {
            bookmarksListEl.innerHTML = '';

            if (bookmarks.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'bookmarks-empty';
                empty.textContent = 'No bookmarks yet';
                bookmarksListEl.appendChild(empty);
                return;
            }

            bookmarks
                .slice()
                .sort((a, b) => a.pageNum - b.pageNum)
                .forEach(b => {
                    const item = document.createElement('div');
                    item.className = 'bookmark-item';

                    const label = document.createElement('span');
                    label.className = 'bookmark-label';
                    label.textContent = b.label || ('Page ' + b.pageNum);
                    item.appendChild(label);

                    const removeBtn = document.createElement('button');
                    removeBtn.className = 'bookmark-remove';
                    removeBtn.title = 'Remove bookmark';
                    removeBtn.textContent = '\u00d7';
                    removeBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        bookmarks = bookmarks.filter(x => x.pageNum !== b.pageNum);
                        persistBookmarks();
                        renderBookmarksList();
                        updateBookmarkToggleLabel();
                    });
                    item.appendChild(removeBtn);

                    item.addEventListener('click', () => scrollToPage(b.pageNum));

                    bookmarksListEl.appendChild(item);
                });
        }

        bookmarkToggleCurrentBtn.addEventListener('click', () => {
            if (isPageBookmarked(currentPage)) {
                bookmarks = bookmarks.filter(b => b.pageNum !== currentPage);
            } else {
                bookmarks.push({ pageNum: currentPage, label: 'Page ' + currentPage, createdAt: Date.now() });
            }
            persistBookmarks();
            renderBookmarksList();
            updateBookmarkToggleLabel();
        });

        function openBookmarksPanel() {
            closeSearch();
            bookmarksPanel.classList.remove('hidden');
            renderBookmarksList();
        }

        function closeBookmarksPanel() {
            bookmarksPanel.classList.add('hidden');
        }

        toggleBookmarksBtn.addEventListener('click', () => {
            if (bookmarksPanel.classList.contains('hidden')) {
                openBookmarksPanel();
            } else {
                closeBookmarksPanel();
            }
        });
        bookmarksCloseBtn.addEventListener('click', closeBookmarksPanel);

        async function renderPdf(bytes) {
            try {
                // bytes arrives as a plain number array (see extension-side comment on
                // why we don't rely on Uint8Array surviving postMessage) - pdf.js
                // requires an actual TypedArray/string/array-like, so rebuild it here.
                const typedBytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
                const loadingTask = pdfjsLib.getDocument({ data: typedBytes });
                pdfDoc = await loadingTask.promise;
                totalPages = pdfDoc.numPages;

                // Restore the last-viewed page/zoom (if any) before the first render,
                // so pages come up already at the right scale instead of flashing
                // default zoom and then re-rendering.
                if (pendingViewState && typeof pendingViewState.scale === 'number') {
                    currentScale = clampScale(pendingViewState.scale);
                }
                // Capture the restore target in a local const, independent of the
                // currentPage variable - layoutPages() below populates placeholders
                // top-down while the viewport is still scrolled to the top, so the
                // current-page IntersectionObserver fires mid-layout reporting page 1
                // as visible and overwrites currentPage before we get a chance to
                // scroll. Using a local snapshot means that blip can't defeat the restore.
                const targetPage = (pendingViewState && typeof pendingViewState.page === 'number')
                    ? Math.min(totalPages, Math.max(1, pendingViewState.page))
                    : 1;
                currentPage = targetPage;
                console.log('[pdfDisplay] computed targetPage=', targetPage, 'from pendingViewState=', pendingViewState, 'totalPages=', totalPages);

                loadingOverlay.style.display = 'none';

                // Also suppress view-state saves entirely while restoring - the same
                // IntersectionObserver blip would otherwise schedule (and eventually
                // flush) a save of the wrong page 1, quietly corrupting the very state
                // we're in the middle of restoring.
                isRestoringView = true;

                updateZoomLabel();
                updatePageControls();
                enableToolbar();

                await layoutPages();
                buildThumbnails(); // independent of zoom level, no need to block on it

                // Reassert the target in case the observer clobbered it during layout,
                // then jump there for real.
                currentPage = targetPage;
                if (targetPage > 1) {
                    // Instant jump, not a smooth animated scroll - restoring position
                    // on open should feel like "it was already there", not a scroll gesture.
                    const target = container.querySelector('.page-container[data-page-number="' + targetPage + '"]');
                    console.log('[pdfDisplay] restoring scroll to page', targetPage, 'found target element:', !!target);
                    if (target) target.scrollIntoView({ behavior: 'auto', block: 'start' });
                }
                updatePageControls();

                // Don't lift the restore guard immediately: the page-building loop
                // above yields to the event loop on every single page (each
                // pdfDoc.getPage() call round-trips to pdf.js's worker), giving the
                // browser several chances to queue current-page IntersectionObserver
                // notifications based on the *pre-scroll* layout. Those can still
                // arrive after this point - the observer callback itself now checks
                // isRestoringView and ignores them entirely while this guard is up
                // (previously only the save was guarded, which wasn't enough - a
                // stale notification could still overwrite currentPage directly).
                // A plain setTimeout (rather than requestAnimationFrame) is used to
                // lift the guard since rAF isn't guaranteed to fire promptly if the
                // tab isn't focused/visible right when the document finishes loading.
                setTimeout(() => {
                    currentPage = targetPage;
                    updatePageControls();
                    pendingViewState = null;
                    isRestoringView = false;
                    console.log('[pdfDisplay] restore guard lifted, currentPage=', currentPage);
                }, 500);
            } catch (error) {
                isRestoringView = false;
                // Password-protected or otherwise encrypted PDFs surface here too;
                // give a clearer hint for that common case.
                const msg = (error && error.name === 'PasswordException')
                    ? 'This PDF is password-protected and cannot be previewed.'
                    : (error && error.message) || String(error);
                console.error('Error rendering PDF:', error);
                showError(msg);
            }
        }

        // Actions forwarded from Command Palette commands (see postToActivePanel
        // in extension.ts) - reuses the same functions the toolbar buttons call.
        function handleExternalCommand(action, payload) {
            if (!pdfDoc) return; // nothing to act on before a document has loaded
            switch (action) {
                case 'zoom-in': applyZoom(currentScale + ZOOM_STEP); break;
                case 'zoom-out': applyZoom(currentScale - ZOOM_STEP); break;
                case 'fit-width': zoomFitWidthBtn.click(); break;
                case 'next-page': scrollToPage(currentPage + 1); break;
                case 'prev-page': scrollToPage(currentPage - 1); break;
                case 'go-to-page':
                    if (typeof payload === 'number' && Number.isFinite(payload)) scrollToPage(payload);
                    break;
                case 'open-search': openSearch(); break;
                case 'toggle-sidebar': toggleSidebarBtn.click(); break;
                case 'toggle-annotate': setAnnotateMode(!annotateMode); break;
                case 'toggle-bookmarks': toggleBookmarksBtn.click(); break;
                case 'bookmark-current-page': bookmarkToggleCurrentBtn.click(); break;
            }
        }

        window.addEventListener('message', (event) => {
            const msg = event.data;
            if (msg.type === 'pdf-data') {
                pdfDataReceived = true;
                annotations = Array.isArray(msg.annotations) ? msg.annotations : [];
                bookmarks = Array.isArray(msg.bookmarks) ? msg.bookmarks : [];
                pendingViewState = (msg.viewState && typeof msg.viewState === 'object') ? msg.viewState : null;
                console.log('[pdfDisplay] received pdf-data, viewState=', pendingViewState);
                renderPdf(msg.data);
            } else if (msg.type === 'pdf-error') {
                pdfDataReceived = true;
                showError(msg.message);
            } else if (msg.type === 'command') {
                handleExternalCommand(msg.action, msg.payload);
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

function getAnnotationsStorageKey(uri: vscode.Uri): string {
    return 'pdfDisplay.annotations:' + uri.toString();
}

function getStoredAnnotations(context: vscode.ExtensionContext, uri: vscode.Uri): unknown[] {
    return context.globalState.get(getAnnotationsStorageKey(uri), []);
}

function storeAnnotations(context: vscode.ExtensionContext, uri: vscode.Uri, annotations: unknown[]): Thenable<void> {
    return context.globalState.update(getAnnotationsStorageKey(uri), annotations);
}

interface PdfViewState {
    page: number;
    scale: number;
}

function getViewStateStorageKey(uri: vscode.Uri): string {
    return 'pdfDisplay.viewState:' + uri.toString();
}

function getStoredViewState(context: vscode.ExtensionContext, uri: vscode.Uri): PdfViewState | undefined {
    return context.globalState.get<PdfViewState>(getViewStateStorageKey(uri));
}

function storeViewState(context: vscode.ExtensionContext, uri: vscode.Uri, viewState: PdfViewState): Thenable<void> {
    return context.globalState.update(getViewStateStorageKey(uri), viewState);
}

function getBookmarksStorageKey(uri: vscode.Uri): string {
    return 'pdfDisplay.bookmarks:' + uri.toString();
}

function getStoredBookmarks(context: vscode.ExtensionContext, uri: vscode.Uri): unknown[] {
    return context.globalState.get(getBookmarksStorageKey(uri), []);
}

function storeBookmarks(context: vscode.ExtensionContext, uri: vscode.Uri, bookmarks: unknown[]): Thenable<void> {
    return context.globalState.update(getBookmarksStorageKey(uri), bookmarks);
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
