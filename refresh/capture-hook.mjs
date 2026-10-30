// Claude Code PostToolUse hook: saves each Snowflake sql tool result verbatim to
// runs/<runId>/captures/<NNNN>.json. Active only while runs/CURRENT exists.
// A hook must never break the session: every failure exits 0.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

function responseText(r) {
  if (typeof r === 'string') return r;
  if (Array.isArray(r)) return r.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('');
  if (r && r.content !== undefined) return responseText(r.content);
  return '';
}

try {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const base = resolve(input.cwd || process.cwd());
  const currentFile = join(base, 'runs', 'CURRENT');
  if (existsSync(currentFile)) {
    const runId = readFileSync(currentFile, 'utf8').trim();
    if (runId) {
      const dir = join(base, 'runs', runId, 'captures');
      mkdirSync(dir, { recursive: true });
      // Normal path: "response" is the extracted text and "shape" is absent.
      // If no text can be extracted, keep the raw payload and mark shape "unrecognized".
      const text = responseText(input.tool_response);
      const unrecognized = text === '';
      let seq = readdirSync(dir).filter((f) => /^\d{4}\.json$/.test(f)).length + 1;
      for (;;) {
        const capture = {
          seq,
          capturedAt: new Date().toISOString(),
          sql: input.tool_input && input.tool_input.sql,
          response: unrecognized ? JSON.stringify(input.tool_response) : text,
          ...(unrecognized ? { shape: 'unrecognized' } : {}),
        };
        try {
          // 'wx' fails if the file exists, so concurrent hooks never overwrite each other.
          writeFileSync(join(dir, String(seq).padStart(4, '0') + '.json'), JSON.stringify(capture, null, 2), { flag: 'wx' });
          break;
        } catch (e) {
          if (e.code !== 'EEXIST') throw e;
          seq += 1;
        }
      }
    }
  }
} catch {
  // swallow
}
process.exit(0);
