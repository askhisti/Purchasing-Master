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

// rowsB64Gzip = base64(gzip(JSON.stringify(rows))).
function decodeRows_(rowsB64Gzip) {
  if (typeof rowsB64Gzip !== 'string' || rowsB64Gzip === '') throw new Error('missing rowsB64Gzip');
  var bytes = Utilities.base64Decode(rowsB64Gzip);
  var json = Utilities.ungzip(Utilities.newBlob(bytes, 'application/x-gzip')).getDataAsString('UTF-8');
  return JSON.parse(json);
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

function deletePartFiles_(date) {
  var folder = snapshotDateFolder_(date, false);
  if (!folder) return;
  listParts_(folder, null).forEach(function (p) {
    p.file.setTrashed(true);
  });
}

// Creates name in folder, trashing any existing files of the same name first.
function replaceFile_(folder, name, content) {
  var it = folder.getFilesByName(name);
  while (it.hasNext()) {
    var file = it.next();
    if (!file.isTrashed()) file.setTrashed(true);
  }
  return folder.createFile(name, content, 'text/csv');
}

function savePart_(date, feed, seq, csv) {
  replaceFile_(snapshotDateFolder_(date, true), partFileName_(feed, seq), csv);
}

// <feed>.csv = header + parts in seq order, replacing a same-date <feed>.csv; the parts are then trashed.
function assembleSnapshot_(date, feed, headers) {
  var folder = snapshotDateFolder_(date, true);
  var parts = listParts_(folder, feed);
  var content = toCsv_(headers, []);
  parts.forEach(function (p) {
    content += p.file.getBlob().getDataAsString('UTF-8');
  });
  replaceFile_(folder, feed + '.csv', content);
  parts.forEach(function (p) {
    p.file.setTrashed(true);
  });
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
