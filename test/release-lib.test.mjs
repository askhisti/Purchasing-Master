import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveReleaseTarget, checkDescription } from '../scripts/release-lib.mjs';

test('returns ids when both present', () => {
  assert.deepEqual(resolveReleaseTarget('{"scriptId":"S"}', '{"deploymentId":"D"}'), { scriptId: 'S', deploymentId: 'D' });
});
test('refuses missing scriptId', () => {
  assert.throws(() => resolveReleaseTarget('', '{"deploymentId":"D"}'), /scriptId/);
});
test('refuses empty deploymentId', () => {
  assert.throws(() => resolveReleaseTarget('{"scriptId":"S"}', '{"deploymentId":""}'), /deploymentId/);
});
test('refuses malformed json', () => {
  assert.throws(() => resolveReleaseTarget('{bad', '{"deploymentId":"D"}'), /scriptId/);
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
