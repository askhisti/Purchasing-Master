// Pure functions (no Apps Script services). Plain JavaScript syntax so Node vm can load this file in tests.

// R22: numbers use 'General' ('0.######' renders integers as "1000." and consumers read display values).
var CORE_COLUMN_FORMATS_ = { string: '@', date: 'yyyy-mm-dd', number: 'General', boolean: 'General' };

// Message naming every feed whose row count fell by more than maxDrop versus prev, or null.
function checkRowDrop_(prev, next, maxDrop) {
  if (!prev) return null;
  var problems = [];
  Object.keys(next).forEach(function (feed) {
    var before = prev[feed];
    var after = next[feed];
    if (typeof before !== 'number' || before <= 0) return;
    var drop = (before - after) / before;
    if (drop > maxDrop) {
      problems.push(feed + ' ' + before + ' -> ' + after + ' (-' + Math.round(drop * 1000) / 10 + '%)');
    }
  });
  if (!problems.length) return null;
  return 'row drop over ' + Math.round(maxDrop * 100) + '% vs last successful run: ' + problems.join('; ');
}

function csvCell_(v) {
  if (v === null || v === undefined) return '';
  if (v === true) return 'TRUE';
  if (v === false) return 'FALSE';
  var s = String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// RFC 4180 CSV with \n line ends; every line (including the last) ends with \n.
function toCsv_(headers, rows) {
  var out = '';
  if (headers) out += headers.map(csvCell_).join(',') + '\n';
  for (var i = 0; i < rows.length; i++) out += rows[i].map(csvCell_).join(',') + '\n';
  return out;
}

function columnFormats_(types) {
  return types.map(function (t) {
    if (!Object.prototype.hasOwnProperty.call(CORE_COLUMN_FORMATS_, t)) throw new Error('unknown column type: ' + t);
    return CORE_COLUMN_FORMATS_[t];
  });
}

// run: {runId, started, finished, sourceRefreshedAt}; feeds: [{feed, rows}]. Columns = MASTERDATA_CONFIG.LOG_HEADERS.
function logRows_(run, feeds, status, message) {
  var list = feeds && feeds.length ? feeds : [{ feed: '', rows: '' }];
  return list.map(function (f) {
    return [run.runId || '', run.started || '', run.finished || '', f.feed, f.rows, run.sourceRefreshedAt || '', status, message || ''];
  });
}

// Days since the Unix epoch for a strict, real YYYY-MM-DD date, else null.
function dayNumber_(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
  if (!m) return null;
  var y = Number(m[1]);
  var mo = Number(m[2]);
  var d = Number(m[3]);
  var t = Date.UTC(y, mo - 1, d);
  var check = new Date(t);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return t / 86400000;
}

function isExpiredSnapshotFolder_(name, today, retentionDays) {
  var day = dayNumber_(name);
  var now = dayNumber_(today);
  if (day === null || now === null) return false;
  return now - day > retentionDays;
}

function sourceRefreshedAt_(health) {
  if (!health || typeof health !== 'object') return '';
  var v = function (k) {
    return health[k] === null || health[k] === undefined ? '' : String(health[k]);
  };
  return 'SC_EMS_PART=' + v('REFRESHED_AT_SC_EMS_PART') + '; COMPONENT_WHERE_USED=' + v('REFRESHED_AT_COMPONENT_WHERE_USED');
}

// R21: the snapshot date folder is the YYYY-MM-DD prefix of runId (Berlin time).
function snapshotDate_(runId) {
  return String(runId).slice(0, 10);
}

function partFileName_(feed, seq) {
  return feed + '.part' + ('000' + seq).slice(-4) + '.csv';
}

// Seq of a part file name for feed (any feed when feed is null), else null.
function partSeq_(name, feed) {
  var m = /^([A-Za-z0-9_]+)\.part(\d{4,})\.csv$/.exec(name);
  if (!m || (feed !== null && feed !== undefined && m[1] !== feed)) return null;
  return Number(m[2]);
}

// runId format YYYY-MM-DDTHH-mm-ss (Berlin) with a real calendar date.
function isRunId_(runId) {
  return typeof runId === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/.test(runId) && dayNumber_(runId.slice(0, 10)) !== null;
}

function isNonNegInt_(n) {
  return typeof n === 'number' && isFinite(n) && Math.floor(n) === n && n >= 0;
}

// Error message for a malformed begin request, else null. A begin must list every tab in TABS exactly once.
function validateBegin_(req) {
  var everyTab = 'begin must list every tab';
  if (!isRunId_(req.runId)) return 'bad runId';
  if (!isNonNegInt_(req.baseYear)) return 'bad baseYear';
  if (!Array.isArray(req.feeds) || req.feeds.length !== MASTERDATA_CONFIG.TABS.length) return everyTab;
  var seenFeeds = {};
  var seenTabs = {};
  for (var i = 0; i < req.feeds.length; i++) {
    var f = req.feeds[i];
    if (!f || typeof f !== 'object') return 'bad feed';
    if (typeof f.feed !== 'string' || !/^[A-Za-z0-9_]+$/.test(f.feed)) return 'bad feed name';
    if (MASTERDATA_CONFIG.TABS.indexOf(f.tab) < 0 || seenTabs[f.tab]) return everyTab;
    if (seenFeeds[f.feed]) return f.feed + ': duplicate feed';
    seenFeeds[f.feed] = true;
    seenTabs[f.tab] = true;
    if (!Array.isArray(f.headers) || !f.headers.length) return f.feed + ': no headers';
    for (var h = 0; h < f.headers.length; h++) {
      if (typeof f.headers[h] !== 'string' || f.headers[h] === '') return f.feed + ': bad header';
    }
    if (!Array.isArray(f.types) || f.types.length !== f.headers.length) return f.feed + ': types do not match headers';
    for (var t = 0; t < f.types.length; t++) {
      if (!Object.prototype.hasOwnProperty.call(CORE_COLUMN_FORMATS_, f.types[t])) return f.feed + ': bad type ' + f.types[t];
    }
    if (!isNonNegInt_(f.rowCount)) return f.feed + ': bad rowCount';
  }
  return null;
}

// Error message unless rows is an array of width-long arrays of string|number|boolean|null, else null.
function validateRows_(rows, width) {
  if (!Array.isArray(rows)) return 'rows is not an array';
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (!Array.isArray(r) || r.length !== width) return 'row ' + i + ' does not have ' + width + ' columns';
    for (var j = 0; j < r.length; j++) {
      var v = r[j];
      var ok = v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && isFinite(v));
      if (!ok) return 'row ' + i + ' column ' + j + ' has an unsupported value';
    }
  }
  return null;
}
