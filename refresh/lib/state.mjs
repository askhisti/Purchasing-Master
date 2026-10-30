import fs from 'node:fs';
import path from 'node:path';

export function runsDir(root) {
  return path.join(root, 'runs');
}

export function currentRunId(root) {
  const f = path.join(runsDir(root), 'CURRENT');
  if (!fs.existsSync(f)) throw new Error('no active run (runs/CURRENT missing); run begin first');
  return fs.readFileSync(f, 'utf8').trim();
}

export function statePath(root, runId) {
  return path.join(runsDir(root), runId, 'state.json');
}

export function loadState(root, runId = currentRunId(root)) {
  return JSON.parse(fs.readFileSync(statePath(root, runId), 'utf8'));
}

export function saveState(root, state) {
  const file = statePath(root, state.runId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

// Newest capture with seq > afterSeq, or null.
export function newestCaptureAfter(root, runId, afterSeq) {
  const dir = path.join(runsDir(root), runId, 'captures');
  if (!fs.existsSync(dir)) return null;
  const names = fs.readdirSync(dir).filter((n) => /^\d{4,}\.json$/.test(n)).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  if (!names.length) return null;
  const cap = JSON.parse(fs.readFileSync(path.join(dir, names[names.length - 1]), 'utf8'));
  return cap.seq > afterSeq ? cap : null;
}

// Berlin local time as YYYY-MM-DDTHH-mm-ss.
export function berlinRunId(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Berlin',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}-${p.minute}-${p.second}`;
}
