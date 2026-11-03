// In-memory fakes of the Apps Script services used by apps-script/MasterData.
// Each fake encodes an assumption about real Apps Script behaviour; see task-8-report.md.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';

// The nine feeds added after the first six, one minimal definition each (feed name = lower-cased tab).
export const NEW_FEED_TABS = ['Product_Volumes', 'Component_Demand_Monthly', 'BOM_Demand_Monthly', 'BOM_Sources', 'Price_At_Demand', 'Savings_Levers', 'Quote_Health', 'Multisource_Health', 'BOM_Coverage'];
export const NEW_FEED_DEFS = NEW_FEED_TABS.map((tab) => ({ feed: tab.toLowerCase(), tab, headers: ['ME_EC', 'Value'], types: ['string', 'number'] }));

// Owner of every spreadsheet SpreadsheetApp.create makes; an editor removeEditor refuses (the current user).
export const FAKE_OWNER = 'owner@example.com';
export const FAKE_UNREMOVABLE_EDITOR = 'self@example.com';

const DEFAULT_ROWS = 1000;
const DEFAULT_COLS = 26;

class FakeRange {
  constructor(sheet, row, col, numRows, numCols) {
    Object.assign(this, { sheet, row, col, numRows, numCols });
  }
  checkShape(values, what) {
    if (!Array.isArray(values) || values.length !== this.numRows || values.some((r) => !Array.isArray(r) || r.length !== this.numCols)) {
      throw new Error(`${what}: data does not match range ${this.numRows}x${this.numCols}`);
    }
  }
  setValues(values) {
    this.checkShape(values, 'setValues');
    this.sheet.ss.calls.push({ op: 'setValues', sheet: this.sheet.name, row: this.row, col: this.col, numRows: this.numRows, numCols: this.numCols });
    values.forEach((r, i) => r.forEach((v, j) => this.sheet.setCell(this.row + i, this.col + j, v)));
    return this;
  }
  setValue(v) { return this.setValues([[v]]); }
  // Notes attach to the top-left cell of the range (a multi-cell range is not used by the code).
  setNote(text) { this.sheet.notes[`${this.row},${this.col}`] = text; return this; }
  getNote() { return this.sheet.notes[`${this.row},${this.col}`] ?? ''; }
  getValues() {
    const out = [];
    for (let i = 0; i < this.numRows; i++) {
      const r = [];
      for (let j = 0; j < this.numCols; j++) r.push(this.sheet.getCell(this.row + i, this.col + j));
      out.push(r);
    }
    return out;
  }
  getValue() { return this.getValues()[0][0]; }
  setNumberFormats(formats) {
    this.checkShape(formats, 'setNumberFormats');
    this.sheet.ss.calls.push({
      op: 'setNumberFormats', sheet: this.sheet.name, row: this.row, col: this.col, numRows: this.numRows, numCols: this.numCols,
      formats: Array.from(formats, (r) => [...r]), // copy out of the vm realm
    });
    formats.forEach((r, i) => r.forEach((f, j) => this.sheet.setFormat(this.row + i, this.col + j, f)));
    return this;
  }
  setNumberFormat(f) { return this.setNumberFormats(Array.from({ length: this.numRows }, () => Array(this.numCols).fill(f))); }
  getNumberFormats() {
    return Array.from({ length: this.numRows }, (_, i) => Array.from({ length: this.numCols }, (_, j) => this.sheet.getFormat(this.row + i, this.col + j)));
  }
  each(fn) {
    for (let i = 0; i < this.numRows; i++) for (let j = 0; j < this.numCols; j++) fn(this.row + i, this.col + j, i, j);
  }
  // Real Range API names are singular (clearContent/clearFormat); Sheet has the plural ones.
  clearContent() {
    this.sheet.ss.calls.push({ op: 'clearContent', sheet: this.sheet.name, row: this.row, col: this.col, numRows: this.numRows, numCols: this.numCols });
    this.each((r, c) => { if (this.sheet.rows[r - 1]) this.sheet.rows[r - 1][c - 1] = undefined; });
    return this;
  }
  clearFormat() {
    this.sheet.ss.calls.push({ op: 'clearFormat', sheet: this.sheet.name, row: this.row, col: this.col, numRows: this.numRows, numCols: this.numCols });
    this.each((r, c) => this.sheet.setFormat(r, c, undefined));
    return this;
  }
  clear() { this.clearContent(); return this.clearFormat(); }
  setFontWeight(w) { this.sheet.ss.calls.push({ op: 'setFontWeight', sheet: this.sheet.name, a1: this.getA1Notation(), weight: w }); return this; }
  setBackground(color) { this.sheet.ss.calls.push({ op: 'setBackground', sheet: this.sheet.name, a1: this.getA1Notation(), color }); return this; }
  setDataValidation(rule) { this.sheet.validations.push({ a1: this.getA1Notation(), rule }); return this; }
  getA1Notation() {
    const letters = (n) => { let s = ''; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
    const a = `${letters(this.col)}${this.row}`;
    return this.numRows === 1 && this.numCols === 1 ? a : `${a}:${letters(this.col + this.numCols - 1)}${this.row + this.numRows - 1}`;
  }
  // Copies values and number formats; the destination's top-left cell anchors the block.
  // Assumption: the destination grid must already be large enough (the code grows it explicitly).
  copyTo(dest) {
    if (dest.sheet.ss !== this.sheet.ss) throw new Error('copyTo: target range must be in the same spreadsheet');
    const values = this.getValues();
    const formats = this.getNumberFormats();
    const target = dest.sheet.getRange(dest.row, dest.col, this.numRows, this.numCols); // throws if outside the grid
    this.sheet.ss.calls.push({ op: 'copyTo', sheet: this.sheet.name, to: dest.sheet.name, numRows: this.numRows, numCols: this.numCols });
    target.each((r, c, i, j) => {
      dest.sheet.setCell(r, c, values[i][j]);
      dest.sheet.setFormat(r, c, formats[i][j]);
    });
    return this;
  }
}

class FakeSheet {
  constructor(ss, name) {
    this.ss = ss;
    this.name = name;
    this.hidden = false;
    this.id = ++ss.nextId;
    this.rows = []; // rows[r-1][c-1]
    this.fmts = []; // fmts[r-1][c-1], undefined = never set / cleared
    this.notes = {}; // 'row,col' -> note text
    this.validations = []; // {a1, rule} recorded by setDataValidation
    this.protections = []; // FakeProtection list recorded by protect()
    this.frozenRows = 0;
    this.maxRows = DEFAULT_ROWS;
    this.maxCols = DEFAULT_COLS;
  }
  getName() { return this.name; }
  getSheetId() { return this.id; }
  setFrozenRows(n) { this.frozenRows = n; return this; }
  setColumnWidth() { return this; }
  protect() {
    if (this.ss.events) this.ss.events.push('protect:' + this.name);
    // Like real Sheet.protect(): editors mirror the spreadsheet and the domain can edit. A fresh My Drive file has
    // only its owner (ss.protectionEditors overrides the list); FAKE_UNREMOVABLE_EDITOR stands for the current user,
    // whom removeEditor refuses. Every editor change is recorded in calls.
    const user = (email) => ({ getEmail: () => email });
    const p = {
      description: '', unprotected: [], editors: (this.ss.protectionEditors || [FAKE_OWNER]).map(user), domainEdit: true, calls: [],
      getEditors() { return [...this.editors]; },
      addEditor(u) {
        const email = typeof u === 'string' ? u : u.getEmail();
        this.calls.push('addEditor:' + email);
        if (!this.editors.some((x) => x.getEmail() === email)) this.editors.push(user(email));
        return this;
      },
      removeEditor(u) {
        const email = typeof u === 'string' ? u : u.getEmail();
        this.calls.push('removeEditor:' + email);
        if (email === FAKE_OWNER) throw new Error('The owner cannot be removed from the protection.');
        if (email === FAKE_UNREMOVABLE_EDITOR) throw new Error('You cannot remove yourself from the protection.');
        this.editors = this.editors.filter((x) => x.getEmail() !== email);
        return this;
      },
      removeEditors(users) { Array.from(users).forEach((u) => this.removeEditor(u)); return this; },
      canDomainEdit() { return this.domainEdit; },
      setDomainEdit(b) { this.calls.push('setDomainEdit:' + b); this.domainEdit = b; return this; },
      setDescription(d) { this.description = d; return this; },
      getDescription() { return this.description; },
      setUnprotectedRanges(r) { this.unprotected = Array.from(r); return this; },
      getUnprotectedRanges() { return [...this.unprotected]; },
    };
    this.protections.push(p);
    return p;
  }
  setFormat(r, c, f) {
    while (this.fmts.length < r) this.fmts.push(undefined);
    if (!this.fmts[r - 1]) this.fmts[r - 1] = [];
    this.fmts[r - 1][c - 1] = f;
  }
  getFormat(r, c) {
    const row = this.fmts[r - 1];
    return row ? row[c - 1] : undefined;
  }
  setName(n) {
    if (this.ss.sheets.some((s) => s !== this && s.name === n)) throw new Error(`A sheet with the name "${n}" already exists.`);
    this.name = n;
    return this;
  }
  hideSheet() {
    if (this.ss.sheets.filter((s) => !s.hidden && s !== this).length === 0) throw new Error("You can't hide all the sheets in a document.");
    this.hidden = true;
    return this;
  }
  showSheet() { this.hidden = false; return this; }
  isSheetHidden() { return this.hidden; }
  getMaxRows() { return this.maxRows; }
  getMaxColumns() { return this.maxCols; }
  insertRowsAfter(after, n) {
    if (after < 1 || after > this.maxRows) throw new Error('insertRowsAfter: position out of range');
    // Inserted rows shift existing values and formats down.
    for (const grid of [this.rows, this.fmts]) {
      while (grid.length < after) grid.push(undefined);
      grid.splice(after, 0, ...Array.from({ length: n }, () => undefined));
    }
    this.maxRows += n;
    return this;
  }
  insertRowsBefore(before, n) {
    if (before < 1 || before > this.maxRows) throw new Error('insertRowsBefore: position out of range');
    for (const grid of [this.rows, this.fmts]) {
      while (grid.length < before - 1) grid.push(undefined);
      grid.splice(before - 1, 0, ...Array.from({ length: n }, () => undefined));
    }
    this.maxRows += n;
    return this;
  }
  insertColumnsAfter(after, n) {
    if (after < 1 || after > this.maxCols) throw new Error('insertColumnsAfter: position out of range');
    for (const grid of [this.rows, this.fmts]) {
      for (const row of grid) if (row && row.length > after) row.splice(after, 0, ...Array(n).fill(undefined));
    }
    this.maxCols += n;
    return this;
  }
  isEmpty(v) { return v === undefined || v === null || v === ''; }
  getLastRow() {
    for (let r = this.rows.length; r >= 1; r--) {
      const row = this.rows[r - 1];
      if (row && row.some((v) => !this.isEmpty(v))) return r;
    }
    return 0;
  }
  getLastColumn() {
    let last = 0;
    for (const row of this.rows) if (row) row.forEach((v, j) => { if (!this.isEmpty(v)) last = Math.max(last, j + 1); });
    return last;
  }
  getRange(row, col, numRows = 1, numCols = 1) {
    if (row < 1 || col < 1 || numRows < 1 || numCols < 1 || row + numRows - 1 > this.maxRows || col + numCols - 1 > this.maxCols) {
      throw new Error('The coordinates of the range are outside the dimensions of the sheet.');
    }
    return new FakeRange(this, row, col, numRows, numCols);
  }
  getDataRange() {
    return new FakeRange(this, 1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn()));
  }
  setCell(r, c, v) {
    while (this.rows.length < r) this.rows.push(undefined);
    if (!this.rows[r - 1]) this.rows[r - 1] = [];
    this.rows[r - 1][c - 1] = v === null || v === undefined ? '' : v;
  }
  getCell(r, c) {
    const row = this.rows[r - 1];
    const v = row ? row[c - 1] : undefined;
    return v === undefined ? '' : v;
  }
  // Test helper: the non-empty block as plain arrays.
  data() { return this.getDataRange().getValues(); }
}

export class FakeSpreadsheet {
  constructor() {
    this.sheets = [];
    this.active = null;
    this.calls = [];
    this.nextId = 0;
    this.locale = 'en_US';
    this.id = 'ss-active';
  }
  getId() { return this.id; }
  getUrl() { return `https://docs.google.com/spreadsheets/d/${this.id}/edit`; }
  getName() { return this.title || ''; }
  getSpreadsheetLocale() { return this.locale; }
  setSpreadsheetLocale(locale) {
    this.calls.push({ op: 'setSpreadsheetLocale', locale });
    this.locale = locale;
  }
  getSheets() { return [...this.sheets]; }
  getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; }
  insertSheet(name) {
    if (this.getSheetByName(name)) throw new Error(`A sheet with the name "${name}" already exists.`);
    const s = new FakeSheet(this, name);
    this.sheets.push(s);
    this.active = s;
    return s;
  }
  deleteSheet(sheet) {
    if (this.sheets.length === 1) throw new Error("You can't remove all the sheets in a document.");
    const i = this.sheets.indexOf(sheet);
    if (i < 0) throw new Error('deleteSheet: unknown sheet');
    this.sheets.splice(i, 1);
    if (this.active === sheet) this.active = this.sheets[0];
  }
  setActiveSheet(sheet) { this.active = sheet; return sheet; }
  getActiveSheet() { return this.active; }
  moveActiveSheet(pos) {
    const i = this.sheets.indexOf(this.active);
    this.sheets.splice(i, 1);
    this.sheets.splice(pos - 1, 0, this.active);
  }
  names() { return this.sheets.map((s) => s.name); }
  // Test helper: seed a sheet with a 2-D block from A1.
  seed(name, values) {
    const s = this.insertSheet(name);
    values.forEach((r, i) => r.forEach((v, j) => s.setCell(i + 1, j + 1, v)));
    return s;
  }
}

class FakeFile {
  // content: a string (files the code creates) or a Buffer (binary Inbox files added by tests).
  constructor(folder, name, content, mimeType, created = new Date()) { Object.assign(this, { folder, name, content, mimeType, created, trashed: false }); }
  getName() { return this.name; }
  setName(n) { this.name = n; return this; }
  getMimeType() { return this.mimeType; }
  getDateCreated() { return new Date(this.created.getTime()); }
  getBlob() {
    if (this.folder.drive.failBlob) this.folder.drive.failBlob(this);
    return makeBlob(Buffer.isBuffer(this.content) ? Buffer.from(this.content) : Buffer.from(this.content, 'utf8'), this.mimeType);
  }
  setTrashed(t) {
    const drive = this.folder ? this.folder.drive : this.drive;
    if (drive && drive.failTrash) drive.failTrash(this); // test hook: simulate a Drive error
    if (this.events) this.events.push('trash');
    this.trashed = t;
    return this;
  }
  isTrashed() { return this.trashed; }
  // Owner of a file outside the fake folder tree (made by SpreadsheetApp.create); shared-drive files have none.
  getOwner() { return this.owner ? { getEmail: () => this.owner } : null; }
  // Moves the file out of its current folder into dest (a file created outside any folder has folder null).
  moveTo(dest) {
    if (dest.drive.failMove) dest.drive.failMove(this, dest); // test hook: simulate a Drive error
    if (this.events) this.events.push('move');
    if (this.folder) this.folder.files = this.folder.files.filter((f) => f !== this);
    this.folder = dest;
    dest.files.push(this);
    return this;
  }
}

function iter(items) {
  let i = 0;
  return { hasNext: () => i < items.length, next: () => { if (i >= items.length) throw new Error('iterator exhausted'); return items[i++]; } };
}

export class FakeFolder {
  constructor(drive, name, id) {
    Object.assign(this, { drive, name, id, folders: [], files: [], trashed: false });
    drive.byId[id] = this;
  }
  getName() { return this.name; }
  getId() { return this.id; }
  setTrashed(t) { this.trashed = t; return this; }
  isTrashed() { return this.trashed; }
  liveFolders() { return this.folders.filter((f) => !f.trashed); }
  liveFiles() { return this.files.filter((f) => !f.trashed); }
  // Worst case of real DriveApp: iterators also return trashed items (callers must check isTrashed()).
  getFolders() { return iter([...this.folders]); }
  getFoldersByName(n) { return iter(this.folders.filter((f) => f.name === n)); }
  createFolder(n) {
    const f = new FakeFolder(this.drive, n, `folder-${++this.drive.seq}`);
    this.folders.push(f);
    return f;
  }
  getFiles() { return iter([...this.files]); }
  getFilesByName(n) { return iter(this.files.filter((f) => f.name === n)); }
  createFile(name, content, mimeType) {
    if (typeof content !== 'string') throw new Error('createFile: content must be a string in this fake');
    if (this.drive.failCreate) this.drive.failCreate(this, name); // test hook: simulate a Drive error
    const f = new FakeFile(this, name, content, mimeType || 'text/plain');
    this.files.push(f);
    return f;
  }
  // Test helpers
  // Adds a file as another writer would (e.g. the service account into the Inbox); several files may share a name.
  addFile(name, bytes, { mimeType = 'application/octet-stream', created = new Date() } = {}) {
    const f = new FakeFile(this, name, Buffer.from(bytes), mimeType, created);
    this.files.push(f);
    return f;
  }
  folder(n) { return this.liveFolders().find((f) => f.name === n) || null; }
  fileNames() { return this.liveFiles().map((f) => f.name).sort(); }
  file(n) { return this.liveFiles().find((f) => f.name === n) || null; }
}

export class FakeDrive {
  constructor(rootId) {
    this.byId = {};
    this.filesById = {};
    this.seq = 0;
    this.root = new FakeFolder(this, '03_Master File from Snowflake', rootId);
  }
  getFileById(id) {
    const f = this.filesById[id];
    if (!f) throw new Error(`No item with the given ID could be found: ${id}`);
    return f;
  }
  getFolderById(id) {
    const f = this.byId[id];
    if (!f) throw new Error(`No item with the given ID could be found: ${id}`);
    return f;
  }
}

function makeBlob(buf, contentType) {
  return {
    buf,
    getBytes: () => toSigned(buf), // Java signed bytes
    getDataAsString: (charset) => buf.toString(charset && /^utf-?8$/i.test(charset) ? 'utf8' : 'utf8'),
    getContentType: () => contentType,
    setContentType(t) { contentType = t; return this; },
  };
}

const toBuffer = (bytes) => Buffer.from(Array.from(bytes, (b) => b & 255));
const toSigned = (buf) => Array.from(buf, (b) => (b > 127 ? b - 256 : b));

// Utilities.formatDate(date, timeZone, pattern) for the tokens the code uses: yyyy MM dd HH mm ss.
function formatDate(date, timeZone, pattern) {
  const ms = Number(date);
  if (!Number.isFinite(ms)) throw new Error('formatDate: invalid date');
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const map = { yyyy: p.year, MM: p.month, dd: p.day, HH: p.hour, mm: p.minute, ss: p.second };
  return pattern.replace(/yyyy|MM|dd|HH|mm|ss/g, (t) => map[t]);
}

// ScriptApp triggers: getProjectTriggers, deleteTrigger,
// newTrigger(fn).timeBased().everyDays().atHour().nearMinute().inTimezone().create(), .everyMinutes(n).create()
// and the one-off .after(ms).create(). Every trigger has getUniqueId().
// Assumption (real Apps Script): everyMinutes accepts only 1, 5, 10, 15 or 30.
export function makeScriptApp() {
  const triggers = [];
  let ids = 0;
  const trigger = (spec) => {
    const id = `trigger-${++ids}`;
    return { ...spec, id, getHandlerFunction: () => spec.handler, getUniqueId: () => id };
  };
  const ScriptApp = {
    getProjectTriggers: () => [...triggers],
    deleteTrigger: (t) => {
      const i = triggers.indexOf(t);
      if (i < 0) throw new Error('deleteTrigger: unknown trigger');
      triggers.splice(i, 1);
    },
    newTrigger: (handler) => {
      const spec = { handler };
      const clock = {
        everyDays(n) { spec.everyDays = n; return clock; },
        everyMinutes(n) {
          if (![1, 5, 10, 15, 30].includes(n)) throw new Error('everyMinutes: the value must be 1, 5, 10, 15 or 30');
          spec.everyMinutes = n;
          return clock;
        },
        nearMinute(m) { spec.nearMinute = m; return clock; },
        after(ms) { spec.after = ms; return clock; },
        atHour(h) { spec.atHour = h; return clock; },
        inTimezone(tz) { spec.timeZone = tz; return clock; },
        create() { const t = trigger(spec); triggers.push(t); return t; },
      };
      return { timeBased: () => { spec.type = 'CLOCK'; return clock; } };
    },
  };
  return { ScriptApp, triggers, trigger };
}

export const FakeUtilities = {
  formatDate,
  DigestAlgorithm: { MD5: 'MD5', SHA_1: 'SHA_1', SHA_256: 'SHA_256' },
  // Like Apps Script: value is a string (UTF-8) or a Byte[]; the digest comes back as signed bytes (-128..127).
  computeDigest: (algorithm, value) => {
    if (algorithm !== 'SHA_256') throw new Error(`computeDigest: algorithm ${algorithm} not faked`);
    const buf = typeof value === 'string' ? Buffer.from(value, 'utf8') : toBuffer(value);
    return toSigned(crypto.createHash('sha256').update(buf).digest());
  },
  base64Decode: (s) => Array.from(Buffer.from(s, 'base64'), (b) => (b > 127 ? b - 256 : b)),
  base64Encode: (bytes) => (typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : toBuffer(bytes)).toString('base64'),
  newBlob: (data, contentType) => makeBlob(typeof data === 'string' ? Buffer.from(data, 'utf8') : toBuffer(data), contentType || null),
  gzip: (blob) => makeBlob(zlib.gzipSync(blob.buf), 'application/x-gzip'),
  ungzip: (blob) => {
    if (blob.getContentType() !== 'application/x-gzip') throw new Error('ungzip: blob is not application/x-gzip');
    return makeBlob(zlib.gunzipSync(blob.buf), null);
  },
};

export function encodeRows(rows) {
  return zlib.gzipSync(Buffer.from(JSON.stringify(rows), 'utf8')).toString('base64');
}

// Script Property limits of Apps Script: 9 KB per value, 500 KB per store.
export const PROPERTY_VALUE_MAX_BYTES = 9216;
export const PROPERTY_STORE_MAX_BYTES = 500 * 1024;

// Bytes of every key and value in the store except key `skip`.
function storeBytes(stored, skip) {
  let n = 0;
  for (const [k, v] of Object.entries(stored)) if (k !== skip) n += Buffer.byteLength(k, 'utf8') + Buffer.byteLength(v, 'utf8');
  return n;
}

export const INBOX_ID = '1PE6IcZqJFHM7ISA4XKNHpifk8oCVyqdV';

export function makeEnv({ props = {}, rootId = '1lP59mBX1dM24emOJlussSvMPbkBiTTUk', inboxId = INBOX_ID } = {}) {
  const stored = { ...props };
  const propStats = { maxValueBytes: 0, maxStoreBytes: 0 }; // peaks of setProperty, for size tests
  const ss = new FakeSpreadsheet();
  const drive = new FakeDrive(rootId);
  // The Inbox lives inside the root folder (a shared drive in reality).
  const inbox = new FakeFolder(drive, 'Inbox', inboxId);
  drive.root.folders.push(inbox);
  const lockLog = [];
  // lock.busy = true makes tryLock fail (another execution holds the script lock).
  const lock = { busy: false };
  const scriptApp = makeScriptApp();
  const events = []; // protect/move/trash order of created spreadsheets
  // Editors a new protection of a created spreadsheet starts with (a fresh My Drive file: its owner only).
  const protection = { editors: null };
  const created = []; // spreadsheets made by SpreadsheetApp.create
  const menus = []; // menus added by getUi().createMenu().addToUi()
  const dialogs = []; // getUi().showModalDialog calls
  const context = {
    console,
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in stored ? stored[k] : null),
        getKeys: () => Object.keys(stored),
        setProperty: (k, v) => {
          // Like Apps Script: one value at most 9 KB, the whole store at most 500 KB (keys + values).
          const value = String(v);
          const bytes = Buffer.byteLength(value, 'utf8');
          if (bytes > PROPERTY_VALUE_MAX_BYTES) throw new Error('Argument too large: value');
          const total = storeBytes(stored, k) + Buffer.byteLength(k, 'utf8') + bytes;
          if (total > PROPERTY_STORE_MAX_BYTES) throw new Error('You have exceeded the property storage quota. Please remove some properties and try again.');
          stored[k] = value;
          propStats.maxValueBytes = Math.max(propStats.maxValueBytes, bytes);
          propStats.maxStoreBytes = Math.max(propStats.maxStoreBytes, total);
        },
        deleteProperty: (k) => { delete stored[k]; },
      }),
    },
    ContentService: {
      MimeType: { JSON: 'JSON' },
      createTextOutput: (s) => ({ text: s, setMimeType() { return this; }, getContent() { return s; } }),
    },
    LockService: {
      getScriptLock: () => ({
        waitLock: (ms) => { lockLog.push(['wait', ms]); },
        tryLock: (ms) => { lockLog.push(['try', ms]); return !lock.busy; },
        releaseLock: () => { lockLog.push(['release']); },
      }),
    },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
      // New spreadsheets land in the user's Drive root (outside the fake folder tree) with one sheet 'Sheet1'.
      create: (name) => {
        const n = created.length + 1;
        const c = new FakeSpreadsheet();
        c.id = `created-${n}`;
        c.title = name;
        c.events = events;
        c.insertSheet('Sheet1');
        c.protectionEditors = protection.editors;
        const file = new FakeFile(null, name, '', 'application/vnd.google-apps.spreadsheet');
        file.events = events;
        file.drive = drive;
        file.owner = FAKE_OWNER;
        drive.filesById[c.id] = file;
        created.push(c);
        return c;
      },
      newDataValidation: () => {
        const rule = {};
        const b = {
          requireValueInList(values, dropdown) { rule.values = Array.from(values); rule.dropdown = dropdown; return b; },
          setAllowInvalid(v) { rule.allowInvalid = v; return b; },
          build: () => rule,
        };
        return b;
      },
      getUi: () => ({
        createMenu: (title) => {
          const menu = { title, items: [] };
          const b = {
            addItem(label, fn) { menu.items.push([label, fn]); return b; },
            addToUi() { menus.push(menu); return b; },
          };
          return b;
        },
        showModalDialog: (html, title) => { dialogs.push({ html, title }); },
      }),
    },
    HtmlService: {
      createHtmlOutputFromFile: (name) => {
        const o = { name, width: null, height: null, setWidth(w) { o.width = w; return o; }, setHeight(h) { o.height = h; return o; } };
        return o;
      },
    },
    DriveApp: { getFolderById: (id) => drive.getFolderById(id), getFileById: (id) => drive.getFileById(id) },
    Utilities: FakeUtilities,
    ScriptApp: scriptApp.ScriptApp,
    Logger: { log() {} },
  };
  vm.createContext(context);
  const dir = path.join(process.cwd(), 'apps-script', 'MasterData');
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.ts')).sort((a, b) => (a === 'Config.ts' ? -1 : b === 'Config.ts' ? 1 : a.localeCompare(b)))) {
    const p = path.join(dir, f);
    vm.runInContext(fs.readFileSync(p, 'utf8'), context, { filename: p });
  }
  const post = (body) => {
    const out = context.doPost({ postData: { contents: JSON.stringify(body) } });
    return JSON.parse(out.getContent());
  };
  return { context, stored, propStats, ss, drive, inbox, created, events, protection, menus, dialogs, lock, lockLog, post, triggers: scriptApp.triggers, trigger: scriptApp.trigger };
}
