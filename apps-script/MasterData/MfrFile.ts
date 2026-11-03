// Manufacturer file: menu, dialog handlers and the writer of the shared spreadsheet.
// Plain JavaScript syntax (no type annotations) so Node vm can load this file in tests.

var MFR_GREY_ = '#d9d9d9';
var MFR_OUR_TEXT_COLUMNS_ = 12; // Category .. Volume Type; the volume and month columns follow.

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('MasterData')
    .addItem('Create manufacturer file…', 'showManufacturerFileDialog')
    .addToUi();
}

function showManufacturerFileDialog() {
  var html = HtmlService.createHtmlOutputFromFile('MfrDialog').setWidth(560).setHeight(680);
  SpreadsheetApp.getUi().showModalDialog(html, 'Create manufacturer file');
}

function mfrReadTab_(ss, name) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error('Tab ' + name + ' not found. Run the refresh first.');
  return mfrTable_(sheet.getDataRange().getValues());
}

function mfrLogValue_(ss, row) {
  var sheet = ss.getSheetByName(MASTERDATA_CONFIG.LOG_SHEET);
  return sheet ? sheet.getRange(row, 2).getValue() : '';
}

function mfrBaseYear_(ss) {
  var v = mfrLogValue_(ss, 2);
  var n = Number(v);
  if (v !== '' && v !== null && isFinite(n) && Math.floor(n) === n) return n;
  return Number(Utilities.formatDate(new Date(), MASTERDATA_CONFIG.TIME_ZONE, 'yyyy'));
}

// B1 of _Refresh_Log is an ISO UTC string; shown as Berlin time (the raw text when it does not parse).
function mfrRefreshedAt_(ss) {
  var v = mfrLogValue_(ss, 1);
  if (v === '' || v === null) return '';
  var d = v instanceof Date ? v : new Date(String(v));
  if (isNaN(d.getTime())) return String(v);
  return Utilities.formatDate(d, MASTERDATA_CONFIG.TIME_ZONE, 'yyyy-MM-dd HH:mm');
}

function getManufacturerFileOptions(onlyUsed) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var components = mfrReadTab_(ss, 'Components');
  var bomSources = mfrReadTab_(ss, 'BOM_Sources');
  return {
    tree: mfrCategoryTree_(components, bomSources, !!onlyUsed),
    baseYear: mfrBaseYear_(ss),
    refreshedAt: mfrRefreshedAt_(ss),
  };
}

function mfrEnsureSize_(sheet, rows, cols) {
  if (sheet.getMaxRows() < rows) sheet.insertRowsAfter(sheet.getMaxRows(), rows - sheet.getMaxRows());
  if (sheet.getMaxColumns() < cols) sheet.insertColumnsAfter(sheet.getMaxColumns(), cols - sheet.getMaxColumns());
}

// Writes rows below `startRow` in slices so one call never carries a huge block.
function mfrWriteRows_(sheet, startRow, rows, width) {
  var step = Math.max(1, Math.floor(50000 / width));
  for (var i = 0; i < rows.length; i += step) {
    var slice = rows.slice(i, i + step);
    sheet.getRange(startRow + i, 1, slice.length, width).setValues(slice);
  }
}

function mfrFolder_() {
  var root = DriveApp.getFolderById(MASTERDATA_CONFIG.FOLDER_ID);
  var it = root.getFoldersByName(MASTERDATA_CONFIG.MFR_FOLDER_NAME);
  while (it.hasNext()) {
    var f = it.next();
    if (!f.isTrashed()) return f;
  }
  return root.createFolder(MASTERDATA_CONFIG.MFR_FOLDER_NAME);
}

function mfrReadMeLines_(manufacturer, selection, baseYear, refreshedAt, now) {
  var cats = selection.map(function (s) { return s.category + ' / ' + s.subcategory; }).join(', ');
  return [
    ['Component overview for ' + manufacturer, false],
    ['Generated ' + Utilities.formatDate(now, MASTERDATA_CONFIG.TIME_ZONE, 'yyyy-MM-dd HH:mm') +
      ' (Berlin) from MasterData, data refreshed ' + refreshedAt, false],
    ['Categories: ' + cats, false],
    ['', false],
    ["Months are the finished product's planned build/shipment month at the EMS. There is no lead-time offset: order your components earlier.", true],
    ['From ' + (baseYear + 2) + ' on, volumes are a yearly plan, not a build schedule.', true],
    ['Rows marked "Potential volume if sourced" are alternative sources: the volume is what that part would get if it were used for the whole BOM line. It is not demand and must not be added to the primary source\'s volume.', true],
    ['Volumes are plans, not orders.', true],
    ['', false],
    ['How to answer:', false],
    ['Sheet "Your alternatives": enter your own part number against our parts where you have a drop-in or near alternative.', false],
    ['Sheet "Your pricing": enter your prices per year; add rows below for alternative part numbers you propose.', false],
    ['Please do not change the grey columns.', false],
  ];
}

function createManufacturerFile(form) {
  var cfg = MASTERDATA_CONFIG;
  form = form || {};
  var manufacturer = String(form.manufacturer === null || form.manufacturer === undefined ? '' : form.manufacturer).trim();
  if (manufacturer === '') throw new Error('Enter the manufacturer name.');
  var selection = (form.selection || []).map(function (s) {
    return { category: String(s.category), subcategory: String(s.subcategory) };
  });
  if (!selection.length) throw new Error('Select at least one category.');
  var onlyUsed = form.onlyUsed !== false;

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var input = {
    components: mfrReadTab_(ss, 'Components'),
    bomSources: mfrReadTab_(ss, 'BOM_Sources'),
    bomMonthly: mfrReadTab_(ss, 'BOM_Demand_Monthly'),
  };
  var baseYear = mfrBaseYear_(ss);
  var built = mfrBuildRows_(input, selection, onlyUsed, baseYear);
  if (!built.rows.length) throw new Error('No parts match the selection.');
  if (built.rows.length * built.headers.length > cfg.MFR_MAX_CELLS) {
    throw new Error('The selection is too large; select fewer categories.');
  }

  var now = new Date();
  var name = manufacturer + ' - component overview - ' + Utilities.formatDate(now, cfg.TIME_ZONE, 'yyyy-MM-dd');
  var file = SpreadsheetApp.create(name);
  DriveApp.getFileById(file.getId()).moveTo(mfrFolder_());

  var readMe = file.getSheets()[0].setName('Read me');
  var ours = file.insertSheet('Our parts', 1);
  var alts = file.insertSheet('Your alternatives', 2);
  var price = file.insertSheet('Your pricing', 3);
  var n = built.parts.length;

  // Read me
  var lines = mfrReadMeLines_(manufacturer, selection, baseYear, mfrRefreshedAt_(ss), now);
  readMe.setColumnWidth(1, 900);
  readMe.getRange(1, 1, lines.length, 1).setValues(lines.map(function (l) { return [l[0]]; }));
  lines.forEach(function (l, i) { if (l[1]) readMe.getRange(i + 1, 1).setFontWeight('bold'); });

  // Our parts
  var width = built.headers.length;
  mfrEnsureSize_(ours, built.rows.length + 1, width);
  ours.getRange(1, 1, built.rows.length + 1, MFR_OUR_TEXT_COLUMNS_).setNumberFormat('@');
  ours.getRange(1, MFR_OUR_TEXT_COLUMNS_ + 1, built.rows.length + 1, width - MFR_OUR_TEXT_COLUMNS_).setNumberFormat('General');
  ours.getRange(1, 1, 1, width).setValues([built.headers]).setFontWeight('bold');
  mfrWriteRows_(ours, 2, built.rows, width);
  ours.setFrozenRows(1);
  ours.protect().setDescription('Read-only');

  // Your alternatives
  var altHeaders = ['ME_EC', 'Manufacturer', 'MPN', 'Description', 'Your Alternative MPN',
    'Drop-in Replacement (Yes/No)', 'Differences', 'Datasheet Link', 'Comment'];
  mfrEnsureSize_(alts, n + 1, altHeaders.length);
  alts.getRange(1, 1, 1, altHeaders.length).setValues([altHeaders]).setFontWeight('bold');
  alts.getRange(2, 1, n, 4).setNumberFormat('@');
  mfrWriteRows_(alts, 2, built.parts.map(function (p) {
    return [p.meEc, p.manufacturer, p.mpn, p.description, '', '', '', '', ''];
  }), altHeaders.length);
  alts.getRange(2, 1, n, 4).setBackground(MFR_GREY_);
  alts.getRange(2, 6, n, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['Yes', 'No'], true).setAllowInvalid(false).build());
  alts.setFrozenRows(1);
  alts.protect().setDescription('Fill in columns E to I only')
    .setUnprotectedRanges([alts.getRange(2, 5, n, 5)]);

  // Your pricing
  var priceHeaders = ['ME_EC', 'Manufacturer', 'MPN', 'Quoted MPN', 'Currency', 'MOQ', 'Lead Time (weeks)'];
  for (var i = 0; i < cfg.MFR_PRICE_YEARS; i++) priceHeaders.push('Price ' + (baseYear + i));
  priceHeaders.push('Valid Until', 'Comment');
  var pw = priceHeaders.length;
  var extra = cfg.MFR_EXTRA_PRICE_ROWS;
  mfrEnsureSize_(price, n + extra + 1, pw);
  price.getRange(1, 1, 1, pw).setValues([priceHeaders]).setFontWeight('bold');
  price.getRange(2, 1, n, 3).setNumberFormat('@');
  mfrWriteRows_(price, 2, built.parts.map(function (p) {
    var row = [p.meEc, p.manufacturer, p.mpn];
    while (row.length < pw) row.push('');
    return row;
  }), pw);
  price.getRange(2, 1, n, 3).setBackground(MFR_GREY_);
  price.setFrozenRows(1);
  price.protect().setDescription('Fill in columns D onward only')
    .setUnprotectedRanges([price.getRange(2, 4, n, pw - 3), price.getRange(n + 2, 1, extra, pw)]);

  return {
    url: file.getUrl(),
    xlsxUrl: 'https://docs.google.com/spreadsheets/d/' + file.getId() + '/export?format=xlsx',
    name: name,
    rowCount: built.rows.length,
  };
}
