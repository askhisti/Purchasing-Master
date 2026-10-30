// Plain JavaScript syntax (no type annotations) so Node vm can load this file in tests.
var MASTERDATA_CONFIG = {
  TOKEN_PROPERTY: 'REFRESH_TOKEN',
  ACTIVE_RUN_PROPERTY: 'ACTIVE_RUN',
  LAST_ROW_COUNTS_PROPERTY: 'LAST_ROW_COUNTS',
  // 03_Master File from Snowflake
  FOLDER_ID: '1lP59mBX1dM24emOJlussSvMPbkBiTTUk',
  SNAPSHOT_FOLDER_NAME: 'Raw snapshots',
  RETENTION_DAYS: 30,
  MAX_ROW_DROP: 0.2,
  LOCK_TIMEOUT_MS: 30000,
  // Same as appsscript.json timeZone; used for _Refresh_Log times and the watchdog trigger.
  TIME_ZONE: 'Europe/Berlin',
  LOG_TIME_FORMAT: 'yyyy-MM-dd HH:mm:ss',
  // Locale set on begin so number and date parsing never follows a German locale.
  LOCALE: 'en_US',
  // Empty default sheets removed after a successful commit.
  DEFAULT_SHEET_NAMES: ['Sheet1', 'Tabelle1'],
  WATCHDOG_HANDLER: 'checkDailyRefresh',
  // R43: daily at 08:15 Berlin (nearMinute: Apps Script runs it within +-15 minutes).
  WATCHDOG_HOUR: 8,
  WATCHDOG_MINUTE: 15,
  // R49: the watchdog waits for a running puller execution (up to its 6-minute limit) instead of 30 s.
  WATCHDOG_LOCK_TIMEOUT_MS: 330000,
  // Drive Inbox (03_Master File from Snowflake/Inbox, shared drive): the nightly run uploads
  // <runId>__<feed>.json.gz files and <runId>__manifest.json last; pollInbox pulls them.
  INBOX_FOLDER_ID: '1PE6IcZqJFHM7ISA4XKNHpifk8oCVyqdV',
  PULL_HANDLER: 'pollInbox',
  // R54: every 5 minutes (a busy or idle poll exits within seconds).
  PULL_EVERY_MINUTES: 5,
  // tryLock wait; a busy lock means another execution is working, so the poll exits.
  PULL_LOCK_WAIT_MS: 5000,
  // Rows per staging write, and the time after which a poll stops (Apps Script kills executions at 6 min).
  // A slice is not started when elapsed + the previous slice's duration would pass the budget.
  PULL_SLICE_ROWS: 4000,
  PULL_BUDGET_MS: 270000,
  // The commit (snapshots + swap) only starts this early in a poll, so it never runs into the 6-minute kill.
  PULL_COMMIT_START_MAX_MS: 150000,
  // R51: a poll that stops early schedules a one-off pollInbox this long after it.
  PULL_CONTINUATION_DELAY_MS: 60000,
  PULL_CONTINUATION_PROPERTY: 'PULL_CONTINUATION_TRIGGERS',
  // R48: unexpected errors of a run are retried on later polls; the last attempt fails the run.
  PULL_MAX_ATTEMPTS: 3,
  PULL_RETRY_PROPERTY: 'PULL_RETRY',
  // R56: {runId, polls, stagedTotal}, persisted at the start of every poll that works on a run (before any work, so a
  // poll hard-killed at 6 minutes still counts). A run whose staged total has not grown for PULL_STALL_POLLS polls in a
  // row is failed ('no progress after 3 polls').
  PULL_PROGRESS_PROPERTY: 'PULL_PROGRESS',
  PULL_STALL_POLLS: 3,
  // runId of the last run whose swap into the live tabs completed (set by the commit itself).
  LAST_COMMITTED_RUN_PROPERTY: 'LAST_COMMITTED_RUN',
  // Last committed runId whose late failed manifest was logged INFO (logged once).
  LAST_LATE_FAILURE_RUN_PROPERTY: 'LAST_LATE_FAILURE_RUN',
  // Last runId logged as 'runId is in the future' (logged once).
  LAST_FUTURE_RUN_PROPERTY: 'LAST_FUTURE_RUN',
  // Inbox files that belong to no manifest are trashed once older than this.
  INBOX_ORPHAN_DAYS: 3,
  // R57: a manifest younger than this is left for a later poll (Drive listings can lag behind uploads).
  INBOX_MIN_AGE_MS: 120000,
  // runId of the last Inbox run that ended (committed or failed); runIds up to it are never processed again.
  LAST_PROCESSED_RUN_PROPERTY: 'LAST_PROCESSED_RUN',
  // Last error logged for a poll that failed outside any run, so a lasting problem is logged once.
  LAST_PULL_ERROR_PROPERTY: 'LAST_PULL_ERROR',
  LOG_SHEET: '_Refresh_Log',
  LOG_HEADERS: ['Run ID', 'Started', 'Finished', 'Feed', 'Rows', 'Source Refreshed At', 'Status', 'Message'],
  LOG_FIRST_ROW: 5,
  STAGING_PREFIX: '__staging_',
  // Live tab names in manifest (sql/feeds.json) order.
  TABS: ['Components', 'Multisource', 'Multisource_Members', 'Component_Usage', 'Products', 'MECL_Price'],
};
