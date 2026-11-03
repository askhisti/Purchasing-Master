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
function withScriptLock_(fn, waitMs = MASTERDATA_CONFIG.LOCK_TIMEOUT_MS) {
  var lock = LockService.getScriptLock();
  lock.waitLock(waitMs);
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

// Removes everything a run left behind: staging tabs, its part and .csv.tmp files, ACTIVE_RUN.
function discardRun_(ss, run) {
  clearStagingTabs_(ss);
  deleteRunFiles_(run.date);
  clearActiveRun_();
}

// {action:'begin', runId, startedAt, baseYear, feeds:[{feed, tab, headers, types, rowCount}], health}
// startedAt (ISO) is the CLI run start; the log's Started column uses it (now when absent).
function handleBegin_(req) {
  var invalid = validateBegin_(req);
  if (invalid) return { ok: false, error: invalid };
  var ss = spreadsheet_();
  ensureLocale_(ss);
  var prev = getActiveRun_();
  if (prev && prev.runId !== req.runId) {
    // The replaced run never committed or failed; record it before its state is cleared.
    writeLogRows_(ss, logRows_(logRun_(prev.runId, prev.started, nowIso_(), prev.sourceRefreshedAt), [], 'ABANDONED', 'replaced by ' + req.runId));
  }
  clearActiveRun_();
  ensureLogSheet_(ss); // keeps a visible sheet so staging tabs can be hidden
  clearStagingTabs_(ss);
  var date = snapshotDate_(req.runId);
  deleteRunFiles_(date);
  if (prev && prev.date && prev.date !== date) deleteRunFiles_(prev.date);
  var run = {
    runId: req.runId,
    date: date,
    baseYear: req.baseYear,
    started: typeof req.startedAt === 'string' ? req.startedAt : nowIso_(),
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
  var invalid = stageRows_(run, f, seq, rows);
  if (invalid) return { ok: false, error: invalid };
  return { ok: true, stagedRows: f.staged };
}

// Appends rows as chunk seq of feed f of the active run and saves the run. Returns an error message
// (nothing written) or null. Shared by the chunk action and the Inbox puller.
function stageRows_(run, f, seq, rows) {
  var invalid = validateRows_(rows, f.headers.length);
  if (invalid) return f.feed + ' chunk ' + seq + ': ' + invalid;
  if (rows.length) {
    // Position comes from the recorded count, so a retry after a partial write overwrites the same rows.
    appendStagedRows_(spreadsheet_(), f.tab, 2 + f.staged, rows, columnFormats_(f.types));
    savePart_(run.date, f.feed, seq, toCsv_(null, rows));
  }
  f.staged += rows.length;
  f.seqs.push(seq);
  setActiveRun_(run);
  return null;
}

// {action:'commit', runId}. Everything that can reject the run happens before any live tab is touched.
function handleCommit_(req) {
  return commitRun_(req, false);
}

// The commit logic. A rejection (staged count, row drop) or an error after the swap started discards the run
// and logs FAILED. An exception before the swap does the same unless retryable (the Inbox puller): then the
// run, its staging tabs and snapshot files are kept and {ok:false, error, transient:true} is returned.
function commitRun_(req, retryable) {
  var run = getActiveRun_();
  if (!run || run.runId !== req.runId) return notActiveRun_();
  var ss = spreadsheet_();
  var swapStarted = false;
  var counts = {};
  var prevCounts;
  var rejection = null;
  try {
    for (var i = 0; i < run.feeds.length && !rejection; i++) {
      var f = run.feeds[i];
      if (f.staged !== f.rowCount) rejection = f.feed + ': staged ' + f.staged + ' rows, expected ' + f.rowCount;
      counts[f.feed] = f.staged;
    }
    if (!rejection) {
      prevCounts = getLastRowCounts_();
      rejection = checkRowDrop_(prevCounts, counts, MASTERDATA_CONFIG.MAX_ROW_DROP);
    }
    if (rejection) throw new Error(rejection);
    run.feeds.forEach(function (f) {
      assembleSnapshot_(run.date, f.feed, f.headers);
    });
    swapStarted = true;
    swapStagingToLive_(
      ss,
      run.feeds.map(function (f) {
        return { tab: f.tab, rows: 1 + f.staged, cols: f.headers.length };
      })
    );
  } catch (err) {
    if (retryable && !rejection && !swapStarted) return { ok: false, error: errorMessage_(err), transient: true };
    var message = (swapStarted ? 'after swap started (live tabs may be updated): ' : '') + errorMessage_(err);
    try {
      discardRun_(ss, run);
    } catch (cleanupErr) {
      message += '; cleanup failed: ' + errorMessage_(cleanupErr);
    }
    try {
      var failRun = logRun_(run.runId, run.started, nowIso_(), run.sourceRefreshedAt);
      writeLogRows_(ss, logRows_(failRun, stagedCounts_(run), 'FAILED', message));
    } catch (logErr) {
      message += '; log write failed: ' + errorMessage_(logErr);
    }
    return { ok: false, error: message };
  }
  // Every live tab now holds this run: later problems are warnings, never a failed run.
  var warnings = [];
  var step = function (label, fn) {
    try {
      fn();
    } catch (e) {
      warnings.push(label + ': ' + errorMessage_(e));
    }
  };
  // First, so a puller execution killed right after the swap is recognised as committed (never staged again).
  step('committed run', function () {
    PropertiesService.getScriptProperties().setProperty(MASTERDATA_CONFIG.LAST_COMMITTED_RUN_PROPERTY, run.runId);
  });
  step('tab notes', function () {
    applyTabNotes_(ss);
  });
  step('clear active run', clearActiveRun_);
  step('snapshot', function () {
    run.feeds.forEach(function (f) {
      promoteSnapshot_(run.date, f.feed);
    });
  });
  step('row counts', function () {
    var merged = prevCounts || {};
    Object.keys(counts).forEach(function (k) {
      merged[k] = counts[k];
    });
    setLastRowCounts_(merged);
  });
  step('snapshot prune', function () {
    pruneSnapshots_(run.date);
  });
  step('default sheet', function () {
    deleteEmptyDefaultSheets_(ss);
  });
  var finished = nowIso_();
  step('log', function () {
    var logRun = logRun_(run.runId, run.started, finished, run.sourceRefreshedAt);
    writeLogRows_(ss, logRows_(logRun, stagedCounts_(run), 'OK', warnings.join('; ')));
  });
  step('last successful refresh', function () {
    setLastSuccess_(ss, finished, run.baseYear);
  });
  if (warnings.length) return { ok: true, feeds: stagedCounts_(run), warning: warnings.join('; ') };
  return { ok: true, feeds: stagedCounts_(run) };
}

// {action:'fail', runId, reason, startedAt?}. Always logged; Started is the active run's start, else startedAt.
// Cleans up when runId is the active run, or when no run is active (staging tabs plus that runId's date-folder part/.tmp files). Another active run is left alone.
function handleFail_(req) {
  var ss = spreadsheet_();
  var run = getActiveRun_();
  var runId = typeof req.runId === 'string' ? req.runId : '';
  var reason = req.reason === undefined || req.reason === null ? 'failed' : String(req.reason);
  var active = !!run && run.runId === runId;
  if (active) discardRun_(ss, run);
  else if (!run) {
    clearStagingTabs_(ss);
    if (isRunId_(runId)) deleteRunFiles_(snapshotDate_(runId));
  }
  var started = active ? run.started : typeof req.startedAt === 'string' ? req.startedAt : '';
  var logRun = logRun_(runId, started, nowIso_(), active ? run.sourceRefreshedAt : '');
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
