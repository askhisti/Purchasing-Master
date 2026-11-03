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

// Demand months of a feed: January of firstYear through December of baseYear + yearsAhead, so
// each January appends twelve columns and none is ever removed. [] without demandMonths.
export function demandMonthsFor(feed, baseYear) {
  const f = resolveFeed(feed);
  if (!f.demandMonths) return [];
  if (!Number.isInteger(baseYear)) throw new Error(`baseYear must be an integer, got ${baseYear}`);
  const { firstYear, yearsAhead } = f.demandMonths;
  const last = baseYear + yearsAhead;
  if (last < firstYear) throw new Error(`${f.feed}: no demand months for base year ${baseYear}`);
  const months = [];
  for (let year = firstYear; year <= last; year++) {
    for (let month = 1; month <= 12; month++) months.push({ year, month });
  }
  return months;
}

const pad2 = (n) => String(n).padStart(2, '0');

// Sheet header row for a feed: the listed columns, then `<headerPrefix><year>` per demand year
// (prefix defaults to "Demand "), then `YYYY-MM` per demand month.
export function headersFor(feed, baseYear) {
  const f = resolveFeed(feed);
  const prefix = f.demandYears?.headerPrefix ?? 'Demand ';
  return [
    ...f.columns.map((c) => c.header),
    ...demandYearsFor(f, baseYear).map((y) => `${prefix}${y}`),
    ...demandMonthsFor(f, baseYear).map((m) => `${m.year}-${pad2(m.month)}`),
  ];
}

// SQL column names in sheet order (ROW_KEY not included); demand columns are `<sqlPrefix><year>`
// and month columns `<sqlPrefix><year>_<MM>`.
export function sqlColumnsFor(feed, baseYear) {
  const f = resolveFeed(feed);
  return [
    ...f.columns.map((c) => c.sql),
    ...demandYearsFor(f, baseYear).map((y) => `${f.demandYears.sqlPrefix}${y}`),
    ...demandMonthsFor(f, baseYear).map((m) => `${f.demandMonths.sqlPrefix}${m.year}_${pad2(m.month)}`),
  ];
}
