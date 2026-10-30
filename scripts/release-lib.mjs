// Pure config validation for release-gas.mjs (unit-tested).
// R55: the release is push-only (no web app deployment), so only the script id is needed.
export function resolveReleaseTarget(claspJsonText) {
  let scriptId = '';
  try { scriptId = String(JSON.parse(claspJsonText || '{}').scriptId || '').trim(); } catch { /* handled below */ }
  if (!scriptId) {
    throw new Error('Missing scriptId: create apps-script/MasterData/.clasp.json (clasp create/clone) with a non-empty "scriptId".');
  }
  return { scriptId };
}

// The description is passed through cmd.exe on Windows; refuse shell metacharacters.
export function checkDescription(desc) {
  const d = String(desc || '').trim();
  if (!d) throw new Error('Usage: npm run release -- "<description>"');
  if (/[&|<>^%"`]/.test(d)) {
    throw new Error('Release description must not contain & | < > ^ % " or `.');
  }
  return d;
}

// '' when no description was given (no clasp version), else the checked description.
export function optionalDescription(desc) {
  return String(desc || '').trim() ? checkDescription(desc) : '';
}
