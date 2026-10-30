import crypto from 'node:crypto';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const BAD_KEY = 'MASTERDATA_SA_KEY is not a service account key';
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Parses the service account key JSON text; requires client_email and private_key. Never echoes content.
export function parseServiceAccountKey(keyJson) {
  let key = keyJson;
  if (typeof keyJson === 'string') {
    try {
      key = JSON.parse(keyJson);
    } catch {
      throw new Error(BAD_KEY);
    }
  }
  if (!key || typeof key !== 'object' || typeof key.client_email !== 'string' || typeof key.private_key !== 'string' || !key.client_email || !key.private_key) {
    throw new Error(BAD_KEY);
  }
  return key;
}

const b64u = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

// Exchanges a signed RS256 JWT for an OAuth access token. Network errors, 5xx and 429 are retried after
// `delays` (5 s, 20 s, like the uploads); other 4xx (e.g. 400 invalid_grant, 401) fail at once. Error messages never
// carry the key, the assertion or the token.
export async function getAccessToken({ keyJson, scope, fetchImpl = fetch, now = () => Date.now(), sleep = defaultSleep, delays = [5000, 20000] }) {
  const key = parseServiceAccountKey(keyJson);
  const iat = Math.floor(now() / 1000);
  const unsigned = `${b64u({ alg: 'RS256', typ: 'JWT' })}.${b64u({ iss: key.client_email, scope, aud: TOKEN_URL, iat, exp: iat + 3600 })}`;
  let signature;
  try {
    signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), key.private_key).toString('base64url');
  } catch {
    throw new Error('could not sign the token request: the private key in MASTERDATA_SA_KEY is unusable');
  }
  const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` });
  let lastErr;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) await sleep(delays[attempt - 1]);
    let res;
    let text;
    try {
      res = await fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(60000),
      });
      text = await res.text();
    } catch (e) {
      lastErr = new Error(`token request network error: ${e && e.message ? e.message : e}`);
      continue;
    }
    let json = null;
    try {
      json = JSON.parse(text);
    } catch { /* not JSON */ }
    if (res.status >= 200 && res.status < 300 && json && typeof json.access_token === 'string') return json.access_token;
    const detail = json && (json.error_description || json.error);
    const err = new Error(`token request failed: HTTP ${res.status}${detail ? ` ${String(detail).slice(0, 200)}` : ''}`);
    if (res.status >= 500 || res.status === 429) {
      lastErr = err;
      continue;
    }
    throw err;
  }
  throw lastErr;
}
