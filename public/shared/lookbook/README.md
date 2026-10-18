# Shared Lookbook modules

Used by the **Creative Lookbook** workspace (`/studios/lookbook/`). Mock-up Studio's Quick Lookbook keeps
its own inline editor and is deliberately not wired to these files (yet).

| File | Role |
|---|---|
| `lookbook-editor.js` | The editor engine. Classic script, globals prefixed `il…` (as in the original). Pages are `.lookbook-canvas` elements holding `.canvas-item` layers (pictures, text, palettes, collages). Includes (de)serialisation (`ilSerializeLookbook` / `ilRestoreLookbook`), zoom/fit, the tool panel, rasterising and exports (`ilExportPagePng/Jpeg`, `ilExportAllPdf`, `ilExportAllZip`). |
| `lookbook-ui.js` | `ScLookbookUI.mount(el)` — the editor chrome (rail, tool panel, viewport, page strip). Mount **before** loading the editor script. |
| `lookbook.css`, `lookbook-base.css` | Styling copied from Mock-up Studio (Coastal Atelier theme: use `<body class="theme-ocean-atelier">`). |
| `lookbook-tray.js` | The collapsible asset tray under the page (patterns / mock-ups / images / other). Works in both standalone and suite; host items carry `kind`. |
| `lookbook-suite.js` | Suite bridge. Does nothing unless the URL has `?project=<id>` (i.e. opened by the suite shell): opens the Lookbook belonging to that suite project, merges the project's assets (full resolution) into the host lists, adds ↻ refresh and "send this page to project" (kind `lookbook`, which Pattern Pages already receives). |
| `lookbook-store.js` | `ScLookbookStore` — IndexedDB projects (`creativeLookbookDB`). Independent of the suite library and of Mock-up Studio's databases. |

## Host seam — `window.ScLookbookHost`

All optional. The standalone app (`studios/lookbook/app.js`) is the reference host.

```js
window.ScLookbookHost = {
  getPatterns() { return [{ src, thumbSrc, name }]; },        // seamless patterns
  getImages()   { return [{ src, thumbSrc, name, ar }]; },    // mock-ups, photos, artwork (may return a Promise)
  onChange()    { /* debounced, after any edit — autosave here */ },
  projectName() { return 'My lookbook'; },                    // used for export file names
  removeAsset(kind, src) { /* shows a × on library swatches */ },
  refreshAssets() { /* optional: shows ↻ refresh in the tray */ }, assetsNote() { return ''; }, emptyNote(group) { return ''; },
  collageTabNames: { mockups: 'images' }, collageEmptyNotes: { mockups: '…' }
};
```

The suite host (`lookbook-suite.js`) wraps `getPatterns/getImages` to add the project library's assets (images get
`kind: 'mockup' | 'image' | 'other'`); the editable Lookbook is still saved by `ScLookbookStore`, tagged with `suiteProjectId`.

## Project data

`{ patterns[], images[], lookbook: { pageW, pageH, pages: [{ items[], bg }] } }`. Collages are stored as
plain editable JSON (`{type:'collage', model}`), never flattened. `.lookbook` files are this plus
`{ format: 'creative-lookbook', version: 1, name }`. Quick Lookbook `.mstudio` files can be opened too
(pages + pattern collection are imported as a new project).

## Provenance

Extracted from the Lookbook editor in `public/studios/mockup/index.html` (the `collage-builder` branch version,
which already contained the Collage Builder glue). Differences from the original: no Mock-up Studio
dependencies (selected mock-ups, autosave slots, overlay open/close), host seam instead; exports use
self-hosted pdf-lib/JSZip instead of the CDN jsPDF.
