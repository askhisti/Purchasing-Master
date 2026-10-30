import crypto from 'node:crypto';
import zlib from 'node:zlib';

const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true';
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pure. `prepared` is the shaped feeds: [{ feedDef, headers, types, rows }]. Data files first, manifest last.
export function buildPayload(state, prepared, { status = 'ready', reason, publishedAt = new Date().toISOString() } = {}) {
  const files = [];
  const feeds = [];
  for (const f of prepared) {
    const bytes = zlib.gzipSync(Buffer.from(JSON.stringify(f.rows), 'utf8'));
    const name = `${state.runId}__${f.feedDef.feed}.json.gz`;
    files.push({ name, bytes, mimeType: 'application/gzip' });
    feeds.push({
      feed: f.feedDef.feed, tab: f.feedDef.tab, headers: f.headers, types: f.types, rowCount: f.rows.length,
      file: name, sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    });
  }
  const manifest = { version: 1, runId: state.runId, status };
  if (status === 'failed') manifest.reason = reason;
  Object.assign(manifest, { baseYear: state.baseYear, startedAt: state.startedAt, publishedAt, health: state.health, feeds });
  files.push({ name: `${state.runId}__manifest.json`, bytes: Buffer.from(JSON.stringify(manifest), 'utf8'), mimeType: 'application/json' });
  return { manifest, files };
}

function multipartBody(meta, file) {
  const boundary = `inbox${crypto.randomBytes(12).toString('hex')}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${file.mimeType}\r\n\r\n`),
    file.bytes,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  return { body, contentType: `multipart/related; boundary=${boundary}` };
}

const RATE_LIMIT_REASONS = ['rateLimitExceeded', 'userRateLimitExceeded'];

// R57: 5xx, 429, and 403 whose Google error JSON names a rate-limit reason (error.errors[].reason) are retried.
export function retryableStatus(status, json) {
  if (status >= 500 || status === 429) return true;
  if (status !== 403) return false;
  const errors = json && json.error && Array.isArray(json.error.errors) ? json.error.errors : [];
  return errors.some((e) => e && RATE_LIMIT_REASONS.includes(e.reason));
}

async function uploadOne({ folderId, file, token, fetchImpl, sleep, delays }) {
  const { body, contentType } = multipartBody({ name: file.name, parents: [folderId], mimeType: file.mimeType }, file);
  let lastErr;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) await sleep(delays[attempt - 1]);
    let res;
    let text;
    try {
      res = await fetchImpl(UPLOAD_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
        body,
        signal: AbortSignal.timeout(120000),
      });
      text = await res.text();
    } catch (e) {
      lastErr = new Error(`${file.name}: network error: ${e && e.message ? e.message : e}`);
      continue;
    }
    let json = null;
    try {
      json = JSON.parse(text);
    } catch { /* not JSON */ }
    if (res.status >= 200 && res.status < 300) {
      if (!json || !json.id) throw new Error(`${file.name}: upload response has no file id`);
      return json.id;
    }
    const detail = json && json.error && json.error.message ? ` ${String(json.error.message).slice(0, 300)}` : '';
    const err = new Error(`${file.name}: upload failed: HTTP ${res.status}${detail}`);
    if (retryableStatus(res.status, json)) {
      lastErr = err;
      continue;
    }
    throw err;
  }
  throw lastErr;
}

// One multipart upload per file, in list order. Retries network errors, 5xx, 429 and rate-limit 403s (5 s, 20 s).
export async function uploadToInbox({ folderId, files, token, fetchImpl = fetch, sleep = defaultSleep, delays = [5000, 20000] }) {
  for (const f of files) {
    if (f.bytes.length > MAX_FILE_BYTES) throw new Error(`${f.name} is ${f.bytes.length} bytes, over the 5 MB multipart upload limit`);
  }
  const ids = [];
  for (const file of files) ids.push(await uploadOne({ folderId, file, token, fetchImpl, sleep, delays }));
  return { ids };
}
