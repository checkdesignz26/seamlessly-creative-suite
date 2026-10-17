/**
 * Drift guard: the shared collage engine REUSES Pattern Pages' collage maths and templates.
 * This test runs Pattern Pages' own inline collage scripts (straight out of
 * public/studios/pages/index.html) and checks the shared engine produces the same results,
 * so the two can't silently diverge.
 *
 *   node tests/collage/parity-pattern-pages.test.js
 */
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const root = path.join(__dirname, '..', '..', 'public');
const html = fs.readFileSync(path.join(root, 'studios/pages/index.html'), 'utf8');

function scriptById(id) {
  const m = new RegExp('<script id="' + id + '">([\\s\\S]*?)</script>').exec(html);
  assert(m, 'could not find Pattern Pages script #' + id);
  return m[1];
}

// Run a Pattern Pages script against a tiny stub DOM (it only registers helpers on `window`).
const win = {};
const doc = { readyState: 'complete', getElementById: () => null, querySelectorAll: () => [], addEventListener() {}, createElement: () => ({ style: {}, appendChild() {} }) };
const sandbox = { window: win, document: doc, setTimeout() {}, console, Math, Array, JSON, Object };
vm.createContext(sandbox);
['ppages-collage-template-picker-js', 'ppages-collage-reposition-js'].forEach(id => vm.runInContext(scriptById(id), sandbox));

require(path.join(root, 'shared/collage-engine.js'));
const SC = globalThis.ScCollage;
assert(SC && SC.GRID_TEMPLATES, 'shared engine did not load');

let n = 0;
const ok = (name) => { n++; console.log('  ok   ' + name); };

// 1. the template library is identical (ids, grids, spans, weights)
assert.deepStrictEqual(JSON.parse(JSON.stringify(SC.GRID_TEMPLATES)), JSON.parse(JSON.stringify(win.PP_COLLAGE_TEMPLATES)));
ok('all ' + Object.keys(SC.GRID_TEMPLATES).length + ' grid templates are identical to Pattern Pages');

// 2. same picker order
const order = /var TEMPLATE_ORDER=(\[[^\]]*\])/.exec(scriptById('ppages-collage-template-picker-js'));
assert.deepStrictEqual(SC.GRID_ORDER, JSON.parse(order[1].replace(/'/g, '"')));
ok('template picker order is identical');

// 3. same cell rectangles for every template, in Pattern Pages' own page-% area and gutter
Object.keys(win.PP_COLLAGE_TEMPLATES).forEach(id => {
  const t = win.PP_COLLAGE_TEMPLATES[id];
  const pp = win.ppCollageCellRects(t, 0);
  const sh = SC.gridLayout(t, { x: 6, y: 6, w: 88, h: 84 }, 3, null).rects;
  assert.strictEqual(pp.length, sh.length, id);
  pp.forEach((r, i) => ['x', 'y', 'w', 'h'].forEach(k => assert(Math.abs(r[k] - sh[i][k]) < 1e-9, id + ' cell ' + i + ' ' + k)));
});
ok('cell rectangles match Pattern Pages for every template');

// 4. same zoom/pan limit
[1, 1.2, 1.5, 2, 3].forEach(z => assert(Math.abs(win.ppCollageMaxOffset(z) - SC.maxOffset(z)) < 1e-9, 'maxOffset ' + z));
ok('pan limit (ppCollageMaxOffset) matches');

console.log('\n' + n + ' passed');
