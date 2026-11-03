import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { NEW_FEED_TABS } from './helpers/gas-fakes.mjs';

const dir = path.join(process.cwd(), 'apps-script', 'MasterData');

function load() {
  const context = { console };
  vm.createContext(context);
  for (const f of ['Config.ts', 'Core.ts']) {
    const p = path.join(dir, f);
    vm.runInContext(fs.readFileSync(p, 'utf8'), context, { filename: p });
  }
  return context;
}

// Values created inside the vm realm have foreign prototypes; compare plain copies.
const plain = (v) => JSON.parse(JSON.stringify(v));

test('checkRowDrop_: a drop of more than 20% names the feed', () => {
  const c = load();
  const msg = c.checkRowDrop_({ mecl_price: 1000 }, { mecl_price: 799 }, 0.2);
  assert.strictEqual(typeof msg, 'string');
  assert.match(msg, /mecl_price/);
});

test('checkRowDrop_: exactly 20% is allowed', () => {
  const c = load();
  assert.strictEqual(c.checkRowDrop_({ mecl_price: 1000 }, { mecl_price: 800 }, 0.2), null);
});

test('checkRowDrop_: no previous run never fails', () => {
  const c = load();
  assert.strictEqual(c.checkRowDrop_(null, { mecl_price: 0 }, 0.2), null);
});

test('checkRowDrop_: new feeds and growth pass; only offending feeds are named', () => {
  const c = load();
  assert.strictEqual(c.checkRowDrop_({ a: 10 }, { a: 50, b: 1 }, 0.2), null);
  const msg = c.checkRowDrop_({ a: 10, b: 100 }, { a: 10, b: 0 }, 0.2);
  assert.match(msg, /\bb\b/);
  assert.doesNotMatch(msg, /\ba\b/);
});

test('toCsv_ quotes per RFC 4180, booleans TRUE/FALSE, null empty', () => {
  const c = load();
  assert.strictEqual(
    c.toCsv_(['A', 'B'], [['x,y', 'he said "hi"'], [null, true]]),
    'A,B\n"x,y","he said ""hi"""\n,TRUE\n',
  );
});

test('toCsv_ quotes values containing line breaks', () => {
  const c = load();
  assert.strictEqual(c.toCsv_(null, [['a\nb', false, 1.5]]), '"a\nb",FALSE,1.5\n');
  assert.strictEqual(c.toCsv_(null, [['a\rb']]), '"a\rb"\n');
});

test('toCsv_ without headers and without rows', () => {
  const c = load();
  assert.strictEqual(c.toCsv_(null, []), '');
  assert.strictEqual(c.toCsv_(['A'], []), 'A\n');
  assert.strictEqual(c.toCsv_(null, [['0402', 0, undefined]]), '0402,0,\n');
});

test('columnFormats_ maps manifest types to number formats (R22: numbers General)', () => {
  const c = load();
  assert.deepStrictEqual(plain(c.columnFormats_(['string', 'date', 'number', 'boolean'])), ['@', 'yyyy-mm-dd', 'General', 'General']);
});

test('isExpiredSnapshotFolder_ keeps 30 days, ignores non-date names', () => {
  const c = load();
  assert.strictEqual(c.isExpiredSnapshotFolder_('2026-09-29', '2026-10-30', 30), true);
  assert.strictEqual(c.isExpiredSnapshotFolder_('2026-09-30', '2026-10-30', 30), false);
  assert.strictEqual(c.isExpiredSnapshotFolder_('notes', '2026-10-30', 30), false);
  assert.strictEqual(c.isExpiredSnapshotFolder_('2026-13-45', '2026-10-30', 30), false);
  assert.strictEqual(c.isExpiredSnapshotFolder_('2026-10-30', '2026-10-30', 30), false);
});

test('logRows_ produces one row per feed in the _Refresh_Log column order', () => {
  const c = load();
  const run = { runId: '2026-10-30T07-00-00', started: 'S', finished: 'F', sourceRefreshedAt: 'SC_EMS_PART=x; COMPONENT_WHERE_USED=y' };
  assert.deepStrictEqual(plain(c.logRows_(run, [{ feed: 'components', rows: 3 }, { feed: 'products', rows: 0 }], 'OK', '')), [
    ['2026-10-30T07-00-00', 'S', 'F', 'components', 3, 'SC_EMS_PART=x; COMPONENT_WHERE_USED=y', 'OK', ''],
    ['2026-10-30T07-00-00', 'S', 'F', 'products', 0, 'SC_EMS_PART=x; COMPONENT_WHERE_USED=y', 'OK', ''],
  ]);
});

test('logRows_ with no feeds still records the run', () => {
  const c = load();
  const run = { runId: 'r', started: '', finished: 'F', sourceRefreshedAt: '' };
  assert.deepStrictEqual(plain(c.logRows_(run, [], 'FAILED', 'boom')), [['r', '', 'F', '', '', '', 'FAILED', 'boom']]);
});

test('sourceRefreshedAt_ formats the two REFRESHED_AT health values', () => {
  const c = load();
  assert.strictEqual(
    c.sourceRefreshedAt_({ BASE_YEAR: 2026, REFRESHED_AT_SC_EMS_PART: '2026-10-30 05:00', REFRESHED_AT_COMPONENT_WHERE_USED: null }),
    'SC_EMS_PART=2026-10-30 05:00; COMPONENT_WHERE_USED=',
  );
  assert.strictEqual(c.sourceRefreshedAt_(null), '');
});

test('snapshotDate_ and part file names follow R21', () => {
  const c = load();
  assert.strictEqual(c.snapshotDate_('2026-10-30T07-00-03'), '2026-10-30');
  assert.strictEqual(c.partFileName_('mecl_price', 7), 'mecl_price.part0007.csv');
  assert.strictEqual(c.partSeq_('mecl_price.part0012.csv', 'mecl_price'), 12);
  assert.strictEqual(c.partSeq_('mecl_price.csv', 'mecl_price'), null);
  assert.strictEqual(c.partSeq_('components.part0001.csv', 'mecl_price'), null);
  assert.strictEqual(c.partSeq_('components.part0001.csv', null), 1);
});

const TABS = ['Components', 'Multisource', 'Multisource_Members', 'Component_Usage', 'Products', 'MECL_Price', ...NEW_FEED_TABS];

test('validateBegin_ accepts a well-formed begin and rejects bad ones', () => {
  const c = load();
  const feeds = TABS.map((tab) => ({ feed: tab.toLowerCase(), tab, headers: ['ID', 'SOP'], types: ['number', 'date'], rowCount: 5 }));
  const ok = { runId: '2026-10-30T07-00-03', baseYear: 2026, feeds };
  assert.strictEqual(c.validateBegin_(ok), null);
  const bad = (patch) => c.validateBegin_({ ...ok, ...patch });
  const badFeed = (patch) => c.validateBegin_({ ...ok, feeds: [{ ...feeds[0], ...patch }, ...feeds.slice(1)] });
  assert.ok(bad({ runId: 'yesterday' }));
  assert.ok(bad({ runId: '2026-02-30T07-00-03' }));
  assert.ok(bad({ baseYear: '2026' }));
  assert.ok(badFeed({ feed: '../x' }));
  assert.ok(badFeed({ types: ['number'] }));
  assert.ok(badFeed({ types: ['number', 'text'] }));
  assert.ok(badFeed({ rowCount: -1 }));
  assert.ok(badFeed({ feed: feeds[1].feed }), 'duplicate feed name');
  // Every tab in TABS exactly once.
  const everyTab = 'begin must list every tab';
  assert.strictEqual(bad({ feeds: [] }), everyTab);
  assert.strictEqual(bad({ feeds: feeds.slice(1) }), everyTab);
  assert.strictEqual(bad({ feeds: [...feeds, { ...feeds[0], feed: 'extra' }] }), everyTab);
  assert.strictEqual(badFeed({ tab: '_Refresh_Log' }), everyTab);
  assert.strictEqual(badFeed({ tab: 'Products' }), everyTab, 'duplicate tab');
});

test('validateRows_ checks shape and cell types', () => {
  const c = load();
  assert.strictEqual(c.validateRows_([['a', 1, true, null]], 4), null);
  assert.ok(c.validateRows_('nope', 1));
  assert.ok(c.validateRows_([['a']], 2));
  assert.ok(c.validateRows_([[{}]], 1));
  assert.ok(c.validateRows_([[NaN]], 1));
});
