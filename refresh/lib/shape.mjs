import { headersFor } from './manifest.mjs';

function typesFor(feedDef) {
  const types = feedDef.columns.map((c) => c.type);
  if (feedDef.demandYears) for (let k = 0; k < feedDef.demandYears.count; k++) types.push('number');
  return types;
}

const isEmpty = (v) => v === null || v === undefined || v === '';

function convert(v, type) {
  if (isEmpty(v)) return null;
  switch (type) {
    case 'number': {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error(`not a number: ${v}`);
      return n;
    }
    case 'boolean': {
      if (typeof v === 'boolean') return v;
      const s = String(v).toLowerCase();
      if (s === 'true') return true;
      if (s === 'false') return false;
      throw new Error(`not a boolean: ${v}`);
    }
    case 'date':
      return String(v).slice(0, 10);
    default:
      return String(v);
  }
}

// rawRows carry ROW_KEY in column 0; output rows follow sqlColumns order without it.
export function shapeFeed(feedDef, baseYear, rawRows, sqlColumns) {
  const headers = headersFor(feedDef, baseYear);
  const types = typesFor(feedDef);
  if (sqlColumns.length !== headers.length) throw new Error(`${feedDef.feed}: column count mismatch`);
  const rows = rawRows.map((raw, i) => {
    if (raw.length !== sqlColumns.length + 1) throw new Error(`${feedDef.feed}: row ${i} has ${raw.length} columns, expected ${sqlColumns.length + 1}`);
    return types.map((t, j) => convert(raw[j + 1], t));
  });
  return { headers, types, rows };
}
