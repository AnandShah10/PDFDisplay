import * as vscode from 'vscode';
import { PDFDocument, StandardFonts, rgb, degrees, RGB } from 'pdf-lib';

/** Feasible PDF edit ops via pdf-lib. Saves a new file (never overwrites silently). */

function suggestedName(uri: vscode.Uri, suffix: string): string {
    const base = uri.path.split(/[\\/]/).pop() || 'document.pdf';
    return base.replace(/\.pdf$/i, '') + suffix + '.pdf';
}

async function loadDoc(uri: vscode.Uri): Promise<{ doc: PDFDocument; bytes: Uint8Array }> {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    return { doc, bytes };
}

/** Optional hook so the viewer can reload after an in-place overwrite. */
let onPdfOverwritten: ((uri: vscode.Uri) => void | Promise<void>) | undefined;

export function setOnPdfOverwritten(handler: (uri: vscode.Uri) => void | Promise<void>): void {
    onPdfOverwritten = handler;
}

/**
 * Ask how to save: overwrite the open file, or Save As a copy.
 * Edits are intentional; overwrite requires an explicit confirmation.
 */
async function saveAs(uri: vscode.Uri, bytes: Uint8Array, suffix: string): Promise<vscode.Uri | undefined> {
    const mode = await vscode.window.showQuickPick(
        [
            {
                label: '$(save) Overwrite original',
                description: uri.path.split(/[\\/]/).pop() || 'document.pdf',
                detail: 'Replace the file you have open (single working copy)',
                value: 'overwrite'
            },
            {
                label: '$(save-as) Save as new file…',
                description: suggestedName(uri, suffix),
                detail: 'Keep the original unchanged',
                value: 'copy'
            }
        ] as (vscode.QuickPickItem & { value: string })[],
        { placeHolder: 'Save edited PDF', ignoreFocusOut: true }
    );
    if (!mode) return undefined;

    if ((mode as any).value === 'overwrite') {
        const ok = await vscode.window.showWarningMessage(
            'Overwrite the original PDF on disk? This cannot be undone from the editor.',
            { modal: true },
            'Overwrite'
        );
        if (ok !== 'Overwrite') return undefined;
        await vscode.workspace.fs.writeFile(uri, bytes);
        vscode.window.showInformationMessage('PDF saved (original overwritten).');
        try {
            await onPdfOverwritten?.(uri);
        } catch {
            /* reload is best-effort */
        }
        return uri;
    }

    const saveUri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.joinPath(uri, '..', suggestedName(uri, suffix)),
        filters: { PDF: ['pdf'] }
    });
    if (!saveUri) return undefined;
    await vscode.workspace.fs.writeFile(saveUri, bytes);
    const choice = await vscode.window.showInformationMessage(
        'Saved copy: ' + (saveUri.path.split(/[\\/]/).pop() || 'document.pdf'),
        'Open'
    );
    if (choice === 'Open') {
        vscode.commands.executeCommand('vscode.openWith', saveUri, 'pdfDisplay.pdfViewer');
    }
    return saveUri;
}

function parsePages(input: string, pageCount: number): number[] {
    // 1-based page numbers
    const out: number[] = [];
    const parts = input.split(',').map(s => s.trim()).filter(Boolean);
    for (const part of parts) {
        const m = /^(\d+)\s*-\s*(\d+)$/.exec(part);
        if (m) {
            let a = Math.max(1, parseInt(m[1], 10));
            let b = Math.min(pageCount, parseInt(m[2], 10));
            if (a > b) [a, b] = [b, a];
            for (let i = a; i <= b; i++) out.push(i);
        } else if (/^\d+$/.test(part)) {
            const n = parseInt(part, 10);
            if (n >= 1 && n <= pageCount) out.push(n);
        }
    }
    return [...new Set(out)].sort((a, b) => a - b);
}

async function askPages(pageCount: number, prompt: string, defaultValue = 'all'): Promise<number[] | undefined> {
    const value = await vscode.window.showInputBox({
        prompt: prompt + ` (${pageCount} pages). Examples: all, 1-3, 2,5,7`,
        value: defaultValue,
        validateInput: v => {
            if (!v || v.trim().toLowerCase() === 'all') return undefined;
            if (parsePages(v, pageCount).length === 0) return 'No valid pages';
            return undefined;
        }
    });
    if (value === undefined) return undefined;
    if (!value.trim() || value.trim().toLowerCase() === 'all') {
        return Array.from({ length: pageCount }, (_, i) => i + 1);
    }
    return parsePages(value, pageCount);
}

function hexToRgb(hex: string): RGB | undefined {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return undefined;
    const n = parseInt(m[1], 16);
    return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

// ---- Watermark --------------------------------------------------------------

export async function addTextWatermark(uri: vscode.Uri): Promise<void> {
    const { doc } = await loadDoc(uri);
    const text = await vscode.window.showInputBox({ prompt: 'Watermark text', value: 'CONFIDENTIAL' });
    if (!text) return;

    const opacityStr = await vscode.window.showInputBox({
        prompt: 'Opacity (0.05 – 0.5)',
        value: '0.18',
        validateInput: v => {
            const n = Number(v);
            if (!(n > 0 && n <= 1)) return 'Enter a number between 0 and 1';
            return undefined;
        }
    });
    if (opacityStr === undefined) return;
    const opacity = Math.min(0.5, Math.max(0.05, Number(opacityStr) || 0.18));

    const pages = await askPages(doc.getPageCount(), 'Apply watermark to pages');
    if (!pages || !pages.length) return;

    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    for (const p1 of pages) {
        const page = doc.getPage(p1 - 1);
        const { width, height } = page.getSize();
        const fontSize = Math.max(24, Math.min(width, height) * 0.08);
        const tw = font.widthOfTextAtSize(text, fontSize);
        page.drawText(text, {
            x: (width - tw) / 2,
            y: height / 2 - fontSize / 2,
            size: fontSize,
            font,
            color: rgb(0.45, 0.45, 0.45),
            opacity,
            rotate: degrees(45)
        });
    }
    const bytes = await doc.save();
    await saveAs(uri, bytes, '-watermark');
}

// ---- Page numbers / header-footer -------------------------------------------

export async function addPageNumbers(uri: vscode.Uri): Promise<void> {
    const { doc } = await loadDoc(uri);
    const pos = await vscode.window.showQuickPick(
        [
            { label: 'Bottom center', value: 'bc' },
            { label: 'Bottom right', value: 'br' },
            { label: 'Bottom left', value: 'bl' },
            { label: 'Top center', value: 'tc' },
            { label: 'Top right', value: 'tr' },
            { label: 'Top left', value: 'tl' }
        ],
        { placeHolder: 'Page number position' }
    );
    if (!pos) return;

    const fmt = await vscode.window.showInputBox({
        prompt: 'Format (use {n} for page, {total} for count)',
        value: '{n} / {total}'
    });
    if (fmt === undefined) return;

    const font = await doc.embedFont(StandardFonts.Helvetica);
    const total = doc.getPageCount();
    const size = 10;
    const margin = 28;

    for (let i = 0; i < total; i++) {
        const page = doc.getPage(i);
        const { width, height } = page.getSize();
        const label = fmt.replace(/\{n\}/g, String(i + 1)).replace(/\{total\}/g, String(total));
        const tw = font.widthOfTextAtSize(label, size);
        let x = margin;
        let y = margin;
        const v = (pos as any).value as string;
        if (v.endsWith('c')) x = (width - tw) / 2;
        if (v.endsWith('r')) x = width - margin - tw;
        if (v.startsWith('t')) y = height - margin - size;
        page.drawText(label, { x, y, size, font, color: rgb(0.25, 0.25, 0.25) });
    }
    const bytes = await doc.save();
    await saveAs(uri, bytes, '-pagenumbers');
}

// ---- Bates numbering --------------------------------------------------------

export async function addBatesNumbers(uri: vscode.Uri): Promise<void> {
    const { doc } = await loadDoc(uri);
    const prefix = await vscode.window.showInputBox({ prompt: 'Bates prefix', value: 'DOC' });
    if (prefix === undefined) return;
    const startStr = await vscode.window.showInputBox({
        prompt: 'Starting number',
        value: '1',
        validateInput: v => (/^\d+$/.test(v) ? undefined : 'Enter an integer')
    });
    if (startStr === undefined) return;
    const padStr = await vscode.window.showInputBox({
        prompt: 'Zero-pad width (e.g. 6 → DOC000001)',
        value: '6',
        validateInput: v => {
            const n = Number(v);
            return n >= 1 && n <= 12 ? undefined : '1–12';
        }
    });
    if (padStr === undefined) return;
    const start = parseInt(startStr, 10);
    const pad = parseInt(padStr, 10);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const total = doc.getPageCount();
    for (let i = 0; i < total; i++) {
        const page = doc.getPage(i);
        const { width } = page.getSize();
        const n = String(start + i).padStart(pad, '0');
        const label = `${prefix}${n}`;
        const size = 9;
        const tw = font.widthOfTextAtSize(label, size);
        page.drawText(label, {
            x: width - 24 - tw,
            y: 16,
            size,
            font,
            color: rgb(0.2, 0.2, 0.2)
        });
    }
    const bytes = await doc.save();
    await saveAs(uri, bytes, '-bates');
}

// ---- Background color -------------------------------------------------------

export async function setPageBackground(uri: vscode.Uri): Promise<void> {
    const { doc } = await loadDoc(uri);
    const hex = await vscode.window.showInputBox({
        prompt: 'Background color (hex)',
        value: '#FFF8E7',
        validateInput: v => (hexToRgb(v) ? undefined : 'Use #RRGGBB')
    });
    if (!hex) return;
    const color = hexToRgb(hex)!;
    const pages = await askPages(doc.getPageCount(), 'Apply background to pages');
    if (!pages || !pages.length) return;

    for (const p1 of pages) {
        const page = doc.getPage(p1 - 1);
        const { width, height } = page.getSize();
        // Draw behind existing content by using a full-page rect first in content stream
        // pdf-lib draws on top; for a true background we'd need content stream surgery.
        // We draw a light overlay only when opacity is used — for solid "paper color"
        // under white pages, draw full rect with blend is limited. Practical approach:
        // draw rect covering page at the start via page.node — simplest UX: full-page rect under.
        page.drawRectangle({
            x: 0,
            y: 0,
            width,
            height,
            color,
            opacity: 0.35,
            borderWidth: 0
        });
    }
    const bytes = await doc.save();
    await saveAs(uri, bytes, '-bg');
}

// ---- Rotate pages (permanent) -----------------------------------------------

export async function rotatePages(uri: vscode.Uri): Promise<void> {
    const { doc } = await loadDoc(uri);
    const anglePick = await vscode.window.showQuickPick(
        [
            { label: '90° clockwise', value: 90 },
            { label: '180°', value: 180 },
            { label: '90° counter-clockwise', value: 270 }
        ],
        { placeHolder: 'Rotation' }
    );
    if (!anglePick) return;
    const pages = await askPages(doc.getPageCount(), 'Rotate pages');
    if (!pages || !pages.length) return;

    for (const p1 of pages) {
        const page = doc.getPage(p1 - 1);
        const current = page.getRotation().angle;
        page.setRotation(degrees((current + (anglePick as any).value) % 360));
    }
    const bytes = await doc.save();
    await saveAs(uri, bytes, '-rotated');
}

// ---- Delete pages -----------------------------------------------------------

export async function deletePages(uri: vscode.Uri): Promise<void> {
    const { doc } = await loadDoc(uri);
    const count = doc.getPageCount();
    const pages = await askPages(count, 'Pages to DELETE', '');
    if (!pages || !pages.length) return;
    if (pages.length >= count) {
        vscode.window.showErrorMessage('Cannot delete all pages.');
        return;
    }
    const confirm = await vscode.window.showWarningMessage(
        `Delete ${pages.length} page(s) and save a new file?`,
        { modal: true },
        'Delete'
    );
    if (confirm !== 'Delete') return;

    // Remove from highest index first
    for (const p1 of [...pages].sort((a, b) => b - a)) {
        doc.removePage(p1 - 1);
    }
    const bytes = await doc.save();
    await saveAs(uri, bytes, '-deleted');
}

// ---- Insert blank page ------------------------------------------------------

export async function insertBlankPage(uri: vscode.Uri): Promise<void> {
    const { doc } = await loadDoc(uri);
    const count = doc.getPageCount();
    const atStr = await vscode.window.showInputBox({
        prompt: `Insert blank page at position (1–${count + 1})`,
        value: String(count + 1),
        validateInput: v => {
            const n = parseInt(v, 10);
            return n >= 1 && n <= count + 1 ? undefined : 'Out of range';
        }
    });
    if (atStr === undefined) return;
    const at = parseInt(atStr, 10);

    // Match size of neighboring page
    const ref = doc.getPage(Math.min(count, Math.max(1, at)) - 1);
    const { width, height } = ref.getSize();
    const blank = doc.insertPage(at - 1, [width, height]);
    blank.drawRectangle({ x: 0, y: 0, width, height, color: rgb(1, 1, 1) });

    const bytes = await doc.save();
    await saveAs(uri, bytes, '-blank');
}

// ---- Duplicate page ---------------------------------------------------------

export async function duplicatePage(uri: vscode.Uri): Promise<void> {
    const { doc } = await loadDoc(uri);
    const count = doc.getPageCount();
    const which = await vscode.window.showInputBox({
        prompt: `Page to duplicate (1–${count})`,
        value: '1',
        validateInput: v => {
            const n = parseInt(v, 10);
            return n >= 1 && n <= count ? undefined : 'Out of range';
        }
    });
    if (which === undefined) return;
    const idx = parseInt(which, 10) - 1;
    const [copied] = await doc.copyPages(doc, [idx]);
    doc.insertPage(idx + 1, copied);
    const bytes = await doc.save();
    await saveAs(uri, bytes, '-dup');
}

// ---- Metadata sanitize ------------------------------------------------------

export async function sanitizeMetadata(uri: vscode.Uri): Promise<void> {
    const { doc } = await loadDoc(uri);
    doc.setTitle('');
    doc.setAuthor('');
    doc.setSubject('');
    doc.setKeywords([]);
    doc.setProducer('PDFDisplay');
    doc.setCreator('PDFDisplay');
    // Dates: pdf-lib sets modification date on save; creation can be cleared where supported
    try {
        (doc as any).setCreationDate?.(new Date(0));
        (doc as any).setModificationDate?.(new Date());
    } catch { /* ignore */ }

    const bytes = await doc.save();
    await saveAs(uri, bytes, '-sanitized');
}

// ---- Visual redaction (black boxes) ----------------------------------------

export async function addRedactionBoxes(uri: vscode.Uri): Promise<void> {
    // Practical blackout: user supplies page + approximate regions as y-bands
    // For richer UX, annotations rail already supports rect marks that can be baked.
    const { doc } = await loadDoc(uri);
    const pageStr = await vscode.window.showInputBox({
        prompt: `Page number (1–${doc.getPageCount()})`,
        value: '1'
    });
    if (!pageStr) return;
    const p1 = parseInt(pageStr, 10);
    if (!(p1 >= 1 && p1 <= doc.getPageCount())) {
        vscode.window.showErrorMessage('Invalid page');
        return;
    }
    const bands = await vscode.window.showInputBox({
        prompt: 'Vertical bands to black out as % from top (e.g. 10-15,40-48)',
        placeHolder: '10-15,40-48'
    });
    if (!bands) return;

    const page = doc.getPage(p1 - 1);
    const { width, height } = page.getSize();
    for (const part of bands.split(',')) {
        const m = /(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)/.exec(part.trim());
        if (!m) continue;
        let a = Number(m[1]) / 100;
        let b = Number(m[2]) / 100;
        if (a > b) [a, b] = [b, a];
        const yTop = height * (1 - a);
        const yBot = height * (1 - b);
        page.drawRectangle({
            x: 24,
            y: yBot,
            width: width - 48,
            height: Math.max(4, yTop - yBot),
            color: rgb(0, 0, 0),
            borderWidth: 0
        });
    }
    const bytes = await doc.save();
    await saveAs(uri, bytes, '-redacted');
}

// ---- Unified QuickPick entry (keeps UI uncluttered) -------------------------

export type EditActionId =
    | 'watermark'
    | 'pagenumbers'
    | 'bates'
    | 'background'
    | 'rotate'
    | 'delete'
    | 'blank'
    | 'duplicate'
    | 'sanitize'
    | 'redact';

const EDIT_ACTIONS: { id: EditActionId; label: string; description: string }[] = [
    { id: 'watermark', label: '$(symbol-text) Text watermark', description: 'Diagonal overlay on selected pages' },
    { id: 'pagenumbers', label: '$(list-ordered) Page numbers', description: 'Header or footer numbering' },
    { id: 'bates', label: '$(law) Bates numbering', description: 'Sequential legal-style IDs' },
    { id: 'background', label: '$(symbol-color) Page background tint', description: 'Light color overlay' },
    { id: 'rotate', label: '$(rotate) Rotate pages', description: 'Permanent 90° / 180° / 270°' },
    { id: 'delete', label: '$(trash) Delete pages', description: 'Remove pages into a new file' },
    { id: 'blank', label: '$(file) Insert blank page', description: 'Add an empty page at a position' },
    { id: 'duplicate', label: '$(copy) Duplicate page', description: 'Copy a page after itself' },
    { id: 'redact', label: '$(eye-closed) Redact bands', description: 'Black-out vertical regions on a page' },
    { id: 'sanitize', label: '$(shield) Sanitize metadata', description: 'Clear author, title, keywords, etc.' }
];

export async function runEditAction(id: EditActionId, uri: vscode.Uri): Promise<void> {
    switch (id) {
        case 'watermark': return addTextWatermark(uri);
        case 'pagenumbers': return addPageNumbers(uri);
        case 'bates': return addBatesNumbers(uri);
        case 'background': return setPageBackground(uri);
        case 'rotate': return rotatePages(uri);
        case 'delete': return deletePages(uri);
        case 'blank': return insertBlankPage(uri);
        case 'duplicate': return duplicatePage(uri);
        case 'sanitize': return sanitizeMetadata(uri);
        case 'redact': return addRedactionBoxes(uri);
    }
}

export async function showEditMenu(uri: vscode.Uri): Promise<void> {
    const pick = await vscode.window.showQuickPick(
        EDIT_ACTIONS.map(a => ({ label: a.label, description: a.description, id: a.id })),
        { placeHolder: 'PDF Edit — choose an action (saves a new file)' }
    );
    if (!pick) return;
    try {
        await runEditAction((pick as any).id, uri);
    } catch (e: any) {
        vscode.window.showErrorMessage('PDF Edit failed: ' + (e?.message ?? String(e)));
    }
}
