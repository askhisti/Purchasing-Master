// Manufacturer file: pure selection logic over 2-D arrays (Range.getValues(), header row first).
// No Apps Script services are used here.

function mfrTable_(values) {
  var headers = (values && values.length ? values[0] : []).map(function (h) { return String(h); });
  var index = {};
  headers.forEach(function (h, i) { if (!(h in index)) index[h] = i; });
  return {
    headers: headers,
    rows: values && values.length ? values.slice(1) : [],
    has: function (name) { return name in index; },
    col: function (name) {
      if (!(name in index)) throw new Error('missing column ' + name);
      return index[name];
    },
  };
}

function mfrNone_(v) {
  var s = v === null || v === undefined ? '' : String(v).trim();
  return s === '' ? '(none)' : s;
}

function mfrKey_(category, subcategory) {
  return category + '\u0001' + subcategory;
}

function mfrCmp_(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function mfrNum_(v) {
  var n = Number(v);
  return isNaN(n) ? 0 : n;
}

function mfrSourceSet_(bomSources) {
  var iSrc = bomSources.col('Source ME_EC');
  var set = {};
  bomSources.rows.forEach(function (r) { set[String(r[iSrc])] = true; });
  return set;
}

function mfrCategoryTree_(components, bomSources, onlyUsed) {
  var iEc = components.col('ME_EC');
  var iCat = components.col('HW Category');
  var iSub = components.col('HW Subcategory');
  var used = onlyUsed ? mfrSourceSet_(bomSources) : null;
  var cats = {};
  components.rows.forEach(function (r) {
    var ec = String(r[iEc]);
    if (ec === '' || (used && !used[ec])) return;
    var cat = mfrNone_(r[iCat]);
    var sub = mfrNone_(r[iSub]);
    var c = cats[cat] || (cats[cat] = { all: {}, subs: {} });
    c.all[ec] = true;
    (c.subs[sub] || (c.subs[sub] = {}))[ec] = true;
  });
  return Object.keys(cats).sort(mfrCmp_).map(function (cat) {
    return {
      category: cat,
      count: Object.keys(cats[cat].all).length,
      subcategories: Object.keys(cats[cat].subs).sort(mfrCmp_).map(function (sub) {
        return { subcategory: sub, count: Object.keys(cats[cat].subs[sub]).length };
      }),
    };
  });
}

function mfrBuildRows_(input, selection, onlyUsed, baseYear) {
  var comps = input.components, src = input.bomSources, mon = input.bomMonthly;
  var cEc = comps.col('ME_EC'), cMfr = comps.col('Manufacturer'), cMpn = comps.col('MPN');
  var cDesc = comps.col('Description'), cCat = comps.col('HW Category');
  var cSub = comps.col('HW Subcategory'), cMs = comps.col('ME_MS');
  var sProd = src.col('Product'), sPid = src.col('Product ID'), sEms = src.col('EMS');
  var sBom = src.col('BOM ME_EC'), sMs = src.col('ME_MS'), sPos = src.col('Source Position');
  var sSrc = src.col('Source ME_EC'), sType = src.col('Volume Type');

  var yearHeaders = [], monthHeaders = [], y, m;
  for (y = baseYear; y <= baseYear + 10; y++) yearHeaders.push('Volume ' + y);
  for (y = baseYear; y <= baseYear + 1; y++) {
    for (m = 1; m <= 12; m++) monthHeaders.push(y + '-' + (m < 10 ? '0' : '') + m);
  }
  var headers = ['Category', 'Subcategory', 'Product', 'EMS', 'BOM ME_EC', 'Source Position',
    'ME_EC', 'Manufacturer', 'MPN', 'Description', 'ME_MS', 'Volume Type']
    .concat(yearHeaders, monthHeaders);
  var yearIdx = yearHeaders.map(function (h) { return src.has(h) ? src.col(h) : -1; });
  var monthIdx = monthHeaders.map(function (h) { return mon.has(h) ? mon.col(h) : -1; });

  var compByEc = {};
  comps.rows.forEach(function (r) { var k = String(r[cEc]); if (!(k in compByEc)) compByEc[k] = r; });

  var selected = {};
  (selection || []).forEach(function (s) { selected[mfrKey_(mfrNone_(s.category), mfrNone_(s.subcategory))] = true; });

  function catOf(ec) {
    var r = compByEc[ec];
    return r ? [mfrNone_(r[cCat]), mfrNone_(r[cSub])] : ['(none)', '(none)'];
  }

  // Monthly demand per (Product ID, ME_EC): sum over flows.
  var mEc = mon.col('ME_EC'), mPid = mon.col('Product ID');
  var monthly = {};
  mon.rows.forEach(function (r) {
    var k = String(r[mPid]) + '\u0001' + String(r[mEc]);
    var acc = monthly[k] || (monthly[k] = monthHeaders.map(function () { return 0; }));
    monthIdx.forEach(function (ix, i) { if (ix >= 0) acc[i] += mfrNum_(r[ix]); });
  });

  // Group source rows into lines.
  var lines = {}, lineOrder = [];
  src.rows.forEach(function (r) {
    var k = String(r[sPid]) + '\u0001' + String(r[sBom]);
    if (!lines[k]) { lines[k] = []; lineOrder.push(k); }
    lines[k].push(r);
  });

  var out = [];
  lineOrder.forEach(function (k) {
    var rows = lines[k].slice().sort(function (a, b) { return mfrNum_(a[sPos]) - mfrNum_(b[sPos]); });
    var hit = rows.some(function (r) {
      var c = catOf(String(r[sSrc]));
      return selected[mfrKey_(c[0], c[1])];
    });
    if (!hit) return;
    var primary = catOf(String(rows[0][sSrc]));
    var mo = monthly[k] || [];
    rows.forEach(function (r) {
      var ec = String(r[sSrc]);
      var cr = compByEc[ec];
      var c = catOf(ec);
      var line = [c[0], c[1], r[sProd], r[sEms], r[sBom], r[sPos], ec,
        cr ? cr[cMfr] : '', cr ? cr[cMpn] : '', cr ? cr[cDesc] : '', r[sMs], r[sType]];
      yearIdx.forEach(function (ix) { line.push(ix >= 0 && r[ix] !== undefined ? r[ix] : ''); });
      monthHeaders.forEach(function (_, i) { line.push(mo[i] || 0); });
      out.push({ sort: [primary[0], primary[1], String(r[sBom]), String(r[sProd]), mfrNum_(r[sPos])], row: line });
    });
  });
  out.sort(function (a, b) {
    return mfrCmp_(a.sort[0], b.sort[0]) || mfrCmp_(a.sort[1], b.sort[1]) ||
      mfrCmp_(a.sort[2], b.sort[2]) || mfrCmp_(a.sort[3], b.sort[3]) || (a.sort[4] - b.sort[4]);
  });
  var resultRows = out.map(function (o) { return o.row; });

  if (!onlyUsed) {
    var used = mfrSourceSet_(src);
    var extra = [];
    comps.rows.forEach(function (r) {
      var ec = String(r[cEc]);
      if (ec === '' || used[ec]) return;
      var c = catOf(ec);
      if (!selected[mfrKey_(c[0], c[1])]) return;
      extra.push([c, ec, r]);
    });
    extra.sort(function (a, b) {
      return mfrCmp_(a[0][0], b[0][0]) || mfrCmp_(a[0][1], b[0][1]) || mfrCmp_(a[1], b[1]);
    });
    extra.forEach(function (e) {
      var r = e[2];
      var line = [e[0][0], e[0][1], '', '', '', '', e[1], r[cMfr], r[cMpn], r[cDesc], r[cMs], 'Not on a BOM'];
      for (var i = 0; i < yearHeaders.length + monthHeaders.length; i++) line.push('');
      resultRows.push(line);
    });
  }

  var seen = {}, parts = [];
  resultRows.forEach(function (r) {
    var ec = r[6];
    if (seen[ec]) return;
    seen[ec] = true;
    parts.push({ meEc: ec, manufacturer: r[7], mpn: r[8], description: r[9] });
  });
  return { headers: headers, rows: resultRows, parts: parts };
}
