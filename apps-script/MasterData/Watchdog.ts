// R37 daily watchdog. Plain JavaScript syntax so Node vm can load this file in tests.

// Time-driven (daily, 08:15 Europe/Berlin), under the script lock with its own wait (R49): logs NO_REFRESH when _Refresh_Log B1 (last successful
// refresh, ISO UTC) is missing or not today's Berlin date.
function checkDailyRefresh() {
  return withScriptLock_(function () {
    var ss = spreadsheet_();
    var now = nowIso_();
    var last = getLastSuccess_(ss);
    if (last && berlinDate_(last) === berlinDate_(now)) return { ok: true, lastSuccess: last };
    writeLogRows_(ss, logRows_(logRun_('', '', now, ''), [], 'NO_REFRESH', 'no successful refresh today'));
    return { ok: false, lastSuccess: last };
  }, MASTERDATA_CONFIG.WATCHDOG_LOCK_TIMEOUT_MS);
}

// Deletes every project trigger that runs handler.
function deleteTriggersFor_(handler) {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === handler) ScriptApp.deleteTrigger(t);
  });
}

// Run once from the Apps Script editor (USER step). Replaces any checkDailyRefresh trigger with one
// daily trigger at WATCHDOG_HOUR:WATCHDOG_MINUTE in TIME_ZONE (= appsscript.json timeZone).
function installDailyWatchdogTrigger() {
  var handler = MASTERDATA_CONFIG.WATCHDOG_HANDLER;
  deleteTriggersFor_(handler);
  return ScriptApp.newTrigger(handler)
    .timeBased()
    .everyDays(1)
    .atHour(MASTERDATA_CONFIG.WATCHDOG_HOUR)
    .nearMinute(MASTERDATA_CONFIG.WATCHDOG_MINUTE)
    .inTimezone(MASTERDATA_CONFIG.TIME_ZONE)
    .create();
}
