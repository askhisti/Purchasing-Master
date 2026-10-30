import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest, headersFor, sqlColumnsFor } from '../refresh/lib/manifest.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Spec §6, copied as literals.
const SPEC = {
  components: ['Components', ['ME_EC', 'Manufacturer', 'MPN', 'Description', 'HW Category', 'HW Subcategory', 'Component Status', 'Lifecycle', 'Years To EOL', 'ME_MS', 'Primary ME_MS', 'EMS Part Numbers', 'Is Sourced By Us']],
  multisource: ['Multisource', ['ME_MS', 'Sourcing Health', 'Member Count', 'Usable Member Count', 'Manufacturer Count']],
  multisource_members: ['Multisource_Members', ['ME_MS', 'ME_EC', 'Member Status', 'Is Usable', 'Member Priority', 'Manufacturer', 'MPN']],
  component_usage: ['Component_Usage', ['ME_EC', 'MPN', 'Manufacturer', 'Product', 'Product ID', 'Project', 'Program', 'Customer', 'EMS', 'Qty Per Unit']],
  products: ['Products', ['Product ID', 'Product Display Name', 'Project', 'Program', 'Customer', 'Sample Phase', 'EMS', 'SOP', 'Is Hierarchy Active']],
  mecl_price: ['MECL_Price', ['Price ID', 'ME_EC', 'Resolved ME_EC', 'Is Linked', 'Price Type', 'Price Owner', 'Vendor', 'Vendor Part Number', 'Volume Stage', 'Year', 'MOQ', 'Price', 'Currency', 'Price EUR (current rate)', 'Quoted Unit', 'Quoted Manufacturer', 'Quoted MPN', 'Quote Reference', 'Quote File', 'Valid From', 'Valid Until', 'Is Valid Today', 'Is Binding', 'Created At']],
};
const WITH_DEMAND = new Set(['components', 'multisource', 'component_usage']);

// Blank out comments and string literals so structure scanning is safe.
function clean(sql) {
  return sql.replace(/--[^\n]*/g, '').replace(/'(?:[^']|'')*'/g, "''");
}

// Returns the aliases of the final (last depth-0) SELECT list and the clean text.
function finalSelect(sql) {
  const s = clean(sql);
  let depth = 0;
  let last = -1;
  let from = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && /[A-Za-z]/.test(ch) && !/[A-Za-z0-9_]/.test(s[i - 1] || ' ')) {
      const w = /^[A-Za-z_]+/.exec(s.slice(i))[0].toUpperCase();
      if (w === 'SELECT') { last = i; from = -1; }
      else if (w === 'FROM' && last >= 0 && from < 0) from = i;
      i += w.length - 1;
    }
  }
  assert.ok(last >= 0 && from > last, 'final SELECT ... FROM not found');
  const list = s.slice(last + 6, from);
  const items = [];
  let d = 0;
  let cur = '';
  for (const ch of list) {
    if (ch === '(') d++;
    if (ch === ')') d--;
    if (ch === ',' && d === 0) { items.push(cur); cur = ''; } else cur += ch;
  }
  items.push(cur);
  const aliases = items.map((it) => {
    const m = /(?:\bAS\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*$/i.exec(it.trim());
    assert.ok(m, 'cannot read alias of: ' + it);
    return m[1];
  });
  return { aliases, s };
}

const manifest = loadManifest();

test('manifest lists the six feeds in order with spec tab names', () => {
  assert.deepEqual(manifest.feeds.map((f) => f.feed), Object.keys(SPEC));
  for (const f of manifest.feeds) assert.equal(f.tab, SPEC[f.feed][0]);
});

test('headers equal spec section 6 exactly', () => {
  for (const f of manifest.feeds) {
    const expected = [...SPEC[f.feed][1]];
    if (WITH_DEMAND.has(f.feed)) for (let k = 0; k <= 10; k++) expected.push(`Demand ${2026 + k}`);
    assert.deepEqual(headersFor(f, 2026), expected, f.feed);
    assert.equal(f.demandYears !== undefined, WITH_DEMAND.has(f.feed), f.feed);
  }
});

test('headersFor components ends with Demand 2026 ... Demand 2036', () => {
  const h = headersFor(manifest.feeds[0], 2026);
  assert.deepEqual(h.slice(-11), Array.from({ length: 11 }, (_, k) => `Demand ${2026 + k}`));
});

test('sqlColumnsFor excludes ROW_KEY and matches manifest columns', () => {
  for (const f of manifest.feeds) {
    const cols = sqlColumnsFor(f);
    assert.ok(!cols.includes('ROW_KEY'));
    assert.deepEqual(cols.slice(0, f.columns.length), f.columns.map((c) => c.sql));
    assert.equal(cols.length, f.columns.length + (f.demandYears ? 11 : 0));
  }
});

for (const f of loadManifest().feeds) {
  test(`${f.feed}: SQL file shape`, () => {
    const file = path.join(root, f.sqlFile);
    assert.ok(fs.existsSync(file), 'sqlFile exists');
    const sql = fs.readFileSync(file, 'utf8');
    const { aliases, s } = finalSelect(sql);
    assert.equal(aliases[0], 'ROW_KEY');
    const expected = ['ROW_KEY', ...sqlColumnsFor(f)];
    assert.deepEqual(aliases, expected, 'aliases in manifest order');
    assert.equal(new Set(aliases).size, aliases.length, 'aliases unique');
    const demand = aliases.filter((a) => /^DEMAND_Y\d+$/.test(a));
    assert.equal(demand.length, f.demandYears ? 11 : 0);
    const placeholders = sql.match(/\{\{[^}]*\}\}/g) || [];
    assert.ok(placeholders.every((p) => p === '{{BASE_YEAR}}'), 'only {{BASE_YEAR}}');
    // top-level ORDER BY / LIMIT
    let depth = 0;
    let top = '';
    for (const ch of s) { if (ch === '(') depth++; else if (ch === ')') depth--; else if (depth === 0) top += ch; }
    assert.ok(!/\bORDER\s+BY\b/i.test(top) && !/\bLIMIT\b/i.test(top), 'no top-level ORDER BY/LIMIT');
    assert.ok(Number.isInteger(f.pageLimit) && f.pageLimit > 0);
  });
}

test('health.sql returns BASE_YEAR, PROBLEM_COUNT, PROBLEM_LIST', () => {
  const sql = fs.readFileSync(path.join(root, 'sql/health.sql'), 'utf8');
  for (const a of ['BASE_YEAR', 'PROBLEM_COUNT', 'PROBLEM_LIST']) assert.match(sql, new RegExp(`AS ${a}\\b`));
  assert.ok(!/\{\{/.test(sql));
});
