import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export function activate(context: vscode.ExtensionContext) {
    const provider = new PdfViewerProvider(context);
    context.subscriptions.push(vscode.window.registerCustomEditorProvider(PdfViewerProvider.viewType, provider));
    
    context.subscriptions.push(vscode.commands.registerCommand('pdfDisplay.openPdf', async (uri: vscode.Uri) => {
        if (!uri) {
            const uris = await vscode.window.showOpenDialog({ filters: { 'PDFs': ['pdf'] } });
            if (uris && uris.length > 0) {
                uri = uris[0];
            } else {
                return;
            }
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
            localResourceRoots: [
                vscode.Uri.file(path.dirname(document.uri.fsPath))
            ]
        };

        const updateWebview = async () => {
            const pdfBytes = fs.readFileSync(document.uri.fsPath);
            const pdfBase64 = Buffer.from(pdfBytes).toString('base64');
            const fileName = path.basename(document.uri.fsPath);
            webviewPanel.webview.html = this.getHtmlForWebview(pdfBase64, fileName);
        };

        await updateWebview();
    }

    private getHtmlForWebview(pdfBase64: string, fileName: string): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' https://*; style-src 'unsafe-inline'; img-src data:; connect-src https://*; child-src blob:; worker-src blob:;">
    <title>PDF Viewer - ${fileName}</title>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.min.js"></script>
    <style>
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

        canvas {
            max-width: 100%;
            height: auto;
            border-radius: 2px;
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

    <script>
        const pdfjsLib = window['pdfjs-dist/build/pdf'];
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';

        const base64Data = "${pdfBase64}";

        async function init() {
            try {
                const container = document.getElementById('viewer-container');
                const binaryString = window.atob(base64Data);
                const bytes = new Uint8Array(binaryString.length);
                for (let i = 0; i < binaryString.length; i++) {
                    bytes[i] = binaryString.charCodeAt(i);
                }

                const loadingTask = pdfjsLib.getDocument({ data: bytes });
                const pdf = await loadingTask.promise;
                
                document.getElementById('loading-overlay').style.display = 'none';

                for (let i = 1; i <= pdf.numPages; i++) {
                    const page = await pdf.getPage(i);
                    const scale = 1.5;
                    const viewport = page.getViewport({ scale });

                    const pageContainer = document.createElement('div');
                    pageContainer.className = 'page-container';
                    pageContainer.style.width = viewport.width + 'px';
                    pageContainer.style.height = viewport.height + 'px';
                    
                    const canvas = document.createElement('canvas');
                    const context = canvas.getContext('2d');
                    canvas.height = viewport.height;
                    canvas.width = viewport.width;
                    
                    pageContainer.appendChild(canvas);
                    container.appendChild(pageContainer);

                    await page.render({
                        canvasContext: context,
                        viewport: viewport
                    }).promise;
                }
            } catch (error) {
                console.error('Error rendering PDF:', error);
                document.getElementById('loading-text').innerHTML = 
                    '<span style="color: #ff4d4d">Failed to load PDF: ' + error.message + '</span>';
                document.querySelector('.spinner').style.display = 'none';
            }
        }

        init();
    </script>
</body>
</html>`;
    }
}

export function deactivate() {}
