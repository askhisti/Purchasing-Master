// Script Properties, chunk decoding and Drive snapshots. Plain JavaScript syntax so Node vm can load this file in tests.

function getJsonProperty_(key) {
  var s = PropertiesService.getScriptProperties().getProperty(key);
  return s ? JSON.parse(s) : null;
}

function setJsonProperty_(key, value) {
  PropertiesService.getScriptProperties().setProperty(key, JSON.stringify(value));
}

// {runId, date, baseYear, started, sourceRefreshedAt, feeds:[{feed, tab, headers, types, rowCount, staged, seqs}]}
function getActiveRun_() {
  return getJsonProperty_(MASTERDATA_CONFIG.ACTIVE_RUN_PROPERTY);
}

function setActiveRun_(run) {
  setJsonProperty_(MASTERDATA_CONFIG.ACTIVE_RUN_PROPERTY, run);
}

function clearActiveRun_() {
  PropertiesService.getScriptProperties().deleteProperty(MASTERDATA_CONFIG.ACTIVE_RUN_PROPERTY);
}

function getLastRowCounts_() {
  return getJsonProperty_(MASTERDATA_CONFIG.LAST_ROW_COUNTS_PROPERTY);
}

function setLastRowCounts_(counts) {
  setJsonProperty_(MASTERDATA_CONFIG.LAST_ROW_COUNTS_PROPERTY, counts);
}

// JSON value of gzip-compressed UTF-8 bytes (Byte[]).
function gunzipJson_(bytes) {
  var json = Utilities.ungzip(Utilities.newBlob(bytes, 'application/x-gzip')).getDataAsString('UTF-8');
  return JSON.parse(json);
}

// rowsB64Gzip = base64(gzip(JSON.stringify(rows))).
function decodeRows_(rowsB64Gzip) {
  if (typeof rowsB64Gzip !== 'string' || rowsB64Gzip === '') throw new Error('missing rowsB64Gzip');
  return gunzipJson_(Utilities.base64Decode(rowsB64Gzip));
}

// DriveApp iterators can include trashed items, so every lookup skips them.
function childFolder_(parent, name, create) {
  var it = parent.getFoldersByName(name);
  while (it.hasNext()) {
    var folder = it.next();
    if (!folder.isTrashed()) return folder;
  }
  return create ? parent.createFolder(name) : null;
}

function snapshotRoot_() {
  return childFolder_(DriveApp.getFolderById(MASTERDATA_CONFIG.FOLDER_ID), MASTERDATA_CONFIG.SNAPSHOT_FOLDER_NAME, true);
}

function snapshotDateFolder_(date, create) {
  return childFolder_(snapshotRoot_(), date, create);
}

// [{file, seq}] of part files in folder for feed (all feeds when feed is null), in numeric seq order.
function listParts_(folder, feed) {
  var parts = [];
  var it = folder.getFiles();
  while (it.hasNext()) {
    var file = it.next();
    if (file.isTrashed()) continue;
    var seq = partSeq_(file.getName(), feed);
    if (seq !== null) parts.push({ file: file, seq: seq });
  }
  parts.sort(function (a, b) {
    return a.seq - b.seq;
  });
  return parts;
}

// Trashes a run's working files in the date folder: part files and unpromoted <feed>.csv.tmp files.
function deleteRunFiles_(date) {
  var folder = snapshotDateFolder_(date, false);
  if (!folder) return;
  var it = folder.getFiles();
  while (it.hasNext()) {
    var file = it.next();
    if (file.isTrashed()) continue;
    var name = file.getName();
    if (partSeq_(name, null) !== null || /\.csv\.tmp$/.test(name)) file.setTrashed(true);
  }
}

function trashFilesNamed_(folder, name) {
  var it = folder.getFilesByName(name);
  while (it.hasNext()) {
    var file = it.next();
    if (!file.isTrashed()) file.setTrashed(true);
  }
}

// Creates name in folder, trashing any existing files of the same name first.
function replaceFile_(folder, name, content) {
  trashFilesNamed_(folder, name);
  return folder.createFile(name, content, 'text/csv');
}

function savePart_(date, feed, seq, csv) {
  replaceFile_(snapshotDateFolder_(date, true), partFileName_(feed, seq), csv);
}

// <feed>.csv.tmp = header + parts in seq order; the parts are then trashed. promoteSnapshot_ makes it <feed>.csv.
// A live .tmp is complete (written in one createFile, and begin removes older ones): a retried commit keeps it
// and only trashes parts left over, so parts already trashed are never lost.
function assembleSnapshot_(date, feed, headers) {
  var folder = snapshotDateFolder_(date, true);
  var parts = listParts_(folder, feed);
  var it = folder.getFilesByName(feed + '.csv.tmp');
  while (it.hasNext()) {
    if (it.next().isTrashed()) continue;
    parts.forEach(function (p) {
      p.file.setTrashed(true);
    });
    return;
  }
  var content = toCsv_(headers, []);
  parts.forEach(function (p) {
    content += p.file.getBlob().getDataAsString('UTF-8');
  });
  replaceFile_(folder, feed + '.csv.tmp', content);
  parts.forEach(function (p) {
    p.file.setTrashed(true);
  });
}

// After a successful swap: <feed>.csv.tmp replaces a same-date <feed>.csv, so a failed run never overwrites a good snapshot.
function promoteSnapshot_(date, feed) {
  var folder = snapshotDateFolder_(date, false);
  var tmp = null;
  if (folder) {
    var it = folder.getFilesByName(feed + '.csv.tmp');
    while (it.hasNext() && !tmp) {
      var file = it.next();
      if (!file.isTrashed()) tmp = file;
    }
  }
  if (!tmp) throw new Error(feed + '.csv.tmp missing');
  trashFilesNamed_(folder, feed + '.csv');
  tmp.setName(feed + '.csv');
}

// Trashes date folders older than RETENTION_DAYS before today (YYYY-MM-DD). Returns their names.
function pruneSnapshots_(today) {
  var pruned = [];
  var it = snapshotRoot_().getFolders();
  while (it.hasNext()) {
    var folder = it.next();
    if (folder.isTrashed()) continue;
    if (isExpiredSnapshotFolder_(folder.getName(), today, MASTERDATA_CONFIG.RETENTION_DAYS)) {
      folder.setTrashed(true);
      pruned.push(folder.getName());
    }
  }
  return pruned;
}
