/* MTA Subway Dashboard: tablet / kiosk front end for the mta-widget-status container.
   Settings live in this browser's localStorage. A "kiosk link" carries the same
   settings in the URL so a fresh tablet (or a wiped browser) can be set up in one step. */
(function () {
  'use strict';

  var API = '../api/';
  var STORE_KEY = 'mta-dashboard:settings:v1';
  var SEEN_KEY = 'mta-dashboard:links:v1';

  var DEFAULTS = {
    configured: false,   // false = follow the container's MTA_STOPS / MTA_ROUTES
    stops: [],           // [{ id: 'L08', dir: 'both' | 'N' | 'S', solo: false }]
                         // solo=false shows every line at the station, solo=true only that platform
    routes: [],          // [] = every line
    max: 4,              // trains per direction
    showGood: true,
    countPlanned: true,
    showAlerts: true,
    refresh: 30,
    theme: 'dark',       // dark | light | auto
    clock24: false,
    dim: false,
    dimStart: '23:00',
    dimEnd: '06:00',
    dimLevel: 60
  };

  var STATUS_LABEL = {
    'good': 'Good Service', 'notice': 'Notice', 'planned': 'Planned Work',
    'service-change': 'Service Change', 'delays': 'Delays', 'suspended': 'Suspended'
  };
  var STATUS_RANK = { 'good': 0, 'notice': 1, 'planned': 2, 'service-change': 3, 'delays': 4, 'suspended': 5 };
  var TOKEN_ALIAS = { 'S': 'GS', 'SIR': 'SI', '6X': '6', '7X': '7', 'FS': 'GS', 'H': 'GS' };
  var BOROUGH = { 'M': 'Manhattan', 'Bk': 'Brooklyn', 'Bx': 'Bronx', 'Q': 'Queens', 'SI': 'Staten Island' };
  var PARAM_KEYS = ['stops', 'solo', 'routes', 'max', 'good', 'planned', 'alerts', 'refresh', 'theme', 'clock', 'dim'];

  var st = {
    settings: null, server: null, lines: {}, lineOrder: [], stationMeta: {},
    metaTried: {}, data: null, lastOk: 0, error: null, offset: 0,
    inflight: false, pending: false, fetchTimer: null,
    focusLine: null, expanded: {}, plannedOpen: null, wakeLock: null
  };
  var draft = null;

  // ---------------------------------------------------------------- helpers
  function $(id) { return document.getElementById(id); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function readJSON(k) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
  function writeJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  function removeKey(k) { try { localStorage.removeItem(k); } catch (e) { /* storage unavailable */ } }
  function clampInt(v, lo, hi, d) { v = parseInt(v, 10); return isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d; }
  function isTime(v) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(v || ''); }
  function nowMs() { return Date.now() + st.offset; }

  function h(tag, props, kids) {
    var e = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, v === true ? '' : v);
      });
    }
    (kids || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return e;
  }
  function clear(e) { while (e.firstChild) e.removeChild(e.firstChild); return e; }

  function fmtTime(ms) {
    return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: !st.settings.clock24 });
  }

  function getJSON(path, ms) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, ms || 12000);
    return fetch(API + path, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) {
        clearTimeout(timer);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }, function (e) {
        clearTimeout(timer);
        throw (e && e.name === 'AbortError') ? new Error('timed out') : e;
      });
  }

  // ---------------------------------------------------------------- lines / bullets
  function indexLines(list) {
    st.lines = {}; st.lineOrder = [];
    (list || []).forEach(function (l) { st.lines[l.id] = l; st.lineOrder.push(l.id); });
  }
  function boardId(token) {
    var t = String(token || '').toUpperCase();
    if (st.lines[t]) return t;
    return TOKEN_ALIAS[t] || t;
  }
  function lineInfo(token) {
    var id = boardId(token);
    return st.lines[id] || { id: id, label: token, color: '#6d6e71', textColor: '#ffffff' };
  }
  function bullet(info, size) {
    var label = info.label || info.route || '?';
    var b = h('span', {
      class: 'bullet' + (size ? ' b-' + size : '') + (info.express ? ' express' : '') + (label.length > 2 ? ' long' : ''),
      title: label + ' train', role: 'img', 'aria-label': label + ' train'
    }, [h('span', { text: label })]);
    b.style.background = info.color || '#6d6e71';
    b.style.color = info.textColor || '#fff';
    return b;
  }
  // "[A][C] trains are delayed" -> inline bullets
  function richText(text, el) {
    var re = /\[([A-Z0-9]{1,3})\]/g, last = 0, m;
    text = text || '';
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) el.appendChild(document.createTextNode(text.slice(last, m.index)));
      el.appendChild(bullet(lineInfo(m[1]), 'inline'));
      last = re.lastIndex;
    }
    if (last < text.length) el.appendChild(document.createTextNode(text.slice(last)));
    return el;
  }

  // ---------------------------------------------------------------- settings
  function splitList(v) {
    return String(v || '').split(',').map(function (x) { return x.trim().toUpperCase(); }).filter(Boolean);
  }
  function parseStop(tok) {
    var m = /^([A-Z0-9]+?)(?:-([NS]))?$/.exec(tok);
    return m ? { id: m[1], dir: m[2] || 'both', solo: false } : null;
  }
  function stopToken(s) { return s.dir === 'both' ? s.id : s.id + '-' + s.dir; }

  function settingsFromParams(qs) {
    if (!PARAM_KEYS.some(function (k) { return qs.has(k); })) return null;
    var s = clone(DEFAULTS);
    s.configured = true;
    if (qs.has('stops')) s.stops = splitList(qs.get('stops')).map(parseStop).filter(Boolean);
    var solo = splitList(qs.get('solo'));
    s.stops.forEach(function (x) { x.solo = solo.indexOf(x.id) >= 0; });
    if (qs.has('routes')) s.routes = splitList(qs.get('routes')).map(boardId);
    if (qs.has('max')) s.max = clampInt(qs.get('max'), 1, 5, s.max);
    if (qs.has('good')) s.showGood = qs.get('good') !== '0';
    if (qs.has('planned')) s.countPlanned = qs.get('planned') !== '0';
    if (qs.has('alerts')) s.showAlerts = qs.get('alerts') !== '0';
    if (qs.has('refresh')) s.refresh = clampInt(qs.get('refresh'), 15, 300, s.refresh);
    if (/^(dark|light|auto)$/.test(qs.get('theme') || '')) s.theme = qs.get('theme');
    if (qs.has('clock')) s.clock24 = qs.get('clock') === '24';
    var dm = /^(\d\d:\d\d)-(\d\d:\d\d)(?:-(\d+))?$/.exec(qs.get('dim') || '');
    if (dm && isTime(dm[1]) && isTime(dm[2])) {
      s.dim = true; s.dimStart = dm[1]; s.dimEnd = dm[2];
      if (dm[3]) s.dimLevel = clampInt(dm[3], 10, 90, s.dimLevel);
    }
    return s;
  }

  function settingsToQuery(s) {
    var p = ['stops=' + s.stops.map(stopToken).join(',')];
    var solo = s.stops.filter(function (x) { return x.solo; }).map(function (x) { return x.id; });
    if (solo.length) p.push('solo=' + solo.join(','));
    if (s.routes.length) p.push('routes=' + s.routes.join(','));
    p.push('max=' + s.max);
    if (!s.showGood) p.push('good=0');
    if (!s.countPlanned) p.push('planned=0');
    if (!s.showAlerts) p.push('alerts=0');
    if (s.refresh !== DEFAULTS.refresh) p.push('refresh=' + s.refresh);
    if (s.theme !== 'dark') p.push('theme=' + s.theme);
    if (s.clock24) p.push('clock=24');
    if (s.dim) p.push('dim=' + s.dimStart + '-' + s.dimEnd + '-' + s.dimLevel);
    return p.join('&');
  }

  // A kiosk link is applied the first time this browser sees it. After that the
  // tablet's own edits win, so a kiosk app that always reopens the same start URL
  // does not undo changes made on the tablet.
  function loadSettings() {
    var stored = readJSON(STORE_KEY);
    var s = Object.assign(clone(DEFAULTS), stored || {});
    var qs = new URLSearchParams(window.location.search);
    var fromUrl = settingsFromParams(qs);
    if (fromUrl) {
      var sig = PARAM_KEYS.filter(function (k) { return qs.has(k); })
        .map(function (k) { return k + '=' + qs.get(k); }).join('&');
      var seen = readJSON(SEEN_KEY) || [];
      if (!stored || seen.indexOf(sig) === -1 || qs.get('apply') === '1') {
        s = fromUrl;
        writeJSON(STORE_KEY, s);
        seen.push(sig);
        writeJSON(SEEN_KEY, seen.slice(-20));
      }
    }
    return s;
  }

  function effStops() {
    if (st.settings.configured) return st.settings.stops;
    return ((st.server && st.server.stops) || []).map(function (id) { return { id: id, dir: 'both', solo: false }; });
  }
  function effRoutes() {
    if (st.settings.configured) return st.settings.routes;
    return ((st.server && st.server.routes) || []).map(boardId);
  }

  // Station complexes: one physical station can have several platforms with
  // their own stop IDs (Times Sq: 127, 725, R16, 902, A27).
  function rememberStation(r) {
    if (!r || !r.id) return;
    st.stationMeta[r.id] = r;
    (r.complexStops || []).forEach(function (m) {
      if (!st.stationMeta[m.id] || !st.stationMeta[m.id].complexStops) {
        st.stationMeta[m.id] = Object.assign({}, m, { complex: r.complex, complexStops: r.complexStops, allRoutes: r.allRoutes });
      }
    });
  }
  function stopMembers(entry) {
    var meta = st.stationMeta[entry.id];
    if (entry.solo || !meta || !meta.complexStops) return [entry.id];
    return meta.complexStops.map(function (m) { return m.id; });
  }
  function entryRoutes(entry) {
    var meta = st.stationMeta[entry.id];
    if (!meta) return [];
    return entry.solo ? (meta.routes || []) : (meta.allRoutes || meta.routes || []);
  }
  function entryName(entry) {
    var meta = st.stationMeta[entry.id];
    return meta ? meta.name : entry.id;
  }
  function dirLabels(entry, key) {
    var meta = st.stationMeta[entry.id];
    if (!meta) return key === 'north' ? 'Northbound' : 'Southbound';
    var list = entry.solo || !meta.complexStops ? [meta] : meta.complexStops;
    var labels = [];
    list.forEach(function (m) { var l = m[key]; if (l && labels.indexOf(l) < 0) labels.push(l); });
    var real = labels.filter(function (l) { return l !== 'Last Stop'; });
    return (real.length ? real : labels).join(' / ') || (key === 'north' ? 'Northbound' : 'Southbound');
  }

  // ---------------------------------------------------------------- data
  function refresh() {
    if (st.inflight) { st.pending = true; return; }
    st.inflight = true;
    var pre = [];
    if (!st.server) pre.push(getJSON('config').then(function (c) { st.server = c; }, function () {}));
    if (!st.lineOrder.length) pre.push(getJSON('lines').then(function (r) { indexLines(r.lines); }, function () {}));
    Promise.all(pre).then(function () {
      return loadStationMeta(effStops().map(function (x) { return x.id; }));
    }).then(function () {
      var stops = effStops();
      var ids = [];
      stops.forEach(function (x) { stopMembers(x).forEach(function (id) { if (ids.indexOf(id) < 0) ids.push(id); }); });
      var q = 'all?stops=' + encodeURIComponent(ids.join(',')) +
        '&routes=' + encodeURIComponent(effRoutes().join(',')) +
        '&max=' + Math.min(6, st.settings.max + 1) +
        (stops.length ? '' : '&arrivals=0');
      return getJSON(q);
    }).then(function (d) {
      st.data = d; st.error = null; st.lastOk = Date.now();
      if (d.serverTime) st.offset = d.serverTime * 1000 - Date.now();
    }, function (e) {
      st.error = (e && e.message) ? e.message : String(e);
    }).then(function () {
      st.inflight = false;
      render();
      if (st.pending) { st.pending = false; refresh(); }
    });
  }
  function schedule() {
    if (st.fetchTimer) clearInterval(st.fetchTimer);
    st.fetchTimer = setInterval(refresh, st.settings.refresh * 1000);
  }

  function computeLines() {
    var routes = (st.data && st.data.status && st.data.status.routes) || [];
    return routes.map(function (r) {
      var all = r.alerts || [];
      var counted = all.filter(function (a) { return st.settings.countPlanned || !a.planned; });
      var status = 'good';
      counted.forEach(function (a) { if (STATUS_RANK[a.status] > STATUS_RANK[status]) status = a.status; });
      return { id: r.id, info: r, status: status, counted: counted, all: all };
    });
  }

  // ---------------------------------------------------------------- rendering
  function render() {
    renderClock(true);
    var grid = $('grid');
    if (!st.data) {
      grid.className = 'grid loading';
      $('state').textContent = st.error
        ? 'Can\u2019t reach the subway server (' + st.error + '). Retrying\u2026'
        : 'Loading subway data\u2026';
      renderBanner();
      return;
    }
    var stops = effStops();
    var showAlerts = st.settings.showAlerts || !!st.focusLine;
    grid.className = 'grid' + (stops.length ? '' : ' no-arrivals') + (showAlerts ? '' : ' no-alerts') +
      (stops.length >= 4 ? ' compact' : '');
    var lines = computeLines();
    renderSummary(lines);
    renderLines(lines);
    renderArrivals();
    if (showAlerts) renderAlerts(lines);
    renderUpdated();
    renderBanner();
  }

  function renderSummary(lines) {
    var el = $('summary');
    if (!lines.length) { el.hidden = true; return; }
    var issues = lines.filter(function (l) { return l.status !== 'good'; });
    var worst = 'good';
    issues.forEach(function (l) { if (STATUS_RANK[l.status] > STATUS_RANK[worst]) worst = l.status; });
    el.hidden = false;
    el.className = 'summary s-' + worst;
    el.textContent = issues.length
      ? issues.length + ' of ' + lines.length + ' lines with issues'
      : 'Good service on ' + (lines.length > 1 ? 'all ' + lines.length + ' lines' : 'your line');
  }

  function toggleFocus(id) {
    st.focusLine = st.focusLine === id ? null : id;
    render();
  }

  function renderLines(lines) {
    var box = clear($('lines'));
    if (!lines.length) { box.appendChild(h('div', { class: 'empty', text: 'No line data yet.' })); return; }
    var issues = lines.filter(function (l) { return l.status !== 'good'; })
      .sort(function (a, b) { return STATUS_RANK[b.status] - STATUS_RANK[a.status]; });
    var good = lines.filter(function (l) { return l.status === 'good'; });

    if (!issues.length) {
      box.appendChild(h('div', { class: 'all-good' }, [
        h('span', { class: 'check', text: '\u2713' }),
        'Good service on ' + (lines.length > 1 ? 'all ' + lines.length + ' lines' : 'the ' + lines[0].info.label)
      ]));
    } else {
      var grid = h('div', { class: 'issue-grid' });
      issues.forEach(function (l) {
        var n = l.counted.length;
        grid.appendChild(h('button', {
          type: 'button', class: 'tile s-' + l.status + (st.focusLine === l.id ? ' selected' : ''),
          'aria-pressed': st.focusLine === l.id ? 'true' : 'false',
          onclick: function () { toggleFocus(l.id); }
        }, [
          bullet(l.info, 'lg'),
          h('span', { class: 'tile-text' }, [
            h('span', { class: 'tile-status', text: STATUS_LABEL[l.status] }),
            h('span', { class: 'tile-count', text: n + (n === 1 ? ' alert' : ' alerts') })
          ])
        ]));
      });
      box.appendChild(grid);
    }

    if (st.settings.showGood && good.length && issues.length) {
      var strip = h('div', { class: 'good-strip' }, [h('span', { class: 'good-label', text: 'Good service' })]);
      good.forEach(function (l) {
        var has = l.all.length > 0;
        strip.appendChild(h('button', {
          type: 'button', class: 'good-bullet' + (has ? ' has-alerts' : '') + (st.focusLine === l.id ? ' selected' : ''),
          'aria-label': l.info.label + ' train: good service' + (has ? ', planned work listed' : ''),
          disabled: !has,
          onclick: has ? function () { toggleFocus(l.id); } : null
        }, [bullet(l.info, 'md')]));
      });
      box.appendChild(strip);
    } else if (st.settings.showGood && !issues.length && lines.length > 1) {
      var allStrip = h('div', { class: 'good-strip' });
      lines.forEach(function (l) {
        var has = l.all.length > 0;
        allStrip.appendChild(h('button', {
          type: 'button', class: 'good-bullet' + (has ? ' has-alerts' : '') + (st.focusLine === l.id ? ' selected' : ''),
          disabled: !has, onclick: has ? function () { toggleFocus(l.id); } : null
        }, [bullet(l.info, 'md')]));
      });
      box.appendChild(allStrip);
    }
  }

  function renderArrivals() {
    var box = clear($('stops'));
    var cfg = effStops();
    if (!cfg.length || !st.data) return;
    var byId = {};
    ((st.data.arrivals && st.data.arrivals.stops) || []).forEach(function (s) { byId[s.id] = s; });
    var t = nowMs();

    cfg.forEach(function (c) {
      var members = stopMembers(c).map(function (id) { return byId[id]; }).filter(Boolean);
      if (!members.length) {
        box.appendChild(h('div', { class: 'stop' }, [
          h('div', { class: 'stop-name', text: entryName(c) }),
          h('div', { class: 'muted', text: 'Waiting for data\u2026' })
        ]));
        return;
      }

      // Header: station name plus every line served by the platforms shown.
      var head = h('div', { class: 'stop-head' }, [h('div', { class: 'stop-name', text: st.stationMeta[c.id] ? entryName(c) : members[0].name })]);
      var rb = h('div', { class: 'stop-routes' }), shown = {}, routes = [];
      members.forEach(function (m) {
        (m.routes || []).forEach(function (r) { if (!shown[r.label]) { shown[r.label] = 1; routes.push(r); } });
      });
      var rank = function (r) { var i = st.lineOrder.indexOf(boardId(r.route || r.label)); return i < 0 ? 99 : i; };
      routes.sort(function (a, b) { return rank(a) - rank(b); });
      routes.forEach(function (r) { rb.appendChild(bullet(r, 'xs')); });
      head.appendChild(rb);
      var card = h('div', { class: 'stop' }, [head]);

      // Rows: one per direction label. Platforms that share a label
      // (e.g. "Uptown" on the 1/2/3 and N/Q/R/W) merge into one row.
      var keys = c.dir === 'N' ? ['north'] : c.dir === 'S' ? ['south'] : ['north', 'south'];
      var rows = [], at = {};
      keys.forEach(function (k) {
        members.forEach(function (m) {
          var d = m[k];
          if (!d) return;
          if (!(d.label in at)) { at[d.label] = rows.length; rows.push({ label: d.label, arrivals: [] }); }
          rows[at[d.label]].arrivals = rows[at[d.label]].arrivals.concat(d.arrivals || []);
        });
      });
      rows.forEach(function (r) {
        r.trains = r.arrivals.filter(function (a) { return a.time * 1000 > t - 30000; })
          .sort(function (a, b) { return a.time - b.time; })
          .slice(0, st.settings.max);
      });
      // At multi-platform stations, hide directions with nothing coming
      // (e.g. a shuttle's "Last Stop" side or a line that isn't running).
      if (members.length > 1 && rows.some(function (r) { return r.trains.length; })) {
        rows = rows.filter(function (r) { return r.trains.length; });
      }

      rows.forEach(function (r) {
        var list = h('div', { class: 'trains' });
        if (!r.trains.length) list.appendChild(h('span', { class: 'none', text: 'No trains scheduled' }));
        r.trains.forEach(function (a, i) {
          var secs = Math.round((a.time * 1000 - t) / 1000);
          var due = secs <= 30;
          var el = h('div', { class: 'train' + (i === 0 ? ' primary' : '') + (due ? ' due' : '') }, [bullet(a, i === 0 ? 'md' : 'sm')]);
          if (due) {
            el.appendChild(h('span', { class: 'min', text: 'Now' }));
          } else {
            el.appendChild(h('span', { class: 'min', text: String(Math.max(1, Math.floor(secs / 60))) }));
            el.appendChild(h('span', { class: 'unit', text: 'min' }));
          }
          list.appendChild(el);
        });
        card.appendChild(h('div', { class: 'dir' }, [h('div', { class: 'dir-label', text: r.label }), list]));
      });
      box.appendChild(card);
    });
  }

  function alertSort(a, b) {
    return (STATUS_RANK[b.status] - STATUS_RANK[a.status]) || ((b.updated || 0) - (a.updated || 0));
  }

  function alertCard(a) {
    var open = !!st.expanded[a.id];
    var card = h('div', {
      class: 'alert s-' + a.status, role: 'button', tabindex: '0', 'aria-expanded': open ? 'true' : 'false',
      onclick: function () { st.expanded[a.id] = !open; render(); },
      onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); st.expanded[a.id] = !open; render(); } }
    }, [
      h('div', { class: 'alert-head' }, [
        h('span', { class: 'alert-type', text: a.type || STATUS_LABEL[a.status] }),
        a.updated ? h('span', { class: 'alert-time', text: 'Updated ' + fmtTime(a.updated * 1000) }) : null
      ]),
      richText(a.header, h('div', { class: 'alert-text' }))
    ]);
    if (a.description) {
      card.appendChild(open
        ? richText(a.description, h('div', { class: 'alert-desc' }))
        : h('div', { class: 'alert-more', text: 'Tap for details' }));
    }
    return card;
  }

  function renderAlerts(lines) {
    var box = clear($('alerts'));
    var focus = st.focusLine;
    var seen = {}, list = [];
    lines.forEach(function (l) {
      if (focus && l.id !== focus) return;
      l.all.forEach(function (a) { if (!seen[a.id]) { seen[a.id] = 1; list.push(a); } });
    });
    var current = list.filter(function (a) { return !a.planned; }).sort(alertSort);
    var planned = list.filter(function (a) { return a.planned; }).sort(alertSort);

    var title = clear($('alerts-title'));
    if (focus) {
      title.appendChild(document.createTextNode('Alerts for '));
      title.appendChild(bullet(lineInfo(focus), 'inline'));
    } else {
      title.appendChild(document.createTextNode('Service alerts' + (list.length ? ' \u00b7 ' + list.length : '')));
    }
    $('alerts-clear').hidden = !focus;

    if (!list.length) {
      box.appendChild(h('div', { class: 'empty', text: focus ? 'No alerts for this line.' : 'No active alerts for your lines.' }));
      return;
    }
    current.forEach(function (a) { box.appendChild(alertCard(a)); });
    if (!current.length) box.appendChild(h('div', { class: 'empty', text: 'No unplanned disruptions right now.' }));

    if (planned.length) {
      var open = focus ? true : (st.plannedOpen === null ? st.settings.countPlanned : st.plannedOpen);
      box.appendChild(h('button', {
        type: 'button', class: 'group-toggle' + (open ? ' open' : ''), 'aria-expanded': open ? 'true' : 'false',
        onclick: function () { st.plannedOpen = !open; render(); }
      }, ['Planned work \u00b7 ' + planned.length, h('span', { class: 'chev', text: '\u25be' })]));
      if (open) planned.forEach(function (a) { box.appendChild(alertCard(a)); });
    }
  }

  function renderUpdated() {
    var el = $('updated');
    if (!st.lastOk) { el.textContent = ''; return; }
    el.textContent = 'Updated ' + fmtTime(st.lastOk);
    el.classList.toggle('stale', isStale());
  }

  function isStale() {
    return !!st.lastOk && Date.now() - st.lastOk > Math.max(90000, st.settings.refresh * 3000);
  }

  function renderBanner() {
    var b = clear($('banner'));
    var msg = null, action = null, kind = '';
    if (st.data && isStale()) {
      kind = 'warn';
      msg = 'Can\u2019t reach the subway server. Showing data from ' + fmtTime(st.lastOk) + '.';
    } else if (st.data && st.data.errors && st.data.errors.length) {
      kind = 'warn';
      msg = 'The MTA feed isn\u2019t responding right now, so some times may be out of date.';
    } else if (st.data && !st.settings.configured) {
      msg = effStops().length
        ? 'Showing the server\u2019s default stations.'
        : 'No stations picked yet, so only line status is shown.';
      action = h('button', { type: 'button', class: 'btn small', text: 'Choose stations', onclick: openSettings });
    }
    b.hidden = !msg;
    if (!msg) return;
    b.className = 'banner' + (kind ? ' ' + kind : '');
    b.appendChild(h('span', { text: msg }));
    if (action) b.appendChild(action);
  }

  var lastClock = '';
  function renderClock(force) {
    var d = new Date();
    var t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: !st.settings.clock24 });
    if (!force && t === lastClock) return;
    lastClock = t;
    $('clock-time').textContent = t;
    $('clock-date').textContent = d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
  }

  // ---------------------------------------------------------------- appearance
  var mql = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
  function applyTheme() {
    var t = st.settings.theme;
    if (t === 'auto') t = (mql && mql.matches) ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', t);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t === 'light' ? '#eef1f5' : '#0b0d12');
  }
  if (mql) {
    var onScheme = function () { if (st.settings && st.settings.theme === 'auto') applyTheme(); };
    if (mql.addEventListener) mql.addEventListener('change', onScheme);
    else if (mql.addListener) mql.addListener(onScheme);
  }

  function minutesOf(hm) { var p = hm.split(':'); return (+p[0]) * 60 + (+p[1]); }
  function applyDim() {
    var s = st.settings, on = false;
    if (s.dim && isTime(s.dimStart) && isTime(s.dimEnd)) {
      var d = new Date(), m = d.getHours() * 60 + d.getMinutes();
      var a = minutesOf(s.dimStart), b = minutesOf(s.dimEnd);
      on = a === b ? false : (a < b ? (m >= a && m < b) : (m >= a || m < b));
    }
    document.documentElement.style.setProperty('--dim', on ? String(s.dimLevel / 100) : '0');
  }

  // Nudge the whole layout a few pixels now and then to spread screen wear.
  function shiftLayout() {
    var r = function () { return Math.round(Math.random() * 6 - 3) + 'px'; };
    var app = $('app');
    app.style.setProperty('--sx', r());
    app.style.setProperty('--sy', r());
  }

  // ---------------------------------------------------------------- kiosk helpers
  function fsElement() { return document.fullscreenElement || document.webkitFullscreenElement; }
  function canFullscreen() {
    var de = document.documentElement;
    return !!(de.requestFullscreen || de.webkitRequestFullscreen);
  }
  function toggleFullscreen() {
    var de = document.documentElement;
    try {
      if (fsElement()) {
        (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      } else {
        var p = (de.requestFullscreen || de.webkitRequestFullscreen).call(de);
        if (p && p.catch) p.catch(function () {});
      }
    } catch (e) { /* not allowed here */ }
  }

  function wakeLockSupported() { return 'wakeLock' in navigator && window.isSecureContext; }
  function requestWakeLock() {
    if (!wakeLockSupported() || st.wakeLock || document.visibilityState !== 'visible') return;
    navigator.wakeLock.request('screen').then(function (lock) {
      st.wakeLock = lock;
      lock.addEventListener('release', function () { st.wakeLock = null; });
    }, function () {});
  }

  // ---------------------------------------------------------------- settings sheet
  function loadStationMeta(ids) {
    var missing = ids.filter(function (id) {
      var m = st.stationMeta[id];
      return (!m || !m.complexStops) && !st.metaTried[id];
    });
    if (!missing.length) return Promise.resolve();
    return getJSON('stations?ids=' + encodeURIComponent(missing.join(','))).then(function (r) {
      missing.forEach(function (id) { st.metaTried[id] = true; });
      (r.results || []).forEach(rememberStation);
    }, function () {});
  }

  function section(title, hint, kids) {
    return h('section', { class: 'sec' }, [h('h3', { text: title }), hint ? h('div', { class: 'hint', text: hint }) : null].concat(kids || []));
  }
  function row(label, hint, control) {
    return h('div', { class: 'row' }, [
      h('div', { class: 'row-text' }, [h('div', { class: 'row-label', text: label }), hint ? h('div', { class: 'hint', text: hint }) : null]),
      h('div', { class: 'row-ctl' }, [control])
    ]);
  }
  function seg(options, current, onChange, label) {
    var wrap = h('div', { class: 'seg', role: 'group', 'aria-label': label || null });
    options.forEach(function (o) {
      var b = h('button', {
        type: 'button', class: 'seg-btn' + (o.v === current ? ' on' : ''), text: o.node ? null : o.label,
        'aria-label': o.node ? o.label : null, 'aria-pressed': o.v === current ? 'true' : 'false'
      }, o.node ? [o.node] : null);
      b.addEventListener('click', function () {
        Array.prototype.forEach.call(wrap.children, function (x) { x.classList.remove('on'); x.setAttribute('aria-pressed', 'false'); });
        b.classList.add('on'); b.setAttribute('aria-pressed', 'true');
        onChange(o.v);
      });
      wrap.appendChild(b);
    });
    return wrap;
  }
  function switchCtl(value, onChange, label) {
    var input = h('input', { type: 'checkbox', 'aria-label': label });
    input.checked = !!value;
    input.addEventListener('change', function () { onChange(input.checked); });
    return h('label', { class: 'switch' }, [input, h('span', { class: 'track' })]);
  }

  var linkInput = null;
  function kioskLink(s) {
    return window.location.origin + window.location.pathname + '?' + settingsToQuery(s);
  }
  function changed() { if (linkInput && draft) linkInput.value = kioskLink(draft); }

  function openSettings() {
    draft = clone(st.settings);
    if (!draft.configured) {
      draft.stops = effStops().map(function (x) { return { id: x.id, dir: x.dir }; });
      draft.routes = effRoutes().slice();
    }
    buildSettings();
    $('settings').hidden = false;
    loadStationMeta(draft.stops.map(function (x) { return x.id; })).then(renderSelectedStops);
  }
  function closeSettings() { $('settings').hidden = true; draft = null; linkInput = null; }
  function applySettings(next) {
    st.settings = next;
    st.focusLine = null; st.expanded = {}; st.plannedOpen = null;
    applyTheme(); applyDim(); schedule(); render(); refresh();
  }
  function saveSettings() {
    if (!draft) return;
    draft.configured = true;
    var next = draft;
    writeJSON(STORE_KEY, next);
    closeSettings();
    applySettings(next);
  }

  function renderSelectedStops() {
    var box = $('sel-stops');
    if (!box || !draft) return;
    clear(box);
    if (!draft.stops.length) {
      box.appendChild(h('div', { class: 'empty-note', text: 'No stations yet. Search below to add one.' }));
      return;
    }
    draft.stops.forEach(function (sel, idx) {
      var meta = st.stationMeta[sel.id];
      var bl = h('span', { class: 'sel-bullets' });
      entryRoutes(sel).forEach(function (r) { bl.appendChild(bullet(lineInfo(r), 'xs')); });
      var move = function (d) {
        var j = idx + d;
        if (j < 0 || j >= draft.stops.length) return;
        var tmp = draft.stops[idx]; draft.stops[idx] = draft.stops[j]; draft.stops[j] = tmp;
        renderSelectedStops(); changed();
      };
      var top = h('div', { class: 'sel-top' }, [
        h('span', { class: 'sel-name' }, [entryName(sel)]),
        bl,
        h('span', { class: 'sel-actions' }, [
          h('button', { type: 'button', class: 'mini-btn', text: '\u2191', 'aria-label': 'Move up', disabled: idx === 0, onclick: function () { move(-1); } }),
          h('button', { type: 'button', class: 'mini-btn', text: '\u2193', 'aria-label': 'Move down', disabled: idx === draft.stops.length - 1, onclick: function () { move(1); } }),
          h('button', { type: 'button', class: 'mini-btn', text: '\u2715', 'aria-label': 'Remove station', onclick: function () { draft.stops.splice(idx, 1); renderSelectedStops(); changed(); } })
        ])
      ]);
      var item = h('div', { class: 'sel' }, [top]);

      // Platform picker, only for stations that have more than one.
      var group = meta && meta.complexStops && meta.complexStops.length > 1 ? meta.complexStops : null;
      if (group) {
        var opts = [{ v: '*', label: 'All lines' }].concat(group.map(function (m) {
          var node = h('span', { class: 'seg-bullets' });
          (m.routes || []).forEach(function (r) { node.appendChild(bullet(lineInfo(r), 'xs')); });
          return { v: m.id, label: (m.routes || []).join(' ') + ' only', node: node };
        }));
        item.appendChild(h('div', { class: 'sel-field' }, [
          h('span', { class: 'sel-field-label', text: 'Lines here' }),
          seg(opts, sel.solo ? sel.id : '*', function (v) {
            if (v === '*') { sel.solo = false; } else { sel.id = v; sel.solo = true; }
            renderSelectedStops(); changed();
          }, 'Lines at this station')
        ]));
      }

      item.appendChild(h('div', { class: 'sel-field' }, [
        h('span', { class: 'sel-field-label', text: 'Direction' }),
        seg([
          { v: 'both', label: 'Both' },
          { v: 'N', label: dirLabels(sel, 'north') },
          { v: 'S', label: dirLabels(sel, 'south') }
        ], sel.dir, function (v) { sel.dir = v; changed(); }, 'Direction')
      ]));
      box.appendChild(item);
    });
  }

  function sameStation(a, b) {
    var ma = st.stationMeta[a], mb = st.stationMeta[b];
    return a === b || !!(ma && mb && ma.complex && ma.complex === mb.complex);
  }

  function renderResults(box, results, input) {
    clear(box);
    if (!results.length) { box.appendChild(h('div', { class: 'empty-note', text: 'No stations match.' })); return; }
    results.forEach(function (r) {
      rememberStation(r);
      var added = draft.stops.some(function (s) { return sameStation(s.id, r.id); });
      var bl = h('span', { class: 'sel-bullets' });
      (r.allRoutes || r.routes || []).forEach(function (x) { bl.appendChild(bullet(lineInfo(x), 'sm')); });
      box.appendChild(h('button', {
        type: 'button', class: 'result', disabled: added,
        onclick: function () {
          draft.stops.push({ id: r.id, dir: 'both', solo: false });
          input.value = '';
          clear(box);
          renderSelectedStops(); changed();
        }
      }, [h('span', { class: 'result-name', text: r.name }), bl,
        h('span', { class: 'result-sub', text: added ? 'Added' : (BOROUGH[r.borough] || r.borough || '') })]));
    });
  }

  function buildSettings() {
    var body = clear($('settings-body'));

    // Stations
    var search = h('input', {
      type: 'search', class: 'input', placeholder: 'Add a station: type part of its name, e.g. Bedford',
      autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Search stations'
    });
    var results = h('div', { class: 'results' });
    var timer = null, seq = 0;
    search.addEventListener('input', function () {
      clearTimeout(timer);
      var q = search.value.trim();
      if (q.length < 2) { clear(results); return; }
      timer = setTimeout(function () {
        var mine = ++seq;
        getJSON('stations?q=' + encodeURIComponent(q)).then(function (r) {
          if (mine === seq && draft) renderResults(results, r.results || [], search);
        }, function () {
          if (mine === seq) clear(results).appendChild(h('div', { class: 'empty-note', text: 'Search failed. Is the server reachable?' }));
        });
      }, 250);
    });
    body.appendChild(section('Stations', 'Next trains are shown for these stations, in this order. A station shows every line that stops there unless you pick one platform under Lines here.', [
      h('div', { class: 'sel-stops', id: 'sel-stops' }), search, results
    ]));
    renderSelectedStops();

    // Lines
    var picker = h('div', { class: 'line-picker' });
    var note = h('span', { class: 'hint' });
    function syncPicker() {
      picker.classList.toggle('all', !draft.routes.length);
      Array.prototype.forEach.call(picker.children, function (b) {
        var on = draft.routes.indexOf(b.getAttribute('data-id')) >= 0;
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      note.textContent = draft.routes.length
        ? draft.routes.length + (draft.routes.length === 1 ? ' line selected' : ' lines selected')
        : 'Watching all lines';
    }
    st.lineOrder.forEach(function (id) {
      var b = h('button', { type: 'button', class: 'line-toggle', 'data-id': id, 'aria-label': 'Line ' + st.lines[id].label }, [bullet(st.lines[id], 'md')]);
      b.addEventListener('click', function () {
        var i = draft.routes.indexOf(id);
        if (i >= 0) draft.routes.splice(i, 1); else draft.routes.push(id);
        draft.routes.sort(function (a, c) { return st.lineOrder.indexOf(a) - st.lineOrder.indexOf(c); });
        syncPicker(); changed();
      });
      picker.appendChild(b);
    });
    var fromStations = h('button', {
      type: 'button', class: 'btn small', text: 'Use lines at my stations',
      onclick: function () {
        var set = {};
        draft.stops.forEach(function (s) {
          entryRoutes(s).forEach(function (r) { var id = boardId(r); if (st.lines[id]) set[id] = 1; });
        });
        draft.routes = st.lineOrder.filter(function (id) { return set[id]; });
        syncPicker(); changed();
      }
    });
    var allBtn = h('button', { type: 'button', class: 'btn small ghost', text: 'All lines', onclick: function () { draft.routes = []; syncPicker(); changed(); } });
    body.appendChild(section('Lines', 'Choose the lines for the status board and alerts. With none selected, every line is watched.', [
      st.lineOrder.length ? picker : h('div', { class: 'empty-note', text: 'Line list unavailable until the server responds.' }),
      h('div', { class: 'row-btns' }, [fromStations, allBtn, note])
    ]));
    syncPicker();

    // Display
    body.appendChild(section('Display', null, [
      row('Trains per direction', null, seg([1, 2, 3, 4, 5].map(function (n) { return { v: n, label: String(n) }; }), draft.max,
        function (v) { draft.max = v; changed(); }, 'Trains per direction')),
      row('Show lines with good service', 'Lines without problems appear as a row of bullets under the problem lines.',
        switchCtl(draft.showGood, function (v) { draft.showGood = v; changed(); }, 'Show lines with good service')),
      row('Count planned work as a problem', 'Turn off to keep weekend and overnight work from flagging a line. It is still listed under Planned work.',
        switchCtl(draft.countPlanned, function (v) { draft.countPlanned = v; changed(); }, 'Count planned work as a problem')),
      row('Show the alerts panel', 'When off, tap a line to see its alerts.',
        switchCtl(draft.showAlerts, function (v) { draft.showAlerts = v; changed(); }, 'Show the alerts panel')),
      row('Refresh every', null, seg([{ v: 15, label: '15s' }, { v: 30, label: '30s' }, { v: 60, label: '1 min' }, { v: 120, label: '2 min' }],
        draft.refresh, function (v) { draft.refresh = v; changed(); }, 'Refresh interval')),
      row('Theme', null, seg([{ v: 'dark', label: 'Dark' }, { v: 'light', label: 'Light' }, { v: 'auto', label: 'Match device' }],
        draft.theme, function (v) { draft.theme = v; changed(); }, 'Theme')),
      row('Clock', null, seg([{ v: false, label: '12-hour' }, { v: true, label: '24-hour' }],
        draft.clock24, function (v) { draft.clock24 = v; changed(); }, 'Clock format'))
    ]));

    // Night dimming
    var startIn = h('input', { type: 'time', class: 'input time-input', value: draft.dimStart, 'aria-label': 'Dim from' });
    var endIn = h('input', { type: 'time', class: 'input time-input', value: draft.dimEnd, 'aria-label': 'Dim until' });
    startIn.addEventListener('change', function () { if (isTime(startIn.value)) { draft.dimStart = startIn.value; changed(); } });
    endIn.addEventListener('change', function () { if (isTime(endIn.value)) { draft.dimEnd = endIn.value; changed(); } });
    body.appendChild(section('Night dimming', 'Darkens the screen on a schedule. The dashboard keeps updating underneath.', [
      row('Dim at night', null, switchCtl(draft.dim, function (v) { draft.dim = v; changed(); }, 'Dim at night')),
      row('From / until', null, h('span', { class: 'row-btns' }, [startIn, endIn])),
      row('How dark', null, seg([30, 50, 70, 85].map(function (n) { return { v: n, label: n + '%' }; }), draft.dimLevel,
        function (v) { draft.dimLevel = v; changed(); }, 'Dim level'))
    ]));

    // Kiosk
    linkInput = h('input', { type: 'text', class: 'input', readonly: true, 'aria-label': 'Kiosk link' });
    linkInput.value = kioskLink(draft);
    var copyBtn = h('button', { type: 'button', class: 'btn small', text: 'Copy' });
    copyBtn.addEventListener('click', function () { copyText(linkInput.value, linkInput, copyBtn); });
    var kioskKids = [
      h('div', { class: 'link-box' }, [linkInput, copyBtn]),
      h('div', { class: 'row-btns', style: 'margin-top:12px' }, [
        canFullscreen() ? h('button', { type: 'button', class: 'btn small', text: 'Toggle full screen', onclick: toggleFullscreen }) : null,
        resetButton()
      ]),
      h('div', { class: 'hint', style: 'margin-top:10px', text: wakeLockSupported()
        ? 'Keep screen on: active while this page is open.'
        : 'Keep screen on needs HTTPS, so over a plain LAN address use your tablet\u2019s or kiosk app\u2019s stay-awake setting.' })
    ];
    body.appendChild(section('Kiosk', 'Open this link on another tablet to give it these same settings. A tablet applies a link once, then keeps its own changes.', kioskKids));
  }

  function resetButton() {
    var armed = false, t = null;
    var b = h('button', { type: 'button', class: 'btn small danger', text: 'Reset to server defaults' });
    b.addEventListener('click', function () {
      if (!armed) {
        armed = true; b.textContent = 'Tap again to reset';
        t = setTimeout(function () { armed = false; b.textContent = 'Reset to server defaults'; }, 4000);
        return;
      }
      clearTimeout(t);
      removeKey(STORE_KEY);
      closeSettings();
      applySettings(clone(DEFAULTS));
    });
    return b;
  }

  function copyText(text, input, btn) {
    function ok() { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy'; }, 2000); }
    function fallback() {
      input.focus(); input.select();
      try { if (document.execCommand('copy')) { ok(); return; } } catch (e) { /* unsupported */ }
      btn.textContent = 'Select and copy';
    }
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(ok, fallback);
    else fallback();
  }

  // ---------------------------------------------------------------- boot
  function tick() {
    renderClock(false);
    var s = new Date().getSeconds();
    if (s % 10 === 0 && st.data) { renderArrivals(); renderUpdated(); renderBanner(); }
    if (s === 0) applyDim();
  }

  function boot() {
    st.settings = loadSettings();
    applyTheme();
    applyDim();
    renderClock(true);

    $('btn-settings').addEventListener('click', openSettings);
    $('settings-close').addEventListener('click', closeSettings);
    $('settings-cancel').addEventListener('click', closeSettings);
    $('settings-save').addEventListener('click', saveSettings);
    $('settings').addEventListener('click', function (e) { if (e.target === $('settings')) closeSettings(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('settings').hidden) closeSettings(); });
    $('alerts-clear').addEventListener('click', function () { st.focusLine = null; render(); });

    var fsBtn = $('btn-fullscreen');
    if (canFullscreen()) fsBtn.addEventListener('click', toggleFullscreen);
    else fsBtn.hidden = true;

    requestWakeLock();
    document.addEventListener('pointerdown', requestWakeLock, { passive: true });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') { requestWakeLock(); refresh(); }
    });

    setInterval(tick, 1000);
    setInterval(shiftLayout, 180000);
    // Reload twice a day so a long-running kiosk picks up new versions and sheds leaks.
    setInterval(function () { if (Date.now() - st.lastOk < 300000) window.location.reload(); }, 12 * 3600 * 1000);

    refresh();
    schedule();
  }

  boot();
})();
