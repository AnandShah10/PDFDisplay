import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as child_process from 'child_process';
import * as path from 'path';
import { PDFDocument, StandardFonts, rgb, PDFFont } from 'pdf-lib';

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
        vscode.commands.registerCommand('pdfDisplay.toggleToc', () => postToActivePanel('toggle-toc')),
        vscode.commands.registerCommand('pdfDisplay.toggleHighContrast', () => postToActivePanel('toggle-high-contrast')),
        vscode.commands.registerCommand('pdfDisplay.copyPageImage', () => postToActivePanel('copy-page-image')),
        vscode.commands.registerCommand('pdfDisplay.copyPageImages', () => postToActivePanel('copy-page-images')),
        vscode.commands.registerCommand('pdfDisplay.rotateView', () => postToActivePanel('rotate-view')),
        vscode.commands.registerCommand('pdfDisplay.toggleProperties', () => postToActivePanel('toggle-properties')),
        vscode.commands.registerCommand('pdfDisplay.toggleGitPanel', () => postToActivePanel('toggle-git')),
        vscode.commands.registerCommand('pdfDisplay.toggleDiffPanel', () => postToActivePanel('toggle-diff')),
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
        }),
        vscode.commands.registerCommand('pdfDisplay.exportAnnotatedPdf', async () => {
            const uri = PdfViewerProvider.activeDocumentUri;
            if (!uri) {
                vscode.window.showInformationMessage('Open a PDF first.');
                return;
            }
            await exportAnnotatedPdf(context, uri);
        }),
        vscode.commands.registerCommand('pdfDisplay.exportAnnotations', async () => {
            const uri = PdfViewerProvider.activeDocumentUri;
            if (!uri) {
                vscode.window.showInformationMessage('Open a PDF first.');
                return;
            }
            await exportAnnotationsJson(context, uri);
        }),
        vscode.commands.registerCommand('pdfDisplay.toggleToolsBar', () => postToActivePanel('toggle-tools')),
        vscode.commands.registerCommand('pdfDisplay.extractPages', async () => {
            const uri = PdfViewerProvider.activeDocumentUri;
            if (!uri) {
                vscode.window.showInformationMessage('Open a PDF first.');
                return;
            }
            await extractPages(uri);
        }),
        vscode.commands.registerCommand('pdfDisplay.compressPdf', async () => {
            const uri = PdfViewerProvider.activeDocumentUri;
            if (!uri) {
                vscode.window.showInformationMessage('Open a PDF first.');
                return;
            }
            await compressPdf(uri);
        }),
        vscode.commands.registerCommand('pdfDisplay.splitPdf', async () => {
            const uri = PdfViewerProvider.activeDocumentUri;
            if (!uri) {
                vscode.window.showInformationMessage('Open a PDF first.');
                return;
            }
            await splitPdf(uri);
        }),
        vscode.commands.registerCommand('pdfDisplay.mergeAnnotationsIntoPdf', () => postToActivePanel('merge-annotations')),
        vscode.commands.registerCommand('pdfDisplay.exportPagesAsImages', () => postToActivePanel('export-images')),
        // Merge PDFs doesn't need any specific document open - it's a standalone
        // multi-file-picker operation, so it's registered directly rather than
        // routed through postToActivePanel (which requires an active PDF panel).
        vscode.commands.registerCommand('pdfDisplay.mergePdfs', () => mergePdfs())
    );
}

class PdfViewerProvider implements vscode.CustomReadonlyEditorProvider {
    public static readonly viewType = 'pdfDisplay.pdfViewer';

    // Tracks whichever PDF panel is currently focused, so Command Palette actions
    // (registered once in activate()) know which webview to forward them to.
    public static activePanel: vscode.WebviewPanel | undefined;

    // Companion to activePanel - lets Command Palette actions that only need the
    // extension-host side of things (export commands below) act on the right
    // document without needing a round trip through the webview at all.
    public static activeDocumentUri: vscode.Uri | undefined;

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
                const effectiveAnnotations = await getEffectiveAnnotations(this.context, document.uri);
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
                    annotations: effectiveAnnotations,
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
                // Sticky-note annotations. Persisted in two places: VS Code's own
                // globalState (fast, always available, works even outside a
                // workspace) and a sidecar JSON file next to the PDF when it's part
                // of an open workspace (so git can track/diff/commit them - see
                // writeAnnotationsSidecar).
                const list = Array.isArray(msg.annotations) ? msg.annotations : [];
                storeAnnotations(this.context, document.uri, list);
                writeAnnotationsSidecar(document.uri, list);
            } else if (msg?.type === 'save-view-state') {
                // Last-viewed page + zoom, saved (debounced) as the user scrolls/zooms,
                // so reopening the document resumes where they left off.
                console.log('[pdfDisplay] onDidReceiveMessage save-view-state', msg.page, msg.scale, 'for', document.uri.toString());
                if (typeof msg.page === 'number' && typeof msg.scale === 'number') {
                    storeViewState(this.context, document.uri, { page: msg.page, scale: msg.scale, highContrast: msg.highContrast });
                }
            } else if (msg?.type === 'save-bookmarks') {
                storeBookmarks(this.context, document.uri, Array.isArray(msg.bookmarks) ? msg.bookmarks : []);
            } else if (msg?.type === 'debug-log') {
                // Forwarded from the webview's own console (see debugLog() in the
                // webview script) so its trace shows up in this same console too.
                console.log('[pdfDisplay:webview]', msg.message);
            } else if (msg?.type === 'open-external') {
                // Webviews can't navigate to arbitrary external sites directly;
                // hand the URL to VS Code to open in the system's default browser.
                if (typeof msg.url === 'string') {
                    try {
                        vscode.env.openExternal(vscode.Uri.parse(msg.url));
                    } catch (e) {
                        // malformed URL from a PDF link annotation - ignore rather than throw
                    }
                }
            } else if (msg?.type === 'open-file-link') {
                // Cross-document link (GoToR action) - a bare filename pointing
                // at another local PDF, resolved relative to this document.
                if (typeof msg.target === 'string') {
                    resolveAndOpenLinkedFile(document.uri, msg.target);
                }
            } else if (msg?.type === 'export-annotated-pdf') {
                exportAnnotatedPdf(this.context, document.uri);
            } else if (msg?.type === 'export-annotations') {
                exportAnnotationsJson(this.context, document.uri);
            } else if (msg?.type === 'extract-pages') {
                extractPages(document.uri);
            } else if (msg?.type === 'compress-pdf') {
                compressPdf(document.uri);
            } else if (msg?.type === 'merge-pdfs') {
                mergePdfs();
            } else if (msg?.type === 'split-pdf') {
                splitPdf(document.uri);
            } else if (msg?.type === 'merge-annotations-in-place') {
                mergeAnnotationsIntoPdf(this.context, document.uri).then(success => {
                    // The file on disk just changed under this same webview -
                    // re-fetch and re-render so it reflects the merged content.
                    if (success) loadAndSend();
                });
            } else if (msg?.type === 'request-export-images-setup') {
                const totalPagesFromWebview = typeof msg.totalPages === 'number' ? msg.totalPages : 0;
                if (totalPagesFromWebview > 0) {
                    promptExportImagesSetup(document.uri, totalPagesFromWebview).then(config => {
                        if (!config) return;
                        webviewPanel.webview.postMessage({
                            type: 'export-images-config',
                            pages: config.pages,
                            destFolder: config.destFolder,
                            stem: config.stem
                        });
                    });
                }
            } else if (msg?.type === 'export-image-data') {
                if (Array.isArray(msg.data) && typeof msg.destFolder === 'string' && typeof msg.pageNum === 'number') {
                    const fileName = (msg.stem || 'page') + '-page-' + msg.pageNum + '.png';
                    const outUri = vscode.Uri.file(path.join(msg.destFolder, fileName));
                    vscode.workspace.fs.writeFile(outUri, Buffer.from(msg.data)).then(
                        () => {
                            if (msg.isLast) {
                                vscode.window.showInformationMessage('pdfDisplay: exported page images to ' + msg.destFolder);
                            }
                        },
                        (e: any) => {
                            vscode.window.showErrorMessage('pdfDisplay: failed to write ' + fileName + ' - ' + (e?.message ?? String(e)));
                        }
                    );
                }
            } else if (msg?.type === 'git-get-status') {
                getGitFileStatus(document.uri).then(status => {
                    webviewPanel.webview.postMessage({ type: 'git-status', status });
                });
            } else if (msg?.type === 'git-get-log') {
                getGitFileLog(document.uri).then(log => {
                    webviewPanel.webview.postMessage({ type: 'git-log', log });
                });
            } else if (msg?.type === 'git-commit') {
                if (typeof msg.message === 'string' && msg.message.trim()) {
                    commitPdfAndAnnotations(document.uri, msg.message.trim())
                        .then(() => {
                            webviewPanel.webview.postMessage({ type: 'git-commit-result', ok: true });
                            vscode.window.showInformationMessage('pdfDisplay: committed successfully.');
                        })
                        .catch((e: any) => {
                            const message = e?.message ?? String(e);
                            webviewPanel.webview.postMessage({ type: 'git-commit-result', ok: false, error: message });
                            vscode.window.showErrorMessage('pdfDisplay: commit failed - ' + message);
                        });
                }
            } else if (msg?.type === 'diff-request-git') {
                if (typeof msg.ref === 'string') {
                    getFileAtGitRevision(document.uri, msg.ref)
                        .then(bytes => {
                            webviewPanel.webview.postMessage({
                                type: 'diff-data',
                                label: 'Commit ' + msg.ref.slice(0, 7),
                                data: Array.from(bytes)
                            });
                        })
                        .catch((e: any) => {
                            const message = e?.message ?? String(e);
                            vscode.window.showErrorMessage('pdfDisplay: could not load that revision - ' + message);
                            webviewPanel.webview.postMessage({ type: 'diff-error', message });
                        });
                }
            } else if (msg?.type === 'diff-request-file') {
                vscode.window.showOpenDialog({ filters: { 'PDF': ['pdf'] }, canSelectMany: false }).then(async (uris) => {
                    if (!uris || uris.length === 0) return;
                    try {
                        const bytes = await vscode.workspace.fs.readFile(uris[0]);
                        webviewPanel.webview.postMessage({
                            type: 'diff-data',
                            label: uris[0].path.split('/').pop() || 'other.pdf',
                            data: Array.from(bytes)
                        });
                    } catch (e: any) {
                        const message = e?.message ?? String(e);
                        vscode.window.showErrorMessage('pdfDisplay: could not read that file - ' + message);
                        webviewPanel.webview.postMessage({ type: 'diff-error', message });
                    }
                });
            }
        });

        webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview, fileName, nonce);

        // Command Palette routing: keep track of whichever panel currently has
        // focus so commands registered once in activate() know where to send actions.
        if (webviewPanel.active) {
            PdfViewerProvider.activePanel = webviewPanel;
            PdfViewerProvider.activeDocumentUri = document.uri;
        }
        webviewPanel.onDidChangeViewState(e => {
            if (e.webviewPanel.active) {
                PdfViewerProvider.activePanel = e.webviewPanel;
                PdfViewerProvider.activeDocumentUri = document.uri;
            } else if (PdfViewerProvider.activePanel === e.webviewPanel) {
                PdfViewerProvider.activePanel = undefined;
                PdfViewerProvider.activeDocumentUri = undefined;
            }
        });

        webviewPanel.onDidDispose(() => {
            if (PdfViewerProvider.activePanel === webviewPanel) {
                PdfViewerProvider.activePanel = undefined;
                PdfViewerProvider.activeDocumentUri = undefined;
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

        #properties-panel {
            position: fixed;
            top: 56px;
            right: 20px;
            width: 280px;
            max-height: 400px;
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

        #properties-panel.hidden {
            display: none;
        }

        .properties-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            font-size: 12px;
            font-weight: 600;
            color: var(--text-color);
        }

        #properties-list {
            overflow-y: auto;
            display: flex;
            flex-direction: column;
            gap: 6px;
            font-size: 12px;
        }

        .property-row {
            display: flex;
            flex-direction: column;
            gap: 1px;
        }

        .property-label {
            color: var(--muted-text-color);
            font-size: 10px;
            text-transform: uppercase;
            letter-spacing: 0.03em;
        }

        .property-value {
            color: var(--text-color);
            word-break: break-word;
        }

        .link-layer {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
        }

        .link-annotation {
            position: absolute;
            cursor: pointer;
            pointer-events: auto;
            border-radius: 2px;
        }

        .link-annotation:hover {
            outline: 1px solid var(--vscode-textLink-foreground, #3794ff);
            outline-offset: 1px;
            background-color: rgba(55, 148, 255, 0.1);
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

        #reading-progress {
            position: fixed;
            top: 48px;
            left: 0;
            height: 3px;
            background-color: var(--accent-color);
            z-index: 101;
            transition: width 0.2s ease-out;
            width: 0%;
        }

        /* Secondary, collapsible bar holding everything that isn't core
           navigation/zoom/search - keeps the main toolbar from turning into an
           unreadable wall of icons as more tools get added. */
        #tools-bar {
            position: fixed;
            top: 48px;
            left: 0;
            right: 0;
            height: 44px;
            background-color: var(--toolbar-bg);
            border-bottom: 1px solid var(--border-color);
            z-index: 99;
            display: flex;
            align-items: center;
            gap: 4px;
            padding: 0 16px;
            overflow-x: auto;
            box-shadow: 0 2px 4px rgba(0,0,0,0.2);
        }

        #tools-bar.hidden {
            display: none;
        }

        .tools-group {
            display: flex;
            align-items: center;
            gap: 4px;
            flex-shrink: 0;
        }

        .tools-separator {
            width: 1px;
            align-self: stretch;
            margin: 8px 6px;
            background-color: var(--border-color);
            flex-shrink: 0;
        }

        .tools-labeled-btn {
            white-space: nowrap;
        }

        /* When the tools bar is open, everything below the toolbar needs to
           shift down by its height (44px) so it doesn't sit underneath it. */
        body.tools-bar-open #content {
            margin-top: 92px;
            height: calc(100vh - 92px);
        }
        body.tools-bar-open #reading-progress {
            top: 92px;
        }
        body.tools-bar-open #loading-overlay {
            top: 92px;
        }
        body.tools-bar-open #diff-overlay {
            top: 92px;
        }

        #viewer-container.high-contrast canvas {
            filter: invert(1) hue-rotate(180deg);
        }

        #toc-panel {
            position: fixed;
            top: 56px;
            right: 20px;
            width: 260px;
            max-height: 400px;
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

        #toc-panel.hidden {
            display: none;
        }

        .toc-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            font-size: 12px;
            font-weight: 600;
            color: var(--text-color);
        }

        #toc-list {
            flex: 1;
            min-height: 0;
            overflow-y: auto;
            display: flex;
            flex-direction: column;
            gap: 2px;
        }

        .toc-item {
            cursor: pointer;
            font-size: 13px;
            color: var(--text-color);
            padding: 6px 8px;
            border-radius: 4px;
            line-height: 1.4;
            word-break: break-word;
        }

        .toc-item.toc-child {
            color: var(--muted-text-color);
            font-size: 11px;
        }

        .toc-item:hover {
            background-color: var(--hover-bg);
        }

        .toc-item.toc-active {
            background-color: var(--vscode-list-activeSelectionBackground, rgba(0, 122, 204, 0.35));
            color: var(--text-color) !important;
        }

        #images-panel {
            position: fixed;
            top: 56px;
            right: 20px;
            width: 260px;
            max-height: 400px;
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

        #images-panel.hidden {
            display: none;
        }

        .images-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            font-size: 12px;
            font-weight: 600;
            color: var(--text-color);
        }

        #images-list {
            overflow-y: auto;
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 8px;
        }

        .image-thumb-item {
            display: flex;
            flex-direction: column;
            gap: 4px;
            cursor: pointer;
            border-radius: 4px;
            padding: 6px;
            background-color: rgba(255,255,255,0.04);
        }

        .image-thumb-item:hover {
            background-color: var(--hover-bg);
        }

        .image-thumb-item canvas {
            width: 100%;
            height: 70px;
            object-fit: contain;
            background-color: repeating-conic-gradient(#80808022 0% 25%, transparent 0% 50%) 50% / 12px 12px;
            border-radius: 2px;
        }

        .image-thumb-label {
            font-size: 10px;
            color: var(--muted-text-color);
            text-align: center;
        }

        #git-panel, #diff-setup-panel {
            position: fixed;
            top: 56px;
            right: 20px;
            width: 300px;
            max-height: 440px;
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

        #git-panel.hidden, #diff-setup-panel.hidden {
            display: none;
        }

        .git-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            font-size: 12px;
            font-weight: 600;
            color: var(--text-color);
        }

        .git-action-btn {
            background-color: var(--hover-bg);
            text-align: center;
        }

        .git-commit-textarea {
            min-height: 44px;
        }

        .git-header-spaced {
            margin-top: 4px;
        }

        #git-log-list, #diff-setup-log-list {
            overflow-y: auto;
            max-height: 220px;
            display: flex;
            flex-direction: column;
            gap: 2px;
        }

        .git-log-item {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            padding: 6px 8px;
            border-radius: 4px;
            font-size: 12px;
            color: var(--text-color);
        }

        .git-log-item:hover {
            background-color: var(--hover-bg);
        }

        .git-log-item-info {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            flex: 1;
        }

        /* Full-screen (below the main toolbar) overlay for comparing two PDF
           versions - deliberately separate from the floating panels above so it
           can host its own sub-toolbar (mode toggle, page nav) without crowding
           the main one. */
        #diff-overlay {
            position: fixed;
            top: 48px;
            left: 0;
            right: 0;
            bottom: 0;
            background-color: var(--bg-color);
            z-index: 300;
            display: flex;
            flex-direction: column;
        }

        #diff-overlay.hidden {
            display: none;
        }

        #diff-toolbar {
            height: 44px;
            flex-shrink: 0;
            background-color: var(--toolbar-bg);
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 0 16px;
            border-bottom: 1px solid var(--border-color);
        }

        #diff-body {
            flex: 1;
            overflow: auto;
            display: flex;
            align-items: flex-start;
            justify-content: center;
            padding: 20px;
        }

        .diff-side-by-side {
            display: flex;
            gap: 16px;
        }

        .diff-column {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 6px;
        }

        .diff-column-label {
            font-size: 12px;
            color: var(--muted-text-color);
            font-weight: 600;
        }

        .diff-canvas {
            max-width: 100%;
            box-shadow: var(--shadow);
            border-radius: 2px;
            background-color: white;
        }
    </style>
</head>
<body>
    <div id="toolbar">
        <button id="toggle-sidebar" class="toolbar-btn" title="Toggle thumbnails" disabled>&#9776;</button>
        <button id="toggle-search" class="toolbar-btn" title="Find in document (Ctrl/Cmd+F)" disabled>&#128269;</button>
        <button id="toggle-tools" class="toolbar-btn" title="Tools" disabled>&#9881;</button>
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

    <div id="tools-bar" class="hidden">
        <div class="tools-group">
            <button id="toggle-toc" class="toolbar-btn" title="Table of Contents" disabled>&#128214;</button>
            <button id="toggle-annotate" class="toolbar-btn" title="Add a sticky note" disabled>&#128204;</button>
            <button id="toggle-bookmarks" class="toolbar-btn" title="Bookmarks" disabled>&#128278;</button>
            <button id="toggle-contrast" class="toolbar-btn" title="Toggle High Contrast" disabled>&#9680;</button>
            <button id="rotate-view" class="toolbar-btn" title="Rotate view" disabled>&#8635;</button>
            <button id="toggle-properties" class="toolbar-btn" title="Document properties" disabled>&#8505;</button>
        </div>
        <div class="tools-separator"></div>
        <div class="tools-group">
            <button id="copy-page" class="toolbar-btn" title="Copy Current Page" disabled>&#128203;</button>
            <button id="copy-images" class="toolbar-btn" title="Copy Images From Page" disabled>&#128247;</button>
            <button id="export-images" class="toolbar-btn text-btn tools-labeled-btn" title="Convert pages to image files" disabled>Images</button>
        </div>
        <div class="tools-separator"></div>
        <div class="tools-group">
            <button id="extract-pages-btn" class="toolbar-btn text-btn tools-labeled-btn" title="Export selected pages as a new PDF" disabled>Extract</button>
            <button id="merge-pdfs-btn" class="toolbar-btn text-btn tools-labeled-btn" title="Merge multiple PDFs into one">Merge PDFs</button>
            <button id="split-pdf-btn" class="toolbar-btn text-btn tools-labeled-btn" title="Split into multiple PDFs by page range" disabled>Split</button>
            <button id="compress-pdf-btn" class="toolbar-btn text-btn tools-labeled-btn" title="Reduce PDF file size" disabled>Compress</button>
        </div>
        <div class="tools-separator"></div>
        <div class="tools-group">
            <button id="export-annotated-pdf" class="toolbar-btn" title="Download Annotated PDF" disabled>&#128190;</button>
            <button id="merge-annotations-btn" class="toolbar-btn text-btn tools-labeled-btn" title="Bake sticky notes into this PDF (overwrites the file)" disabled>Merge Notes</button>
            <button id="export-annotations" class="toolbar-btn" title="Export Annotations as JSON" disabled>&#128228;</button>
        </div>
        <div class="tools-separator"></div>
        <div class="tools-group">
            <button id="toggle-git" class="toolbar-btn text-btn tools-labeled-btn" title="Git: status, history, commit" disabled>Git</button>
            <button id="toggle-diff" class="toolbar-btn text-btn tools-labeled-btn" title="Compare PDF versions" disabled>Diff</button>
        </div>
    </div>

    <div id="reading-progress"></div>

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

    <div id="properties-panel" class="hidden">
        <div class="properties-header">
            <span>Document Properties</span>
            <button id="properties-close" class="toolbar-btn" title="Close">&times;</button>
        </div>
        <div id="properties-list"></div>
    </div>

    <div id="toc-panel" class="hidden">
        <div class="toc-header">
            <span>Table of Contents</span>
            <button id="toc-close" class="toolbar-btn" title="Close">&times;</button>
        </div>
        <div id="toc-list"></div>
    </div>

    <div id="images-panel" class="hidden">
        <div class="images-header">
            <span id="images-panel-title">Images on This Page</span>
            <button id="images-close" class="toolbar-btn" title="Close">&times;</button>
        </div>
        <div id="images-list"></div>
    </div>

    <div id="git-panel" class="hidden">
        <div class="git-header">
            <span>Git</span>
            <button id="git-close" class="toolbar-btn" title="Close">&times;</button>
        </div>
        <div id="git-status-line" class="bookmarks-empty">Checking status&hellip;</div>
        <textarea id="git-commit-message" class="annotation-popup-textarea git-commit-textarea" placeholder="Commit message&hellip;"></textarea>
        <button id="git-commit-btn" class="toolbar-btn text-btn git-action-btn">Commit PDF &amp; Annotations</button>
        <div class="git-header git-header-spaced">History</div>
        <div id="git-log-list"></div>
    </div>

    <div id="diff-setup-panel" class="hidden">
        <div class="git-header">
            <span>Compare With</span>
            <button id="diff-setup-close" class="toolbar-btn" title="Close">&times;</button>
        </div>
        <button id="diff-pick-file" class="toolbar-btn text-btn git-action-btn">Choose Another PDF File&hellip;</button>
        <div class="git-header git-header-spaced">Or a previous commit</div>
        <div id="diff-setup-log-list"></div>
    </div>

    <div id="diff-overlay" class="hidden">
        <div id="diff-toolbar">
            <button id="diff-exit" class="toolbar-btn text-btn">&larr; Exit Diff</button>
            <span id="diff-label" class="page-sep"></span>
            <div class="toolbar-spacer"></div>
            <button id="diff-mode-overlay" class="toolbar-btn text-btn active">Overlay</button>
            <button id="diff-mode-sidebyside" class="toolbar-btn text-btn">Side by Side</button>
            <div class="toolbar-group" id="diff-page-nav">
                <button id="diff-prev-page" class="toolbar-btn" title="Previous page">&#9650;</button>
                <span id="diff-page-indicator" class="page-sep"></span>
                <button id="diff-next-page" class="toolbar-btn" title="Next page">&#9660;</button>
            </div>
            <span id="diff-stats" class="page-sep"></span>
        </div>
        <div id="diff-body"></div>
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

        // Mirrors to the extension host's own console (visible via Help > Toggle
        // Developer Tools, or the Debug Console when running via F5) in addition to
        // this webview's own devtools console (Command Palette > "Developer: Open
        // Webview Developer Tools") - the latter is a separate window that's easy
        // to miss, so this makes the same trace visible wherever you're already looking.
        function debugLog() {
            const args = Array.prototype.slice.call(arguments);
            console.log.apply(console, ['[pdfDisplay]'].concat(args));
            try {
                const message = args.map(a => {
                    if (typeof a === 'string') return a;
                    try { return JSON.stringify(a); } catch (e) { return String(a); }
                }).join(' ');
                vscodeApi.postMessage({ type: 'debug-log', message: message });
            } catch (e) { /* best-effort only */ }
        }

        const container = document.getElementById('viewer-container');
        const loadingOverlay = document.getElementById('loading-overlay');
        const loadingText = document.getElementById('loading-text');

        // The filename is baked into the HTML server-side (see the ${fileName}
        // template substitutions in getHtmlForWebview) - there's no actual client-
        // side "fileName" variable, so pull the already-rendered text back out of
        // the DOM for anything in this script that needs it (e.g. the properties panel).
        const displayFileName = (document.querySelector('.title').textContent || '').replace(/^\s*\S+\s*/, '').trim();

        const toggleSidebarBtn = document.getElementById('toggle-sidebar');
        const thumbnailSidebar = document.getElementById('thumbnail-sidebar');

        const toggleToolsBtn = document.getElementById('toggle-tools');
        const toolsBar = document.getElementById('tools-bar');

        const extractPagesBtn = document.getElementById('extract-pages-btn');
        const mergePdfsBtn = document.getElementById('merge-pdfs-btn');
        const splitPdfBtn = document.getElementById('split-pdf-btn');
        const compressPdfBtn = document.getElementById('compress-pdf-btn');
        const mergeAnnotationsBtn = document.getElementById('merge-annotations-btn');
        const exportImagesBtn = document.getElementById('export-images');

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

        const rotateViewBtn = document.getElementById('rotate-view');

        const togglePropertiesBtn = document.getElementById('toggle-properties');
        const propertiesPanel = document.getElementById('properties-panel');
        const propertiesListEl = document.getElementById('properties-list');
        const propertiesCloseBtn = document.getElementById('properties-close');

        const exportAnnotatedPdfBtn = document.getElementById('export-annotated-pdf');
        const exportAnnotationsBtn = document.getElementById('export-annotations');

        const toggleGitBtn = document.getElementById('toggle-git');
        const gitPanel = document.getElementById('git-panel');
        const gitStatusLine = document.getElementById('git-status-line');
        const gitCommitMessageEl = document.getElementById('git-commit-message');
        const gitCommitBtn = document.getElementById('git-commit-btn');
        const gitLogListEl = document.getElementById('git-log-list');
        const gitCloseBtn = document.getElementById('git-close');

        const toggleDiffBtn = document.getElementById('toggle-diff');
        const diffSetupPanel = document.getElementById('diff-setup-panel');
        const diffSetupLogListEl = document.getElementById('diff-setup-log-list');
        const diffPickFileBtn = document.getElementById('diff-pick-file');
        const diffSetupCloseBtn = document.getElementById('diff-setup-close');

        const contentEl = document.getElementById('content');
        const diffOverlay = document.getElementById('diff-overlay');
        const diffExitBtn = document.getElementById('diff-exit');
        const diffLabelEl = document.getElementById('diff-label');
        const diffModeOverlayBtn = document.getElementById('diff-mode-overlay');
        const diffModeSideBySideBtn = document.getElementById('diff-mode-sidebyside');
        const diffPrevPageBtn = document.getElementById('diff-prev-page');
        const diffNextPageBtn = document.getElementById('diff-next-page');
        const diffPageIndicator = document.getElementById('diff-page-indicator');
        const diffStatsEl = document.getElementById('diff-stats');
        const diffBodyEl = document.getElementById('diff-body');

        const toggleTocBtn = document.getElementById('toggle-toc');
        const tocPanel = document.getElementById('toc-panel');
        const tocListEl = document.getElementById('toc-list');
        const tocCloseBtn = document.getElementById('toc-close');

        const toggleContrastBtn = document.getElementById('toggle-contrast');
        const copyPageBtn = document.getElementById('copy-page');
        const readingProgress = document.getElementById('reading-progress');

        const copyImagesBtn = document.getElementById('copy-images');
        const imagesPanel = document.getElementById('images-panel');
        const imagesPanelTitle = document.getElementById('images-panel-title');
        const imagesListEl = document.getElementById('images-list');
        const imagesCloseBtn = document.getElementById('images-close');

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
        let currentRotation = 0;    // 0 | 90 | 180 | 270, view-only - never written back to the file
        let currentHighContrast = false;
        const BASE_SCALE = 1.5;
        const MIN_SCALE = 0.375;    // ~25%
        const MAX_SCALE = 6.0;      // ~400%
        const ZOOM_STEP = BASE_SCALE * 0.1; // 10% per click

        // Every viewport in the app should go through here so zoom AND rotation
        // stay consistent everywhere (main pages, thumbnails, text/link/annotation
        // layers, fit-width calculation) - rotation is view-only, never written
        // back to the underlying file.
        function getViewport(page, scale) {
            return page.getViewport({ scale: scale, rotation: currentRotation });
        }

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

        // ---- Links + document properties state ---------------------------------
        const pageAnnotationsCache = new Map(); // pageNum -> pdf.js annotations array, fetched once per page
        let fileSizeBytes = 0;
        let documentMetadata = null;     // { info, metadata } from pdfDoc.getMetadata(), fetched once
        let viewStateSaveTimer = null;

        // ---- Git + Diff state ---------------------------------------------------
        let gitLogCache = null;     // cached commit history for this file, refreshed on panel open/after commit
        let otherPdfDoc = null;     // second PDFDocumentProxy loaded when comparing against another version
        let otherPdfLabel = '';
        let diffMode = 'overlay';   // 'overlay' | 'sidebyside'
        let diffPage = 1;
        let diffTotalPages = 1;
        const DIFF_SCALE = 1.3;     // fixed scale for diff rendering, independent of the main viewer's zoom - keeps comparisons consistent and the pixel-diff loop bounded


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
                debugLog('flushViewStateSave skipped', { hasPdfDoc: !!pdfDoc, isRestoringView });
                return;
            }
            clearTimeout(viewStateSaveTimer);
            debugLog('sending save-view-state', { page: currentPage, scale: currentScale, highContrast: currentHighContrast });
            vscodeApi.postMessage({ type: 'save-view-state', page: currentPage, scale: currentScale, highContrast: currentHighContrast });
        }

        document.addEventListener('visibilitychange', () => {
            debugLog('visibilitychange, state=', document.visibilityState);
            if (document.visibilityState === 'hidden') {
                flushViewStateSave();
            }
        });
        window.addEventListener('pagehide', () => {
            debugLog('pagehide fired');
            flushViewStateSave();
        });

        function updatePageControls() {
            pageInput.value = String(currentPage);
            pageCountEl.textContent = String(totalPages);
            prevPageBtn.disabled = currentPage <= 1;
            nextPageBtn.disabled = currentPage >= totalPages;

            if (totalPages > 0) {
                readingProgress.style.width = ((currentPage / totalPages) * 100) + '%';
            }

            updateActiveThumbnail();
            updateBookmarkToggleLabel();
            scheduleViewStateSave();
        }

        function enableToolbar() {
            [prevPageBtn, nextPageBtn, pageInput, zoomOutBtn, zoomInBtn, zoomFitWidthBtn, toggleSidebarBtn, toggleSearchBtn, toggleToolsBtn, toggleAnnotateBtn, toggleBookmarksBtn, rotateViewBtn, togglePropertiesBtn, toggleTocBtn, toggleContrastBtn, copyPageBtn, copyImagesBtn, exportAnnotatedPdfBtn, exportAnnotationsBtn, toggleGitBtn, toggleDiffBtn, extractPagesBtn, splitPdfBtn, compressPdfBtn, mergeAnnotationsBtn, exportImagesBtn].forEach(el => el.disabled = false);
        }

        toggleSidebarBtn.addEventListener('click', () => {
            thumbnailSidebar.classList.toggle('collapsed');
        });

        toggleToolsBtn.addEventListener('click', () => {
            const nowOpen = toolsBar.classList.toggle('hidden') === false;
            document.body.classList.toggle('tools-bar-open', nowOpen);
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
                const naturalViewport = getViewport(page, 1);
                const scale = THUMB_WIDTH / naturalViewport.width;
                const viewport = getViewport(page, scale);

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
                const naturalViewport = getViewport(page, 1);
                const scale = THUMB_WIDTH / naturalViewport.width;
                const viewport = getViewport(page, scale);
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
                const viewport = getViewport(page, currentScale);

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

                // Clickable overlays for the PDF's own link annotations (internal
                // page-jump links and external URLs) - invisible, the document's
                // own rendering already shows whatever visual styling the link has
                // (underline, blue text, etc.) baked into the canvas.
                const pageLinks = await getPageAnnotations(page, pageNum);
                buildLinkLayer(pageContainer, pageLinks, viewport);
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
                const viewport = getViewport(page, currentScale);

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
            const naturalViewport = getViewport(firstPage, 1);
            const availableWidth = container.clientWidth - 48; // leave a little breathing room
            applyZoom(availableWidth / naturalViewport.width);
        });

        // View-only rotation (never written back to the file) - cycles 0 -> 90 ->
        // 180 -> 270 -> 0. Every getViewport() call in the app already goes through
        // the shared helper above, so rebuilding pages/thumbnails at the new
        // rotation is all that's needed; width/height swap automatically for
        // 90/270 since those come from the viewport itself.
        async function applyRotation(newRotation) {
            currentRotation = ((newRotation % 360) + 360) % 360;
            const pageToRestore = currentPage;
            await layoutPages();
            buildThumbnails();
            const target = container.querySelector('.page-container[data-page-number="' + pageToRestore + '"]');
            if (target) target.scrollIntoView({ behavior: 'auto', block: 'start' });
        }

        rotateViewBtn.addEventListener('click', () => applyRotation(currentRotation + 90));

        // High Contrast Mode
        function applyHighContrast(enabled) {
            currentHighContrast = enabled;
            container.classList.toggle('high-contrast', currentHighContrast);
            toggleContrastBtn.classList.toggle('active', currentHighContrast);
            scheduleViewStateSave();
        }

        toggleContrastBtn.addEventListener('click', () => applyHighContrast(!currentHighContrast));

        // Copy Page Image
        copyPageBtn.addEventListener('click', async () => {
            const pageContainer = container.querySelector('.page-container[data-page-number="' + currentPage + '"]');
            const canvas = pageContainer ? pageContainer.querySelector('canvas') : null;
            if (canvas) {
                const originalIcon = copyPageBtn.innerHTML;
                copyPageBtn.innerHTML = '&#10003;'; // checkmark
                try {
                    canvas.toBlob((blob) => {
                        if (blob) {
                            navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]).catch(err => debugLog('Clipboard error:', err));
                        }
                    }, 'image/png');
                } catch (e) {
                    debugLog('Copy image failed', e);
                }
                setTimeout(() => copyPageBtn.innerHTML = originalIcon, 1500);
            }
        });

        // ---- Copy embedded images from the current page ------------------------
        // Distinct from "Copy Current Page" above: that copies a screenshot of the
        // whole rendered page, this extracts the actual raster images embedded in
        // the PDF page content (photos, figures, etc.) so you can copy just one of
        // them at full resolution rather than the whole page.

        // Walks the page's operator list for paintImageXObject ops (the drawing
        // instruction pdf.js uses for embedded raster images) and resolves each
        // referenced image object. This is inherently a bit version-sensitive since
        // it reaches into how pdf.js internally represents decoded image data;
        // extraction failures are handled per-image so one bad image can't block
        // the rest, and if literally nothing can be extracted the panel says so
        // rather than silently appearing empty.
        async function extractPageImages(pageNum) {
            const page = await pdfDoc.getPage(pageNum);
            const opList = await page.getOperatorList();

            const objIds = [];
            const seen = new Set();
            for (let i = 0; i < opList.fnArray.length; i++) {
                const fn = opList.fnArray[i];
                if (fn === pdfjsLib.OPS.paintImageXObject) {
                    const objId = opList.argsArray[i][0];
                    if (typeof objId === 'string' && !seen.has(objId)) {
                        seen.add(objId);
                        objIds.push(objId);
                    }
                }
            }

            const results = [];
            for (const objId of objIds) {
                try {
                    const imgObj = await new Promise((resolve) => {
                        if (page.objs.has(objId)) {
                            resolve(page.objs.get(objId));
                        } else {
                            page.objs.get(objId, resolve);
                        }
                    });
                    const canvas = imageObjToCanvas(imgObj);
                    if (canvas) results.push({ objId, canvas });
                } catch (e) {
                    debugLog('extractPageImages: failed to resolve', objId, (e && e.message) || String(e));
                }
            }
            return results;
        }

        // Converts whatever shape pdf.js resolved an image object to into a plain
        // <canvas> so it can be shown as a thumbnail and copied via toBlob().
        function imageObjToCanvas(imgObj) {
            if (!imgObj) return null;

            // Some pdf.js builds resolve directly to a drawable (ImageBitmap or
            // an HTMLImageElement/HTMLCanvasElement-like object with width/height).
            if (typeof ImageBitmap !== 'undefined' && imgObj instanceof ImageBitmap) {
                const canvas = document.createElement('canvas');
                canvas.width = imgObj.width;
                canvas.height = imgObj.height;
                canvas.getContext('2d').drawImage(imgObj, 0, 0);
                return canvas;
            }
            if (imgObj.bitmap) {
                return imageObjToCanvas(imgObj.bitmap);
            }

            // Older/other builds resolve to raw pixel data: { width, height, data, kind }.
            if (imgObj.data && imgObj.width && imgObj.height) {
                const rgba = toRgbaBytes(imgObj);
                if (!rgba) return null;
                const canvas = document.createElement('canvas');
                canvas.width = imgObj.width;
                canvas.height = imgObj.height;
                try {
                    canvas.getContext('2d').putImageData(new ImageData(rgba, imgObj.width, imgObj.height), 0, 0);
                } catch (e) {
                    return null;
                }
                return canvas;
            }

            return null;
        }

        // Normalizes pdf.js's raw image pixel formats (RGBA/RGB/1-bit grayscale)
        // into a flat RGBA byte array a canvas ImageData can use directly.
        function toRgbaBytes(imgObj) {
            const data = imgObj.data;
            const width = imgObj.width;
            const height = imgObj.height;
            const pixelCount = width * height;
            const out = new Uint8ClampedArray(pixelCount * 4);
            const KIND = (pdfjsLib && pdfjsLib.ImageKind) || {};

            if (data.length === pixelCount * 4 || imgObj.kind === KIND.RGBA_32BPP) {
                out.set(data.subarray ? data.subarray(0, out.length) : data.slice(0, out.length));
                return out;
            }

            if (data.length === pixelCount * 3 || imgObj.kind === KIND.RGB_24BPP) {
                for (let i = 0, j = 0; i < pixelCount; i++, j += 3) {
                    out[i * 4] = data[j];
                    out[i * 4 + 1] = data[j + 1];
                    out[i * 4 + 2] = data[j + 2];
                    out[i * 4 + 3] = 255;
                }
                return out;
            }

            const rowBytes = Math.ceil(width / 8);
            if (data.length === rowBytes * height || imgObj.kind === KIND.GRAYSCALE_1BPP) {
                for (let y = 0; y < height; y++) {
                    for (let x = 0; x < width; x++) {
                        const byte = data[y * rowBytes + (x >> 3)];
                        const bit = (byte >> (7 - (x & 7))) & 1;
                        const v = bit ? 255 : 0;
                        const idx = (y * width + x) * 4;
                        out[idx] = out[idx + 1] = out[idx + 2] = v;
                        out[idx + 3] = 255;
                    }
                }
                return out;
            }

            // Unrecognized pixel format - bail rather than render garbage.
            return null;
        }

        async function copyCanvasToClipboard(canvas, triggerBtn) {
            return new Promise((resolve) => {
                canvas.toBlob((blob) => {
                    if (!blob) { resolve(false); return; }
                    navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
                        .then(() => resolve(true))
                        .catch((err) => {
                            debugLog('Clipboard error:', (err && err.message) || String(err));
                            resolve(false);
                        });
                }, 'image/png');
            });
        }

        function flashButton(btn, glyph) {
            const original = btn.innerHTML;
            btn.innerHTML = glyph;
            setTimeout(() => { btn.innerHTML = original; }, 1200);
        }

        function closeImagesPanel() {
            imagesPanel.classList.add('hidden');
        }
        imagesCloseBtn.addEventListener('click', closeImagesPanel);

        copyImagesBtn.addEventListener('click', async () => {
            if (!pdfDoc) return;
            closeSearch();
            closeBookmarksPanel();
            closePropertiesPanel();
            if (typeof closeTocPanel === 'function') closeTocPanel();
            if (typeof closeGitPanel === 'function') closeGitPanel();
            if (typeof closeDiffSetupPanel === 'function') closeDiffSetupPanel();

            const originalIcon = copyImagesBtn.innerHTML;
            copyImagesBtn.innerHTML = '&#8987;'; // hourglass while extracting
            let found = [];
            try {
                found = await extractPageImages(currentPage);
            } catch (e) {
                debugLog('copyImagesBtn: extraction failed', (e && e.message) || String(e));
            }
            copyImagesBtn.innerHTML = originalIcon;

            if (found.length === 0) {
                imagesPanelTitle.textContent = 'No images found on page ' + currentPage;
                imagesListEl.innerHTML = '';
                imagesPanel.classList.remove('hidden');
                return;
            }

            if (found.length === 1) {
                // Single image - copy it directly, same one-click feel as "Copy Current Page".
                const ok = await copyCanvasToClipboard(found[0].canvas, copyImagesBtn);
                flashButton(copyImagesBtn, ok ? '&#10003;' : '&#10007;');
                return;
            }

            // Multiple images on the page - let the user pick which one(s) to copy.
            imagesPanelTitle.textContent = found.length + ' images on page ' + currentPage;
            imagesListEl.innerHTML = '';
            found.forEach((item, idx) => {
                const wrap = document.createElement('div');
                wrap.className = 'image-thumb-item';
                wrap.title = 'Click to copy this image';

                const thumbCanvas = document.createElement('canvas');
                thumbCanvas.width = item.canvas.width;
                thumbCanvas.height = item.canvas.height;
                thumbCanvas.getContext('2d').drawImage(item.canvas, 0, 0);
                wrap.appendChild(thumbCanvas);

                const label = document.createElement('div');
                label.className = 'image-thumb-label';
                label.textContent = item.canvas.width + '\u00d7' + item.canvas.height;
                wrap.appendChild(label);

                wrap.addEventListener('click', async () => {
                    const ok = await copyCanvasToClipboard(item.canvas);
                    label.textContent = ok ? 'Copied!' : 'Copy failed';
                    setTimeout(() => { label.textContent = item.canvas.width + '\u00d7' + item.canvas.height; }, 1200);
                });

                imagesListEl.appendChild(wrap);
            });

            imagesPanel.classList.remove('hidden');
        });

        // Table of Contents
        async function renderTocList() {
            if (!pdfDoc) {
                debugLog('renderTocList: pdfDoc not ready yet');
                return;
            }
            tocListEl.innerHTML = '<div class="bookmarks-empty">Loading\u2026</div>';
            let outline = null;
            try {
                outline = await pdfDoc.getOutline();
                debugLog('getOutline() returned:', outline ? outline.length + ' items' : 'null');
            } catch (e) {
                debugLog('Error getting outline:', (e && e.message) || String(e));
            }

            tocListEl.innerHTML = '';

            if (!outline || outline.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'bookmarks-empty';
                empty.textContent = outline === null ? 'No outline in this PDF' : 'Empty outline';
                tocListEl.appendChild(empty);
                return;
            }

            const renderItems = (items, parentEl, depth) => {
                items.forEach(item => {
                    const div = document.createElement('div');
                    div.className = 'toc-item' + (depth > 0 ? ' toc-child' : '');
                    div.style.paddingLeft = (depth * 14 + 6) + 'px';

                    // Clean potential null bytes from bad PDF encodings
                    const cleanTitle = (item.title || '(untitled)').replace(/\x00/g, '');
                    div.textContent = cleanTitle;
                    div.title = cleanTitle;

                    div.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        // pdf.js outline items expose the destination either directly
                        // as item.dest (a named string or explicit array) or nested
                        // inside item.url for external links. Some generators also
                        // emit it via an action object - handle all three cases.
                        const dest = item.dest || (item.action && item.action.dest) || null;
                        if (dest) {
                            const targetPageNum = await resolveDestPageNumber(dest);
                            if (targetPageNum) {
                                scrollToPage(targetPageNum);
                                // Highlight which item was clicked
                                tocListEl.querySelectorAll('.toc-item.toc-active').forEach(el => el.classList.remove('toc-active'));
                                div.classList.add('toc-active');
                            }
                        } else if (item.url) {
                            vscodeApi.postMessage({ type: 'open-external', url: item.url });
                        }
                    });

                    parentEl.appendChild(div);
                    if (item.items && item.items.length > 0) {
                        renderItems(item.items, parentEl, depth + 1);
                    }
                });
            };

            renderItems(outline, tocListEl, 0);
        }

        function openTocPanel() {
            closeSearch();
            closePropertiesPanel();
            closeBookmarksPanel();
            closeImagesPanel();
            closeGitPanel();
            closeDiffSetupPanel();
            tocPanel.classList.remove('hidden');
            // Always re-render so switching between documents or re-opening
            // after "No outline" doesn't show stale content.
            renderTocList();
        }

        function closeTocPanel() {
            tocPanel.classList.add('hidden');
        }

        toggleTocBtn.addEventListener('click', () => {
            if (tocPanel.classList.contains('hidden')) {
                openTocPanel();
            } else {
                closeTocPanel();
            }
        });
        tocCloseBtn.addEventListener('click', closeTocPanel);

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
            closePropertiesPanel();
            if (typeof closeTocPanel === 'function') closeTocPanel();
            closeImagesPanel();
            closeGitPanel();
            closeDiffSetupPanel();
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

        // ---- PDF links (internal page-jump + external URLs) ---------------------

        async function getPageAnnotations(page, pageNum) {
            if (pageAnnotationsCache.has(pageNum)) return pageAnnotationsCache.get(pageNum);
            let list = [];
            try {
                list = await page.getAnnotations();
            } catch (e) {
                list = [];
            }
            pageAnnotationsCache.set(pageNum, list);
            return list;
        }

        // Resolves a pdf.js link destination (either a named destination string,
        // or an already-explicit [pageRef, ...] array) to a 1-based page number.
        async function resolveDestPageNumber(dest) {
            try {
                let explicitDest = dest;
                if (typeof dest === 'string') {
                    explicitDest = await pdfDoc.getDestination(dest);
                }
                if (!explicitDest || !explicitDest[0]) return null;
                const pageIndex = await pdfDoc.getPageIndex(explicitDest[0]);
                return pageIndex + 1;
            } catch (e) {
                return null;
            }
        }

        // pdf.js normalizes BOTH plain URI-action links (http://...) and GoToR
        // "jump to another PDF file" actions into the same .url string field -
        // for GoToR it's just the bare target filename, optionally with a
        // "#nameddest=..." or "#[...]" fragment describing where in that other
        // file to land (see pdf.js's annotation.js GoToR handling). A real
        // protocol scheme (http:, mailto:, etc.) is what distinguishes the two.
        const URL_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

        function buildLinkLayer(pageContainer, pageAnnotationList, viewport) {
            const linkAnnotations = pageAnnotationList.filter(a => a.subtype === 'Link' && (a.url || a.dest));
            if (linkAnnotations.length === 0) return;

            const layer = document.createElement('div');
            layer.className = 'link-layer';

            linkAnnotations.forEach(ann => {
                const rect = viewport.convertToViewportRectangle(ann.rect);
                const x = Math.min(rect[0], rect[2]);
                const y = Math.min(rect[1], rect[3]);
                const w = Math.abs(rect[2] - rect[0]);
                const h = Math.abs(rect[3] - rect[1]);

                const linkEl = document.createElement('div');
                linkEl.className = 'link-annotation';
                linkEl.style.left = x + 'px';
                linkEl.style.top = y + 'px';
                linkEl.style.width = w + 'px';
                linkEl.style.height = h + 'px';

                if (ann.url && URL_SCHEME_RE.test(ann.url)) {
                    // Real external URL - webviews can't navigate to arbitrary
                    // external sites directly, so hand it to the extension host
                    // to open in the system's default browser.
                    linkEl.title = ann.url;
                    linkEl.addEventListener('click', (e) => {
                        e.stopPropagation();
                        vscodeApi.postMessage({ type: 'open-external', url: ann.url });
                    });
                } else if (ann.url) {
                    // Cross-document link (GoToR): bare filename, no protocol
                    // scheme. Resolve and open it as another local PDF.
                    linkEl.title = 'Open linked file: ' + ann.url;
                    linkEl.addEventListener('click', (e) => {
                        e.stopPropagation();
                        vscodeApi.postMessage({ type: 'open-file-link', target: ann.url });
                    });
                } else if (ann.dest) {
                    // Internal link - stays inside the viewer and jumps to the target page.
                    linkEl.title = 'Go to page';
                    linkEl.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        const targetPageNum = await resolveDestPageNumber(ann.dest);
                        if (targetPageNum) scrollToPage(targetPageNum);
                    });
                }

                layer.appendChild(linkEl);
            });

            pageContainer.appendChild(layer);
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
            const viewport = getViewport(page, currentScale);

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
            closePropertiesPanel();
            if (typeof closeTocPanel === 'function') closeTocPanel();
            closeImagesPanel();
            closeGitPanel();
            closeDiffSetupPanel();
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

        // ---- Document properties -------------------------------------------------

        function formatFileSize(bytes) {
            if (!bytes && bytes !== 0) return 'Unknown';
            if (bytes < 1024) return bytes + ' B';
            if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
            return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
        }

        // PDF metadata dates look like "D:20230115143000+05'30'" - parse the parts
        // pdf.js gives us and fall back to showing the raw string if it's malformed.
        function formatPdfDate(pdfDate) {
            if (!pdfDate || typeof pdfDate !== 'string') return null;
            const m = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(pdfDate);
            if (!m) return pdfDate;
            const year = m[1], month = m[2] || '01', day = m[3] || '01';
            const hour = m[4] || '00', minute = m[5] || '00', second = m[6] || '00';
            const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)));
            return isNaN(date.getTime()) ? pdfDate : date.toLocaleString();
        }

        function addPropertyRow(label, value) {
            if (!value) return;
            const row = document.createElement('div');
            row.className = 'property-row';

            const labelEl = document.createElement('div');
            labelEl.className = 'property-label';
            labelEl.textContent = label;

            const valueEl = document.createElement('div');
            valueEl.className = 'property-value';
            valueEl.textContent = value;

            row.appendChild(labelEl);
            row.appendChild(valueEl);
            propertiesListEl.appendChild(row);
        }

        async function renderPropertiesList() {
            propertiesListEl.innerHTML = '';

            try {
                addPropertyRow('File name', displayFileName);
                addPropertyRow('File size', formatFileSize(fileSizeBytes));
                addPropertyRow('Pages', totalPages ? String(totalPages) : null);

                if (!documentMetadata) {
                    try {
                        documentMetadata = await pdfDoc.getMetadata();
                    } catch (e) {
                        documentMetadata = { info: {} };
                    }
                }
                const info = (documentMetadata && documentMetadata.info) || {};

                addPropertyRow('PDF version', info.PDFFormatVersion || null);
                addPropertyRow('Title', info.Title);
                addPropertyRow('Author', info.Author);
                addPropertyRow('Subject', info.Subject);
                addPropertyRow('Producer', info.Producer);
                addPropertyRow('Created', formatPdfDate(info.CreationDate));
                addPropertyRow('Modified', formatPdfDate(info.ModDate));
            } catch (err) {
                debugLog('renderPropertiesList error', (err && err.message) || String(err));
                propertiesListEl.innerHTML = '';
                const errorEl = document.createElement('div');
                errorEl.className = 'bookmarks-empty';
                errorEl.textContent = 'Could not load properties.';
                propertiesListEl.appendChild(errorEl);
                return;
            }

            if (!propertiesListEl.children.length) {
                const empty = document.createElement('div');
                empty.className = 'bookmarks-empty';
                empty.textContent = 'No properties available';
                propertiesListEl.appendChild(empty);
            }
        }

        function openPropertiesPanel() {
            closeSearch();
            closeBookmarksPanel();
            if (typeof closeTocPanel === 'function') closeTocPanel();
            closeImagesPanel();
            closeGitPanel();
            closeDiffSetupPanel();
            propertiesPanel.classList.remove('hidden');
            renderPropertiesList();
        }

        function closePropertiesPanel() {
            propertiesPanel.classList.add('hidden');
        }

        togglePropertiesBtn.addEventListener('click', () => {
            if (propertiesPanel.classList.contains('hidden')) {
                openPropertiesPanel();
            } else {
                closePropertiesPanel();
            }
        });
        propertiesCloseBtn.addEventListener('click', closePropertiesPanel);

        // ---- Export: annotated PDF + standalone annotations JSON ---------------
        // Both run entirely in the extension host (it already has direct access to
        // the raw PDF bytes and stored annotations for this document) - these
        // buttons just trigger that, no state needs to come from the webview side.

        exportAnnotatedPdfBtn.addEventListener('click', () => {
            vscodeApi.postMessage({ type: 'export-annotated-pdf' });
        });

        exportAnnotationsBtn.addEventListener('click', () => {
            vscodeApi.postMessage({ type: 'export-annotations' });
        });

        // ---- New PDF operations: extract, compress, merge, split, merge-notes ---
        // All of these run entirely in the extension host (it has direct access
        // to the PDF bytes and pdf-lib) - each button just sends a request and any
        // needed setup (page ranges, save locations) happens via native VS Code
        // dialogs on that side.

        extractPagesBtn.addEventListener('click', () => {
            vscodeApi.postMessage({ type: 'extract-pages' });
        });

        compressPdfBtn.addEventListener('click', () => {
            vscodeApi.postMessage({ type: 'compress-pdf' });
        });

        mergePdfsBtn.addEventListener('click', () => {
            vscodeApi.postMessage({ type: 'merge-pdfs' });
        });

        splitPdfBtn.addEventListener('click', () => {
            vscodeApi.postMessage({ type: 'split-pdf' });
        });

        mergeAnnotationsBtn.addEventListener('click', () => {
            vscodeApi.postMessage({ type: 'merge-annotations-in-place' });
        });

        // ---- Convert pages to image files ---------------------------------------
        // The extension host prompts for which pages + a destination folder (see
        // 'request-export-images-setup' / 'export-images-config'), then this side
        // renders each requested page to a canvas (reusing renderPageToCanvas,
        // already built for PDF diffing), converts it to a PNG, and sends the
        // bytes back for the extension host to write to disk. Pages are processed
        // one at a time (not all rendered concurrently) to keep memory bounded on
        // large page ranges.

        exportImagesBtn.addEventListener('click', () => {
            if (!pdfDoc) return;
            vscodeApi.postMessage({ type: 'request-export-images-setup', totalPages: totalPages });
        });

        async function runImageExportQueue(pages, destFolder, stem) {
            for (let i = 0; i < pages.length; i++) {
                const pageNum = pages[i];
                try {
                    const canvas = await renderPageToCanvas(pdfDoc, pageNum, 2); // 2x scale for decent quality
                    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
                    if (!blob) continue;
                    const arrayBuffer = await blob.arrayBuffer();
                    const byteArray = Array.from(new Uint8Array(arrayBuffer));
                    vscodeApi.postMessage({
                        type: 'export-image-data',
                        pageNum: pageNum,
                        data: byteArray,
                        destFolder: destFolder,
                        stem: stem,
                        isLast: i === pages.length - 1
                    });
                } catch (e) {
                    debugLog('runImageExportQueue failed for page', pageNum, (e && e.message) || String(e));
                }
            }
        }

        // ---- Git: status, history, commit ---------------------------------------
        // All the actual git work happens in the extension host (see the
        // git-get-status / git-get-log / git-commit handlers in extension.ts) -
        // this panel just requests data and renders whatever comes back.

        function renderGitStatus(status) {
            if (!status || !status.isRepo) {
                gitStatusLine.textContent = 'Not inside a Git repository.';
                return;
            }
            const labelMap = {
                clean: 'Clean',
                modified: 'Modified (uncommitted changes)',
                untracked: 'Untracked',
                staged: 'Staged',
                unknown: 'Unknown'
            };
            const branchPart = status.branch ? (' on ' + status.branch) : '';
            gitStatusLine.textContent = (labelMap[status.status] || 'Unknown') + branchPart;
        }

        function renderGitLogList(entries, listEl) {
            listEl.innerHTML = '';
            if (!entries || entries.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'bookmarks-empty';
                empty.textContent = 'No commit history for this file';
                listEl.appendChild(empty);
                return;
            }

            entries.forEach(entry => {
                const item = document.createElement('div');
                item.className = 'git-log-item';

                const info = document.createElement('div');
                info.className = 'git-log-item-info';
                info.textContent = entry.shortHash + '  ' + entry.message;
                info.title = entry.message + ' (' + entry.author + ', ' + entry.date + ')';
                item.appendChild(info);

                const compareBtn = document.createElement('button');
                compareBtn.className = 'toolbar-btn text-btn';
                compareBtn.textContent = 'Compare';
                compareBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    startDiffAgainstGit(entry.hash);
                });
                item.appendChild(compareBtn);

                listEl.appendChild(item);
            });
        }

        function refreshGitStatus() {
            gitStatusLine.textContent = 'Checking status...';
            vscodeApi.postMessage({ type: 'git-get-status' });
        }

        function refreshGitLog() {
            gitLogListEl.innerHTML = '<div class="bookmarks-empty">Loading...</div>';
            vscodeApi.postMessage({ type: 'git-get-log' });
        }

        function openGitPanel() {
            closeSearch();
            closeBookmarksPanel();
            closePropertiesPanel();
            if (typeof closeTocPanel === 'function') closeTocPanel();
            closeImagesPanel();
            closeDiffSetupPanel();
            gitPanel.classList.remove('hidden');
            refreshGitStatus();
            refreshGitLog();
        }

        function closeGitPanel() {
            gitPanel.classList.add('hidden');
        }

        toggleGitBtn.addEventListener('click', () => {
            if (gitPanel.classList.contains('hidden')) {
                openGitPanel();
            } else {
                closeGitPanel();
            }
        });
        gitCloseBtn.addEventListener('click', closeGitPanel);

        gitCommitBtn.addEventListener('click', () => {
            const message = gitCommitMessageEl.value.trim();
            if (!message) {
                gitCommitMessageEl.focus();
                return;
            }
            gitCommitBtn.disabled = true;
            gitCommitBtn.textContent = 'Committing...';
            vscodeApi.postMessage({ type: 'git-commit', message });
        });

        // ---- PDF Diff: compare with a previous commit or another file -----------

        function openDiffSetupPanel() {
            closeSearch();
            closeBookmarksPanel();
            closePropertiesPanel();
            if (typeof closeTocPanel === 'function') closeTocPanel();
            closeImagesPanel();
            closeGitPanel();
            diffSetupPanel.classList.remove('hidden');
            if (gitLogCache) {
                renderGitLogList(gitLogCache, diffSetupLogListEl);
            } else {
                diffSetupLogListEl.innerHTML = '<div class="bookmarks-empty">Loading...</div>';
                vscodeApi.postMessage({ type: 'git-get-log' });
            }
        }

        function closeDiffSetupPanel() {
            diffSetupPanel.classList.add('hidden');
        }

        toggleDiffBtn.addEventListener('click', () => {
            if (diffSetupPanel.classList.contains('hidden')) {
                openDiffSetupPanel();
            } else {
                closeDiffSetupPanel();
            }
        });
        diffSetupCloseBtn.addEventListener('click', closeDiffSetupPanel);

        diffPickFileBtn.addEventListener('click', () => {
            closeDiffSetupPanel();
            vscodeApi.postMessage({ type: 'diff-request-file' });
        });

        function startDiffAgainstGit(hash) {
            closeDiffSetupPanel();
            closeGitPanel();
            vscodeApi.postMessage({ type: 'diff-request-git', ref: hash });
        }

        // Loads the "other" PDF version (bytes arrive via the diff-data message,
        // fetched by the extension host from either git or a file picker - see
        // window.addEventListener('message', ...) below) and switches into diff mode.
        async function loadDiffOther(label, data) {
            try {
                const typedBytes = data instanceof Uint8Array ? data : new Uint8Array(data);
                const loadingTask = pdfjsLib.getDocument({ data: typedBytes });
                if (otherPdfDoc && otherPdfDoc.destroy) {
                    try { otherPdfDoc.destroy(); } catch (e) { /* ignore */ }
                }
                otherPdfDoc = await loadingTask.promise;
                otherPdfLabel = label;
                diffTotalPages = Math.min(totalPages, otherPdfDoc.numPages);
                diffPage = Math.min(currentPage, diffTotalPages) || 1;
                enterDiffMode();
            } catch (e) {
                debugLog('loadDiffOther failed', (e && e.message) || String(e));
                window.alert('Could not load that PDF for comparison.');
            }
        }

        function enterDiffMode() {
            contentEl.style.display = 'none';
            diffOverlay.classList.remove('hidden');
            diffLabelEl.textContent = 'Comparing with: ' + otherPdfLabel;
            renderDiffPage();
        }

        function exitDiffMode() {
            diffOverlay.classList.add('hidden');
            contentEl.style.display = 'flex';
            if (otherPdfDoc && otherPdfDoc.destroy) {
                try { otherPdfDoc.destroy(); } catch (e) { /* ignore */ }
            }
            otherPdfDoc = null;
        }

        diffExitBtn.addEventListener('click', exitDiffMode);

        diffModeOverlayBtn.addEventListener('click', () => {
            diffMode = 'overlay';
            diffModeOverlayBtn.classList.add('active');
            diffModeSideBySideBtn.classList.remove('active');
            renderDiffPage();
        });
        diffModeSideBySideBtn.addEventListener('click', () => {
            diffMode = 'sidebyside';
            diffModeSideBySideBtn.classList.add('active');
            diffModeOverlayBtn.classList.remove('active');
            renderDiffPage();
        });

        diffPrevPageBtn.addEventListener('click', () => {
            if (diffPage > 1) { diffPage--; renderDiffPage(); }
        });
        diffNextPageBtn.addEventListener('click', () => {
            if (diffPage < diffTotalPages) { diffPage++; renderDiffPage(); }
        });

        // Renders one page from a given document to an offscreen canvas at a fixed
        // scale. Intentionally NOT using the shared getViewport() helper (which
        // applies the main viewer's currentRotation) - diff rendering always uses
        // a fixed, unrotated scale so the two versions being compared line up
        // consistently regardless of whatever the user's current view state is.
        async function renderPageToCanvas(doc, pageNum, scale) {
            const page = await doc.getPage(pageNum);
            const viewport = page.getViewport({ scale: scale });
            const canvas = document.createElement('canvas');
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            const ctx = canvas.getContext('2d');
            await page.render({ canvasContext: ctx, viewport: viewport }).promise;
            return canvas;
        }

        // Produces a heatmap canvas: a dimmed copy of canvasA as background, with
        // red overlaid wherever the two canvases differ beyond a per-channel
        // threshold, and blue for any region that only exists in one of the two
        // (i.e. one page is physically larger than the other).
        function computePixelDiff(canvasA, canvasB) {
            const w = Math.max(canvasA.width, canvasB.width);
            const h = Math.max(canvasA.height, canvasB.height);
            const diffCanvas = document.createElement('canvas');
            diffCanvas.width = w;
            diffCanvas.height = h;
            const diffCtx = diffCanvas.getContext('2d');

            diffCtx.fillStyle = '#000';
            diffCtx.fillRect(0, 0, w, h);
            diffCtx.globalAlpha = 0.35;
            diffCtx.drawImage(canvasA, 0, 0);
            diffCtx.globalAlpha = 1;

            const dataA = canvasA.getContext('2d').getImageData(0, 0, canvasA.width, canvasA.height).data;
            const dataB = canvasB.getContext('2d').getImageData(0, 0, canvasB.width, canvasB.height).data;

            const outImageData = diffCtx.getImageData(0, 0, w, h);
            const out = outImageData.data;

            const THRESHOLD = 24;
            let changedPixelCount = 0;

            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    const outIdx = (y * w + x) * 4;
                    const inA = x < canvasA.width && y < canvasA.height;
                    const inB = x < canvasB.width && y < canvasB.height;

                    if (!inA || !inB) {
                        out[outIdx] = 60; out[outIdx + 1] = 140; out[outIdx + 2] = 255; out[outIdx + 3] = 220;
                        changedPixelCount++;
                        continue;
                    }

                    const idxA = (y * canvasA.width + x) * 4;
                    const idxB = (y * canvasB.width + x) * 4;
                    const dr = Math.abs(dataA[idxA] - dataB[idxB]);
                    const dg = Math.abs(dataA[idxA + 1] - dataB[idxB + 1]);
                    const db = Math.abs(dataA[idxA + 2] - dataB[idxB + 2]);

                    if (dr > THRESHOLD || dg > THRESHOLD || db > THRESHOLD) {
                        out[outIdx] = 255; out[outIdx + 1] = 40; out[outIdx + 2] = 40; out[outIdx + 3] = 220;
                        changedPixelCount++;
                    }
                }
            }

            diffCtx.putImageData(outImageData, 0, 0);
            return { canvas: diffCanvas, changedPixelCount: changedPixelCount, totalPixelCount: w * h };
        }

        async function renderDiffPage() {
            diffPageIndicator.textContent = diffPage + ' / ' + diffTotalPages;
            diffPrevPageBtn.disabled = diffPage <= 1;
            diffNextPageBtn.disabled = diffPage >= diffTotalPages;
            diffBodyEl.innerHTML = '<div class="bookmarks-empty">Rendering...</div>';
            diffStatsEl.textContent = '';

            if (!pdfDoc || !otherPdfDoc) return;

            let canvasA, canvasB;
            try {
                canvasA = await renderPageToCanvas(pdfDoc, diffPage, DIFF_SCALE);
                canvasB = await renderPageToCanvas(otherPdfDoc, diffPage, DIFF_SCALE);
            } catch (e) {
                debugLog('renderDiffPage failed', (e && e.message) || String(e));
                diffBodyEl.innerHTML = '<div class="bookmarks-empty">Could not render this page for comparison.</div>';
                return;
            }

            diffBodyEl.innerHTML = '';

            if (diffMode === 'sidebyside') {
                const row = document.createElement('div');
                row.className = 'diff-side-by-side';
                [['Current', canvasA], [otherPdfLabel || 'Other', canvasB]].forEach(pair => {
                    const label = pair[0];
                    const canvas = pair[1];
                    const col = document.createElement('div');
                    col.className = 'diff-column';
                    const heading = document.createElement('div');
                    heading.className = 'diff-column-label';
                    heading.textContent = label;
                    col.appendChild(heading);
                    canvas.classList.add('diff-canvas');
                    col.appendChild(canvas);
                    row.appendChild(col);
                });
                diffBodyEl.appendChild(row);
            } else {
                const result = computePixelDiff(canvasA, canvasB);
                result.canvas.classList.add('diff-canvas');
                const wrap = document.createElement('div');
                wrap.className = 'diff-column';
                wrap.appendChild(result.canvas);
                diffBodyEl.appendChild(wrap);

                const pct = result.totalPixelCount > 0 ? ((result.changedPixelCount / result.totalPixelCount) * 100) : 0;
                diffStatsEl.textContent = pct.toFixed(1) + '% of this page changed';
            }
        }

        async function renderPdf(bytes) {
            try {
                // bytes arrives as a plain number array (see extension-side comment on
                // why we don't rely on Uint8Array surviving postMessage) - pdf.js
                // requires an actual TypedArray/string/array-like, so rebuild it here.
                const typedBytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
                fileSizeBytes = typedBytes.length;
                const loadingTask = pdfjsLib.getDocument({ data: typedBytes });
                pdfDoc = await loadingTask.promise;
                totalPages = pdfDoc.numPages;

                // Restore the last-viewed page/zoom (if any) before the first render,
                // so pages come up already at the right scale instead of flashing
                // default zoom and then re-rendering.
                if (pendingViewState && typeof pendingViewState.scale === 'number') {
                    currentScale = clampScale(pendingViewState.scale);
                }
                if (pendingViewState && pendingViewState.highContrast) {
                    applyHighContrast(true);
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
                debugLog('computed targetPage=', targetPage, 'from pendingViewState=', pendingViewState, 'totalPages=', totalPages);

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
                    debugLog('restoring scroll to page', targetPage, 'found target element:', !!target);
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
                    debugLog('restore guard lifted, currentPage=', currentPage);
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
                case 'toggle-toc': toggleTocBtn.click(); break;
                case 'toggle-high-contrast': toggleContrastBtn.click(); break;
                case 'copy-page-image': copyPageBtn.click(); break;
                case 'copy-page-images': copyImagesBtn.click(); break;
                case 'rotate-view': rotateViewBtn.click(); break;
                case 'toggle-properties': togglePropertiesBtn.click(); break;
                case 'toggle-git': toggleGitBtn.click(); break;
                case 'toggle-diff': toggleDiffBtn.click(); break;
                case 'toggle-tools': toggleToolsBtn.click(); break;
                case 'extract-pages': extractPagesBtn.click(); break;
                case 'compress-pdf': compressPdfBtn.click(); break;
                case 'merge-pdfs': mergePdfsBtn.click(); break;
                case 'split-pdf': splitPdfBtn.click(); break;
                case 'merge-annotations': mergeAnnotationsBtn.click(); break;
                case 'export-images': exportImagesBtn.click(); break;
            }
        }

        window.addEventListener('message', (event) => {
            const msg = event.data;
            if (msg.type === 'pdf-data') {
                pdfDataReceived = true;
                annotations = Array.isArray(msg.annotations) ? msg.annotations : [];
                bookmarks = Array.isArray(msg.bookmarks) ? msg.bookmarks : [];
                pendingViewState = (msg.viewState && typeof msg.viewState === 'object') ? msg.viewState : null;
                debugLog('received pdf-data, viewState=', pendingViewState);
                renderPdf(msg.data);
            } else if (msg.type === 'pdf-error') {
                pdfDataReceived = true;
                showError(msg.message);
            } else if (msg.type === 'command') {
                handleExternalCommand(msg.action, msg.payload);
            } else if (msg.type === 'git-status') {
                renderGitStatus(msg.status);
            } else if (msg.type === 'git-log') {
                gitLogCache = Array.isArray(msg.log) ? msg.log : [];
                renderGitLogList(gitLogCache, gitLogListEl);
                // Also refresh the diff-setup panel's copy if it's currently open
                // and was waiting on this same fetch.
                if (!diffSetupPanel.classList.contains('hidden')) {
                    renderGitLogList(gitLogCache, diffSetupLogListEl);
                }
            } else if (msg.type === 'git-commit-result') {
                gitCommitBtn.disabled = false;
                gitCommitBtn.textContent = 'Commit PDF & Annotations';
                if (msg.ok) {
                    gitCommitMessageEl.value = '';
                    refreshGitStatus();
                    refreshGitLog();
                }
            } else if (msg.type === 'diff-data') {
                loadDiffOther(msg.label, msg.data);
            } else if (msg.type === 'diff-error') {
                debugLog('diff-error from extension host', msg.message);
                window.alert('Could not load that PDF for comparison: ' + msg.message);
            } else if (msg.type === 'export-images-config') {
                runImageExportQueue(msg.pages, msg.destFolder, msg.stem);
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

// ---- Annotations sidecar file (git-trackable) ------------------------------
// globalState (above) is opaque to git - it lives in VS Code's own storage, not
// the workspace, so annotation history was previously invisible to version
// control entirely. When a PDF is part of an open workspace, annotations are
// also written to a plain JSON file next to it, which git can track/diff/commit
// like any other file. globalState remains the fallback/cache for PDFs opened
// from outside any workspace, and for backward compatibility with annotations
// saved before this sidecar mechanism existed.

function getAnnotationsSidecarUri(pdfUri: vscode.Uri): vscode.Uri | undefined {
    const folder = vscode.workspace.getWorkspaceFolder(pdfUri);
    if (!folder) return undefined; // not part of an open workspace - don't scatter files next to it

    const dir = vscode.Uri.joinPath(pdfUri, '..');
    const baseName = pdfUri.path.split('/').pop() || 'document.pdf';
    const stem = baseName.toLowerCase().endsWith('.pdf') ? baseName.slice(0, -4) : baseName;
    return vscode.Uri.joinPath(dir, stem + '.annotations.json');
}

async function readAnnotationsSidecar(pdfUri: vscode.Uri): Promise<unknown[] | undefined> {
    const sidecarUri = getAnnotationsSidecarUri(pdfUri);
    if (!sidecarUri) return undefined;
    try {
        const bytes = await vscode.workspace.fs.readFile(sidecarUri);
        const parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
        if (Array.isArray(parsed)) return parsed;
        if (parsed && Array.isArray(parsed.annotations)) return parsed.annotations;
        return undefined;
    } catch (e) {
        return undefined; // doesn't exist yet, or isn't valid JSON - caller falls back to globalState
    }
}

async function writeAnnotationsSidecar(pdfUri: vscode.Uri, annotations: unknown[]): Promise<void> {
    const sidecarUri = getAnnotationsSidecarUri(pdfUri);
    if (!sidecarUri) return; // not in a workspace - globalState alone is the source of truth
    try {
        await vscode.workspace.fs.writeFile(sidecarUri, Buffer.from(JSON.stringify(annotations, null, 2), 'utf8'));
    } catch (e) {
        // best-effort only (e.g. read-only filesystem) - globalState still has the data
    }
}

// Prefers the sidecar file (if present and parseable) over globalState, so
// annotations checked out from a past commit take precedence over whatever
// happens to be cached locally.
async function getEffectiveAnnotations(context: vscode.ExtensionContext, uri: vscode.Uri): Promise<unknown[]> {
    const fromSidecar = await readAnnotationsSidecar(uri);
    if (fromSidecar) return fromSidecar;
    return getStoredAnnotations(context, uri);
}

// ---- Git integration --------------------------------------------------------
// Shells out to the git CLI directly (respecting VS Code's own git.path setting
// if configured) rather than depending on the internal, unofficially-typed
// vscode.git extension API. This also sidesteps a real correctness risk: that
// API's Repository.show() returns file content as a string, which is not safe
// for binary data like a PDF - decoding arbitrary binary bytes as text can
// corrupt them. Fetching historical file content below uses 'buffer' encoding
// specifically to avoid that.

function getConfiguredGitPath(): string {
    const config = vscode.workspace.getConfiguration('git');
    return config.get<string>('path') || 'git';
}

function runGitText(args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
        child_process.execFile(
            getConfiguredGitPath(),
            args,
            { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 * 50 },
            (err, stdout, stderr) => {
                if (err) {
                    reject(new Error(((stderr as string) || err.message || 'git command failed').toString().trim()));
                    return;
                }
                resolve(stdout.toString());
            }
        );
    });
}

function runGitBinary(args: string[], cwd: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        child_process.execFile(
            getConfiguredGitPath(),
            args,
            { cwd, encoding: 'buffer', maxBuffer: 1024 * 1024 * 200 },
            (err, stdout, stderr) => {
                if (err) {
                    const stderrText = stderr ? stderr.toString() : '';
                    reject(new Error(stderrText || err.message || 'git command failed'));
                    return;
                }
                resolve(stdout as unknown as Buffer);
            }
        );
    });
}

function getGitCwd(uri: vscode.Uri): string {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    return folder ? folder.uri.fsPath : path.dirname(uri.fsPath);
}

function getRelativeGitPath(uri: vscode.Uri, cwd: string): string {
    return path.relative(cwd, uri.fsPath).split(path.sep).join('/');
}

interface GitFileStatus {
    isRepo: boolean;
    status: 'clean' | 'modified' | 'untracked' | 'staged' | 'unknown';
    branch?: string;
}

async function getGitFileStatus(uri: vscode.Uri): Promise<GitFileStatus> {
    const cwd = getGitCwd(uri);
    const rel = getRelativeGitPath(uri, cwd);

    try {
        await runGitText(['rev-parse', '--is-inside-work-tree'], cwd);
    } catch (e) {
        return { isRepo: false, status: 'unknown' };
    }

    let branch = '';
    try {
        branch = (await runGitText(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).trim();
    } catch (e) {
        // detached HEAD or a brand new repo with no commits yet - leave branch blank
    }

    try {
        const out = await runGitText(['status', '--porcelain', '--', rel], cwd);
        const line = out.split('\n').find(l => l.trim().length > 0);
        if (!line) return { isRepo: true, status: 'clean', branch };
        const code = line.slice(0, 2);
        if (code.includes('?')) return { isRepo: true, status: 'untracked', branch };
        if (code[0] !== ' ') return { isRepo: true, status: 'staged', branch };
        return { isRepo: true, status: 'modified', branch };
    } catch (e) {
        return { isRepo: true, status: 'unknown', branch };
    }
}

interface GitLogEntry {
    hash: string;
    shortHash: string;
    author: string;
    date: string;
    message: string;
}

async function getGitFileLog(uri: vscode.Uri, maxEntries: number = 25): Promise<GitLogEntry[]> {
    const cwd = getGitCwd(uri);
    const rel = getRelativeGitPath(uri, cwd);
    // Field separator \x1f and record separator \x1e keep parsing robust even
    // if a commit message happens to contain a comma, pipe, etc.
    const format = '%H%x1f%an%x1f%ad%x1f%s%x1e';
    try {
        const out = await runGitText(
            ['log', '--follow', '--max-count=' + String(maxEntries), '--date=short', '--pretty=format:' + format, '--', rel],
            cwd
        );
        return out.split('\x1e')
            .map(rec => rec.trim())
            .filter(Boolean)
            .map(rec => {
                const parts = rec.split('\x1f');
                const hash = parts[0] || '';
                return {
                    hash,
                    shortHash: hash.slice(0, 7),
                    author: parts[1] || '',
                    date: parts[2] || '',
                    message: parts[3] || ''
                };
            });
    } catch (e) {
        return [];
    }
}

async function getFileAtGitRevision(uri: vscode.Uri, ref: string): Promise<Uint8Array> {
    const cwd = getGitCwd(uri);
    const rel = getRelativeGitPath(uri, cwd);
    const buf = await runGitBinary(['show', ref + ':' + rel], cwd);
    return new Uint8Array(buf);
}

// Stages and commits the PDF plus its annotations sidecar (if one exists),
// scoped strictly to those two paths via pathspec so any other unrelated
// staged changes the user might have pending are left untouched.
async function commitPdfAndAnnotations(uri: vscode.Uri, message: string): Promise<void> {
    const cwd = getGitCwd(uri);
    const rel = getRelativeGitPath(uri, cwd);
    const paths = [rel];

    const sidecarUri = getAnnotationsSidecarUri(uri);
    if (sidecarUri) {
        try {
            await vscode.workspace.fs.stat(sidecarUri);
            paths.push(getRelativeGitPath(sidecarUri, cwd));
        } catch (e) {
            // no sidecar yet (no annotations saved) - just commit the PDF itself
        }
    }

    await runGitText(['add', '--', ...paths], cwd);
    await runGitText(['commit', '-m', message, '--', ...paths], cwd);
}

interface PdfViewState {
    page: number;
    scale: number;
    highContrast?: boolean;
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

// Resolves a cross-document link (GoToR action) target and opens it. pdf.js
// encodes these as a bare filename, optionally with a "#nameddest=..." or
// "#[...]" fragment describing a destination *within* the target file (see
// pdf.js's annotation.js) - we don't currently resolve that specific
// destination, just open the target file itself, which is still the core of
// what a GoToR link is for.
async function resolveAndOpenLinkedFile(currentUri: vscode.Uri, rawTarget: string): Promise<void> {
    const filePart = rawTarget.split('#')[0];
    if (!filePart) {
        vscode.window.showErrorMessage('pdfDisplay: this link does not point to a valid file.');
        return;
    }

    let targetUri: vscode.Uri;
    try {
        const isAbsolute = /^[a-zA-Z]:[\\/]/.test(filePart) || filePart.startsWith('/');
        targetUri = isAbsolute
            ? vscode.Uri.file(filePart)
            : vscode.Uri.joinPath(currentUri, '..', filePart);
    } catch (e) {
        vscode.window.showErrorMessage(`pdfDisplay: could not resolve linked file "${filePart}".`);
        return;
    }

    try {
        await vscode.workspace.fs.stat(targetUri);
    } catch (e) {
        vscode.window.showErrorMessage(`pdfDisplay: linked file not found - ${targetUri.fsPath}`);
        return;
    }

    if (targetUri.fsPath.toLowerCase().endsWith('.pdf')) {
        vscode.commands.executeCommand('vscode.openWith', targetUri, PdfViewerProvider.viewType);
    } else {
        // Not a PDF - let VS Code pick whatever handler is appropriate for it.
        vscode.commands.executeCommand('vscode.open', targetUri);
    }
}

// ---- Export: annotated PDF + standalone annotations JSON ------------------
// Both run entirely in the extension host, using the raw PDF bytes and stored
// annotations it already has direct access to - no round trip through the
// webview needed, unlike the toolbar-driven features above.

interface StoredAnnotation {
    id?: string;
    pageNum: number;
    xRatio: number;
    yRatio: number;
    text: string;
    createdAt?: number;
}

function isStoredAnnotation(value: unknown): value is StoredAnnotation {
    if (!value || typeof value !== 'object') return false;
    const rec = value as Record<string, unknown>;
    return typeof rec.pageNum === 'number'
        && typeof rec.xRatio === 'number'
        && typeof rec.yRatio === 'number'
        && typeof rec.text === 'string';
}

function wrapTextForPdf(text: string, font: PDFFont, fontSize: number, maxWidth: number): string[] {
    const words = text.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let current = '';
    for (const word of words) {
        const candidate = current ? current + ' ' + word : word;
        if (font.widthOfTextAtSize(candidate, fontSize) > maxWidth && current) {
            lines.push(current);
            current = word;
        } else {
            current = candidate;
        }
    }
    if (current) lines.push(current);
    return lines;
}

function suggestedExportName(uri: vscode.Uri, suffix: string): string {
    const baseName = uri.path.split('/').pop() || 'document.pdf';
    const stem = baseName.toLowerCase().endsWith('.pdf') ? baseName.slice(0, -4) : baseName;
    return stem + suffix;
}

function formatBytesForMessage(bytes: number): string {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

// Parses a page-range string like "1-3,5,8-10" into a deduplicated, ordered
// list of 1-based page numbers, silently dropping anything out of bounds or
// unparseable rather than failing the whole input over one bad segment.
function parsePageRanges(input: string, maxPage: number): number[] {
    const result: number[] = [];
    const seen = new Set<number>();
    const parts = input.split(',').map(p => p.trim()).filter(Boolean);

    for (const part of parts) {
        const rangeMatch = /^(\d+)\s*-\s*(\d+)$/.exec(part);
        if (rangeMatch) {
            let start = parseInt(rangeMatch[1], 10);
            let end = parseInt(rangeMatch[2], 10);
            if (start > end) { const tmp = start; start = end; end = tmp; }
            for (let p = start; p <= end; p++) {
                if (p >= 1 && p <= maxPage && !seen.has(p)) { seen.add(p); result.push(p); }
            }
        } else if (/^\d+$/.test(part)) {
            const p = parseInt(part, 10);
            if (p >= 1 && p <= maxPage && !seen.has(p)) { seen.add(p); result.push(p); }
        }
    }

    return result;
}

// ---- Extract / export selected pages ---------------------------------------

async function extractPages(uri: vscode.Uri): Promise<void> {
    let srcDoc: PDFDocument;
    try {
        const srcBytes = await vscode.workspace.fs.readFile(uri);
        srcDoc = await PDFDocument.load(srcBytes);
    } catch (e: any) {
        vscode.window.showErrorMessage('pdfDisplay: could not open the PDF - ' + (e?.message ?? String(e)));
        return;
    }

    const pageCount = srcDoc.getPageCount();
    const input = await vscode.window.showInputBox({
        prompt: `Which pages to extract? (1-${pageCount}), e.g. "1-3,5,8-10"`,
        validateInput: v => parsePageRanges(v, pageCount).length > 0 ? undefined : 'Enter at least one valid page number or range'
    });
    if (!input) return;

    const pageNumbers = parsePageRanges(input, pageCount);
    if (pageNumbers.length === 0) return;

    const outDoc = await PDFDocument.create();
    const copiedPages = await outDoc.copyPages(srcDoc, pageNumbers.map(n => n - 1));
    copiedPages.forEach(p => outDoc.addPage(p));

    let outputBytes: Uint8Array;
    try {
        outputBytes = await outDoc.save();
    } catch (e: any) {
        vscode.window.showErrorMessage('pdfDisplay: failed to build the extracted PDF - ' + (e?.message ?? String(e)));
        return;
    }

    const defaultDir = vscode.Uri.joinPath(uri, '..');
    const saveUri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.joinPath(defaultDir, suggestedExportName(uri, '-pages.pdf')),
        filters: { 'PDF': ['pdf'] }
    });
    if (!saveUri) return;

    try {
        await vscode.workspace.fs.writeFile(saveUri, outputBytes);
    } catch (e: any) {
        vscode.window.showErrorMessage('pdfDisplay: failed to save the extracted PDF - ' + (e?.message ?? String(e)));
        return;
    }

    const pageWord = pageNumbers.length === 1 ? 'page' : 'pages';
    const choice = await vscode.window.showInformationMessage(`Extracted ${pageNumbers.length} ${pageWord}.`, 'Open');
    if (choice === 'Open') {
        vscode.commands.executeCommand('vscode.openWith', saveUri, PdfViewerProvider.viewType);
    }
}

// ---- PDF compression ---------------------------------------------------------

async function compressPdf(uri: vscode.Uri): Promise<void> {
    let originalBytes: Uint8Array;
    let pdfDoc: PDFDocument;
    try {
        originalBytes = await vscode.workspace.fs.readFile(uri);
        pdfDoc = await PDFDocument.load(originalBytes);
    } catch (e: any) {
        vscode.window.showErrorMessage('pdfDisplay: could not open the PDF - ' + (e?.message ?? String(e)));
        return;
    }

    let outputBytes: Uint8Array;
    try {
        // pdf-lib doesn't recompress embedded images or subset fonts - this is a
        // lightweight, safe optimization (compacting the PDF's internal object
        // structure via object streams), not full image-recompression-grade
        // compression. Results vary a lot depending on how the source PDF was
        // produced; an already-optimized file may see little to no reduction.
        outputBytes = await pdfDoc.save({ useObjectStreams: true });
    } catch (e: any) {
        vscode.window.showErrorMessage('pdfDisplay: compression failed - ' + (e?.message ?? String(e)));
        return;
    }

    const beforeSize = originalBytes.byteLength;
    const afterSize = outputBytes.byteLength;

    if (afterSize >= beforeSize) {
        vscode.window.showInformationMessage(
            'pdfDisplay: this file is already compact - no meaningful size reduction was possible (' +
            formatBytesForMessage(beforeSize) + ' -> ' + formatBytesForMessage(afterSize) + ').'
        );
        return;
    }

    const savedPct = ((beforeSize - afterSize) / beforeSize) * 100;
    const defaultDir = vscode.Uri.joinPath(uri, '..');
    const saveUri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.joinPath(defaultDir, suggestedExportName(uri, '-compressed.pdf')),
        filters: { 'PDF': ['pdf'] }
    });
    if (!saveUri) return;

    try {
        await vscode.workspace.fs.writeFile(saveUri, outputBytes);
    } catch (e: any) {
        vscode.window.showErrorMessage('pdfDisplay: failed to save the compressed PDF - ' + (e?.message ?? String(e)));
        return;
    }

    const choice = await vscode.window.showInformationMessage(
        'Saved compressed PDF: ' + formatBytesForMessage(beforeSize) + ' -> ' + formatBytesForMessage(afterSize) +
        ' (' + savedPct.toFixed(0) + '% smaller).',
        'Open'
    );
    if (choice === 'Open') {
        vscode.commands.executeCommand('vscode.openWith', saveUri, PdfViewerProvider.viewType);
    }
}

// ---- Merge multiple PDFs into one -------------------------------------------

async function mergePdfs(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
        canSelectMany: true,
        filters: { 'PDF': ['pdf'] },
        openLabel: 'Select PDFs to merge'
    });
    if (!uris || uris.length < 2) {
        if (uris && uris.length === 1) {
            vscode.window.showInformationMessage('pdfDisplay: select at least 2 PDF files to merge.');
        }
        return;
    }

    // NOTE: the order files come back in from the OS picker isn't guaranteed to
    // match click order on every platform - if the merged order matters, check
    // the result and re-run if needed.
    const outDoc = await PDFDocument.create();
    for (const srcUri of uris) {
        try {
            const bytes = await vscode.workspace.fs.readFile(srcUri);
            const srcDoc = await PDFDocument.load(bytes);
            const pages = await outDoc.copyPages(srcDoc, srcDoc.getPageIndices());
            pages.forEach(p => outDoc.addPage(p));
        } catch (e: any) {
            const name = srcUri.path.split('/').pop() || srcUri.fsPath;
            vscode.window.showErrorMessage('pdfDisplay: could not read "' + name + '" - ' + (e?.message ?? String(e)));
            return;
        }
    }

    let outputBytes: Uint8Array;
    try {
        outputBytes = await outDoc.save();
    } catch (e: any) {
        vscode.window.showErrorMessage('pdfDisplay: failed to build the merged PDF - ' + (e?.message ?? String(e)));
        return;
    }

    const defaultDir = vscode.Uri.joinPath(uris[0], '..');
    const saveUri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.joinPath(defaultDir, 'merged.pdf'),
        filters: { 'PDF': ['pdf'] }
    });
    if (!saveUri) return;

    try {
        await vscode.workspace.fs.writeFile(saveUri, outputBytes);
    } catch (e: any) {
        vscode.window.showErrorMessage('pdfDisplay: failed to save the merged PDF - ' + (e?.message ?? String(e)));
        return;
    }

    const choice = await vscode.window.showInformationMessage('Merged ' + uris.length + ' files into one PDF.', 'Open');
    if (choice === 'Open') {
        vscode.commands.executeCommand('vscode.openWith', saveUri, PdfViewerProvider.viewType);
    }
}

// ---- Split a PDF into multiple files by page range --------------------------

async function splitPdf(uri: vscode.Uri): Promise<void> {
    let srcDoc: PDFDocument;
    try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        srcDoc = await PDFDocument.load(bytes);
    } catch (e: any) {
        vscode.window.showErrorMessage('pdfDisplay: could not open the PDF - ' + (e?.message ?? String(e)));
        return;
    }

    const pageCount = srcDoc.getPageCount();
    const input = await vscode.window.showInputBox({
        prompt: 'Split into parts by page range (' + pageCount + ' pages total), e.g. "1-3,4-6,7-' + pageCount + '"',
        validateInput: v => {
            const parts = v.split(',').map(p => p.trim()).filter(Boolean);
            if (parts.length === 0) return 'Enter at least one range';
            for (const part of parts) {
                if (parsePageRanges(part, pageCount).length === 0) return '"' + part + '" is not a valid range';
            }
            return undefined;
        }
    });
    if (!input) return;

    const rangeStrings = input.split(',').map(p => p.trim()).filter(Boolean);
    const parts = rangeStrings.map(r => parsePageRanges(r, pageCount)).filter(p => p.length > 0);
    if (parts.length === 0) return;

    const destFolders = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        openLabel: 'Choose output folder'
    });
    if (!destFolders || destFolders.length === 0) return;
    const destFolder = destFolders[0];
    const stem = suggestedExportName(uri, '').replace(/\.pdf$/i, '') || 'document';

    let written = 0;
    for (let i = 0; i < parts.length; i++) {
        try {
            const outDoc = await PDFDocument.create();
            const copiedPages = await outDoc.copyPages(srcDoc, parts[i].map(n => n - 1));
            copiedPages.forEach(p => outDoc.addPage(p));
            const outputBytes = await outDoc.save();
            const partUri = vscode.Uri.joinPath(destFolder, stem + '-part' + (i + 1) + '.pdf');
            await vscode.workspace.fs.writeFile(partUri, outputBytes);
            written++;
        } catch (e: any) {
            vscode.window.showErrorMessage('pdfDisplay: failed to write part ' + (i + 1) + ' - ' + (e?.message ?? String(e)));
        }
    }

    const fileWord = written === 1 ? 'file' : 'files';
    vscode.window.showInformationMessage('Split into ' + written + ' ' + fileWord + ' in ' + destFolder.fsPath + '.');
}

// ---- Convert pages to image files -------------------------------------------
// The extension host handles the "which pages / where to save" setup (this
// function); the actual rasterization has to happen in the webview since only
// pdf.js there can render a page to a canvas - see the 'export-image-data'
// message handler in resolveCustomEditor for the write side of that handoff.

async function promptExportImagesSetup(uri: vscode.Uri, totalPages: number): Promise<{ pages: number[]; destFolder: string; stem: string } | undefined> {
    const input = await vscode.window.showInputBox({
        prompt: 'Which pages to export as images? (1-' + totalPages + '), e.g. "1-3,5" or "all"',
        value: 'all',
        validateInput: v => {
            if (v.trim().toLowerCase() === 'all') return undefined;
            return parsePageRanges(v, totalPages).length > 0 ? undefined : 'Enter at least one valid page number or range, or "all"';
        }
    });
    if (!input) return undefined;

    const pages = input.trim().toLowerCase() === 'all'
        ? Array.from({ length: totalPages }, (_, i) => i + 1)
        : parsePageRanges(input, totalPages);
    if (pages.length === 0) return undefined;

    const destFolders = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        openLabel: 'Choose output folder'
    });
    if (!destFolders || destFolders.length === 0) return undefined;

    const stem = suggestedExportName(uri, '').replace(/\.pdf$/i, '') || 'document';
    return { pages, destFolder: destFolders[0].fsPath, stem };
}

// Draws each sticky note onto its page as a visible pin + wrapped text label.
// Shared by exportAnnotatedPdf (save as a new file) and mergeAnnotationsIntoPdf
// (overwrite the original) below, so both stay in sync automatically.
async function bakeAnnotationsOntoDoc(pdfDoc: PDFDocument, annotations: StoredAnnotation[]): Promise<void> {
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const pages = pdfDoc.getPages();
    const FONT_SIZE = 9;
    const PIN_RADIUS = 6;
    const MAX_TEXT_WIDTH = 220;
    const MAX_TEXT_LENGTH = 400; // keep a very long note from producing a huge label block

    for (const ann of annotations) {
        const pageIndex = ann.pageNum - 1;
        if (pageIndex < 0 || pageIndex >= pages.length) continue; // stale annotation, e.g. from a differently-paginated version of the file

        const page = pages[pageIndex];
        const { width, height } = page.getSize();
        // Stored ratios are relative to a top-left origin (screen coordinates);
        // PDF space has a bottom-left origin, so the Y axis needs flipping.
        const x = ann.xRatio * width;
        const y = height - (ann.yRatio * height);

        page.drawCircle({
            x, y,
            size: PIN_RADIUS,
            color: rgb(1, 0.85, 0.2),
            borderColor: rgb(0.55, 0.4, 0),
            borderWidth: 1
        });

        const text = ann.text.length > MAX_TEXT_LENGTH ? ann.text.slice(0, MAX_TEXT_LENGTH) + '…' : ann.text;
        const lines = wrapTextForPdf(text, font, FONT_SIZE, MAX_TEXT_WIDTH);
        const lineHeight = FONT_SIZE * 1.3;
        const boxHeight = lines.length * lineHeight + 8;
        const boxWidth = MAX_TEXT_WIDTH + 12;
        const boxX = Math.min(x + PIN_RADIUS + 4, width - boxWidth - 4);
        const boxY = Math.max(y - boxHeight, 4);

        page.drawRectangle({
            x: boxX,
            y: boxY,
            width: boxWidth,
            height: boxHeight,
            color: rgb(1, 0.98, 0.75),
            borderColor: rgb(0.6, 0.5, 0.1),
            borderWidth: 0.75,
            opacity: 0.95
        });

        lines.forEach((line, i) => {
            page.drawText(line, {
                x: boxX + 6,
                y: boxY + boxHeight - (i + 1) * lineHeight,
                size: FONT_SIZE,
                font,
                color: rgb(0.15, 0.12, 0)
            });
        });
    }
}

async function exportAnnotatedPdf(context: vscode.ExtensionContext, uri: vscode.Uri): Promise<void> {
    const annotations = getStoredAnnotations(context, uri).filter(isStoredAnnotation);

    if (annotations.length === 0) {
        vscode.window.showInformationMessage('pdfDisplay: no sticky notes to bake into this PDF.');
        return;
    }

    let pdfDoc: PDFDocument;
    try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        pdfDoc = await PDFDocument.load(bytes);
    } catch (e: any) {
        vscode.window.showErrorMessage('pdfDisplay: could not open the PDF for export - ' + (e?.message ?? String(e)));
        return;
    }

    await bakeAnnotationsOntoDoc(pdfDoc, annotations);

    let outputBytes: Uint8Array;
    try {
        outputBytes = await pdfDoc.save();
    } catch (e: any) {
        vscode.window.showErrorMessage('pdfDisplay: failed to generate the annotated PDF - ' + (e?.message ?? String(e)));
        return;
    }

    const defaultDir = vscode.Uri.joinPath(uri, '..');
    const saveUri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.joinPath(defaultDir, suggestedExportName(uri, '-annotated.pdf')),
        filters: { 'PDF': ['pdf'] }
    });
    if (!saveUri) return; // user cancelled

    try {
        await vscode.workspace.fs.writeFile(saveUri, outputBytes);
    } catch (e: any) {
        vscode.window.showErrorMessage('pdfDisplay: failed to save the annotated PDF - ' + (e?.message ?? String(e)));
        return;
    }

    const noteWord = annotations.length === 1 ? 'note' : 'notes';
    const choice = await vscode.window.showInformationMessage(
        `Saved annotated PDF with ${annotations.length} ${noteWord} baked in.`,
        'Open'
    );
    if (choice === 'Open') {
        vscode.commands.executeCommand('vscode.openWith', saveUri, PdfViewerProvider.viewType);
    }
}

// In-place variant of exportAnnotatedPdf above: bakes annotations directly into
// the currently-open file and overwrites it, rather than saving a copy. This is
// destructive, so it requires an explicit modal confirmation. Returns whether it
// actually happened, so the caller (the message handler in resolveCustomEditor)
// knows whether to refresh the webview with the new content.
async function mergeAnnotationsIntoPdf(context: vscode.ExtensionContext, uri: vscode.Uri): Promise<boolean> {
    const sidecarAnnotations = await readAnnotationsSidecar(uri);
    const effective = (sidecarAnnotations ?? getStoredAnnotations(context, uri)).filter(isStoredAnnotation);

    if (effective.length === 0) {
        vscode.window.showInformationMessage('pdfDisplay: no sticky notes to merge into this PDF.');
        return false;
    }

    const noteWord = effective.length === 1 ? 'note' : 'notes';
    const confirmChoice = await vscode.window.showWarningMessage(
        `This will permanently draw ${effective.length} ${noteWord} onto the PDF and overwrite the original file. This cannot be undone from within the extension.`,
        { modal: true },
        'Merge & Overwrite'
    );
    if (confirmChoice !== 'Merge & Overwrite') return false;

    let pdfDoc: PDFDocument;
    try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        pdfDoc = await PDFDocument.load(bytes);
    } catch (e: any) {
        vscode.window.showErrorMessage('pdfDisplay: could not open the PDF - ' + (e?.message ?? String(e)));
        return false;
    }

    await bakeAnnotationsOntoDoc(pdfDoc, effective);

    let outputBytes: Uint8Array;
    try {
        outputBytes = await pdfDoc.save();
    } catch (e: any) {
        vscode.window.showErrorMessage('pdfDisplay: failed to generate the merged PDF - ' + (e?.message ?? String(e)));
        return false;
    }

    try {
        await vscode.workspace.fs.writeFile(uri, outputBytes);
    } catch (e: any) {
        vscode.window.showErrorMessage('pdfDisplay: failed to overwrite the PDF - ' + (e?.message ?? String(e)));
        return false;
    }

    vscode.window.showInformationMessage(`Merged ${effective.length} ${noteWord} into the PDF.`);
    return true;
}

// Exports just the sticky notes as JSON, independent of the PDF file itself -
// e.g. for backing them up, diffing across versions, or importing into another tool.
async function exportAnnotationsJson(context: vscode.ExtensionContext, uri: vscode.Uri): Promise<void> {
    const annotations = getStoredAnnotations(context, uri);
    if (!annotations || annotations.length === 0) {
        vscode.window.showInformationMessage('pdfDisplay: no sticky notes to export for this PDF.');
        return;
    }

    const defaultDir = vscode.Uri.joinPath(uri, '..');
    const saveUri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.joinPath(defaultDir, suggestedExportName(uri, '-annotations.json')),
        filters: { 'JSON': ['json'] }
    });
    if (!saveUri) return; // user cancelled

    const payload = {
        sourceFile: uri.toString(),
        exportedAt: new Date().toISOString(),
        annotations
    };

    try {
        await vscode.workspace.fs.writeFile(saveUri, Buffer.from(JSON.stringify(payload, null, 2), 'utf8'));
    } catch (e: any) {
        vscode.window.showErrorMessage('pdfDisplay: failed to save annotations - ' + (e?.message ?? String(e)));
        return;
    }

    const noteWord = annotations.length === 1 ? 'annotation' : 'annotations';
    vscode.window.showInformationMessage(`Exported ${annotations.length} ${noteWord}.`);
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
