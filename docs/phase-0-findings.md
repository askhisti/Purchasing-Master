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

- Script ID: 
- Deployment ID: 
- `/exec` URL: (also in docs/memory.md)
- Reachable from cloud run (yes/no): 
- Env vars present (names only, from probe-webapp output): MASTERDATA_WEBAPP_URL: , MASTERDATA_TOKEN: 
- How the secret reaches the process (env var name or injected header): 
- HTTP status: 
- Response body: 
- Result: PASS (`{"ok":true,"pong":true}`) / FAIL. Fail path: switch to the GitHub `data`-branch transport (spec section 5) and write a plan amendment replacing Task 7's client and Task 8's `doPost` with a pull trigger.
