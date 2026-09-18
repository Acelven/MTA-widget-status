/* MTA Subway Status — Xeneon Edge widget logic.
   Works inside iCUE (native .icuewidget or iFrame widget) and in a plain browser. */

// Bare assignment on purpose: iCUE needs to see this on the global scope.
icueEvents = {
  onDataUpdated: onIcueDataUpdated,
  onICUEInitialized: onIcueInitialized
};

var STATUS_META = {
  'good':           { label: 'Good Service',   css: 'var(--status-good)' },
  'notice':         { label: 'Notice',         css: 'var(--status-notice)' },
  'planned':        { label: 'Planned Work',   css: 'var(--status-planned)' },
  'service-change': { label: 'Service Change', css: 'var(--status-service-change)' },
  'delays':         { label: 'Delays',         css: 'var(--status-delays)' },
  'suspended':      { label: 'Suspended',      css: 'var(--status-suspended)' }
};

var app = {
  cfg: null, data: null, error: null, lastOk: 0,
  timer: null, inflight: false, tickerSig: '', detailTimer: null
};

// ---------- iCUE property helpers ----------
function getIcueProperty(name) {
  if (typeof window !== 'undefined' && Object.prototype.hasOwnProperty.call(window, name)) {
    var v = window[name];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  try {
    var v2 = Function('return typeof ' + name + ' !== "undefined" ? ' + name + ' : undefined')();
    if (v2 !== undefined && v2 !== null && v2 !== '') return v2;
  } catch (e) {}
  return undefined;
}
function clampRange(v, min, max, d) {
  if (v === undefined || v === null || v === '') return d;
  v = Number(v);
  if (!Number.isFinite(v)) return d;
  return Math.max(min, Math.min(max, v));
}
function asString(v) { return (typeof v === 'string') ? v.trim() : ''; }
function asBool(v, d) {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 1 || v === '1') return true;
  if (v === 'false' || v === 0 || v === '0') return false;
  return d;
}

// ---------- config ----------
function readConfig() {
  var qs = new URLSearchParams(window.location.search);
  var server = asString(getIcueProperty('serverUrl')) || qs.get('server') || '';
  // Served by the container itself (iFrame mode)? Then relative URLs are enough.
  var samePage = (window.location.protocol === 'http:' || window.location.protocol === 'https:');
  if (samePage && server && isPlaceholderServer(server)) server = '';
  return {
    serverUrl: server.replace(/\/+$/, ''),
    stops: asString(getIcueProperty('stops')) || qs.get('stops') || '',
    routes: asString(getIcueProperty('routes')) || qs.get('routes') || '',
    showArrivals: asBool(getIcueProperty('showArrivals'), qs.get('arrivals') !== '0'),
    showTicker: asBool(getIcueProperty('showTicker'), qs.get('ticker') !== '0'),
    refreshSeconds: clampRange(getIcueProperty('refreshSeconds') || qs.get('refresh'), 15, 120, 30),
    maxArrivals: clampRange(qs.get('max'), 1, 6, 3)
  };
}
// The default textfield value is an example address; when the page is already
// being served by the container we ignore it so the iFrame mode "just works".
function isPlaceholderServer(s) { return /192\.168\.1\.10:8787$/.test(s); }

function apiUrl() {
  var c = app.cfg, p = new URLSearchParams();
  if (c.stops) p.set('stops', c.stops);
  if (c.routes) p.set('routes', c.routes);
  p.set('max', String(c.maxArrivals));
  if (!c.showArrivals) p.set('arrivals', '0');
  return c.serverUrl + '/api/all?' + p.toString();
}

// ---------- styles ----------
function applyStyles() {
  var root = document.documentElement;
  var tc = getIcueProperty('textColor'), ac = getIcueProperty('accentColor'), bgc = getIcueProperty('backgroundColor');
  root.style.setProperty('--text', (typeof tc === 'string' && tc) ? tc : '#ffffff');
  root.style.setProperty('--accent', (typeof ac === 'string' && ac) ? ac : '#0039a6');
  root.style.setProperty('--bg', (typeof bgc === 'string' && bgc) ? bgc : '#0b0d12');
  root.style.setProperty('--bg-opacity', clampRange(getIcueProperty('transparency'), 0, 100, 100) / 100);
}

// ---------- fetching ----------
function refresh() {
  if (app.inflight) return;
  app.inflight = true;
  var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  var to = setTimeout(function () { if (ctrl) ctrl.abort(); }, 12000);
  var url = apiUrl();
  fetch(url, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status + ' from ' + url); return r.json(); })
    .then(function (d) { app.data = d; app.error = null; app.lastOk = Date.now(); })
    .catch(function (e) { app.error = (e && e.message) ? e.message : String(e); })
    .then(function () { clearTimeout(to); app.inflight = false; render(); });
}
function schedule() {
  if (app.timer) clearInterval(app.timer);
  app.timer = setInterval(refresh, app.cfg.refreshSeconds * 1000);
}

// ---------- rendering ----------
function el(tag, cls, text) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}
function bullet(info, small) {
  var b = el('span', 'bullet' + (small ? ' bullet-sm' : '') + (info.express ? ' express' : ''));
  b.style.background = info.color || '#6d6e71';
  b.style.color = info.textColor || '#fff';
  b.appendChild(el('span', null, info.label || info.route || '?'));
  return b;
}
function showState(state) {
  ['loading-state', 'error-state', 'content'].forEach(function (id) {
    var n = document.getElementById(id);
    if (n) n.style.display = (id === state) ? '' : 'none';
  });
}
function fmtTime(ts) {
  if (!ts) return '';
  var d = new Date(ts * 1000);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function render() {
  var root = document.getElementById('root');
  root.classList.toggle('has-ticker', !!app.cfg.showTicker);

  if (!app.data) {
    if (app.error) {
      showState('error-state');
      var hint = app.cfg.serverUrl ? app.error
        : 'No Server URL set. Enter http://<unraid-ip>:8787 in the widget settings.';
      document.getElementById('error-detail').textContent = hint;
    } else {
      showState('loading-state');
    }
    return;
  }
  showState('content');

  var st = app.data.status || {};
  var arr = app.data.arrivals;
  var hasArrivals = !!(app.cfg.showArrivals && arr && arr.stops && arr.stops.length);
  root.classList.toggle('has-arrivals', hasArrivals);

  renderSummary(st);
  renderChips(st.routes || []);
  if (hasArrivals) renderStops(arr.stops);
  if (app.cfg.showTicker) renderTicker(st.alerts || []);

  var upd = document.getElementById('updated');
  var stale = !!app.error;
  upd.classList.toggle('stale', stale);
  upd.textContent = (stale ? 'offline · last ' : 'updated ') + fmtTime(app.data.updated || (app.lastOk / 1000));
}

function renderSummary(st) {
  var s = document.getElementById('summary');
  s.textContent = '';
  var sum = st.summary || {};
  if (!sum.total) return;
  if (sum.issues === 0) {
    s.appendChild(el('span', 'ok', 'Good service on all ' + sum.total + ' lines'));
    return;
  }
  var parts = [];
  var by = sum.byStatus || {};
  ['suspended', 'delays', 'service-change', 'planned', 'notice'].forEach(function (k) {
    if (by[k]) parts.push(by[k] + ' ' + STATUS_META[k].label.toLowerCase());
  });
  s.appendChild(el('span', 'bad', sum.issues + ' of ' + sum.total + ' lines affected'));
  s.appendChild(document.createTextNode(' · ' + parts.join(', ')));
}

function renderChips(routes) {
  var box = document.getElementById('chips');
  box.textContent = '';
  routes.forEach(function (r) {
    var chip = el('div', 'chip s-' + r.status + (r.status !== 'good' ? ' issue' : ''));
    chip.appendChild(bullet(r));
    chip.appendChild(el('span', 'status-text', r.statusLabel));
    chip.title = r.statusLabel;
    if (r.alerts && r.alerts.length) {
      chip.classList.add('tappable');
      chip.addEventListener('click', function () { showDetail(r); });
    }
    box.appendChild(chip);
  });
}

function renderStops(stops) {
  var box = document.getElementById('stops');
  box.textContent = '';
  stops.forEach(function (s) {
    var card = el('div', 'stop');
    var head = el('div', 'stop-head');
    head.appendChild(el('span', 'stop-name', s.name));
    var rs = el('span', 'stop-routes');
    (s.routes || []).forEach(function (r) { rs.appendChild(bullet(r, true)); });
    head.appendChild(rs);
    card.appendChild(head);
    ['north', 'south'].forEach(function (d) {
      var dir = s[d] || { label: d, arrivals: [] };
      var row = el('div', 'dir-row');
      row.appendChild(el('span', 'dir-label', dir.label));
      var list = el('div', 'arrivals');
      if (!dir.arrivals.length) list.appendChild(el('span', 'none', 'no trains'));
      dir.arrivals.forEach(function (a) {
        var item = el('span', 'arrival' + (a.seconds < 45 ? ' now' : ''));
        item.appendChild(bullet(a, true));
        if (a.seconds < 45) {
          item.appendChild(el('span', 'min', 'Now'));
        } else {
          item.appendChild(el('span', 'min', String(Math.max(1, a.minutes))));
          item.appendChild(el('span', 'unit', 'min'));
        }
        list.appendChild(item);
      });
      row.appendChild(list);
      card.appendChild(row);
    });
    box.appendChild(card);
  });
}

// Turn "[A][C] trains ..." into inline bullets.
function alertTextNodes(text, container) {
  var re = /\[([A-Z0-9]{1,3})\]/g, last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) container.appendChild(document.createTextNode(text.slice(last, m.index)));
    container.appendChild(bullet(routeStyle(m[1]), true));
    last = re.lastIndex;
  }
  if (last < text.length) container.appendChild(document.createTextNode(text.slice(last)));
}
var ROUTE_COLORS = {
  '1': '#EE352E', '2': '#EE352E', '3': '#EE352E', '4': '#00933C', '5': '#00933C', '6': '#00933C',
  '7': '#B933AD', 'A': '#0039A6', 'C': '#0039A6', 'E': '#0039A6', 'B': '#FF6319', 'D': '#FF6319',
  'F': '#FF6319', 'M': '#FF6319', 'G': '#6CBE45', 'J': '#996633', 'Z': '#996633', 'L': '#A7A9AC',
  'N': '#FCCC0A', 'Q': '#FCCC0A', 'R': '#FCCC0A', 'W': '#FCCC0A', 'S': '#808183', 'SIR': '#0078C6', 'SI': '#0078C6'
};
function routeStyle(r) {
  return { label: r === 'SI' ? 'SIR' : r, color: ROUTE_COLORS[r] || '#6d6e71',
           textColor: /^[NQRW]$/.test(r) ? '#111' : '#fff' };
}

function renderTicker(alerts) {
  var track = document.getElementById('ticker-track');
  var sig = alerts.map(function (a) { return a.id + ':' + a.updated; }).join('|');
  if (sig === app.tickerSig) return;    // keep the scroll position when nothing changed
  app.tickerSig = sig;
  track.textContent = '';
  track.classList.remove('static');
  if (!alerts.length) {
    track.classList.add('static');
    track.appendChild(el('span', 'ticker-item', 'No active service alerts'));
    return;
  }
  alerts.forEach(function (a) {
    var item = el('span', 'ticker-item');
    item.style.setProperty('--status-color', STATUS_META[a.status] ? STATUS_META[a.status].css : '#888');
    item.appendChild(el('span', 'tag', a.type || STATUS_META[a.status].label));
    alertTextNodes(a.header || '', item);
    track.appendChild(item);
  });
  // ~90 px/s regardless of length; restart the animation from the right edge.
  requestAnimationFrame(function () {
    var w = track.scrollWidth || 1000;
    track.style.setProperty('--ticker-dur', Math.max(12, (w + window.innerWidth) / 90) + 's');
    track.style.animation = 'none';
    void track.offsetWidth;
    track.style.animation = '';
  });
}

// ---------- tap-to-inspect ----------
function showDetail(route) {
  var d = document.getElementById('detail');
  var b = document.getElementById('detail-bullet');
  b.textContent = ''; b.className = 'bullet detail-bullet';
  b.style.background = route.color; b.style.color = route.textColor;
  b.appendChild(el('span', null, route.label));
  var stTxt = document.getElementById('detail-status');
  stTxt.textContent = route.statusLabel;
  stTxt.style.color = STATUS_META[route.status] ? STATUS_META[route.status].css : '';
  var body = document.getElementById('detail-body');
  body.textContent = '';
  route.alerts.forEach(function (a) {
    var row = el('div', 'detail-alert');
    row.style.setProperty('--status-color', STATUS_META[a.status] ? STATUS_META[a.status].css : '#fff');
    row.appendChild(el('span', 'type', a.type));
    alertTextNodes(a.header || '', row);
    if (a.description) {
      var desc = el('span', 'desc');
      alertTextNodes(a.description, desc);
      row.appendChild(desc);
    }
    body.appendChild(row);
  });
  d.style.display = '';
  if (app.detailTimer) clearTimeout(app.detailTimer);
  app.detailTimer = setTimeout(hideDetail, 20000);
}
function hideDetail() {
  document.getElementById('detail').style.display = 'none';
  if (app.detailTimer) { clearTimeout(app.detailTimer); app.detailTimer = null; }
}
document.getElementById('detail').addEventListener('click', hideDetail);

// ---------- iCUE lifecycle ----------
function onIcueDataUpdated() {
  applyStyles();
  var next = readConfig();
  var changed = !app.cfg || JSON.stringify(next) !== JSON.stringify(app.cfg);
  app.cfg = next;
  if (changed) {
    app.tickerSig = '';
    schedule();
    refresh();
  } else {
    render();
  }
}
function onIcueInitialized() { onIcueDataUpdated(); }

// iCUE injects its globals on its own schedule; retry briefly before assuming a plain browser.
var bootAttempts = 0, BOOT_RETRY_MS = 100, BOOT_RETRY_MAX = 15;
function bootCheck() {
  if (typeof iCUE_initialized !== 'undefined' && iCUE_initialized) { onIcueInitialized(); return; }
  if (bootAttempts < BOOT_RETRY_MAX) { bootAttempts++; setTimeout(bootCheck, BOOT_RETRY_MS); return; }
  onIcueDataUpdated();
}
bootCheck();
