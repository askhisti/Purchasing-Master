import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest } from './lib/manifest.mjs';
import { parseConnectorResult } from './lib/result.mjs';
import { renderFeedSql, buildCountSql, buildPageSql, nextLimit, shrinkLimit } from './lib/sql.mjs';
import { berlinRunId, loadState, saveState, newestCaptureAfter, runsDir, currentRunId } from './lib/state.mjs';

const MIN_LIMIT = 100;

const normSql = (t) => String(t).replace(/\s+/g, ' ').trim();
const runSql = (sql) => `RUN_SQL\n${sql}`;

function feedSql(root, feed, baseYear) {
  const text = fs.readFileSync(path.join(root, feed.sqlFile), 'utf8').trimEnd();
  return renderFeedSql(text, baseYear);
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
  if (cap.shape === 'unrecognized') return abort(root, state, 'unrecognized connector result');
  if (normSql(cap.sql) !== normSql(state.pendingSql)) return abort(root, state, 'expected result of the pending SQL');

  let r;
  try {
    r = parseConnectorResult(cap.response);
  } catch {
    return abort(root, state, 'unrecognized connector result');
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
    state.limit = nextLimit(requested, r.chars, r.rows.length);
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

const commands = { begin: (root) => begin({ root }), next: (root) => next({ root }) };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cmd = commands[process.argv[2]];
  if (!cmd) {
    console.error(`usage: cli.mjs <${Object.keys(commands).join('|')}>`);
    process.exit(2);
  }
  let out;
  try {
    out = cmd(process.cwd());
  } catch (e) {
    out = `ABORT ${e && e.message ? e.message : e}`;
  }
  console.log(out);
}
