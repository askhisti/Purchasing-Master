# Phase 0 findings

Template. Fill in after each spike run. Do not edit the spike inputs, record what happened.

## S1 + S3: capture hook and result size limit (Task 2)

Run date / environment:

| Query | Capture file exists? | chars | rows.length | numRows | shape unrecognized? | response is complete JSON? |
|---|---|---|---|---|---|---|
| (a) SELECT 1 AS ONE | | | | | | |
| (b) COMPONENT_PRICE_ID LIMIT 20000 | | | | | | |
| (c) 13 columns LIMIT 1200 | | | | | | |
| (c) 13 columns LIMIT 2400 | | | | | | |
| (c) 13 columns LIMIT 3600 | | | | | | |

- Captures appeared for small result (a): 
- Captures appeared for large results (b)/(c) (>50k chars): 
- `response` contains the full JSON for large results: 
- Largest `chars` that came back complete: 
- Smallest `chars` that was truncated: 
- `TARGET_PAGE_CHARS` = min(250000, 0.75 x smallest truncated size) = 
- Result: PASS / FAIL. Fail path: hook also accepts a file path argument; nightly skill passes the auto-saved result file to `node refresh/cli.mjs next --file <path>`; revise Tasks 5 and 10.

## S2: web app reachable from a cloud run (Task 3)

Run date / environment: 2026-10-30, local `clasp` against the MasterData script.

- Script ID: `1tvWWeoQrTm9s2yhORqkASkSaq9eixPfjRh6mNSqTryOJwoBurc2MEv95`
- Deployment ID: none. `clasp create-deployment` (web app, access `ANYONE_ANONYMOUS`) was refused: "ANYONE access has been disabled by your domain administrator".
- `/exec` URL: none.
- Reachable from cloud run (yes/no): not testable (no deployment); the probe-webapp skill was never run and has been removed.
- Result: **FAIL** (2026-10-30). Fail path taken: a GitHub data-branch route was blocked by Claude Code's safety check (company data leaving Google), so the transport is a Google Cloud service account that uploads into the Drive Inbox and the bound script pulls it (`pollInbox`). See `docs/superpowers/plans/2026-10-30-amendment-drive-inbox-transport.md`. The `webapp` block was removed from `appsscript.json` and the release is push-only (R55); `doPost` stays in the code but is not deployed.
