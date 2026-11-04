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
  for (let y = 2026; y <= 2036; y++) years.push('Demand ' + y);
  const months = [];
  for (const y of [2026, 2027]) for (let m = 1; m <= 12; m++) months.push(y + '-' + String(m).padStart(2, '0'));
  const components = c.mfrTable_([
    ['ME_EC', 'Manufacturer', 'MPN', 'Description', 'HW Category', 'HW Subcategory', 'ME_MS'],
    ['C1', 'Murata', 'M1', 'cap 0402', 'MLCC', '0402', 'MS1'],
    ['C2', 'TDK', 'M2', 'cap 0603', 'MLCC', '0603', 'MS1'],
    ['C3', 'Yageo', 'M3', 'res', 'Resistors', 'Thick film', 'MS3'],
    ['C4', 'Samsung', 'M4', 'cap 0402 b', 'MLCC', '0402', 'MS2'],
    ['C5', 'Vishay', 'M5', 'diode', 'Diodes', 'Zener', 'MS1'],
  ]);
  const usage = c.mfrTable_([
    ['ME_EC', 'MPN', 'Manufacturer', 'Product', 'Product ID', 'Project', 'Program', 'Customer', 'EMS', 'Qty Per Unit'].concat(years),
    ['C1', 'M1', 'Murata', 'P1', 123, 'J', 'G', 'K', 'E1', 2].concat(years.map((_, i) => (i === 0 ? 30 : 100 + i))),
  ]);
  const members = c.mfrTable_([
    ['ME_MS', 'ME_EC', 'Member Status', 'Is Usable', 'Member Priority', 'Manufacturer', 'MPN'],
    ['MS1', 'C1', 'Released', true, 1, 'Murata', 'M1'],
    ['MS1', 'C2', 'Released', 'TRUE', 2, 'TDK', 'M2'],
    ['MS1', 'C4', 'Released', true, 3, 'Samsung', 'M4'],
    ['MS1', 'C5', 'Draft', false, 4, 'Vishay', 'M5'],
    ['MS2', 'C1', 'Released', true, 1, 'Murata', 'M1'],
    ['MS2', 'C4', 'Released', true, 2, 'Samsung', 'M4'],
  ]);
  const pvHead = ['Product ID', 'Product Display Name', 'Project', 'Program', 'Customer', 'EMS', 'Flow', 'Units 2025']
    .concat(months, ['Units 2026']);
  const pv = (pid, flow, march) => [pid, 'P', 'J', 'G', 'K', 'E1', flow, 0]
    .concat(months.map((m) => (m === '2026-03' ? march : 0)), [march]);
  const productVolumes = c.mfrTable_([
    pvHead,
    pv('123', 'Series', 10),
    pv(123, 'Sample', 5),
    pv(999, 'Series', 7),
  ]);
  return { components, usage, members, productVolumes };
}

test('category tree counts distinct parts per node', () => {
  const c = load(); const f = fixture(c);
  const used = plain(c.mfrCategoryTree_(f.components, f.usage, f.members, true));
  assert.deepStrictEqual(used, [{ category: 'MLCC', count: 3, subcategories: [
    { subcategory: '0402', count: 2 }, { subcategory: '0603', count: 1 }] }]);
  const all = plain(c.mfrCategoryTree_(f.components, f.usage, f.members, false));
  assert.strictEqual(all.length, 3);
  assert.strictEqual(all[2].category, 'Resistors');
  assert.strictEqual(all[2].count, 1);
});

test('line is included when only an alternative is selected', () => {
  const c = load(); const f = fixture(c);
  const r = c.mfrBuildRows_(f, [{ category: 'MLCC', subcategory: '0603' }], true, 2026);
  const h = r.headers;
  assert.strictEqual(r.rows.length, 3);
  assert.deepStrictEqual(plain(r.rows.map((x) => x[h.indexOf('Source Position')])), [1, 2, 3]);
  assert.deepStrictEqual(plain(r.rows.map((x) => x[h.indexOf('Volume Type')])), ['Demand', 'Potential volume if sourced', 'Potential volume if sourced']);
  assert.deepStrictEqual(plain(r.parts.map((p) => p.meEc)), ['C1', 'C2', 'C4']);
});

test('monthly cells sum series and sample', () => {
  const c = load(); const f = fixture(c);
  const r = c.mfrBuildRows_(f, [{ category: 'MLCC', subcategory: '0402' }], true, 2026);
  const i = r.headers.indexOf('2026-03');
  assert.strictEqual(r.rows[0][i], 30);
  assert.strictEqual(r.rows[1][i], 30);
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

test('a part in two clusters appears once per line', () => {
  const c = load(); const f = fixture(c);
  const r = c.mfrBuildRows_(f, [{ category: 'MLCC', subcategory: '0402' }], true, 2026);
  const h = r.headers;
  const c4 = r.rows.filter((x) => x[h.indexOf('ME_EC')] === 'C4');
  assert.strictEqual(c4.length, 1);
  assert.strictEqual(c4[0][h.indexOf('ME_MS')], 'MS2');
  assert.strictEqual(c4[0][h.indexOf('Source Position')], 3);
  assert.strictEqual(r.rows[0][h.indexOf('ME_MS')], '');
});

test('monthly volume is product units times qty', () => {
  const c = load(); const f = fixture(c);
  const r = c.mfrBuildRows_(f, [{ category: 'MLCC', subcategory: '0402' }], true, 2026);
  const i = r.headers.indexOf('2026-03');
  assert.deepStrictEqual(plain(r.rows.map((x) => x[i])), [30, 30, 30]);
  assert.deepStrictEqual(plain(r.rows.map((x) => x[r.headers.indexOf('Volume 2026')])), [30, 30, 30]);
});

test('a product missing from Product_Volumes gives zero months', () => {
  const c = load(); const f = fixture(c);
  f.usage.rows[0][f.usage.col('Product ID')] = 555;
  const r = c.mfrBuildRows_(f, [{ category: 'MLCC', subcategory: '0402' }], true, 2026);
  const i = r.headers.indexOf('2026-03');
  assert.deepStrictEqual(plain(r.rows.map((x) => x[i])), [0, 0, 0]);
});

test('draft members are not alternatives', () => {
  const c = load(); const f = fixture(c);
  const r = c.mfrBuildRows_(f, [{ category: 'Diodes', subcategory: 'Zener' }], true, 2026);
  assert.strictEqual(r.rows.length, 0);
  assert.ok(!r.parts.map((p) => p.meEc).includes('C5'));
});

test('a product with only a Series row: months are Series units times qty', () => {
  const c = load(); const f = fixture(c);
  f.usage.rows.push(['C1', 'M1', 'Murata', 'P2', 999, 'J', 'G', 'K', 'E1', 3].concat(Array(11).fill(0)));
  const r = c.mfrBuildRows_(f, [{ category: 'MLCC', subcategory: '0402' }], true, 2026);
  const h = r.headers;
  const p2 = r.rows.filter((x) => x[h.indexOf('Product')] === 'P2');
  assert.strictEqual(p2.length, 3);
  assert.strictEqual(p2[0][h.indexOf('2026-03')], 21);
});

test('a missing month column throws', () => {
  const c = load(); const f = fixture(c);
  const i = f.productVolumes.headers.indexOf('2027-12');
  const rows = [f.productVolumes.headers, ...f.productVolumes.rows].map((r) => r.filter((_, k) => k !== i));
  f.productVolumes = c.mfrTable_(rows);
  assert.throws(() => c.mfrBuildRows_(f, [{ category: 'MLCC', subcategory: '0402' }], true, 2026),
    /MasterData has no column 2027-12 in Product_Volumes; run the refresh first\./);
});

test('a missing demand column throws', () => {
  const c = load(); const f = fixture(c);
  const i = f.usage.headers.indexOf('Demand 2036');
  f.usage = c.mfrTable_([f.usage.headers, ...f.usage.rows].map((r) => r.filter((_, k) => k !== i)));
  assert.throws(() => c.mfrBuildRows_(f, [{ category: 'MLCC', subcategory: '0402' }], true, 2026),
    /MasterData has no column Demand 2036 in Component_Usage; run the refresh first\./);
});

test('month and yearly cells are rounded to 2 decimals', () => {
  const c = load(); const f = fixture(c);
  f.productVolumes.rows[0][f.productVolumes.col('2026-03')] = 10.004;
  f.usage.rows[0][f.usage.col('Demand 2026')] = 12.3456;
  const r = c.mfrBuildRows_(f, [{ category: 'MLCC', subcategory: '0402' }], true, 2026);
  const h = r.headers;
  assert.strictEqual(r.rows[0][h.indexOf('2026-03')], 30.01);
  assert.strictEqual(r.rows[0][h.indexOf('Volume 2026')], 12.35);
});

test('a blank Member Priority sorts last', () => {
  const c = load(); const f = fixture(c);
  f.members.rows.find((r) => r[1] === 'C2')[4] = '';
  const r = c.mfrBuildRows_(f, [{ category: 'MLCC', subcategory: '0402' }], true, 2026);
  const h = r.headers;
  const p1 = r.rows.filter((x) => x[h.indexOf('Product')] === 'P1');
  assert.deepStrictEqual(plain(p1.map((x) => x[h.indexOf('ME_EC')])), ['C1', 'C4', 'C2']);
});

test('an alternative missing from Components takes manufacturer and MPN from its member row', () => {
  const c = load(); const f = fixture(c);
  f.components.rows = f.components.rows.filter((r) => r[0] !== 'C2');
  const r = c.mfrBuildRows_(f, [{ category: 'MLCC', subcategory: '0402' }], true, 2026);
  const h = r.headers;
  const row = r.rows.find((x) => x[h.indexOf('ME_EC')] === 'C2');
  assert.strictEqual(row[h.indexOf('Manufacturer')], 'TDK');
  assert.strictEqual(row[h.indexOf('MPN')], 'M2');
  assert.strictEqual(row[h.indexOf('Description')], '(none)');
});
