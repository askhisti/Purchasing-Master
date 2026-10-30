import crypto from 'node:crypto';

// A throwaway service-account key for tests. KEY_MARKER appears inside the private key text, so a
// test can scan output for it to prove the key never leaks.
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
export const TEST_PUBLIC_KEY = publicKey;
export const TEST_PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
export const KEY_MARKER = TEST_PRIVATE_PEM.split('\n')[1].slice(0, 24);
export const CLIENT_EMAIL = 'masterdata-uploader@test-project.iam.gserviceaccount.com';
export const KEY_JSON = JSON.stringify({ type: 'service_account', client_email: CLIENT_EMAIL, private_key: TEST_PRIVATE_PEM });
export const ACCESS_TOKEN = 'ya29.test-access-token-ZZZ';

// Fake Google: token endpoint + Drive multipart upload. Records every request.
// tokenStatus: a status, or (n) => status | 'throw' for the n-th token request (1-based).
// uploadStatus(upload, n): a status, 'throw' (network error), or {status, body} with a raw response body.
export function fakeGoogle({ uploadStatus = () => 200, tokenStatus = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const call = { url: u, method: init.method, headers: init.headers ?? {}, body: init.body };
    calls.push(call);
    if (u.startsWith('https://oauth2.googleapis.com/token')) {
      const n = calls.filter((c) => c.url.startsWith('https://oauth2.googleapis.com/token')).length;
      const t = typeof tokenStatus === 'function' ? tokenStatus(n) : tokenStatus;
      if (t === 'throw') throw new Error('getaddrinfo ENOTFOUND oauth2.googleapis.com');
      return t === 200
        ? { status: 200, ok: true, text: async () => JSON.stringify({ access_token: ACCESS_TOKEN, expires_in: 3600 }) }
        : { status: t, ok: false, text: async () => JSON.stringify({ error: 'invalid_grant', error_description: 'Bad grant' }) };
    }
    call.upload = parseMultipart(call);
    const n = calls.filter((c) => c.upload).length;
    const result = uploadStatus(call.upload, n);
    if (result === 'throw') throw new Error('socket hang up');
    if (result && typeof result === 'object') return { status: result.status, ok: result.status < 300, text: async () => result.body };
    const status = result;
    return status < 300
      ? { status, ok: true, text: async () => JSON.stringify({ id: `id-${n}` }) }
      : { status, ok: false, text: async () => JSON.stringify({ error: { code: status, message: `drive says ${status}` } }) };
  };
  return { calls, fetchImpl, uploads: () => calls.filter((c) => c.upload).map((c) => c.upload) };
}

export function parseMultipart(call) {
  const ct = call.headers['Content-Type'] ?? call.headers['content-type'];
  const boundary = /boundary=(.+)$/.exec(ct)[1];
  const body = Buffer.from(call.body);
  const delim = Buffer.from(`--${boundary}`);
  const parts = [];
  let pos = body.indexOf(delim);
  while (pos >= 0) {
    const next = body.indexOf(delim, pos + delim.length);
    if (next < 0) break;
    const part = body.subarray(pos + delim.length + 2, next - 2); // strip CRLF after delimiter and before next
    const split = part.indexOf('\r\n\r\n');
    parts.push({ head: part.subarray(0, split).toString('utf8'), data: part.subarray(split + 4) });
    pos = next;
  }
  const meta = JSON.parse(parts[0].data.toString('utf8'));
  return { url: call.url, contentType: ct, meta, media: parts[1].data, mediaHead: parts[1].head, authorization: call.headers.Authorization };
}
