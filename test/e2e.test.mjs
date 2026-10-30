// End-to-end: begin/next through a whole fake run with the REAL sql/feeds.json and SQL files, then
// finish against the vm-loaded Apps Script web app (gas-fakes) through a fetch shim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { begin, next, finish } from '../refresh/cli.mjs';
import { loadManifest, sqlColumnsFor, headersFor } from '../refresh/lib/manifest.mjs';
import { makeEnv } from './helpers/gas-fakes.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const TOKEN = 'e'.repeat(64);
const NOW = new Date('2026-10-30T06:00:03.000Z'); // 07:00:03 Berlin (CET)
const RUN_ID = '2026-10-30T07-00-03';
const BASE_YEAR = 2026;
const ROWS_PER_FEED = { components: 3, multisource: 1, multisource_members: 2, component_usage: 3, products: 2, mecl_price: 1 };
const TABS = ['Components', 'Multisource', 'Multisource_Members', 'Component_Usage', 'Products', 'MECL_Price'];

const resultText = (columns, rows) => JSON.stringify({
  query_id: 'q',
  result_set: { data: rows, resultSetMetaData: { format: 'jsonv2', numRows: rows.length, rowType: columns.map((name) => ({ name, type: 'text', nullable: true })) } },
});

// Raw connector values (all strings, as the Snowflake JSON v2 result returns them) and the
// value expected in the sheet for each.
function cell(feed, col, i) {
  if (feed.feed === 'components' && col.sql === 'MPN') return ['0402', '1E3', 'MAR-12, "x"'][i];
  if (col.sql === 'ME_EC') return `ME_EC_000000${i + 1}`;
  switch (col.type) {
    case 'number': return String((i + 1) * 1.5);
    case 'boolean': return i % 2 === 0 ? 'true' : 'false';
    case 'date': return col.sql === 'CREATED_AT' ? '2026-10-01 08:15:00.000' : '2027-01-15';
    default: return `${col.sql.toLowerCase()} ${i}`;
  }
}
function expected(type, raw) {
  if (raw === null || raw === '') return '';
  if (type === 'number') return Number(raw);
  if (type === 'boolean') return raw === 'true';
  if (type === 'date') return raw.slice(0, 10);
  return raw;
}

function fixture(feed) {
  const n = ROWS_PER_FEED[feed.feed];
  const columns = ['ROW_KEY', ...sqlColumnsFor(feed)];
  const raw = [];
  const sheet = [];
  for (let i = 0; i < n; i++) {
    const r = [`${feed.feed}-${String(i).padStart(3, '0')}`];
    const s = [];
    for (const col of feed.columns) {
      const v = cell(feed, col, i);
      r.push(v);
      s.push(expected(col.type, v));
    }
    if (feed.demandYears) {
      for (let k = 0; k < feed.demandYears.count; k++) {
        // An empty demand ('' and null) on the first row, numbers elsewhere.
        const v = i === 0 && k === 0 ? '' : i === 0 && k === 1 ? null : String(1000 * (k + 1) + i);
        r.push(v);
        s.push(expected('number', v));
      }
    }
    raw.push(r);
    sheet.push(s);
  }
  return { columns, raw, sheet };
}

test('e2e: begin/next over the real manifest, then finish into the Apps Script web app', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pm-e2e-'));
  cpSync(join(repo, 'sql'), join(root, 'sql'), { recursive: true });
  const manifest = loadManifest(join(root, 'sql', 'feeds.json'));
  assert.equal(manifest.feeds.length, 6);
  const fixtures = Object.fromEntries(manifest.feeds.map((f) => [f.feed, fixture(f)]));

  let out = begin({ root, now: NOW });
  assert.equal(readFileSync(join(root, 'runs', 'CURRENT'), 'utf8').trim(), RUN_ID);
  const capDir = join(root, 'runs', RUN_ID, 'captures');
  mkdirSync(capDir, { recursive: true });
  let seq = 0;
  const kinds = [];
  for (let guard = 0; out !== 'FETCHED'; guard++) {
    assert.ok(guard < 50, 'run does not converge');
    assert.ok(out.startsWith('RUN_SQL\n'), `unexpected CLI output: ${out}`);
    const sql = out.slice('RUN_SQL\n'.length);
    const state = JSON.parse(readFileSync(join(root, 'runs', RUN_ID, 'state.json'), 'utf8'));
    let response;
    if (state.phase === 'health') {
      assert.equal(sql, readFileSync(join(root, 'sql', 'health.sql'), 'utf8').trimEnd());
      kinds.push('health');
      response = resultText(['BASE_YEAR', 'PROBLEM_COUNT', 'PROBLEM_LIST', 'REFRESHED_AT_SC_EMS_PART', 'REFRESHED_AT_COMPONENT_WHERE_USED'],
        [[String(BASE_YEAR), '0', null, '2026-10-30 04:10:00.000', '2026-10-30 05:45:00.000']]);
    } else {
      const feed = manifest.feeds[state.feedIndex];
      const fx = fixtures[feed.feed];
      assert.ok(!sql.includes('{{'), 'placeholders rendered');
      if (state.step === 'count') {
        kinds.push(`count:${feed.feed}`);
        response = resultText(['ROW_COUNT', 'KEY_COUNT'], [[String(fx.raw.length), String(fx.raw.length)]]);
      } else {
        kinds.push(`page:${feed.feed}`);
        assert.match(sql, /ORDER BY ROW_KEY LIMIT 500$/);
        response = resultText(fx.columns, fx.raw);
      }
    }
    seq += 1;
    writeFileSync(join(capDir, `${String(seq).padStart(4, '0')}.json`),
      JSON.stringify({ seq, capturedAt: new Date().toISOString(), sql, response }));
    out = next({ root });
  }
  assert.deepEqual(kinds, ['health', ...manifest.feeds.flatMap((f) => [`count:${f.feed}`, `page:${f.feed}`])]);

  // finish -> doPost of the vm-loaded web app.
  const gas = makeEnv({ props: { REFRESH_TOKEN: TOKEN } });
  gas.ss.locale = 'de_DE';
  const actions = [];
  const fetchImpl = async (url, init) => {
    actions.push(JSON.parse(init.body).action);
    const text = gas.context.doPost({ postData: { contents: init.body } }).getContent();
    return { status: 200, text: async () => text };
  };
  const res = await finish({
    root,
    env: { MASTERDATA_WEBAPP_URL: 'https://script.invalid/exec', MASTERDATA_TOKEN: TOKEN },
    fetchImpl,
    sleep: async () => {},
  });
  const counts = manifest.feeds.map((f) => `${f.feed}=${ROWS_PER_FEED[f.feed]}`).join(' ');
  assert.equal(res, `DONE ${counts}`);
  assert.deepEqual(actions, ['begin', ...manifest.feeds.filter((f) => ROWS_PER_FEED[f.feed]).map(() => 'chunk'), 'commit']);

  // Live tabs: expected headers and rows, in TABS order, no staging left.
  assert.deepEqual(gas.ss.names(), [...TABS, '_Refresh_Log']);
  for (const f of manifest.feeds) {
    const sheet = gas.ss.getSheetByName(f.tab);
    assert.deepEqual(sheet.data(), [headersFor(f, BASE_YEAR), ...fixtures[f.feed].sheet], f.feed);
    assert.equal(sheet.isSheetHidden(), false);
  }
  const comp = gas.ss.getSheetByName('Components');
  const mpnCol = headersFor(manifest.feeds[0], BASE_YEAR).indexOf('MPN') + 1;
  assert.equal(comp.getCell(2, mpnCol), '0402');
  assert.equal(typeof comp.getCell(2, mpnCol), 'string');
  assert.equal(comp.getCell(3, mpnCol), '1E3');
  assert.equal(comp.getFormat(2, mpnCol), '@', 'text format keeps the leading zero');
  assert.equal(gas.ss.getSpreadsheetLocale(), 'en_US');

  // Raw snapshots: six CSVs with header + rows.
  const day = gas.drive.root.folder('Raw snapshots').folder('2026-10-30');
  assert.deepEqual(day.fileNames(), manifest.feeds.map((f) => `${f.feed}.csv`).sort());
  for (const f of manifest.feeds) {
    const lines = day.file(`${f.feed}.csv`).getBlob().getDataAsString().trimEnd().split('\n');
    assert.equal(lines.length, 1 + ROWS_PER_FEED[f.feed], f.feed);
  }
  assert.match(day.file('components.csv').getBlob().getDataAsString(), /,0402,/);

  // _Refresh_Log: one OK row per feed, Started = CLI run start in Berlin time; B1 ISO UTC.
  const log = gas.ss.getSheetByName('_Refresh_Log').data();
  assert.match(log[0][1], /Z$/);
  assert.equal(log[1][1], BASE_YEAR);
  assert.deepEqual(log.slice(4).map((r) => [r[0], r[1], r[3], r[4], r[6]]),
    manifest.feeds.map((f) => [RUN_ID, '2026-10-30 07:00:03', f.feed, ROWS_PER_FEED[f.feed], 'OK']));

  // CLI run closed.
  assert.equal(JSON.parse(readFileSync(join(root, 'runs', RUN_ID, 'state.json'), 'utf8')).phase, 'pushed');
  assert.ok(!existsSync(join(root, 'runs', 'CURRENT')));
  assert.equal(gas.stored.ACTIVE_RUN, undefined);
});
