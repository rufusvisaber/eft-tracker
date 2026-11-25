/* ETF 成交额跟踪器 · GitHub Pages 实时版
 * 行情：腾讯 qt.gtimg.cn（JSONP，浏览器直连）
 * 基准：腾讯 web.ifzq.gtimg.cn 日 K + 新浪 quotes.sina.cn 5 分钟 K（首访计算并按日缓存）
 * 份额：静态种子 + GitHub Actions 写入的 data/shares.js
 */
(function () {
  'use strict';

  var CFG = window.ETF_CONFIG;
  if (!CFG) {
    document.getElementById('vtitle').textContent = '配置未加载，请确认 data/config.js 可访问';
    return;
  }
  var SHARE_UPDATES = window.ETF_SHARE_UPDATES || {};

  var S = {
    items: CFG.items.map(function (x) {
      return Object.assign({}, x, {
        price: 0, prev_close: 0, pct: 0, amount_yi: 0, amount_wan: 0,
        mktcap_yi: 0, shares: 0, shares_yi: 0, outer_lots: 0, inner_lots: 0,
        turnover: 0, ts: '', date: '', subscr_net_yi: null, prev_shares: null,
        tail_ratio: null
      });
    }),
    shares_history: Object.assign({}, CFG.shares_history, SHARE_UPDATES),
    trade_date: CFG.seed_trade_date,
    generated_at: CFG.seed_generated_at,
    prev_share_date: CFG.prev_share_date,
    shares_asof: null,
    shares_has_today: false,
    baselineSource: 'seed',
    tailBase: null,
    tailCur: null
  };
  var byCode = {};
  S.items.forEach(function (it) { byCode[it.code] = it; });
  var tcodes = S.items.map(function (it) { return it.tcode; });
  var liveOK = false, lastLiveAt = 0, refreshing = false;
  var RANGE = { delta: 242, index: 242 };

  // ---------- 基础工具 ----------
  function fmt(n, d) {
    d = (d === undefined ? 2 : d);
    return (n || 0).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function signed(n) { return (n > 0 ? '+' : '') + fmt(n, 2); }
  function cls(n) { return n > 0 ? 'up' : (n < 0 ? 'down' : 'muted'); }
  function fmtDate(d) {
    if (!d || d.length !== 8) return d || '—';
    var wk = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    var dt = new Date(parseInt(d.slice(0, 4), 10), parseInt(d.slice(4, 6), 10) - 1, parseInt(d.slice(6, 8), 10));
    return d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8) + ' ' + wk[dt.getDay()];
  }
  function compactDate(d) { return d && d.length === 8 ? d.slice(4, 6) + '-' + d.slice(6, 8) : d; }

  function bjParts() {
    var p = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23'
    }).formatToParts(new Date());
    var o = {};
    p.forEach(function (x) { o[x.type] = x.value; });
    return o;
  }
  function todayKey() { var b = bjParts(); return b.year + b.month + b.day; }

  function marketState() {
    var b = bjParts(), wd = b.weekday;
    var weekend = (wd === 'Sat' || wd === 'Sun');
    var h = parseInt(b.hour, 10), m = parseInt(b.minute, 10), t = h * 60 + m;
    var lunch = !weekend && t >= 690 && t < 780;
    var trading = !weekend && t >= 570 && t < 900;
    var preopen = !weekend && t >= 540 && t < 570;
    var after = !weekend && t >= 900;
    var before = !weekend && t < 540;
    var offhours = weekend || before || preopen;
    var prog;
    if (t < 570) prog = 0;
    else if (t <= 690) prog = (t - 570) / 240;
    else if (t < 780) prog = 120 / 240;
    else if (t < 900) prog = (120 + (t - 780)) / 240;
    else prog = 1;
    return {
      weekend: weekend, trading: trading, lunch: lunch, preopen: preopen, after: after,
      before: before, offhours: offhours,
      progress: Math.max(0.12, Math.min(1, prog)),
      date: b.year + b.month + b.day,
      hhmm: b.hour + ':' + b.minute,
      effHHMM: lunch ? '11:30' : (b.hour + ':' + b.minute),
      weekday: wd
    };
  }

  // ---------- 同时点对齐 ----------
  function hhmm2min(s) {
    if (!s) return 0;
    var p = String(s).split(':');
    return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0);
  }
  function shapeAt(shape, hhmm) {
    if (!shape || !shape.length) return null;
    var n = shape.length, tx = hhmm2min(hhmm);
    if (tx <= hhmm2min(shape[0][0])) return shape[0][1];
    if (tx >= hhmm2min(shape[n - 1][0])) return shape[n - 1][1];
    for (var i = 1; i < n; i++) {
      var t1 = hhmm2min(shape[i][0]);
      if (tx <= t1) {
        var t0 = hhmm2min(shape[i - 1][0]);
        if (t1 <= t0) return shape[i][1];
        return shape[i - 1][1] + (shape[i][1] - shape[i - 1][1]) * (tx - t0) / (t1 - t0);
      }
    }
    return shape[n - 1][1];
  }
  function dayProgress(it, st) {
    if (!st || !st.trading) return 1;
    var s = shapeAt(it.shape, st.effHHMM);
    if (s !== null && s > 0.02) return Math.min(1, s);
    return st.progress || 0.5;
  }
  function calcAdj(it, st) {
    var base = it.avg20_yi || 0, amt = it.amount_yi || 0;
    var p = dayProgress(it, st);
    var oi = (it.outer_lots || 0) + (it.inner_lots || 0);
    return {
      ratio: (base > 0 && p > 0) ? amt / (base * p) : 0,
      raw: base > 0 ? amt / base : 0,
      done: p,
      net: oi > 0 ? ((it.outer_lots - it.inner_lots) / oi) * amt : 0
    };
  }

  function spark(hist) {
    if (!hist || !hist.length) return '';
    var vals = hist.map(function (x) { return x.amount_yi; });
    var mx = Math.max.apply(null, vals) || 1, w = 96, h = 26, bw = w / vals.length;
    var bars = vals.map(function (v, i) {
      var bh = Math.max(1.2, v / mx * h), last = (i === vals.length - 1);
      return '<rect x="' + (i * bw).toFixed(1) + '" y="' + (h - bh).toFixed(1) +
        '" width="' + Math.max(1.2, bw - 1).toFixed(1) + '" height="' + bh.toFixed(1) +
        '" fill="' + (last ? '#ff4713' : '#e0e0e0') + '"/>';
    }).join('');
    return '<svg class="spark" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h +
      '" aria-label="近30日成交额">' + bars + '</svg>';
  }

  // ---------- 份额图表 ----------
  function dShort(d) { return d && d.length === 8 ? d.slice(4, 6) + '-' + d.slice(6, 8) : d; }
  function dAxis(d, big) {
    if (!d || d.length !== 8) return d;
    return big ? d.slice(2, 4) + '/' + d.slice(4, 6) : dShort(d);
  }
  function tray(box, tip, html, ev) {
    var rect = box.getBoundingClientRect();
    var px = (ev.touches && ev.touches[0] ? ev.touches[0].clientX : ev.clientX) - rect.left;
    var py = (ev.touches && ev.touches[0] ? ev.touches[0].clientY : ev.clientY) - rect.top;
    tipShow(box, tip, html, px, py);
  }
  function tipShow(box, tip, html, x, y) {
    tip.innerHTML = html; tip.style.display = 'block';
    var bw = box.clientWidth, tw = tip.offsetWidth;
    tip.style.left = Math.max(4, Math.min(bw - tw - 4, x - tw / 2)) + 'px';
    tip.style.top = Math.max(0, y - tip.offsetHeight - 10) + 'px';
  }
  function niceMax(v) {
    if (v <= 0) return 1;
    var p = Math.pow(10, Math.floor(Math.log(v) / Math.LN10));
    var arr = [1, 2, 2.5, 5, 10];
    for (var i = 0; i < arr.length; i++) { if (arr[i] * p >= v) return arr[i] * p; }
    return 10 * p;
  }
  function axisY(v) {
    if (v === 0) return '0';
    return v >= 1000 ? fmt(v / 1000, 1) + 'k' : fmt(v, Math.abs(v) < 1 ? 2 : (Math.abs(v) < 10 ? 1 : 0));
  }

  function seriesData(n) {
    var H = S.shares_history;
    var dates = Object.keys(H).sort();
    if (dates.length < 2) return null;
    var core = S.items.filter(function (i) { return i.group === 'core'; }).map(function (i) { return i.code; });
    if (!core.length) core = Object.keys(H[dates[dates.length - 1]] || {});
    n = Math.max(8, Math.min(n || 242, dates.length - 1));
    var wd = dates.slice(Math.max(0, dates.length - 1 - n));
    var last = {}, tot = [];
    wd.forEach(function (d) {
      var row = H[d] || {};
      core.forEach(function (c) { if (row[c] !== undefined && row[c] !== null) last[c] = row[c]; });
      var s = 0;
      core.forEach(function (c) { if (last[c] !== undefined) s += last[c]; });
      tot.push(s);
    });
    var deltas = [];
    for (var i = 1; i < wd.length; i++) deltas.push({ date: wd[i], d: tot[i] - tot[i - 1] });
    var base = tot[0] || 1;
    var idx = wd.map(function (d, i) { return { date: d, v: 100 * tot[i] / base }; });
    return { dates: wd, deltas: deltas, idx: idx, bars: deltas.length };
  }

  function renderBarChart(data) {
    var box = document.getElementById('chartDelta'), tip = box.querySelector('.chart-tip');
    if (!data) {
      box.innerHTML = '<div class="chart-empty">份额快照还在积累<br>需要至少两个交易日的份额数据</div>';
      return;
    }
    var mob = box.clientWidth > 0 && box.clientWidth < 430;
    var W = mob ? 390 : 560, Hh = mob ? 200 : 232, pl = mob ? 40 : 48, pr = 10, pt = 16, pb = 26;
    var fs = mob ? 11 : 10, pw = W - pl - pr, ph = Hh - pt - pb;
    var big = data.deltas[0].date.slice(0, 4) !== data.deltas[data.deltas.length - 1].date.slice(0, 4);
    var vals = data.deltas.map(function (x) { return x.d; });
    var m = niceMax(Math.max.apply(null, vals.map(Math.abs)) || 1);
    var y0 = pt + ph / 2, sx = pw / data.deltas.length;
    var bw = Math.max(1, Math.min(34, sx * 0.62));
    var g = '';
    [m, m / 2, 0, -m / 2, -m].forEach(function (v) {
      var y = y0 - v / m * (ph / 2);
      g += '<line x1="' + pl + '" y1="' + y.toFixed(1) + '" x2="' + (W - pr) + '" y2="' + y.toFixed(1) +
        '" stroke="' + (v === 0 ? '#d0d0d0' : '#efefef') + '" stroke-width="1"/>' +
        '<text x="' + (pl - 6) + '" y="' + (y + 3.5).toFixed(1) + '" text-anchor="end" font-size="' + fs +
        '" fill="#8a8a8a">' + axisY(v) + '</text>';
    });
    var n = data.deltas.length, step = Math.ceil(n / (mob ? 4 : 7));
    data.deltas.forEach(function (x, i) {
      if (i % step !== 0 && i !== n - 1) return;
      g += '<text x="' + (pl + sx * (i + 0.5)).toFixed(1) + '" y="' + (Hh - 8) +
        '" text-anchor="middle" font-size="' + fs + '" fill="#8a8a8a">' + dAxis(x.date, big) + '</text>';
    });
    data.deltas.forEach(function (x, i) {
      var v = x.d, h = Math.max(bw >= 3 ? 1.5 : 0.8, Math.abs(v) / m * (ph / 2));
      var cx = pl + sx * (i + 0.5);
      g += '<rect x="' + (cx - bw / 2).toFixed(1) + '" y="' + (v >= 0 ? y0 - h : y0).toFixed(1) +
        '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '"' + (bw >= 3 ? ' rx="1.5"' : '') +
        ' fill="' + (v >= 0 ? '#ff4713' : '#00875a') + '"/>';
    });
    data.deltas.forEach(function (x, i) {
      g += '<rect class="hit" data-i="' + i + '" x="' + (pl + sx * i).toFixed(1) + '" y="' + pt +
        '" width="' + sx.toFixed(1) + '" height="' + ph + '" fill="transparent" style="cursor:crosshair"/>';
    });
    var svg = '<svg viewBox="0 0 ' + W + ' ' + Hh + '" aria-label="每日份额变化">' +
      '<text x="6" y="10" font-size="' + fs + '" fill="#8a8a8a">亿份</text>' + g + '</svg>';
    box.innerHTML = svg; box.appendChild(tip);
    tip = box.querySelector('.chart-tip');
    box.querySelectorAll('.hit').forEach(function (r) {
      var i = +r.getAttribute('data-i'), x = data.deltas[i];
      function show(ev) {
        tray(box, tip, '<b>' + x.date.slice(0, 4) + '-' + dShort(x.date) + '</b><br>份额变化 <span class="' +
          (x.d >= 0 ? 'tu' : 'td') + '">' + signed(x.d) + ' 亿份</span>', ev);
      }
      r.addEventListener('mousemove', show);
      r.addEventListener('touchstart', show, { passive: true });
      r.addEventListener('mouseleave', function () { tip.style.display = 'none'; });
    });
  }

  function renderLineChart(data) {
    var box = document.getElementById('chartIndex'), tip = box.querySelector('.chart-tip');
    if (!data) {
      box.innerHTML = '<div class="chart-empty">至少需要两个交易日的份额快照</div>';
      return;
    }
    var mob = box.clientWidth > 0 && box.clientWidth < 430;
    var W = mob ? 390 : 560, Hh = mob ? 200 : 232, pl = mob ? 40 : 48, pr = mob ? 10 : 12, pt = 16, pb = 26;
    var fs = mob ? 11 : 10, pw = W - pl - pr, ph = Hh - pt - pb;
    var big = data.idx[0].date.slice(0, 4) !== data.idx[data.idx.length - 1].date.slice(0, 4);
    var vs = data.idx.map(function (x) { return x.v; });
    var lo = Math.min(100, Math.min.apply(null, vs)), hi = Math.max(100, Math.max.apply(null, vs));
    var pad = Math.max(0.6, (hi - lo) * 0.18); lo -= pad; hi += pad;
    function Y(v) { return pt + (hi - v) / (hi - lo) * ph; }
    function X(i) { return pl + (data.idx.length === 1 ? pw / 2 : pw * i / (data.idx.length - 1)); }
    var g = '';
    for (var k = 0; k <= 4; k++) {
      var v = lo + (hi - lo) * k / 4, y = Y(v);
      g += '<line x1="' + pl + '" y1="' + y.toFixed(1) + '" x2="' + (W - pr) + '" y2="' + y.toFixed(1) +
        '" stroke="#efefef"/><text x="' + (pl - 6) + '" y="' + (y + 3.5).toFixed(1) +
        '" text-anchor="end" font-size="' + fs + '" fill="#8a8a8a">' + fmt(v, 1) + '</text>';
    }
    var yb = Y(100);
    g += '<line x1="' + pl + '" y1="' + yb.toFixed(1) + '" x2="' + (W - pr) + '" y2="' + yb.toFixed(1) +
      '" stroke="#b0b0b0" stroke-dasharray="4 4"/><text x="' + (W - pr) + '" y="' + (yb - 5).toFixed(1) +
      '" text-anchor="end" font-size="' + fs + '" fill="#8a8a8a">基期 100</text>';
    var n = data.idx.length, step = Math.ceil(n / (mob ? 4 : 7));
    data.idx.forEach(function (x, i) {
      if (i % step !== 0 && i !== n - 1) return;
      g += '<text x="' + X(i).toFixed(1) + '" y="' + (Hh - 8) + '" text-anchor="middle" font-size="' + fs +
        '" fill="#8a8a8a">' + dAxis(x.date, big) + '</text>';
    });
    var pts = data.idx.map(function (x, i) { return X(i).toFixed(1) + ',' + Y(x.v).toFixed(1); }).join(' ');
    var area = 'M' + pl + ',' + Y(lo).toFixed(1) + ' L' + pts.replace(/ /g, ' L') +
      (' L' + X(n - 1).toFixed(1)) + ',' + Y(lo).toFixed(1) + ' Z';
    g += '<path d="' + area + '" fill="rgba(0,94,184,.08)"/>';
    g += '<polyline points="' + pts + '" fill="none" stroke="#005eb8" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
    var dots = n <= 70 ? data.idx.map(function (x, i) { return i; }) : [n - 1];
    dots.forEach(function (i) {
      g += '<circle cx="' + X(i).toFixed(1) + '" cy="' + Y(data.idx[i].v).toFixed(1) +
        '" r="3" fill="#005eb8" stroke="#fff" stroke-width="1.5"/>';
    });
    data.idx.forEach(function (x, i) {
      g += '<rect class="hit" data-i="' + i + '" x="' + (pl + pw * i / n).toFixed(1) + '" y="' + pt +
        '" width="' + (pw / n).toFixed(1) + '" height="' + ph + '" fill="transparent" style="cursor:crosshair"/>';
    });
    var svg = '<svg viewBox="0 0 ' + W + ' ' + Hh + '" aria-label="加仓指数">' +
      '<text x="6" y="10" font-size="' + fs + '" fill="#8a8a8a">指数</text>' + g + '</svg>';
    box.innerHTML = svg; box.appendChild(tip);
    tip = box.querySelector('.chart-tip');
    box.querySelectorAll('.hit').forEach(function (r) {
      var i = +r.getAttribute('data-i'), x = data.idx[i];
      var prev = i > 0 ? data.idx[i - 1].v : null;
      var diff = prev === null ? '' : ((x.v - prev >= 0 ? ' +' : ' ') + fmt(x.v - prev, 2));
      function show(ev) {
        tray(box, tip, '<b>' + x.date.slice(0, 4) + '-' + dShort(x.date) + '</b><br>加仓指数 <b style="color:#005eb8">' +
          fmt(x.v, 2) + '</b>' + (diff ? '<br>较前日 <span class="' + (x.v - prev >= 0 ? 'tu' : 'td') + '">' + diff + '</span>' : ''), ev);
      }
      r.addEventListener('mousemove', show);
      r.addEventListener('touchstart', show, { passive: true });
      r.addEventListener('mouseleave', function () { tip.style.display = 'none'; });
    });
  }

  function renderCharts() {
    var bd = seriesData(RANGE.delta), ld = seriesData(RANGE.index);
    var dn = document.getElementById('chartDeltaNote'), en = document.getElementById('chartIndexNote');
    renderBarChart(bd);
    renderLineChart(ld);
    if (!bd) { dn.innerHTML = ''; en.innerHTML = ''; return; }
    var b0 = bd.dates[0], b1 = bd.dates[bd.dates.length - 1];
    var l0 = ld.dates[0], l1 = ld.dates[ld.dates.length - 1];
    dn.innerHTML = '<b>估算方法：</b>池内 20 只 ETF「当日场内份额 − 上一交易日份额」加总，正数计申购、负数计赎回；' +
      '区间 ' + b0 + ' ~ ' + b1 + '（' + bd.bars + ' 个交易日）。' +
      '参考常见口径，日度份额变化均视为池内组合操作，<b>实际也可能来自其他机构或个人投资者</b>；' +
      '2026-11-06 起使用上交所 / 深交所官方每日基金规模数据（见表格脚注②）。<b>日频数据，盘中不实时更新。</b>此为近似推算，非官方披露数据。';
    en.innerHTML = '<b>估算方法：</b>加仓指数 = 100 × 当日池内总份额 ÷ 区间首日（' + l0 + '）总份额，区间 ' + l0 + ' ~ ' + l1 + '。' +
      '高于 100 = 这段区间估算净加仓，低于 100 = 净减仓。<b>不等于真实持仓比例</b>：定期报告已停止披露前十大持有人，' +
      '期初持仓不可验证，比例锚定会失真，故用指数刻画变化方向与幅度。' +
      '份额源未日更的交易日按前值顺延（不产生假跳变）。<b>日频数据，盘中不实时更新。</b>此为近似推算，非官方披露数据。';
  }

  function bindRange() {
    ['rngDelta', 'rngIndex'].forEach(function (id) {
      var box = document.getElementById(id);
      if (!box) return;
      var key = box.getAttribute('data-target');
      box.querySelectorAll('button').forEach(function (b) {
        b.addEventListener('click', function () {
          box.querySelectorAll('button').forEach(function (x) { x.classList.remove('on'); });
          b.classList.add('on');
          RANGE[key] = +b.getAttribute('data-n');
          renderCharts();
        });
      });
    });
  }

  // ---------- 判断 ----------
  function verdict() {
    var st = marketState();
    var newest = S.items[0] && S.items[0].date ? S.items[0].date : S.trade_date;
    var stale = st.trading && newest && newest !== st.date;
    var effSt = stale ? { trading: false, lunch: false, offhours: st.offhours } : st;
    var core = S.items.filter(function (i) { return i.group === 'core'; });
    var sumAmt = 0, sumBase = 0, sumBaseAdj = 0, sumNet = 0, capW = 0, pctW = 0;
    var tailCur = 0, tailBase = 0, tailAmt = 0;
    core.forEach(function (it) {
      var c = calcAdj(it, effSt);
      sumAmt += it.amount_yi || 0;
      sumBase += it.avg20_yi || 0;
      sumBaseAdj += (it.avg20_yi || 0) * c.done;
      sumNet += c.net;
      var w = it.mktcap_yi || 0; capW += w; pctW += (it.pct || 0) * w;
      if (S.tailCur !== null && S.tailBase !== null) {
        tailCur += (it.amount_yi || 0) * S.tailCur;
        tailBase += (it.amount_yi || 0) * S.tailBase;
        tailAmt += (it.amount_yi || 0);
      }
    });
    var ratio = sumBaseAdj > 0 ? sumAmt / sumBaseAdj : 0;
    var rawRatio = sumBase > 0 ? sumAmt / sumBase : 0;
    var done = sumBase > 0 ? sumBaseAdj / sumBase : 1;
    var wpct = capW > 0 ? pctW / capW : 0;
    var tail = tailAmt > 0 ? tailCur / tailAmt : 0;
    var tailB = tailAmt > 0 ? tailBase / tailAmt : 0;

    var level = 'cool', title = '', reason = '';
    if (ratio >= 1.8 && sumNet > 0) {
      level = 'hot'; title = '大概率上班了';
      reason = '核心池成交额达到历史同时点均值的 ' + fmt(ratio, 2) + ' 倍，且主动净买入 ' + fmt(sumNet, 1) +
        ' 亿元。放量与买入方向一致，量价配合较明显。';
    } else if (ratio >= 1.3 && sumNet > 0) {
      level = 'mid'; title = '有放量迹象';
      reason = '成交额放大到历史同时点均值的 ' + fmt(ratio, 2) + ' 倍，主动净买入 ' + fmt(sumNet, 1) +
        ' 亿元，方向偏买，但力度还不构成强信号。';
    } else if (ratio >= 1.8 && sumNet <= 0) {
      level = 'mid'; title = '放量了，方向不对';
      reason = '成交额放大到历史同时点均值的 ' + fmt(ratio, 2) + ' 倍，但主动净买入 ' + fmt(sumNet, 1) +
        ' 亿元。大额成交未必是买盘，更像换手或出货，不能直接算上班。';
    } else if (ratio >= 1.3) {
      level = 'mid'; title = '成交活跃，证据不够';
      reason = '成交额达到历史同时点均值的 ' + fmt(ratio, 2) + ' 倍，但主动净买入 ' + fmt(sumNet, 1) + ' 亿元，方向不清晰。';
    } else {
      level = 'cool'; title = '没看出上班迹象';
      reason = '成交额只有历史同时点均值的 ' + fmt(ratio, 2) + ' 倍，主动净买入 ' + fmt(sumNet, 1) + ' 亿元，量价都平静。';
    }
    if (tail > 0 && tailB > 0 && tail > tailB * 1.25 && (level === 'hot' || level === 'mid')) {
      reason += ' 尾盘半小时成交占全天 ' + fmt(tail * 100, 1) + '%，明显高于 20 日均值 ' + fmt(tailB * 100, 1) + '%。';
    }
    if (wpct < -0.5 && (level === 'hot' || level === 'mid')) {
      reason += ' 池内规模加权涨跌 ' + fmt(wpct, 2) + '%，下跌日放量更值得关注。';
    }
    if (stale) reason += '（实时通道数据日期不是今天，当前按全天口径对比；连上今日数据后自动切回同时点对齐）';
    else if (st.lunch) reason += '（午间休市，成交额锁定 11:30；对比基准 = 20 日均额 × 历史同时点进度 ' + fmt(done * 100, 1) + '%）';
    else if (st.trading) reason += '（' + st.hhmm + ' 历史平均已走完全天 ' + fmt(done * 100, 1) + '%，分母已同比例缩小，与历史同时刻对比）';
    else if (st.offhours) reason += '（非交易时段，以上为 ' + fmtDate(newest) + ' 收盘复盘，开盘后自动切换实时）';
    else if (st.after) reason += '（今日收盘复盘，基准为最近 20 个交易日）';

    return {
      st: st, core: core, sumAmt: sumAmt, sumBase: sumBase, sumBaseAdj: sumBaseAdj,
      sumNet: sumNet, ratio: ratio, rawRatio: rawRatio, done: done, wpct: wpct,
      tail: tail, tailB: tailB, level: level, title: title, reason: reason
    };
  }

  function card(k, v, n, extra) {
    return '<div><div class="k">' + k + '</div><div class="v num">' + v + '</div><div class="n">' + n + '</div>' + extra + '</div>';
  }
  function renderVerdict(v) {
    var el = document.getElementById('verdict');
    el.className = 'verdict ' + (v.level === 'hot' ? 'hot' : (v.level === 'mid' ? 'mid' : ''));
    document.getElementById('vlabel').textContent = v.st.lunch ? '今日结论 · 午间半场' :
      (v.st.trading ? '今日结论 · 实时跟踪' :
        (v.st.after ? '今日收盘复盘' : '最近交易日复盘 · ' + fmtDate(S.trade_date)));
    var t = document.getElementById('vtitle');
    t.textContent = v.title; t.className = 'vtitle ' + (v.level === 'cool' ? 'cool' : '');
    document.getElementById('vreason').textContent = v.reason;
    var sn = document.getElementById('vstampNum');
    sn.textContent = fmt(v.ratio, 2) + '×';
    sn.className = 'num' + (v.ratio >= 1.8 ? ' hl' : '');
    document.getElementById('vstampLabel').textContent = v.st.trading ? '较同时点历史均值' : '较20日均额';
    var thr = document.getElementById('thRatio');
    if (thr) thr.textContent = v.st.trading ? '同时点倍数' : '较20日均';
    var bars = Math.min(100, v.ratio / 2.5 * 100);
    var newest = S.items[0] && S.items[0].date ? S.items[0].date : S.trade_date;
    document.getElementById('mgrid').innerHTML =
      card('核心池合计成交额', fmt(v.sumAmt, 1) + ' 亿',
        v.st.trading ? '截至 ' + v.st.effHHMM + ' · 已达成全天日均 ' + fmt(v.rawRatio, 2) + '×' :
          '20日均额 ' + fmt(v.sumBase, 1) + ' 亿', '') +
      card('成交额放大倍数', fmt(v.ratio, 2) + '×',
        v.st.trading ? '基准 ' + fmt(v.sumBaseAdj, 1) + ' 亿 = 20日均额 × 同时点进度 ' + fmt(v.done * 100, 1) + '%' :
          '阈值 1.8× 为强信号',
        '<div class="bar"><span style="width:' + bars.toFixed(1) + '%"></span></div>') +
      card('合计主动净买入', signed(v.sumNet) + ' 亿', '主动买卖口径推算', '') +
      card('池内加权涨跌', fmt(v.wpct, 2) + '%', '规模加权 · ' + fmtDate(newest), '');
    var g = document.getElementById('mgrid');
    g.children[1].querySelector('.v').className = 'v num ' + (v.ratio >= 1.8 ? 'hl' : '');
    g.children[2].querySelector('.v').className = 'v num ' + cls(v.sumNet);
    g.children[3].querySelector('.v').className = 'v num ' + cls(v.wpct);
  }

  // 份额变化自检：同市场绝大多数标的份额与上一快照完全相同 => 数据源未按日更新
  var suspectCache = null;
  function sharesSuspect() {
    if (suspectCache) return suspectCache;
    var by = {};
    S.items.forEach(function (it) {
      var m = (it.tcode || '').slice(0, 2);
      (by[m] = by[m] || []).push(it);
    });
    var out = {};
    Object.keys(by).forEach(function (m) {
      var known = by[m].filter(function (x) { return x.subscr_net_yi !== null && x.subscr_net_yi !== undefined; });
      if (known.length < 3) return;
      var same = known.filter(function (x) { return Math.abs(x.subscr_net_yi) < 0.005; }).length;
      out[m] = same / known.length >= 0.7;
    });
    suspectCache = out; return out;
  }
  function shareAsOfCell() {
    if (S.shares_has_today) return '';
    return '<div class="sub muted">官方 ' + (S.shares_asof ? compactDate(S.shares_asof) : '上期') + ' 日终</div>';
  }
  function subscrCell(it) {
    var v = it.subscr_net_yi;
    if (v === null || v === undefined) return '<div class="sub muted">申赎 待官方日更</div>';
    var m = (it.tcode || '').slice(0, 2);
    if (sharesSuspect()[m]) return '<div class="sub muted" title="同市场绝大多数标的份额与上一份快照完全相同，判断为行情商份额字段未按日更新，不代表当日没有申赎">份额源未日更</div>';
    var pd = S.prev_share_date;
    var tag = (pd && pd.length === 8) ? (pd.slice(4, 6) + '-' + pd.slice(6, 8)) : '上期';
    if (Math.abs(v) < 0.005) return '<div class="sub muted">较 ' + tag + ' 持平</div>';
    return '<div class="sub num ' + cls(v) + '">较 ' + tag + ' ' + signed(v) + '亿</div>';
  }

  function renderTable() {
    var st = marketState();
    var newest = S.items[0] && S.items[0].date ? S.items[0].date : S.trade_date;
    var stale = st.trading && newest && newest !== st.date;
    var effSt = stale ? { trading: false } : st;
    var sort = document.getElementById('sort').value, scope = document.getElementById('scope').value;
    var q = document.getElementById('q').value.trim().toLowerCase();
    var list = S.items.filter(function (it) {
      if (scope !== 'all' && it.group !== scope) return false;
      if (q && (it.code + it.name + it.index).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var cmp = {
      huijin: function (a, b) { return (b.huijin_yi - a.huijin_yi) || (b.mktcap_yi - a.mktcap_yi); },
      amount: function (a, b) { return b.amount_yi - a.amount_yi; },
      ratio: function (a, b) { return calcAdj(b, effSt).ratio - calcAdj(a, effSt).ratio; },
      net: function (a, b) { return calcAdj(b, effSt).net - calcAdj(a, effSt).net; },
      mktcap: function (a, b) { return b.mktcap_yi - a.mktcap_yi; }
    }[sort];
    list.sort(function (a, b) { if (a.group !== b.group) return a.group === 'core' ? -1 : 1; return cmp(a, b); });

    var html = '', lastGroup = '';
    list.forEach(function (it) {
      if (it.group !== lastGroup) {
        lastGroup = it.group;
        var label = it.group === 'core' ?
          '核心池 · 2025年报口径（此后停止披露）' :
          '扩展观察 · 未纳入核心池（名单已停止更新）';
        var cnt = list.filter(function (x) { return x.group === it.group; }).length;
        html += '<tr class="grouphead"><td colspan="10">' + label + '<span class="cnt">' + cnt + ' 只</span></td></tr>';
      }
      var c = calcAdj(it, effSt), pctCls = cls(it.pct), netCls = cls(c.net);
      var rCls = c.ratio >= 1.8 ? 'hl' : (c.ratio >= 1.3 ? '' : 'muted');
      var hb = Math.min(100, c.ratio / 3 * 100);
      var amtSub = st.trading ? '<div class="sub muted">截至 ' + st.effHHMM + '</div>' : '';
      var ratioSub = st.trading ? '<div class="sub muted">已达成日均 ' + fmt(c.raw, 2) + '×</div>' : '';
      html += '<tr>' +
        '<td><div class="name">' + it.name + '<span class="chip ' + it.group + '">' +
          (it.group === 'core' ? '核心' : '观察') + '</span></div><div class="code num">' + it.code + '</div></td>' +
        '<td class="muted">' + it.index + '</td>' +
        '<td class="num">' + fmt(it.mktcap_yi, 1) + '</td>' +
        '<td class="num" style="font-weight:700">' + fmt(it.amount_yi, 2) + amtSub + '</td>' +
        '<td><div class="ratio num ' + rCls + '">' + fmt(c.ratio, 2) + '<b>×</b></div>' + ratioSub +
          '<div class="mini"><span style="width:' + hb.toFixed(1) + '%"></span></div></td>' +
        '<td class="num ' + netCls + '" style="font-weight:700">' + signed(c.net) + '</td>' +
        '<td class="num ' + pctCls + '" style="font-weight:700">' + signed(it.pct) + '%</td>' +
        '<td><div class="num">' + fmt(it.shares_yi, 1) + '</div>' + shareAsOfCell() + subscrCell(it) + '</td>' +
        '<td>' + spark(it.hist) + '</td>' +
        '<td class="num ' + (it.huijin_yi ? '' : 'muted') + '">' + (it.huijin_yi ? fmt(it.huijin_yi, 1) : '—') + '</td>' +
        '</tr>';
    });
    var core = S.items.filter(function (i) { return i.group === 'core'; });
    var sa = 0, sb = 0, sn = 0;
    core.forEach(function (it) { var c = calcAdj(it, st); sa += it.amount_yi; sb += (it.avg20_yi || 0) * c.done; sn += c.net; });
    html += '<tr class="total"><td>核心池合计</td><td class="muted">' + core.length + ' 只</td><td class="muted">—</td>' +
      '<td class="num">' + fmt(sa, 2) + (st.trading ? '<div class="sub muted">截至 ' + st.effHHMM + '</div>' : '') + '</td>' +
      '<td class="num hl">' + fmt(sb > 0 ? sa / sb : 0, 2) + '×</td>' +
      '<td class="num ' + cls(sn) + '">' + signed(sn) + '</td>' +
      '<td colspan="4" class="muted" style="text-align:right">合计口径与上方判断一致</td></tr>';
    document.getElementById('tbody').innerHTML = html;
  }

  function renderStatus() {
    var v = verdict(), st = v.st;
    var badge = document.getElementById('badge'), txt = document.getElementById('badgeText');
    if (st.lunch) {
      badge.className = 'badge' + (liveOK ? ' live' : ' warn');
      txt.textContent = '午间休市 · 数据锁定 11:30';
    } else if (st.trading) {
      badge.className = 'badge' + (liveOK ? ' live' : ' warn');
      txt.textContent = liveOK ? '实时 · 每20秒' : '实时通道不可用 · 显示快照';
    } else if (st.preopen) {
      badge.className = 'badge'; txt.textContent = '等待开盘 · 9:30';
    } else if (st.after) {
      badge.className = 'badge'; txt.textContent = '已收盘 · 今日复盘数据';
    } else {
      badge.className = 'badge'; txt.textContent = '休市 · 最近交易日收盘数据';
    }
    var newest = S.items[0] && S.items[0].ts ? S.items[0].ts.replace(
      /(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/, '$1-$2-$3 $4:$5:$6') : '—';
    document.getElementById('stamp').textContent = '行情 ' + newest + ' · 基准 ' +
      (S.baselineSource === 'live' ? '今日重算' : '种子快照');
    var shareDays = Object.keys(S.shares_history).length;
    document.getElementById('meta').innerHTML =
      '数据时间 ' + newest + (liveOK ? (st.lunch ? ' · 通道正常，13:00 继续刷新' : ' · 实时已连接') : '') +
      '<br>基准来源：' + (S.baselineSource === 'live' ? '腾讯日K + 新浪5分钟K（逐只当日计算）' : '历史快照（接口不可用时回退）') +
      ' · 份额样本 ' + shareDays + ' 日（交易所官方按日数据）' +
      (Object.keys(SHARE_UPDATES).length ? ' · 已载入 ' + Object.keys(SHARE_UPDATES).length + ' 份新增快照' : '');
    document.getElementById('footerSign').textContent =
      '数据来源：腾讯行情（实时）+ 腾讯日K / 新浪5分钟K（基准）+ 上交所 / 深交所官方每日基金规模（份额）· 种子截至 ' +
      CFG.seed_generated_at + ' · 名单口径：2025年报前十大持有人（此后停止披露，不可验证）' +
      ' · GitHub Pages 静态托管 · 仅供内部研究，不构成投资建议';
  }

  function renderAll() { renderVerdict(verdict()); renderCharts(); renderTable(); renderStatus(); }

  // ---------- 实时行情：腾讯 JSONP ----------
  function parseLive(raw) {
    if (!raw) return null;
    var a = String(raw).split('~');
    if (a.length < 40) return null;
    function n(i) { var v = parseFloat(a[i]); return isNaN(v) ? 0 : v; }
    return {
      code: a[2], price: n(3), prev_close: n(4), volume_lots: n(6), outer_lots: n(7), inner_lots: n(8),
      pct: n(32), amount_wan: n(37), turnover: n(38), mktcap_yi: n(45), shares: a.length > 72 ? n(72) : 0,
      ts: a[30] || '', date: (a[30] || '').slice(0, 8)
    };
  }

  function updatePrevShares() {
    var hist = S.shares_history;
    var dates = Object.keys(hist).sort();
    var cur = S.items[0] && S.items[0].date ? S.items[0].date : todayKey();
    var latest = null, prev = null;
    dates.forEach(function (d) {
      if (d <= cur) latest = d;
      if (d < cur) prev = d;
    });
    if (!latest) latest = dates[dates.length - 1];
    if (!prev) prev = dates[dates.length - 1];
    S.prev_share_date = prev;
    S.shares_asof = latest;
    S.shares_has_today = (latest === cur);
    var row = hist[prev] || {};
    var latestRow = hist[latest] || {};
    S.items.forEach(function (it) {
      it.prev_shares = row[it.code] === undefined || row[it.code] === null ? null : row[it.code] * 1e8;
      // 份额一律用交易所官方日终快照；行情商份额字段不按日更新，不用于展示
      var official = latestRow[it.code];
      if (official !== undefined && official !== null) {
        it.shares = official * 1e8;
        it.shares_yi = official;
      }
      if (S.shares_has_today && it.prev_shares !== null && it.shares && it.price) {
        it.subscr_net_yi = Math.round((it.shares - it.prev_shares) * it.price / 1e8 * 100) / 100;
      } else {
        it.subscr_net_yi = null; // 当日官方份额尚未披露，盘中不拿滞后数据凑数
      }
    });
    suspectCache = null;
  }

  function applyLive() {
    var got = 0;
    tcodes.forEach(function (tc) {
      var q = parseLive(window['v_' + tc]);
      if (!q) return;
      var it = byCode[q.code];
      if (!it) return;
      it.price = q.price; it.prev_close = q.prev_close; it.pct = q.pct;
      it.amount_wan = q.amount_wan; it.amount_yi = q.amount_wan / 1e4;
      it.outer_lots = q.outer_lots; it.inner_lots = q.inner_lots;
      it.turnover = q.turnover; it.mktcap_yi = q.mktcap_yi;
      it.ts = q.ts;
      if (q.date) it.date = q.date;
      got++;
    });
    if (got) {
      liveOK = true; lastLiveAt = Date.now();
      var newest = '';
      S.items.forEach(function (it) { if (it.date > newest) newest = it.date; });
      if (newest) S.trade_date = newest;
      updatePrevShares();
    }
    return got;
  }

  function refreshLive() {
    if (refreshing) return Promise.resolve(false);
    refreshing = true;
    return new Promise(function (resolve) {
      var btn = document.getElementById('refresh');
      btn.textContent = '更新中…';
      var s = document.createElement('script');
      s.charset = 'GBK';
      s.src = 'https://qt.gtimg.cn/q=' + tcodes.join(',') + '&r=' + Date.now();
      var done = false;
      function finish(ok) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (ok) { var n = applyLive(); if (!n) ok = false; }
        if (!ok) liveOK = false;
        refreshing = false;
        btn.textContent = '立即刷新';
        renderAll();
        try { if (s.parentNode) s.parentNode.removeChild(s); } catch (e) { }
        resolve(ok);
      }
      var timer = setTimeout(function () { finish(false); }, 8000);
      s.onload = function () { finish(true); };
      s.onerror = function () { finish(false); };
      document.head.appendChild(s);
    });
  }

  // ---------- 基准：日K 均额 + 5分钟K 日内分布 ----------
  function loadDayK(it) {
    var url = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=' + it.tcode + ',day,,,40,qfq&r=' + Date.now();
    return fetch(url, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('dayk ' + r.status);
      return r.json();
    }).then(function (j) {
      var d = j && j.data && j.data[it.tcode];
      var rows = (d && (d.qfqday || d.day)) || [];
      if (!rows.length) throw new Error('no kline');
      var hist = rows.slice(-30).map(function (r) {
        var o = parseFloat(r[1]), c = parseFloat(r[2]), h = parseFloat(r[3]), l = parseFloat(r[4]), v = parseFloat(r[5]);
        return {
          date: String(r[0]).replace(/-/g, ''),
          amount_yi: Math.round(v * 100 * ((o + c + h + l) / 4) / 1e8 * 10000) / 10000
        };
      });
      var today = todayKey();
      // 一律剔除当日 K 线：盘中 / 开盘前当日数据未定稿，会污染 20 日均额。
      // 当日完整收盘数据会在下一个交易日重算基准时自然滚入 last20。
      if (hist.length && hist[hist.length - 1].date === today) hist.pop();
      var last20 = hist.slice(-20);
      var avg = last20.reduce(function (a, x) { return a + x.amount_yi; }, 0) / (last20.length || 1);
      return { code: it.code, hist: hist, avg20_yi: avg };
    }).catch(function () { return null; });
  }

  // 每只 ETF 各自拉新浪 5 分钟 K；JSONP 变量名必须唯一，避免并发互相覆盖
  function loadShapeScript(it, idx) {
    return new Promise(function (resolve) {
      var varName = 'ETF_SHAPE_DATA_' + idx;
      window[varName] = null;
      var s = document.createElement('script');
      s.src = 'https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20' + varName +
        '=/CN_MarketDataService.getKLineData?symbol=' + it.tcode + '&scale=5&ma=no&datalen=1000&r=' + Date.now();
      var done = false;
      function finish(v) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { if (s.parentNode) s.parentNode.removeChild(s); } catch (e) { }
        resolve(v);
      }
      var timer = setTimeout(function () { finish(null); }, 15000);
      s.onload = function () { finish(window[varName] || null); };
      s.onerror = function () { finish(null); };
      document.head.appendChild(s);
    });
  }

  // 限制并发，避免一次性向新浪发 24 个请求被限频
  function mapLimit(arr, limit, fn) {
    var results = new Array(arr.length), next = 0;
    function worker() {
      if (next >= arr.length) return Promise.resolve();
      var i = next++;
      return Promise.resolve(fn(arr[i], i)).then(function (v) { results[i] = v; return worker(); });
    }
    var pool = [];
    for (var k = 0; k < Math.min(limit, arr.length); k++) pool.push(worker());
    return Promise.all(pool).then(function () { return results; });
  }

  function labels() {
    var a = [];
    for (var t = 9 * 60 + 35; t <= 11 * 60 + 30; t += 5) a.push(t);
    for (var u = 13 * 60 + 5; u <= 15 * 60; u += 5) a.push(u);
    return a.map(function (t) {
      return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
    });
  }

  function computeShape(rows) {
    if (!rows || !rows.length) return null;
    var byDay = {};
    rows.forEach(function (r) {
      var day = String(r.day).slice(0, 10).replace(/-/g, '');
      var hhmm = String(r.day).slice(11, 16);
      var amt = parseFloat(r.amount) || 0;
      (byDay[day] = byDay[day] || { total: 0, map: {}, bars: 0 });
      byDay[day].map[hhmm] = (byDay[day].map[hhmm] || 0) + amt;
      byDay[day].total += amt;
      byDay[day].bars++;
    });
    var days = Object.keys(byDay).sort();
    var lab = labels(), acc = {}, cnts = {}, tailSum = 0, tailN = 0;
    lab.forEach(function (l) { acc[l] = 0; cnts[l] = 0; });
    days.forEach(function (d) {
      var row = byDay[d];
      if (row.bars < 40 || row.total <= 0) return;
      var cum = 0, tail = 0;
      lab.forEach(function (l) {
        cum += (row.map[l] || 0);
        acc[l] += cum / row.total;
        cnts[l]++;
        if (l >= '14:30') tail += (row.map[l] || 0);
      });
      tailSum += tail / row.total; tailN++;
    });
    if (!tailN) return null;
    var shape = lab.map(function (l) { return [l, Math.round((acc[l] / (cnts[l] || 1)) * 100000) / 100000]; });
    return { shape: shape, tailBase: tailSum / tailN };
  }

  function applyBaseline(obj) {
    obj.items.forEach(function (x) {
      var it = byCode[x.code];
      if (!it) return;
      if (x.avg20_yi) it.avg20_yi = x.avg20_yi;
      if (x.hist && x.hist.length) it.hist = x.hist;
      if (x.shape && x.shape.length) it.shape = x.shape;
      if (x.tailBase !== null && x.tailBase !== undefined) it.tailBase = x.tailBase;
    });
    // 尾盘基准按均额加权汇总，供结论里的尾盘加分文案使用
    var wsum = 0, tsum = 0;
    obj.items.forEach(function (x) {
      var w = x.avg20_yi || 0;
      if (x.tailBase !== null && x.tailBase !== undefined) { tsum += w * x.tailBase; wsum += w; }
    });
    S.tailBase = wsum > 0 ? tsum / wsum : (obj.tailBase || null);
    var st = marketState();
    S.tailCur = (st.trading && st.effHHMM < '14:30') ? null : S.tailBase;
    S.baselineSource = 'live';
  }

  function loadBaselines() {
    var key = 'etf_tracker_baseline_v2_' + todayKey();
    try {
      var cached = JSON.parse(localStorage.getItem(key) || 'null');
      if (cached && cached.items && cached.items.length === S.items.length &&
          cached.items.every(function (x) { return x.shape && x.shape.length; })) {
        applyBaseline(cached);
        return Promise.resolve(true);
      }
    } catch (e) { }

    // 每只 ETF 各自拉日 K 与 5 分钟 K，算各自的 20 日均额、进度曲线与尾盘基准
    return mapLimit(S.items, 8, function (it, idx) {
      return Promise.all([loadDayK(it), loadShapeScript(it, idx)]).then(function (r) {
        var day = r[0], rows = r[1];
        var sh = computeShape(rows);
        return {
          code: it.code,
          avg20_yi: day ? day.avg20_yi : (it.avg20_yi || 0),
          hist: day && day.hist.length ? day.hist : (it.hist || []),
          shape: sh ? sh.shape : (it.shape || []),
          tailBase: sh ? sh.tailBase : null
        };
      });
    }).then(function (out) {
      var good = out.filter(function (x) { return x.shape && x.shape.length && x.avg20_yi; });
      if (good.length < S.items.length * 0.8) return false;
      var obj = { date: todayKey(), items: out, tailBase: null };
      applyBaseline(obj);
      try { localStorage.setItem(key, JSON.stringify(obj)); } catch (e) { }
      return true;
    }).catch(function () { return false; });
  }

  // ---------- 事件与调度 ----------
  ['sort', 'scope', 'q'].forEach(function (id) {
    document.getElementById(id).addEventListener(id === 'q' ? 'input' : 'change', renderTable);
  });
  document.getElementById('refresh').addEventListener('click', function () { refreshLive(); });
  document.getElementById('auto').addEventListener('change', function () {
    if (this.checked) schedule(); else clearTimeout(window.__etfTimer);
  });
  function schedule() {
    clearTimeout(window.__etfTimer);
    var ms = marketState().trading ? 20000 : 60000;
    window.__etfTimer = setTimeout(function () {
      if (document.getElementById('auto').checked && marketState().trading) refreshLive();
      schedule();
    }, ms);
  }

  bindRange();
  renderCharts();
  document.getElementById('vtitle').textContent = '正在连接实时行情…';
  refreshLive().then(function () {
    return loadBaselines();
  }).then(function () {
    renderAll();
    schedule();
  });
})();
