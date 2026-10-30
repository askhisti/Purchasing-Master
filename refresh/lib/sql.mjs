// SQL builders for the refresh pipeline and adaptive page sizing.
// Feed SQL files contain a literal {{BASE_YEAR}} placeholder and a single SELECT
// whose first column is ROW_KEY; these helpers wrap that SELECT.

const PLACEHOLDER = '{{BASE_YEAR}}';
const MIN_LIMIT = 100;
const MAX_LIMIT = 20000;

// Snowflake string literal: a single quote is escaped by doubling it.
function quoteLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// Replace {{BASE_YEAR}} with the integer year. Any other placeholder is an error.
export function renderFeedSql(sqlText, baseYear) {
  if (!Number.isInteger(baseYear)) throw new Error(`baseYear must be an integer, got ${baseYear}`);
  for (const m of sqlText.matchAll(/\{\{[^}]*\}\}/g)) {
    if (m[0] !== PLACEHOLDER) throw new Error(`unknown placeholder: ${m[0]}`);
  }
  return sqlText.split(PLACEHOLDER).join(String(baseYear));
}

// One row for total rows and distinct ROW_KEY values of the feed.
export function buildCountSql(feedSql) {
  return `SELECT COUNT(*) AS ROW_COUNT, COUNT(DISTINCT ROW_KEY) AS KEY_COUNT FROM (${feedSql})`;
}

// One keyset page of the feed, ordered by ROW_KEY, resuming after afterKey when given.
export function buildPageSql(feedSql, afterKey, limit) {
  const where = afterKey === null || afterKey === undefined ? '' : ` WHERE ROW_KEY > ${quoteLiteral(afterKey)}`;
  return `SELECT * FROM (${feedSql})${where} ORDER BY ROW_KEY LIMIT ${limit}`;
}

// Size the next page so it should return about `target` characters.
// Average chars per row is observed from the last page; prevLimit is accepted for
// signature stability and is not used by the formula.
export function nextLimit(prevLimit, chars, rowsReturned, target = 250000) {
  const charsPerRow = chars / rowsReturned;
  const raw = Math.floor(target / charsPerRow);
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, raw));
}

// Shrink the limit after a truncated page: scale by the fraction actually returned,
// with a 0.8 safety factor, never below the minimum.
export function shrinkLimit(limit, rowsReturned, numRows) {
  return Math.max(MIN_LIMIT, Math.floor((limit * rowsReturned) / numRows * 0.8));
}
