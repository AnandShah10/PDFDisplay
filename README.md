<div align="center">

# 📄 PDF Display for VS Code

**A fast PDF viewer and editor for Visual Studio Code — annotations, page extract/split/merge/compress, Git-friendly sidecars, optional AI reading assist, and more.**

[![Visual Studio Marketplace](https://img.shields.io/badge/VS%20Code-Marketplace-0098FF?logo=visualstudiocode&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=AnandShah.pdfdisplay)
[![Stars](https://img.shields.io/github/stars/AnandShah10/PDFDisplay?style=social)](https://github.com/AnandShah10/PDFDisplay/stargazers)
[![GitHub issues](https://img.shields.io/github/issues/AnandShah10/PDFDisplay)](https://github.com/AnandShah10/PDFDisplay/issues)
[![License](https://img.shields.io/github/license/AnandShah10/PDFDisplay)](LICENSE)


*Made with ❤️ by Anand Shah for the development community.*

</div>

---

Tired of switching between your code editor and a separate PDF reader? **PDF Display** brings a complete, high-performance PDF viewing and editing experience directly into VS Code.

Powered by `pdf.js` + `pdf-lib`, it includes professional tools, annotation support with Git-friendly sidecars, built-in PDF manipulation, version comparison, and more.

## ✨ Key Features

### Core Viewer
- **🚀 Built-in High-Performance Viewer**: Open PDFs instantly in a dedicated webview panel with smooth rendering.
- **🧭 Navigation & Zoom**: Page navigation, jump to page, zoom (in/out/fit), rotation, and multiple **view modes** (Continuous, Single Page, Two-Page spread).
- **🗂️ Thumbnails, TOC & Bookmarks**: Visual thumbnail sidebar, interactive Table of Contents, and persistent bookmarks.
- **🔍 Smart Search**: Full-text search with accurate highlighting.
- **📊 Reading Progress**: Visual progress bar showing how far you've read.
- **🌗 High Contrast Mode**: One-click inversion for dark mode / accessibility.
- **📋 Image Tools**: Copy current page as image *or* extract/copy embedded images from any page.
- **ℹ️ Document Properties**: View metadata (author, dates, size, etc.).
- **🧠 Smart State Restoration**: Reopens exactly where you left off (page, zoom, view mode, contrast).

### Annotations & Export
- **Markup tools**: Highlight, underline, strikeout, ink, pencil, eraser, sticky notes, typed comments, rectangle / circle / arrow, and a signature stamp. Color, opacity, and undo/redo live on a floating rail. Marks persist in VS Code global state *and* a git-trackable `.annotations.json` sidecar.
- **📤 Export Options**:
  - Bake annotations into a new PDF (visible pins + wrapped text callouts via pdf-lib).
  - Export annotations as JSON.
  - **Merge Annotations In-Place** (overwrites original PDF with baked notes).
  - Batch export pages as high-quality PNG images.

### PDF Toolkit
- **🛠️ Built-in Manipulation** (via pdf-lib):
  - Extract pages (by range or "all").
  - Compress PDF (object stream optimization).
  - Split PDF by page ranges into multiple files.
  - Merge multiple PDFs into one.
- All tools accessible via toolbar, Command Palette, or keyboard shortcuts.

### Git & Diff Integration
- **🔄 Git Panel**: View repo status for the current PDF, commit changes (automatically includes PDF + sidecar annotations), and browse commit history with one-click "Compare".
- **📊 PDF Diff / Comparison**: Compare current document vs. any Git revision *or* another PDF on disk. Supports:
  - Overlay mode with pixel-difference heatmap (red/blue changes + % changed).
  - Side-by-side mode.
  - Independent navigation for both documents.

### Productivity
- **⌨️ Full Command Palette + Keybindings**: 30+ commands with sensible `Ctrl+Alt+` (or `Cmd+Alt+`) shortcuts.
- **📤 Cross-Document Links**: Supports internal/external and GoToR links.
- **⚡ Lazy Loading & Performance**: Fast even on large documents (IntersectionObserver thumbnails, retained context).

---

## 🚀 Quick Start

1. Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=AnandShah.pdfdisplay).
2. Open any `.pdf` file — it will automatically use the PDF Display editor.
3. Use the toolbar, side panels (TOC, Git, Diff, Properties), or Command Palette (`Ctrl+Shift+P` → type "PDF Display").

**Standalone open command**: `PDF Display: View PDF`.

---

## ⌨️ Shortcuts & Commands

All features are available in the Command Palette under the `PDF Display:` prefix. Many have default keybindings (active only when a PDF viewer is focused):

| Category | Command | Default Keybinding | Description |
|----------|---------|--------------------|-------------|
| **Navigation** | Next Page | `PageDown` | Go to next page |
| | Previous Page | `PageUp` | Go to previous page |
| | Go to Page... | - | Jump to specific page number |
| | Find in Document | `Ctrl/Cmd + F` | Open search |
| **View** | Toggle Thumbnails | - | Show/hide sidebar thumbnails |
| | Toggle Table of Contents | `Ctrl+Alt+T` / `Cmd+Alt+T` | Show interactive TOC |
| | Toggle Bookmarks | - | Show/hide bookmarks panel |
| | Bookmark Current Page | - | Add bookmark |
| | Toggle High Contrast | `Ctrl+Alt+H` / `Cmd+Alt+H` | Invert colors |
| | Rotate View | `Ctrl+Alt+R` / `Cmd+Alt+R` | Rotate document 90° |
| | Toggle Properties | `Ctrl+Alt+P` / `Cmd+Alt+P` | Show metadata |
| | Toggle Tools Bar | `Ctrl+Alt+Q` / `Cmd+Alt+Q` | Show extra toolbar |
| | View Mode - Continuous | `Ctrl+Alt+L` / `Cmd+Alt+L` | Scrollable pages |
| | View Mode - Single Page | `Ctrl+Alt+N` / `Cmd+Alt+N` | One page at a time |
| | View Mode - Two Page | `Ctrl+Alt+W` / `Cmd+Alt+W` | Two-page spread |
| **Annotations & Images** | Add Sticky Note | - | Enter annotation mode |
| | Copy Current Page Image | `Ctrl+Alt+C` / `Cmd+Alt+C` | Clipboard (rendered page) |
| | Copy Images From Page | `Ctrl+Alt+I` / `Cmd+Alt+I` | Extract embedded images |
| | Download Annotated PDF | `Ctrl+Alt+D` / `Cmd+Alt+D` | Export with baked notes |
| | Export Annotations as JSON | `Ctrl+Alt+J` / `Cmd+Alt+J` | Portable JSON backup |
| | Convert Pages to Images | `Ctrl+Alt+O` / `Cmd+Alt+O` | Batch PNG export |
| **PDF Toolkit** | Extract / Export Selected Pages | `Ctrl+Alt+E` / `Cmd+Alt+E` | Save pages to new PDF |
| | Compress PDF | `Ctrl+Alt+X` / `Cmd+Alt+X` | Optimize file size |
| | Split PDF by Page Range | `Ctrl+Alt+S` / `Cmd+Alt+S` | Create multiple files |
| | Merge PDFs... | `Ctrl+Alt+U` / `Cmd+Alt+U` | Combine several PDFs |
| | Merge Annotations into PDF (Overwrite) | `Ctrl+Alt+M` / `Cmd+Alt+M` | Bake notes in-place |
| **Git & Diff** | Toggle Git Panel | `Ctrl+Alt+G` / `Cmd+Alt+G` | Status, commit, history |
| | Compare PDF Versions | `Ctrl+Alt+V` / `Cmd+Alt+V` | Open diff panel (Git or file) |

> **Tip**: Many toolbar buttons also have hover tooltips. The Git and Diff panels appear as collapsible side panels inside the viewer.

---

## ⚙️ Requirements

- Visual Studio Code 1.80.0 or higher.
- For Git features: a Git repository with the PDF file inside it (the extension uses the `git` CLI via the configured `git.path` setting).

## 🤝 Contributing

We welcome contributions! Whether it's a bug report, feature request, or a pull request, your input helps make this extension better for everyone.

Check out our [CONTRIBUTING.md](CONTRIBUTING.md) and [DEVELOPMENT.md](DEVELOPMENT.md) for details on how to set up the project locally and contribute.

## 📄 License

This project is open-source and licensed under the [MIT License](LICENSE).
