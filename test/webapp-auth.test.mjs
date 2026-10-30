import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const dir = path.join(process.cwd(), 'apps-script', 'MasterData');
const TOKEN = 'a'.repeat(64);

function load(props = { REFRESH_TOKEN: TOKEN }) {
  const stored = { ...props };
  const context = {
    console,
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in stored ? stored[k] : null),
        setProperty: (k, v) => { stored[k] = v; },
      }),
    },
    ContentService: {
      MimeType: { JSON: 'JSON' },
      createTextOutput: (s) => ({ text: s, setMimeType() { return this; }, getContent() { return s; } }),
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Logger: { log() {} },
  };
  vm.createContext(context);
  for (const f of ['Config.ts', 'WebApp.ts']) {
    const p = path.join(dir, f);
    vm.runInContext(fs.readFileSync(p, 'utf8'), context, { filename: p });
  }
  return { context, stored };
}

function post(context, body) {
  const out = context.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } });
  return JSON.parse(out.getContent());
}

test('wrong token is unauthorized', () => {
  const { context } = load();
  assert.deepStrictEqual(post(context, { token: 'nope', action: 'ping' }), { ok: false, error: 'unauthorized' });
});

test('missing token is unauthorized', () => {
  const { context } = load();
  assert.deepStrictEqual(post(context, { action: 'ping' }), { ok: false, error: 'unauthorized' });
});

test('unset REFRESH_TOKEN rejects everything, including empty token', () => {
  const { context } = load({});
  assert.deepStrictEqual(post(context, { token: '', action: 'ping' }), { ok: false, error: 'unauthorized' });
});

test('right token + ping returns pong', () => {
  const { context } = load();
  assert.deepStrictEqual(post(context, { token: TOKEN, action: 'ping' }), { ok: true, pong: true });
});

test('unknown action', () => {
  const { context } = load();
  assert.deepStrictEqual(post(context, { token: TOKEN, action: 'nope' }), { ok: false, error: 'unknown action' });
});

test('non-JSON body is a bad request', () => {
  const { context } = load();
  assert.deepStrictEqual(post(context, 'not json {'), { ok: false, error: 'bad request' });
});

test('missing postData is a bad request', () => {
  const { context } = load();
  const out = context.doPost({});
  assert.deepStrictEqual(JSON.parse(out.getContent()), { ok: false, error: 'bad request' });
});

test('checkToken_ compares exactly', () => {
  const { context } = load();
  assert.strictEqual(context.checkToken_(TOKEN), true);
  assert.strictEqual(context.checkToken_(TOKEN + 'x'), false);
  assert.strictEqual(context.checkToken_(TOKEN.slice(0, -1)), false);
  assert.strictEqual(context.checkToken_(undefined), false);
});

test('setRefreshToken stores the property', () => {
  const { context, stored } = load({});
  context.setRefreshToken('abc');
  assert.strictEqual(stored.REFRESH_TOKEN, 'abc');
  assert.deepStrictEqual(post(context, { token: 'abc', action: 'ping' }), { ok: true, pong: true });
});
