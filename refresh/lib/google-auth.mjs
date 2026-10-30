import crypto from 'node:crypto';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const BAD_KEY = 'MASTERDATA_SA_KEY is not a service account key';

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

// Exchanges a signed RS256 JWT for an OAuth access token. Error messages never carry the key, the
// assertion or the token.
export async function getAccessToken({ keyJson, scope, fetchImpl = fetch, now = () => Date.now() }) {
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
    throw new Error(`token request network error: ${e && e.message ? e.message : e}`);
  }
  let json = null;
  try {
    json = JSON.parse(text);
  } catch { /* not JSON */ }
  if (res.status < 200 || res.status >= 300 || !json || typeof json.access_token !== 'string') {
    const detail = json && (json.error_description || json.error);
    throw new Error(`token request failed: HTTP ${res.status}${detail ? ` ${String(detail).slice(0, 200)}` : ''}`);
  }
  return json.access_token;
}
