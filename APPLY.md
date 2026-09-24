# 0.0.22 markup drop-in

Copy these into https://github.com/AnandShah10/PDFDisplay:

1. `media/markup.js` (new)
2. `media/markup.css` (new)
3. `src/extension.ts` (patched)
4. `package.json` (version 0.0.22, undo/redo commands + keybindings)

```
npm install
npm run compile
```

F5 → open a PDF. Existing sticky-note `.annotations.json` files still load.
