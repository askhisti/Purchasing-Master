// End-to-end: begin/next through a whole fake run with the REAL sql/feeds.json and SQL files, then
// finish against a fake Google (token endpoint + Drive uploads) through an injected fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { begin, next, finish } from '../refresh/cli.mjs';
import { loadManifest, sqlColumnsFor, headersFor, demandYearsFor, demandMonthsFor } from '../refresh/lib/manifest.mjs';
import { fakeGoogle, KEY_JSON } from './helpers/sa-key.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const NOW = new Date('2026-10-30T06:00:03.000Z'); // 07:00:03 Berlin (CET)
const RUN_ID = '2026-10-30T07-00-03';
const BASE_YEAR = 2026;
const ROWS_PER_FEED = { components: 3, multisource: 1, multisource_members: 2, component_usage: 3, products: 2, mecl_price: 1, product_volumes: 2, component_demand_monthly: 2, bom_demand_monthly: 2, bom_sources: 2, price_at_demand: 2, savings_levers: 2, quote_health: 2, multisource_health: 2, bom_coverage: 2 };

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
  const columns = ['ROW_KEY', ...sqlColumnsFor(feed, BASE_YEAR)];
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
      for (let k = 0; k < demandYearsFor(feed, BASE_YEAR).length; k++) {
        // An empty demand ('' and null) on the first row, numbers elsewhere.
        const v = i === 0 && k === 0 ? '' : i === 0 && k === 1 ? null : String(1000 * (k + 1) + i);
        r.push(v);
        s.push(expected('number', v));
      }
    }
    if (feed.demandMonths) {
      for (let k = 0; k < demandMonthsFor(feed, BASE_YEAR).length; k++) {
        const v = String(10 * (k + 1) + i);
        r.push(v);
        s.push(expected('number', v));
      }
    }
    raw.push(r);
    sheet.push(s);
  }
  return { columns, raw, sheet };
}

test('e2e: begin/next over the real manifest, then finish into the Drive Inbox', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pm-e2e-'));
  cpSync(join(repo, 'sql'), join(root, 'sql'), { recursive: true });
  const manifest = loadManifest(join(root, 'sql', 'feeds.json'));
  assert.equal(manifest.feeds.length, loadManifest().feeds.length);
  for (const name of ['components', 'multisource', 'multisource_members', 'component_usage', 'products', 'mecl_price']) {
    assert.ok(manifest.feeds.some((f) => f.feed === name), `feed ${name} missing`);
  }
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
        assert.match(sql, new RegExp(`ORDER BY ROW_KEY LIMIT ${feed.pageLimit}$`));
        response = resultText(fx.columns, fx.raw);
      }
    }
    seq += 1;
    writeFileSync(join(capDir, `${String(seq).padStart(4, '0')}.json`),
      JSON.stringify({ seq, capturedAt: new Date().toISOString(), sql, response }));
    out = next({ root });
  }
  assert.deepEqual(kinds, ['health', ...manifest.feeds.flatMap((f) => [`count:${f.feed}`, `page:${f.feed}`])]);

  // finish -> Drive Inbox through a fake fetch.
  const g = fakeGoogle();
  const res = await finish({
    root,
    env: { MASTERDATA_SA_KEY: KEY_JSON, MASTERDATA_INBOX_ID: 'INBOX' },
    fetchImpl: g.fetchImpl,
    sleep: async () => {},
    now: () => NOW.getTime(),
  });
  const counts = manifest.feeds.map((f) => `${f.feed}=${ROWS_PER_FEED[f.feed]}`).join(' ');
  assert.equal(res, `DONE uploaded ${RUN_ID} ${counts}`);

  // One token request, then data files in manifest order and the manifest last.
  assert.equal(g.calls[0].url, 'https://oauth2.googleapis.com/token');
  assert.equal(g.calls.filter((c) => !c.upload).length, 1);
  const ups = g.uploads();
  assert.deepEqual(ups.map((u) => u.meta.name), [...manifest.feeds.map((f) => `${RUN_ID}__${f.feed}.json.gz`), `${RUN_ID}__manifest.json`]);
  assert.ok(ups.every((u) => u.meta.parents[0] === 'INBOX' && u.url.includes('supportsAllDrives=true')));

  const m = JSON.parse(ups.at(-1).media.toString('utf8'));
  assert.deepEqual([m.version, m.runId, m.status, m.baseYear, m.startedAt, m.publishedAt], [1, RUN_ID, 'ready', BASE_YEAR, NOW.toISOString(), NOW.toISOString()]);
  assert.equal(Number(m.health.BASE_YEAR), BASE_YEAR);
  assert.equal(m.feeds.length, manifest.feeds.length);
  manifest.feeds.forEach((f, i) => {
    const entry = m.feeds[i];
    const gz = ups[i].media;
    assert.equal(entry.feed, f.feed);
    assert.equal(entry.tab, f.tab);
    assert.deepEqual(entry.headers, headersFor(f, BASE_YEAR));
    assert.equal(entry.rowCount, ROWS_PER_FEED[f.feed]);
    assert.equal(entry.file, `${RUN_ID}__${f.feed}.json.gz`);
    assert.equal(entry.sha256, createHash('sha256').update(gz).digest('hex'));
    assert.deepEqual(JSON.parse(gunzipSync(gz).toString('utf8')), fixtures[f.feed].sheet.map((r) => r.map((v) => (v === '' ? null : v))), f.feed); // shaped rows carry null for empty cells
  });
  const comp = JSON.parse(gunzipSync(ups[0].media).toString('utf8'));
  const mpnCol = headersFor(manifest.feeds[0], BASE_YEAR).indexOf('MPN');
  assert.equal(comp[0][mpnCol], '0402');
  assert.equal(typeof comp[0][mpnCol], 'string');
  assert.equal(comp[1][mpnCol], '1E3');

  // CLI run closed.
  assert.equal(JSON.parse(readFileSync(join(root, 'runs', RUN_ID, 'state.json'), 'utf8')).phase, 'uploaded');
  assert.ok(!existsSync(join(root, 'runs', 'CURRENT')));
});
