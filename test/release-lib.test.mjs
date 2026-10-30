import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveReleaseTarget } from '../scripts/release-lib.mjs';

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
