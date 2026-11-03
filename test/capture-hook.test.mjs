import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const hook = fileURLToPath(new URL('../refresh/capture-hook.mjs', import.meta.url));
const input = JSON.parse(readFileSync(new URL('./fixtures/hook-input.json', import.meta.url), 'utf8'));
const expectedResponse = input.tool_response.map((b) => b.text).join('');

function tempRepo(runId) {
  const dir = mkdtempSync(join(tmpdir(), 'pm-hook-'));
  if (runId) {
    mkdirSync(join(dir, 'runs'), { recursive: true });
    writeFileSync(join(dir, 'runs', 'CURRENT'), runId);
  }
  return dir;
}

// Hook env without CLAUDE_PROJECT_DIR (the test runner may itself run inside Claude Code), plus extra.
function hookEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  if (!('CLAUDE_PROJECT_DIR' in extra)) delete env.CLAUDE_PROJECT_DIR;
  return env;
}

function runHook(stdin, cwd = tmpdir(), env = hookEnv()) {
  // The process cwd is deliberately elsewhere: paths must resolve against input.cwd.
  return spawnSync(process.execPath, [hook], { input: stdin, encoding: 'utf8', cwd, env });
}

test('writes a numbered capture with sql and verbatim response', () => {
  const dir = tempRepo('r1');
  const stdin = JSON.stringify({ ...input, cwd: dir });
  const res = runHook(stdin);
  assert.equal(res.status, 0);
  const file = join(dir, 'runs', 'r1', 'captures', '0001.json');
  const cap = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(cap.seq, 1);
  assert.equal(cap.sql, input.tool_input.sql);
  assert.equal(cap.response, expectedResponse);
  assert.ok(!Number.isNaN(Date.parse(cap.capturedAt)));

  assert.equal(runHook(stdin).status, 0);
  const cap2 = JSON.parse(readFileSync(join(dir, 'runs', 'r1', 'captures', '0002.json'), 'utf8'));
  assert.equal(cap2.seq, 2);
});

test('accepts string and {content:[...]} tool_response shapes', () => {
  for (const tool_response of [expectedResponse, { content: input.tool_response }]) {
    const dir = tempRepo('r1');
    const res = runHook(JSON.stringify({ ...input, tool_response, cwd: dir }));
    assert.equal(res.status, 0);
    const cap = JSON.parse(readFileSync(join(dir, 'runs', 'r1', 'captures', '0001.json'), 'utf8'));
    assert.equal(cap.response, expectedResponse);
  }
});

test('does nothing when runs/CURRENT is absent', () => {
  const dir = tempRepo(null);
  const res = runHook(JSON.stringify({ ...input, cwd: dir }));
  assert.equal(res.status, 0);
  assert.equal(existsSync(join(dir, 'runs')), false);
});

test('malformed stdin exits 0 and writes nothing', () => {
  const dir = tempRepo('r1');
  for (const bad of ['', 'not json', '{"cwd":']) {
    // Process cwd is the repo with runs/CURRENT, so a wrongly-written capture would land in `dir`.
    assert.equal(runHook(bad, dir).status, 0);
  }
  assert.deepEqual(readdirSync(join(dir, 'runs')), ['CURRENT']);
  assert.deepEqual(readdirSync(dir), ['runs']);
});

test('concurrent hooks never overwrite each other', async () => {
  const dir = tempRepo('r1');
  const n = 8;
  const runs = Array.from({ length: n }, (_, i) => new Promise((resolveRun) => {
    const child = spawn(process.execPath, [hook], { cwd: tmpdir(), env: hookEnv() });
    child.on('close', (code) => resolveRun(code));
    child.stdin.end(JSON.stringify({ ...input, cwd: dir, tool_response: `response-${i}` }));
  }));
  assert.deepEqual(await Promise.all(runs), Array(n).fill(0));
  const capDir = join(dir, 'runs', 'r1', 'captures');
  const files = readdirSync(capDir).sort();
  assert.equal(files.length, n);
  const responses = files.map((f) => JSON.parse(readFileSync(join(capDir, f), 'utf8')).response);
  assert.equal(new Set(responses).size, n);
});

test('unrecognized tool_response is kept as JSON and flagged', () => {
  const dir = tempRepo('r1');
  const weird = { foo: 'bar', n: 1 };
  assert.equal(runHook(JSON.stringify({ ...input, tool_response: weird, cwd: dir })).status, 0);
  const cap = JSON.parse(readFileSync(join(dir, 'runs', 'r1', 'captures', '0001.json'), 'utf8'));
  assert.equal(cap.shape, 'unrecognized');
  assert.equal(cap.response, JSON.stringify(weird));
});

test('normal captures carry no shape flag', () => {
  const dir = tempRepo('r1');
  runHook(JSON.stringify({ ...input, cwd: dir }));
  const cap = JSON.parse(readFileSync(join(dir, 'runs', 'r1', 'captures', '0001.json'), 'utf8'));
  assert.equal('shape' in cap, false);
});

function savedNote(path, chars) {
  return `Error: result (${chars.toLocaleString('en-US')} characters across 1 line) exceeds maximum allowed tokens. Output has been saved to ${path}.\nFormat: Plain text\nUse offset and limit parameters to read specific portions of the file.`;
}

test('an oversized result is read from the file the note points at', () => {
  const dir = tempRepo('r1');
  const savedPath = join(dir, 'saved dir', 'mcp-sql-1.txt');
  mkdirSync(join(dir, 'saved dir'));
  const full = expectedResponse.repeat(300);
  writeFileSync(savedPath, full);
  assert.equal(runHook(JSON.stringify({ ...input, tool_response: [{ type: 'text', text: savedNote(savedPath, full.length) }], cwd: dir })).status, 0);
  const cap = JSON.parse(readFileSync(join(dir, 'runs', 'r1', 'captures', '0001.json'), 'utf8'));
  assert.equal(cap.response, full);
  assert.equal(cap.savedFrom, savedPath);
  assert.equal('shape' in cap, false);
});

test('a saved-result note is kept as is when the file is missing or its length differs', () => {
  const dir = tempRepo('r1');
  const savedPath = join(dir, 'mcp-sql-2.txt');
  writeFileSync(savedPath, 'short');
  const missing = savedNote(join(dir, 'nope.txt'), 5);
  const wrongLength = savedNote(savedPath, 6);
  for (const note of [missing, wrongLength]) runHook(JSON.stringify({ ...input, tool_response: note, cwd: dir }));
  const capDir = join(dir, 'runs', 'r1', 'captures');
  const caps = readdirSync(capDir).sort().map((f) => JSON.parse(readFileSync(join(capDir, f), 'utf8')));
  assert.deepEqual(caps.map((c) => c.response), [missing, wrongLength]);
  assert.ok(caps.every((c) => !('savedFrom' in c)));
});

test('CLAUDE_PROJECT_DIR wins over input.cwd as the repo root', () => {
  const project = tempRepo('r1');
  const other = tempRepo('r2');
  const res = runHook(JSON.stringify({ ...input, cwd: other }), tmpdir(), hookEnv({ CLAUDE_PROJECT_DIR: project }));
  assert.equal(res.status, 0);
  assert.ok(existsSync(join(project, 'runs', 'r1', 'captures', '0001.json')), 'capture under CLAUDE_PROJECT_DIR');
  assert.equal(existsSync(join(other, 'runs', 'r2')), false, 'nothing under input.cwd');
});

test('without CLAUDE_PROJECT_DIR the repo root is input.cwd', () => {
  const dir = tempRepo('r1');
  const res = runHook(JSON.stringify({ ...input, cwd: dir }), tmpdir(), hookEnv({ CLAUDE_PROJECT_DIR: '' }));
  assert.equal(res.status, 0);
  assert.ok(existsSync(join(dir, 'runs', 'r1', 'captures', '0001.json')));
});
