// SQL builders for the refresh pipeline and adaptive page sizing.
// Feed SQL files contain a single SELECT whose first column is ROW_KEY, and may use the
// placeholders {{BASE_YEAR}} and {{DEMAND: <template>}}; these helpers wrap that SELECT.

const PLACEHOLDER = '{{BASE_YEAR}}';
const DEMAND_TEMPLATE = /\{\{DEMAND:([^}]*)\}\}/g;
const MONTHS_TEMPLATE = /\{\{MONTHS:([^}]*)\}\}/g;
const MIN_LIMIT = 100;
const MAX_LIMIT = 20000;

// Snowflake string literal: backslash is an escape character inside single quotes,
// so it is escaped first, then a single quote is escaped by doubling it.
function quoteLiteral(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

// Replace {{BASE_YEAR}} with the integer year, and expand each {{DEMAND: <template>}} into one
// line per demand year with #YEAR# replaced (templates start with a comma, so lines join cleanly).
// {{MONTHS: <template>}} works the same per demand month with #YEAR#, #MONTH# (1-12) and #MM# (01-12).
// Any other placeholder is an error.
export function renderFeedSql(sqlText, baseYear, demandYears = [], demandMonths = []) {
  if (!Number.isInteger(baseYear)) throw new Error(`baseYear must be an integer, got ${baseYear}`);
  const withDemand = sqlText.replace(DEMAND_TEMPLATE, (_, template) => {
    if (!template.includes('#YEAR#')) throw new Error(`DEMAND template without #YEAR#: ${template.trim()}`);
    if (!demandYears.length) throw new Error('DEMAND template but no demand years');
    return demandYears.map((y) => template.trim().split('#YEAR#').join(String(y))).join('\n');
  });
  const expanded = withDemand.replace(MONTHS_TEMPLATE, (_, template) => {
    if (!template.includes('#YEAR#')) throw new Error(`MONTHS template without #YEAR#: ${template.trim()}`);
    if (!demandMonths.length) throw new Error('MONTHS template but no demand months');
    return demandMonths.map(({ year, month }) => template.trim()
      .split('#YEAR#').join(String(year))
      .split('#MONTH#').join(String(month))
      .split('#MM#').join(String(month).padStart(2, '0'))).join('\n');
  });
  for (const m of expanded.matchAll(/\{\{[^}]*\}\}/g)) {
    if (m[0] !== PLACEHOLDER) throw new Error(`unknown placeholder: ${m[0]}`);
  }
  return expanded.split(PLACEHOLDER).join(String(baseYear));
}

// One row for total rows and distinct ROW_KEY values of the feed.
// The closing parenthesis of every wrapper starts a new line, so a trailing `--` comment in the feed SQL cannot swallow it.
export function buildCountSql(feedSql) {
  return `SELECT COUNT(*) AS ROW_COUNT, COUNT(DISTINCT ROW_KEY) AS KEY_COUNT FROM (${feedSql}\n)`;
}

// One keyset page of the feed, ordered by ROW_KEY, resuming after afterKey.
// Callers pass null (not '') for the first page; null omits the WHERE clause.
export function buildPageSql(feedSql, afterKey, limit) {
  if (!Number.isInteger(limit) || limit <= 0) throw new Error(`limit must be a positive integer, got ${limit}`);
  const where = afterKey === null || afterKey === undefined ? '' : ` WHERE ROW_KEY > ${quoteLiteral(afterKey)}`;
  return `SELECT * FROM (${feedSql}\n)${where} ORDER BY ROW_KEY LIMIT ${limit}`;
}

// Size the next page so it should return about `target` characters.
// Average chars per row is observed from the last page; prevLimit is accepted for
// signature stability and is not used by the formula. Returns MIN_LIMIT when the
// observed ratio is unusable (no rows, or no characters per row).
export function nextLimit(prevLimit, chars, rowsReturned, target = 250000) {
  const charsPerRow = chars / rowsReturned;
  if (!Number.isFinite(charsPerRow) || charsPerRow <= 0) return MIN_LIMIT;
  const raw = Math.floor(target / charsPerRow);
  if (!Number.isFinite(raw)) return MIN_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, raw));
}

// Shrink the limit after a truncated page. On a truncated page (rowsReturned below
// min(limit, numRows)) the rows that fit are the right scale, so the next limit is
// rowsReturned with a 0.8 safety factor; otherwise the limit is scaled by the fraction
// returned. Never below the minimum; MIN_LIMIT when the inputs give no finite result.
export function shrinkLimit(limit, rowsReturned, numRows) {
  const scaled = rowsReturned < Math.min(limit, numRows)
    ? Math.floor(rowsReturned * 0.8)
    : Math.floor((limit * rowsReturned) / numRows * 0.8);
  if (!Number.isFinite(scaled)) return MIN_LIMIT;
  return Math.max(MIN_LIMIT, scaled);
}
