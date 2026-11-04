import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function loadManifest(p = path.join(root, 'sql', 'feeds.json')) {
  const manifest = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!manifest || !Array.isArray(manifest.feeds)) throw new Error('manifest has no feeds array');
  return manifest;
}

function resolveFeed(feed) {
  if (typeof feed !== 'string') return feed;
  const f = loadManifest().feeds.find((x) => x.feed === feed);
  if (!f) throw new Error(`unknown feed: ${feed}`);
  return f;
}

// Demand years of a feed: the fixed firstYear through baseYear + yearsAhead. The start never
// moves, so each new year appends one column and no column is ever removed. [] without demand.
export function demandYearsFor(feed, baseYear) {
  const f = resolveFeed(feed);
  if (!f.demandYears) return [];
  if (!Number.isInteger(baseYear)) throw new Error(`baseYear must be an integer, got ${baseYear}`);
  const { firstYear, yearsAhead } = f.demandYears;
  const last = baseYear + yearsAhead;
  if (last < firstYear) throw new Error(`${f.feed}: no demand years for base year ${baseYear}`);
  return Array.from({ length: last - firstYear + 1 }, (_, k) => firstYear + k);
}

// Demand months of a feed: all twelve months of baseYear through baseYear + yearsAhead (the
// rolling window; feeds use yearsAhead 1 = 24 months). [] without demandMonths.
export function demandMonthsFor(feed, baseYear) {
  const f = resolveFeed(feed);
  if (!f.demandMonths) return [];
  if (!Number.isInteger(baseYear)) throw new Error(`baseYear must be an integer, got ${baseYear}`);
  const months = [];
  for (let year = baseYear; year <= baseYear + f.demandMonths.yearsAhead; year++) {
    for (let month = 1; month <= 12; month++) months.push({ year, month });
  }
  return months;
}

const pad2 = (n) => String(n).padStart(2, '0');

// Series columns in sheet order: for each demand year, the window months of that year, then the
// year total. Each entry is {header, sql}.
function seriesFor(f, baseYear) {
  if (f.demandMonths && !f.demandYears) throw new Error(`${f.feed}: demandMonths requires demandYears`);
  const months = demandMonthsFor(f, baseYear);
  const prefix = f.demandYears?.headerPrefix ?? 'Demand ';
  const out = [];
  for (const y of demandYearsFor(f, baseYear)) {
    for (const m of months.filter((x) => x.year === y)) {
      out.push({ header: `${y}-${pad2(m.month)}`, sql: `${f.demandMonths.sqlPrefix}${y}_${pad2(m.month)}` });
    }
    out.push({ header: `${prefix}${y}`, sql: `${f.demandYears.sqlPrefix}${y}` });
  }
  return out;
}

// Sheet header row: the listed columns, then per demand year its window months (`YYYY-MM`) and
// the year column `<headerPrefix><year>` (prefix defaults to "Demand ").
export function headersFor(feed, baseYear) {
  const f = resolveFeed(feed);
  return [...f.columns.map((c) => c.header), ...seriesFor(f, baseYear).map((c) => c.header)];
}

// SQL column names in sheet order (ROW_KEY not included); year columns are `<sqlPrefix><year>`
// and month columns `<sqlPrefix><year>_<MM>`.
export function sqlColumnsFor(feed, baseYear) {
  const f = resolveFeed(feed);
  return [...f.columns.map((c) => c.sql), ...seriesFor(f, baseYear).map((c) => c.sql)];
}
