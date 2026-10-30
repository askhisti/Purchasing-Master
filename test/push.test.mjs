import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chunkRows, postJson } from '../refresh/lib/push.mjs';
import { finish, fail } from '../refresh/cli.mjs';

const decode = (b64) => JSON.parse(zlib.gunzipSync(Buffer.from(b64, 'base64')).toString('utf8'));

function server(handler) {
  return new Promise((resolve) => {
    const requests = [];
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body);
        requests.push({ body: parsed, contentType: req.headers['content-type'] });
        const out = handler(parsed, requests.length);
        res.statusCode = out.status ?? 200;
        res.end(JSON.stringify(out.json ?? { ok: true }));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${srv.address().port}/`, requests, close: () => srv.close() }));
  });
}

test('chunkRows respects maxBytes and round-trips', () => {
  const rows = Array.from({ length: 2000 }, (_, i) => [`id${i}`, Math.random(), `${'x'.repeat(20)}${Math.random()}`, null]);
  const chunks = chunkRows(rows, 5000);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 5000);
  assert.deepEqual(chunks.flatMap(decode), rows);
  assert.deepEqual(chunkRows([], 5000), []);
});

test('postJson retries a 503 then succeeds', async () => {
  const s = await server((_, n) => (n === 1 ? { status: 503, json: { ok: false } } : { json: { ok: true, v: 1 } }));
  const sleeps = [];
  const r = await postJson(s.url, { a: 1 }, { sleep: async (ms) => sleeps.push(ms) });
  s.close();
  assert.equal(r.v, 1);
  assert.equal(s.requests.length, 2);
  assert.deepEqual(sleeps, [5000]);
  assert.match(s.requests[0].contentType, /^text\/plain;charset=utf-8$/);
});

test('postJson throws the error of {ok:false} without retrying', async () => {
  const s = await server(() => ({ json: { ok: false, error: 'x' } }));
  await assert.rejects(postJson(s.url, {}, { sleep: async () => {} }), /^Error: x$/);
  s.close();
  assert.equal(s.requests.length, 1);
});

test('postJson gives up after 3 attempts', async () => {
  const s = await server(() => ({ status: 500 }));
  await assert.rejects(postJson(s.url, {}, { sleep: async () => {} }), /HTTP 500/);
  s.close();
  assert.equal(s.requests.length, 3);
});

const RUN_ID = '2026-10-30T02-00-00';

function makeRun({ dupKey = false, rowCountOff = 0 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pm-fin-'));
  mkdirSync(join(root, 'sql'), { recursive: true });
  mkdirSync(join(root, 'runs', RUN_ID, 'captures'), { recursive: true });
  writeFileSync(join(root, 'runs', 'CURRENT'), RUN_ID);
  writeFileSync(join(root, 'sql', 'feeds.json'), JSON.stringify({
    feeds: [
      { feed: 'fa', tab: 'A', columns: [{ sql: 'V', header: 'V', type: 'string' }, { sql: 'N', header: 'N', type: 'number' }] },
      { feed: 'fb', tab: 'B', columns: [{ sql: 'W', header: 'W', type: 'string' }] },
    ],
  }));
  const cap = (n, rows, cols) => writeFileSync(join(root, 'runs', RUN_ID, 'captures', `000${n}.json`), JSON.stringify({
    seq: n, capturedAt: 'x', sql: 's',
    response: JSON.stringify({ result_set: { data: rows, resultSetMetaData: { numRows: rows.length, rowType: cols.map((name) => ({ name })) } } }),
  }));
  cap(1, [['k1', '0402', '1.50'], ['k2', '1E3', '']], ['ROW_KEY', 'V', 'N']);
  cap(2, [[dupKey ? 'k1' : 'k3', 'z', '2']], ['ROW_KEY', 'V', 'N']);
  cap(3, [], ['ROW_KEY', 'W']);
  const state = {
    runId: RUN_ID, phase: 'fetched', baseYear: 2027, health: { BASE_YEAR: 2027, PROBLEM_COUNT: 0 },
    done: [
      { feed: 'fa', expected: { rowCount: 3 + rowCountOff, keyCount: 3 + rowCountOff }, pages: [
        { captureSeq: 1, rows: 2, firstKey: 'k1', lastKey: 'k2' }, { captureSeq: 2, rows: 1, firstKey: 'k3', lastKey: 'k3' }] },
      { feed: 'fb', expected: { rowCount: 0, keyCount: 0 }, pages: [] },
    ],
  };
  writeFileSync(join(root, 'runs', RUN_ID, 'state.json'), JSON.stringify(state));
  return root;
}
const stateOf = (root) => JSON.parse(readFileSync(join(root, 'runs', RUN_ID, 'state.json'), 'utf8'));
const envOf = (s) => ({ MASTERDATA_WEBAPP_URL: s.url, MASTERDATA_TOKEN: 'tok' });

test('finish sends begin, chunks in seq order, commit', async () => {
  const root = makeRun();
  const s = await server((b) => (b.action === 'commit' ? { json: { ok: true, feeds: [] } } : {}));
  const out = await finish({ root, env: envOf(s), sleep: async () => {} });
  s.close();
  assert.equal(out, 'DONE fa=3 fb=0');
  assert.deepEqual(s.requests.map((r) => r.body.action), ['begin', 'chunk', 'commit']);
  assert.ok(s.requests.every((r) => r.body.token === 'tok'));
  const begin = s.requests[0].body;
  assert.deepEqual(begin.feeds.map((x) => [x.feed, x.tab, x.rowCount]), [['fa', 'A', 3], ['fb', 'B', 0]]);
  assert.deepEqual(begin.feeds[0].types, ['string', 'number']);
  assert.equal(s.requests[1].body.seq, 1);
  assert.deepEqual(decode(s.requests[1].body.rowsB64Gzip), [['0402', 1.5], ['1E3', null], ['z', 2]]);
  assert.equal(stateOf(root).phase, 'pushed');
  assert.ok(!existsSync(join(root, 'runs', 'CURRENT')));
});

test('finish prints warning from commit', async () => {
  const root = makeRun();
  const s = await server((b) => (b.action === 'commit' ? { json: { ok: true, warning: 'w1' } } : {}));
  const out = await finish({ root, env: envOf(s), sleep: async () => {} });
  s.close();
  assert.equal(out, 'DONE fa=3 fb=0 WARNING w1');
});

test('finish: commit failure posts fail and prints FAILED', async () => {
  const root = makeRun();
  const s = await server((b) => (b.action === 'commit' ? { json: { ok: false, error: 'boom' } } : {}));
  const out = await finish({ root, env: envOf(s), sleep: async () => {} });
  s.close();
  assert.equal(out, 'FAILED boom');
  const last = s.requests.at(-1).body;
  assert.equal(last.action, 'fail');
  assert.equal(last.reason, 'boom');
  assert.equal(stateOf(root).phase, 'failed');
  assert.ok(!existsSync(join(root, 'runs', 'CURRENT')));
});

test('finish: duplicate keys and count mismatch fail before begin', async () => {
  for (const [opts, re] of [[{ dupKey: true }, /duplicate ROW_KEY/], [{ rowCountOff: 1 }, /expected 4/]]) {
    const root = makeRun(opts);
    const s = await server(() => ({}));
    const out = await finish({ root, env: envOf(s), sleep: async () => {} });
    s.close();
    assert.match(out, re);
    assert.ok(out.startsWith('FAILED'));
    assert.deepEqual(s.requests.map((r) => r.body.action), ['fail']);
  }
});

test('finish: missing env sends nothing; wrong phase refused', async () => {
  const root = makeRun();
  assert.equal(await finish({ root, env: {} }), 'FAILED missing MASTERDATA_WEBAPP_URL or MASTERDATA_TOKEN');
  const st = stateOf(root);
  st.phase = 'feeds';
  writeFileSync(join(root, 'runs', RUN_ID, 'state.json'), JSON.stringify(st));
  const s = await server(() => ({}));
  assert.equal(await finish({ root, env: envOf(s) }), 'FAILED run is not fetched (phase feeds)');
  s.close();
  assert.equal(s.requests.length, 0);
});

test('fail posts reason and prints FAILED', async () => {
  const root = makeRun();
  const s = await server(() => ({}));
  const out = await fail({ root, reason: 'sf down', env: envOf(s) });
  s.close();
  assert.equal(out, 'FAILED sf down');
  assert.deepEqual(s.requests[0].body, { token: 'tok', action: 'fail', runId: RUN_ID, reason: 'sf down' });
  assert.equal(stateOf(root).phase, 'failed');
});
