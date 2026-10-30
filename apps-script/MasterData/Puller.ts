// Drive Inbox puller: time-driven every 15 minutes. Plain JavaScript syntax so Node vm can load this file in tests.
//
// Inbox contract (refresh/lib/inbox.mjs buildPayload): per run, <runId>__<feed>.json.gz (gzip of the JSON rows)
// for every feed, then <runId>__manifest.json last. A run is pulled through the same begin -> chunk -> commit
// logic as the web app (staging tabs, validation, row-drop guard, swap, CSV snapshots, _Refresh_Log).

var INBOX_NAME_RE_ = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})__(.+)$/;
var INBOX_MANIFEST_ = 'manifest.json';

// Puller clock in ms (tests replace it to simulate the time budget).
function pullerNow_() {
  return Date.now();
}

// Lower-case hex SHA-256 of a Byte[]. Apps Script digests are signed bytes (-128..127).
function sha256Hex_(bytes) {
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes);
  var hex = '';
  for (var i = 0; i < digest.length; i++) {
    var b = (digest[i] + 256) % 256;
    hex += (b < 16 ? '0' : '') + b.toString(16);
  }
  return hex;
}

function inboxFolder_() {
  return DriveApp.getFolderById(MASTERDATA_CONFIG.INBOX_FOLDER_ID);
}

function scriptProps_() {
  return PropertiesService.getScriptProperties();
}

// Live Inbox files: {runs: {runId: {runId, manifests: [File], files: [File]}}, foreign: [File]}.
// Foreign files do not start with a valid <runId>__.
function listInbox_() {
  var runs = {};
  var foreign = [];
  var it = inboxFolder_().getFiles();
  while (it.hasNext()) {
    var file = it.next();
    if (file.isTrashed()) continue;
    var m = INBOX_NAME_RE_.exec(file.getName());
    if (!m || !isRunId_(m[1])) {
      foreign.push(file);
      continue;
    }
    var run = runs[m[1]] || (runs[m[1]] = { runId: m[1], manifests: [], files: [] });
    run.files.push(file);
    if (m[2] === INBOX_MANIFEST_) run.manifests.push(file);
  }
  return { runs: runs, foreign: foreign };
}

// One _Refresh_Log row without feeds for an Inbox run (throws when the log cannot be written).
function inboxLog_(runId, startedAt, status, message) {
  writeLogRows_(spreadsheet_(), logRows_(logRun_(runId, startedAt || '', nowIso_(), ''), [], status, message));
}

// Best effort: a file that cannot be trashed now is tried again on a later poll. Returns true when trashed.
function trashQuietly_(file) {
  try {
    file.setTrashed(true);
    return true;
  } catch (err) {
    console.log('pollInbox: cannot trash ' + file.getName() + ': ' + errorMessage_(err));
    return false;
  }
}

// Trashes every live Inbox file named <runId>__*. Best effort (it runs after the run was logged):
// leftovers of a processed run are trashed by a later poll.
function trashRunFiles_(runId) {
  var prefix = runId + '__';
  try {
    var it = inboxFolder_().getFiles();
    while (it.hasNext()) {
      var file = it.next();
      if (!file.isTrashed() && file.getName().indexOf(prefix) === 0) trashQuietly_(file);
    }
  } catch (err) {
    console.log('pollInbox: cannot trash the files of ' + runId + ': ' + errorMessage_(err));
  }
}

// Files older than INBOX_ORPHAN_DAYS that belong to no manifest (an upload in progress is younger) are
// trashed. Data files of a runId that never got a manifest are logged INCOMPLETE (foreign files are not).
function trashOrphans_(inbox, nowMs) {
  var days = MASTERDATA_CONFIG.INBOX_ORPHAN_DAYS;
  var cutoff = nowMs - days * 86400000;
  var trashOld = function (file) {
    try {
      return file.getDateCreated().getTime() < cutoff && trashQuietly_(file);
    } catch (err) {
      console.log('pollInbox: cannot check ' + file.getName() + ': ' + errorMessage_(err));
      return false;
    }
  };
  inbox.foreign.forEach(trashOld);
  Object.keys(inbox.runs)
    .sort()
    .forEach(function (id) {
      if (inbox.runs[id].manifests.length) return;
      var trashed = inbox.runs[id].files.filter(trashOld).length;
      if (trashed) inboxLog_(id, '', 'INCOMPLETE', 'no manifest after ' + days + ' days; ' + trashed + ' file(s) trashed');
    });
}

// Manifests up to LAST_PROCESSED_RUN are not processed again; their files are trashed. An older run that
// was never processed (a newer one already was) is logged SUPERSEDED.
function trashProcessedRuns_(inbox, ids, last) {
  ids.forEach(function (id) {
    if (id > last) return;
    inbox.runs[id].files.forEach(trashQuietly_);
    if (id < last) inboxLog_(id, '', 'SUPERSEDED', 'not processed: the newer run ' + last + ' was already processed; files trashed');
  });
}

// Largest runId accepted at nowMs: one day ahead of Berlin wall-clock time.
function maxRunId_(nowMs) {
  var d = new Date(nowMs + 86400000);
  var tz = MASTERDATA_CONFIG.TIME_ZONE;
  return Utilities.formatDate(d, tz, 'yyyy-MM-dd') + 'T' + Utilities.formatDate(d, tz, 'HH-mm-ss');
}

// {manifest} or {error}. Copies of the manifest (create retries) must agree; a failed copy wins (R46).
function readInboxManifest_(entry) {
  var texts = entry.manifests.map(function (file) {
    return file.getBlob().getDataAsString('UTF-8');
  });
  var parsed = [];
  var unreadable = false;
  texts.forEach(function (text) {
    try {
      parsed.push(JSON.parse(text));
    } catch (err) {
      unreadable = true;
    }
  });
  for (var i = 0; i < parsed.length; i++) {
    if (parsed[i] && parsed[i].status === 'failed') return { manifest: parsed[i] };
  }
  if (unreadable) return { error: 'manifest is not valid JSON' };
  for (var j = 1; j < texts.length; j++) {
    if (texts[j] !== texts[0]) return { error: 'manifest copies differ' };
  }
  return { manifest: parsed[0] };
}

// Error message for a ready manifest that does not fit the Inbox contract, else null.
function checkReadyManifest_(m, runId) {
  if (!m || typeof m !== 'object') return 'manifest is not an object';
  if (m.version !== 1) return 'unsupported manifest version ' + m.version;
  if (m.runId !== runId) return 'manifest runId ' + m.runId + ' does not match its file name';
  if (m.status !== 'ready') return 'unknown manifest status ' + m.status;
  if (!Array.isArray(m.feeds)) return 'manifest has no feeds';
  for (var i = 0; i < m.feeds.length; i++) {
    var f = m.feeds[i];
    if (!f || typeof f !== 'object') return 'bad feed';
    if (f.file !== runId + '__' + f.feed + '.json.gz') return f.feed + ': file must be ' + runId + '__' + f.feed + '.json.gz';
    if (typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256)) return f.feed + ': bad sha256';
  }
  return null;
}

// The begin request a ready manifest stands for (same validation as the web app's begin).
function inboxBeginRequest_(m) {
  return {
    runId: m.runId,
    startedAt: m.startedAt,
    baseYear: m.baseYear,
    health: m.health,
    feeds: m.feeds.map(function (f) {
      return { feed: f.feed, tab: f.tab, headers: f.headers, types: f.types, rowCount: f.rowCount };
    }),
  };
}

// {bytes, error: null} of the live copy of mf.file whose sha256 matches the manifest (R46), else {bytes: null, error}.
function findInboxDataFile_(mf) {
  var copies = 0;
  var it = inboxFolder_().getFilesByName(mf.file);
  while (it.hasNext()) {
    var file = it.next();
    if (file.isTrashed()) continue;
    copies++;
    var bytes = file.getBlob().getBytes();
    if (sha256Hex_(bytes) === mf.sha256) return { bytes: bytes, error: null };
  }
  return { bytes: null, error: mf.file + (copies ? ': sha256 does not match the manifest' : ': missing from the Inbox') };
}

// {rows, error: null} of a feed's data file (checked: sha256, JSON array, row count, cell values),
// else {rows: null, error}.
function loadInboxRows_(mf) {
  var fail = function (message) {
    return { rows: null, error: mf.file + ': ' + message };
  };
  var found = findInboxDataFile_(mf);
  if (found.error) return { rows: null, error: found.error };
  var rows;
  try {
    rows = gunzipJson_(found.bytes);
  } catch (err) {
    return fail('not gzip JSON: ' + errorMessage_(err));
  }
  if (!Array.isArray(rows)) return fail('not a JSON array');
  if (rows.length !== mf.rowCount) return fail(rows.length + ' rows, manifest says ' + mf.rowCount);
  var invalid = validateRows_(rows, mf.headers.length);
  if (invalid) return fail(invalid);
  return { rows: rows, error: null };
}

function setLastProcessedRun_(runId) {
  try {
    scriptProps_().setProperty(MASTERDATA_CONFIG.LAST_PROCESSED_RUN_PROPERTY, runId);
  } catch (err) {
    console.log('pollInbox: cannot set LAST_PROCESSED_RUN: ' + errorMessage_(err));
  }
}

function clearRetries_() {
  try {
    scriptProps_().deleteProperty(MASTERDATA_CONFIG.PULL_RETRY_PROPERTY);
  } catch (err) {
    console.log('pollInbox: cannot clear PULL_RETRY: ' + errorMessage_(err));
  }
}

// Ends an Inbox run as failed: the fail action (discard + FAILED row), LAST_PROCESSED_RUN = runId, the retry
// counter cleared and its Inbox files trashed. Throws only when no FAILED row could be written.
function failInboxRun_(runId, reason, startedAt) {
  try {
    handleFail_({ runId: runId, reason: reason, startedAt: startedAt });
  } catch (err) {
    // handleFail_ logs last, so nothing was logged yet.
    inboxLog_(runId, startedAt, 'FAILED', reason + '; cleanup failed: ' + errorMessage_(err));
  }
  setLastProcessedRun_(runId);
  clearRetries_();
  trashRunFiles_(runId);
  return { status: 'failed', runId: runId, error: reason };
}

// Ends an Inbox run after its commit (which logged OK, or FAILED and discarded the run itself; a run that
// was no longer active is logged FAILED here).
function endInboxRun_(current, res) {
  var runId = current.runId;
  if (!res.ok && res.error === notActiveRun_().error) inboxLog_(runId, current.startedAt, 'FAILED', res.error);
  setLastProcessedRun_(runId);
  clearRetries_();
  trashRunFiles_(runId);
  if (!res.ok) return { status: 'failed', runId: runId, error: res.error };
  if (res.warning) return { status: 'committed', runId: runId, warning: res.warning };
  return { status: 'committed', runId: runId };
}

function findManifestFeed_(m, feed) {
  for (var i = 0; i < m.feeds.length; i++) if (m.feeds[i].feed === feed) return m.feeds[i];
  return null;
}

// Begins (once) and stages one Inbox run until it is committed, failed or the poll must stop for time.
// Validation problems fail the run at once; exceptions (incl. a transient commit error) reach the caller,
// which retries the run (R48). current.startedAt is filled in for that path.
function processInboxRun_(entry, startMs, current) {
  var runId = entry.runId;
  var paused = { status: 'staging', runId: runId };
  var read = readInboxManifest_(entry);
  if (read.error) return failInboxRun_(runId, read.error, null);
  var m = read.manifest;
  current.startedAt = m && typeof m.startedAt === 'string' ? m.startedAt : null;
  if (m && m.status === 'failed') {
    return failInboxRun_(runId, m.reason === undefined || m.reason === null ? 'failed' : String(m.reason), current.startedAt);
  }
  var invalid = checkReadyManifest_(m, runId);
  if (invalid) return failInboxRun_(runId, invalid, current.startedAt);

  var loaded = {};
  var run = getActiveRun_();
  if (!run || run.runId !== runId) {
    var req = inboxBeginRequest_(m);
    invalid = validateBegin_(req);
    if (invalid) return failInboxRun_(runId, invalid, current.startedAt);
    // Every data file must be present and intact before anything is staged.
    for (var i = 0; i < m.feeds.length; i++) {
      var got = loadInboxRows_(m.feeds[i]);
      if (got.error) return failInboxRun_(runId, got.error, current.startedAt);
      loaded[m.feeds[i].feed] = got.rows;
    }
    var begun = handleBegin_(req);
    if (!begun.ok) return failInboxRun_(runId, begun.error, current.startedAt);
    run = getActiveRun_();
  }

  var budget = MASTERDATA_CONFIG.PULL_BUDGET_MS;
  var lastSliceMs = 0; // duration of the previous slice in this poll
  for (var k = 0; k < run.feeds.length; k++) {
    var f = run.feeds[k];
    if (f.staged >= f.rowCount) continue;
    if (pullerNow_() - startMs + lastSliceMs > budget) return paused;
    var rows = loaded[f.feed];
    if (!rows) {
      var mf = findManifestFeed_(m, f.feed);
      if (!mf) return failInboxRun_(runId, f.feed + ': not in the manifest', current.startedAt);
      var again = loadInboxRows_(mf);
      if (again.error) return failInboxRun_(runId, again.error, current.startedAt);
      rows = again.rows;
    }
    while (f.staged < f.rowCount) {
      var sliceStart = pullerNow_();
      if (sliceStart - startMs + lastSliceMs > budget) return paused;
      var slice = rows.slice(f.staged, f.staged + MASTERDATA_CONFIG.PULL_SLICE_ROWS);
      var bad = stageRows_(run, f, f.seqs.length + 1, slice);
      if (bad) return failInboxRun_(runId, bad, current.startedAt);
      lastSliceMs = pullerNow_() - sliceStart;
    }
  }
  // Headroom for snapshots + swap before the 6-minute kill.
  if (pullerNow_() - startMs >= MASTERDATA_CONFIG.PULL_COMMIT_START_MAX_MS) return paused;
  var res = commitRun_({ runId: runId }, true);
  if ('transient' in res && res.transient) throw new Error(res.error); // staging kept; retried on a later poll
  return endInboxRun_(current, res);
}

// A runId more than a day ahead of the clock: logged FAILED once (LAST_FUTURE_RUN), files trashed.
// It never touches LAST_PROCESSED_RUN, so it cannot block later runs.
function futureInboxRun_(runId) {
  var props = scriptProps_();
  var reason = 'runId is in the future';
  if (props.getProperty(MASTERDATA_CONFIG.LAST_FUTURE_RUN_PROPERTY) !== runId) {
    inboxLog_(runId, '', 'FAILED', reason);
    try {
      props.setProperty(MASTERDATA_CONFIG.LAST_FUTURE_RUN_PROPERTY, runId);
    } catch (err) {
      console.log('pollInbox: cannot set LAST_FUTURE_RUN: ' + errorMessage_(err));
    }
  }
  trashRunFiles_(runId);
  return { status: 'failed', runId: runId, error: reason };
}

// R51: one-off pollInbox triggers created by earlier polls (their ids are kept in a Script Property).
// Deleted under the lock: this poll does the pending work, and the 15-minute trigger is never touched.
function deleteContinuationTriggers_() {
  try {
    var key = MASTERDATA_CONFIG.PULL_CONTINUATION_PROPERTY;
    var ids = getJsonProperty_(key);
    if (!ids || !ids.length) return;
    ScriptApp.getProjectTriggers().forEach(function (t) {
      if (ids.indexOf(t.getUniqueId()) >= 0) ScriptApp.deleteTrigger(t);
    });
    scriptProps_().deleteProperty(key);
  } catch (err) {
    console.log('pollInbox: cannot delete continuation triggers: ' + errorMessage_(err));
  }
}

// R51: a poll that stopped for time continues in PULL_CONTINUATION_DELAY_MS instead of 15 minutes.
function scheduleContinuation_() {
  try {
    var key = MASTERDATA_CONFIG.PULL_CONTINUATION_PROPERTY;
    var trigger = ScriptApp.newTrigger(MASTERDATA_CONFIG.PULL_HANDLER)
      .timeBased()
      .after(MASTERDATA_CONFIG.PULL_CONTINUATION_DELAY_MS)
      .create();
    setJsonProperty_(key, (getJsonProperty_(key) || []).concat([trigger.getUniqueId()]));
  } catch (err) {
    console.log('pollInbox: cannot create a continuation trigger: ' + errorMessage_(err));
  }
}

// One poll under the script lock. Returns {status: 'idle' | 'staging' | 'committed' | 'retry' | 'failed' | 'error', ...}.
function pollInboxLocked_(startMs) {
  var current = { runId: null, startedAt: null };
  var out;
  deleteContinuationTriggers_();
  try {
    out = pollInboxRun_(startMs, current);
  } catch (err) {
    return pullUnexpected_(err, current.runId ? current : null);
  }
  // A poll that ended without an error outside a run re-arms the once-only logging of such errors.
  try {
    if (scriptProps_().getProperty(MASTERDATA_CONFIG.LAST_PULL_ERROR_PROPERTY) !== null) {
      scriptProps_().deleteProperty(MASTERDATA_CONFIG.LAST_PULL_ERROR_PROPERTY);
    }
  } catch (err) {
    console.log('pollInbox: cannot clear LAST_PULL_ERROR: ' + errorMessage_(err));
  }
  return out;
}

// Lists the Inbox, cleans up, and works on the oldest pending run. current.runId is set once a run
// (not a future runId) is being processed, so its exceptions are retried as run errors (R48).
function pollInboxRun_(startMs, current) {
  var inbox = listInbox_();
  trashOrphans_(inbox, startMs);
  var last = scriptProps_().getProperty(MASTERDATA_CONFIG.LAST_PROCESSED_RUN_PROPERTY) || '';
  var ids = Object.keys(inbox.runs)
    .filter(function (id) {
      return inbox.runs[id].manifests.length > 0;
    })
    .sort();
  trashProcessedRuns_(inbox, ids, last);
  var pending = ids.filter(function (id) {
    return id > last;
  });
  if (!pending.length) return { status: 'idle' };
  var runId = pending[0];
  if (runId > maxRunId_(startMs)) return futureInboxRun_(runId);
  current.runId = runId;
  var out = processInboxRun_(inbox.runs[runId], startMs, current);
  if (out.status === 'staging') scheduleContinuation_();
  return out;
}

// R48: an unexpected error of a run is retried on later polls: attempts 1 .. PULL_MAX_ATTEMPTS-1 log a RETRY
// row and keep the run's state (ACTIVE_RUN, staging), the last attempt fails the run.
function retryInboxRun_(current, message) {
  var max = MASTERDATA_CONFIG.PULL_MAX_ATTEMPTS;
  var key = MASTERDATA_CONFIG.PULL_RETRY_PROPERTY;
  var state = getJsonProperty_(key);
  var attempt = state && state.runId === current.runId ? state.failures + 1 : 1;
  var text = 'attempt ' + attempt + ' of ' + max + ': ' + message;
  if (attempt >= max) return failInboxRun_(current.runId, text, current.startedAt);
  setJsonProperty_(key, { runId: current.runId, failures: attempt });
  inboxLog_(current.runId, current.startedAt, 'RETRY', text);
  return { status: 'retry', runId: current.runId, error: message };
}

// Unexpected exception. Inside a run: R48 retry / final FAILED. Outside a run: one FAILED row (a repeated
// message is not logged again). Rethrown only when nothing could be logged.
function pullUnexpected_(err, current) {
  var message = errorMessage_(err);
  if (current) {
    try {
      return retryInboxRun_(current, message);
    } catch (logErr) {
      throw err;
    }
  }
  var text = 'inbox: ' + message;
  try {
    if (scriptProps_().getProperty(MASTERDATA_CONFIG.LAST_PULL_ERROR_PROPERTY) === text) return { status: 'error', error: text };
    writeLogRows_(spreadsheet_(), logRows_(logRun_('', '', nowIso_(), ''), [], 'FAILED', text));
  } catch (logErr) {
    throw err;
  }
  try {
    scriptProps_().setProperty(MASTERDATA_CONFIG.LAST_PULL_ERROR_PROPERTY, text);
  } catch (propErr) {
    console.log('pollInbox: cannot set LAST_PULL_ERROR: ' + errorMessage_(propErr));
  }
  return { status: 'error', error: text };
}

// Time-driven trigger handler (every PULL_EVERY_MINUTES, plus one-off continuations). The start time is taken
// on entry, before the lock. Exits quietly when another execution holds the lock.
function pollInbox() {
  var startMs = pullerNow_();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(MASTERDATA_CONFIG.PULL_LOCK_WAIT_MS)) return { status: 'busy' };
  try {
    return pollInboxLocked_(startMs);
  } finally {
    lock.releaseLock();
  }
}

// Run once from the Apps Script editor (USER step). Replaces any pollInbox trigger with one that runs
// every PULL_EVERY_MINUTES minutes.
function installPullTrigger() {
  var handler = MASTERDATA_CONFIG.PULL_HANDLER;
  deleteTriggersFor_(handler);
  try {
    scriptProps_().deleteProperty(MASTERDATA_CONFIG.PULL_CONTINUATION_PROPERTY);
  } catch (err) {
    console.log('installPullTrigger: cannot clear continuation ids: ' + errorMessage_(err));
  }
  return ScriptApp.newTrigger(handler).timeBased().everyMinutes(MASTERDATA_CONFIG.PULL_EVERY_MINUTES).create();
}
