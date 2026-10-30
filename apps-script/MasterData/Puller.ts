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

// Best effort: a file that cannot be trashed now is tried again on a later poll.
function trashQuietly_(file) {
  try {
    file.setTrashed(true);
  } catch (err) {
    console.log('pollInbox: cannot trash ' + file.getName() + ': ' + errorMessage_(err));
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

// Files older than INBOX_ORPHAN_DAYS that belong to no manifest (an upload in progress is younger).
function trashOrphans_(inbox, nowMs) {
  var cutoff = nowMs - MASTERDATA_CONFIG.INBOX_ORPHAN_DAYS * 86400000;
  var trashOld = function (file) {
    try {
      if (file.getDateCreated().getTime() < cutoff) file.setTrashed(true);
    } catch (err) {
      console.log('pollInbox: cannot trash ' + file.getName() + ': ' + errorMessage_(err));
    }
  };
  inbox.foreign.forEach(trashOld);
  Object.keys(inbox.runs).forEach(function (id) {
    if (!inbox.runs[id].manifests.length) inbox.runs[id].files.forEach(trashOld);
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

function overBudget_(startMs) {
  return pullerNow_() - startMs > MASTERDATA_CONFIG.PULL_BUDGET_MS;
}

function setLastProcessedRun_(runId) {
  try {
    scriptProps_().setProperty(MASTERDATA_CONFIG.LAST_PROCESSED_RUN_PROPERTY, runId);
  } catch (err) {
    console.log('pollInbox: cannot set LAST_PROCESSED_RUN: ' + errorMessage_(err));
  }
}

// Ends an Inbox run as failed: the fail action (discard + FAILED row), LAST_PROCESSED_RUN = runId,
// and its Inbox files trashed. Throws only when no FAILED row could be written.
function failInboxRun_(runId, reason, startedAt) {
  return failInboxFiles_(runId, reason, startedAt, true);
}

// failInboxRun_ with LAST_PROCESSED_RUN left alone unless markProcessed.
function failInboxFiles_(runId, reason, startedAt, markProcessed) {
  try {
    handleFail_({ runId: runId, reason: reason, startedAt: startedAt });
  } catch (err) {
    // handleFail_ logs last, so nothing was logged yet.
    var row = logRun_(runId, startedAt || '', nowIso_(), '');
    writeLogRows_(spreadsheet_(), logRows_(row, [], 'FAILED', reason + '; cleanup failed: ' + errorMessage_(err)));
  }
  if (markProcessed) setLastProcessedRun_(runId);
  trashRunFiles_(runId);
  return { status: 'failed', runId: runId, error: reason };
}

// Ends an Inbox run after its commit (which logged OK, or FAILED and discarded the run itself).
function endInboxRun_(runId, res) {
  setLastProcessedRun_(runId);
  trashRunFiles_(runId);
  if (!res.ok) return { status: 'failed', runId: runId, error: res.error };
  if (res.warning) return { status: 'committed', runId: runId, warning: res.warning };
  return { status: 'committed', runId: runId };
}

function findManifestFeed_(m, feed) {
  for (var i = 0; i < m.feeds.length; i++) if (m.feeds[i].feed === feed) return m.feeds[i];
  return null;
}

// Begins (once) and stages one Inbox run until it is committed, failed or the time budget is used up.
// current.startedAt is filled in for the caller's unexpected-error path.
function processInboxRun_(entry, startMs, current) {
  var runId = entry.runId;
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

  for (var k = 0; k < run.feeds.length; k++) {
    var f = run.feeds[k];
    if (f.staged >= f.rowCount) continue;
    if (overBudget_(startMs)) return { status: 'staging', runId: runId };
    var rows = loaded[f.feed];
    if (!rows) {
      var mf = findManifestFeed_(m, f.feed);
      if (!mf) return failInboxRun_(runId, f.feed + ': not in the manifest', current.startedAt);
      var again = loadInboxRows_(mf);
      if (again.error) return failInboxRun_(runId, again.error, current.startedAt);
      rows = again.rows;
    }
    while (f.staged < f.rowCount) {
      if (overBudget_(startMs)) return { status: 'staging', runId: runId };
      var slice = rows.slice(f.staged, f.staged + MASTERDATA_CONFIG.PULL_SLICE_ROWS);
      var bad = stageRows_(run, f, f.seqs.length + 1, slice);
      if (bad) return failInboxRun_(runId, bad, current.startedAt);
    }
  }
  if (overBudget_(startMs)) return { status: 'staging', runId: runId };
  return endInboxRun_(runId, handleCommit_({ runId: runId }));
}

// One poll under the script lock. Returns {status: 'idle' | 'staging' | 'committed' | 'failed' | 'error', ...}.
function pollInboxLocked_(startMs) {
  var current = null;
  try {
    var props = scriptProps_();
    var inbox = listInbox_();
    if (props.getProperty(MASTERDATA_CONFIG.LAST_PULL_ERROR_PROPERTY) !== null) {
      props.deleteProperty(MASTERDATA_CONFIG.LAST_PULL_ERROR_PROPERTY);
    }
    trashOrphans_(inbox, startMs);
    var last = props.getProperty(MASTERDATA_CONFIG.LAST_PROCESSED_RUN_PROPERTY) || '';
    var ids = Object.keys(inbox.runs)
      .filter(function (id) {
        return inbox.runs[id].manifests.length > 0;
      })
      .sort();
    var pending = [];
    ids.forEach(function (id) {
      if (id > last) pending.push(id);
      else inbox.runs[id].files.forEach(trashQuietly_); // already processed; leftovers of an earlier poll
    });
    if (!pending.length) return { status: 'idle' };
    var runId = pending[0];
    current = { runId: runId, startedAt: null };
    // A runId ahead of the clock is never processed, so it cannot block later runs via LAST_PROCESSED_RUN.
    if (runId > maxRunId_(startMs)) return failInboxFiles_(runId, 'runId is in the future', null, false);
    return processInboxRun_(inbox.runs[runId], startMs, current);
  } catch (err) {
    return pullUnexpected_(err, current);
  }
}

// Unexpected exception: logged FAILED once (the run fails; outside a run, a repeated message is not logged
// again). Rethrown only when nothing could be logged.
function pullUnexpected_(err, current) {
  var message = errorMessage_(err);
  if (current) {
    try {
      return failInboxRun_(current.runId, 'unexpected error: ' + message, current.startedAt);
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

// Time-driven trigger handler (every PULL_EVERY_MINUTES). Exits quietly when another execution holds the lock.
function pollInbox() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(MASTERDATA_CONFIG.PULL_LOCK_WAIT_MS)) return { status: 'busy' };
  try {
    return pollInboxLocked_(pullerNow_());
  } finally {
    lock.releaseLock();
  }
}

// Run once from the Apps Script editor (USER step). Replaces any pollInbox trigger with one that runs
// every PULL_EVERY_MINUTES minutes.
function installPullTrigger() {
  var handler = MASTERDATA_CONFIG.PULL_HANDLER;
  deleteTriggersFor_(handler);
  return ScriptApp.newTrigger(handler).timeBased().everyMinutes(MASTERDATA_CONFIG.PULL_EVERY_MINUTES).create();
}
