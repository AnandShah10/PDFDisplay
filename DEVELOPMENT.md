# Development Guide

This document contains instructions for setting up the development environment for the PDFDisplay extension.

## Prerequisites

- [Node.js](https://nodejs.org/) (v16.x or newer recommended)
- [Visual Studio Code](https://code.visualstudio.com/)
- Git

## Getting Started

1. Clone the repository:
   ```bash
   git clone https://github.com/AnandShah10/PDFDisplay.git
   cd PDFDisplay
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Open the project in VS Code:
   ```bash
   code .
   ```

## Running the Extension

1. Press `F5` in VS Code to open a new Extension Development Host window.
2. In the new window, open any PDF file to test the viewer.
3. To view debug logs, open the Developer Tools in the Extension Development Host window (`Help` > `Toggle Developer Tools`).

## Building the Extension

To compile the TypeScript code:
```bash
npm run compile
```

To continuously watch for changes and recompile:
```bash
npm run watch
```

## Packaging

To package the extension into a `.vsix` file for distribution:
```bash
npx vsce package
```
