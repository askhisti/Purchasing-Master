// Staging tabs, swap into live tabs, _Refresh_Log. Plain JavaScript syntax so Node vm can load this file in tests.

function spreadsheet_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function stagingName_(tab) {
  return MASTERDATA_CONFIG.STAGING_PREFIX + tab;
}

function clearStagingTabs_(ss) {
  ss.getSheets().forEach(function (sheet) {
    if (sheet.getName().indexOf(MASTERDATA_CONFIG.STAGING_PREFIX) === 0) ss.deleteSheet(sheet);
  });
}

// Grows the grid so that rows x cols fit (writing outside the grid throws in Sheets).
function ensureSize_(sheet, rows, cols) {
  var maxRows = sheet.getMaxRows();
  if (rows > maxRows) sheet.insertRowsAfter(maxRows, rows - maxRows);
  var maxCols = sheet.getMaxColumns();
  if (cols > maxCols) sheet.insertColumnsAfter(maxCols, cols - maxCols);
}

// Number formats first, then values, so Sheets never converts text such as '0402' or 'MAR-12'.
function writeBlock_(sheet, row, values, formats) {
  if (!values.length) return;
  var width = values[0].length;
  ensureSize_(sheet, row + values.length - 1, width);
  var range = sheet.getRange(row, 1, values.length, width);
  range.setNumberFormats(values.map(function () { return formats; }));
  range.setValues(values);
}

function textFormats_(n) {
  var out = [];
  for (var i = 0; i < n; i++) out.push('@');
  return out;
}

// Hidden __staging_<tab> with the header row only.
function createStagingTab_(ss, tab, headers) {
  var sheet = ss.insertSheet(stagingName_(tab));
  writeBlock_(sheet, 1, [headers], textFormats_(headers.length));
  sheet.hideSheet();
  return sheet;
}

function appendStagedRows_(ss, tab, startRow, rows, formats) {
  var sheet = ss.getSheetByName(stagingName_(tab));
  if (!sheet) throw new Error('staging tab missing for ' + tab);
  writeBlock_(sheet, startRow, rows, formats);
}

// R23: swap keeps each live tab's identity (gid links, formulas, filters survive).
// items: [{tab, rows, cols}] = the staged extent (header + data rows, header width).
// Live tab missing: the staging tab is renamed and shown. Otherwise the staged block (values + formats)
// is copied onto the live tab, leftovers below/right of it are cleared, and the staging tab is deleted.
function swapStagingToLive_(ss, items) {
  items.forEach(function (it) {
    if (!ss.getSheetByName(stagingName_(it.tab))) throw new Error('staging tab missing for ' + it.tab);
  });
  items.forEach(function (it) {
    var staging = ss.getSheetByName(stagingName_(it.tab));
    var live = ss.getSheetByName(it.tab);
    if (!live) {
      staging.setName(it.tab);
      staging.showSheet();
      return;
    }
    var r = it.rows;
    var c = it.cols;
    ensureSize_(live, r, c);
    staging.getRange(1, 1, r, c).copyTo(live.getRange(1, 1));
    var maxRows = live.getMaxRows();
    var maxCols = live.getMaxColumns();
    if (maxRows > r) clearBlock_(live.getRange(r + 1, 1, maxRows - r, maxCols));
    if (maxCols > c) clearBlock_(live.getRange(1, c + 1, r, maxCols - c));
    ss.deleteSheet(staging);
  });
  orderTabs_(ss);
}

function clearBlock_(range) {
  range.clearContent();
  range.clearFormat();
}

// Live tabs in TABS order, then _Refresh_Log, then any other sheets in their existing order.
function orderTabs_(ss) {
  var pos = 1;
  MASTERDATA_CONFIG.TABS.concat([MASTERDATA_CONFIG.LOG_SHEET]).forEach(function (name) {
    var sheet = ss.getSheetByName(name);
    if (!sheet) return;
    ss.setActiveSheet(sheet);
    ss.moveActiveSheet(pos);
    pos++;
  });
}

// _Refresh_Log: A1 'Last successful refresh' / B1 ISO time, A2 'Base year' / B2, headers in row 4, rows from row 5.
function ensureLogSheet_(ss) {
  var sheet = ss.getSheetByName(MASTERDATA_CONFIG.LOG_SHEET);
  if (sheet) return sheet;
  sheet = ss.insertSheet(MASTERDATA_CONFIG.LOG_SHEET);
  writeBlock_(sheet, 1, [['Last successful refresh', ''], ['Base year', '']], ['@', '@']);
  var headers = MASTERDATA_CONFIG.LOG_HEADERS;
  writeBlock_(sheet, 4, [headers], textFormats_(headers.length));
  return sheet;
}

// Inserts rows (newest first) at row LOG_FIRST_ROW, above earlier entries.
function writeLogRows_(ss, rows) {
  if (!rows.length) return;
  var sheet = ensureLogSheet_(ss);
  var first = MASTERDATA_CONFIG.LOG_FIRST_ROW;
  if (sheet.getMaxRows() >= first) sheet.insertRowsBefore(first, rows.length);
  // Rows is a number; every other column is text (run ids and ISO times must not become dates).
  writeBlock_(sheet, first, rows, ['@', '@', '@', '@', '0', '@', '@', '@']);
}

function setLastSuccess_(ss, isoTime, baseYear) {
  var sheet = ensureLogSheet_(ss);
  writeBlock_(sheet, 1, [['Last successful refresh', isoTime]], ['@', '@']);
  writeBlock_(sheet, 2, [['Base year', baseYear]], ['@', '0']);
}
