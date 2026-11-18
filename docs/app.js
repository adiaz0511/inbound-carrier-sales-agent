/* Project notebook — renders the tabs from the data files in data/. */
(function () {
  'use strict';
  var NB = window.NB || {};
  var ck = NB.checklist || { done: [], groups: [] };
  var sys = NB.system || { diagrams: [], parts: [] };
  var decs = NB.decisions || [];
  var research = NB.research || [];
  var plan = NB.plan || { phases: [], upcoming: [] };
  var scripts = NB.scripts || { intro: '', rules: [], carriers: [], scripts: [] };

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function $(id) { return document.getElementById(id); }

  /* ---------- state ---------- */
  var done = {};
  (ck.done || []).forEach(function (id) { done[id] = true; });
  var total = ck.groups.reduce(function (n, g) { return n + g[1].length; }, 0);
  function doneCount() { return Object.keys(done).filter(function (k) { return done[k]; }).length; }
  var decFilter = 'all';

  /* ---------- routes ---------- */
  var ROUTES = [
    { id: 'checklist', label: 'Checklist', count: function () { return doneCount() + '/' + total; }, render: renderChecklist },
    { id: 'plan', label: 'Build plan', count: function () { var d = plan.phases.filter(function (p) { return p.status === 'done'; }).length; return d + '/' + plan.phases.length; }, render: renderPlan },
    { id: 'scripts', label: 'Scripts', count: function () { return String(scripts.scripts.length); }, render: renderScripts },
    { id: 'system', label: 'System design', count: function () { return ''; }, render: renderSystem },
    { id: 'decisions', label: 'Decisions', count: function () { var o = decs.filter(function (d) { return d.status === 'open'; }).length; return o ? o + ' open' : ''; }, render: renderDecisions },
    { id: 'research', label: 'Research', count: function () { return research.length ? String(research.length) : ''; }, render: renderResearch }
  ];
  function current() {
    var h = (location.hash || '').replace('#', '');
    return ROUTES.filter(function (r) { return r.id === h; })[0] || ROUTES[0];
  }
  function renderNav() {
    var cur = current();
    $('nav').innerHTML = '<div class="nav-group"><div class="nav-group-label">Notebook</div>' +
      ROUTES.map(function (r) {
        return '<a class="nav-item" href="#' + r.id + '"' + (r === cur ? ' aria-current="page"' : '') + '><span>' + esc(r.label) + '</span><span class="nav-count">' + esc(r.count()) + '</span></a>';
      }).join('') + '</div>';
    $('nav-select').innerHTML = ROUTES.map(function (r) {
      return '<option value="' + r.id + '"' + (r === cur ? ' selected' : '') + '>' + esc(r.label) + '</option>';
    }).join('');
  }
  function show() { renderNav(); current().render(); window.scrollTo(0, 0); }
  $('nav-select').addEventListener('change', function (e) { location.hash = e.target.value; });
  window.addEventListener('hashchange', show);

  function badge(status) {
    var tone = { decided: 'success', open: 'warning', superseded: 'neutral' }[status] || 'neutral';
    return '<span class="badge tone-' + tone + '"><span class="dot"></span>' + esc(status) + '</span>';
  }

  /* ---------- checklist ---------- */
  function renderChecklist() {
    var n = doneCount();
    $('main').innerHTML =
      '<h1 class="page-title">Checklist</h1>' +
      '<p class="page-lede">Every requirement and deliverable from the brief and the prep guide, in plain words. An item is ticked only once it works and has been checked.</p>' +
      '<div class="progress"><div class="progress-track"><i style="width:' + (n / total * 100) + '%"></i></div><span class="progress-num">' + n + ' of ' + total + '</span></div>' +
      ck.groups.map(function (g) {
        return '<div class="ck-group"><div class="eyebrow">' + esc(g[0]) + '</div><ul>' + g[1].map(function (it) {
          return '<li><label><input type="checkbox" class="checkbox" id="' + esc(it[0]) + '"' + (done[it[0]] ? ' checked' : '') + '><span>' + esc(it[1]) + '</span></label></li>';
        }).join('') + '</ul></div>';
      }).join('') +
      '<p class="note" id="note"></p>';
    if (!canSave()) $('note').textContent = saveHint;
  }

  function serializeChecklist() {
    var ids = Object.keys(done).filter(function (k) { return done[k]; });
    var order = [];
    ck.groups.forEach(function (g) { g[1].forEach(function (it) { if (ids.indexOf(it[0]) >= 0) order.push(it[0]); }); });
    var lines = ['window.NB = window.NB || {};', 'NB.checklist = {', '  "done": ' + JSON.stringify(order).replace(/,/g, ', ') + ',', '  "groups": ['];
    ck.groups.forEach(function (g, gi) {
      lines.push('    [' + JSON.stringify(g[0]) + ', [');
      g[1].forEach(function (it, ii) { lines.push('      ' + JSON.stringify(it).replace('","', '", "') + (ii < g[1].length - 1 ? ',' : '')); });
      lines.push('    ]]' + (gi < ck.groups.length - 1 ? ',' : ''));
    });
    lines.push('  ]', '};', '');
    return lines.join('\n');
  }

  var artifact = null, readOnly = false, timer = null;
  var saveHint = 'Ticks made here are not saved. Tick in the published notebook, or edit docs/data/checklist.js.';
  function canSave() { return !!artifact && !readOnly; }
  if (window.claude && window.claude.use) {
    window.claude.use('artifact').then(function (a) { artifact = a; var n = $('note'); if (n) n.textContent = a ? '' : saveHint; });
  }
  function note(t) { var n = $('note'); if (n) n.textContent = t; }
  function save() {
    if (!canSave()) return;
    note('Saving…');
    artifact.publish({ 'data/checklist.js': serializeChecklist() }).then(function () { note('Saved.'); }).catch(function (e) {
      var c = e && e.code;
      if (c === 'conflict') return;
      if (['not_writer', 'not_granted', 'consent_required', 'capability_disabled', 'not_declared', 'read_only_path'].indexOf(c) >= 0) { readOnly = true; note('This view is read-only, so ticks are not saved.'); return; }
      note('Could not save just now. Tick again in a moment.');
    });
  }
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (!t || !t.classList || !t.classList.contains('checkbox')) return;
    done[t.id] = t.checked;
    var n = doneCount();
    var bar = document.querySelector('.progress-track i'); if (bar) bar.style.width = (n / total * 100) + '%';
    var num = document.querySelector('.progress-num'); if (num) num.textContent = n + ' of ' + total;
    renderNav();
    if (!canSave()) return;
    note('Saving in a moment…');
    clearTimeout(timer); timer = setTimeout(save, 1500);
  });

  /* ---------- system design ---------- */
  function renderSystem() {
    $('main').innerHTML =
      '<h1 class="page-title">System design</h1>' +
      '<p class="page-lede">' + esc(sys.status) + ' Last updated ' + esc(sys.updated) + '.</p>' +
      sys.diagrams.map(function (d) {
        return '<section class="sec"><h2 class="sec-title">' + esc(d.title) + '</h2><p class="muted" style="margin:0 0 12px">' + linkify(d.caption) + '</p>' +
          '<div class="diagram" id="dg-' + esc(d.id) + '"><pre>' + esc(d.mermaid) + '</pre></div></section>';
      }).join('') +
      '<section class="sec"><h2 class="sec-title">What each part does</h2><dl class="parts">' +
      sys.parts.map(function (p) {
        return '<div class="part"><dt>' + esc(p.name) + '</dt>' + badge(p.status) + '<dd>' + linkify(p.what) +
          (p.ref && p.ref !== 'Brief' ? ' <a href="#decisions" data-dec="' + esc(p.ref) + '">' + esc(p.ref) + '</a>' : ' <span class="eyebrow">Set by the brief</span>') + '</dd></div>';
      }).join('') + '</dl></section>';
    drawDiagrams();
  }

  var mmReady = false;
  function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
  function drawDiagrams() {
    if (!window.mermaid) return; // falls back to the text source
        window.mermaid.initialize({
      startOnLoad: false, securityLevel: 'strict', theme: 'base',
      fontFamily: cssVar('--font-sans'),
      themeVariables: {
        darkMode: false, background: cssVar('--surface'), fontSize: '13px',
        primaryColor: cssVar('--subtle'), primaryTextColor: cssVar('--fg'), primaryBorderColor: cssVar('--line-strong'),
        secondaryColor: cssVar('--subtle'), tertiaryColor: cssVar('--surface'),
        lineColor: cssVar('--fg-subtle'), textColor: cssVar('--fg'),
        edgeLabelBackground: cssVar('--surface'), clusterBkg: cssVar('--subtle')
      },
      flowchart: { curve: 'basis', htmlLabels: true }
    });
    mmReady = true;
    sys.diagrams.forEach(function (d, i) {
      var el = $('dg-' + d.id); if (!el) return;
      window.mermaid.render('mm-' + d.id + '-' + Date.now() + i, d.mermaid).then(function (r) { el.innerHTML = r.svg; }).catch(function () { /* keep text source */ });
    });
  }

  /* ---------- decisions ---------- */
  function renderDecisions() {
    var counts = { all: decs.length, open: 0, decided: 0, superseded: 0 };
    decs.forEach(function (d) { counts[d.status] = (counts[d.status] || 0) + 1; });
    var list = decs.filter(function (d) { return decFilter === 'all' || d.status === decFilter; });
    $('main').innerHTML =
      '<h1 class="page-title">Decisions</h1>' +
      '<p class="page-lede">Every choice that shapes the system: the question, the options we weighed (ranked once decided), why the winner won, and what we accept in exchange. Open ones still need research.</p>' +
      '<div class="filters" role="group" aria-label="Filter by status">' +
      ['all', 'open', 'decided', 'superseded'].filter(function (f) { return f === 'all' || counts[f]; }).map(function (f) {
        return '<button type="button" class="chip" data-filter="' + f + '" aria-pressed="' + (decFilter === f) + '">' + f.charAt(0).toUpperCase() + f.slice(1) + ' · ' + counts[f] + '</button>';
      }).join('') + '</div>' +
      '<div class="sec">' + list.map(renderDecision).join('') + '</div>';
  }
  function renderDecision(d) {
    var ranked = d.options.some(function (o) { return o.rank; });
    var opts = d.options.slice().sort(function (a, b) { return (a.rank || 99) - (b.rank || 99); });
    var table = '<div class="opts-wrap"><table class="opts"><thead><tr><th>' + (ranked ? (d.status === 'open' ? 'Proposed' : 'Rank') : '') + '</th><th>Option</th><th>For</th><th>Against</th></tr></thead><tbody>' +
      opts.map(function (o) {
        var li = function (a) { return a && a.length ? '<ul>' + a.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' : '<span class="muted">—</span>'; };
        return '<tr' + (o.rank === 1 ? ' class="win"' : '') + '><td>' + (o.rank ? o.rank : '·') + '</td><td class="opt-name">' + esc(o.name) + '</td><td>' + li(o.pros) + '</td><td>' + li(o.cons) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
    var kv = '<dl class="kv">' +
      '<dt>Context</dt><dd>' + linkify(d.context) + '</dd>' +
      (d.recommendation ? '<dt>Recommended</dt><dd>' + linkify(d.recommendation) + '</dd>' : '') +
      (d.questions && d.questions.length ? '<dt>To decide</dt><dd><ul class="qs">' + d.questions.map(function (q) { return '<li>' + esc(q) + '</li>'; }).join('') + '</ul></dd>' : '') +
      (d.decision ? '<dt>Decision</dt><dd>' + esc(d.decision) + '</dd>' : '') +
      (d.why ? '<dt>Why</dt><dd>' + esc(d.why) + '</dd>' : '') +
      (d.tradeoffs ? '<dt>Trade-offs</dt><dd>' + esc(d.tradeoffs) + '</dd>' : '') +
      (d.supersededBy ? '<dt>Replaced by</dt><dd>' + esc(d.supersededBy) + '</dd>' : '') +
      '<dt>Date</dt><dd class="mono">' + esc(d.date) + ' · ' + esc(d.area) + '</dd></dl>';
    return '<details class="dec" id="' + esc(d.id) + '"' + (d.status === 'open' ? ' open' : '') + '><summary><span class="dec-id">' + esc(d.id) + '</span><span class="dec-title">' + esc(d.title) + '</span>' + badge(d.status) + '</summary>' +
      '<div class="dec-body"><p class="dec-q">' + esc(d.question) + '</p>' + table + kv + '</div></details>';
  }
  /* ---------- build plan ---------- */
  function renderPlan() {
    var tone = { done: 'success', doing: 'info', todo: 'neutral' }, label = { done: 'done', doing: 'in progress', todo: 'to do' };
    $('main').innerHTML =
      '<h1 class="page-title">Build plan</h1>' +
      '<p class="page-lede">' + esc(plan.rule) + ' Each phase says what we build, why it comes at this point, and how we prove it works.</p>' +
      '<div class="sec">' + plan.phases.map(function (p) {
        return '<article class="res" id="' + esc(p.id) + '"><header class="res-head"><span class="dec-id">' + esc(p.id) + '</span><span class="dec-title">' + esc(p.title) + '</span><span class="badge tone-' + tone[p.status] + '"><span class="dot"></span>' + label[p.status] + '</span></header>' +
          '<dl class="kv"><dt>What</dt><dd>' + esc(p.what) + '</dd><dt>Why now</dt><dd>' + esc(p.why) + '</dd><dt>Done when</dt><dd>' + esc(p.doneWhen) + '</dd>' +
          (p.proof ? '<dt>Proof</dt><dd>' + linkify(p.proof) + '</dd>' : '') +
          (p.decisions && p.decisions.length ? '<dt>Decisions</dt><dd>' + linkify(p.decisions.join(', ')) + '</dd>' : '') + '</dl></article>';
      }).join('') + '</div>' +
      (plan.upcoming.length ? '<section class="sec"><h2 class="sec-title">Decisions still ahead</h2><dl class="kv">' + plan.upcoming.map(function (u) { return '<dt>Before ' + esc(u.before) + '</dt><dd>' + esc(u.topic) + '</dd>'; }).join('') + '</dl></section>' : '');
  }

  /* ---------- scripts ---------- */
  function renderScripts() {
    $('main').innerHTML =
      '<h1 class="page-title">Scripts</h1>' +
      '<p class="page-lede">' + esc(scripts.intro) + '</p>' +
      '<section class="sec"><div class="caution"><div class="eyebrow">Rules</div><ul>' +
      scripts.rules.map(function (r) { return '<li>' + esc(r) + '</li>'; }).join('') +
      '</ul></div></section>' +
      '<section class="sec"><h2 class="sec-title">Test carriers</h2><div class="opts-wrap"><table class="opts"><thead><tr><th>MC</th><th>Carrier</th><th>Use</th></tr></thead><tbody>' +
      scripts.carriers.map(function (c) { return '<tr><td>' + esc(c[0]) + '</td><td class="opt-name">' + esc(c[1]) + '</td><td>' + esc(c[2]) + '</td></tr>'; }).join('') +
      '</tbody></table></div></section>' +
      '<div class="sec">' + scripts.scripts.map(renderScript).join('') + '</div>';
  }
  function renderScript(x) {
    var steps = '<div class="opts-wrap"><table class="opts plain"><thead><tr><th>You say</th><th>Should happen</th></tr></thead><tbody>' +
      x.steps.map(function (st) { return '<tr><td>' + esc(st[0]) + '</td><td>' + esc(st[1]) + '</td></tr>'; }).join('') +
      '</tbody></table></div>';
    return '<article class="res" id="' + esc(x.id) + '"><header class="res-head"><span class="dec-id">' + esc(x.id) + '</span><span class="dec-title">' + esc(x.title) + '</span></header>' +
      '<p class="muted" style="margin:0 0 12px">' + esc(x.purpose) + '</p>' +
      (x.warning ? '<p class="caution">' + esc(x.warning) + '</p>' : '') +
      steps +
      '<dl class="kv" style="margin-top:14px"><dt>Pass if</dt><dd>' + esc(x.pass) + '</dd></dl></article>';
  }

  /* ---------- research ---------- */
  function linkify(s) {
    return esc(s).replace(/\b([DR]-\d{2,3})\b/g, function (m) { return '<a href="#' + (m[0] === 'D' ? 'decisions' : 'research') + '" data-' + (m[0] === 'D' ? 'dec' : 'res') + '="' + m + '">' + m + '</a>'; });
  }
  function renderResearch() {
    $('main').innerHTML =
      '<h1 class="page-title">Research</h1>' +
      '<p class="page-lede">What we found before deciding, and where it came from. \u201cVerified\u201d means I re-read the source myself. \u201cReported\u201d means a research agent found it and it hasn\u2019t been re-read yet.</p>' +
      '<div class="sec">' + research.slice().reverse().map(function (r) {
        var tone = r.checked === 'verified' ? 'success' : 'info';
        return '<article class="res" id="' + esc(r.id) + '"><header class="res-head"><span class="dec-id">' + esc(r.id) + '</span><span class="dec-title">' + esc(r.topic) + '</span><span class="badge tone-' + tone + '"><span class="dot"></span>' + esc(r.checked) + '</span></header>' +
          '<dl class="kv"><dt>Found</dt><dd>' + esc(r.finding) + '</dd><dt>So what</dt><dd>' + linkify(r.meaning) + '</dd>' +
          '<dt>Source</dt><dd class="mono">' + esc(r.source) + '</dd>' +
          (r.affects && r.affects.length ? '<dt>Feeds</dt><dd>' + linkify(r.affects.join(', ')) + '</dd>' : '') +
          '<dt>Date</dt><dd class="mono">' + esc(r.date) + '</dd></dl></article>';
      }).join('') + '</div>';
  }

  document.addEventListener('click', function (e) {
    var f = e.target.closest && e.target.closest('[data-filter]');
    if (f) { decFilter = f.getAttribute('data-filter'); renderDecisions(); return; }
    var link = e.target.closest && e.target.closest('[data-dec],[data-res]');
    if (link) {
      e.preventDefault();
      var isDec = link.hasAttribute('data-dec'), target = link.getAttribute(isDec ? 'data-dec' : 'data-res');
      if (isDec) decFilter = 'all';
      var go = function () { var el = $(target); if (el) { if (isDec) el.open = true; el.scrollIntoView({ block: 'start' }); } };
      var hash = isDec ? 'decisions' : 'research';
      if (location.hash === '#' + hash) { current().render(); go(); } else { location.hash = hash; setTimeout(go, 30); }
    }
  });

  show();
})();
