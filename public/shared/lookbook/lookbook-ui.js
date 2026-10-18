/* Lookbook editor markup (shared).
 *
 * ScLookbookUI.mount(rootEl) builds the editor chrome: the four-tool rail (Add / Arrange / Style / Export),
 * the collapsible tool panel, the canvas viewport and the page filmstrip. The ids are the ones the shared
 * editor engine (lookbook-editor.js) looks up, so mount it BEFORE loading that script.
 * This is the "workspace" flavour (own project name, uploads, project file actions); the Quick Lookbook inside
 * Mock-up Studio keeps its own inline markup.
 */
(function (global) {
  'use strict';
  var HTML = `  <div class="lookbook-editor-card">
    <!-- shared custom-colour picker for every swatch strip; lives outside any hidden section so iPad Safari will open it -->
    <input type="color" id="ilCustomColorInput" aria-hidden="true" tabindex="-1" style="position:fixed; left:0; top:0; width:1px; height:1px; opacity:0; pointer-events:none; border:none; padding:0;">
    <div class="lookbook-editor-topbar">
      <button type="button" class="secondary" id="lbHomeBtn" title="back to your projects">‹ projects</button>
      <h2 class="lb-title"><input id="lbProjectName" type="text" value="" placeholder="untitled lookbook" aria-label="project name" maxlength="80" autocomplete="off" spellcheck="false"></h2>
      <span class="lb-save-status" id="lbSaveStatus" aria-live="polite"></span>
      <div class="lookbook-topbar-controls">
        <button type="button" class="secondary" id="ilFitPageBtn" title="fit the whole page to the window">fit page</button>
        <label class="lookbook-row-label">zoom <span id="ilZoomValue">100%</span></label>
        <input type="range" id="ilZoomSlider" min="40" max="200" value="100">
        <button class="secondary" id="ilToggleThumbnailsBtn" type="button">hide pages</button>
        <button class="secondary" id="lbSaveBtn" type="button" title="save now">save</button>
      </div>
    </div>

    <div class="lookbook-editor-body">
      <div class="lookbook-tool-rail" id="ilToolRail">
        <button type="button" class="lookbook-rail-btn" id="ilRailAddBtn" data-group="add" title="Add" aria-label="Add tools">
          <span class="lookbook-rail-icon" aria-hidden="true">➕</span><span class="lookbook-rail-label">Add</span>
        </button>
        <button type="button" class="lookbook-rail-btn" id="ilRailArrangeBtn" data-group="arrange" title="Arrange" aria-label="Arrange tools">
          <span class="lookbook-rail-icon" aria-hidden="true">🔧</span><span class="lookbook-rail-label">Arrange</span>
        </button>
        <button type="button" class="lookbook-rail-btn" id="ilRailStyleBtn" data-group="style" title="Style" aria-label="Style tools">
          <span class="lookbook-rail-icon" aria-hidden="true">🎨</span><span class="lookbook-rail-label">Style</span>
        </button>
        <button type="button" class="lookbook-rail-btn" id="ilRailExportBtn" data-group="export" title="Export" aria-label="Export tools">
          <span class="lookbook-rail-icon" aria-hidden="true">📤</span><span class="lookbook-rail-label">Export</span>
        </button>
      </div>

      <div class="lookbook-tool-panel-backdrop" id="ilToolPanelBackdrop" hidden></div>

      <div class="lookbook-tool-panel" id="ilToolPanel" aria-hidden="true">
        <div class="lookbook-tool-panel-header">
          <span id="ilToolPanelTitle">Add</span>
          <button type="button" class="lookbook-tool-panel-collapse" id="ilToolPanelCollapseBtn" title="Collapse panel" aria-label="Collapse panel">‹</button>
        </div>
        <div class="lookbook-tool-panel-body">

          <section id="ilGroupAdd" class="lookbook-tool-group">
            <div class="lookbook-tool-block">
              <h4>add a pattern swatch</h4>
              <div class="lookbook-pattern-strip" id="ilPatternStrip"></div>
              <button class="secondary" id="lbUploadPatternsBtn" type="button">＋ upload patterns</button>
            </div>

            <div class="lookbook-tool-block">
              <h4>add an image or mock-up</h4>
              <div class="lookbook-pattern-strip" id="ilImageStrip"></div>
              <button class="secondary" id="lbUploadImagesBtn" type="button">＋ upload images</button>
            </div>

            <div class="lookbook-tool-block">
              <h4>decorative shapes</h4>
              <div class="il-chips" id="ilShapeKinds"></div>
              <p class="lookbook-tool-hint">shapes are free objects: drag them anywhere, over anything, then colour them in Style.</p>
            </div>

            <button class="secondary" id="ilAddPaletteBtn" type="button" title="uses the colours of your patterns and images">+ add colour palette</button>
            <button class="secondary" id="ilAddTextBtn" type="button">+ add text</button>
            <button class="secondary" id="ilOpenCollageBtn" type="button" title="build a collage from patterns, mock-ups and photos">🧩 collage builder</button>
          </section>

                    <section id="ilGroupCollage" class="lookbook-tool-group" hidden>
            <div id="ilCollageRoot"></div>
          </section>

          <section id="ilGroupArrange" class="lookbook-tool-group" hidden>
            <button class="secondary" id="ilDeleteItemBtn" type="button" disabled>delete selected</button>

            <div class="lookbook-tool-block">
              <h4>selecting &amp; snapping</h4>
              <button class="secondary il-toggle" id="ilMultiBtn" type="button" aria-pressed="false">☑ select several</button>
              <button class="secondary" id="ilSelectAllBtn" type="button">select everything on this page</button>
              <button class="secondary il-toggle" id="ilSnapBtn" type="button" aria-pressed="false">snapping to guides: off</button>
            </div>

            <div class="lookbook-tool-block" id="ilAlignBlock">
              <h4>align</h4>
              <div class="il-seg" id="ilAlignRel" role="group" aria-label="align relative to">
                <button type="button" data-rel="page" class="on">to the page</button>
                <button type="button" data-rel="selection">to the selection</button>
              </div>
              <div class="il-grid3">
                <button type="button" class="secondary" data-align="left" title="align left">⇤ left</button>
                <button type="button" class="secondary" data-align="center" title="align centre">↔ centre</button>
                <button type="button" class="secondary" data-align="right" title="align right">right ⇥</button>
                <button type="button" class="secondary" data-align="top" title="align top">⤒ top</button>
                <button type="button" class="secondary" data-align="middle" title="align middle">↕ middle</button>
                <button type="button" class="secondary" data-align="bottom" title="align bottom">⤓ bottom</button>
              </div>
              <div class="il-grid2">
                <button type="button" class="secondary" data-distribute="h" title="space evenly, left to right">space across</button>
                <button type="button" class="secondary" data-distribute="v" title="space evenly, top to bottom">space down</button>
              </div>
              <p class="lookbook-tool-hint" id="ilAlignNote"></p>
            </div>

            <div id="ilLayerControls" class="lookbook-tool-block" hidden>
              <h4>rotation &amp; resizing</h4>
              <label>pattern scale <span id="ilScaleValue">100%</span></label>
              <input type="range" id="ilScaleSlider" min="20" max="400" value="100">
              <label>rotate <span id="ilRotateValue">0°</span></label>
              <input type="range" id="ilRotateSlider" min="0" max="360" value="0">
            </div>

            <div id="ilCollageArrangeBlock" class="lookbook-tool-block" hidden>
              <h4>collage</h4>
              <button class="secondary" id="ilEditCollageBtn" type="button">🧩 open collage builder</button>
            </div>

            <p class="lookbook-tool-hint" id="ilArrangeHint">select a pattern swatch on the page to scale or rotate it.</p>
          </section>

          <section id="ilGroupStyle" class="lookbook-tool-group" hidden>
            <div class="lookbook-tool-block">
              <h4>page background</h4>
              <div class="lookbook-bg-row">
                <span class="lookbook-row-label">solid colour</span>
                <input type="color" id="ilPageBgColorInput" value="#ffffff">
              </div>
              <div class="lookbook-bg-row">
                <button type="button" class="secondary" id="ilPageBgImageBtn">upload image…</button>
                <input type="file" id="ilPageBgImageFile" accept="image/*" hidden>
              </div>
              <div class="lookbook-palette-strip il-strip" id="ilPageBgStrip"></div>
              <button type="button" class="secondary" id="ilPageBgClearBtn">clear (white)</button>
            </div>

            <div id="ilExtractedBlock" class="lookbook-tool-block" hidden>
              <h4>colours from your pictures</h4>
              <div class="lookbook-palette-strip il-strip" id="ilExtractedStrip"></div>
              <p class="lookbook-tool-hint">tap one to colour the selected text or shape, or the page background if nothing is selected.</p>
              <button type="button" class="secondary" id="ilAddExtractedPaletteBtn">add these as a palette on the page</button>
            </div>

            <div id="ilShapeControls" class="lookbook-tool-block" hidden>
              <h4>shape</h4>
              <div id="ilShapeFillRow">
                <label>fill</label>
                <div class="lookbook-palette-strip il-strip" id="ilShapeFillStrip"></div>
                <button type="button" class="secondary il-toggle" id="ilShapeNoFillBtn">no fill</button>
              </div>
              <label>outline colour</label>
              <div class="lookbook-palette-strip il-strip" id="ilShapeStrokeStrip"></div>
              <button type="button" class="secondary il-toggle" id="ilShapeNoStrokeBtn">no outline</button>
              <label>outline width <span id="ilShapeStrokeWValue">0px</span></label>
              <input type="range" id="ilShapeStrokeWSlider" min="0" max="40" step="1" value="0">
              <label>opacity <span id="ilShapeOpacityValue">100%</span></label>
              <input type="range" id="ilShapeOpacitySlider" min="5" max="100" step="1" value="100">
              <label>rotate <span id="ilShapeRotateValue">0°</span></label>
              <input type="range" id="ilShapeRotateSlider" min="0" max="359" step="1" value="0">
            </div>

            <div id="ilShadowGroup" class="lookbook-tool-block" hidden>
              <h4>drop shadow</h4>
              <label>shadow <span id="ilShadowValue">0%</span></label>
              <input type="range" id="ilShadowSlider" min="0" max="100" value="0">
            </div>

            <div id="ilTextControls" class="lookbook-tool-block" hidden>
              <h4>text style</h4>
              <div class="lookbook-font-mode-toggle">
                <button type="button" class="lookbook-font-mode-btn active" id="ilFontModePairBtn">font pairing</button>
                <button type="button" class="lookbook-font-mode-btn" id="ilFontModeSingleBtn">single font</button>
              </div>
              <div id="ilFontPairGroup" class="lookbook-font-mode-group">
                <select id="ilFontPairSelect"></select>
                <div class="lookbook-font-mode-actions">
                  <button type="button" class="secondary" id="ilApplyTitleFontBtn">title</button>
                  <button type="button" class="secondary" id="ilApplyBodyFontBtn">body</button>
                </div>
              </div>
              <div id="ilFontSingleGroup" class="lookbook-font-mode-group" hidden>
                <select id="ilFontSingleSelect"></select>
                <div class="lookbook-font-mode-actions">
                  <button type="button" class="secondary" id="ilApplySingleFontBtn">apply font</button>
                </div>
              </div>
              <label>size <span id="ilFontSizeValue">24px</span></label>
              <input type="range" id="ilFontSizeSlider" min="10" max="96" value="24">
              <label>colour</label>
              <div class="lookbook-palette-strip il-strip" id="ilPaletteStrip"></div>
              <div id="ilTextOpacityRow" hidden>
                <label>text opacity <span id="ilTextOpacityValue">100%</span></label>
                <input type="range" id="ilTextOpacitySlider" min="5" max="100" step="1" value="100">
              </div>
            </div>
          </section>

          <section id="ilGroupExport" class="lookbook-tool-group" hidden>
            <div class="lookbook-tool-block">
              <h4>this page</h4>
              <button class="secondary" id="ilExportPngBtn" type="button">export page as PNG</button>
              <button class="secondary" id="lbExportJpgBtn" type="button">export page as JPEG</button>
            </div>
            <div class="lookbook-tool-block">
              <h4>whole lookbook</h4>
              <button class="orange" id="ilExportPdfBtn" type="button">export all pages as PDF</button>
              <button class="secondary" id="lbExportZipBtn" type="button">all pages as PNG files (.zip)</button>
            </div>
            <div class="lookbook-tool-block">
              <h4>project file</h4>
              <button class="secondary" id="lbDownloadProjectBtn" type="button">save a backup (.lookbook)</button>
              <button class="secondary" id="lbOpenFileBtn" type="button">open a .lookbook file…</button>
            </div>
          </section>

        </div>
      </div>

      <div class="lookbook-canvas-area">
        <div class="lookbook-viewport" id="lookbookViewport"></div>
        <div class="lookbook-page-thumbnails" id="ilPageThumbnails"></div>
      </div>
    </div>
  </div>`;
  global.ScLookbookUI = {
    html: function () { return HTML; },
    mount: function (root) { root.innerHTML = HTML; return root; }
  };
})(window);
