// Plain JavaScript syntax (no type annotations) so Node vm can load this file in tests.

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// Constant-time compare against Script Property REFRESH_TOKEN. Unset token rejects everything.
function checkToken_(provided) {
  var expected = PropertiesService.getScriptProperties().getProperty(MASTERDATA_CONFIG.TOKEN_PROPERTY);
  if (typeof provided !== 'string' || typeof expected !== 'string' || expected === '') return false;
  var diff = provided.length === expected.length ? 0 : 1;
  var n = Math.max(provided.length, expected.length);
  for (var i = 0; i < n; i++) {
    diff |= (provided.charCodeAt(i) || 0) ^ (expected.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function doPost(e) {
  var req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonOut_({ ok: false, error: 'bad request' });
  }
  if (!req || typeof req !== 'object') return jsonOut_({ ok: false, error: 'bad request' });
  if (!checkToken_(req.token)) return jsonOut_({ ok: false, error: 'unauthorized' });
  if (req.action === 'ping') return jsonOut_({ ok: true, pong: true });
  return jsonOut_({ ok: false, error: 'unknown action' });
}

// Run once from the editor with a new random 32-byte hex token.
function setRefreshToken(token) {
  PropertiesService.getScriptProperties().setProperty(MASTERDATA_CONFIG.TOKEN_PROPERTY, token);
}
