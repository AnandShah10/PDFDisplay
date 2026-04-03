# PDF Display Extension

This extension allows users to open and view PDF files directly within Visual Studio Code. It utilizes the `pdf-lib` library to render PDF documents in a webview.

## Features
- Open PDF files from your file system.
- View PDF documents in a dedicated webview panel.

## Requirements
- Visual Studio Code version 1.50.0 or higher.
- Node.js and npm installed.

## Installation
1. Clone the repository or download the source code.
2. Navigate to the extension directory in your terminal.
3. Run `npm install` to install the required dependencies.
4. Run `npm run build` to compile the TypeScript files.
5. Press `F5` to launch a new VS Code window with the extension loaded.

## Usage
1. Open the command palette (`Ctrl+Shift+P` or `Cmd+Shift+P` on Mac).
2. Type `Open PDF` and select the command.
3. Choose a PDF file from your file system to view it in the webview.

## Known Issues
- Ensure that the PDF files are not corrupted, as this may cause rendering issues.

## Release Notes
### 1.0.0
Initial release of the PDF Display extension.

## License
This project is licensed under the MIT License.
