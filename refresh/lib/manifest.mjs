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

// Sheet header row for a feed; demand headers are generated as `Demand <baseYear+k>`.
export function headersFor(feed, baseYear) {
  const f = resolveFeed(feed);
  const headers = f.columns.map((c) => c.header);
  if (f.demandYears) {
    for (let k = 0; k < f.demandYears.count; k++) headers.push(`Demand ${baseYear + k}`);
  }
  return headers;
}

// SQL column names in sheet order (ROW_KEY not included).
export function sqlColumnsFor(feed) {
  const f = resolveFeed(feed);
  const cols = f.columns.map((c) => c.sql);
  if (f.demandYears) {
    for (let k = 0; k < f.demandYears.count; k++) cols.push(`${f.demandYears.sqlPrefix}${k}`);
  }
  return cols;
}
