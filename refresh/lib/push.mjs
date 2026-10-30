import zlib from 'node:zlib';

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const encode = (rows) => zlib.gzipSync(Buffer.from(JSON.stringify(rows), 'utf8')).toString('base64');

// Splits rows into base64(gzip(JSON)) chunks, each under maxBytes.
export function chunkRows(rows, maxBytes = 2000000) {
  const out = [];
  const take = (slice) => {
    const b64 = encode(slice);
    if (b64.length <= maxBytes) {
      out.push(b64);
      return;
    }
    if (slice.length <= 1) throw new Error('a single row exceeds the chunk size limit');
    const mid = slice.length >> 1;
    take(slice.slice(0, mid));
    take(slice.slice(mid));
  };
  // Start from slices of a size that usually fits, halving when it does not.
  const start = 5000;
  for (let i = 0; i < rows.length; i += start) take(rows.slice(i, i + start));
  return out;
}

// transient errors (network, timeout, 5xx, unparseable body) leave the server-side outcome unknown.
function transient(message) {
  const e = new Error(message);
  e.transient = true;
  return e;
}

export async function postJson(url, body, { fetchImpl = fetch, sleep = defaultSleep, delays = [5000, 20000], timeoutMs = 120000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) await sleep(delays[attempt - 1]);
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(body),
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      lastErr = transient(`network error: ${e && e.message ? e.message : e}`);
      continue;
    }
    if (res.status >= 500) {
      lastErr = transient(`HTTP ${res.status}`);
      continue;
    }
    let json;
    try {
      json = JSON.parse(await res.text());
    } catch {
      throw transient(`HTTP ${res.status}: response is not JSON`);
    }
    if (!json || json.ok !== true) {
      // The server answered and rejected the request: not transient, outcome known.
      const e = new Error(json && json.error ? String(json.error) : 'request failed');
      e.rejected = true;
      throw e;
    }
    return json;
  }
  throw lastErr;
}
