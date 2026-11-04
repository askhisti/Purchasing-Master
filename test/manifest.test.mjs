import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest, headersFor, sqlColumnsFor, demandYearsFor, demandMonthsFor } from '../refresh/lib/manifest.mjs';
import vm from 'node:vm';
import { renderFeedSql } from '../refresh/lib/sql.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Spec §6, copied as literals.
const SPEC = {
  components: ['Components', ['ME_EC', 'Manufacturer', 'MPN', 'Description', 'HW Category', 'HW Subcategory', 'Component Status', 'Lifecycle', 'Years To EOL', 'ME_MS', 'Primary ME_MS', 'EMS Part Numbers', 'Is Sourced By Us']],
  multisource: ['Multisource', ['ME_MS', 'Sourcing Health', 'Member Count', 'Usable Member Count', 'Manufacturer Count']],
  multisource_members: ['Multisource_Members', ['ME_MS', 'ME_EC', 'Member Status', 'Is Usable', 'Member Priority', 'Manufacturer', 'MPN']],
  component_usage: ['Component_Usage', ['ME_EC', 'MPN', 'Manufacturer', 'Product', 'Product ID', 'Project', 'Program', 'Customer', 'EMS', 'Qty Per Unit']],
  products: ['Products', ['Product ID', 'Product Display Name', 'Project', 'Program', 'Customer', 'Sample Phase', 'EMS', 'SOP', 'Is Hierarchy Active']],
  mecl_price: ['MECL_Price', ['Price ID', 'ME_EC', 'Resolved ME_EC', 'Is Linked', 'Price Type', 'Price Owner', 'Vendor', 'Vendor Part Number', 'Volume Stage', 'Year', 'MOQ', 'Price', 'Currency', 'Price EUR (current rate)', 'Quoted Unit', 'Quoted Manufacturer', 'Quoted MPN', 'Quote Reference', 'Quote File', 'Valid From', 'Valid Until', 'Is Valid Today', 'Is Binding', 'Created At']],
};
const WITH_DEMAND = new Set(['components', 'multisource', 'component_usage']);
const MONTHLY = {
  product_volumes: ['Product_Volumes', ['Product ID', 'Product Display Name', 'Project', 'Program', 'Customer', 'EMS', 'Flow']],
  component_demand_monthly: ['Component_Demand_Monthly', ['ME_EC', 'MPN', 'Manufacturer', 'HW Category', 'HW Subcategory', 'Primary ME_MS']],
  bom_demand_monthly: ['BOM_Demand_Monthly', ['ME_EC', 'MPN', 'Manufacturer', 'Product', 'Product ID', 'EMS', 'Flow', 'Qty Per Unit']],
};
const PRICE = {
  price_at_demand: ['Price_At_Demand', ['ME_EC', 'MPN', 'Manufacturer', 'Year', 'EMS', 'EMS Demand', 'Total Demand', 'EMS Price EUR', 'EMS Price Stage', 'LOA Price EUR', 'LOA Price Stage', 'Target Price EUR', 'Best Binding Price EUR', 'Best Binding Price Type', 'Expected Spend EUR', 'Target Spend EUR', 'Gap To Target EUR', 'Is Priced', 'Is Below Lowest Stage', 'Source Refreshed At']],
  savings_levers: ['Savings_Levers', ['ME_EC', 'MPN', 'Manufacturer', 'Year', 'EMS', 'Spend Rank In Year', 'Cumulative Spend Share %', 'Expected Spend EUR', 'Component Spend In Year EUR', 'LOA Pass-Through Risk EUR', 'No LOA Spend EUR', 'EMS Harmonisation Saving EUR', 'Lowest EMS', 'Lowest EMS Price EUR', 'Alternative Saving EUR', 'Best Alternative MPN', 'Best Alternative Price EUR', 'Stale Price Spend EUR', 'Below Lowest Stage Spend EUR', 'Gap To Target EUR', 'Is Quote Expired', 'Is Carried Forward', 'Price Valid Until', 'Has LOA Price', 'Has Target Price', 'Source Refreshed At']],
};
const HEALTH = {
  quote_health: ['Quote_Health', ['ME_EC', 'MPN', 'Manufacturer', 'HW Category', 'Next Demand Year', 'Demand Next 12 Months', 'Valid LOA Quotes', 'Expired LOA Quotes', 'LOA Valid Until', 'Valid EMS Quotes', 'Expired EMS Quotes', 'EMS Valid Until', 'Last Quoted On', 'Stale Price Spend EUR', 'Status'], 500],
  multisource_health: ['Multisource_Health', ['ME_EC', 'MPN', 'Manufacturer', 'HW Category', 'Sourcing Level', 'True Single Source Placements', 'Single Source Reasons', 'Usable Alternates', 'ME_MS', 'Cluster Sourcing Health', 'Products Using', 'Demand Current Year'], 500],
  bom_coverage: ['BOM_Coverage', ['Year', 'Planned Units', 'Released BOM Units', 'Released BOM Share %'], 100],
};
const months = Array.from({ length: 144 }, (_, k) => `${2025 + Math.floor(k / 12)}-${String(k % 12 + 1).padStart(2, '0')}`);

// Blank out comments and string literals so structure scanning is safe.
function clean(sql) {
  return sql.replace(/--[^\n]*/g, '').replace(/'(?:[^']|'')*'/g, "''");
}

// Returns the aliases of the final (last depth-0) SELECT list and the clean text.
function finalSelect(sql) {
  const s = clean(sql);
  let depth = 0;
  let last = -1;
  let from = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && /[A-Za-z]/.test(ch) && !/[A-Za-z0-9_]/.test(s[i - 1] || ' ')) {
      const w = /^[A-Za-z_]+/.exec(s.slice(i))[0].toUpperCase();
      if (w === 'SELECT') { last = i; from = -1; }
      else if (w === 'FROM' && last >= 0 && from < 0) from = i;
      i += w.length - 1;
    }
  }
  assert.ok(last >= 0 && from > last, 'final SELECT ... FROM not found');
  const list = s.slice(last + 6, from);
  const items = [];
  let d = 0;
  let cur = '';
  for (const ch of list) {
    if (ch === '(') d++;
    if (ch === ')') d--;
    if (ch === ',' && d === 0) { items.push(cur); cur = ''; } else cur += ch;
  }
  items.push(cur);
  const aliases = items.map((it) => {
    const m = /(?:\bAS\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*$/i.exec(it.trim());
    assert.ok(m, 'cannot read alias of: ' + it);
    return m[1];
  });
  return { aliases, s };
}

const manifest = loadManifest();

test('manifest lists the feeds in order with spec tab names', () => {
  assert.deepEqual(manifest.feeds.map((f) => f.feed), [...Object.keys(SPEC), ...Object.keys(MONTHLY), 'bom_sources', ...Object.keys(PRICE), ...Object.keys(HEALTH)]);
  for (const f of manifest.feeds) assert.equal(f.tab, f.feed === 'bom_sources' ? 'BOM_Sources' : (SPEC[f.feed] || MONTHLY[f.feed] || PRICE[f.feed] || HEALTH[f.feed])[0]);
});

test('monthly feeds: headers, years and 24 rolling month columns', () => {
  const get = (n) => manifest.feeds.find((f) => f.feed === n);
  const cdm = headersFor(get('component_demand_monthly'), 2026);
  assert.deepEqual(cdm.slice(0, 6), MONTHLY.component_demand_monthly[1]);
  assert.equal(cdm.length, 6 + 12 + 24);
  const pv = headersFor(get('product_volumes'), 2026);
  assert.deepEqual(pv.slice(0, 7), MONTHLY.product_volumes[1]);
  assert.equal(pv[7], 'Units 2025'); assert.equal(pv[8], '2026-01');
  assert.equal(pv.at(-1), 'Units 2036');
  const bom = headersFor(get('bom_demand_monthly'), 2026);
  assert.equal(bom[7], 'Qty Per Unit');
  assert.deepEqual(bom.slice(0, 8), MONTHLY.bom_demand_monthly[1]);
  assert.equal(bom.length, 8 + 12 + 24);
  for (const n of Object.keys(MONTHLY)) assert.equal(get(n).pageLimit, 200, n);
});

test('price feeds: headers exactly as spec section 5, pageLimit 500, no year or month columns', () => {
  assert.equal(PRICE.price_at_demand[1].length, 20);
  assert.equal(PRICE.savings_levers[1].length, 26);
  for (const [name, [tab, headers]] of Object.entries(PRICE)) {
    const f = manifest.feeds.find((x) => x.feed === name);
    assert.ok(f, name + ' in manifest');
    assert.equal(f.tab, tab);
    assert.equal(f.pageLimit, 500);
    assert.ok(!f.demandYears && !f.demandMonths && !f.demand, name + ' has no demand expansion');
    assert.deepEqual(headersFor(f, 2026), headers);
  }
  const types = (n) => Object.fromEntries(manifest.feeds.find((x) => x.feed === n).columns.map((c) => [c.header, c.type]));
  assert.equal(types('price_at_demand')['Source Refreshed At'], 'string');
  assert.equal(types('savings_levers')['Price Valid Until'], 'date');
  assert.equal(types('savings_levers')['Is Quote Expired'], 'boolean');
  assert.equal(types('price_at_demand')['Year'], 'number');
});

test('health feeds: headers, types, page limits; tabs equal MASTERDATA_CONFIG.TABS', () => {
  const types = (n) => Object.fromEntries(manifest.feeds.find((x) => x.feed === n).columns.map((c) => [c.header, c.type]));
  for (const [name, [tab, headers, limit]] of Object.entries(HEALTH)) {
    const f = manifest.feeds.find((x) => x.feed === name);
    assert.ok(f, name + ' in manifest');
    assert.equal(f.tab, tab);
    assert.equal(f.pageLimit, limit);
    assert.ok(!f.demandYears && !f.demandMonths, name + ' has no demand expansion');
    assert.deepEqual(headersFor(f, 2026), headers);
  }
  const q = types('quote_health');
  for (const h of ['Next Demand Year', 'Demand Next 12 Months', 'Valid LOA Quotes', 'Expired LOA Quotes', 'Valid EMS Quotes', 'Expired EMS Quotes', 'Stale Price Spend EUR']) assert.equal(q[h], 'number', h);
  for (const h of ['LOA Valid Until', 'EMS Valid Until', 'Last Quoted On']) assert.equal(q[h], 'date', h);
  assert.equal(q.Status, 'string');
  const m = types('multisource_health');
  for (const h of ['True Single Source Placements', 'Products Using', 'Demand Current Year']) assert.equal(m[h], 'number', h);
  assert.equal(m.ME_MS, 'string');
  for (const t of Object.values(types('bom_coverage'))) assert.equal(t, 'number');
  const context = {};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, 'apps-script/MasterData/Config.ts'), 'utf8'), context);
  assert.deepEqual([...vm.runInContext('MASTERDATA_CONFIG.TABS', context)], manifest.feeds.map((f) => f.tab));
});

test('bom_sources: 14 headers then Volume 2025..2036, tab BOM_Sources, pageLimit 300', () => {
  const f = manifest.feeds.find((x) => x.feed === 'bom_sources');
  assert.ok(f, 'bom_sources in manifest');
  assert.equal(f.tab, 'BOM_Sources');
  assert.equal(f.pageLimit, 300);
  const base = ['Product', 'Product ID', 'EMS', 'BOM ME_EC', 'ME_MS', 'Source Position', 'Source ME_EC', 'Manufacturer', 'MPN', 'HW Category', 'HW Subcategory', 'Member Status', 'Is Usable', 'Volume Type'];
  const years = Array.from({ length: 12 }, (_, k) => `Volume ${2025 + k}`);
  const h = headersFor(f, 2026);
  assert.deepEqual(h, [...base, ...years]);
  assert.equal(h.length, 26);
  assert.equal(f.columns.find((c) => c.sql === 'SOURCE_POSITION').type, 'number');
  assert.equal(f.columns.find((c) => c.sql === 'IS_USABLE').type, 'boolean');
});

test('headers equal spec section 6 exactly', () => {
  for (const f of manifest.feeds) {
    if (!SPEC[f.feed]) continue;
    const expected = [...SPEC[f.feed][1]];
    if (WITH_DEMAND.has(f.feed)) for (let y = 2025; y <= 2036; y++) expected.push(`Demand ${y}`);
    assert.deepEqual(headersFor(f, 2026), expected, f.feed);
    assert.equal(f.demandYears !== undefined, WITH_DEMAND.has(f.feed), f.feed);
  }
});

test('headersFor components ends with Demand 2025 ... Demand 2036 in 2026', () => {
  const h = headersFor(manifest.feeds[0], 2026);
  assert.deepEqual(h.slice(-12), Array.from({ length: 12 }, (_, k) => `Demand ${2025 + k}`));
});

test('demand years start at a fixed first year and grow by one column each year', () => {
  const f = manifest.feeds[0];
  assert.deepEqual(demandYearsFor(f, 2026), Array.from({ length: 12 }, (_, k) => 2025 + k));
  assert.deepEqual(demandYearsFor(f, 2027), Array.from({ length: 13 }, (_, k) => 2025 + k));
  assert.deepEqual(headersFor(f, 2027).slice(-13, -12), ['Demand 2025'], 'old year columns are kept');
  assert.deepEqual(demandYearsFor(manifest.feeds.find((x) => !x.demandYears), 2026), []);
  assert.throws(() => demandYearsFor(f, 2026.5));
  assert.throws(() => demandYearsFor(f, 2014), /no demand years/);
});

test('sqlColumnsFor excludes ROW_KEY and matches manifest columns', () => {
  for (const f of manifest.feeds) {
    const cols = sqlColumnsFor(f, 2026);
    assert.ok(!cols.includes('ROW_KEY'));
    assert.deepEqual(cols.slice(0, f.columns.length), f.columns.map((c) => c.sql));
    assert.equal(cols.length, f.columns.length + (f.demandYears ? 12 : 0) + (f.demandMonths ? 24 : 0));
    if (f.demandYears && !f.demandMonths) assert.deepEqual(cols.slice(-2), [`${f.demandYears.sqlPrefix}2035`, `${f.demandYears.sqlPrefix}2036`]);
  }
});

for (const f of loadManifest().feeds) {
  test(`${f.feed}: SQL file shape`, () => {
    const file = path.join(root, f.sqlFile);
    assert.ok(fs.existsSync(file), 'sqlFile exists');
    const text = fs.readFileSync(file, 'utf8');
    const sql = renderFeedSql(text, 2026, demandYearsFor(f, 2026), demandMonthsFor(f, 2026));
    assert.ok(!sql.includes('{{'), 'no placeholder left after rendering');
    const { aliases, s } = finalSelect(sql);
    assert.equal(aliases[0], 'ROW_KEY');
    const expected = ['ROW_KEY', ...sqlColumnsFor(f, 2026)];
    assert.deepEqual(aliases, expected, 'aliases in manifest order');
    assert.equal(new Set(aliases).size, aliases.length, 'aliases unique');
    const demand = aliases.filter((a) => /^(DEMAND|UNITS|VOLUME)_\d{4}$/.test(a));
    assert.equal(demand.length, f.demandYears ? 12 : 0);
    assert.equal(/\{\{(DEMAND|SERIES):/.test(text), Boolean(f.demandYears), 'demand template only in demand feeds');
    // top-level ORDER BY / LIMIT
    let depth = 0;
    let top = '';
    for (const ch of s) { if (ch === '(') depth++; else if (ch === ')') depth--; else if (depth === 0) top += ch; }
    assert.ok(!/\bORDER\s+BY\b/i.test(top) && !/\bLIMIT\b/i.test(top), 'no top-level ORDER BY/LIMIT');
    assert.ok(Number.isInteger(f.pageLimit) && f.pageLimit > 0);
  });
}

test('health.sql returns BASE_YEAR, PROBLEM_COUNT, PROBLEM_LIST', () => {
  const sql = fs.readFileSync(path.join(root, 'sql/health.sql'), 'utf8');
  for (const a of ['BASE_YEAR', 'PROBLEM_COUNT', 'PROBLEM_LIST']) assert.match(sql, new RegExp(`AS ${a}\\b`));
  assert.ok(!/\{\{/.test(sql));
});

test('paging: every feed starts at pageLimit 500 (200 for monthly feeds, 300 for bom_sources, 100 for bom_coverage); targetPageChars is 250000', () => {
  for (const f of manifest.feeds) assert.equal(f.pageLimit, f.feed === 'bom_sources' ? 300 : MONTHLY[f.feed] ? 200 : f.feed === 'bom_coverage' ? 100 : 500, f.feed);
  assert.equal(manifest.targetPageChars, 250000);
});

test('R34: health gate blocks on the MECL snapshot area and the three refresh tasks only', () => {
  const sql = fs.readFileSync(path.join(root, 'sql/health.sql'), 'utf8');
  // Comments removed, whitespace collapsed, no space just inside parentheses.
  const n = sql.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')');
  const gate = "IS_PROBLEM AND (AREA = 'MECL_SNAPSHOT' OR OBJECT_NAME IN ('TASK_REFRESH_PURCHASING', 'TASK_REFRESH_SUPPLY_CHAIN', 'TASK_REFRESH_PLATFORM_HEALTH'))";
  assert.equal(n.split(gate).length - 1, 2, 'PROBLEM_COUNT and PROBLEM_LIST use the same gate');
  // Feed view names never appear in PLATFORM_HEALTH, so they must not be the gate.
  for (const v of ['COMPONENT_CATALOG', 'MULTISOURCE_PARTS', 'COMPONENT_PRICE_ITEMS', "LIKE 'MECL%'"]) assert.ok(!n.includes(v), v);
  assert.ok(n.includes("COALESCE(AREA, '?') || '/' || COALESCE(OBJECT_NAME, '?') || ':' || COALESCE(STATUS, '?')"), 'PROBLEM_LIST entry format');
});

const wide = { feed: 'w', columns: [{ sql: 'ME_EC', header: 'ME_EC', type: 'string' }],
  demandYears: { sqlPrefix: 'UNITS_', firstYear: 2025, yearsAhead: 10, headerPrefix: 'Units ' },
  demandMonths: { sqlPrefix: 'M_', yearsAhead: 1 } };
test('month headers sit before their year header', () => {
  const h = headersFor(wide, 2026);
  assert.equal(h.length, 1 + 12 + 24);
  assert.deepEqual(h.slice(0, 3), ['ME_EC', 'Units 2025', '2026-01']);
  assert.equal(h.at(-1), 'Units 2036');
  assert.deepEqual(sqlColumnsFor(wide, 2026).slice(0, 3), ['ME_EC', 'UNITS_2025', 'M_2026_01']);
});
test('rolling window moves a year in January: one year column and twelve months added, 2026 months dropped', () => {
  const m26 = headersFor(wide, 2026), m27 = headersFor(wide, 2027);
  assert.equal(m27.length - m26.length, 1);
  assert.ok(m27.includes('2028-12') && !m27.includes('2026-01'));
});
test('header prefix defaults to "Demand "', () => {
  assert.equal(headersFor({ ...wide, demandYears: { sqlPrefix: 'D_', firstYear: 2025, yearsAhead: 0 }, demandMonths: undefined }, 2025)[1], 'Demand 2025');
});
test('demandMonthsFor is empty without demandMonths', () => {
  assert.deepEqual(demandMonthsFor({ ...wide, demandMonths: undefined }, 2026), []);
});

const rolling = { feed: 'r', columns: [{ sql: 'K', header: 'K', type: 'string' }],
  demandYears: { sqlPrefix: 'DEMAND_', firstYear: 2025, yearsAhead: 10 },
  demandMonths: { sqlPrefix: 'M_', yearsAhead: 1 } };
const mm = (y) => Array.from({ length: 12 }, (_, i) => `${y}-${String(i + 1).padStart(2, '0')}`);
test('rolling series: months of Y and Y+1 sit directly before their year total', () => {
  const h = headersFor(rolling, 2026);
  assert.deepEqual(h, ['K', 'Demand 2025', ...mm(2026), 'Demand 2026', ...mm(2027), 'Demand 2027',
    ...Array.from({ length: 9 }, (_, k) => `Demand ${2028 + k}`)]);
  assert.equal(h.length - 1, 12 + 24);
  const s = sqlColumnsFor(rolling, 2026);
  assert.equal(s.length, h.length);
  assert.deepEqual(s.slice(0, 3), ['K', 'DEMAND_2025', 'M_2026_01']);
  assert.equal(s[14], 'DEMAND_2026'); assert.equal(s.at(-1), 'DEMAND_2036');
});
test('rolling series: base year 2027 drops 2026 months but keeps Demand 2026', () => {
  const h = headersFor(rolling, 2027);
  assert.ok(!h.some((x) => /^2026-/.test(x)));
  assert.ok(h.includes('Demand 2026'));
  assert.equal(h[h.indexOf('Demand 2027') - 1], '2027-12');
  assert.equal(h[h.indexOf('Demand 2028') - 1], '2028-12');
  assert.deepEqual(demandMonthsFor(rolling, 2027).length, 24);
  assert.deepEqual(demandMonthsFor(rolling, 2027)[0], { year: 2027, month: 1 });
});
test('rolling series: SERIES renders aliases in sqlColumnsFor order', () => {
  for (const by of [2026, 2027]) {
    const sql = renderFeedSql('SELECT K AS ROW_KEY, K AS K {{SERIES: , D_#YEAR# AS DEMAND_#YEAR# || , M#YEAR##MM# AS M_#YEAR#_#MM#}} FROM T',
      by, demandYearsFor(rolling, by), demandMonthsFor(rolling, by));
    const aliases = [...sql.matchAll(/\bAS (\w+)/g)].map((m) => m[1]);
    assert.deepEqual(aliases, ['ROW_KEY', ...sqlColumnsFor(rolling, by)]);
  }
});
test('demandMonths without demandYears throws', () => {
  const bad = { ...rolling, demandYears: undefined };
  assert.throws(() => headersFor(bad, 2026), /demandYears/);
  assert.throws(() => sqlColumnsFor(bad, 2026), /demandYears/);
});
