import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { getAccessToken, parseServiceAccountKey } from '../refresh/lib/google-auth.mjs';
import { KEY_JSON, KEY_MARKER, CLIENT_EMAIL, TEST_PUBLIC_KEY, TEST_PRIVATE_PEM, fakeGoogle, ACCESS_TOKEN } from './helpers/sa-key.mjs';

const SCOPE = 'https://www.googleapis.com/auth/drive';
const b64u = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

test('getAccessToken sends a signed RS256 JWT assertion and returns the access token', async () => {
  const g = fakeGoogle();
  const token = await getAccessToken({ keyJson: KEY_JSON, scope: SCOPE, fetchImpl: g.fetchImpl, now: () => 1_800_000_000_000 });
  assert.equal(token, ACCESS_TOKEN);
  assert.equal(g.calls.length, 1);
  const c = g.calls[0];
  assert.equal(c.url, 'https://oauth2.googleapis.com/token');
  assert.equal(c.method, 'POST');
  assert.equal(c.headers['Content-Type'], 'application/x-www-form-urlencoded');
  const form = new URLSearchParams(String(c.body));
  assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const [h, p, s] = form.get('assertion').split('.');
  assert.deepEqual(b64u(h), { alg: 'RS256', typ: 'JWT' });
  assert.deepEqual(b64u(p), { iss: CLIENT_EMAIL, scope: SCOPE, aud: 'https://oauth2.googleapis.com/token', iat: 1_800_000_000, exp: 1_800_003_600 });
  assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), TEST_PUBLIC_KEY, Buffer.from(s, 'base64url')), 'signature verifies');
});

test('parseServiceAccountKey requires client_email and private_key, echoing nothing', () => {
  assert.equal(parseServiceAccountKey(KEY_JSON).client_email, CLIENT_EMAIL);
  for (const bad of ['not json SECRETBIT', '{"client_email":"a@b"}', JSON.stringify({ private_key: 'SECRETBIT' }), '[]', 'null']) {
    assert.throws(() => parseServiceAccountKey(bad), (e) => e.message === 'MASTERDATA_SA_KEY is not a service account key');
  }
});

test('token errors name the status and Google message but never the key or the assertion', async () => {
  const g = fakeGoogle({ tokenStatus: 400 });
  let err;
  try { await getAccessToken({ keyJson: KEY_JSON, scope: SCOPE, fetchImpl: g.fetchImpl }); } catch (e) { err = e; }
  assert.match(err.message, /400/);
  assert.match(err.message, /Bad grant/);
  const assertion = new URLSearchParams(String(g.calls[0].body)).get('assertion');
  assert.ok(!err.message.includes(KEY_MARKER));
  assert.ok(!err.message.includes(assertion));
});

test('a private key that cannot sign fails without echoing it', async () => {
  const bad = JSON.stringify({ client_email: CLIENT_EMAIL, private_key: TEST_PRIVATE_PEM.replace(/\n/g, '').slice(0, 80) });
  const g = fakeGoogle();
  let err;
  try { await getAccessToken({ keyJson: bad, scope: SCOPE, fetchImpl: g.fetchImpl }); } catch (e) { err = e; }
  assert.ok(err);
  assert.ok(!err.message.includes(KEY_MARKER));
  assert.equal(g.calls.length, 0);
});
