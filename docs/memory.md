# Memory (living state)

## IDs and URLs

| Item | Value |
|---|---|
| MasterData sheet ID | (fill in) |
| Apps Script script ID | (fill in; also in `apps-script/MasterData/.clasp.json`) |
| Deployment ID | (fill in; also in `scripts/release-config.json`) |
| Drive Inbox folder ID | `1PE6IcZqJFHM7ISA4XKNHpifk8oCVyqdV` (in `refresh/config.json`; inside `03_Master File from Snowflake`, a shared drive) |
| Upload service account | `masterdata-uploader@rfq-mecl-automation-project.iam.gserviceaccount.com` (Editor on the Inbox; key in `MASTERDATA_SA_KEY` in the cloud environment) |
| Cloud environment | `purchasing-master` |
| Schedule | 06:15 Europe/Berlin daily (not yet created) |

Secrets (`MASTERDATA_SA_KEY`) are never recorded here.

## Phase 0 status

- S1 (capture hook): pending
- S2 (web app reachable from cloud): pending
- S3 (result size limit): pending
- R1: dropped by the user.

Results go into [phase-0-findings.md](phase-0-findings.md).

The `probe-connector` and `probe-webapp` skills in `.claude/skills/` stay until the phase-0 spikes have run; remove them afterwards.

## Release

`npm run release -- "<description>"` once `.clasp.json` and `scripts/release-config.json` hold real IDs.

## USER steps (one-time)

- [ ] Install the Inbox puller, after the first release that contains `Puller.ts`: open the Apps Script editor of the MasterData sheet, select `installPullTrigger` and click Run once. Approve the permissions when prompted (`script.scriptapp` "manage triggers", Drive). Check under Triggers that exactly one `pollInbox` trigger exists (time-driven, minutes timer, every 15 minutes). Re-running it is safe: it replaces the existing `pollInbox` trigger. The account that runs it needs Content manager (or Manager) on the shared drive `03_Master File from Snowflake`, so the puller can trash processed Inbox files.
- [ ] Install the daily watchdog (R37, R43), in the same editor: select `installDailyWatchdogTrigger` and click Run once. Check under Triggers that exactly one `checkDailyRefresh` trigger exists (time-driven, day timer, 08:00 to 09:00, Europe/Berlin; it fires near 08:15). Re-running it is safe: it replaces the existing `checkDailyRefresh` trigger (also one installed earlier at 10:00).
- Puller status: not installed.
- Watchdog status: not installed (08:15).
