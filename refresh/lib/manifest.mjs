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

// Sheet header row for a feed; demand headers are generated as `Demand <year>`.
export function headersFor(feed, baseYear) {
  const f = resolveFeed(feed);
  return [...f.columns.map((c) => c.header), ...demandYearsFor(f, baseYear).map((y) => `Demand ${y}`)];
}

// SQL column names in sheet order (ROW_KEY not included); demand columns are `<sqlPrefix><year>`.
export function sqlColumnsFor(feed, baseYear) {
  const f = resolveFeed(feed);
  return [...f.columns.map((c) => c.sql), ...demandYearsFor(f, baseYear).map((y) => `${f.demandYears.sqlPrefix}${y}`)];
}
