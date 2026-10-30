import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolveReleaseTarget, checkDescription, optionalDescription } from '../scripts/release-lib.mjs';

test('returns the scriptId; no deploymentId is needed (R55: push-only release)', () => {
  assert.deepEqual(resolveReleaseTarget('{"scriptId":"S"}'), { scriptId: 'S' });
});
test('refuses missing scriptId', () => {
  assert.throws(() => resolveReleaseTarget(''), /scriptId/);
  assert.throws(() => resolveReleaseTarget('{"scriptId":"  "}'), /scriptId/);
});
test('refuses malformed json', () => {
  assert.throws(() => resolveReleaseTarget('{bad'), /scriptId/);
});

test('checkDescription accepts plain text and trims', () => {
  assert.equal(checkDescription('  phase 1 receiver '), 'phase 1 receiver');
});
test('checkDescription rejects empty and shell metacharacters', () => {
  assert.throws(() => checkDescription('  '), /Usage/);
  for (const c of ['&', '|', '<', '>', '^', '%', '"', '`']) {
    assert.throws(() => checkDescription(`a ${c} b`), /must not contain/);
  }
});
test('optionalDescription: empty means no clasp version; otherwise validated like checkDescription', () => {
  assert.equal(optionalDescription(''), '');
  assert.equal(optionalDescription('   '), '');
  assert.equal(optionalDescription(' puller 5 min '), 'puller 5 min');
  assert.throws(() => optionalDescription('a & b'), /must not contain/);
});

test('R55: the release script pushes only (no deploy, no release-config.json)', () => {
  const src = fs.readFileSync(new URL('../scripts/release-gas.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes("'push', '--force'"));
  assert.ok(!/'deploy'/.test(src), 'no clasp deploy');
  assert.ok(!src.includes('release-config'), 'no release-config.json');
  assert.ok(!fs.existsSync(new URL('../scripts/release-config.json', import.meta.url)), 'release-config.json deleted');
  assert.ok(src.indexOf('npm test && npm run validate') < src.indexOf("'push', '--force'"), 'tests and validate run before the push');
});
