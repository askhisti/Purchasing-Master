# Memory (living state)

## IDs and URLs

| Item | Value |
|---|---|
| MasterData sheet ID | `1xHaiQKQJdw6FYSplP1XhJqdHGxwSqsw6CnxUZwj1s3A` |
| Apps Script script ID | `1tvWWeoQrTm9s2yhORqkASkSaq9eixPfjRh6mNSqTryOJwoBurc2MEv95` (also in `apps-script/MasterData/.clasp.json`) |
| Drive Inbox folder ID | `1PE6IcZqJFHM7ISA4XKNHpifk8oCVyqdV` (in `refresh/config.json`; inside `03_Master File from Snowflake`, a shared drive) |
| Upload service account | `masterdata-uploader@rfq-mecl-automation-project.iam.gserviceaccount.com` (Editor on the Inbox; key in `MASTERDATA_SA_KEY` in the cloud environment) |
| Cloud environment | `purchasing-master` |
| Schedule | 06:15 Europe/Berlin daily (cloud run; not yet created) |
| Inbox puller | `pollInbox` every 5 minutes (R54; not yet installed) |
| Watchdog | `checkDailyRefresh` daily 08:15 Europe/Berlin (not yet installed) |

Secrets (`MASTERDATA_SA_KEY`) are never recorded here. A downloaded key file is deleted once its text is in the cloud environment; `.gitignore` blocks `*service-account*.json`, `rfq-mecl-automation-project-*.json` and `*-key.json`.

## Phase 0 status

- S1 (capture hook): pending
- S2 (web app reachable from cloud): FAIL (2026-10-30): `clasp create-deployment` was refused with "ANYONE access has been disabled by your domain administrator". The transport became the Drive Inbox (service account upload + `pollInbox`), see `docs/superpowers/plans/2026-10-30-amendment-drive-inbox-transport.md`. No web app deployment exists.
- S3 (result size limit): pending
- R1: dropped by the user.

Results go into [phase-0-findings.md](phase-0-findings.md).

The `probe-connector` skill in `.claude/skills/` stays until spikes S1/S3 have run; remove it afterwards. (`probe-webapp` is removed: S2 is closed.)

## Release

`npm run release` (R55, push-only): `npm test && npm run validate`, then `clasp push --force`. `npm run release -- "<description>"` also runs `clasp version "<description>"`. No deployment is created or updated.

## USER steps (one-time)

- [ ] Install the Inbox puller, after `clasp push` (of a version that contains `Puller.ts`): open the Apps Script editor of the MasterData sheet, select `installPullTrigger` and click Run once. Approve the permissions when prompted (`script.scriptapp` "manage triggers", Drive, Sheets). Check under Triggers that exactly one `pollInbox` trigger exists (time-driven, minutes timer, every 5 minutes). Re-running it is safe: it replaces the existing `pollInbox` trigger. The account that runs it needs Content manager (or Manager) on the shared drive `03_Master File from Snowflake`, so the puller can trash processed Inbox files.
- [ ] Install the daily watchdog (R37, R43), in the same editor: select `installDailyWatchdogTrigger` and click Run once. Check under Triggers that exactly one `checkDailyRefresh` trigger exists (time-driven, day timer, 08:00 to 09:00, Europe/Berlin; it fires near 08:15). Re-running it is safe: it replaces the existing `checkDailyRefresh` trigger (also one installed earlier at 10:00).
- Puller status: not installed (every 5 minutes).
- Watchdog status: not installed (08:15).
