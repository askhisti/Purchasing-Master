import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { makeEnv } from './helpers/gas-fakes.mjs';

const BERLIN_FMT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const appsscript = JSON.parse(fs.readFileSync(new URL('../apps-script/MasterData/appsscript.json', import.meta.url), 'utf8'));

function logSheet(e) {
  return e.ss.getSheetByName('_Refresh_Log');
}
function entries(e) {
  return logSheet(e).data().slice(4);
}
function setB1(e, value) {
  e.context.ensureLogSheet_(e.ss);
  logSheet(e).setCell(1, 2, value);
}

test('R37: checkDailyRefresh logs NO_REFRESH when there is no log sheet / no B1', () => {
  const e = makeEnv();
  e.context.checkDailyRefresh();
  const rows = entries(e);
  assert.strictEqual(rows.length, 1);
  const [runId, started, finished, feed, count, src, status, message] = rows[0];
  assert.deepStrictEqual([runId, started, feed, count, src, status, message], ['', '', '', '', '', 'NO_REFRESH', 'no successful refresh today']);
  assert.match(finished, BERLIN_FMT);
  assert.deepStrictEqual(e.lockLog.map((l) => l[0]), ['wait', 'release'], 'runs under the script lock');
});

test('R37: checkDailyRefresh is silent when B1 is today (Berlin)', () => {
  const e = makeEnv();
  setB1(e, new Date().toISOString());
  e.context.checkDailyRefresh();
  assert.deepStrictEqual(entries(e), []);
});

test('R37: checkDailyRefresh logs NO_REFRESH when B1 is an earlier day', () => {
  const e = makeEnv();
  setB1(e, new Date(Date.now() - 2 * 86400000).toISOString());
  e.context.checkDailyRefresh();
  assert.deepStrictEqual(entries(e).map((r) => [r[6], r[7]]), [['NO_REFRESH', 'no successful refresh today']]);
  setB1(e, 'garbage');
  e.context.checkDailyRefresh();
  assert.strictEqual(entries(e).length, 2, 'an unreadable B1 counts as missing');
});

test('R37: B1 is compared by its Berlin date, not its UTC date', () => {
  const e = makeEnv();
  // 23:30 UTC on 29 Oct is 00:30 on 30 Oct in Berlin (CET).
  assert.strictEqual(e.context.berlinDate_('2026-10-29T23:30:00.000Z'), '2026-10-30');
  assert.strictEqual(e.context.berlinDate_('2026-07-01T21:59:59.000Z'), '2026-07-01');
  assert.strictEqual(e.context.berlinDate_('2026-07-01T22:00:00.000Z'), '2026-07-02');
  assert.strictEqual(e.context.berlinDate_('nope'), '');
});

test('R37: installDailyWatchdogTrigger replaces checkDailyRefresh triggers with one daily trigger at 10 (Berlin)', () => {
  const e = makeEnv();
  const other = e.trigger({ handler: 'somethingElse' });
  e.triggers.push(other, e.trigger({ handler: 'checkDailyRefresh' }), e.trigger({ handler: 'checkDailyRefresh' }));
  e.context.installDailyWatchdogTrigger();
  e.context.installDailyWatchdogTrigger();
  const mine = e.triggers.filter((t) => t.getHandlerFunction() === 'checkDailyRefresh');
  assert.strictEqual(mine.length, 1);
  assert.deepStrictEqual({ type: mine[0].type, everyDays: mine[0].everyDays, atHour: mine[0].atHour, timeZone: mine[0].timeZone },
    { type: 'CLOCK', everyDays: 1, atHour: 10, timeZone: 'Europe/Berlin' });
  assert.ok(e.triggers.includes(other), 'other triggers are kept');
});

test('R37: the trigger time zone matches appsscript.json and the manifest grants the trigger scope', () => {
  const e = makeEnv();
  assert.strictEqual(appsscript.timeZone, 'Europe/Berlin');
  assert.strictEqual(e.context.MASTERDATA_CONFIG.TIME_ZONE, appsscript.timeZone);
  assert.ok(appsscript.oauthScopes.includes('https://www.googleapis.com/auth/script.scriptapp'));
});
