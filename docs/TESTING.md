# Testing

## Commands

- `npm test`: `node --test "test/*.test.mjs"`.
- `npm run validate`: `tsc --noEmit -p tsconfig.json` (type check of the Apps Script sources).

## What the automated tests cover

- Refresh CLI logic: manifest (including `pageLimit` 500 and `targetPageChars`), SQL rendering and page sizing, the health gate text, result parsing, shaping, service account JWT signing and token request (retried after network errors, 5xx and 429 with an injected sleep; 400/401/403 not retried), Inbox payload building and multipart upload (order, retry of network errors, 5xx, 429 and 403 `rateLimitExceeded` / `userRateLimitExceeded` parsed from Google's error JSON; other 403s not retried; 5 MB limit), `finish`/`fail` against a fake Google fetch, a key-leak scan of stdout and error messages, the `next` state machine with fixture captures, the capture hook (repo root from `CLAUDE_PROJECT_DIR` or input `cwd`), main-module detection through a symlink/junction, `.claude/settings.json` and the skill's no-other-query rule.
- Apps Script code (`Core`, `Sheets`, `WebApp`, `Watchdog`, `Puller`) loaded in Node `vm` against fake SpreadsheetApp (including locale), DriveApp (folder listing incl. trashed items and same-name duplicates, binary files, `getDateCreated`, `setTrashed` with an injectable failure), Properties, Lock (`waitLock`, `tryLock`), Utilities (`formatDate`, `computeDigest` returning signed bytes, gzip) and ScriptApp (daily, every-5-minutes and one-off `after` triggers, `nearMinute`, `getUniqueId`): token auth, actions, staging and swap, log (Berlin times, `ABANDONED`, `NO_REFRESH`), guards, default-sheet cleanup, watchdog trigger install at 08:15.
- Inbox puller (`test/apps-script-puller.test.mjs`): a ready run lands all eight tabs, logs `OK`, writes CSV snapshots and trashes its files; a second poll does nothing; the time budget with an injected clock (no slice started when elapsed + the previous slice would pass 270 s; no commit after 150 s; the next poll resumes without re-running begin or restaging; one-off continuation trigger replaced, the 5-minute trigger kept; start time read before `tryLock`); 4,000-row slices; R48 retries (one transient error → `RETRY` then `OK`; a transient commit error keeps staging and the retry commits without restaging, with complete snapshots; three failures → `FAILED`; validation rejections final); a commit that finds the run inactive logs `FAILED`; sha256 mismatch, missing file, row-count mismatch, begin validation and unreadable manifests fail the run with live tabs untouched; same-name duplicates (matching copy used, failed manifest wins); failed manifests; two pending runs oldest first; stale orphans (`INCOMPLETE`); busy lock; `LAST_PROCESSED_RUN` (`SUPERSEDED` worded `older run superseded by <last>`, logged once and only after every file of the run is trashed, manifest last) and future runIds (logged once, never `LAST_PROCESSED_RUN`, also when logging fails); row-drop guard; unexpected errors logged once (rethrown only when nothing can be logged); `installPullTrigger` (every 5 minutes). R56 stalled runs with simulated hard kills (a marker error that bypasses every catch, like Apps Script's 6-minute kill): polls killed before staging and polls whose commit is killed both fail the run after 3 polls without progress (`no progress after 3 polls`, live tabs untouched, no `RETRY`); polls killed after staging a slice are progress and the run commits; a poll killed right after its commit is finished on the next poll without restaging, a second `OK` or `FAILED`. R57: a manifest younger than 2 minutes is left for a later poll (`waiting`), and a newer run is not processed ahead of it. A late failed manifest for the committed run logs one `INFO` row; for a failed run it is trashed silently. An end-to-end test feeds the exact files of Node's `buildPayload` for the real `sql/feeds.json` into the fake Inbox.
- End to end (`test/e2e.test.mjs`): `begin`/`next` over the real `sql/feeds.json` and SQL files with generated captures for all eight feeds, then `finish` against a fake Google fetch: one token request, six gz data files then the manifest last, decoded headers and rows with `0402` kept as a string and matching sha256 and row counts.
- Release (`scripts/release-lib.mjs`): scriptId check, description validation (optional; shell metacharacters refused), and a source check that `release-gas.mjs` runs tests and validate before `clasp push --force`, never deploys and no longer reads `scripts/release-config.json` (deleted).
- Repo config (`test/repo-config.test.mjs`): `.clasp.json` `filePushOrder` lists every `.ts` file (incl. `Puller.ts`); `appsscript.json` has no `webapp` block and only the `spreadsheets`, `drive`, `script.scriptapp` scopes, and no source calls `getUi`; `.gitignore` blocks downloaded service account key files.

## What they do not cover

- Real Google services: `getActiveSpreadsheet()` in a time-driven trigger, real sheet type coercion, `setSpreadsheetLocale`, tab ordering in a real spreadsheet, Drive folders (the shared-drive Inbox, trash permissions), real triggers, quotas and execution time limits (how many 4,000-row slices fit in 270 s).
- The real Snowflake connector, result sizes, the health gate against live `PLATFORM_HEALTH`, hook behaviour in the cloud (`$CLAUDE_PROJECT_DIR` expansion), and network reachability.
- `scripts/release-gas.mjs` itself (the clasp calls) is not run by the tests; only its config validation and its source shape are checked.
- A real 6-minute kill: the tests simulate it with an error that skips every catch block; the real kill also skips `finally` (the lock is then released by Apps Script).

## USER step: install the triggers (once)

After `clasp push` (`npm run release`) of a version containing `Puller.ts`, run `installPullTrigger` and `installDailyWatchdogTrigger` once each from the Apps Script editor and approve the permissions (see `docs/memory.md`, USER steps). Then check:

- [ ] Triggers page shows exactly one `pollInbox` trigger, time-driven, every 5 minutes.
- [ ] Triggers page shows exactly one `checkDailyRefresh` trigger, time-driven, daily 08:00 to 09:00 Europe/Berlin (fires near 08:15).
- [ ] After the first nightly run: the Inbox is empty again, `_Refresh_Log` shows `OK` rows for the run, and the `pollInbox` executions (Executions page) finished without errors, each under 6 minutes.
- [ ] Slice timing: in the Executions page, the `pollInbox` executions that staged the run (Components is the largest feed) took well under 270 s each, and the commit execution well under 6 minutes; if a poll stopped early, a one-off `pollInbox` trigger ran about a minute later and no one-off trigger is left afterwards.
- [ ] The account that installed the triggers has Content manager (or Manager) on the shared drive `03_Master File from Snowflake` (otherwise processed Inbox files are not trashed).
- [ ] The watchdog still runs when a `pollInbox` execution is busy at 08:15 (it waits for the lock; no "lock timeout" failure): `waitLock(330000)` is accepted by Apps Script (no error about the timeout value in the `checkDailyRefresh` execution).
- [ ] `getActiveSpreadsheet()` returns MasterData inside the time-driven `pollInbox` and `checkDailyRefresh` (bound script, no UI).
- [ ] The trigger owner can trash files the service account created in the shared-drive Inbox (after a run the Inbox is empty; no `cannot trash` lines in the execution log).
- [ ] One-off continuation triggers do not pile up: the Triggers page shows fewer than 20 triggers in total after a run (Apps Script's limit is 20 per user per script).
- [ ] Running `checkDailyRefresh` from the editor on a day without a successful refresh adds a `NO_REFRESH` row to `_Refresh_Log`; on a day with one it adds nothing.

## Manual live-run checklist

Before the first run:

- [ ] Google Drive API is enabled in the Google Cloud project `rfq-mecl-automation-project` (APIs & Services).
- [ ] The cloud environment's network allowlist contains `oauth2.googleapis.com` and `www.googleapis.com` (plus the default list).
- [ ] `MASTERDATA_SA_KEY` holds the key JSON text; afterwards the downloaded key file is deleted from the local machine (it is never committed; `.gitignore` blocks the usual names).
- [ ] The service account can create files in the shared-drive Inbox: a test upload (or the first run) gives no storage-quota error (a service account has no own Drive quota; files in a shared drive do not need one).

Run once in the cloud environment `purchasing-master` with the prompt "Run the nightly-refresh skill." (Snowflake connector only).

- [ ] The cloud run is not blocked by Claude Code's safety checks (the upload to Google Drive with the service account goes through; no prompt or refusal in the transcript).
- [ ] Record the cloud run's duration (start to `DONE`) here: ______; it must finish well before 08:00 Berlin when scheduled at 06:15.
- [ ] Slice and commit timings from the Executions page: seconds per 4,000-row slice ______, commit execution ______ s (well under 6 minutes).

- [ ] Final line is `DONE` with eight feeds.
- [ ] `_Refresh_Log` has a row `OK` per feed and `B1` = today (ISO UTC); Started/Finished show Berlin time `yyyy-MM-dd HH:mm:ss`, Started = the CLI run start.
- [ ] The eight tabs exist with headers exactly as in `docs/sheets.md`; the 7 removed tabs are gone.
- [ ] `Components` and `Product_Volumes` headers read `... Demand 2025 | 2026-01 ... 2026-12 | Demand 2026 | 2027-01 ... | Demand 2027 | Demand 2028 ...` (`Units` instead of `Demand` in `Product_Volumes`).
- [ ] In a generated manufacturer file, the sum of the 2026-xx cells of a line equals its Volume 2026.
- [ ] Deploy note: push the Apps Script and run the CLI from the same commit (the Apps Script rejects a run whose feed set differs from `TABS`).
- [ ] `Components` row ME_EC_0000001 Demand <Y> equals the Snowflake value queried directly.
- [ ] `Raw snapshots/<today>/` has eight CSVs with header and row counts matching the log.
- [ ] Snowflake connector calls in the run are <= 45, and the transcript shows no Snowflake tool other than `sql` with the CLI's SQL.
- [ ] The capture hook wrote captures (`$CLAUDE_PROJECT_DIR` resolved in the cloud).
- [ ] `getActiveSpreadsheet()` works inside the time-driven `pollInbox` of the bound script.
- [ ] Spreadsheet locale is `en_US` (File > Settings) after the run; an empty `Sheet1` / `Tabelle1` is gone.
- [ ] A part number with a leading zero (e.g. 0402) shows the zero, and `1E3` stay text.
- [ ] Tab order is correct after the swap (`moveActiveSheet` without UI).
- [ ] A string starting with `=` is stored as text, not a formula.
- [ ] Number columns show without a trailing dot.

## Manufacturer file live checklist

- [ ] After pushing, reload the MasterData sheet: the menu `MasterData` > `Create manufacturer file...` appears and the one-time authorisation (container UI scope) is granted.
- [ ] The dialog opens at a readable size, lists categories with counts, ticking a category ticks its subcategories, and toggling "Only parts we use" changes the counts.
- [ ] Creating a file for a small selection returns within the 6-minute limit and shows the name, "Open file" and "Download as Excel" links; the file sits in `03_Master File from Snowflake/Manufacturer files`.
- [ ] The four sheets are in order (`Read me`, `Our parts`, `Your alternatives`, `Your pricing`); `Our parts` is protected and frozen; part numbers with leading zeros keep them; volume columns show numbers (the `General` number format is accepted).
- [ ] The month headers in `Our parts` read `2026-01` etc. (text, not dates).
- [ ] Sharing the file with a test account as editor: only `Your alternatives` E-I and `Your pricing` D onward (and the extra rows) can be edited; the Yes/No list works on F.
- [ ] The downloaded xlsx opens in Excel with all sheets.
- [ ] A very large selection (all categories) gives `The selection is too large; select fewer categories.` or finishes in time; record the time and row count: ______.
- [ ] Gate before the first external share: open a generated file as a different editor: `Read me`, `Our parts` and the grey columns of `Your alternatives` / `Your pricing` cannot be edited (the protections only work because other editors were removed from them). Do not share any file with a manufacturer until this passes.
- [ ] `Read me` cannot be edited by another editor.
