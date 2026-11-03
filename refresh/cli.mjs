import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest, sqlColumnsFor, demandYearsFor, demandMonthsFor } from './lib/manifest.mjs';
import { shapeFeed } from './lib/shape.mjs';
import { getAccessToken, parseServiceAccountKey } from './lib/google-auth.mjs';
import { buildPayload, uploadToInbox } from './lib/inbox.mjs';
import { parseConnectorResult } from './lib/result.mjs';
import { renderFeedSql, buildCountSql, buildPageSql, nextLimit, shrinkLimit } from './lib/sql.mjs';
import { berlinRunId, loadState, saveState, newestCaptureAfter, runsDir, currentRunId } from './lib/state.mjs';

const MIN_LIMIT = 100;
const DEFAULT_TARGET_PAGE_CHARS = 250000;
const SNIPPET_CHARS = 200;

const normSql = (t) => String(t).replace(/\s+/g, ' ').trim();
const runSql = (sql) => `RUN_SQL\n${sql}`;

function feedSql(root, feed, baseYear) {
  const text = fs.readFileSync(path.join(root, feed.sqlFile), 'utf8').trimEnd();
  return renderFeedSql(text, baseYear, demandYearsFor(feed, baseYear), demandMonthsFor(feed, baseYear));
}

export function begin({ root, now = new Date() }) {
  const runId = berlinRunId(now);
  const pendingSql = fs.readFileSync(path.join(root, 'sql', 'health.sql'), 'utf8').trimEnd();
  const state = {
    runId,
    startedAt: now.toISOString(),
    baseYear: null,
    phase: 'health',
    feedIndex: 0,
    step: 'count',
    afterKey: null,
    limit: null,
    expected: null,
    pages: [],
    done: [],
    pendingSql,
    health: null,
    failure: null,
    lastSeq: 0,
  };
  fs.mkdirSync(runsDir(root), { recursive: true });
  saveState(root, state);
  fs.writeFileSync(path.join(runsDir(root), 'CURRENT'), runId);
  return runSql(pendingSql);
}

function abort(root, state, reason) {
  state.phase = 'failed';
  state.failure = reason;
  state.pendingSql = null;
  saveState(root, state);
  return `ABORT ${reason}`;
}

function startFeed(root, state, manifest, index) {
  state.feedIndex = index;
  state.step = 'count';
  state.afterKey = null;
  state.limit = null;
  state.expected = null;
  state.pages = [];
  state.pendingSql = buildCountSql(feedSql(root, manifest.feeds[index], state.baseYear));
}

// Start of a raw connector response for an ABORT reason: newlines collapsed, 200 characters.
function unrecognized(response) {
  const snippet = String(response ?? '').replace(/[\r\n]+/g, ' ').slice(0, SNIPPET_CHARS);
  return snippet ? `unrecognized connector result: ${snippet}` : 'unrecognized connector result';
}

function colValue(r, name) {
  const i = r.columns.indexOf(name);
  return i < 0 || !r.rows[0] ? undefined : r.rows[0][i];
}

export function next({ root }) {
  const runId = currentRunId(root);
  const state = loadState(root, runId);
  if (state.phase === 'failed') return `ABORT ${state.failure}`;
  if (state.phase === 'fetched') return 'FETCHED';

  const cap = newestCaptureAfter(root, runId, state.lastSeq);
  if (!cap) return abort(root, state, 'expected result of the pending SQL');
  state.lastSeq = cap.seq;
  if (cap.shape === 'unrecognized') return abort(root, state, unrecognized(cap.response));
  if (normSql(cap.sql) !== normSql(state.pendingSql)) return abort(root, state, 'expected result of the pending SQL');

  let r;
  try {
    r = parseConnectorResult(cap.response);
  } catch {
    return abort(root, state, unrecognized(cap.response));
  }

  const manifest = loadManifest(path.join(root, 'sql', 'feeds.json'));

  if (state.phase === 'health') {
    if (!r.rows[0]) return abort(root, state, 'unrecognized connector result');
    const health = Object.fromEntries(r.columns.map((c, i) => [c, r.rows[0][i]]));
    state.health = health;
    const problems = Number(health.PROBLEM_COUNT);
    if (!Number.isFinite(problems)) return abort(root, state, 'unrecognized connector result');
    if (problems > 0) return abort(root, state, `platform health: ${health.PROBLEM_LIST}`);
    const baseYear = Number(health.BASE_YEAR);
    if (!Number.isInteger(baseYear)) return abort(root, state, 'unrecognized connector result');
    state.baseYear = baseYear;
    state.phase = 'feeds';
    startFeed(root, state, manifest, 0);
    saveState(root, state);
    return runSql(state.pendingSql);
  }

  const feed = manifest.feeds[state.feedIndex];
  const fsql = feedSql(root, feed, state.baseYear);

  if (state.step === 'count') {
    const rowCount = Number(colValue(r, 'ROW_COUNT'));
    const keyCount = Number(colValue(r, 'KEY_COUNT'));
    if (!Number.isFinite(rowCount) || !Number.isFinite(keyCount)) return abort(root, state, 'unrecognized connector result');
    if (rowCount !== keyCount) return abort(root, state, `${feed.feed}: duplicate ROW_KEY`);
    state.expected = { rowCount, keyCount };
    state.step = 'page';
    state.afterKey = null;
    state.limit = feed.pageLimit;
    state.pendingSql = buildPageSql(fsql, null, state.limit);
    saveState(root, state);
    return runSql(state.pendingSql);
  }

  // step page
  if (r.columns[0] !== 'ROW_KEY') return abort(root, state, `${feed.feed}: first column is not ROW_KEY`);
  if (!Number.isFinite(Number(r.numRows))) return abort(root, state, 'unrecognized connector result');
  const requested = state.limit;
  if (r.rows.length < r.numRows) {
    if (requested <= MIN_LIMIT) return abort(root, state, `${feed.feed}: page truncated at minimum size`);
    state.limit = shrinkLimit(requested, r.rows.length, r.numRows);
    state.pendingSql = buildPageSql(fsql, state.afterKey, state.limit);
    saveState(root, state);
    return runSql(state.pendingSql);
  }

  if (r.rows.length > 0) {
    state.pages.push({
      captureSeq: cap.seq,
      rows: r.rows.length,
      firstKey: r.rows[0][0],
      lastKey: r.rows[r.rows.length - 1][0],
    });
    state.afterKey = r.rows[r.rows.length - 1][0];
    state.limit = nextLimit(requested, r.chars, r.rows.length, manifest.targetPageChars ?? DEFAULT_TARGET_PAGE_CHARS);
  }

  if (r.rows.length < requested) {
    const fetched = state.pages.reduce((s, p) => s + p.rows, 0);
    if (fetched !== state.expected.rowCount) {
      return abort(root, state, `${feed.feed}: expected ${state.expected.rowCount} rows, fetched ${fetched}`);
    }
    state.done.push({ feed: feed.feed, expected: state.expected, pages: state.pages });
    if (state.feedIndex + 1 < manifest.feeds.length) {
      startFeed(root, state, manifest, state.feedIndex + 1);
      saveState(root, state);
      return runSql(state.pendingSql);
    }
    state.phase = 'fetched';
    state.pendingSql = null;
    saveState(root, state);
    return 'FETCHED';
  }

  state.pendingSql = buildPageSql(fsql, state.afterKey, state.limit);
  saveState(root, state);
  return runSql(state.pendingSql);
}

function readPageRows(root, runId, page) {
  const file = path.join(runsDir(root), runId, 'captures', `${String(page.captureSeq).padStart(4, '0')}.json`);
  const cap = JSON.parse(fs.readFileSync(file, 'utf8'));
  const r = parseConnectorResult(cap.response);
  return { rows: r.rows, columns: r.columns };
}

function endRun(root, state, phase, failure) {
  state.phase = phase;
  state.failure = failure ?? null;
  saveState(root, state);
  fs.rmSync(path.join(runsDir(root), 'CURRENT'), { force: true });
}

const MISSING_KEY = 'missing MASTERDATA_SA_KEY';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const CONFIG_FILE = fileURLToPath(new URL('./config.json', import.meta.url));

// Re-reads every feed's captured pages, checks them against the fetch-time counts, and shapes them.
function prepareFeeds(root, state, manifest) {
  return state.done.map((d) => {
    const feedDef = manifest.feeds.find((f) => f.feed === d.feed);
    if (!feedDef) throw new Error(`${d.feed}: not in manifest`);
    const sum = d.pages.reduce((s, p) => s + p.rows, 0);
    if (sum !== d.expected.rowCount) throw new Error(`${d.feed}: pages hold ${sum} rows, expected ${d.expected.rowCount}`);
    const raw = [];
    const seen = new Set();
    for (const page of d.pages) {
      const { rows, columns } = readPageRows(root, state.runId, page);
      const want = ['ROW_KEY', ...sqlColumnsFor(feedDef, state.baseYear)];
      if (JSON.stringify(columns) !== JSON.stringify(want)) {
        throw new Error(`${d.feed}: capture ${page.captureSeq} column names do not match the manifest (got ${columns.join(',')})`);
      }
      if (rows.length !== page.rows) throw new Error(`${d.feed}: capture ${page.captureSeq} holds ${rows.length} rows, expected ${page.rows}`);
      for (const r of rows) {
        if (seen.has(r[0])) throw new Error(`${d.feed}: duplicate ROW_KEY ${r[0]}`);
        seen.add(r[0]);
        raw.push(r);
      }
    }
    const shaped = shapeFeed(feedDef, state.baseYear, raw, sqlColumnsFor(feedDef, state.baseYear));
    return { feedDef, ...shaped };
  });
}

function inboxFolderId(env) {
  const id = env.MASTERDATA_INBOX_ID || JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).inboxFolderId;
  if (!id) throw new Error('no Inbox folder id (refresh/config.json inboxFolderId or MASTERDATA_INBOX_ID)');
  return id;
}

async function uploadFiles({ env, files, fetchImpl, sleep, now }) {
  const token = await getAccessToken({ keyJson: env.MASTERDATA_SA_KEY, scope: DRIVE_SCOPE, fetchImpl, sleep, now });
  return uploadToInbox({ folderId: inboxFolderId(env), files, token, fetchImpl, sleep });
}

const isoNow = (now) => new Date(now ? now() : Date.now()).toISOString();

// Best effort: a failed manifest tells the puller the run is over. Returns '' or a note for the message.
async function bestEffortFail(io, state, reason) {
  try {
    const { files } = buildPayload(state, [], { status: 'failed', reason, publishedAt: isoNow(io.now) });
    await uploadFiles({ ...io, files });
    return '';
  } catch (e) {
    return `; failed manifest also not uploaded: ${e && e.message ? e.message : e}`;
  }
}

export async function finish({ root, env = process.env, fetchImpl, sleep, now }) {
  if (!env.MASTERDATA_SA_KEY) return `FAILED ${MISSING_KEY}`;
  try {
    parseServiceAccountKey(env.MASTERDATA_SA_KEY);
  } catch (e) {
    return `FAILED ${e.message}`;
  }
  const state = loadState(root);
  if (state.phase !== 'fetched') return `FAILED run is not fetched (phase ${state.phase})`;
  const io = { env, fetchImpl, sleep, now };
  try {
    const manifest = loadManifest(path.join(root, 'sql', 'feeds.json'));
    const feeds = prepareFeeds(root, state, manifest);
    const { files } = buildPayload(state, feeds, { publishedAt: isoNow(now) });
    await uploadFiles({ ...io, files });
    endRun(root, state, 'uploaded');
    const counts = feeds.map((f) => `${f.feedDef.feed}=${f.rows.length}`).join(' ');
    return `DONE uploaded ${state.runId} ${counts}`;
  } catch (e) {
    const message = e && e.message ? e.message : String(e);
    const extra = await bestEffortFail(io, state, message);
    endRun(root, state, 'failed', message);
    return `FAILED ${message}${extra}`;
  }
}

export async function fail({ root, reason, env = process.env, fetchImpl, sleep, now }) {
  const msg = reason || 'failed';
  let state;
  try {
    state = loadState(root);
  } catch {
    return `FAILED ${msg}`;
  }
  const extra = env.MASTERDATA_SA_KEY
    ? await bestEffortFail({ env, fetchImpl, sleep, now }, state, msg)
    : `; failed manifest not uploaded: ${MISSING_KEY}`;
  endRun(root, state, 'failed', msg);
  return `FAILED ${msg}${extra}`;
}

const commands = {
  begin: (root) => begin({ root }),
  next: (root) => next({ root }),
  finish: (root) => finish({ root }),
  fail: (root, args) => fail({ root, reason: args.join(' ') }),
};

// Main-module check on real paths: argv[1] may run through a symlink or junction while
// import.meta.url is the resolved file.
function isMain() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const name = process.argv[2];
  const cmd = commands[name];
  if (!cmd) {
    console.error(`usage: cli.mjs <${Object.keys(commands).join('|')}>`);
    process.exit(2);
  }
  let out;
  try {
    out = await cmd(process.cwd(), process.argv.slice(3));
  } catch (e) {
    out = `${name === 'finish' || name === 'fail' ? 'FAILED' : 'ABORT'} ${e && e.message ? e.message : e}`;
  }
  console.log(out);
  if (out.startsWith('FAILED')) process.exitCode = 1;
}
