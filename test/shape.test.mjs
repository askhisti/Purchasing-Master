import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shapeFeed } from '../refresh/lib/shape.mjs';
import { loadManifest, sqlColumnsFor, demandYearsFor } from '../refresh/lib/manifest.mjs';

const feedDef = {
  feed: 'f', tab: 'F',
  columns: [
    { sql: 'MPN', header: 'MPN', type: 'string' },
    { sql: 'N', header: 'N', type: 'number' },
    { sql: 'D', header: 'D', type: 'date' },
    { sql: 'B', header: 'B', type: 'boolean' },
  ],
};
const cols = ['MPN', 'N', 'D', 'B'];

test('string columns stay strings, empty becomes null', () => {
  const r = shapeFeed(feedDef, 2027, [['k1', '0402', '1', '', 'TRUE'], ['k2', '1E3', '', '', 'false'], ['k3', '', '', '', '']], cols);
  assert.equal(r.rows[0][0], '0402');
  assert.equal(r.rows[1][0], '1E3');
  assert.equal(r.rows[2][0], null);
});

test('number, date and boolean conversions', () => {
  const r = shapeFeed(feedDef, 2027, [['k', 'x', '4.730000000', '2022-08-25 00:00:00.000', 'TRUE'], ['k', 'y', '', '', 'false']], cols);
  assert.deepEqual(r.rows[0], ['x', 4.73, '2022-08-25', true]);
  assert.deepEqual(r.rows[1], ['y', null, null, false]);
  assert.deepEqual(r.types, ['string', 'number', 'date', 'boolean']);
});

test('ROW_KEY dropped and demand headers follow base year', () => {
  const manifest = loadManifest();
  const f = manifest.feeds.find((x) => x.demandYears);
  const sqlCols = sqlColumnsFor(f, 2027);
  const sample = { boolean: 'true', date: '2022-08-25' };
  const types = [...f.columns.map((c) => c.type), ...demandYearsFor(f, 2027).map(() => 'number')];
  const raw = ['KEY', ...types.map((t) => sample[t] ?? '1')];
  const r = shapeFeed(f, 2027, [raw], sqlCols);
  assert.equal(r.headers.at(-1), 'Demand 2037');
  assert.equal(r.rows[0].length, sqlCols.length);
  assert.equal(r.types.at(-1), 'number');
  assert.ok(!r.headers.includes('ROW_KEY'));
});

test('row width mismatch throws', () => {
  assert.throws(() => shapeFeed(feedDef, 2027, [['k', 'a']], cols), /columns/);
});

test('date must look like YYYY-MM-DD, error names feed and column', () => {
  assert.throws(() => shapeFeed(feedDef, 2027, [['k', 'a', '1', 'not a date', 'true']], cols), /f.*D/);
});

test('number: whitespace is null, non-decimal forms rejected, exponent accepted', () => {
  assert.equal(shapeFeed(feedDef, 2027, [['k', 'a', '  ', '', '']], cols).rows[0][1], null);
  assert.equal(shapeFeed(feedDef, 2027, [['k', 'a', '1e3', '', '']], cols).rows[0][1], 1000);
  assert.equal(shapeFeed(feedDef, 2027, [['k', 'a', ' -2.5 ', '', '']], cols).rows[0][1], -2.5);
  assert.throws(() => shapeFeed(feedDef, 2027, [['k', 'a', '0x1A', '', '']], cols), /f.*N/);
  assert.throws(() => shapeFeed(feedDef, 2027, [['k', 'a', 'Infinity', '', '']], cols), /f.*N/);
});

test('month columns shape as numbers', () => {
  const f = { feed: 'm', columns: [{ sql: 'K', header: 'K', type: 'string' }], demandMonths: { sqlPrefix: 'M_', firstYear: 2025, yearsAhead: 0 } };
  const raw = ['rk', 'k', '0', '', ...Array(10).fill('5')];
  const r = shapeFeed(f, 2025, [raw], sqlColumnsFor(f, 2025));
  assert.equal(r.rows[0][1], 0);
  assert.equal(r.rows[0][2], null);
  assert.equal(r.rows[0][3], 5);
});
