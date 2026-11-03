import { headersFor, demandYearsFor } from './manifest.mjs';

function typesFor(feedDef, baseYear) {
  return [...feedDef.columns.map((c) => c.type), ...demandYearsFor(feedDef, baseYear).map(() => 'number')];
}

const isEmpty = (v) => v === null || v === undefined || v === '';

function convert(v, type) {
  if (isEmpty(v)) return null;
  switch (type) {
    case 'number': {
      const t = String(v).trim();
      if (t === '') return null;
      if (!/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(t)) throw new Error(`not a number: ${v}`);
      return Number(t);
    }
    case 'boolean': {
      if (typeof v === 'boolean') return v;
      const s = String(v).toLowerCase();
      if (s === 'true') return true;
      if (s === 'false') return false;
      throw new Error(`not a boolean: ${v}`);
    }
    case 'date': {
      const t = String(v);
      if (!/^\d{4}-\d{2}-\d{2}/.test(t)) throw new Error(`not a date: ${v}`);
      return t.slice(0, 10);
    }
    default:
      return String(v);
  }
}

// rawRows carry ROW_KEY in column 0; output rows follow sqlColumns order without it.
export function shapeFeed(feedDef, baseYear, rawRows, sqlColumns) {
  const headers = headersFor(feedDef, baseYear);
  const types = typesFor(feedDef, baseYear);
  if (sqlColumns.length !== headers.length) throw new Error(`${feedDef.feed}: column count mismatch`);
  const rows = rawRows.map((raw, i) => {
    if (raw.length !== sqlColumns.length + 1) throw new Error(`${feedDef.feed}: row ${i} has ${raw.length} columns, expected ${sqlColumns.length + 1}`);
    return types.map((t, j) => {
      try {
        return convert(raw[j + 1], t);
      } catch (e) {
        throw new Error(`${feedDef.feed} column ${headers[j]}: ${e.message}`);
      }
    });
  });
  return { headers, types, rows };
}
