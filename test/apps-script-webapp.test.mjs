import { test } from 'node:test';
import assert from 'node:assert';
import { makeEnv, encodeRows } from './helpers/gas-fakes.mjs';

const TOKEN = 'b'.repeat(64);
const RUN = '2026-10-30T07-00-03';
const RUN2 = '2026-10-30T09-15-00';
const TABS = ['Components', 'Multisource', 'Multisource_Members', 'Component_Usage', 'Products', 'MECL_Price'];
const LOG_HEADERS = ['Run ID', 'Started', 'Finished', 'Feed', 'Rows', 'Source Refreshed At', 'Status', 'Message'];
const HEALTH = {
  BASE_YEAR: 2026,
  PROBLEM_COUNT: 0,
  PROBLEM_LIST: '',
  REFRESHED_AT_SC_EMS_PART: '2026-10-30 04:10:00',
  REFRESHED_AT_COMPONENT_WHERE_USED: '2026-10-30 04:20:00',
};

const COMP = {
  feed: 'components',
  tab: 'Components',
  headers: ['ME_EC', 'MPN', 'Years To EOL', 'Is Sourced By Us', 'Demand 2026'],
  types: ['string', 'string', 'number', 'boolean', 'number'],
};
const COMP_CHUNK1 = [
  ['ME_EC_0000001', '0402', 3.5, true, 1000],
  ['ME_EC_0000002', '1E3', null, false, 0],
];
const COMP_CHUNK2 = [['ME_EC_0000003', 'MAR-12, "x"', 2, true, 7]];
const PROD = {
  feed: 'products',
  tab: 'Products',
  headers: ['Product ID', 'Product Display Name', 'SOP'],
  types: ['number', 'string', 'date'],
};
const PROD_ROWS = [[42, 'Inverter', '2027-01-15']];

function feedsFor(defs) {
  return defs.map(([def, rowCount]) => ({ ...def, rowCount }));
}

function env(props = {}) {
  const e = makeEnv({ props: { REFRESH_TOKEN: TOKEN, ...props } });
  const call = (body) => e.post({ token: TOKEN, ...body });
  return { ...e, call };
}

function begin(e, runId, defs, baseYear = 2026) {
  return e.call({ action: 'begin', runId, baseYear, feeds: feedsFor(defs), health: HEALTH });
}
function chunk(e, runId, feed, seq, rows) {
  return e.call({ action: 'chunk', runId, feed, seq, rowsB64Gzip: encodeRows(rows) });
}
function snapshots(e) {
  return e.drive.root.folder('Raw snapshots');
}
function logData(e) {
  return e.ss.getSheetByName('_Refresh_Log').data();
}

test('begin -> 2 chunks -> commit puts the sent rows live, snapshots CSV, logs OK', () => {
  const e = env();
  // Pre-existing state: an old live tab, an unrelated sheet, an expired and a fresh snapshot folder.
  e.ss.seed('Notes', [['keep me']]);
  e.ss.seed('Components', [['ME_EC', 'MPN', 'Years To EOL', 'Is Sourced By Us', 'Demand 2026'], ['OLD', 'old', 1, true, 1]]);
  const raw = e.drive.root.createFolder('Raw snapshots');
  raw.createFolder('2026-09-01').createFile('components.csv', 'old', 'text/csv');
  raw.createFolder('2026-10-01');
  raw.createFolder('notes');

  assert.deepStrictEqual(begin(e, RUN, [[COMP, 3], [PROD, 1]]), { ok: true });
  assert.ok(e.ss.getSheetByName('__staging_Components').isSheetHidden(), 'staging tabs are hidden');
  assert.ok(e.ss.getSheetByName('__staging_Products').isSheetHidden());
  assert.deepStrictEqual(chunk(e, RUN, 'components', 1, COMP_CHUNK1), { ok: true, stagedRows: 2 });
  assert.deepStrictEqual(chunk(e, RUN, 'components', 2, COMP_CHUNK2), { ok: true, stagedRows: 3 });
  assert.deepStrictEqual(chunk(e, RUN, 'products', 1, PROD_ROWS), { ok: true, stagedRows: 1 });
  // Live tab untouched until commit.
  assert.strictEqual(e.ss.getSheetByName('Components').data()[1][0], 'OLD');

  const res = e.call({ action: 'commit', runId: RUN });
  assert.deepStrictEqual(res, { ok: true, feeds: [{ feed: 'components', rows: 3 }, { feed: 'products', rows: 1 }] });

  // Live tabs hold header + sent rows.
  const comp = e.ss.getSheetByName('Components');
  assert.deepStrictEqual(comp.data(), [COMP.headers, ['ME_EC_0000001', '0402', 3.5, true, 1000], ['ME_EC_0000002', '1E3', '', false, 0], ...COMP_CHUNK2]);
  assert.strictEqual(comp.isSheetHidden(), false);
  assert.deepStrictEqual(e.ss.getSheetByName('Products').data(), [PROD.headers, ...PROD_ROWS]);
  assert.strictEqual(e.ss.getSheetByName('Products').isSheetHidden(), false);

  // Tab order: managed tabs in TABS order, then the log, then everything else; no staging left.
  assert.deepStrictEqual(e.ss.names(), ['Components', 'Products', '_Refresh_Log', 'Notes']);

  // Number formats applied to each appended range immediately before its setValues.
  const dataWrites = e.ss.calls.filter((c) => c.sheet === '__staging_Components' && c.row >= 2);
  assert.deepStrictEqual(dataWrites.map((c) => [c.op, c.row, c.numRows]), [
    ['setNumberFormats', 2, 2], ['setValues', 2, 2],
    ['setNumberFormats', 4, 1], ['setValues', 4, 1],
  ]);
  for (const c of dataWrites.filter((c) => c.op === 'setNumberFormats')) {
    for (const r of c.formats) assert.deepStrictEqual(r, ['@', '@', '0.######', 'General', '0.######']);
  }
  const prodFmt = e.ss.calls.find((c) => c.sheet === '__staging_Products' && c.row === 2 && c.op === 'setNumberFormats');
  assert.deepStrictEqual(prodFmt.formats, [['0.######', '@', 'yyyy-mm-dd']]);
  // Header row is written as text, formats first.
  const hdr = e.ss.calls.filter((c) => c.sheet === '__staging_Components' && c.row === 1).map((c) => c.op);
  assert.deepStrictEqual(hdr, ['setNumberFormats', 'setValues']);

  // Snapshot CSVs: header + chunks in seq order; parts removed.
  const day = snapshots(e).folder('2026-10-30');
  assert.deepStrictEqual(day.fileNames(), ['components.csv', 'products.csv']);
  assert.strictEqual(
    day.file('components.csv').getBlob().getDataAsString(),
    'ME_EC,MPN,Years To EOL,Is Sourced By Us,Demand 2026\n' +
      'ME_EC_0000001,0402,3.5,TRUE,1000\nME_EC_0000002,1E3,,FALSE,0\n' +
      'ME_EC_0000003,"MAR-12, ""x""",2,TRUE,7\n',
  );
  assert.strictEqual(day.file('products.csv').getBlob().getDataAsString(), 'Product ID,Product Display Name,SOP\n42,Inverter,2027-01-15\n');

  // Retention: folders older than 30 days pruned; recent and non-date folders kept.
  assert.deepStrictEqual(snapshots(e).liveFolders().map((f) => f.name).sort(), ['2026-10-01', '2026-10-30', 'notes']);

  // Log layout and OK rows.
  const log = logData(e);
  assert.strictEqual(log[0][0], 'Last successful refresh');
  assert.match(log[0][1], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  assert.deepStrictEqual(log[1].slice(0, 2), ['Base year', 2026]);
  assert.deepStrictEqual(log[3], LOG_HEADERS);
  assert.strictEqual(log.length, 6);
  assert.deepStrictEqual(log.slice(4).map((r) => [r[0], r[3], r[4], r[5], r[6]]), [
    [RUN, 'components', 3, 'SC_EMS_PART=2026-10-30 04:10:00; COMPONENT_WHERE_USED=2026-10-30 04:20:00', 'OK'],
    [RUN, 'products', 1, 'SC_EMS_PART=2026-10-30 04:10:00; COMPONENT_WHERE_USED=2026-10-30 04:20:00', 'OK'],
  ]);
  assert.strictEqual(log[4][1] <= log[4][2], true, 'Started <= Finished');
  assert.strictEqual(log[4][2], log[0][1], 'B1 is the commit finish time');

  // Properties.
  assert.strictEqual(e.stored.ACTIVE_RUN, undefined);
  assert.deepStrictEqual(JSON.parse(e.stored.LAST_ROW_COUNTS), { components: 3, products: 1 });

  // Every action took the script lock with a 30 s wait and released it.
  const waits = e.lockLog.filter((l) => l[0] === 'wait');
  assert.strictEqual(waits.length, 5);
  assert.ok(waits.every((w) => w[1] === 30000));
  assert.strictEqual(e.lockLog.filter((l) => l[0] === 'release').length, 5);
});

test('a second successful run inserts its log rows at row 5, above the earlier ones', () => {
  const e = env();
  begin(e, RUN, [[PROD, 1]]);
  chunk(e, RUN, 'products', 1, PROD_ROWS);
  assert.strictEqual(e.call({ action: 'commit', runId: RUN }).ok, true);
  begin(e, RUN2, [[PROD, 1]], 2027);
  chunk(e, RUN2, 'products', 1, [[43, 'Charger', null]]);
  assert.strictEqual(e.call({ action: 'commit', runId: RUN2 }).ok, true);
  const log = logData(e);
  assert.deepStrictEqual(log.slice(4).map((r) => r[0]), [RUN2, RUN]);
  assert.strictEqual(log[1][1], 2027);
  assert.deepStrictEqual(e.ss.getSheetByName('Products').data(), [PROD.headers, [43, 'Charger', '']]);
  // Same-date snapshot replaced, not duplicated.
  const day = snapshots(e).folder('2026-10-30');
  assert.deepStrictEqual(day.fileNames(), ['products.csv']);
  assert.strictEqual(day.file('products.csv').getBlob().getDataAsString(), 'Product ID,Product Display Name,SOP\n43,Charger,\n');
});

test('commit with staged 9 vs rowCount 10 fails, live tab unchanged, log FAILED', () => {
  const e = env();
  const oldLive = [PROD.headers, [1, 'Old', '2020-01-01']];
  e.ss.seed('Products', oldLive);
  begin(e, RUN, [[PROD, 10]]);
  const nine = Array.from({ length: 9 }, (_, i) => [i, `P${i}`, null]);
  assert.deepStrictEqual(chunk(e, RUN, 'products', 1, nine), { ok: true, stagedRows: 9 });
  const res = e.call({ action: 'commit', runId: RUN });
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /products/);
  assert.deepStrictEqual(e.ss.getSheetByName('Products').data(), oldLive);
  const log = logData(e);
  assert.strictEqual(log[4][6], 'FAILED');
  assert.strictEqual(log[4][3], 'products');
  assert.strictEqual(log[4][4], 9);
  assert.strictEqual(log[4][7], res.error);
  assert.strictEqual(log[0][1], '', 'Last successful refresh not set by a failed run');
  // The failed run is closed: no staging, no parts, no active run, baseline untouched.
  assert.ok(!e.ss.names().some((n) => n.startsWith('__staging_')));
  assert.deepStrictEqual(snapshots(e).folder('2026-10-30').fileNames(), []);
  assert.strictEqual(e.stored.ACTIVE_RUN, undefined);
  assert.strictEqual(e.stored.LAST_ROW_COUNTS, undefined);
});

test('chunk with a different runId is rejected', () => {
  const e = env();
  begin(e, RUN, [[PROD, 1]]);
  assert.deepStrictEqual(chunk(e, RUN2, 'products', 1, PROD_ROWS), { ok: false, error: 'not the active run' });
  assert.deepStrictEqual(e.ss.getSheetByName('__staging_Products').data(), [PROD.headers]);
  assert.deepStrictEqual(e.call({ action: 'commit', runId: RUN2 }), { ok: false, error: 'not the active run' });
});

test('chunk and commit without any active run are rejected', () => {
  const e = env();
  assert.deepStrictEqual(chunk(e, RUN, 'products', 1, PROD_ROWS), { ok: false, error: 'not the active run' });
  assert.deepStrictEqual(e.call({ action: 'commit', runId: RUN }), { ok: false, error: 'not the active run' });
});

test('begin for a new run removes staging tabs and stray parts left by an earlier run', () => {
  const e = env();
  begin(e, RUN, [[COMP, 3], [PROD, 1]]);
  chunk(e, RUN, 'components', 1, COMP_CHUNK1);
  chunk(e, RUN, 'products', 1, PROD_ROWS);
  assert.deepStrictEqual(snapshots(e).folder('2026-10-30').fileNames(), ['components.part0001.csv', 'products.part0001.csv']);

  assert.deepStrictEqual(begin(e, RUN2, [[COMP, 1]]), { ok: true });
  assert.ok(!e.ss.getSheetByName('__staging_Products'), 'old staging tab removed');
  assert.deepStrictEqual(e.ss.getSheetByName('__staging_Components').data(), [COMP.headers], 'fresh staging tab');
  assert.deepStrictEqual(snapshots(e).folder('2026-10-30').fileNames(), []);
  assert.strictEqual(JSON.parse(e.stored.ACTIVE_RUN).runId, RUN2);
  // The superseded run can no longer write.
  assert.deepStrictEqual(chunk(e, RUN, 'components', 2, COMP_CHUNK2), { ok: false, error: 'not the active run' });
});

test('row drop > 20% versus the last successful run fails and leaves live unchanged', () => {
  const e = env({ LAST_ROW_COUNTS: JSON.stringify({ products: 10, components: 3 }) });
  const oldLive = [PROD.headers, [1, 'Old', '2020-01-01']];
  e.ss.seed('Products', oldLive);
  begin(e, RUN, [[PROD, 7]]);
  chunk(e, RUN, 'products', 1, Array.from({ length: 7 }, (_, i) => [i, `P${i}`, null]));
  const res = e.call({ action: 'commit', runId: RUN });
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /products/);
  assert.deepStrictEqual(e.ss.getSheetByName('Products').data(), oldLive);
  assert.strictEqual(logData(e)[4][6], 'FAILED');
  assert.deepStrictEqual(JSON.parse(e.stored.LAST_ROW_COUNTS), { products: 10, components: 3 });
  assert.ok(!snapshots(e).folder('2026-10-30').file('products.csv'), 'no snapshot for a rejected run');
});

test('LAST_ROW_COUNTS keeps feeds that were not part of this run', () => {
  const e = env({ LAST_ROW_COUNTS: JSON.stringify({ components: 3 }) });
  begin(e, RUN, [[PROD, 1]]);
  chunk(e, RUN, 'products', 1, PROD_ROWS);
  assert.strictEqual(e.call({ action: 'commit', runId: RUN }).ok, true);
  assert.deepStrictEqual(JSON.parse(e.stored.LAST_ROW_COUNTS), { components: 3, products: 1 });
});

test('fail logs FAILED with the reason, clears staging, parts and the active run', () => {
  const e = env();
  begin(e, RUN, [[PROD, 2]]);
  chunk(e, RUN, 'products', 1, PROD_ROWS);
  assert.deepStrictEqual(e.call({ action: 'fail', runId: RUN, reason: 'connector error: timeout' }), { ok: true });
  assert.ok(!e.ss.names().some((n) => n.startsWith('__staging_')));
  assert.deepStrictEqual(snapshots(e).folder('2026-10-30').fileNames(), []);
  assert.strictEqual(e.stored.ACTIVE_RUN, undefined);
  const log = logData(e);
  assert.deepStrictEqual([log[4][0], log[4][3], log[4][4], log[4][6], log[4][7]], [RUN, 'products', 1, 'FAILED', 'connector error: timeout']);
});

test('fail before any begin still records the run', () => {
  const e = env();
  assert.deepStrictEqual(e.call({ action: 'fail', runId: RUN, reason: 'ABORT health gate' }), { ok: true });
  const log = logData(e);
  assert.deepStrictEqual(log[3], LOG_HEADERS);
  assert.deepStrictEqual([log[4][0], log[4][3], log[4][6], log[4][7]], [RUN, '', 'FAILED', 'ABORT health gate']);
});

test('fail for a non-active run does not touch the active run', () => {
  const e = env();
  begin(e, RUN2, [[PROD, 1]]);
  assert.deepStrictEqual(e.call({ action: 'fail', runId: RUN, reason: 'old' }), { ok: true });
  assert.strictEqual(JSON.parse(e.stored.ACTIVE_RUN).runId, RUN2);
  assert.ok(e.ss.getSheetByName('__staging_Products'));
});

test('a repeated chunk seq is ignored; an out-of-order seq is rejected', () => {
  const e = env();
  begin(e, RUN, [[COMP, 3]]);
  assert.deepStrictEqual(chunk(e, RUN, 'components', 1, COMP_CHUNK1), { ok: true, stagedRows: 2 });
  assert.deepStrictEqual(chunk(e, RUN, 'components', 1, COMP_CHUNK1), { ok: true, stagedRows: 2, duplicate: true });
  assert.deepStrictEqual(chunk(e, RUN, 'components', 3, COMP_CHUNK2), { ok: true, stagedRows: 3 });
  assert.deepStrictEqual(chunk(e, RUN, 'components', 2, COMP_CHUNK2), { ok: false, error: 'chunk out of order' });
  assert.strictEqual(e.call({ action: 'commit', runId: RUN }).ok, true);
  assert.strictEqual(e.ss.getSheetByName('Components').data().length, 4);
});

test('chunks larger than the default grid grow the staging sheet', () => {
  const e = env();
  const rows = Array.from({ length: 1500 }, (_, i) => [i, `P${i}`, null]);
  begin(e, RUN, [[PROD, 1500]]);
  assert.deepStrictEqual(chunk(e, RUN, 'products', 1, rows), { ok: true, stagedRows: 1500 });
  assert.strictEqual(e.call({ action: 'commit', runId: RUN }).ok, true);
  assert.strictEqual(e.ss.getSheetByName('Products').getLastRow(), 1501);
});

test('bad requests are rejected without side effects', () => {
  const e = env();
  assert.strictEqual(e.call({ action: 'begin', runId: RUN, baseYear: 2026, feeds: [{ ...PROD, tab: '_Refresh_Log', rowCount: 1 }], health: HEALTH }).ok, false);
  assert.strictEqual(e.stored.ACTIVE_RUN, undefined);
  begin(e, RUN, [[PROD, 1]]);
  assert.deepStrictEqual(chunk(e, RUN, 'nope', 1, PROD_ROWS), { ok: false, error: 'unknown feed' });
  assert.strictEqual(chunk(e, RUN, 'products', 1, [[1, 'too short']]).ok, false);
  assert.strictEqual(e.call({ action: 'chunk', runId: RUN, feed: 'products', seq: 1, rowsB64Gzip: 'not-gzip' }).ok, false);
  assert.deepStrictEqual(e.ss.getSheetByName('__staging_Products').data(), [PROD.headers]);
  assert.strictEqual(JSON.parse(e.stored.ACTIVE_RUN).feeds[0].staged, 0);
});

test('existing auth rules still apply to the new actions', () => {
  const e = env();
  assert.deepStrictEqual(e.post({ token: 'wrong', action: 'begin', runId: RUN, baseYear: 2026, feeds: feedsFor([[PROD, 1]]) }), { ok: false, error: 'unauthorized' });
  assert.strictEqual(e.ss.getSheets().length, 0);
  assert.strictEqual(e.lockLog.length, 0, 'unauthorized requests never take the lock');
});
