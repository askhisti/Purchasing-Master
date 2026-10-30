---
name: probe-webapp
description: Spike S2 probe. POSTs a token-authenticated ping to the MasterData Apps Script web app and prints the HTTP status and body, plus which required env vars are present (names only).
---

# probe-webapp

Experiment only. Commit nothing. Never print the token or the URL value.

Run exactly:

```
node --input-type=module -e "
for (const n of ['MASTERDATA_WEBAPP_URL', 'MASTERDATA_TOKEN']) console.log(n, process.env[n] ? 'PRESENT' : 'MISSING');
const url = process.env.MASTERDATA_WEBAPP_URL;
const token = process.env.MASTERDATA_TOKEN;
if (!url || !token) { console.log('cannot probe: missing env var(s)'); process.exit(0); }
try {
  const res = await fetch(url, { method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ token, action: 'ping' }) });
  console.log('status', res.status);
  console.log('body', (await res.text()).slice(0, 2000));
} catch (e) {
  console.log('fetch failed, code:', (e.cause && e.cause.code) || e.name);
}
"
```

Reply with the printed output verbatim. Pass is `status 200` and body `{"ok":true,"pong":true}`. If the token is not in `MASTERDATA_TOKEN`, also list (names only, no values) any other env var names that look like the secret, so the findings record how the secret arrives.
