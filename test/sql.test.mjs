import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderFeedSql, buildCountSql, buildPageSql, nextLimit, shrinkLimit } from '../refresh/lib/sql.mjs';

const FEED = 'SELECT ROW_KEY, {{BASE_YEAR}} AS BASE FROM t';

test('renderFeedSql replaces BASE_YEAR and leaves no placeholder', () => {
  const out = renderFeedSql('SELECT x, {{BASE_YEAR}} AS a, {{BASE_YEAR}} + 1 AS b FROM t', 2027);
  assert.ok(out.includes('2027'));
  assert.ok(!out.includes('{{'));
  assert.equal(out, 'SELECT x, 2027 AS a, 2027 + 1 AS b FROM t');
});

test('renderFeedSql throws on any other placeholder', () => {
  assert.throws(() => renderFeedSql('{{X}}', 2027));
  assert.throws(() => renderFeedSql('{{BASE_YEAR}} {{X}}', 2027));
});

test('renderFeedSql expands a DEMAND template once per year', () => {
  const out = renderFeedSql('SELECT A {{DEMAND: , SUM(IFF(Y = #YEAR#, Q, 0)) AS DEMAND_#YEAR#}} FROM t', 2026, [2025, 2026]);
  assert.equal(out, 'SELECT A , SUM(IFF(Y = 2025, Q, 0)) AS DEMAND_2025\n, SUM(IFF(Y = 2026, Q, 0)) AS DEMAND_2026 FROM t');
});

test('renderFeedSql throws on a DEMAND template without demand years', () => {
  assert.throws(() => renderFeedSql('SELECT A {{DEMAND: , B AS DEMAND_#YEAR#}} FROM t', 2026), /demand years/);
  assert.throws(() => renderFeedSql('SELECT A {{DEMAND: , B AS DEMAND_#YEAR#}} FROM t', 2026, []), /demand years/);
  assert.throws(() => renderFeedSql('SELECT A {{DEMAND: , B}} FROM t', 2026, [2026]), /#YEAR#/);
});

test('renderFeedSql throws on a non-integer year', () => {
  assert.throws(() => renderFeedSql(FEED, 2027.5));
  assert.throws(() => renderFeedSql(FEED, '2027'));
  assert.throws(() => renderFeedSql(FEED, NaN));
});

test('buildCountSql wraps the feed in a count query', () => {
  assert.equal(
    buildCountSql(FEED),
    `SELECT COUNT(*) AS ROW_COUNT, COUNT(DISTINCT ROW_KEY) AS KEY_COUNT FROM (${FEED})`,
  );
});

test('buildPageSql escapes a single quote in afterKey by doubling it', () => {
  const sql = buildPageSql(FEED, "A'B", 10);
  assert.ok(sql.includes("ROW_KEY > 'A''B'"));
  assert.equal(sql, `SELECT * FROM (${FEED}) WHERE ROW_KEY > 'A''B' ORDER BY ROW_KEY LIMIT 10`);
});

test('buildPageSql with afterKey null has no WHERE', () => {
  const sql = buildPageSql(FEED, null, 500);
  assert.ok(!/\bWHERE\b/.test(sql));
  assert.equal(sql, `SELECT * FROM (${FEED}) ORDER BY ROW_KEY LIMIT 500`);
});

test('buildPageSql escapes a backslash in afterKey', () => {
  assert.ok(buildPageSql(FEED, 'A\\B', 10).includes(String.raw`ROW_KEY > 'A\\B'`));
});

test('buildPageSql: trailing backslash cannot escape the closing quote', () => {
  assert.ok(buildPageSql(FEED, 'AB\\', 10).includes(String.raw`ROW_KEY > 'AB\\'`));
});

test('buildPageSql escapes backslash before quote', () => {
  assert.ok(buildPageSql(FEED, "x\\'y", 10).includes(String.raw`ROW_KEY > 'x\\''y'`));
});

test('buildPageSql throws unless limit is a positive integer', () => {
  for (const bad of [0, -1, 1.5, NaN, '10', undefined]) {
    assert.throws(() => buildPageSql(FEED, null, bad), undefined, String(bad));
  }
});

test('nextLimit sizes pages to the target character budget', () => {
  assert.equal(nextLimit(2000, 339594, 2137), 1573);
});

test('nextLimit clamps to 20000 at the top', () => {
  assert.equal(nextLimit(2000, 1000, 1000), 20000);
});

test('nextLimit clamps to 100 at the bottom', () => {
  assert.equal(nextLimit(2000, 10000000, 1), 100);
});

test('nextLimit returns 100 (never NaN) when rowsReturned is 0', () => {
  assert.equal(nextLimit(2000, 0, 0), 100);
});

test('shrinkLimit: a truncated page sizes the next limit from the rows that fit (x0.8)', () => {
  assert.equal(shrinkLimit(5000, 2137, 5000), 1709);
});

test('shrinkLimit: truncated last page (numRows below limit) still uses the rows that fit', () => {
  // Old formula scaled by rows/numRows and gave 1233, which can truncate again.
  assert.equal(shrinkLimit(5000, 850, 2757), 680);
});

test('shrinkLimit returns 100 (never NaN) for non-numeric input', () => {
  assert.equal(shrinkLimit(5000, NaN, 5000), 100);
  assert.equal(shrinkLimit(NaN, 10, NaN), 100);
});

test('shrinkLimit never goes below 100', () => {
  assert.equal(shrinkLimit(120, 1, 5000), 100);
});

test('shrinkLimit returns 100 (never NaN) when numRows is 0', () => {
  assert.equal(shrinkLimit(5000, 0, 0), 100);
});
