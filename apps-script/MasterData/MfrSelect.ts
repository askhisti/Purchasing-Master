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

function mfrTrue_(v) {
  return v === true || String(v).trim().toUpperCase() === 'TRUE';
}

// ME_EC -> alternatives of that part: usable members of every cluster (ME_MS) the part belongs to, the part itself
// excluded, one entry per alternative (lowest Member Priority, ties lowest ME_MS), ordered by priority then ME_EC.
function mfrAlternatives_(members) {
  var iMs = members.col('ME_MS'), iEc = members.col('ME_EC');
  var iUse = members.col('Is Usable'), iPrio = members.col('Member Priority');
  var clusters = {}, clustersOf = {};
  members.rows.forEach(function (r) {
    var ms = String(r[iMs]), ec = String(r[iEc]);
    if (ms === '' || ec === '') return;
    (clusters[ms] || (clusters[ms] = [])).push(r);
    var list = clustersOf[ec] || (clustersOf[ec] = []);
    if (list.indexOf(ms) < 0) list.push(ms);
  });
  var cache = {};
  return function (primary) {
    if (cache[primary]) return cache[primary];
    var best = {};
    (clustersOf[primary] || []).forEach(function (ms) {
      clusters[ms].forEach(function (r) {
        var ec = String(r[iEc]);
        if (ec === primary || !mfrTrue_(r[iUse])) return;
        var prio = mfrNum_(r[iPrio]);
        var b = best[ec];
        if (!b || prio < b.prio || (prio === b.prio && ms < b.ms)) best[ec] = { ec: ec, ms: ms, prio: prio };
      });
    });
    var list = Object.keys(best).map(function (k) { return best[k]; }).sort(function (a, b) {
      return (a.prio - b.prio) || mfrCmp_(a.ec, b.ec);
    });
    return (cache[primary] = list);
  };
}

// ME_EC values that are a line primary in Component_Usage or an alternative of one.
function mfrUsedSet_(usage, members) {
  var iEc = usage.col('ME_EC');
  var alts = mfrAlternatives_(members);
  var set = {};
  usage.rows.forEach(function (r) {
    var ec = String(r[iEc]);
    if (ec === '') return;
    set[ec] = true;
    alts(ec).forEach(function (a) { set[a.ec] = true; });
  });
  return set;
}

function mfrCategoryTree_(components, usage, members, onlyUsed) {
  var iEc = components.col('ME_EC');
  var iCat = components.col('HW Category');
  var iSub = components.col('HW Subcategory');
  var used = onlyUsed ? mfrUsedSet_(usage, members) : null;
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
  var comps = input.components, usage = input.usage, pvol = input.productVolumes;
  var cEc = comps.col('ME_EC'), cMfr = comps.col('Manufacturer'), cMpn = comps.col('MPN');
  var cDesc = comps.col('Description'), cCat = comps.col('HW Category');
  var cSub = comps.col('HW Subcategory'), cMs = comps.col('ME_MS');
  var uEc = usage.col('ME_EC'), uProd = usage.col('Product'), uPid = usage.col('Product ID');
  var uEms = usage.col('EMS'), uQty = usage.col('Qty Per Unit');
  var pPid = pvol.col('Product ID');

  var yearHeaders = [], monthHeaders = [], y, m;
  for (y = baseYear; y <= baseYear + 10; y++) yearHeaders.push('Volume ' + y);
  for (y = baseYear; y <= baseYear + 1; y++) {
    for (m = 1; m <= 12; m++) monthHeaders.push(y + '-' + (m < 10 ? '0' : '') + m);
  }
  var headers = ['Category', 'Subcategory', 'Product', 'EMS', 'BOM ME_EC', 'Source Position',
    'ME_EC', 'Manufacturer', 'MPN', 'Description', 'ME_MS', 'Volume Type']
    .concat(yearHeaders, monthHeaders);
  var yearIdx = yearHeaders.map(function (h) {
    var n = 'Demand ' + h.slice(7);
    return usage.has(n) ? usage.col(n) : -1;
  });
  var monthIdx = monthHeaders.map(function (h) { return pvol.has(h) ? pvol.col(h) : -1; });

  var compByEc = {};
  comps.rows.forEach(function (r) { var k = String(r[cEc]); if (!(k in compByEc)) compByEc[k] = r; });

  var selected = {};
  (selection || []).forEach(function (s) { selected[mfrKey_(mfrNone_(s.category), mfrNone_(s.subcategory))] = true; });

  function catOf(ec) {
    var r = compByEc[ec];
    return r ? [mfrNone_(r[cCat]), mfrNone_(r[cSub])] : ['(none)', '(none)'];
  }

  // Product units per month, summed over every Product_Volumes row (Series and Sample) of the product.
  var unitsByPid = {};
  pvol.rows.forEach(function (r) {
    var k = String(r[pPid]);
    var acc = unitsByPid[k] || (unitsByPid[k] = monthHeaders.map(function () { return 0; }));
    monthIdx.forEach(function (ix, i) { if (ix >= 0) acc[i] += mfrNum_(r[ix]); });
  });

  var alts = mfrAlternatives_(input.members);

  var out = [];
  usage.rows.forEach(function (ur) {
    var primaryEc = String(ur[uEc]);
    if (primaryEc === '') return;
    var sources = [{ ec: primaryEc, ms: '', pos: 1, type: 'Demand' }];
    alts(primaryEc).forEach(function (a, i) {
      sources.push({ ec: a.ec, ms: a.ms, pos: i + 2, type: 'Potential volume if sourced' });
    });
    var hit = sources.some(function (s) {
      var c = catOf(s.ec);
      return selected[mfrKey_(c[0], c[1])];
    });
    if (!hit) return;
    var primary = catOf(primaryEc);
    var units = unitsByPid[String(ur[uPid])];
    var qty = mfrNum_(ur[uQty]);
    sources.forEach(function (s) {
      var cr = compByEc[s.ec];
      var c = catOf(s.ec);
      var line = [c[0], c[1], ur[uProd], ur[uEms], primaryEc, s.pos, s.ec,
        cr ? cr[cMfr] : '', cr ? cr[cMpn] : '', cr ? cr[cDesc] : '', s.ms, s.type];
      yearIdx.forEach(function (ix) { line.push(ix >= 0 && ur[ix] !== undefined ? ur[ix] : ''); });
      monthHeaders.forEach(function (_, i) { line.push(units ? units[i] * qty : 0); });
      out.push({ sort: [primary[0], primary[1], primaryEc, String(ur[uProd]), String(ur[uPid]), s.pos], row: line });
    });
  });
  out.sort(function (a, b) {
    return mfrCmp_(a.sort[0], b.sort[0]) || mfrCmp_(a.sort[1], b.sort[1]) ||
      mfrCmp_(a.sort[2], b.sort[2]) || mfrCmp_(a.sort[3], b.sort[3]) ||
      mfrCmp_(a.sort[4], b.sort[4]) || (a.sort[5] - b.sort[5]);
  });
  var resultRows = out.map(function (o) { return o.row; });

  if (!onlyUsed) {
    var used = mfrUsedSet_(usage, input.members);
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
