// Parse raw text returned by the Snowflake MCP `sql` tool.
// Accepts a JSON object with `result_set`, or a JSON array of content blocks
// `[{type:'text', text:'<json object>'}]` wrapping it.
export function parseConnectorResult(text) {
  let value = JSON.parse(text);
  if (Array.isArray(value)) {
    const inner = value.filter((b) => b && typeof b.text === 'string').map((b) => b.text).join('');
    value = JSON.parse(inner);
  }
  const rs = value && value.result_set;
  if (!rs || (rs.data !== undefined && !Array.isArray(rs.data)) || !rs.resultSetMetaData) {
    throw new Error('connector result has no result_set');
  }
  const meta = rs.resultSetMetaData;
  return {
    rows: rs.data ?? [],
    columns: (meta.rowType || []).map((c) => c.name),
    numRows: meta.numRows,
    chars: text.length,
  };
}
