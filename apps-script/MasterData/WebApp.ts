// Plain JavaScript syntax (no type annotations) so Node vm can load this file in tests.

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// Constant-time compare against Script Property REFRESH_TOKEN. Unset token rejects everything.
function checkToken_(provided) {
  var expected = PropertiesService.getScriptProperties().getProperty(MASTERDATA_CONFIG.TOKEN_PROPERTY);
  if (typeof provided !== 'string' || typeof expected !== 'string' || expected === '') return false;
  var diff = provided.length === expected.length ? 0 : 1;
  var n = Math.max(provided.length, expected.length);
  for (var i = 0; i < n; i++) {
    diff |= (provided.charCodeAt(i) || 0) ^ (expected.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function errorMessage_(err) {
  return err && err.message ? String(err.message) : String(err);
}

function nowIso_() {
  return new Date().toISOString();
}

// Every action runs under the script lock so begin/chunk/commit/fail never interleave.
function withScriptLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(MASTERDATA_CONFIG.LOCK_TIMEOUT_MS);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function notActiveRun_() {
  return { ok: false, error: 'not the active run' };
}

function findRunFeed_(run, feed) {
  for (var i = 0; i < run.feeds.length; i++) if (run.feeds[i].feed === feed) return run.feeds[i];
  return null;
}

function stagedCounts_(run) {
  return run.feeds.map(function (f) {
    return { feed: f.feed, rows: f.staged };
  });
}

// Removes everything a run left behind: staging tabs, its part files, ACTIVE_RUN.
function discardRun_(ss, run) {
  clearStagingTabs_(ss);
  deletePartFiles_(run.date);
  clearActiveRun_();
}

// {action:'begin', runId, baseYear, feeds:[{feed, tab, headers, types, rowCount}], health}
function handleBegin_(req) {
  var invalid = validateBegin_(req);
  if (invalid) return { ok: false, error: invalid };
  var ss = spreadsheet_();
  var prev = getActiveRun_();
  clearActiveRun_();
  ensureLogSheet_(ss); // keeps a visible sheet so staging tabs can be hidden
  clearStagingTabs_(ss);
  var date = snapshotDate_(req.runId);
  deletePartFiles_(date);
  if (prev && prev.date && prev.date !== date) deletePartFiles_(prev.date);
  var run = {
    runId: req.runId,
    date: date,
    baseYear: req.baseYear,
    started: nowIso_(),
    sourceRefreshedAt: sourceRefreshedAt_(req.health),
    feeds: req.feeds.map(function (f) {
      createStagingTab_(ss, f.tab, f.headers);
      return { feed: f.feed, tab: f.tab, headers: f.headers, types: f.types, rowCount: f.rowCount, staged: 0, seqs: [] };
    }),
  };
  setActiveRun_(run);
  return { ok: true };
}

// {action:'chunk', runId, feed, seq, rowsB64Gzip}. Rows are appended in arrival order; seqs must increase.
function handleChunk_(req) {
  var run = getActiveRun_();
  if (!run || run.runId !== req.runId) return notActiveRun_();
  var f = findRunFeed_(run, req.feed);
  if (!f) return { ok: false, error: 'unknown feed' };
  var seq = req.seq;
  if (typeof seq !== 'number' || Math.floor(seq) !== seq || seq < 0 || seq > 9999) return { ok: false, error: 'bad seq' };
  // A retried chunk that was already applied is acknowledged without writing it twice.
  if (f.seqs.indexOf(seq) >= 0) return { ok: true, stagedRows: f.staged, duplicate: true };
  if (f.seqs.length && seq < Math.max.apply(null, f.seqs)) return { ok: false, error: 'chunk out of order' };
  var rows;
  try {
    rows = decodeRows_(req.rowsB64Gzip);
  } catch (err) {
    return { ok: false, error: 'bad chunk payload: ' + errorMessage_(err) };
  }
  var invalid = validateRows_(rows, f.headers.length);
  if (invalid) return { ok: false, error: f.feed + ' chunk ' + seq + ': ' + invalid };
  if (rows.length) {
    // Position comes from the recorded count, so a retry after a partial write overwrites the same rows.
    appendStagedRows_(spreadsheet_(), f.tab, 2 + f.staged, rows, columnFormats_(f.types));
    savePart_(run.date, f.feed, seq, toCsv_(null, rows));
  }
  f.staged += rows.length;
  f.seqs.push(seq);
  setActiveRun_(run);
  return { ok: true, stagedRows: f.staged };
}

// {action:'commit', runId}. Validates every feed before touching live tabs.
function handleCommit_(req) {
  var run = getActiveRun_();
  if (!run || run.runId !== req.runId) return notActiveRun_();
  var ss = spreadsheet_();
  var swapStarted = false;
  try {
    var counts = {};
    run.feeds.forEach(function (f) {
      if (f.staged !== f.rowCount) throw new Error(f.feed + ': staged ' + f.staged + ' rows, expected ' + f.rowCount);
      counts[f.feed] = f.staged;
    });
    var prevCounts = getLastRowCounts_();
    var drop = checkRowDrop_(prevCounts, counts, MASTERDATA_CONFIG.MAX_ROW_DROP);
    if (drop) throw new Error(drop);
    run.feeds.forEach(function (f) {
      assembleSnapshot_(run.date, f.feed, f.headers);
    });
    swapStarted = true;
    swapStagingToLive_(ss, run.feeds.map(function (f) { return f.tab; }));
    var merged = prevCounts || {};
    Object.keys(counts).forEach(function (k) {
      merged[k] = counts[k];
    });
    setLastRowCounts_(merged);
    clearActiveRun_();
    var warning = '';
    try {
      pruneSnapshots_(run.date);
    } catch (pruneErr) {
      warning = 'snapshot prune failed: ' + errorMessage_(pruneErr);
    }
    var finished = nowIso_();
    var logRun = { runId: run.runId, started: run.started, finished: finished, sourceRefreshedAt: run.sourceRefreshedAt };
    writeLogRows_(ss, logRows_(logRun, stagedCounts_(run), 'OK', warning));
    setLastSuccess_(ss, finished, run.baseYear);
    return { ok: true, feeds: stagedCounts_(run) };
  } catch (err) {
    var message = (swapStarted ? 'after swap started (live tabs may be updated): ' : '') + errorMessage_(err);
    try {
      discardRun_(ss, run);
    } catch (cleanupErr) {
      message += '; cleanup failed: ' + errorMessage_(cleanupErr);
    }
    var failRun = { runId: run.runId, started: run.started, finished: nowIso_(), sourceRefreshedAt: run.sourceRefreshedAt };
    writeLogRows_(ss, logRows_(failRun, stagedCounts_(run), 'FAILED', message));
    return { ok: false, error: message };
  }
}

// {action:'fail', runId, reason}. Always logged; cleans up only when runId is the active run (or none is active).
function handleFail_(req) {
  var ss = spreadsheet_();
  var run = getActiveRun_();
  var runId = typeof req.runId === 'string' ? req.runId : '';
  var reason = req.reason === undefined || req.reason === null ? 'failed' : String(req.reason);
  var active = !!run && run.runId === runId;
  if (active) discardRun_(ss, run);
  else if (!run) clearStagingTabs_(ss);
  var logRun = {
    runId: runId,
    started: active ? run.started : '',
    finished: nowIso_(),
    sourceRefreshedAt: active ? run.sourceRefreshedAt : '',
  };
  writeLogRows_(ss, logRows_(logRun, active ? stagedCounts_(run) : [], 'FAILED', reason));
  return { ok: true };
}

var WEBAPP_ACTIONS_ = {
  ping: function () {
    return { ok: true, pong: true };
  },
  begin: handleBegin_,
  chunk: handleChunk_,
  commit: handleCommit_,
  fail: handleFail_,
};

function doPost(e) {
  var req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonOut_({ ok: false, error: 'bad request' });
  }
  if (!req || typeof req !== 'object') return jsonOut_({ ok: false, error: 'bad request' });
  if (!checkToken_(req.token)) return jsonOut_({ ok: false, error: 'unauthorized' });
  if (typeof req.action !== 'string' || !Object.prototype.hasOwnProperty.call(WEBAPP_ACTIONS_, req.action)) {
    return jsonOut_({ ok: false, error: 'unknown action' });
  }
  try {
    return jsonOut_(withScriptLock_(function () { return WEBAPP_ACTIONS_[req.action](req); }));
  } catch (err) {
    return jsonOut_({ ok: false, error: errorMessage_(err) });
  }
}

// Run once from the editor with a new random 32-byte hex token.
function setRefreshToken(token) {
  PropertiesService.getScriptProperties().setProperty(MASTERDATA_CONFIG.TOKEN_PROPERTY, token);
}
