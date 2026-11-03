import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest, sqlColumnsFor, demandYearsFor, demandMonthsFor } from '../refresh/lib/manifest.mjs';
import { renderFeedSql, buildPageSql } from '../refresh/lib/sql.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

for (const feed of loadManifest().feeds) {
  test(`feed ${feed.feed}: rendered SQL has ROW_KEY and every manifest column`, () => {
    const text = fs.readFileSync(path.join(root, 'sql', 'feeds', `${feed.feed}.sql`), 'utf8');
    const sql = renderFeedSql(text, 2026, demandYearsFor(feed, 2026), demandMonthsFor(feed, 2026));
    assert.ok(!sql.includes('{{'));
    assert.match(sql, /\bAS ROW_KEY\b/);
    for (const name of sqlColumnsFor(feed, 2026)) {
      assert.match(sql, new RegExp(String.raw`\bAS ${name}\b`), `missing column ${name}`);
    }
  });
}

// The connector runs one page SQL at a time; the 144-month feeds once rendered to ~17.5k characters.
const MAX_SQL_CHARS = 8000;
for (const feed of loadManifest().feeds) {
  test(`feed ${feed.feed}: rendered SQL (base year 2026) has at most ${MAX_SQL_CHARS} characters`, () => {
    const text = fs.readFileSync(path.join(root, feed.sqlFile), 'utf8').trimEnd();
    const sql = renderFeedSql(text, 2026, demandYearsFor(feed, 2026), demandMonthsFor(feed, 2026));
    assert.ok(sql.length <= MAX_SQL_CHARS, `${sql.length} characters`);
    const page = buildPageSql(sql, 'ME_EC_0000001|1234567|Series', 20000);
    assert.ok(page.length <= MAX_SQL_CHARS, `page SQL ${page.length} characters`);
  });
}
