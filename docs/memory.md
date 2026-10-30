# Memory (living state)

## IDs and URLs

| Item | Value |
|---|---|
| MasterData sheet ID | (fill in) |
| Apps Script script ID | (fill in; also in `apps-script/MasterData/.clasp.json`) |
| Deployment ID | (fill in; also in `scripts/release-config.json`) |
| Web app `/exec` URL | (fill in; set as `MASTERDATA_WEBAPP_URL` in the cloud environment) |
| Cloud environment | `purchasing-master` |
| Schedule | 07:00 Europe/Berlin daily (not yet created) |

Secrets (`MASTERDATA_TOKEN`, Script Property `REFRESH_TOKEN`) are never recorded here.

## Phase 0 status

- S1 (capture hook): pending
- S2 (web app reachable from cloud): pending
- S3 (result size limit): pending
- R1: dropped by the user.

Results go into [phase-0-findings.md](phase-0-findings.md).

The `probe-connector` and `probe-webapp` skills in `.claude/skills/` stay until the phase-0 spikes have run; remove them afterwards.

## Release

`npm run release -- "<description>"` once `.clasp.json` and `scripts/release-config.json` hold real IDs.
