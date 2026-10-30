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

- [ ] Install the daily watchdog (R37), after the first release that contains `Watchdog.ts`: open the Apps Script editor of the MasterData sheet, select `installDailyWatchdogTrigger` and click Run once. Approve the new permission (`script.scriptapp`, "manage triggers") when prompted. Check under Triggers that exactly one `checkDailyRefresh` trigger exists (time-driven, day timer, 10:00 to 11:00, Europe/Berlin). Re-running it is safe: it replaces the existing `checkDailyRefresh` trigger.
- Watchdog status: not installed.
