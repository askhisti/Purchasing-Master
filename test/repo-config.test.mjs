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
