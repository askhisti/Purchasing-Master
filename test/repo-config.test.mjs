import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('settings.json runs the capture hook via $CLAUDE_PROJECT_DIR (works from any cwd)', () => {
  const settings = JSON.parse(read('.claude/settings.json'));
  const [entry] = settings.hooks.PostToolUse;
  assert.equal(entry.matcher, 'mcp__claude_ai_Snowflake_-_ME_Data__sql');
  assert.deepEqual(entry.hooks, [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/refresh/capture-hook.mjs"' }]);
});

test('nightly-refresh skill forbids every other Snowflake query', () => {
  const skill = read('.claude/skills/nightly-refresh/SKILL.md');
  assert.ok(
    skill.includes('Do not run any other Snowflake query — not PLATFORM_RULES, getting_started, find_data or anything else; the SQL from the CLI already applies the platform rules.'),
  );
});

test('item 7: .clasp.json filePushOrder lists every Apps Script source file (incl. Puller.ts)', () => {
  const clasp = JSON.parse(read('apps-script/MasterData/.clasp.json'));
  const sources = fs.readdirSync(new URL('../apps-script/MasterData/', import.meta.url)).filter((n) => n.endsWith('.ts')).sort();
  assert.deepEqual([...clasp.filePushOrder].sort(), sources);
  assert.equal(clasp.filePushOrder[0], 'Config.ts');
});

test('R55 / item 8: appsscript.json has no web app; container UI only in MfrFile.ts', () => {
  const manifest = JSON.parse(read('apps-script/MasterData/appsscript.json'));
  assert.equal(manifest.webapp, undefined);
  assert.deepEqual(manifest.oauthScopes, [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/script.scriptapp',
    'https://www.googleapis.com/auth/script.container.ui',
  ]);
  const dir = new URL('../apps-script/MasterData/', import.meta.url);
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.ts') && n !== 'MfrFile.ts')) {
    assert.ok(!/getUi\s*\(/.test(fs.readFileSync(new URL(f, dir), 'utf8')), `${f} must not use the container UI`);
  }
});

test('item 11: .gitignore keeps downloaded service account keys out of git', () => {
  const lines = read('.gitignore').split(/\r?\n/).map((l) => l.trim());
  for (const p of ['*service-account*.json', 'rfq-mecl-automation-project-*.json', '*-key.json']) assert.ok(lines.includes(p), p);
});
