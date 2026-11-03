// Usage: node scripts/feed-check-sql.mjs <feed> [baseYear]
// Prints the count SQL and a 3-row sample SQL for a feed, separated by a line `-- next`,
// ready to run through the Snowflake connector. Base year defaults to the current Berlin year.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest, demandYearsFor, demandMonthsFor } from '../refresh/lib/manifest.mjs';
import { renderFeedSql, buildCountSql, buildPageSql } from '../refresh/lib/sql.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [feedName, yearArg] = process.argv.slice(2);
if (!feedName) {
  console.error('usage: node scripts/feed-check-sql.mjs <feed> [baseYear]');
  process.exit(2);
}
const feed = loadManifest().feeds.find((f) => f.feed === feedName);
if (!feed) {
  console.error(`unknown feed: ${feedName}`);
  process.exit(2);
}
const baseYear = yearArg
  ? Number(yearArg)
  : Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric' }).format(new Date()));
const text = fs.readFileSync(path.join(root, feed.sqlFile), 'utf8');
const sql = renderFeedSql(text, baseYear, demandYearsFor(feed, baseYear), demandMonthsFor(feed, baseYear)).trim().replace(/;\s*$/, '');
console.log(buildCountSql(sql));
console.log('-- next');
console.log(buildPageSql(sql, null, 3));
