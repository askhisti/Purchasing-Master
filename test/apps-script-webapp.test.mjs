import { test } from 'node:test';
import assert from 'node:assert';
import { makeEnv, encodeRows, NEW_FEED_DEFS, NEW_FEED_TABS } from './helpers/gas-fakes.mjs';

const TOKEN = 'b'.repeat(64);
const RUN = '2026-10-30T07-00-03';
const RUN2 = '2026-10-30T09-15-00';
const TABS = ['Components', 'Multisource', 'Multisource_Members', 'Component_Usage', 'Products', 'MECL_Price', ...NEW_FEED_TABS];
const LOG_HEADERS = ['Run ID', 'Started', 'Finished', 'Feed', 'Rows', 'Source Refreshed At', 'Status', 'Message'];
const HEALTH = {
  BASE_YEAR: 2026,
  PROBLEM_COUNT: 0,
  PROBLEM_LIST: '',
  REFRESHED_AT_SC_EMS_PART: '2026-10-30 04:10:00',
  REFRESHED_AT_COMPONENT_WHERE_USED: '2026-10-30 04:20:00',
};
const SRC = 'SC_EMS_PART=2026-10-30 04:10:00; COMPONENT_WHERE_USED=2026-10-30 04:20:00';

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
// Every begin lists all fifteen tabs (in TABS order); feeds not under test are tiny and usually empty.
const DEFS = [
  COMP,
  { feed: 'multisource', tab: 'Multisource', headers: ['ME_MS', 'Member Count'], types: ['string', 'number'] },
  { feed: 'multisource_members', tab: 'Multisource_Members', headers: ['ME_MS', 'ME_EC'], types: ['string', 'string'] },
  { feed: 'component_usage', tab: 'Component_Usage', headers: ['ME_EC', 'Product ID'], types: ['string', 'number'] },
  PROD,
  { feed: 'mecl_price', tab: 'MECL_Price', headers: ['Price ID', 'ME_EC'], types: ['number', 'string'] },
  ...NEW_FEED_DEFS,
];
const FEED_NAMES = DEFS.map((d) => d.feed);

function feedsFor(counts) {
  return DEFS.map((d) => ({ ...d, rowCount: counts[d.feed] ?? 0 }));
}
function feedResult(counts) {
  return FEED_NAMES.map((feed) => ({ feed, rows: counts[feed] ?? 0 }));
}

function env(props = {}) {
  const e = makeEnv({ props: { REFRESH_TOKEN: TOKEN, ...props } });
  const call = (body) => e.post({ token: TOKEN, ...body });
  return { ...e, call };
}

function begin(e, runId, counts, baseYear = 2026) {
  return e.call({ action: 'begin', runId, baseYear, feeds: feedsFor(counts), health: HEALTH });
}
function chunk(e, runId, feed, seq, rows) {
  return e.call({ action: 'chunk', runId, feed, seq, rowsB64Gzip: encodeRows(rows) });
}
function commit(e, runId) {
  return e.call({ action: 'commit', runId });
}
function snapshots(e) {
  return e.drive.root.folder('Raw snapshots');
}
function logData(e) {
  return e.ss.getSheetByName('_Refresh_Log').data();
}
function logRow(e, feed) {
  return logData(e).slice(4).find((r) => r[3] === feed);
}
function runProducts(e, runId, rows) {
  assert.deepStrictEqual(begin(e, runId, { products: rows.length }), { ok: true });
  assert.strictEqual(chunk(e, runId, 'products', 1, rows).ok, true);
}
const ALL_CSV = FEED_NAMES.map((f) => `${f}.csv`).sort();
const BERLIN_FMT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
// Independent of the Utilities.formatDate fake: sv-SE formats as 'yyyy-MM-dd HH:mm:ss'.
const berlin = (iso) => new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
}).format(new Date(iso));

test('begin -> 2 chunks -> commit puts the sent rows live, snapshots CSV, logs OK', () => {
  const e = env();
  // Pre-existing state: an old live tab, an unrelated sheet, an expired and a fresh snapshot folder.
  e.ss.seed('Notes', [['keep me']]);
  const liveComp = e.ss.seed('Components', [COMP.headers, ['OLD', 'old', 1, true, 1]]);
  const liveCompId = liveComp.getSheetId();
  const raw = e.drive.root.createFolder('Raw snapshots');
  raw.createFolder('2026-09-01').createFile('components.csv', 'old', 'text/csv');
  raw.createFolder('2026-10-01');
  raw.createFolder('notes');

  assert.deepStrictEqual(begin(e, RUN, { components: 3, products: 1 }), { ok: true });
  for (const tab of TABS) assert.ok(e.ss.getSheetByName(`__staging_${tab}`).isSheetHidden(), `staging ${tab} hidden`);
  const stagingProd = e.ss.getSheetByName('__staging_Products');
  const stagingProdId = stagingProd.getSheetId();
  assert.deepStrictEqual(chunk(e, RUN, 'components', 1, COMP_CHUNK1), { ok: true, stagedRows: 2 });
  assert.deepStrictEqual(chunk(e, RUN, 'components', 2, COMP_CHUNK2), { ok: true, stagedRows: 3 });
  assert.deepStrictEqual(chunk(e, RUN, 'products', 1, PROD_ROWS), { ok: true, stagedRows: 1 });
  // Live tab untouched until commit.
  assert.strictEqual(e.ss.getSheetByName('Components').data()[1][0], 'OLD');

  assert.deepStrictEqual(commit(e, RUN), { ok: true, feeds: feedResult({ components: 3, products: 1 }) });

  // R23: an existing live tab keeps its identity; a missing one is the renamed staging tab.
  assert.strictEqual(e.ss.getSheetByName('Components'), liveComp);
  assert.strictEqual(liveComp.getSheetId(), liveCompId);
  assert.strictEqual(e.ss.getSheetByName('Products'), stagingProd);
  assert.strictEqual(stagingProd.getSheetId(), stagingProdId);

  // Live tabs hold header + sent rows, with the staged formats.
  assert.deepStrictEqual(liveComp.data(), [COMP.headers, ['ME_EC_0000001', '0402', 3.5, true, 1000], ['ME_EC_0000002', '1E3', '', false, 0], ...COMP_CHUNK2]);
  assert.deepStrictEqual([liveComp.getFormat(1, 3), liveComp.getFormat(2, 2), liveComp.getFormat(4, 3)], ['@', '@', 'General']);
  assert.strictEqual(liveComp.isSheetHidden(), false);
  assert.deepStrictEqual(e.ss.getSheetByName('Products').data(), [PROD.headers, ...PROD_ROWS]);
  assert.strictEqual(e.ss.getSheetByName('Products').isSheetHidden(), false);
  assert.deepStrictEqual(e.ss.getSheetByName('MECL_Price').data(), [DEFS[5].headers]);

  // Tab order: managed tabs in TABS order, then the log, then everything else; no staging left.
  assert.deepStrictEqual(e.ss.names(), [...TABS, '_Refresh_Log', 'Notes']);

  // Number formats applied to each appended range immediately before its setValues.
  const dataWrites = e.ss.calls.filter((c) => c.sheet === '__staging_Components' && c.row >= 2 && (c.op === 'setNumberFormats' || c.op === 'setValues'));
  assert.deepStrictEqual(dataWrites.map((c) => [c.op, c.row, c.numRows]), [
    ['setNumberFormats', 2, 2], ['setValues', 2, 2],
    ['setNumberFormats', 4, 1], ['setValues', 4, 1],
  ]);
  for (const c of dataWrites.filter((c) => c.op === 'setNumberFormats')) {
    for (const r of c.formats) assert.deepStrictEqual(r, ['@', '@', 'General', 'General', 'General']);
  }
  const prodFmt = e.ss.calls.find((c) => c.sheet === '__staging_Products' && c.row === 2 && c.op === 'setNumberFormats');
  assert.deepStrictEqual(prodFmt.formats, [['General', '@', 'yyyy-mm-dd']]);
  // Header row is written as text, formats first.
  const hdr = e.ss.calls.filter((c) => c.sheet === '__staging_Components' && c.row === 1).map((c) => c.op);
  assert.deepStrictEqual(hdr, ['setNumberFormats', 'setValues']);

  // Snapshot CSVs: header + chunks in seq order; parts and .tmp files gone.
  const day = snapshots(e).folder('2026-10-30');
  assert.deepStrictEqual(day.fileNames(), ALL_CSV);
  assert.strictEqual(
    day.file('components.csv').getBlob().getDataAsString(),
    'ME_EC,MPN,Years To EOL,Is Sourced By Us,Demand 2026\n' +
      'ME_EC_0000001,0402,3.5,TRUE,1000\nME_EC_0000002,1E3,,FALSE,0\n' +
      'ME_EC_0000003,"MAR-12, ""x""",2,TRUE,7\n',
  );
  assert.strictEqual(day.file('products.csv').getBlob().getDataAsString(), 'Product ID,Product Display Name,SOP\n42,Inverter,2027-01-15\n');
  assert.strictEqual(day.file('mecl_price.csv').getBlob().getDataAsString(), 'Price ID,ME_EC\n');

  // Retention: folders older than 30 days pruned; recent and non-date folders kept.
  assert.deepStrictEqual(snapshots(e).liveFolders().map((f) => f.name).sort(), ['2026-10-01', '2026-10-30', 'notes']);

  // Log layout and OK rows.
  const log = logData(e);
  assert.strictEqual(log[0][0], 'Last successful refresh');
  assert.match(log[0][1], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/, 'R36: B1 stays an ISO UTC time');
  assert.deepStrictEqual(log[1].slice(0, 2), ['Base year', 2026]);
  assert.deepStrictEqual(log[3], LOG_HEADERS);
  assert.strictEqual(log.length, 4 + DEFS.length);
  assert.deepStrictEqual(log.slice(4).map((r) => [r[0], r[3], r[4], r[5], r[6], r[7]]),
    FEED_NAMES.map((f) => [RUN, f, { components: 3, products: 1 }[f] ?? 0, SRC, 'OK', '']));
  assert.match(log[4][1], BERLIN_FMT);
  assert.match(log[4][2], BERLIN_FMT);
  assert.strictEqual(log[4][1] <= log[4][2], true, 'Started <= Finished');
  assert.strictEqual(log[4][2], berlin(log[0][1]), 'Finished is the commit finish time (B1) in Berlin time');

  // Properties.
  assert.strictEqual(e.stored.ACTIVE_RUN, undefined);
  assert.deepStrictEqual(JSON.parse(e.stored.LAST_ROW_COUNTS), Object.fromEntries(feedResult({ components: 3, products: 1 }).map((f) => [f.feed, f.rows])));

  // Every action took the script lock with a 30 s wait and released it.
  const waits = e.lockLog.filter((l) => l[0] === 'wait');
  assert.strictEqual(waits.length, 5);
  assert.ok(waits.every((w) => w[1] === 30000));
  assert.strictEqual(e.lockLog.filter((l) => l[0] === 'release').length, 5);
});

test('R23: leftover rows and columns of a longer previous live tab are cleared (values and formats)', () => {
  const e = env();
  const old = [
    ['Product ID', 'Product Display Name', 'SOP', 'Old col', 'Old col 2'],
    ...Array.from({ length: 5 }, (_, i) => [i, `Old ${i}`, '2020-01-01', 'x', 'y']),
  ];
  const live = e.ss.seed('Products', old);
  for (let r = 1; r <= 6; r++) for (let c = 1; c <= 5; c++) live.setFormat(r, c, 'old-fmt');
  const id = live.getSheetId();
  runProducts(e, RUN, PROD_ROWS);
  assert.strictEqual(commit(e, RUN).ok, true);

  assert.strictEqual(e.ss.getSheetByName('Products'), live);
  assert.strictEqual(live.getSheetId(), id);
  assert.deepStrictEqual(live.data(), [PROD.headers, ...PROD_ROWS]);
  assert.deepStrictEqual([live.getFormat(1, 1), live.getFormat(2, 1), live.getFormat(2, 2), live.getFormat(2, 3)], ['@', 'General', '@', 'yyyy-mm-dd']);
  for (let r = 3; r <= 6; r++) {
    for (let c = 1; c <= 5; c++) {
      assert.strictEqual(live.getCell(r, c), '', `value r${r}c${c} cleared`);
      assert.strictEqual(live.getFormat(r, c), undefined, `format r${r}c${c} cleared`);
    }
  }
  for (let r = 1; r <= 2; r++) {
    for (let c = 4; c <= 5; c++) {
      assert.strictEqual(live.getCell(r, c), '', `value r${r}c${c} cleared`);
      assert.strictEqual(live.getFormat(r, c), undefined, `format r${r}c${c} cleared`);
    }
  }
  assert.ok(!e.ss.getSheetByName('__staging_Products'), 'staging deleted after copy');
});

test('a second successful run inserts its log rows at row 5, above the earlier ones', () => {
  const e = env();
  runProducts(e, RUN, PROD_ROWS);
  assert.strictEqual(commit(e, RUN).ok, true);
  begin(e, RUN2, { products: 1 }, 2027);
  chunk(e, RUN2, 'products', 1, [[43, 'Charger', null]]);
  assert.strictEqual(commit(e, RUN2).ok, true);
  const log = logData(e);
  assert.deepStrictEqual(log.slice(4).map((r) => r[0]), [...Array(DEFS.length).fill(RUN2), ...Array(DEFS.length).fill(RUN)]);
  // Inserted rows shift the older entries' formats with them.
  const sheet = e.ss.getSheetByName('_Refresh_Log');
  assert.strictEqual(sheet.getFormat(11, 5), '0');
  assert.strictEqual(sheet.getFormat(11, 1), '@');
  assert.strictEqual(log[1][1], 2027);
  assert.deepStrictEqual(e.ss.getSheetByName('Products').data(), [PROD.headers, [43, 'Charger', '']]);
  // Same-date snapshot replaced, not duplicated.
  const day = snapshots(e).folder('2026-10-30');
  assert.deepStrictEqual(day.fileNames(), ALL_CSV);
  assert.strictEqual(day.file('products.csv').getBlob().getDataAsString(), 'Product ID,Product Display Name,SOP\n43,Charger,\n');
});

test('commit with staged 9 vs rowCount 10 fails, live tab unchanged, log FAILED', () => {
  const e = env();
  const oldLive = [PROD.headers, [1, 'Old', '2020-01-01']];
  e.ss.seed('Products', oldLive);
  begin(e, RUN, { products: 10 });
  const nine = Array.from({ length: 9 }, (_, i) => [i, `P${i}`, null]);
  assert.deepStrictEqual(chunk(e, RUN, 'products', 1, nine), { ok: true, stagedRows: 9 });
  const res = commit(e, RUN);
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /products/);
  assert.deepStrictEqual(e.ss.getSheetByName('Products').data(), oldLive);
  const row = logRow(e, 'products');
  assert.deepStrictEqual([row[4], row[6], row[7]], [9, 'FAILED', res.error]);
  assert.ok(logData(e).slice(4).every((r) => r[6] === 'FAILED'));
  assert.strictEqual(logData(e)[0][1], '', 'Last successful refresh not set by a failed run');
  // The failed run is closed: no staging, no parts, no active run, baseline untouched.
  assert.ok(!e.ss.names().some((n) => n.startsWith('__staging_')));
  assert.deepStrictEqual(snapshots(e).folder('2026-10-30').fileNames(), []);
  assert.strictEqual(e.stored.ACTIVE_RUN, undefined);
  assert.strictEqual(e.stored.LAST_ROW_COUNTS, undefined);
});

test('a commit failing after snapshot assembly keeps the previous same-date CSV and removes .tmp files', () => {
  const e = env();
  runProducts(e, RUN, PROD_ROWS);
  assert.strictEqual(commit(e, RUN).ok, true);
  const day = snapshots(e).folder('2026-10-30');
  const goodCsv = day.file('products.csv').getBlob().getDataAsString();

  runProducts(e, RUN2, [[43, 'Charger', null]]);
  e.context.swapStagingToLive_ = () => { throw new Error('boom'); };
  const res = commit(e, RUN2);
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /boom/);
  assert.strictEqual(day.file('products.csv').getBlob().getDataAsString(), goodCsv);
  assert.deepStrictEqual(day.fileNames(), ALL_CSV, 'no .tmp or part files left');
  assert.deepStrictEqual(e.ss.getSheetByName('Products').data(), [PROD.headers, ...PROD_ROWS]);
  assert.strictEqual(logData(e)[4][6], 'FAILED');
  assert.strictEqual(e.stored.ACTIVE_RUN, undefined);
});

test('doPost commit: a Drive error during snapshot assembly still discards the run and logs FAILED (no transient flag)', () => {
  const e = env();
  runProducts(e, RUN, PROD_ROWS);
  e.drive.failCreate = (folder, name) => {
    if (name === 'products.csv.tmp') throw new Error('Drive create failed');
  };
  const res = commit(e, RUN);
  assert.deepStrictEqual(res, { ok: false, error: 'Drive create failed' });
  assert.strictEqual(e.stored.ACTIVE_RUN, undefined);
  assert.deepStrictEqual(e.ss.names().filter((n) => n.startsWith('__staging_')), []);
  assert.strictEqual(logRow(e, 'products')[6], 'FAILED');
});

test('a failing FAILED-log write does not hide the original commit error', () => {
  const e = env();
  begin(e, RUN, { products: 2 });
  chunk(e, RUN, 'products', 1, PROD_ROWS);
  e.context.writeLogRows_ = () => { throw new Error('log down'); };
  const res = commit(e, RUN);
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /^products: staged 1 rows, expected 2/);
  assert.match(res.error, /log down/);
});

test('once every live tab is swapped, later failures return ok:true with a warning', () => {
  const e = env();
  runProducts(e, RUN, PROD_ROWS);
  e.context.setLastRowCounts_ = () => { throw new Error('props full'); };
  const res = commit(e, RUN);
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.feeds, feedResult({ products: 1 }));
  assert.match(res.warning, /row counts: props full/);
  assert.deepStrictEqual(e.ss.getSheetByName('Products').data(), [PROD.headers, ...PROD_ROWS]);
  assert.strictEqual(e.stored.ACTIVE_RUN, undefined);
  const row = logRow(e, 'products');
  assert.strictEqual(row[6], 'OK');
  assert.match(row[7], /props full/);
  assert.notStrictEqual(logData(e)[0][1], '', 'B1 still set');
  assert.ok(snapshots(e).folder('2026-10-30').file('products.csv'));
});

test('a commit sets the A1 note of the tabs listed in TAB_NOTES and no other', () => {
  const e = env();
  runProducts(e, RUN, PROD_ROWS);
  assert.strictEqual(commit(e, RUN).ok, true);
  const notes = e.context.MASTERDATA_CONFIG.TAB_NOTES;
  assert.deepStrictEqual(Object.keys(notes), ['Product_Volumes', 'Component_Demand_Monthly', 'BOM_Demand_Monthly', 'BOM_Sources', 'Price_At_Demand', 'Savings_Levers', 'Quote_Health', 'Multisource_Health']);
  assert.match(notes.Savings_Levers, /^One row per component, demand year and EMS\. Never add the lever columns together\./);
  assert.strictEqual(e.ss.getSheetByName('Savings_Levers').getRange(1, 1).getNote(), notes.Savings_Levers);
  for (const tab of Object.keys(notes)) assert.strictEqual(e.ss.getSheetByName(tab).getRange(1, 1).getNote(), notes[tab], tab);
  for (const tab of ['Components', 'Products', 'BOM_Coverage']) assert.strictEqual(e.ss.getSheetByName(tab).getRange(1, 1).getNote(), '', `${tab} has no note`);
});

test('applyTabNotes_ skips tabs missing from the spreadsheet', () => {
  const e = env();
  e.ss.seed('Savings_Levers', [['A']]);
  e.context.applyTabNotes_(e.ss);
  assert.strictEqual(e.ss.getSheetByName('Savings_Levers').getRange(1, 1).getNote(), e.context.MASTERDATA_CONFIG.TAB_NOTES.Savings_Levers);
  assert.deepStrictEqual(e.ss.names(), ['Savings_Levers']);
});

test('chunk with a different runId is rejected', () => {
  const e = env();
  begin(e, RUN, { products: 1 });
  assert.deepStrictEqual(chunk(e, RUN2, 'products', 1, PROD_ROWS), { ok: false, error: 'not the active run' });
  assert.deepStrictEqual(e.ss.getSheetByName('__staging_Products').data(), [PROD.headers]);
  assert.deepStrictEqual(commit(e, RUN2), { ok: false, error: 'not the active run' });
});

test('chunk and commit without any active run are rejected', () => {
  const e = env();
  assert.deepStrictEqual(chunk(e, RUN, 'products', 1, PROD_ROWS), { ok: false, error: 'not the active run' });
  assert.deepStrictEqual(commit(e, RUN), { ok: false, error: 'not the active run' });
});

test('begin for a new run removes staging tabs, parts and .tmp files left by an earlier run', () => {
  const e = env();
  e.ss.seed('Keep', [['x']]);
  e.ss.seed('__staging_Legacy', [['stale']]);
  begin(e, RUN, { components: 3, products: 1 });
  assert.ok(!e.ss.getSheetByName('__staging_Legacy'), 'any __staging_* tab is removed');
  chunk(e, RUN, 'components', 1, COMP_CHUNK1);
  chunk(e, RUN, 'products', 1, PROD_ROWS);
  const day = snapshots(e).folder('2026-10-30');
  day.createFile('products.csv.tmp', 'stale', 'text/csv');
  assert.deepStrictEqual(day.fileNames(), ['components.part0001.csv', 'products.csv.tmp', 'products.part0001.csv']);

  assert.deepStrictEqual(begin(e, RUN2, { components: 1 }), { ok: true });
  assert.deepStrictEqual(e.ss.getSheetByName('__staging_Products').data(), [PROD.headers], 'fresh staging tab');
  assert.deepStrictEqual(e.ss.getSheetByName('__staging_Components').data(), [COMP.headers], 'fresh staging tab');
  assert.deepStrictEqual(day.fileNames(), []);
  assert.strictEqual(JSON.parse(e.stored.ACTIVE_RUN).runId, RUN2);
  // The superseded run can no longer write.
  assert.deepStrictEqual(chunk(e, RUN, 'components', 2, COMP_CHUNK2), { ok: false, error: 'not the active run' });
});

test('row drop > 20% versus the last successful run fails and leaves live unchanged', () => {
  const e = env({ LAST_ROW_COUNTS: JSON.stringify({ products: 10 }) });
  const oldLive = [PROD.headers, [1, 'Old', '2020-01-01']];
  e.ss.seed('Products', oldLive);
  begin(e, RUN, { products: 7 });
  chunk(e, RUN, 'products', 1, Array.from({ length: 7 }, (_, i) => [i, `P${i}`, null]));
  const res = commit(e, RUN);
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /products/);
  assert.deepStrictEqual(e.ss.getSheetByName('Products').data(), oldLive);
  assert.strictEqual(logRow(e, 'products')[6], 'FAILED');
  assert.deepStrictEqual(JSON.parse(e.stored.LAST_ROW_COUNTS), { products: 10 });
  assert.deepStrictEqual(snapshots(e).folder('2026-10-30').fileNames(), [], 'no snapshot for a rejected run');
});

test('LAST_ROW_COUNTS keeps keys of feeds no longer sent', () => {
  const e = env({ LAST_ROW_COUNTS: JSON.stringify({ legacy: 3 }) });
  runProducts(e, RUN, PROD_ROWS);
  assert.strictEqual(commit(e, RUN).ok, true);
  const counts = JSON.parse(e.stored.LAST_ROW_COUNTS);
  assert.strictEqual(counts.legacy, 3);
  assert.strictEqual(counts.products, 1);
  assert.strictEqual(counts.mecl_price, 0);
});

test('fail logs FAILED with the reason, clears staging, parts and the active run', () => {
  const e = env();
  begin(e, RUN, { products: 2 });
  chunk(e, RUN, 'products', 1, PROD_ROWS);
  assert.deepStrictEqual(e.call({ action: 'fail', runId: RUN, reason: 'connector error: timeout' }), { ok: true });
  assert.ok(!e.ss.names().some((n) => n.startsWith('__staging_')));
  assert.deepStrictEqual(snapshots(e).folder('2026-10-30').fileNames(), []);
  assert.strictEqual(e.stored.ACTIVE_RUN, undefined);
  const row = logRow(e, 'products');
  assert.deepStrictEqual([row[0], row[4], row[6], row[7]], [RUN, 1, 'FAILED', 'connector error: timeout']);
});

test('fail before any begin still records the run and removes that date\'s part and .tmp files', () => {
  const e = env();
  const day = e.drive.root.createFolder('Raw snapshots').createFolder('2026-10-30');
  day.createFile('products.csv', 'good', 'text/csv');
  day.createFile('products.part0001.csv', 'p', 'text/csv');
  day.createFile('products.csv.tmp', 't', 'text/csv');
  assert.deepStrictEqual(e.call({ action: 'fail', runId: RUN, reason: 'ABORT health gate' }), { ok: true });
  const log = logData(e);
  assert.deepStrictEqual(log[3], LOG_HEADERS);
  assert.deepStrictEqual([log[4][0], log[4][3], log[4][6], log[4][7]], [RUN, '', 'FAILED', 'ABORT health gate']);
  assert.deepStrictEqual(day.fileNames(), ['products.csv']);
});

test('fail for a non-active run does not touch the active run', () => {
  const e = env();
  begin(e, RUN2, { products: 1 });
  chunk(e, RUN2, 'products', 1, PROD_ROWS);
  assert.deepStrictEqual(e.call({ action: 'fail', runId: RUN, reason: 'old' }), { ok: true });
  assert.strictEqual(JSON.parse(e.stored.ACTIVE_RUN).runId, RUN2);
  assert.ok(e.ss.getSheetByName('__staging_Products'));
  assert.deepStrictEqual(snapshots(e).folder('2026-10-30').fileNames(), ['products.part0001.csv']);
});

test('a repeated chunk seq is ignored; an out-of-order seq is rejected', () => {
  const e = env();
  begin(e, RUN, { components: 3 });
  assert.deepStrictEqual(chunk(e, RUN, 'components', 1, COMP_CHUNK1), { ok: true, stagedRows: 2 });
  assert.deepStrictEqual(chunk(e, RUN, 'components', 1, COMP_CHUNK1), { ok: true, stagedRows: 2, duplicate: true });
  assert.deepStrictEqual(chunk(e, RUN, 'components', 3, COMP_CHUNK2), { ok: true, stagedRows: 3 });
  assert.deepStrictEqual(chunk(e, RUN, 'components', 2, COMP_CHUNK2), { ok: false, error: 'chunk out of order' });
  assert.strictEqual(commit(e, RUN).ok, true);
  assert.strictEqual(e.ss.getSheetByName('Components').data().length, 4);
});

test('chunks larger than the default grid grow the staging sheet and the existing live tab', () => {
  const e = env();
  const live = e.ss.seed('Products', [PROD.headers, [1, 'Old', null]]);
  const rows = Array.from({ length: 1500 }, (_, i) => [i, `P${i}`, null]);
  begin(e, RUN, { products: 1500 });
  assert.deepStrictEqual(chunk(e, RUN, 'products', 1, rows), { ok: true, stagedRows: 1500 });
  assert.strictEqual(commit(e, RUN).ok, true);
  assert.strictEqual(e.ss.getSheetByName('Products'), live);
  assert.strictEqual(live.getLastRow(), 1501);
  assert.strictEqual(live.getCell(1501, 2), 'P1499');
});

test('bad requests are rejected without side effects', () => {
  const e = env();
  const everyTab = { ok: false, error: 'begin must list every tab' };
  const beginWith = (feeds) => e.call({ action: 'begin', runId: RUN, baseYear: 2026, feeds, health: HEALTH });
  const feeds = feedsFor({});
  assert.deepStrictEqual(beginWith(feeds.slice(1)), everyTab);
  assert.deepStrictEqual(beginWith([...feeds.slice(0, -1), { ...feeds.at(-1), tab: '_Refresh_Log' }]), everyTab);
  assert.deepStrictEqual(beginWith([...feeds.slice(0, -1), { ...feeds.at(-1), tab: 'Products' }]), everyTab);
  assert.strictEqual(e.stored.ACTIVE_RUN, undefined);
  assert.strictEqual(e.ss.getSheets().length, 0);
  begin(e, RUN, { products: 1 });
  assert.deepStrictEqual(chunk(e, RUN, 'nope', 1, PROD_ROWS), { ok: false, error: 'unknown feed' });
  assert.strictEqual(chunk(e, RUN, 'products', 1, [[1, 'too short']]).ok, false);
  assert.strictEqual(e.call({ action: 'chunk', runId: RUN, feed: 'products', seq: 1, rowsB64Gzip: 'not-gzip' }).ok, false);
  assert.deepStrictEqual(e.ss.getSheetByName('__staging_Products').data(), [PROD.headers]);
  assert.strictEqual(JSON.parse(e.stored.ACTIVE_RUN).feeds[4].staged, 0);
});

test('existing auth rules still apply to the new actions', () => {
  const e = env();
  assert.deepStrictEqual(e.post({ token: 'wrong', action: 'begin', runId: RUN, baseYear: 2026, feeds: feedsFor({}) }), { ok: false, error: 'unauthorized' });
  assert.strictEqual(e.ss.getSheets().length, 0);
  assert.strictEqual(e.lockLog.length, 0, 'unauthorized requests never take the lock');
});

// ---- final review fixes ----

test('begin replacing an active run with another runId logs the old run as ABANDONED', () => {
  const e = env();
  e.call({ action: 'begin', runId: RUN, startedAt: '2026-10-30T06:00:03.000Z', baseYear: 2026, feeds: feedsFor({ products: 1 }), health: HEALTH });
  chunk(e, RUN, 'products', 1, PROD_ROWS);
  assert.deepStrictEqual(begin(e, RUN2, { products: 1 }), { ok: true });
  const rows = logData(e).slice(4);
  assert.strictEqual(rows.length, 1);
  const [runId, started, finished, feed, count, src, status, message] = rows[0];
  assert.deepStrictEqual([runId, started, feed, count, src, status, message],
    [RUN, '2026-10-30 07:00:03', '', '', SRC, 'ABANDONED', `replaced by ${RUN2}`]);
  assert.match(finished, BERLIN_FMT);
  assert.strictEqual(JSON.parse(e.stored.ACTIVE_RUN).runId, RUN2);
});

test('begin repeated for the same runId (a retried begin) logs no ABANDONED row', () => {
  const e = env();
  begin(e, RUN, { products: 1 });
  assert.deepStrictEqual(begin(e, RUN, { products: 1 }), { ok: true });
  assert.deepStrictEqual(logData(e).slice(4), []);
});

test('begin sets the spreadsheet locale to en_US when it differs, and leaves en_US alone', () => {
  const e = env();
  e.ss.locale = 'de_DE';
  assert.deepStrictEqual(begin(e, RUN, {}), { ok: true });
  assert.strictEqual(e.ss.getSpreadsheetLocale(), 'en_US');
  assert.deepStrictEqual(e.ss.calls.filter((c) => c.op === 'setSpreadsheetLocale'), [{ op: 'setSpreadsheetLocale', locale: 'en_US' }]);
  const e2 = env();
  begin(e2, RUN, {});
  assert.strictEqual(e2.ss.calls.filter((c) => c.op === 'setSpreadsheetLocale').length, 0);
});

test('R36: Started comes from begin startedAt; Started/Finished are Berlin time; B1 is ISO UTC', () => {
  const e = env();
  const startedAt = '2026-10-30T06:00:03.000Z'; // 07:00:03 CET
  assert.deepStrictEqual(e.call({ action: 'begin', runId: RUN, startedAt, baseYear: 2026, feeds: feedsFor({ products: 1 }), health: HEALTH }), { ok: true });
  chunk(e, RUN, 'products', 1, PROD_ROWS);
  assert.strictEqual(commit(e, RUN).ok, true);
  const log = logData(e);
  assert.match(log[0][1], /Z$/);
  for (const r of log.slice(4)) {
    assert.strictEqual(r[1], '2026-10-30 07:00:03');
    assert.strictEqual(r[2], berlin(log[0][1]));
  }
  // Summer time: +02:00.
  assert.strictEqual(e.context.logTime_('2026-07-01T05:00:00.000Z'), '2026-07-01 07:00:00');
  assert.strictEqual(e.context.logTime_(''), '');
});

test('R36: begin rejects a startedAt that is not a timestamp', () => {
  const e = env();
  const res = e.call({ action: 'begin', runId: RUN, startedAt: 'yesterday-ish', baseYear: 2026, feeds: feedsFor({}), health: HEALTH });
  assert.deepStrictEqual(res, { ok: false, error: 'bad startedAt' });
  assert.strictEqual(e.stored.ACTIVE_RUN, undefined);
});

test('a successful commit deletes an empty default Sheet1 / Tabelle1, never one with data', () => {
  const e = env();
  e.ss.insertSheet('Sheet1');
  e.ss.seed('Tabelle1', [['notes']]);
  runProducts(e, RUN, PROD_ROWS);
  assert.strictEqual(commit(e, RUN).ok, true);
  assert.strictEqual(e.ss.getSheetByName('Sheet1'), null);
  assert.ok(e.ss.getSheetByName('Tabelle1'));

  const e2 = env();
  e2.ss.insertSheet('Tabelle1');
  runProducts(e2, RUN, PROD_ROWS);
  assert.strictEqual(commit(e2, RUN).ok, true);
  assert.strictEqual(e2.ss.getSheetByName('Tabelle1'), null);
  assert.deepStrictEqual(e2.ss.names(), [...TABS, '_Refresh_Log']);
});

test('a failed commit keeps an empty default sheet', () => {
  const e = env();
  e.ss.insertSheet('Sheet1');
  begin(e, RUN, { products: 2 });
  chunk(e, RUN, 'products', 1, PROD_ROWS);
  assert.strictEqual(commit(e, RUN).ok, false);
  assert.ok(e.ss.getSheetByName('Sheet1'));
});

// C1: each feed's headers and types live in ACTIVE_RUN_FEED_<feed>, never in ACTIVE_RUN; every path that clears
// ACTIVE_RUN (commit, rejected commit, fail, a begin that replaces another run) also deletes them.
test('feed columns are kept beside ACTIVE_RUN and cleared with it on every path', () => {
  const e = env();
  const runKeys = () => Object.keys(e.stored).filter((k) => k.startsWith('ACTIVE_RUN')).sort();
  const feedKeys = FEED_NAMES.map((f) => `ACTIVE_RUN_FEED_${f}`).sort();

  runProducts(e, RUN, PROD_ROWS);
  assert.deepStrictEqual(runKeys(), ['ACTIVE_RUN', ...feedKeys].sort());
  const run = JSON.parse(e.stored.ACTIVE_RUN);
  assert.deepStrictEqual(run.feeds[4], { feed: 'products', tab: 'Products', width: 3, rowCount: 1, staged: 1, seqs: [1] });
  assert.deepStrictEqual(JSON.parse(e.stored.ACTIVE_RUN_FEED_products), { headers: PROD.headers, types: PROD.types });
  assert.strictEqual(commit(e, RUN).ok, true);
  assert.deepStrictEqual(runKeys(), [], 'commit');

  begin(e, RUN, { products: 2 });
  assert.strictEqual(commit(e, RUN).ok, false);
  assert.deepStrictEqual(runKeys(), [], 'rejected commit');

  begin(e, RUN, {});
  assert.deepStrictEqual(e.call({ action: 'fail', runId: RUN, reason: 'x' }), { ok: true });
  assert.deepStrictEqual(runKeys(), [], 'fail of the active run');

  // A begin that threw part-way left columns without ACTIVE_RUN: a fail with no active run sweeps them.
  e.stored.ACTIVE_RUN_FEED_old_feed = '{"headers":["A"],"types":["string"]}';
  assert.deepStrictEqual(e.call({ action: 'fail', runId: RUN2, reason: 'x' }), { ok: true });
  assert.deepStrictEqual(runKeys(), [], 'fail with no active run');

  // A begin replacing another run leaves only the new run's columns.
  begin(e, RUN, {});
  e.stored.ACTIVE_RUN_FEED_old_feed = '{"headers":["A"],"types":["string"]}';
  begin(e, RUN2, {});
  assert.deepStrictEqual(runKeys(), ['ACTIVE_RUN', ...feedKeys].sort(), 'begin of another run');
  assert.strictEqual(JSON.parse(e.stored.ACTIVE_RUN).runId, RUN2);
});
