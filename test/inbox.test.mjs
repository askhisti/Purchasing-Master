import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPayload, uploadToInbox } from '../refresh/lib/inbox.mjs';
import { finish, fail } from '../refresh/cli.mjs';
import { KEY_JSON, KEY_MARKER, ACCESS_TOKEN, fakeGoogle } from './helpers/sa-key.mjs';

const RUN_ID = '2026-10-30T02-00-00';
const FOLDER = 'FOLDER123';
const gunzip = (buf) => JSON.parse(zlib.gunzipSync(buf).toString('utf8'));

const state = { runId: RUN_ID, startedAt: '2026-10-30T01:00:00.000Z', baseYear: 2027, health: { BASE_YEAR: 2027 } };
const prepared = [
  { feedDef: { feed: 'fa', tab: 'A' }, headers: ['V', 'N'], types: ['string', 'number'], rows: [['0402', 1.5], ['1E3', null]] },
  { feedDef: { feed: 'fb', tab: 'B' }, headers: ['W'], types: ['string'], rows: [] },
];

test('buildPayload: data files first, manifest last, sha256 over the gz bytes', () => {
  const { manifest, files } = buildPayload(state, prepared, { publishedAt: '2026-10-30T02:05:00.000Z' });
  assert.deepEqual(files.map((f) => f.name), [`${RUN_ID}__fa.json.gz`, `${RUN_ID}__fb.json.gz`, `${RUN_ID}__manifest.json`]);
  assert.deepEqual(files.map((f) => f.mimeType), ['application/gzip', 'application/gzip', 'application/json']);
  assert.deepEqual(gunzip(files[0].bytes), [['0402', 1.5], ['1E3', null]]);
  assert.deepEqual(JSON.parse(files[2].bytes.toString('utf8')), manifest);
  assert.deepEqual(manifest, {
    version: 1, runId: RUN_ID, status: 'ready', baseYear: 2027, startedAt: state.startedAt, publishedAt: '2026-10-30T02:05:00.000Z',
    health: state.health,
    feeds: [
      { feed: 'fa', tab: 'A', headers: ['V', 'N'], types: ['string', 'number'], rowCount: 2, file: `${RUN_ID}__fa.json.gz`, sha256: crypto.createHash('sha256').update(files[0].bytes).digest('hex') },
      { feed: 'fb', tab: 'B', headers: ['W'], types: ['string'], rowCount: 0, file: `${RUN_ID}__fb.json.gz`, sha256: crypto.createHash('sha256').update(files[1].bytes).digest('hex') },
    ],
  });
});

test('buildPayload: failed manifest has a reason, no feeds and no data files', () => {
  const { manifest, files } = buildPayload(state, [], { status: 'failed', reason: 'sf down', publishedAt: 'T' });
  assert.equal(manifest.status, 'failed');
  assert.equal(manifest.reason, 'sf down');
  assert.deepEqual(manifest.feeds, []);
  assert.deepEqual(files.map((f) => f.name), [`${RUN_ID}__manifest.json`]);
});

test('uploadToInbox: one multipart upload per file, in order, shared-drive flag, folder parent, bearer token', async () => {
  const g = fakeGoogle();
  const { files } = buildPayload(state, prepared);
  const { ids } = await uploadToInbox({ folderId: FOLDER, files, token: ACCESS_TOKEN, fetchImpl: g.fetchImpl, sleep: async () => {} });
  assert.deepEqual(ids, ['id-1', 'id-2', 'id-3']);
  const ups = g.uploads();
  assert.deepEqual(ups.map((u) => u.meta.name), files.map((f) => f.name));
  for (const u of ups) {
    assert.equal(u.url, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true');
    assert.match(u.contentType, /^multipart\/related; boundary=/);
    assert.deepEqual(u.meta.parents, [FOLDER]);
    assert.equal(u.authorization, `Bearer ${ACCESS_TOKEN}`);
  }
  assert.deepEqual(ups.map((u) => u.meta.mimeType), ['application/gzip', 'application/gzip', 'application/json']);
  assert.ok(ups[0].media.equals(files[0].bytes), 'gzip bytes survive the multipart body unchanged');
});

test('uploadToInbox: 5xx and network errors retry (5 s, 20 s) up to 3 attempts; 4xx does not', async () => {
  let g = fakeGoogle({ uploadStatus: (_, n) => (n === 1 ? 503 : n === 2 ? 'throw' : 200) });
  const sleeps = [];
  const { files } = buildPayload(state, []);
  await uploadToInbox({ folderId: FOLDER, files, token: 't', fetchImpl: g.fetchImpl, sleep: async (ms) => sleeps.push(ms) });
  assert.deepEqual(sleeps, [5000, 20000]);
  assert.equal(g.uploads().length, 3);

  g = fakeGoogle({ uploadStatus: () => 500 });
  await assert.rejects(uploadToInbox({ folderId: FOLDER, files, token: 't', fetchImpl: g.fetchImpl, sleep: async () => {} }), /HTTP 500.*drive says 500/);
  assert.equal(g.uploads().length, 3);

  g = fakeGoogle({ uploadStatus: () => 403 });
  await assert.rejects(uploadToInbox({ folderId: FOLDER, files, token: 'SECRETTOKEN', fetchImpl: g.fetchImpl, sleep: async () => {} }),
    (e) => /HTTP 403.*drive says 403/.test(e.message) && !e.message.includes('SECRETTOKEN'));
  assert.equal(g.uploads().length, 1);
});

test('uploadToInbox: a data file over 5 MB fails clearly before anything is uploaded', async () => {
  const g = fakeGoogle();
  const files = [
    { name: 'a.json.gz', bytes: Buffer.alloc(10), mimeType: 'application/gzip' },
    { name: 'big.json.gz', bytes: Buffer.alloc(5 * 1024 * 1024 + 1), mimeType: 'application/gzip' },
  ];
  await assert.rejects(uploadToInbox({ folderId: FOLDER, files, token: 't', fetchImpl: g.fetchImpl, sleep: async () => {} }), /big\.json\.gz.*5 MB/);
  assert.equal(g.calls.length, 0);
});

// ---- finish / fail ----

function makeRun({ dupKey = false } = {}) {
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
  writeFileSync(join(root, 'runs', RUN_ID, 'state.json'), JSON.stringify({
    runId: RUN_ID, startedAt: '2026-10-30T01:00:00.000Z', phase: 'fetched', baseYear: 2027, health: { BASE_YEAR: 2027, PROBLEM_COUNT: 0 },
    done: [
      { feed: 'fa', expected: { rowCount: 3, keyCount: 3 }, pages: [{ captureSeq: 1, rows: 2, firstKey: 'k1', lastKey: 'k2' }, { captureSeq: 2, rows: 1, firstKey: 'k3', lastKey: 'k3' }] },
      { feed: 'fb', expected: { rowCount: 0, keyCount: 0 }, pages: [] },
    ],
  }));
  return root;
}
const stateOf = (root) => JSON.parse(readFileSync(join(root, 'runs', RUN_ID, 'state.json'), 'utf8'));
const env = { MASTERDATA_SA_KEY: KEY_JSON, MASTERDATA_INBOX_ID: FOLDER };
const opts = (g) => ({ fetchImpl: g.fetchImpl, sleep: async () => {}, now: () => Date.parse('2026-10-30T02:05:00Z') });

test('finish happy path: uploads data files then manifest, prints DONE uploaded, phase uploaded, CURRENT removed', async () => {
  const root = makeRun();
  const g = fakeGoogle();
  const out = await finish({ root, env, ...opts(g) });
  assert.equal(out, `DONE uploaded ${RUN_ID} fa=3 fb=0`);
  const ups = g.uploads();
  assert.deepEqual(ups.map((u) => u.meta.name), [`${RUN_ID}__fa.json.gz`, `${RUN_ID}__fb.json.gz`, `${RUN_ID}__manifest.json`]);
  assert.deepEqual(gunzip(ups[0].media), [['0402', 1.5], ['1E3', null], ['z', 2]]);
  assert.equal(typeof gunzip(ups[0].media)[0][0], 'string');
  const manifest = JSON.parse(ups[2].media.toString('utf8'));
  assert.equal(manifest.status, 'ready');
  assert.equal(manifest.publishedAt, '2026-10-30T02:05:00.000Z');
  assert.equal(manifest.feeds[0].sha256, crypto.createHash('sha256').update(ups[0].media).digest('hex'));
  assert.ok(ups.every((u) => u.meta.parents[0] === FOLDER));
  assert.equal(stateOf(root).phase, 'uploaded');
  assert.ok(!existsSync(join(root, 'runs', 'CURRENT')));
});

test('finish uses the inbox folder from refresh/config.json when MASTERDATA_INBOX_ID is unset', async () => {
  const g = fakeGoogle();
  await finish({ root: makeRun(), env: { MASTERDATA_SA_KEY: KEY_JSON }, ...opts(g) });
  assert.deepEqual(g.uploads()[0].meta.parents, ['1PE6IcZqJFHM7ISA4XKNHpifk8oCVyqdV']);
});

test('finish refusals keep CURRENT and state: missing key, bad key, wrong phase', async () => {
  const root = makeRun();
  const g = fakeGoogle();
  assert.equal(await finish({ root, env: {}, ...opts(g) }), 'FAILED missing MASTERDATA_SA_KEY');
  assert.equal(await finish({ root, env: { MASTERDATA_SA_KEY: 'garbage' }, ...opts(g) }), 'FAILED MASTERDATA_SA_KEY is not a service account key');
  assert.equal(stateOf(root).phase, 'fetched');
  assert.ok(existsSync(join(root, 'runs', 'CURRENT')));
  const st = stateOf(root);
  st.phase = 'feeds';
  writeFileSync(join(root, 'runs', RUN_ID, 'state.json'), JSON.stringify(st));
  assert.equal(await finish({ root, env, ...opts(g) }), 'FAILED run is not fetched (phase feeds)');
  assert.ok(existsSync(join(root, 'runs', 'CURRENT')));
  assert.equal(stateOf(root).phase, 'feeds');
  assert.equal(g.calls.length, 0);
});

test('finish: verification failure uploads a failed manifest and ends the run failed', async () => {
  const root = makeRun({ dupKey: true });
  const g = fakeGoogle();
  const out = await finish({ root, env, ...opts(g) });
  assert.match(out, /^FAILED fa: duplicate ROW_KEY k1$/);
  const ups = g.uploads();
  assert.deepEqual(ups.map((u) => u.meta.name), [`${RUN_ID}__manifest.json`]);
  const m = JSON.parse(ups[0].media.toString('utf8'));
  assert.equal(m.status, 'failed');
  assert.match(m.reason, /duplicate ROW_KEY/);
  assert.deepEqual(m.feeds, []);
  assert.equal(stateOf(root).phase, 'failed');
  assert.ok(!existsSync(join(root, 'runs', 'CURRENT')));
});

test('finish: a Drive error fails the run, tries a failed manifest, and appends its own error', async () => {
  const root = makeRun();
  const g = fakeGoogle({ uploadStatus: () => 403 });
  const out = await finish({ root, env, ...opts(g) });
  assert.match(out, /^FAILED .*HTTP 403.*drive says 403; failed manifest also not uploaded: .*HTTP 403/);
  assert.equal(stateOf(root).phase, 'failed');
  assert.ok(!existsSync(join(root, 'runs', 'CURRENT')));
});

test('fail uploads a failed manifest, marks the state failed, deletes CURRENT', async () => {
  const root = makeRun();
  const g = fakeGoogle();
  const out = await fail({ root, reason: 'sf down', env, ...opts(g) });
  assert.equal(out, 'FAILED sf down');
  const m = JSON.parse(g.uploads()[0].media.toString('utf8'));
  assert.deepEqual([m.status, m.reason, m.runId], ['failed', 'sf down', RUN_ID]);
  assert.equal(stateOf(root).phase, 'failed');
  assert.ok(!existsSync(join(root, 'runs', 'CURRENT')));
});

test('fail without a key still closes the run; without any run it just prints', async () => {
  const root = makeRun();
  const out = await fail({ root, reason: 'r', env: {} });
  assert.match(out, /^FAILED r; failed manifest not uploaded: missing MASTERDATA_SA_KEY$/);
  assert.equal(stateOf(root).phase, 'failed');
  assert.ok(!existsSync(join(root, 'runs', 'CURRENT')));
  const empty = mkdtempSync(join(tmpdir(), 'pm-none-'));
  assert.equal(await fail({ root: empty, reason: 'nothing', env }), 'FAILED nothing');
});

test('the key, the assertion and the access token never appear in stdout or thrown messages', async () => {
  const seen = [];
  const log = console.log;
  console.log = (...a) => seen.push(a.join(' '));
  const outputs = [];
  try {
    for (const status of [200, 403]) {
      outputs.push(await finish({ root: makeRun(), env, ...opts(fakeGoogle({ uploadStatus: () => status })) }));
      outputs.push(await fail({ root: makeRun(), reason: 'x', env, ...opts(fakeGoogle({ uploadStatus: () => status })) }));
    }
    outputs.push(await finish({ root: makeRun(), env, ...opts(fakeGoogle({ tokenStatus: 401 })) }));
  } finally {
    console.log = log;
  }
  for (const text of [...seen, ...outputs]) {
    assert.ok(!text.includes(KEY_MARKER), text);
    assert.ok(!text.includes(ACCESS_TOKEN), text);
    assert.ok(!/eyJ[A-Za-z0-9_-]{20,}\./.test(text), 'no JWT in output');
  }
});
