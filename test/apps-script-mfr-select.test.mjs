import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const dir = path.join(process.cwd(), 'apps-script', 'MasterData');

function load() {
  const context = { console };
  vm.createContext(context);
  for (const f of ['Config.ts', 'MfrSelect.ts']) {
    const p = path.join(dir, f);
    vm.runInContext(fs.readFileSync(p, 'utf8'), context, { filename: p });
  }
  return context;
}
const plain = (v) => JSON.parse(JSON.stringify(v));

function fixture(c) {
  const years = [];
  for (let y = 2026; y <= 2036; y++) years.push('Volume ' + y);
  const months = [];
  for (const y of [2025, 2026, 2027]) for (let m = 1; m <= 12; m++) months.push(y + '-' + String(m).padStart(2, '0'));
  const components = c.mfrTable_([
    ['ME_EC', 'Manufacturer', 'MPN', 'Description', 'HW Category', 'HW Subcategory', 'ME_MS'],
    ['C1', 'Murata', 'M1', 'cap 0402', 'MLCC', '0402', 'MS1'],
    ['C2', 'TDK', 'M2', 'cap 0603', 'MLCC', '0603', 'MS1'],
    ['C3', 'Yageo', 'M3', 'res', 'Resistors', 'Thick film', 'MS3'],
  ]);
  const bomSources = c.mfrTable_([
    ['Product', 'Product ID', 'EMS', 'BOM ME_EC', 'ME_MS', 'Source Position', 'Source ME_EC', 'Volume Type'].concat(years),
    ['P1', 123, 'E1', 'C1', 'MS1', 1, 'C1', 'Demand'].concat(years.map((_, i) => 100 + i)),
    ['P1', '123', 'E1', 'C1', 'MS1', 2, 'C2', 'Potential volume if sourced'].concat(years.map((_, i) => 200 + i)),
  ]);
  const bomMonthly = c.mfrTable_([
    ['ME_EC', 'Product ID', 'EMS', 'Flow', 'Qty Per Unit'].concat(months),
    ['C1', 123, 'E1', 'series', 1].concat(months.map((m) => (m === '2026-03' ? 10 : 0))),
    ['C1', '123', 'E1', 'sample', 1].concat(months.map((m) => (m === '2026-03' ? 5 : 0))),
  ]);
  return { components, bomSources, bomMonthly };
}

test('category tree counts distinct parts per node', () => {
  const c = load(); const f = fixture(c);
  const used = plain(c.mfrCategoryTree_(f.components, f.bomSources, true));
  assert.deepStrictEqual(used, [{ category: 'MLCC', count: 2, subcategories: [
    { subcategory: '0402', count: 1 }, { subcategory: '0603', count: 1 }] }]);
  const all = plain(c.mfrCategoryTree_(f.components, f.bomSources, false));
  assert.strictEqual(all.length, 2);
  assert.strictEqual(all[1].category, 'Resistors');
  assert.strictEqual(all[1].count, 1);
});

test('line is included when only an alternative is selected', () => {
  const c = load(); const f = fixture(c);
  const r = c.mfrBuildRows_(f, [{ category: 'MLCC', subcategory: '0603' }], true, 2026);
  const h = r.headers;
  assert.strictEqual(r.rows.length, 2);
  assert.deepStrictEqual(plain(r.rows.map((x) => x[h.indexOf('Source Position')])), [1, 2]);
  assert.deepStrictEqual(plain(r.rows.map((x) => x[h.indexOf('Volume Type')])), ['Demand', 'Potential volume if sourced']);
  assert.deepStrictEqual(plain(r.parts.map((p) => p.meEc)), ['C1', 'C2']);
});

test('monthly cells sum series and sample', () => {
  const c = load(); const f = fixture(c);
  const r = c.mfrBuildRows_(f, [{ category: 'MLCC', subcategory: '0402' }], true, 2026);
  const i = r.headers.indexOf('2026-03');
  assert.strictEqual(r.rows[0][i], 15);
  assert.strictEqual(r.rows[1][i], 15);
});

test('missing months are zero', () => {
  const c = load(); const f = fixture(c);
  const r = c.mfrBuildRows_(f, [{ category: 'MLCC', subcategory: '0402' }], true, 2026);
  assert.strictEqual(r.rows[0][r.headers.indexOf('2027-12')], 0);
});

test('headers for base year 2026', () => {
  const c = load(); const f = fixture(c);
  const r = c.mfrBuildRows_(f, [{ category: 'MLCC', subcategory: '0402' }], true, 2026);
  assert.strictEqual(r.headers.length, 47);
  assert.strictEqual(r.headers[r.headers.length - 1], '2027-12');
  assert.strictEqual(r.headers[12], 'Volume 2026');
});

test('unused parts appear only when onlyUsed is off', () => {
  const c = load(); const f = fixture(c);
  const sel = [{ category: 'Resistors', subcategory: 'Thick film' }];
  assert.strictEqual(c.mfrBuildRows_(f, sel, true, 2026).rows.length, 0);
  const r = c.mfrBuildRows_(f, sel, false, 2026);
  assert.strictEqual(r.rows.length, 1);
  assert.strictEqual(r.rows[0][r.headers.indexOf('Volume Type')], 'Not on a BOM');
  assert.strictEqual(r.rows[0][r.headers.indexOf('ME_MS')], 'MS3');
  assert.strictEqual(r.rows[0][r.headers.indexOf('Volume 2026')], '');
});

test('missing column is reported', () => {
  const c = load();
  const t = c.mfrTable_([['Product', 'Product ID']]);
  assert.throws(() => t.col('Source Position'), /missing column Source Position/);
});
