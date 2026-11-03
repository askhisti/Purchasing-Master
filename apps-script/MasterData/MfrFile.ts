// Manufacturer file: menu, dialog handlers and the writer of the shared spreadsheet.
// Plain JavaScript syntax (no type annotations) so Node vm can load this file in tests.

var MFR_GREY_ = '#d9d9d9';

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

// B2 of _Refresh_Log when it is a year 2000..2100 (a number or a digit string), else the current Berlin year.
function mfrBaseYear_(ss) {
  var v = mfrLogValue_(ss, 2);
  var n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
  if (Math.floor(n) === n && n >= 2000 && n <= 2100) return n;
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
      ' (Berlin) from MasterData, data refreshed' + (refreshedAt === '' ? ': unknown' : ' ' + refreshedAt), false],
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

// A new protection mirrors the spreadsheet's permissions until its editor list is changed: the file owner is added
// explicitly first (so the list is set), then every other editor is removed and domain edit is switched off.
// An editor that cannot be removed (e.g. the current user) is counted and logged, not fatal.
function mfrLock_(protection, owner) {
  protection.addEditor(owner);
  var failed = 0;
  protection.getEditors().forEach(function (u) {
    if (u.getEmail() === owner.getEmail()) return;
    try { protection.removeEditor(u); } catch (e) { failed++; }
  });
  if (failed) console.warn('mfrLock_: ' + failed + ' editor(s) could not be removed from "' + protection.getDescription() + '"');
  if (protection.canDomainEdit()) protection.setDomainEdit(false);
  return protection;
}

// Header row as text, so a header such as '2026-01' is never turned into a date.
function mfrWriteHeader_(sheet, headers) {
  sheet.getRange(1, 1, 1, headers.length).setNumberFormat('@').setValues([headers]).setFontWeight('bold');
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
  var folder = mfrFolder_(); // before the file exists, so a Drive problem here leaves nothing behind
  var file = SpreadsheetApp.create(name);
  var driveFile = DriveApp.getFileById(file.getId());
  var owner = driveFile.getOwner();

  var readMe = file.getSheets()[0].setName('Read me');
  var ours = file.insertSheet('Our parts', 1);
  var alts = file.insertSheet('Your alternatives', 2);
  var price = file.insertSheet('Your pricing', 3);
  var n = built.parts.length;

  // Read me
  var lines = mfrReadMeLines_(manufacturer, selection, baseYear, mfrRefreshedAt_(ss), now);
  readMe.setColumnWidth(1, 900);
  readMe.getRange(1, 1).setNumberFormat('@');
  readMe.getRange(1, 1, lines.length, 1).setValues(lines.map(function (l) { return [l[0]]; }));
  lines.forEach(function (l, i) { if (l[1]) readMe.getRange(i + 1, 1).setFontWeight('bold'); });
  mfrLock_(readMe.protect().setDescription('Read-only'), owner);

  // Our parts: Category .. Volume Type are text; the volume and month columns that follow are numbers.
  var width = built.headers.length;
  var textCols = built.headers.indexOf('Volume Type') + 1;
  mfrEnsureSize_(ours, built.rows.length + 1, width);
  mfrWriteHeader_(ours, built.headers);
  ours.getRange(2, 1, built.rows.length, textCols).setNumberFormat('@');
  ours.getRange(2, textCols + 1, built.rows.length, width - textCols).setNumberFormat('General');
  mfrWriteRows_(ours, 2, built.rows, width);
  ours.setFrozenRows(1);
  mfrLock_(ours.protect().setDescription('Read-only'), owner);

  // Your alternatives
  var altHeaders = ['ME_EC', 'Manufacturer', 'MPN', 'Description', 'Your Alternative MPN',
    'Drop-in Replacement (Yes/No)', 'Differences', 'Datasheet Link', 'Comment'];
  mfrEnsureSize_(alts, n + 1, altHeaders.length);
  mfrWriteHeader_(alts, altHeaders);
  alts.getRange(2, 1, n, altHeaders.length).setNumberFormat('@'); // all text, the input columns E-I too
  mfrWriteRows_(alts, 2, built.parts.map(function (p) {
    return [p.meEc, p.manufacturer, p.mpn, p.description, '', '', '', '', ''];
  }), altHeaders.length);
  alts.getRange(2, 1, n, 4).setBackground(MFR_GREY_);
  alts.getRange(2, 6, n, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['Yes', 'No'], true).setAllowInvalid(false).build());
  alts.setFrozenRows(1);
  mfrLock_(alts.protect().setDescription('Fill in columns E to I only')
    .setUnprotectedRanges([alts.getRange(2, 5, n, 5)]), owner);

  // Your pricing
  var priceHeaders = ['ME_EC', 'Manufacturer', 'MPN', 'Quoted MPN', 'Currency', 'MOQ', 'Lead Time (weeks)'];
  for (var i = 0; i < cfg.MFR_PRICE_YEARS; i++) priceHeaders.push('Price ' + (baseYear + i));
  priceHeaders.push('Valid Until', 'Comment');
  var pw = priceHeaders.length;
  var extra = cfg.MFR_EXTRA_PRICE_ROWS;
  mfrEnsureSize_(price, n + extra + 1, pw);
  mfrWriteHeader_(price, priceHeaders);
  // Part rows and extra rows: text, except MOQ, Lead Time (weeks) and the Price <year> columns.
  var numeric = ['MOQ', 'Lead Time (weeks)'];
  var rowFormats = priceHeaders.map(function (h) {
    return numeric.indexOf(h) >= 0 || /^Price \d{4}$/.test(h) ? 'General' : '@';
  });
  var formats = [];
  for (var r = 0; r < n + extra; r++) formats.push(rowFormats);
  price.getRange(2, 1, n + extra, pw).setNumberFormats(formats);
  mfrWriteRows_(price, 2, built.parts.map(function (p) {
    var row = [p.meEc, p.manufacturer, p.mpn];
    while (row.length < pw) row.push('');
    return row;
  }), pw);
  price.getRange(2, 1, n, 3).setBackground(MFR_GREY_);
  price.setFrozenRows(1);
  mfrLock_(price.protect().setDescription('Fill in columns D onward only')
    .setUnprotectedRanges([price.getRange(2, 4, n, pw - 3), price.getRange(n + 2, 1, extra, pw)]), owner);

  // Protections are made while the file is still in the creator's My Drive; moving it afterwards.
  try {
    driveFile.moveTo(folder);
  } catch (e) {
    try { driveFile.setTrashed(true); } catch (trashErr) { /* the move error is the one reported */ }
    throw new Error('Could not save the file in the Manufacturer files folder: ' + errorMessage_(e));
  }

  return {
    url: file.getUrl(),
    xlsxUrl: 'https://docs.google.com/spreadsheets/d/' + file.getId() + '/export?format=xlsx',
    name: name,
    rowCount: built.rows.length,
  };
}
