## [0.0.24]
- API key stored in VS Code **Secret Storage** (Command Palette → Set / Clear AI API Key); no longer visible in Settings.
- Azure OpenAI: new `pdfDisplay.ai.azureApiVersion` setting (default `2024-06-01`).
- Define works without an API key via Free Dictionary API + Wiktionary fallback (better word cleaning for PDF text).

## [0.0.23]
- Optional AI assist: **Translate selection** and **Define** (hover + selection toolbar).
- Works without an API key via MyMemory + Free Dictionary API; configure OpenAI / Azure / Ollama / Gemini / Anthropic / Grok under `pdfDisplay.ai.*` for better quality and longer text.

# Changelog

All notable changes to the "PDFDisplay" extension will be documented in this file.

## [0.0.22]
- Full page markup: highlight, underline, strikeout, ink, pencil, eraser, sticky notes, text comments, rectangle, circle, arrow, and signature stamp.
- Color picker, opacity, stroke width, and undo/redo (`Ctrl/Cmd+Z`) on the floating markup rail.
- Annotated PDF export now bakes every markup kind (not just sticky notes). Existing `.annotations.json` sticky notes still load.

## [0.0.21]
- Updated README.md with complete feature list, expanded shortcuts table (now covering Git, Diff, PDF toolkit, view modes, Tools bar, image export, etc.), and improved documentation.
- Version bump and minor packaging updates (package.json now at 0.0.21).

## [0.0.20]
- **Major PDF toolkit expansion**:
  - Extract selected pages (by range or "all") to a new PDF.
  - Compress PDF using pdf-lib optimizations.
  - Split PDF into multiple files by page ranges.
  - Merge multiple PDFs into one document.
  - "Merge Annotations" command bakes sticky notes directly into the original PDF (in-place overwrite with confirmation).
  - Export any range of pages as high-quality PNG images (with folder/stem selection).
- Added multiple **view modes**: Continuous scrolling, Single Page, and Two-Page spread layout.
- Added collapsible secondary **Tools bar** to organize the growing set of controls without cluttering the main toolbar.
- **Full Git integration panel**: shows repo status, commit message box (commits both PDF + `.annotations.json` sidecar), and commit history with one-click "Compare" buttons.
- **Full PDF Diff viewer**: compare against any previous Git commit or another PDF file on disk. Supports overlay mode (with red/blue pixel-difference heatmap + change %) and side-by-side mode, with its own page navigation.
- Annotations are now also written to a git-trackable `.annotations.json` sidecar file (when the PDF lives inside an open workspace). Sidecar takes precedence on load so annotations from version control are respected.
- Enhanced annotated-PDF export: sticky notes now render as visible yellow pins + wrapped text callouts (using pdf-lib).
- View state persistence now includes selected view mode and high-contrast setting.
- Expanded Command Palette + keybinding coverage for all new features (extract, compress, split, merge, view modes, tools bar, git, diff, export-images, etc.).
- Numerous stability, rendering, and UX improvements (lazy thumbnail rendering, better restore-after-zoom/rotation, improved search, etc.).

## [0.0.19]
- Version bump and minor packaging updates.

## [0.0.18]
- Pdf Viewer Bug fix.

## [0.0.17]
- Updated marketplace description in package.json to better reflect the full feature set (annotations with export, Git integration, PDF diffing, etc.).
- Added Command Palette entries for Git panel and PDF version comparison (implementation forthcoming in webview/handlers).

## [0.0.16]
- Added full annotation export support:
  - "Export Annotated PDF" command bakes sticky notes (as visible pins + text callouts) into a new PDF using pdf-lib.
  - "Export Annotations as JSON" for portable backup, versioning, or external use.
- Improved embedded image extraction, TOC rendering, cross-document (GoToR) link support, and view state persistence.

## [0.0.15]
- Added High Contrast Mode toggle.
- Added Table of Contents (TOC) sidebar.
- Added Reading Progress indicator.
- Added Copy Page Image feature.
- Added Command Palette support for "Rotate View" and "Toggle Properties".

## [0.0.14]
- Added view rotation.
- Added support for external links within PDFs.
- Added document metadata/properties panel.

## [0.0.13]
- Enhanced view state restoration: reopening a PDF now resumes on the exact page you left off.

## [0.0.12]
- Added bookmarks feature.
- Added persistent saving of zoom values.

## [0.0.11]
- Added command palette integration for core viewer actions.
- Added text copying support.
- Fixed search highlight bug.

## [0.0.10]
- Minor stability improvements.

## [0.0.9]
- Added sticky note annotations functionality.

## [0.0.8]
- Added in-document text search functionality.

## [0.0.7]
- Added page thumbnail sidebar for quick navigation.

## [0.0.6]
- Added page navigation (next/previous) and zoom controls (in/out/fit width).

## [0.0.5]
- Initial functional updates.

## [0.0.1]
- First commit and initial release.
