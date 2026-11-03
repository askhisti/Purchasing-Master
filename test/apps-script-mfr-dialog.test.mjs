// MfrDialog.html: the dialog script run in Node vm against a minimal DOM and a fake google.script.run that keeps
// each server call pending until the test resolves it.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

// Setting textContent replaces the children, as in the DOM.
function node(tag) {
  let text = '';
  return {
    tag, children: [], disabled: false, checked: false, indeterminate: false, value: '',
    get textContent() { return text; },
    set textContent(t) { text = t; this.children = []; },
    appendChild(c) { this.children.push(c); return c; },
  };
}

function loadDialog() {
  const html = fs.readFileSync(path.join(process.cwd(), 'apps-script', 'MasterData', 'MfrDialog.html'), 'utf8');
  const script = /<script>([\s\S]*)<\/script>/.exec(html)[1];
  const ids = {};
  for (const id of ['manufacturer', 'onlyUsed', 'meta', 'tree', 'create', 'status']) ids[id] = node(id);
  ids.onlyUsed.checked = true;
  ids.create.disabled = true;
  const calls = []; // {fn, arg, ok, fail}
  const run = () => {
    const c = {};
    const r = {
      withSuccessHandler(f) { c.ok = f; return r; },
      withFailureHandler(f) { c.fail = f; return r; },
      getManufacturerFileOptions(arg) { calls.push({ fn: 'options', arg, ...c }); },
      createManufacturerFile(arg) { calls.push({ fn: 'create', arg, ...c }); },
    };
    return r;
  };
  const context = {
    document: {
      getElementById: (id) => ids[id],
      createElement: (tag) => node(tag),
      createTextNode: (text) => ({ text }),
    },
    google: { script: { get run() { return run(); } } },
  };
  vm.createContext(context);
  vm.runInContext(script, context);
  // Sub-category checkboxes of the rendered tree, by label text.
  const boxes = () => {
    const out = {};
    for (const label of ids.tree.children) {
      if (label.className === 'sub') out[label.children[1].text.trim()] = label.children[0];
    }
    return out;
  };
  return { ids, calls, boxes };
}

const tree = (subs) => [{ category: 'MLCC', count: subs.length, subcategories: subs.map((s) => ({ subcategory: s, count: 1 })) }];

test('dialog: while a create runs, Create and the toggle stay disabled, even when a tree load finishes', () => {
  const d = loadDialog();
  assert.strictEqual(d.calls[0].fn, 'options');
  assert.strictEqual(d.ids.create.disabled, true, 'disabled until the tree is loaded');
  d.calls[0].ok({ tree: tree(['0402']), baseYear: 2026, refreshedAt: '' });
  assert.strictEqual(d.ids.create.disabled, false);

  // A tree load still pending when Create is clicked.
  d.ids.onlyUsed.onchange();
  d.calls[1].ok({ tree: tree(['0402']), baseYear: 2026, refreshedAt: '' });
  d.ids.onlyUsed.onchange();
  d.ids.create.onclick();
  assert.strictEqual(d.calls[3].fn, 'create');
  assert.strictEqual(d.ids.create.disabled, true);
  assert.strictEqual(d.ids.onlyUsed.disabled, true);
  d.calls[2].ok({ tree: tree(['0402']), baseYear: 2026, refreshedAt: '' });
  assert.strictEqual(d.ids.create.disabled, true, 'the tree load cannot re-enable Create');
  d.ids.create.onclick();
  assert.strictEqual(d.calls.length, 4, 'no second create while busy');

  d.calls[3].fail(new Error('boom'));
  assert.strictEqual(d.ids.create.disabled, false);
  assert.strictEqual(d.ids.onlyUsed.disabled, false);
  assert.strictEqual(d.ids.status.children[0].textContent, 'boom');
});

test('dialog: a tree reload prunes ticked subcategories that are gone', () => {
  const d = loadDialog();
  d.calls[0].ok({ tree: tree(['0402', '0603']), baseYear: 2026, refreshedAt: '' });
  for (const b of Object.values(d.boxes())) { b.checked = true; b.onchange(); }
  d.ids.onlyUsed.onchange();
  d.calls[1].ok({ tree: tree(['0603']), baseYear: 2026, refreshedAt: '' });
  d.ids.create.onclick();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(d.calls[2].arg.selection)), [{ category: 'MLCC', subcategory: '0603' }]);
  // Back to the full tree: 0402 is no longer ticked.
  d.calls[2].ok({ name: 'x', rowCount: 1, url: 'https://docs.google.com/x', xlsxUrl: 'https://docs.google.com/y' });
  d.ids.onlyUsed.onchange();
  d.calls[3].ok({ tree: tree(['0402', '0603']), baseYear: 2026, refreshedAt: '' });
  assert.deepStrictEqual(Object.fromEntries(Object.entries(d.boxes()).map(([k, b]) => [k, b.checked])), { '0402': false, '0603': true });
});
