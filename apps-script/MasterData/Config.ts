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
  LOG_SHEET: '_Refresh_Log',
  LOG_HEADERS: ['Run ID', 'Started', 'Finished', 'Feed', 'Rows', 'Source Refreshed At', 'Status', 'Message'],
  LOG_FIRST_ROW: 5,
  STAGING_PREFIX: '__staging_',
  // Live tab names in manifest (sql/feeds.json) order.
  TABS: ['Components', 'Multisource', 'Multisource_Members', 'Component_Usage', 'Products', 'MECL_Price'],
};
