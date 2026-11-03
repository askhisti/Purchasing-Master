import { test } from 'node:test';
import assert from 'node:assert';
import { makeEnv, FAKE_OWNER, FAKE_UNREMOVABLE_EDITOR } from './helpers/gas-fakes.mjs';

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

const SHEETS = ['Read me', 'Our parts', 'Your alternatives', 'Your pricing'];

// I5/I6: every sheet, Read me included, is protected; protections are made before the file is moved.
test('protections drop all other editors and domain edit, before the file is moved', () => {
  const e = setup();
  e.context.createManufacturerFile(form());
  for (const name of SHEETS) {
    const p = e.created[0].getSheetByName(name).protections[0];
    assert.deepStrictEqual(p.getEditors().map((u) => u.getEmail()), [FAKE_OWNER], name);
    assert.strictEqual(p.canDomainEdit(), false, name);
  }
  assert.strictEqual(e.created[0].getSheetByName('Read me').protections[0].getDescription(), 'Read-only');
  assert.deepStrictEqual(plain(e.events), ['protect:Read me', 'protect:Our parts', 'protect:Your alternatives', 'protect:Your pricing', 'move']);
});

// I5: like a fresh My Drive file the protection starts with the owner only; the owner is added explicitly so the
// editor list is set, then domain edit is switched off.
test('a protection adds the file owner first, then switches off domain edit', () => {
  const e = setup();
  e.context.createManufacturerFile(form());
  for (const name of SHEETS) {
    assert.deepStrictEqual(plain(e.created[0].getSheetByName(name).protections[0].calls),
      [`addEditor:${FAKE_OWNER}`, 'setDomainEdit:false'], name);
  }
});

// Correction: Protection.addEditor takes an email string (or a Base.User), never the DriveApp User of getOwner().
test('the owner is added to a protection by email string', () => {
  const e = setup();
  e.context.createManufacturerFile(form());
  const protection = e.created[0].getSheetByName('Our parts').protections[0];
  assert.throws(() => protection.addEditor({ getEmail: () => FAKE_OWNER }), /don't match the method signature/);
  assert.strictEqual(protection.calls[0], `addEditor:${FAKE_OWNER}`);
});

test('without a Drive owner no editor is added and the others are still removed', () => {
  const e = setup();
  e.protection.owner = null;
  e.protection.editors = ['editor@example.com', 'other@example.com'];
  e.context.createManufacturerFile(form());
  for (const name of SHEETS) {
    const p = e.created[0].getSheetByName(name).protections[0];
    assert.deepStrictEqual(plain(p.calls), ['removeEditor:editor@example.com', 'removeEditor:other@example.com', 'setDomainEdit:false'], name);
    assert.deepStrictEqual(p.getEditors(), [], name);
  }
});

test('a failure while the sheets are written trashes the new file and rethrows the original error', () => {
  const e = setup();
  const real = e.context.mfrWriteRows_;
  e.context.mfrWriteRows_ = (sheet, ...rest) => {
    if (sheet.getName() === 'Your alternatives') throw new Error('write failed');
    return real(sheet, ...rest);
  };
  assert.throws(() => e.context.createManufacturerFile(form()), /^Error: write failed$/);
  assert.strictEqual(e.created.length, 1);
  assert.strictEqual(e.drive.filesById['created-1'].isTrashed(), true);
  assert.deepStrictEqual(plain(e.events).slice(-1), ['trash']);
  assert.deepStrictEqual(e.drive.root.folder('Manufacturer files').fileNames(), []);
});

test('a failure in a protection also trashes the new file', () => {
  const e = setup();
  e.protection.editors = [FAKE_OWNER];
  e.context.mfrLock_ = () => { throw new Error('protect failed'); };
  assert.throws(() => e.context.createManufacturerFile(form()), /^Error: protect failed$/);
  assert.strictEqual(e.drive.filesById['created-1'].isTrashed(), true);
});

test('a protection removes every editor but the owner; one it cannot remove is logged, not fatal', () => {
  const e = setup();
  e.protection.editors = [FAKE_OWNER, 'editor@example.com', FAKE_UNREMOVABLE_EDITOR];
  const warnings = [];
  e.context.console = { ...console, warn: (m) => warnings.push(m) };
  e.context.createManufacturerFile(form());
  for (const name of SHEETS) {
    const p = e.created[0].getSheetByName(name).protections[0];
    assert.deepStrictEqual(plain(p.calls), [`addEditor:${FAKE_OWNER}`, 'removeEditor:editor@example.com',
      `removeEditor:${FAKE_UNREMOVABLE_EDITOR}`, 'setDomainEdit:false'], name);
    assert.deepStrictEqual(p.getEditors().map((u) => u.getEmail()), [FAKE_OWNER, FAKE_UNREMOVABLE_EDITOR], name);
  }
  assert.strictEqual(warnings.length, 4);
  assert.strictEqual(warnings[1], 'mfrLock_: 1 editor(s) could not be removed from "Read-only"');
});

// I3/I4: header rows are text on every sheet; data rows are text except the volume columns of Our parts and the
// numeric input columns of Your pricing.
test('header rows are text; input columns are text except MOQ, lead time and prices', () => {
  const e = setup();
  e.context.createManufacturerFile(form());
  const f = e.created[0];
  const fmts = (name, row) => {
    const s = f.getSheetByName(name);
    return Array.from({ length: s.data()[0].length }, (_, j) => s.getFormat(row, j + 1));
  };
  for (const name of SHEETS.slice(1)) assert.ok(fmts(name, 1).every((x) => x === '@'), name + ' header row');
  assert.strictEqual(f.getSheetByName('Read me').getFormat(1, 1), '@');

  const ours = f.getSheetByName('Our parts');
  const h = ours.data()[0];
  assert.strictEqual(ours.getCell(1, h.indexOf('2026-01') + 1), '2026-01');
  const textCols = h.indexOf('Volume Type') + 1;
  assert.deepStrictEqual(fmts('Our parts', 2), h.map((_, j) => (j < textCols ? '@' : 'General')));

  assert.deepStrictEqual(fmts('Your alternatives', 2), Array(9).fill('@'));
  // ME_EC Manufacturer MPN | Quoted MPN Currency | MOQ Lead Time | Price x5 | Valid Until Comment
  const priceRow = ['@', '@', '@', '@', '@', 'General', 'General', ...Array(5).fill('General'), '@', '@'];
  assert.deepStrictEqual(fmts('Your pricing', 2), priceRow, 'part row');
  assert.deepStrictEqual(fmts('Your pricing', 4), priceRow, 'first extra row');
  assert.deepStrictEqual(fmts('Your pricing', 303), priceRow, 'last extra row');
});

test('a failed move trashes the new file and says so', () => {
  const e = setup();
  e.drive.failMove = () => { throw new Error('no access'); };
  assert.throws(() => e.context.createManufacturerFile(form()),
    /^Error: Could not save the file in the Manufacturer files folder: no access$/);
  assert.strictEqual(e.drive.filesById['created-1'].isTrashed(), true);
  assert.deepStrictEqual(e.drive.root.folder('Manufacturer files').fileNames(), []);
});

test('the Manufacturer files folder is resolved before the file is created', () => {
  const e = setup();
  e.drive.root.createFolder = () => { throw new Error('folder create failed'); };
  assert.throws(() => e.context.createManufacturerFile(form()), /folder create failed/);
  assert.strictEqual(e.created.length, 0);
});

test('read me says the refresh time is unknown when _Refresh_Log B1 is empty', () => {
  const e = setup();
  e.ss.getSheetByName('_Refresh_Log').setCell(1, 2, '');
  e.context.createManufacturerFile(form());
  const col = e.created[0].getSheetByName('Read me').data().map((r) => r[0]);
  assert.ok(col[1].endsWith('from MasterData, data refreshed: unknown'), col[1]);
  assert.ok(col.includes('From 2028 on, volumes are a yearly plan, not a build schedule.'));
});

test('base year: a number or digit string 2000..2100 from _Refresh_Log B2, else the Berlin year', () => {
  const e = setup();
  const berlinYear = Number(e.context.Utilities.formatDate(new Date(), 'Europe/Berlin', 'yyyy'));
  const log = e.ss.getSheetByName('_Refresh_Log');
  const year = (v) => { log.setCell(2, 2, v); return e.context.mfrBaseYear_(e.ss); };
  assert.strictEqual(year(2031), 2031);
  assert.strictEqual(year('2032'), 2032);
  assert.strictEqual(year(2000), 2000);
  assert.strictEqual(year(2100), 2100);
  for (const bad of ['', 1999, 2101, 2026.5, '2026.0', ' 2026', '2e3', true, 'abc']) {
    assert.strictEqual(year(bad), berlinYear, JSON.stringify(bad));
  }
});
