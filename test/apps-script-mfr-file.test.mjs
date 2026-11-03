import { test } from 'node:test';
import assert from 'node:assert';
import { makeEnv } from './helpers/gas-fakes.mjs';

const plain = (v) => JSON.parse(JSON.stringify(v));
const SEL = [{ category: 'MLCC', subcategory: '0402' }];

function setup() {
  const e = makeEnv();
  const years = [];
  for (let y = 2026; y <= 2036; y++) years.push('Volume ' + y);
  const months = [];
  for (const y of [2025, 2026, 2027]) for (let m = 1; m <= 12; m++) months.push(y + '-' + String(m).padStart(2, '0'));
  e.ss.seed('Components', [
    ['ME_EC', 'Manufacturer', 'MPN', 'Description', 'HW Category', 'HW Subcategory', 'ME_MS'],
    ['C1', 'Murata', 'M1', 'cap 0402', 'MLCC', '0402', 'MS1'],
    ['C2', 'TDK', 'M2', 'cap 0603', 'MLCC', '0603', 'MS1'],
    ['C3', 'Yageo', 'M3', 'res', 'Resistors', 'Thick film', 'MS3'],
  ]);
  e.ss.seed('BOM_Sources', [
    ['Product', 'Product ID', 'EMS', 'BOM ME_EC', 'ME_MS', 'Source Position', 'Source ME_EC', 'Volume Type'].concat(years),
    ['P1', 123, 'E1', 'C1', 'MS1', 1, 'C1', 'Demand'].concat(years.map((_, i) => 100 + i)),
    ['P1', 123, 'E1', 'C1', 'MS1', 2, 'C2', 'Potential volume if sourced'].concat(years.map((_, i) => 200 + i)),
  ]);
  e.ss.seed('BOM_Demand_Monthly', [
    ['ME_EC', 'Product ID', 'EMS', 'Flow', 'Qty Per Unit'].concat(months),
    ['C1', 123, 'E1', 'series', 1].concat(months.map((m) => (m === '2026-03' ? 10 : 0))),
  ]);
  e.ss.seed('_Refresh_Log', [['Last successful refresh', '2026-11-02T05:30:00.000Z'], ['Base year', 2026]]);
  return e;
}
const form = (o = {}) => ({ manufacturer: 'Murata', selection: SEL, onlyUsed: true, ...o });
const today = (e) => e.context.Utilities.formatDate(new Date(), 'Europe/Berlin', 'yyyy-MM-dd');

test('onOpen adds the MasterData menu', () => {
  const e = setup();
  e.context.onOpen();
  assert.deepStrictEqual(plain(e.menus), [{ title: 'MasterData', items: [['Create manufacturer file…', 'showManufacturerFileDialog']] }]);
  e.context.showManufacturerFileDialog();
  assert.strictEqual(e.dialogs[0].title, 'Create manufacturer file');
  assert.strictEqual(e.dialogs[0].html.name, 'MfrDialog');
  assert.strictEqual(e.dialogs[0].html.width, 560);
  assert.strictEqual(e.dialogs[0].html.height, 680);
});

test('creates the file in Manufacturer files with four sheets', () => {
  const e = setup();
  const r = e.context.createManufacturerFile(form());
  assert.strictEqual(r.name, `Murata - component overview - ${today(e)}`);
  const f = e.created[0];
  assert.deepStrictEqual(f.names(), ['Read me', 'Our parts', 'Your alternatives', 'Your pricing']);
  assert.strictEqual(r.rowCount, 2);
  assert.strictEqual(f.getSheetByName('Our parts').data().length, 3);
  const folder = e.drive.root.folder('Manufacturer files');
  assert.deepStrictEqual(folder.fileNames(), [r.name]);
  assert.strictEqual(f.getSheetByName('Our parts').frozenRows, 1);
  assert.strictEqual(f.getSheetByName('Our parts').protections[0].getDescription(), 'Read-only');
  e.context.createManufacturerFile(form({ manufacturer: 'TDK' }));
  assert.strictEqual(e.drive.root.liveFolders().filter((x) => x.name === 'Manufacturer files').length, 1);
  assert.strictEqual(folder.fileNames().length, 2);
  const alt = f.getSheetByName('Your alternatives');
  assert.deepStrictEqual(plain(alt.data()[0]), ['ME_EC', 'Manufacturer', 'MPN', 'Description', 'Your Alternative MPN',
    'Drop-in Replacement (Yes/No)', 'Differences', 'Datasheet Link', 'Comment']);
  assert.deepStrictEqual(plain(alt.validations.map((v) => [v.a1, v.rule.values])), [['F2:F3', ['Yes', 'No']]]);
  const pr = f.getSheetByName('Your pricing').data()[0];
  assert.deepStrictEqual(plain(pr), ['ME_EC', 'Manufacturer', 'MPN', 'Quoted MPN', 'Currency', 'MOQ', 'Lead Time (weeks)',
    'Price 2026', 'Price 2027', 'Price 2028', 'Price 2029', 'Price 2030', 'Valid Until', 'Comment']);
});

test('input columns are the only unprotected ranges', () => {
  const e = setup();
  e.context.createManufacturerFile(form());
  const f = e.created[0];
  const a1 = (name) => f.getSheetByName(name).protections[0].getUnprotectedRanges().map((x) => x.getA1Notation());
  assert.deepStrictEqual(a1('Your alternatives'), ['E2:I3']);
  assert.deepStrictEqual(a1('Your pricing'), ['D2:N3', 'A4:N303']);
  assert.deepStrictEqual(a1('Our parts'), []);
});

test('read me carries the build-month warning', () => {
  const e = setup();
  e.context.createManufacturerFile(form());
  const col = e.created[0].getSheetByName('Read me').data().map((r) => r[0]);
  assert.ok(col.some((v) => String(v).startsWith("Months are the finished product's planned build/shipment month")));
  assert.strictEqual(col[0], 'Component overview for Murata');
  assert.ok(col[1].includes('data refreshed 2026-11-02 06:30'));
  assert.strictEqual(col[2], 'Categories: MLCC / 0402');
});

test('rejects an empty manufacturer, an empty selection and a selection with no parts', () => {
  const e = setup();
  assert.throws(() => e.context.createManufacturerFile(form({ manufacturer: '  ' })), /^Error: Enter the manufacturer name\.$/);
  assert.throws(() => e.context.createManufacturerFile(form({ selection: [] })), /^Error: Select at least one category\.$/);
  assert.throws(() => e.context.createManufacturerFile(form({ selection: [{ category: 'Resistors', subcategory: 'Thick film' }] })),
    /^Error: No parts match the selection\.$/);
  assert.strictEqual(e.created.length, 0);
});

test('rejects a selection over the cell limit', () => {
  const e = setup();
  e.context.MASTERDATA_CONFIG.MFR_MAX_CELLS = 10;
  assert.throws(() => e.context.createManufacturerFile(form()), /^Error: The selection is too large; select fewer categories\.$/);
  assert.strictEqual(e.created.length, 0);
});

test('xlsxUrl points at the export of the new file', () => {
  const e = setup();
  const r = e.context.createManufacturerFile(form());
  assert.strictEqual(r.xlsxUrl, 'https://docs.google.com/spreadsheets/d/created-1/export?format=xlsx');
  assert.strictEqual(r.url, 'https://docs.google.com/spreadsheets/d/created-1/edit');
});

test('options return tree, base year and refresh time', () => {
  const e = setup();
  const o = plain(e.context.getManufacturerFileOptions(true));
  assert.strictEqual(o.baseYear, 2026);
  assert.strictEqual(o.refreshedAt, '2026-11-02 06:30');
  assert.strictEqual(o.tree[0].category, 'MLCC');
});
