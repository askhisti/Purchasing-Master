import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseConnectorResult } from '../refresh/lib/result.mjs';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('complete result: numRows equals rows.length', () => {
  const text = fixture('sql-small.json');
  const r = parseConnectorResult(text);
  assert.equal(r.rows.length, 3);
  assert.equal(r.numRows, r.rows.length);
  assert.deepEqual(r.columns, ['PART_ID', 'DESCRIPTION', 'QTY']);
  assert.equal(r.chars, text.length);
});

test('truncated result: fewer rows than numRows', () => {
  const r = parseConnectorResult(fixture('sql-truncated.json'));
  assert.equal(r.numRows, 5000);
  assert.equal(r.rows.length, 3);
  assert.ok(r.rows.length < r.numRows);
  assert.ok(r.columns.length > 0);
});

test('array-wrapped form parses the same as the unwrapped form', () => {
  const inner = fixture('sql-small.json');
  const wrapped = JSON.stringify([{ type: 'text', text: inner }]);
  const a = parseConnectorResult(inner);
  const b = parseConnectorResult(wrapped);
  assert.deepEqual(b.rows, a.rows);
  assert.deepEqual(b.columns, a.columns);
  assert.equal(b.numRows, a.numRows);
  assert.equal(b.chars, wrapped.length);
});

test('throws on text without a result_set', () => {
  assert.throws(() => parseConnectorResult('{"error":"boom"}'));
  assert.throws(() => parseConnectorResult('not json'));
});
