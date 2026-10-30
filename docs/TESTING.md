# Testing

## Commands

- `npm test`: `node --test "test/*.test.mjs"`.
- `npm run validate`: `tsc --noEmit -p tsconfig.json` (type check of the Apps Script sources).

## What the automated tests cover

- Refresh CLI logic: manifest (including `pageLimit` 500 and `targetPageChars`), SQL rendering and page sizing, the health gate text, result parsing, shaping, chunking and push with a fake fetch, the `next` state machine with fixture captures, the capture hook (repo root from `CLAUDE_PROJECT_DIR` or input `cwd`), main-module detection through a symlink/junction, `.claude/settings.json` and the skill's no-other-query rule.
- Apps Script code (`Core`, `Sheets`, `WebApp`, `Watchdog`) loaded in Node `vm` against fake SpreadsheetApp (including locale), DriveApp, Properties, Lock, Utilities (`formatDate`) and ScriptApp (triggers): token auth, actions, staging and swap, log (Berlin times, `ABANDONED`, `NO_REFRESH`), guards, default-sheet cleanup, watchdog trigger install.
- End to end (`test/e2e.test.mjs`): `begin`/`next` over the real `sql/feeds.json` and SQL files with generated captures for all six feeds, then `finish` through a fetch shim into the vm-loaded `doPost`: six live tabs with the expected headers and rows, `0402` kept as text, six CSV snapshots, `OK` log rows.
- Release config validation (`scripts/release-lib.mjs`).

## What they do not cover

- Real Google services: `getActiveSpreadsheet()` in `doPost` and in a time-driven trigger, real sheet type coercion, `setSpreadsheetLocale`, tab ordering in a real spreadsheet, Drive folders, real triggers, quotas and execution time limits.
- The real Snowflake connector, result sizes, the health gate against live `PLATFORM_HEALTH`, hook behaviour in the cloud (`$CLAUDE_PROJECT_DIR` expansion), and network reachability.
- `scripts/release-gas.mjs` itself (the clasp calls) is untested by design; only its config validation is unit-tested.

## USER step: install the watchdog trigger (once)

After the first release containing `Watchdog.ts`, run `installDailyWatchdogTrigger` once from the Apps Script editor and approve the trigger permission (see `docs/memory.md`, USER steps). Then check:

- [ ] Triggers page shows exactly one `checkDailyRefresh` trigger, time-driven, daily 10:00 to 11:00 Europe/Berlin.
- [ ] Running `checkDailyRefresh` from the editor on a day without a successful refresh adds a `NO_REFRESH` row to `_Refresh_Log`; on a day with one it adds nothing.

## Manual live-run checklist

Run once in the cloud environment `purchasing-master` with the prompt "Run the nightly-refresh skill." (Snowflake connector only).

- [ ] Final line is `DONE` with six feeds.
- [ ] `_Refresh_Log` has a row `OK` per feed and `B1` = today (ISO UTC); Started/Finished show Berlin time `yyyy-MM-dd HH:mm:ss`, Started = the CLI run start.
- [ ] The six tabs exist with headers exactly as in `docs/sheets.md`.
- [ ] `Components` row ME_EC_0000001 Demand <Y> equals the Snowflake value queried directly.
- [ ] `Raw snapshots/<today>/` has six CSVs with header and row counts matching the log.
- [ ] Snowflake connector calls in the run are <= 45, and the transcript shows no Snowflake tool other than `sql` with the CLI's SQL.
- [ ] The capture hook wrote captures (`$CLAUDE_PROJECT_DIR` resolved in the cloud).
- [ ] `getActiveSpreadsheet()` works inside `doPost` of the bound web app.
- [ ] Spreadsheet locale is `en_US` (File > Settings) after the run; an empty `Sheet1` / `Tabelle1` is gone.
- [ ] A part number with a leading zero (e.g. 0402) shows the zero, and `1E3` stay text.
- [ ] Tab order is correct after the swap (`moveActiveSheet` without UI).
- [ ] A string starting with `=` is stored as text, not a formula.
- [ ] Number columns show without a trailing dot.
