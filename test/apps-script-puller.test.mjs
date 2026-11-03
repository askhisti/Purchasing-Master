// Drive Inbox puller (Task A2): pollInbox() against fake Drive/Sheets, fed with the exact files Node's buildPayload produces.
import { test } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { makeEnv, INBOX_ID, NEW_FEED_DEFS, NEW_FEED_TABS } from './helpers/gas-fakes.mjs';
import { buildPayload } from '../refresh/lib/inbox.mjs';
import { loadManifest, sqlColumnsFor } from '../refresh/lib/manifest.mjs';
import { shapeFeed } from '../refresh/lib/shape.mjs';

const RUN = '2026-10-30T06-15-02';
const RUN2 = '2026-10-31T06-15-04';
const NOW = Date.parse('2026-10-31T07:00:00.000Z'); // puller clock: 08:00 Berlin on 31 Oct
const HOUR = 3600000;
const DAY = 24 * HOUR;
const TABS = ['Components', 'Multisource', 'Multisource_Members', 'Component_Usage', 'Products', 'MECL_Price', ...NEW_FEED_TABS];
// Raw connector strings, as the CLI stores them in the manifest (BASE_YEAR is a string there).
const HEALTH = {
  BASE_YEAR: '2026',
  PROBLEM_COUNT: '0',
  PROBLEM_LIST: null,
  REFRESHED_AT_SC_EMS_PART: '2026-10-30 04:10:00.000',
  REFRESHED_AT_COMPONENT_WHERE_USED: '2026-10-30 05:45:00.000',
};
const SRC = 'SC_EMS_PART=2026-10-30 04:10:00.000; COMPONENT_WHERE_USED=2026-10-30 05:45:00.000';
const STARTED = '2026-10-30T05:15:02.000Z';

const COMP = {
  feed: 'components',
  tab: 'Components',
  headers: ['ME_EC', 'MPN', 'Years To EOL', 'Is Sourced By Us', 'Demand 2026'],
  types: ['string', 'string', 'number', 'boolean', 'number'],
};
const COMP_ROWS = [
  ['ME_EC_0000001', '0402', 3.5, true, 1000],
  ['ME_EC_0000002', '1E3', null, false, 0],
  ['ME_EC_0000003', 'MAR-12, "x"', 2, true, 7],
];
const PROD = { feed: 'products', tab: 'Products', headers: ['Product ID', 'Product Display Name', 'SOP'], types: ['number', 'string', 'date'] };
const PROD_ROWS = [[42, 'Inverter', '2027-01-15']];
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
const N = DEFS.length; // feeds per run; a run's Inbox holds N data files plus the manifest
const ALL_CSV = FEED_NAMES.map((f) => `${f}.csv`).sort();
const DEFAULT_ROWS = { components: COMP_ROWS, products: PROD_ROWS };

const berlin = (iso) => new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
}).format(new Date(iso));
const sheetRows = (rows) => rows.map((r) => r.map((v) => (v === null ? '' : v)));
// Values returned from the vm realm, as plain objects of this realm.
const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function env(opts = {}) {
  const e = makeEnv(opts);
  e.clock = { t: NOW, step: 0 };
  e.context.pullerNow_ = () => {
    const t = e.clock.t;
    e.clock.t += e.clock.step;
    return t;
  };
  e.poll = () => plain(e.context.pollInbox());
  return e;
}

function payload(runId, rowsByFeed = DEFAULT_ROWS, { status = 'ready', reason, state = {} } = {}) {
  const prepared = status === 'failed' ? [] : DEFS.map((d) => ({
    feedDef: { feed: d.feed, tab: d.tab }, headers: d.headers, types: d.types, rows: rowsByFeed[d.feed] ?? [],
  }));
  const st = { runId, startedAt: STARTED, baseYear: 2026, health: HEALTH, ...state };
  return buildPayload(st, prepared, { status, reason, publishedAt: '2026-10-30T05:40:00.000Z' });
}

// Uploads files into the fake Inbox as the service account would (created an hour before NOW by default).
function drop(e, files, { created = new Date(NOW - HOUR), skip = [] } = {}) {
  for (const f of files) {
    if (!skip.includes(f.name)) e.inbox.addFile(f.name, f.bytes, { mimeType: f.mimeType, created });
  }
}

function manifestFile(manifest) {
  return { name: `${manifest.runId}__manifest.json`, bytes: Buffer.from(JSON.stringify(manifest), 'utf8'), mimeType: 'application/json' };
}

// Each staged slice / commit "takes" ms on the injected clock.
function sliceCost(e, ms) {
  const real = e.context.stageRows_;
  e.context.stageRows_ = (...args) => {
    e.clock.t += ms;
    return real(...args);
  };
}
function oneOffTriggers(e) {
  return e.triggers.filter((t) => t.getHandlerFunction() === 'pollInbox' && t.after !== undefined);
}
function countBegins(e) {
  const counter = { n: 0 };
  const real = e.context.handleBegin_;
  e.context.handleBegin_ = (req) => {
    counter.n++;
    return real(req);
  };
  return counter;
}
function stagingWrites(e) {
  return e.ss.calls.filter((c) => c.op === 'setValues' && c.sheet.startsWith('__staging_') && c.row >= 2)
    .map((c) => `${c.sheet}:${c.row}x${c.numRows}`).sort();
}

function entries(e) {
  const log = e.ss.getSheetByName('_Refresh_Log');
  return log ? log.data().slice(4) : [];
}
function stagingTabs(e) {
  return e.ss.names().filter((n) => n.startsWith('__staging_'));
}
function snapshotDay(e, day) {
  const raw = e.drive.root.folder('Raw snapshots');
  return raw ? raw.folder(day) : null;
}

test('a ready run lands all fifteen tabs, logs OK, writes CSV snapshots and trashes its Inbox files', () => {
  const e = env();
  const live = e.ss.seed('Components', [COMP.headers, ['OLD', 'old', 1, true, 1]]);
  const liveId = live.getSheetId();
  drop(e, payload(RUN).files);

  assert.deepStrictEqual(e.poll(), { status: 'committed', runId: RUN });

  assert.deepStrictEqual(e.ss.names(), [...TABS, '_Refresh_Log']);
  assert.strictEqual(e.ss.getSheetByName('Components'), live, 'live tab keeps its identity');
  assert.strictEqual(live.getSheetId(), liveId);
  assert.deepStrictEqual(live.data(), [COMP.headers, ...sheetRows(COMP_ROWS)]);
  assert.strictEqual(live.getFormat(2, 2), '@', 'MPN column is text');
  assert.strictEqual(live.data()[1][1], '0402');
  assert.deepStrictEqual(e.ss.getSheetByName('Products').data(), [PROD.headers, ...PROD_ROWS]);
  assert.deepStrictEqual(e.ss.getSheetByName('MECL_Price').data(), [DEFS[5].headers]);

  const day = snapshotDay(e, '2026-10-30');
  assert.deepStrictEqual(day.fileNames(), ALL_CSV);
  assert.strictEqual(day.file('components.csv').getBlob().getDataAsString(),
    'ME_EC,MPN,Years To EOL,Is Sourced By Us,Demand 2026\nME_EC_0000001,0402,3.5,TRUE,1000\nME_EC_0000002,1E3,,FALSE,0\nME_EC_0000003,"MAR-12, ""x""",2,TRUE,7\n');

  const counts = { components: 3, products: 1 };
  assert.deepStrictEqual(entries(e).map((r) => [r[0], r[1], r[3], r[4], r[5], r[6], r[7]]),
    FEED_NAMES.map((f) => [RUN, berlin(STARTED), f, counts[f] ?? 0, SRC, 'OK', '']));
  const log = e.ss.getSheetByName('_Refresh_Log').data();
  assert.deepStrictEqual(log[1].slice(0, 2), ['Base year', 2026], 'base year from the numeric manifest.baseYear');

  assert.strictEqual(e.stored.LAST_PROCESSED_RUN, RUN);
  assert.strictEqual(e.stored.ACTIVE_RUN, undefined);
  assert.deepStrictEqual(e.inbox.fileNames(), [], 'every Inbox file of the run is trashed');
  assert.strictEqual(e.inbox.files.length, N + 1);
  assert.deepStrictEqual(e.lockLog, [['try', 5000], ['release']]);
});

test('a second poll after a processed run does nothing', () => {
  const e = env();
  drop(e, payload(RUN).files);
  assert.strictEqual(e.poll().status, 'committed');
  const calls = e.ss.calls.length;
  const log = entries(e).length;
  assert.deepStrictEqual(e.poll(), { status: 'idle' });
  assert.strictEqual(e.ss.calls.length, calls, 'no sheet writes');
  assert.strictEqual(entries(e).length, log, 'no log rows');
  assert.strictEqual(e.stored.LAST_PROCESSED_RUN, RUN);
});

test('an empty Inbox is idle and writes nothing', () => {
  const e = env();
  assert.deepStrictEqual(e.poll(), { status: 'idle' });
  assert.deepStrictEqual(e.ss.names(), []);
  assert.strictEqual(e.stored.LAST_PROCESSED_RUN, undefined);
});

test('slicing stops when elapsed + the previous slice would pass 270 s; the next poll resumes without restaging or re-running begin', () => {
  const e = env();
  e.context.installPullTrigger();
  e.context.MASTERDATA_CONFIG.PULL_SLICE_CELLS = 5; // components is 5 wide: one row per slice
  sliceCost(e, 100000); // every slice takes 100 s
  const begins = countBegins(e);
  drop(e, payload(RUN).files);

  // Poll 1: slices at 0 s and 100 s; at 200 s the next one (200 + 100 > 270) is not started.
  assert.deepStrictEqual(e.poll(), { status: 'staging', runId: RUN });
  let run = JSON.parse(e.stored.ACTIVE_RUN);
  assert.deepStrictEqual(run.feeds.map((f) => f.staged), [2, ...Array(N - 1).fill(0)]);
  assert.strictEqual(e.ss.getSheetByName('Components'), null, 'live tabs untouched while staging');
  assert.strictEqual(e.inbox.fileNames().length, N + 1, 'Inbox files stay until the run ends');
  // R51: a one-off continuation trigger in 60 s; the 5-minute trigger stays.
  let oneOffs = oneOffTriggers(e);
  assert.strictEqual(oneOffs.length, 1);
  assert.strictEqual(oneOffs[0].after, 60000);
  const firstId = oneOffs[0].getUniqueId();

  // Poll 2: stages the remaining 2 rows; at 200 s it is too late to start the commit (>= 150 s).
  assert.deepStrictEqual(e.poll(), { status: 'staging', runId: RUN });
  run = JSON.parse(e.stored.ACTIVE_RUN);
  assert.deepStrictEqual(run.feeds.map((f) => f.staged), [3, 0, 0, 0, 1, ...Array(N - 5).fill(0)]);
  oneOffs = oneOffTriggers(e);
  assert.strictEqual(oneOffs.length, 1, 'the spent one-off trigger was deleted, a new one created');
  assert.notStrictEqual(oneOffs[0].getUniqueId(), firstId);

  // Poll 3: commits at once.
  assert.deepStrictEqual(e.poll(), { status: 'committed', runId: RUN });
  assert.strictEqual(begins.n, 1, 'begin runs once');
  assert.deepStrictEqual(stagingWrites(e),
    ['__staging_Components:2x1', '__staging_Components:3x1', '__staging_Components:4x1', '__staging_Products:2x1'], 'each row staged once');
  assert.deepStrictEqual(e.ss.getSheetByName('Components').data(), [COMP.headers, ...sheetRows(COMP_ROWS)]);
  assert.strictEqual(snapshotDay(e, '2026-10-30').file('components.csv').getBlob().getDataAsString().split('\n').length, 5);
  assert.deepStrictEqual(entries(e).map((r) => r[6]), Array(N).fill('OK'), 'no ABANDONED, RETRY or FAILED rows');
  assert.deepStrictEqual(e.inbox.fileNames(), []);
  assert.deepStrictEqual(oneOffTriggers(e), [], 'no continuation left after the commit');
  assert.deepStrictEqual(e.triggers.filter((t) => t.everyMinutes === 5).length, 1, 'the 5-minute trigger is kept');
});

test('the commit only starts before 150 s of the poll; later it waits for the next poll', () => {
  let e = env();
  sliceCost(e, 160000);
  drop(e, payload(RUN, { components: COMP_ROWS }).files);
  assert.deepStrictEqual(e.poll(), { status: 'staging', runId: RUN });
  assert.strictEqual(e.ss.getSheetByName('Components'), null);
  assert.strictEqual(oneOffTriggers(e).length, 1);
  assert.deepStrictEqual(e.poll(), { status: 'committed', runId: RUN });

  e = env();
  sliceCost(e, 140000);
  drop(e, payload(RUN, { components: COMP_ROWS }).files);
  assert.deepStrictEqual(e.poll(), { status: 'committed', runId: RUN });
  assert.strictEqual(e.context.MASTERDATA_CONFIG.PULL_COMMIT_START_MAX_MS, 150000);
  assert.deepStrictEqual(oneOffTriggers(e), []);
});

test('the start time is read on entry, before tryLock', () => {
  const e = env();
  e.context.pullerNow_ = () => {
    e.lockLog.push(['now']);
    return NOW;
  };
  e.poll();
  assert.deepStrictEqual(e.lockLog.slice(0, 2), [['now'], ['try', 5000]]);
})

test('the slice size is 100,000 cells and the budget 270 s (Config.ts)', () => {
  const e = env();
  assert.strictEqual(e.context.MASTERDATA_CONFIG.PULL_SLICE_CELLS, 100000);
  assert.strictEqual(e.context.MASTERDATA_CONFIG.PULL_SLICE_ROWS, undefined);
  assert.strictEqual(e.context.MASTERDATA_CONFIG.PULL_BUDGET_MS, 270000);
  assert.strictEqual(e.context.MASTERDATA_CONFIG.INBOX_FOLDER_ID, INBOX_ID);
  const ms = Array.from({ length: 9001 }, (_, i) => [`ME_MS_${i}`, i]);
  drop(e, payload(RUN, { multisource: ms }).files);
  assert.strictEqual(e.poll().status, 'committed');
  const writes = e.ss.calls.filter((c) => c.op === 'setValues' && c.sheet === '__staging_Multisource' && c.row >= 2);
  assert.deepStrictEqual(writes.map((c) => [c.row, c.numRows]), [[2, 9001]], '2 columns: up to 50,000 rows per slice');
  assert.strictEqual(e.ss.getSheetByName('Multisource').getLastRow(), 9002);
  assert.strictEqual(e.stored.LAST_PROCESSED_RUN, RUN);
  assert.deepStrictEqual(e.inbox.fileNames(), []);
});

// The rows per slice follow the feed width: floor(100,000 / headers), at least 1.
function stagedSliceSizes(headerCount, rowCount) {
  const e = env();
  const headers = Array.from({ length: headerCount }, (_, i) => `H${i}`);
  const types = headers.map(() => 'number');
  const rows = Array.from({ length: rowCount }, (_, i) => headers.map((_, j) => i + j));
  const defs = DEFS.map((d) => (d.feed === 'multisource' ? { ...d, headers, types } : d));
  const prepared = defs.map((d) => ({ feedDef: { feed: d.feed, tab: d.tab }, headers: d.headers, types: d.types, rows: d.feed === 'multisource' ? rows : [] }));
  const { files } = buildPayload({ runId: RUN, startedAt: STARTED, baseYear: 2026, health: HEALTH }, prepared, { publishedAt: '2026-10-30T05:40:00.000Z' });
  drop(e, files);
  assert.strictEqual(e.poll().status, 'committed');
  return e.ss.calls.filter((c) => c.op === 'setValues' && c.sheet === '__staging_Multisource' && c.row >= 2).map((c) => c.numRows);
}

test('wide feeds stage in cell-sized slices', () => {
  assert.deepStrictEqual(stagedSliceSizes(160, 1500), [625, 625, 250]);
  assert.deepStrictEqual(stagedSliceSizes(25, 9000), [4000, 4000, 1000]);
});


test('a sha256 mismatch fails the run: FAILED, live tabs untouched, Inbox files trashed', () => {
  const e = env();
  const live = e.ss.seed('Components', [COMP.headers, ['OLD', 'old', 1, true, 1]]);
  const { files } = payload(RUN);
  const name = `${RUN}__components.json.gz`;
  drop(e, files, { skip: [name] });
  e.inbox.addFile(name, gzipSync(Buffer.from(JSON.stringify([['TAMPERED', 'x', 1, true, 1]]), 'utf8')), { created: new Date(NOW - HOUR) });

  const res = e.poll();
  assert.strictEqual(res.status, 'failed');
  assert.match(res.error, /components\.json\.gz: sha256 does not match the manifest/);
  assert.deepStrictEqual(live.data(), [COMP.headers, ['OLD', 'old', 1, true, 1]]);
  assert.deepStrictEqual(stagingTabs(e), []);
  const rows = entries(e);
  assert.strictEqual(rows.length, 1);
  assert.deepStrictEqual([rows[0][0], rows[0][1], rows[0][6]], [RUN, berlin(STARTED), 'FAILED']);
  assert.match(rows[0][7], /sha256 does not match/);
  assert.strictEqual(e.stored.LAST_PROCESSED_RUN, RUN);
  assert.strictEqual(e.stored.ACTIVE_RUN, undefined);
  assert.deepStrictEqual(e.inbox.fileNames(), []);
  assert.deepStrictEqual(e.poll(), { status: 'idle' }, 'the failed run is not retried');
});

test('R46: of several same-name copies, the data file whose sha256 matches the manifest is used', () => {
  const e = env();
  const { files } = payload(RUN);
  const name = `${RUN}__components.json.gz`;
  // A bad copy first, then the real files (including a second, identical manifest copy).
  e.inbox.addFile(name, gzipSync(Buffer.from('[]', 'utf8')), { created: new Date(NOW - 2 * HOUR) });
  drop(e, files);
  drop(e, files.filter((f) => f.name.endsWith('__manifest.json')));
  assert.deepStrictEqual(e.poll(), { status: 'committed', runId: RUN });
  assert.deepStrictEqual(e.ss.getSheetByName('Components').data(), [COMP.headers, ...sheetRows(COMP_ROWS)]);
  assert.deepStrictEqual(e.inbox.fileNames(), []);
});

test('a failed manifest logs one FAILED row with its reason and trashes the run\'s files (also data files)', () => {
  const e = env();
  const ready = payload(RUN);
  // Data files uploaded before the failure, then the failed manifest (health and baseYear null).
  drop(e, ready.files.filter((f) => !f.name.endsWith('__manifest.json')));
  const failed = payload(RUN, {}, { status: 'failed', reason: 'upload failed: HTTP 500', state: { health: null, baseYear: null } });
  assert.strictEqual(failed.manifest.health, null);
  drop(e, failed.files);

  assert.deepStrictEqual(e.poll(), { status: 'failed', runId: RUN, error: 'upload failed: HTTP 500' });
  const rows = entries(e);
  assert.strictEqual(rows.length, 1);
  assert.deepStrictEqual([rows[0][0], rows[0][1], rows[0][3], rows[0][4], rows[0][5], rows[0][6], rows[0][7]],
    [RUN, berlin(STARTED), '', '', '', 'FAILED', 'upload failed: HTTP 500']);
  assert.deepStrictEqual(TABS.filter((t) => e.ss.getSheetByName(t)), []);
  assert.strictEqual(e.stored.LAST_PROCESSED_RUN, RUN);
  assert.deepStrictEqual(e.inbox.fileNames(), []);
  assert.deepStrictEqual(e.poll(), { status: 'idle' });
  assert.strictEqual(entries(e).length, 1);
});

test('R46: when a runId has both a ready and a failed manifest, the failed one wins', () => {
  const e = env();
  drop(e, payload(RUN).files);
  drop(e, payload(RUN, {}, { status: 'failed', reason: 'late failure' }).files);
  const res = e.poll();
  assert.deepStrictEqual(res, { status: 'failed', runId: RUN, error: 'late failure' });
  assert.deepStrictEqual(TABS.filter((t) => e.ss.getSheetByName(t)), []);
  assert.deepStrictEqual(entries(e).map((r) => r[6]), ['FAILED']);
  assert.deepStrictEqual(e.inbox.fileNames(), []);
});

test('a manifest whose data file is missing fails the run before anything is staged', () => {
  const e = env();
  const { files } = payload(RUN);
  drop(e, files, { skip: [`${RUN}__mecl_price.json.gz`] });
  const res = e.poll();
  assert.strictEqual(res.status, 'failed');
  assert.match(res.error, /mecl_price\.json\.gz: missing from the Inbox/);
  assert.ok(!e.ss.calls.some((c) => c.sheet && c.sheet.startsWith('__staging_')), 'no staging tab was written');
  assert.deepStrictEqual(entries(e).map((r) => [r[0], r[6]]), [[RUN, 'FAILED']]);
  assert.strictEqual(e.stored.LAST_PROCESSED_RUN, RUN);
  assert.deepStrictEqual(e.inbox.fileNames(), []);
});

test('a data file whose row count differs from the manifest fails the run', () => {
  const e = env();
  const { manifest, files } = payload(RUN);
  const bad = structuredClone(manifest);
  bad.feeds[0].rowCount = 4;
  drop(e, [...files.filter((f) => !f.name.endsWith('__manifest.json')), manifestFile(bad)]);
  const res = e.poll();
  assert.strictEqual(res.status, 'failed');
  assert.match(res.error, /components\.json\.gz: 3 rows, manifest says 4/);
  assert.deepStrictEqual(entries(e).map((r) => r[6]), ['FAILED']);
});

test('a ready manifest that does not pass begin validation fails the run', () => {
  const e = env();
  const { manifest, files } = payload(RUN);
  const bad = structuredClone(manifest);
  bad.feeds = bad.feeds.slice(0, N - 1); // begin must list every tab
  drop(e, [...files.filter((f) => !f.name.endsWith('__manifest.json')), manifestFile(bad)]);
  const res = e.poll();
  assert.strictEqual(res.status, 'failed');
  assert.match(res.error, /begin must list every tab/);
  assert.deepStrictEqual(entries(e).map((r) => r[6]), ['FAILED']);
  assert.deepStrictEqual(e.inbox.fileNames(), []);
});

test('a manifest pointing at another run\'s file or with an unreadable body fails the run', () => {
  let e = env();
  const { manifest, files } = payload(RUN);
  const bad = structuredClone(manifest);
  bad.feeds[1].file = `${RUN2}__multisource.json.gz`;
  drop(e, [...files.filter((f) => !f.name.endsWith('__manifest.json')), manifestFile(bad)]);
  let res = e.poll();
  assert.strictEqual(res.status, 'failed');
  assert.match(res.error, /multisource: file must be 2026-10-30T06-15-02__multisource\.json\.gz/);

  e = env();
  e.inbox.addFile(`${RUN}__manifest.json`, Buffer.from('{not json', 'utf8'), { created: new Date(NOW - HOUR) });
  res = e.poll();
  assert.deepStrictEqual(res, { status: 'failed', runId: RUN, error: 'manifest is not valid JSON' });
  assert.deepStrictEqual(entries(e).map((r) => [r[0], r[6], r[7]]), [[RUN, 'FAILED', 'manifest is not valid JSON']]);
});

test('two pending runs are processed oldest first', () => {
  const e = env();
  const newer = { components: [['ME_EC_0000009', '0603', 1, true, 5], ...COMP_ROWS.slice(1)], products: PROD_ROWS };
  drop(e, payload(RUN2, newer).files, { created: new Date(NOW - HOUR) });
  drop(e, payload(RUN).files, { created: new Date(NOW - 2 * HOUR) });
  assert.deepStrictEqual(e.poll(), { status: 'committed', runId: RUN });
  assert.strictEqual(e.ss.getSheetByName('Components').data()[1][1], '0402');
  assert.deepStrictEqual(e.inbox.fileNames().every((n) => n.startsWith(`${RUN2}__`)), true);
  assert.deepStrictEqual(e.poll(), { status: 'committed', runId: RUN2 });
  assert.strictEqual(e.ss.getSheetByName('Components').data()[1][1], '0603');
  assert.deepStrictEqual(entries(e).map((r) => r[0]), [...Array(N).fill(RUN2), ...Array(N).fill(RUN)]);
  assert.strictEqual(e.stored.LAST_PROCESSED_RUN, RUN2);
  assert.deepStrictEqual(e.inbox.fileNames(), []);
});

test('Inbox files older than 3 days that belong to no manifest are trashed; newer ones stay', () => {
  const e = env();
  const old = new Date(NOW - 3 * DAY - HOUR);
  const recent = new Date(NOW - 2 * DAY);
  e.inbox.addFile('2026-10-20T06-15-00__components.json.gz', Buffer.from('x'), { created: old });
  e.inbox.addFile('2026-10-31T06-15-00__components.json.gz', Buffer.from('x'), { created: new Date(NOW - 5 * 60000) }); // upload in progress
  e.inbox.addFile('notes.txt', Buffer.from('x'), { created: old });
  e.inbox.addFile('readme.txt', Buffer.from('x'), { created: recent });
  e.inbox.addFile('2026-10-21T06-15-00__products.json.gz', Buffer.from('x'), { created: recent });
  assert.deepStrictEqual(e.poll(), { status: 'idle' });
  assert.deepStrictEqual(e.inbox.fileNames(), ['2026-10-21T06-15-00__products.json.gz', '2026-10-31T06-15-00__components.json.gz', 'readme.txt']);
  assert.deepStrictEqual(entries(e).map((r) => [r[0], r[6], r[7]]),
    [['2026-10-20T06-15-00', 'INCOMPLETE', 'no manifest after 3 days; 1 file(s) trashed']], 'foreign files are not logged');
});

test('a busy script lock makes the poll exit quietly', () => {
  const e = env();
  drop(e, payload(RUN).files);
  e.lock.busy = true;
  assert.deepStrictEqual(e.poll(), { status: 'busy' });
  assert.deepStrictEqual(e.lockLog, [['try', 5000]]);
  assert.deepStrictEqual(e.ss.names(), []);
  assert.strictEqual(e.inbox.fileNames().length, N + 1);
  e.lock.busy = false;
  assert.strictEqual(e.poll().status, 'committed');
});

test('a manifest at or before LAST_PROCESSED_RUN is never processed again; its leftover files are trashed', () => {
  const e = env({ props: { LAST_PROCESSED_RUN: RUN2 } });
  drop(e, payload(RUN).files);
  drop(e, payload(RUN2).files);
  assert.deepStrictEqual(e.poll(), { status: 'idle' });
  assert.deepStrictEqual(TABS.filter((t) => e.ss.getSheetByName(t)), []);
  assert.deepStrictEqual(e.inbox.fileNames(), []);
  assert.strictEqual(e.stored.LAST_PROCESSED_RUN, RUN2);
  // The older run is logged SUPERSEDED; leftovers of the last processed run itself are not logged.
  assert.deepStrictEqual(entries(e).map((r) => [r[0], r[6], r[7]]),
    [[RUN, 'SUPERSEDED', `older run superseded by ${RUN2}; files trashed`]]);
});

test('a runId more than a day in the future is FAILED without moving LAST_PROCESSED_RUN', () => {
  const e = env({ props: { LAST_PROCESSED_RUN: RUN } });
  const future = '2026-11-05T06-15-00';
  drop(e, payload(future).files);
  const res = e.poll();
  assert.deepStrictEqual(res, { status: 'failed', runId: future, error: 'runId is in the future' });
  assert.deepStrictEqual(e.ss.names(), ['_Refresh_Log']);
  assert.strictEqual(e.stored.LAST_PROCESSED_RUN, RUN);
  assert.deepStrictEqual(e.inbox.fileNames(), []);
  assert.deepStrictEqual(entries(e).map((r) => [r[0], r[6], r[7]]), [[future, 'FAILED', 'runId is in the future']]);
  // The same runId again (re-upload, or files that could not be trashed): not logged a second time.
  drop(e, payload(future).files);
  assert.deepStrictEqual(e.poll(), { status: 'failed', runId: future, error: 'runId is in the future' });
  assert.strictEqual(entries(e).length, 1);
  assert.deepStrictEqual(e.inbox.fileNames(), []);
});

test('a future runId never moves LAST_PROCESSED_RUN, even when logging fails', () => {
  const e = env({ props: { LAST_PROCESSED_RUN: RUN } });
  const future = '2026-11-05T06-15-00';
  drop(e, payload(future, {}, { status: 'failed', reason: 'x' }).files);
  const real = e.context.SpreadsheetApp.getActiveSpreadsheet;
  let n = 0;
  e.context.SpreadsheetApp.getActiveSpreadsheet = () => {
    n++;
    if (n <= 2) throw new Error('transient');
    return real();
  };
  assert.throws(() => e.context.pollInbox(), /transient/, 'nothing could be logged');
  assert.strictEqual(e.stored.LAST_PROCESSED_RUN, RUN);
  assert.deepStrictEqual(e.poll(), { status: 'failed', runId: future, error: 'runId is in the future' });
  assert.strictEqual(e.stored.LAST_PROCESSED_RUN, RUN);
  assert.deepStrictEqual(entries(e).map((r) => [r[0], r[6]]), [[future, 'FAILED']]);
});

test('errors on the future-runId path are not run errors: no RETRY, never LAST_PROCESSED_RUN', () => {
  const e = env({ props: { LAST_PROCESSED_RUN: RUN } });
  const future = '2026-11-05T06-15-00';
  drop(e, payload(future).files);
  const real = e.context.writeLogRows_;
  e.context.writeLogRows_ = (ss, rows) => {
    if (rows[0][7] === 'runId is in the future') throw new Error('log hiccup');
    return real(ss, rows);
  };
  for (let i = 0; i < 3; i++) assert.deepStrictEqual(e.poll(), { status: 'error', error: 'inbox: log hiccup' });
  assert.strictEqual(e.stored.LAST_PROCESSED_RUN, RUN);
  assert.deepStrictEqual(entries(e).map((r) => [r[0], r[6], r[7]]), [['', 'FAILED', 'inbox: log hiccup']], 'logged once, no RETRY');
});

test('the row-drop guard still rejects a run: FAILED once, live untouched, Inbox files trashed', () => {
  const e = env({ props: { LAST_ROW_COUNTS: JSON.stringify({ components: 100 }) } });
  const live = e.ss.seed('Components', [COMP.headers, ['OLD', 'old', 1, true, 1]]);
  drop(e, payload(RUN).files);
  const res = e.poll();
  assert.strictEqual(res.status, 'failed');
  assert.match(res.error, /row drop over 20%/);
  assert.deepStrictEqual(live.data(), [COMP.headers, ['OLD', 'old', 1, true, 1]]);
  assert.deepStrictEqual(stagingTabs(e), []);
  assert.deepStrictEqual([...new Set(entries(e).map((r) => r[6]))], ['FAILED'], 'a validation rejection is final: no RETRY');
  assert.strictEqual(e.stored.PULL_RETRY, undefined);
  assert.strictEqual(e.stored.LAST_PROCESSED_RUN, RUN);
  assert.deepStrictEqual(e.inbox.fileNames(), []);
});

test('R48: a transient error is retried on the next poll: one RETRY row, then OK', () => {
  const e = env();
  drop(e, payload(RUN).files);
  let fails = 1;
  e.drive.failBlob = (file) => {
    if (file.name.endsWith('__products.json.gz') && fails-- > 0) throw new Error('Drive hiccup');
  };
  const res = e.poll();
  assert.deepStrictEqual(res, { status: 'retry', runId: RUN, error: 'Drive hiccup' });
  assert.deepStrictEqual(entries(e).map((r) => [r[0], r[1], r[6], r[7]]), [[RUN, berlin(STARTED), 'RETRY', 'attempt 1 of 3: Drive hiccup']]);
  assert.strictEqual(e.stored.LAST_PROCESSED_RUN, undefined);
  assert.strictEqual(e.inbox.fileNames().length, N + 1);
  assert.deepStrictEqual(e.poll(), { status: 'committed', runId: RUN });
  assert.deepStrictEqual(entries(e).map((r) => r[6]), [...Array(N).fill('OK'), 'RETRY']);
  assert.strictEqual(e.stored.PULL_RETRY, undefined, 'counter cleared on success');
  assert.deepStrictEqual(e.inbox.fileNames(), []);
});

test('R48: a transient commit error keeps staging; the retry commits without restaging, snapshots complete', () => {
  const e = env();
  const begins = countBegins(e);
  drop(e, payload(RUN).files);
  let fails = 1;
  // Components is assembled (parts trashed, .tmp written) before products fails.
  e.drive.failCreate = (folder, name) => {
    if (name === 'products.csv.tmp' && fails-- > 0) throw new Error('Drive create failed');
  };
  const res = e.poll();
  assert.strictEqual(res.status, 'retry');
  assert.match(res.error, /Drive create failed/);
  assert.strictEqual(stagingTabs(e).length, N, 'staging kept');
  assert.ok(e.stored.ACTIVE_RUN, 'active run kept');
  assert.strictEqual(e.ss.getSheetByName('Components'), null, 'live tabs untouched');
  const writes = stagingWrites(e);

  assert.deepStrictEqual(e.poll(), { status: 'committed', runId: RUN });
  assert.strictEqual(begins.n, 1);
  assert.deepStrictEqual(stagingWrites(e), writes, 'nothing restaged');
  const day = snapshotDay(e, '2026-10-30');
  assert.deepStrictEqual(day.fileNames(), ALL_CSV);
  assert.strictEqual(day.file('components.csv').getBlob().getDataAsString().split('\n').length, 5, 'components.csv keeps its rows');
  assert.strictEqual(day.file('products.csv').getBlob().getDataAsString(), 'Product ID,Product Display Name,SOP\n42,Inverter,2027-01-15\n');
  assert.deepStrictEqual(entries(e).map((r) => r[6]), [...Array(N).fill('OK'), 'RETRY']);
});

test('R48: the third failed attempt ends the run FAILED', () => {
  const e = env();
  drop(e, payload(RUN).files);
  e.drive.failBlob = (file) => {
    if (file.name.endsWith('__products.json.gz')) throw new Error('Drive hiccup');
  };
  assert.strictEqual(e.poll().status, 'retry');
  assert.strictEqual(e.poll().status, 'retry');
  const res = e.poll();
  assert.deepStrictEqual(res, { status: 'failed', runId: RUN, error: 'attempt 3 of 3: Drive hiccup' });
  assert.deepStrictEqual(entries(e).map((r) => [r[0], r[6], r[7]]), [
    [RUN, 'FAILED', 'attempt 3 of 3: Drive hiccup'],
    [RUN, 'RETRY', 'attempt 2 of 3: Drive hiccup'],
    [RUN, 'RETRY', 'attempt 1 of 3: Drive hiccup'],
  ]);
  assert.deepStrictEqual(stagingTabs(e), []);
  assert.strictEqual(e.stored.ACTIVE_RUN, undefined);
  assert.strictEqual(e.stored.PULL_RETRY, undefined);
  assert.strictEqual(e.stored.LAST_PROCESSED_RUN, RUN);
  assert.deepStrictEqual(e.inbox.fileNames(), []);
  assert.deepStrictEqual(e.poll(), { status: 'idle' });
  assert.strictEqual(entries(e).length, 3);
});

test('a commit that finds the run no longer active writes a FAILED row', () => {
  const e = env();
  drop(e, payload(RUN).files);
  const real = e.context.commitRun_;
  e.context.commitRun_ = (req, retryable) => {
    e.context.clearActiveRun_();
    return real(req, retryable);
  };
  assert.deepStrictEqual(e.poll(), { status: 'failed', runId: RUN, error: 'not the active run' });
  assert.deepStrictEqual(entries(e).map((r) => [r[0], r[6], r[7]]), [[RUN, 'FAILED', 'not the active run']]);
  assert.strictEqual(e.stored.LAST_PROCESSED_RUN, RUN);
  assert.deepStrictEqual(e.inbox.fileNames(), []);
});

test('a Drive error while trashing a committed run\'s files keeps the run OK; a later poll trashes the leftovers', () => {
  const e = env();
  drop(e, payload(RUN).files);
  const realGetFiles = e.inbox.getFiles.bind(e.inbox);
  let listings = 0;
  e.inbox.getFiles = () => {
    listings++;
    if (listings === 2) throw new Error('Drive listing failed');
    return realGetFiles();
  };
  assert.deepStrictEqual(e.poll(), { status: 'committed', runId: RUN });
  assert.deepStrictEqual(entries(e).map((r) => r[6]), Array(N).fill('OK'));
  assert.strictEqual(e.stored.LAST_PROCESSED_RUN, RUN);
  assert.strictEqual(e.inbox.fileNames().length, N + 1, 'files could not be trashed yet');
  assert.deepStrictEqual(e.poll(), { status: 'idle' });
  assert.deepStrictEqual(e.inbox.fileNames(), []);
  assert.strictEqual(entries(e).length, N, 'nothing else logged');
});

test('an unexpected error outside a run (Inbox unreachable) is logged FAILED once, not every poll', () => {
  const e = env({ inboxId: 'some-other-folder' });
  const res = e.poll();
  assert.strictEqual(res.status, 'error');
  assert.match(res.error, /^inbox: No item with the given ID could be found/);
  assert.deepStrictEqual(e.poll().status, 'error');
  assert.deepStrictEqual(entries(e).map((r) => [r[0], r[6], r[7]]), [['', 'FAILED', res.error]]);
  assert.deepStrictEqual(e.lockLog.map((l) => l[0]), ['try', 'release', 'try', 'release']);
});

test('an unexpected error is rethrown only when nothing could be logged', () => {
  const e = env({ inboxId: 'some-other-folder' });
  e.context.SpreadsheetApp.getActiveSpreadsheet = () => {
    throw new Error('sheet unavailable');
  };
  assert.throws(() => e.context.pollInbox(), /No item with the given ID could be found/);
  assert.deepStrictEqual(e.lockLog.map((l) => l[0]), ['try', 'release'], 'the lock is released');
});

test('R54: installPullTrigger replaces pollInbox triggers with one trigger every 5 minutes', () => {
  const e = env();
  const other = e.trigger({ handler: 'checkDailyRefresh' });
  e.triggers.push(other, e.trigger({ handler: 'pollInbox' }), e.trigger({ handler: 'pollInbox' }));
  e.context.installPullTrigger();
  e.context.installPullTrigger();
  const mine = e.triggers.filter((t) => t.getHandlerFunction() === 'pollInbox');
  assert.strictEqual(mine.length, 1);
  assert.deepStrictEqual({ type: mine[0].type, everyMinutes: mine[0].everyMinutes }, { type: 'CLOCK', everyMinutes: 5 });
  assert.ok(e.triggers.includes(other), 'other triggers are kept');
});

test('sha256Hex_ turns Apps Script\'s signed digest bytes into lower-case hex', () => {
  const e = env();
  const buf = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  const signed = Array.from(buf, (b) => (b > 127 ? b - 256 : b));
  assert.strictEqual(e.context.sha256Hex_(signed), crypto.createHash('sha256').update(buf).digest('hex'));
  assert.strictEqual(e.context.sha256Hex_([]), crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex'));
});

// End to end: the exact files Node's buildPayload produces for the real sql/feeds.json feed definitions.
test('e2e: the real buildPayload output in the Inbox lands all fifteen live tabs', () => {
  const BASE_YEAR = 2026;
  const realFeeds = loadManifest().feeds;
  const raw = (feed, col, i) => {
    if (feed.feed === 'components' && col.sql === 'MPN') return ['0402', '1E3'][i];
    if (col.sql === 'ME_EC') return `ME_EC_000000${i + 1}`;
    if (i === 1 && col.type !== 'string' && col !== feed.columns[0]) return null; // empty cells become null in the shaped rows (never the whole row: BOM_Coverage has only number columns)
    switch (col.type) {
      case 'number': return String((i + 1) * 1.5);
      case 'boolean': return 'true';
      case 'date': return '2027-01-15 00:00:00.000';
      default: return `${col.sql.toLowerCase()} ${i}`;
    }
  };
  const prepared = realFeeds.map((feedDef) => {
    const cols = sqlColumnsFor(feedDef, BASE_YEAR);
    const typeOf = (j) => (j < feedDef.columns.length ? feedDef.columns[j] : { sql: cols[j], type: 'number' });
    const rawRows = [0, 1].map((i) => [`${feedDef.feed}-${i}`, ...cols.map((_, j) => raw(feedDef, typeOf(j), i))]);
    return { feedDef, ...shapeFeed(feedDef, BASE_YEAR, rawRows, cols) };
  });
  // Feeds registered in TABS but not yet in sql/feeds.json (added by later tasks) are padded with hand-made two-row feeds.
  for (const d of NEW_FEED_DEFS) {
    if (!realFeeds.some((f) => f.feed === d.feed)) {
      prepared.push({ feedDef: { feed: d.feed, tab: d.tab }, headers: d.headers, types: d.types, rows: [['x', 1], ['y', null]] });
    }
  }
  const feeds = prepared.map((p) => p.feedDef);
  const state = { runId: RUN, startedAt: STARTED, baseYear: BASE_YEAR, health: HEALTH };
  const { manifest, files } = buildPayload(state, prepared, { publishedAt: '2026-10-30T05:40:00.000Z' });
  // Sanity of the payload itself: gz JSON rows with null for empty cells.
  assert.deepStrictEqual(JSON.parse(gunzipSync(files[0].bytes).toString('utf8')), prepared[0].rows);
  assert.ok(prepared[0].rows[1].includes(null));

  const e = env();
  drop(e, files);
  assert.deepStrictEqual(e.poll(), { status: 'committed', runId: RUN });

  assert.deepStrictEqual(e.ss.names(), [...TABS, '_Refresh_Log']);
  prepared.forEach((p, k) => {
    const sheet = e.ss.getSheetByName(p.feedDef.tab);
    assert.deepStrictEqual(sheet.data(), [p.headers, ...sheetRows(p.rows)], p.feedDef.tab);
    assert.strictEqual(sheet.isSheetHidden(), false);
    assert.strictEqual(manifest.feeds[k].rowCount, 2);
  });
  const comp = e.ss.getSheetByName('Components');
  const mpn = prepared[0].headers.indexOf('MPN') + 1;
  assert.strictEqual(comp.getCell(2, mpn), '0402');
  assert.strictEqual(comp.getFormat(2, mpn), '@');
  assert.strictEqual(comp.getCell(3, mpn), '1E3');

  const day = snapshotDay(e, '2026-10-30');
  assert.deepStrictEqual(day.fileNames(), feeds.map((f) => `${f.feed}.csv`).sort());
  for (const p of prepared) {
    assert.strictEqual(day.file(`${p.feedDef.feed}.csv`).getBlob().getDataAsString().split('\n').length, 4, `${p.feedDef.feed}.csv: header + 2 rows`);
  }
  assert.ok(day.file('components.csv').getBlob().getDataAsString().includes(',0402,'));

  assert.deepStrictEqual(entries(e).map((r) => [r[0], r[3], r[4], r[5], r[6]]), feeds.map((f) => [RUN, f.feed, 2, SRC, 'OK']));
  assert.strictEqual(e.ss.getSheetByName('_Refresh_Log').data()[1][1], BASE_YEAR);
  assert.deepStrictEqual(e.inbox.fileNames(), []);
  assert.strictEqual(e.inbox.files.length, files.length);
  assert.ok(e.inbox.files.every((f) => f.trashed));
});

// ---- Final review fixes: R56 stalled runs, R57 young manifests, SUPERSEDED wording, late failed manifests ----

// A hard kill (Apps Script's 6-minute limit) ends an execution without any catch block or later code running.
// Simulated by a marker error that passes through pullUnexpected_ untouched: no RETRY row, no continuation trigger,
// nothing persisted after the point of the kill.
const KILL = 'HARD_KILL (simulated 6-minute kill)';
function hardKills(e) {
  const real = e.context.pullUnexpected_;
  e.context.pullUnexpected_ = (err, current) => {
    if (err && err.message === KILL) throw err;
    return real(err, current);
  };
}
const kill = () => {
  throw new Error(KILL);
};
const progress = (e) => (e.stored.PULL_PROGRESS === undefined ? undefined : JSON.parse(e.stored.PULL_PROGRESS));

test('R56: a run whose polls are hard-killed before anything is staged fails after 3 polls without progress', () => {
  const e = env();
  hardKills(e);
  const live = e.ss.seed('Components', [COMP.headers, ['OLD', 'old', 1, true, 1]]);
  drop(e, payload(RUN).files);
  e.context.stageRows_ = kill;
  for (let i = 1; i <= 3; i++) {
    assert.throws(() => e.context.pollInbox(), /HARD_KILL/, `poll ${i}`);
    assert.deepStrictEqual(progress(e), { runId: RUN, polls: i, stagedTotal: 0 }, 'persisted before any work');
  }
  assert.deepStrictEqual(e.poll(), { status: 'failed', runId: RUN, error: 'no progress after 3 polls' });
  const rows = entries(e);
  assert.ok(rows.length > 0);
  assert.deepStrictEqual([...new Set(rows.map((r) => [r[0], r[6], r[7]].join('|')))], [`${RUN}|FAILED|no progress after 3 polls`], 'no RETRY rows');
  assert.deepStrictEqual(live.data(), [COMP.headers, ['OLD', 'old', 1, true, 1]], 'live tabs untouched');
  assert.deepStrictEqual(stagingTabs(e), []);
  assert.strictEqual(e.stored.ACTIVE_RUN, undefined);
  assert.strictEqual(e.stored.LAST_PROCESSED_RUN, RUN);
  assert.strictEqual(e.stored.PULL_PROGRESS, undefined, 'cleared when the run ends');
  assert.deepStrictEqual(e.inbox.fileNames(), []);
  assert.deepStrictEqual(e.poll(), { status: 'idle' });
});

test('R56: a run whose commit is hard-killed on every poll fails after 3 commit-only polls', () => {
  const e = env();
  hardKills(e);
  sliceCost(e, 160000); // poll 1 stages everything but is too late to start the commit
  drop(e, payload(RUN, { components: COMP_ROWS }).files);
  assert.deepStrictEqual(e.poll(), { status: 'staging', runId: RUN });
  assert.deepStrictEqual(progress(e), { runId: RUN, polls: 1, stagedTotal: 0 });
  e.context.commitRun_ = kill;
  for (let i = 1; i <= 3; i++) {
    assert.throws(() => e.context.pollInbox(), /HARD_KILL/, `commit poll ${i}`);
    assert.deepStrictEqual(progress(e), { runId: RUN, polls: i, stagedTotal: 3 }, 'a commit-only poll is no progress');
  }
  assert.deepStrictEqual(e.poll(), { status: 'failed', runId: RUN, error: 'no progress after 3 polls' });
  assert.strictEqual(e.ss.getSheetByName('Components'), null, 'never swapped');
  assert.deepStrictEqual(stagingTabs(e), []);
  assert.deepStrictEqual([...new Set(entries(e).map((r) => r[6]))], ['FAILED']);
  assert.strictEqual(e.stored.LAST_PROCESSED_RUN, RUN);
  assert.deepStrictEqual(e.inbox.fileNames(), []);
});

test('R56: polls that are hard-killed but stage rows each time are not stalled; the run commits', () => {
  const e = env();
  hardKills(e);
  e.context.MASTERDATA_CONFIG.PULL_SLICE_CELLS = 5; // components is 5 wide: one row per slice
  const real = e.context.stageRows_;
  e.context.stageRows_ = (...args) => {
    real(...args);
    throw new Error(KILL); // killed right after each slice
  };
  drop(e, payload(RUN).files);
  for (let i = 0; i < 4; i++) assert.throws(() => e.context.pollInbox(), /HARD_KILL/);
  assert.deepStrictEqual(progress(e), { runId: RUN, polls: 1, stagedTotal: 3 });
  assert.deepStrictEqual(e.poll(), { status: 'committed', runId: RUN }, 'a commit-only poll that commits ends the run');
  assert.deepStrictEqual(e.ss.getSheetByName('Components').data(), [COMP.headers, ...sheetRows(COMP_ROWS)]);
  assert.deepStrictEqual(e.ss.getSheetByName('Products').data(), [PROD.headers, ...PROD_ROWS]);
  assert.deepStrictEqual(entries(e).map((r) => r[6]), Array(N).fill('OK'));
  assert.strictEqual(e.stored.PULL_PROGRESS, undefined);
});

test('R56: a run committed by a poll killed before LAST_PROCESSED_RUN was set is finished, not restaged or failed', () => {
  const e = env();
  hardKills(e);
  const begins = countBegins(e);
  drop(e, payload(RUN).files);
  const real = e.context.commitRun_;
  e.context.commitRun_ = (req, retryable) => {
    real(req, retryable);
    throw new Error(KILL); // killed right after the commit
  };
  assert.throws(() => e.context.pollInbox(), /HARD_KILL/);
  e.context.commitRun_ = real;
  assert.strictEqual(e.stored.LAST_PROCESSED_RUN, undefined);
  assert.strictEqual(e.stored.LAST_COMMITTED_RUN, RUN);
  const writes = stagingWrites(e);
  for (let i = 0; i < 4; i++) {
    assert.deepStrictEqual(e.poll(), i === 0 ? { status: 'committed', runId: RUN } : { status: 'idle' });
  }
  assert.strictEqual(begins.n, 1, 'not begun again');
  assert.deepStrictEqual(stagingWrites(e), writes, 'not restaged');
  assert.deepStrictEqual(entries(e).map((r) => r[6]), Array(N).fill('OK'), 'no second OK, no FAILED');
  assert.strictEqual(e.stored.LAST_PROCESSED_RUN, RUN);
  assert.strictEqual(e.stored.PULL_PROGRESS, undefined);
  assert.deepStrictEqual(e.inbox.fileNames(), []);
});

test('R57: a manifest younger than 2 minutes is left for a later poll (Drive listing lag)', () => {
  const e = env();
  assert.strictEqual(e.context.MASTERDATA_CONFIG.INBOX_MIN_AGE_MS, 120000);
  drop(e, payload(RUN).files, { created: new Date(NOW - 60000) });
  assert.deepStrictEqual(e.poll(), { status: 'waiting', runId: RUN });
  assert.deepStrictEqual(e.ss.names(), []);
  assert.strictEqual(e.inbox.fileNames().length, N + 1);
  assert.strictEqual(e.stored.PULL_PROGRESS, undefined, 'a skipped poll does not count toward R56');
  assert.deepStrictEqual(oneOffTriggers(e), []);
  e.clock.t = NOW + 60000; // now 2 minutes old
  assert.deepStrictEqual(e.poll(), { status: 'committed', runId: RUN });
});

test('R57: a young manifest of the oldest pending run is not skipped over by a newer run', () => {
  const e = env();
  drop(e, payload(RUN).files, { created: new Date(NOW - 30000) });
  drop(e, payload(RUN2).files, { created: new Date(NOW - HOUR) });
  assert.deepStrictEqual(e.poll(), { status: 'waiting', runId: RUN });
  assert.strictEqual(e.stored.LAST_PROCESSED_RUN, undefined);
  assert.strictEqual(e.inbox.fileNames().length, 2 * (N + 1));
});

test('item 6: SUPERSEDED is logged once, only after every file of the older run is trashed (manifest last)', () => {
  const e = env({ props: { LAST_PROCESSED_RUN: RUN2 } });
  drop(e, payload(RUN).files);
  let failing = true;
  e.drive.failTrash = (file) => {
    if (failing && file.name === `${RUN}__products.json.gz`) throw new Error('no permission');
  };
  for (let i = 0; i < 2; i++) {
    assert.deepStrictEqual(e.poll(), { status: 'idle' });
    assert.deepStrictEqual(entries(e), [], 'not logged while files remain');
    assert.deepStrictEqual(e.inbox.fileNames(), [`${RUN}__manifest.json`, `${RUN}__products.json.gz`], 'the manifest stays until its data files are gone');
  }
  failing = false;
  assert.deepStrictEqual(e.poll(), { status: 'idle' });
  assert.deepStrictEqual(e.inbox.fileNames(), []);
  assert.deepStrictEqual(e.poll(), { status: 'idle' });
  assert.deepStrictEqual(entries(e).map((r) => [r[0], r[6], r[7]]), [[RUN, 'SUPERSEDED', `older run superseded by ${RUN2}; files trashed`]]);
});

test('item 6: leftovers of a committed run keep their manifest, so they are trashed later without INCOMPLETE or SUPERSEDED', () => {
  const e = env();
  drop(e, payload(RUN).files);
  let failing = true;
  e.drive.failTrash = (file) => {
    if (failing && file.name === `${RUN}__products.json.gz`) throw new Error('no permission');
  };
  assert.deepStrictEqual(e.poll(), { status: 'committed', runId: RUN });
  assert.deepStrictEqual(e.inbox.fileNames(), [`${RUN}__manifest.json`, `${RUN}__products.json.gz`]);
  failing = false;
  e.clock.t = NOW + 4 * DAY;
  assert.deepStrictEqual(e.poll(), { status: 'idle' });
  assert.deepStrictEqual(e.inbox.fileNames(), []);
  assert.deepStrictEqual(entries(e).map((r) => r[6]), Array(N).fill('OK'));
});

test('item 12: a late failed manifest for a committed run writes one INFO row; live data stays', () => {
  const e = env();
  drop(e, payload(RUN).files);
  assert.deepStrictEqual(e.poll(), { status: 'committed', runId: RUN });
  const late = payload(RUN, {}, { status: 'failed', reason: 'upload failed: HTTP 503' });
  drop(e, late.files);
  assert.deepStrictEqual(e.poll(), { status: 'idle' });
  const rows = entries(e);
  assert.deepStrictEqual([rows[0][0], rows[0][1], rows[0][6], rows[0][7]],
    [RUN, berlin(STARTED), 'INFO', 'cloud run reported failure after data was committed: upload failed: HTTP 503']);
  assert.deepStrictEqual(rows.slice(1).map((r) => r[6]), Array(N).fill('OK'));
  assert.deepStrictEqual(e.ss.getSheetByName('Components').data(), [COMP.headers, ...sheetRows(COMP_ROWS)]);
  assert.deepStrictEqual(e.inbox.fileNames(), []);
  // The same failed manifest again (a create retry): not logged a second time.
  drop(e, late.files);
  assert.deepStrictEqual(e.poll(), { status: 'idle' });
  assert.strictEqual(entries(e).length, N + 1);
  assert.deepStrictEqual(e.inbox.fileNames(), []);
});

test('item 12: a late failed manifest for a run that already failed is trashed without a log row', () => {
  const e = env();
  drop(e, payload(RUN, {}, { status: 'failed', reason: 'first' }).files);
  assert.strictEqual(e.poll().status, 'failed');
  drop(e, payload(RUN, {}, { status: 'failed', reason: 'second' }).files);
  assert.deepStrictEqual(e.poll(), { status: 'idle' });
  assert.deepStrictEqual(entries(e).map((r) => [r[6], r[7]]), [['FAILED', 'first']]);
  assert.deepStrictEqual(e.inbox.fileNames(), []);
});
