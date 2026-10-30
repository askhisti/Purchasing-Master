// Pure config validation for release-gas.mjs (unit-tested).
export function resolveReleaseTarget(claspJsonText, releaseConfigText) {
  let scriptId = '';
  let deploymentId = '';
  try { scriptId = String(JSON.parse(claspJsonText || '{}').scriptId || '').trim(); } catch { /* handled below */ }
  try { deploymentId = String(JSON.parse(releaseConfigText || '{}').deploymentId || '').trim(); } catch { /* handled below */ }
  if (!scriptId) {
    throw new Error('Missing scriptId: create apps-script/MasterData/.clasp.json (clasp create/clone) with a non-empty "scriptId".');
  }
  if (!deploymentId) {
    throw new Error('Missing deploymentId: set "deploymentId" in scripts/release-config.json (create the web app deployment once in the Apps Script editor).');
  }
  return { scriptId, deploymentId };
}
