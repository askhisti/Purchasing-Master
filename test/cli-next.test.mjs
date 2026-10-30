import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { begin, next } from '../refresh/cli.mjs';

const FEED_A = 'SELECT ROW_KEY, V FROM t WHERE Y = {{BASE_YEAR}}';
const FEED_B = 'SELECT ROW_KEY, W FROM u WHERE Y = {{BASE_YEAR}}';

function makeRoot(pageLimit = 2) {
  const root = mkdtempSync(join(tmpdir(), 'pm-cli-'));
  mkdirSync(join(root, 'sql', 'feeds'), { recursive: true });
  writeFileSync(join(root, 'sql', 'health.sql'), 'SELECT 1 AS BASE_YEAR');
  writeFileSync(join(root, 'sql', 'feeds', 'a.sql'), FEED_A);
  writeFileSync(join(root, 'sql', 'feeds', 'b.sql'), FEED_B);
  writeFileSync(join(root, 'sql', 'feeds.json'), JSON.stringify({
    feeds: [
      { feed: 'fa', tab: 'A', sqlFile: 'sql/feeds/a.sql', pageLimit, columns: [{ sql: 'V', header: 'V', type: 'string' }] },
      { feed: 'fb', tab: 'B', sqlFile: 'sql/feeds/b.sql', pageLimit: 2, columns: [{ sql: 'W', header: 'W', type: 'string' }] },
    ],
  }));
  return root;
}

function resultText(columns, rows, numRows = rows.length) {
  return JSON.stringify({
    result_set: {
      data: rows,
      resultSetMetaData: { numRows, rowType: columns.map((name) => ({ name })) },
    },
  });
}

const counters = new Map();
function cap(root, runId, sql, response, extra = {}) {
  const k = root + runId;
  const n = (counters.get(k) ?? 0) + 1;
  counters.set(k, n);
  const dir = join(root, 'runs', runId, 'captures');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${String(n).padStart(4, '0')}.json`),
    JSON.stringify({ seq: n, capturedAt: new Date().toISOString(), sql, response, ...extra }));
}

const sqlOf = (out) => {
  assert.ok(out.startsWith('RUN_SQL\n'), `expected RUN_SQL, got: ${out}`);
  return out.slice('RUN_SQL\n'.length);
};
const stateOf = (root, runId) => JSON.parse(readFileSync(join(root, 'runs', runId, 'state.json'), 'utf8'));

const healthResp = (year = 2027, problems = 0, list = null) =>
  resultText(['BASE_YEAR', 'PROBLEM_COUNT', 'PROBLEM_LIST', 'REFRESHED_AT_SC_EMS_PART', 'REFRESHED_AT_COMPONENT_WHERE_USED'],
    [[String(year), String(problems), list, '2027-01-01', '2027-01-02']]);
const countResp = (rc, kc) => resultText(['ROW_COUNT', 'KEY_COUNT'], [[String(rc), String(kc)]]);
const pageResp = (rows, numRows) => resultText(['ROW_KEY', 'V'], rows, numRows);

function start(root) {
  const out = begin({ root, now: new Date('2026-10-30T10:15:30Z') });
  const runId = readFileSync(join(root, 'runs', 'CURRENT'), 'utf8').trim();
  return { out, runId };
}

test('begin: Berlin run id, CURRENT, health SQL', () => {
  const root = makeRoot();
  const { out, runId } = start(root);
  assert.equal(runId, '2026-10-30T11-15-30');
  assert.equal(sqlOf(out), 'SELECT 1 AS BASE_YEAR');
  const st = stateOf(root, runId);
  assert.equal(st.phase, 'health');
  assert.equal(st.pendingSql, 'SELECT 1 AS BASE_YEAR');
});

test('begin: summer time uses Berlin offset', () => {
  const root = makeRoot();
  begin({ root, now: new Date('2026-07-01T22:30:00Z') });
  assert.equal(readFileSync(join(root, 'runs', 'CURRENT'), 'utf8').trim(), '2026-07-02T00-30-00');
});

test('happy path across 2 feeds, base year from health', () => {
  const root = makeRoot();
  const { out, runId } = start(root);
  let sql = sqlOf(out);
  cap(root, runId, sql, healthResp(2027));
  sql = sqlOf(next({ root }));
  assert.match(sql, /COUNT\(\*\) AS ROW_COUNT/);
  assert.match(sql, /Y = 2027/);

  cap(root, runId, sql, countResp(3, 3));
  sql = sqlOf(next({ root }));
  assert.match(sql, /LIMIT 2$/);
  assert.doesNotMatch(sql, /WHERE ROW_KEY >/);

  cap(root, runId, sql, pageResp([['k1', 'a'], ['k2', 'b']]));
  sql = sqlOf(next({ root }));
  assert.match(sql, /WHERE ROW_KEY > 'k2'/);

  cap(root, runId, sql, pageResp([['k3', 'c']]));
  sql = sqlOf(next({ root }));
  assert.match(sql, /ROW_COUNT/);
  assert.match(sql, /FROM u WHERE Y = 2027/);

  cap(root, runId, sql, countResp(1, 1));
  sql = sqlOf(next({ root }));
  cap(root, runId, sql, pageResp([['z', 'x']]));
  assert.equal(next({ root }), 'FETCHED');

  const st = stateOf(root, runId);
  assert.equal(st.phase, 'fetched');
  assert.equal(st.baseYear, 2027);
  assert.equal(st.health.BASE_YEAR, '2027');
  assert.equal(st.health.REFRESHED_AT_SC_EMS_PART, '2027-01-01');
  assert.equal(st.pages.length, 1); // pages are per feed
});

test('truncated page at minimum size aborts instead of looping', () => {
  const root = makeRoot();
  const { out, runId } = start(root);
  cap(root, runId, sqlOf(out), healthResp());
  let sql = sqlOf(next({ root }));
  cap(root, runId, sql, countResp(2, 2));
  sql = sqlOf(next({ root }));
  // limit 2 is below the minimum of 100, so truncation can only abort
  cap(root, runId, sql, pageResp([['k1', 'a']], 2));
  assert.equal(next({ root }), 'ABORT fa: page truncated at minimum size');
});

test('truncated page above minimum: same afterKey, smaller LIMIT, rows not stored', () => {
  const root = makeRoot(1000);
  const { out, runId } = start(root);
  cap(root, runId, sqlOf(out), healthResp());
  let sql = sqlOf(next({ root }));
  cap(root, runId, sql, countResp(5, 5));
  sql = sqlOf(next({ root }));
  assert.match(sql, /LIMIT 1000$/);
  cap(root, runId, sql, pageResp([['k1', 'a'], ['k2', 'b']], 1000));
  const sql2 = sqlOf(next({ root }));
  assert.equal(sql2.replace(/LIMIT \d+$/, ''), sql.replace(/LIMIT \d+$/, ''));
  const lim = Number(/LIMIT (\d+)$/.exec(sql2)[1]);
  assert.ok(lim < 1000 && lim >= 100);
  const st = stateOf(root, runId);
  assert.equal(st.pages.length, 0);
  assert.equal(st.afterKey, null);
});

test('row count mismatch aborts', () => {
  const root = makeRoot();
  const { out, runId } = start(root);
  cap(root, runId, sqlOf(out), healthResp());
  let sql = sqlOf(next({ root }));
  cap(root, runId, sql, countResp(10, 10));
  sql = sqlOf(next({ root }));
  cap(root, runId, sql, pageResp([['k1', 'a'], ['k2', 'b']]));
  sql = sqlOf(next({ root }));
  cap(root, runId, sql, pageResp([['k3', 'a']]));
  assert.equal(next({ root }), 'ABORT fa: expected 10 rows, fetched 3');
});

test('duplicate ROW_KEY aborts', () => {
  const root = makeRoot();
  const { out, runId } = start(root);
  cap(root, runId, sqlOf(out), healthResp());
  const sql = sqlOf(next({ root }));
  cap(root, runId, sql, countResp(5, 4));
  assert.equal(next({ root }), 'ABORT fa: duplicate ROW_KEY');
});

test('capture SQL differs from pending aborts', () => {
  const root = makeRoot();
  const { runId } = start(root);
  cap(root, runId, 'SELECT something else', healthResp());
  assert.equal(next({ root }), 'ABORT expected result of the pending SQL');
});

test('no capture aborts; same capture is not consumed twice', () => {
  const root = makeRoot();
  start(root);
  assert.equal(next({ root }), 'ABORT expected result of the pending SQL');

  const root2 = makeRoot();
  const s2 = start(root2);
  cap(root2, s2.runId, sqlOf(s2.out), healthResp());
  assert.match(next({ root: root2 }), /^RUN_SQL/);
  assert.equal(next({ root: root2 }), 'ABORT expected result of the pending SQL');
});

test('health problems abort', () => {
  const root = makeRoot();
  const { out, runId } = start(root);
  cap(root, runId, sqlOf(out), healthResp(2027, 2, 'A/B (red), C/D (red)'));
  assert.equal(next({ root }), 'ABORT platform health: A/B (red), C/D (red)');
});

test('unrecognized capture aborts', () => {
  const root = makeRoot();
  const { out, runId } = start(root);
  cap(root, runId, sqlOf(out), 'garbage', { shape: 'unrecognized' });
  assert.equal(next({ root }), 'ABORT unrecognized connector result');
});

test('unparseable response aborts as unrecognized', () => {
  const root = makeRoot();
  const { out, runId } = start(root);
  cap(root, runId, sqlOf(out), 'not json');
  assert.equal(next({ root }), 'ABORT unrecognized connector result');
});
