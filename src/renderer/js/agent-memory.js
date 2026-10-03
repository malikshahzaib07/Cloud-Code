/* =============================================================================
 * Cloud Code — Agent Long-Term Memory (window.agentMemory)
 * -----------------------------------------------------------------------------
 * Durable, global, persistent notes the agent can inject into its system prompt
 * via window.agentMemory.getPromptBlock().
 *
 * Persistence: store name 'agent-memory' -> { version, entries: [...] }
 * Entry: { id, text, tags:[], scope:'global'|'project', createdAt, hits }
 * Degrades to an in-memory store when window.electronAPI is unavailable.
 * ============================================================================= */
(function () {
  'use strict';

  var STORE = 'agent-memory';
  var MAX_ENTRIES = 200;
  var PROMPT_MAX = 1200;
  var SNIPPET = 220;

  // ---------------------------------------------------------------------------
  // Store adapter
  // ---------------------------------------------------------------------------
  var memStore = null;
  function hasStore() {
    try {
      return !!(window.electronAPI && typeof window.electronAPI.storeRead === 'function'
        && typeof window.electronAPI.storeWrite === 'function');
    } catch (e) { return false; }
  }
  function storeRead(name) {
    if (hasStore()) {
      try {
        return Promise.resolve(window.electronAPI.storeRead(name)).catch(function () {
          return memStore ? memStore[name] : null;
        });
      } catch (e) { /* ignore */ }
    }
    return Promise.resolve(memStore ? memStore[name] : null);
  }
  function storeWrite(name, data) {
    memStore = memStore || {};
    memStore[name] = data;
    if (hasStore()) {
      try { return Promise.resolve(window.electronAPI.storeWrite(name, data)).catch(function () { return false; }); }
      catch (e) { return Promise.resolve(false); }
    }
    return Promise.resolve(true);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  var STOP = ('a an the and or but if then else of to in on at for with by from is are was were be been '
    + 'this that these those it its i you he she they we my your our me do does did not no yes so as '
    + 'can could should would will just about into over under out up down please thanks thank').split(' ');

  function tokens(s) {
    return String(s || '').toLowerCase().match(/[a-z0-9_#+.-]{2,}/g) || [];
  }
  function contentTokens(s) {
    return tokens(s).filter(function (t) { return STOP.indexOf(t) === -1; });
  }
  function now() { return Date.now(); }
  function uid() { return 'm_' + now().toString(36) + '_' + Math.random().toString(36).slice(2, 8); }

  function normalize(text) {
    return String(text == null ? '' : text).replace(/\s+/g, ' ').trim().toLowerCase();
  }
  function stripLead(s) {
    return String(s || '').replace(/^\s*(?:please\s+)?(?:remember(?: that)?|note(?: that)?|keep in mind(?: that)?)\s*[:,-]?\s*/i, '');
  }
  function clip(s, n) {
    s = String(s || '').replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n).trim() + '…' : s;
  }
  function relativeTime(ts) {
    var d = now() - (Number(ts) || now());
    if (d < 45e3) return 'just now';
    if (d < 36e5) return Math.round(d / 6e4) + 'm ago';
    if (d < 864e5) return Math.round(d / 36e5) + 'h ago';
    if (d < 6048e5) return Math.round(d / 864e5) + 'd ago';
    return new Date(Number(ts) || now()).toLocaleDateString();
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function safe(sel) { try { return document.querySelector(sel); } catch (e) { return null; } }
  function byId(id) { try { return document.getElementById(id); } catch (e) { return null; } }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  var state = { entries: [], loaded: false, overlay: null, saveTimer: null };
  var LEGACY = null; // raw persisted shape before load()

  function save() {
    state.saveTimer = null;
    return storeWrite(STORE, { version: 1, entries: state.entries });
  }
  function scheduleSave() {
    if (state.saveTimer) return;
    state.saveTimer = setTimeout(save, 300);
  }
  function load() {
    if (state.loaded) return Promise.resolve(state.entries);
    return storeRead(STORE).then(function (data) {
      var raw = (data && data.entries) || (Array.isArray(data) ? data : null);
      if (raw) {
        LEGACY = raw;
        state.entries = raw.filter(function (e) { return e && typeof e.text === 'string' && e.text.trim(); })
          .map(function (e) {
            return {
              id: e.id || uid(),
              text: String(e.text).trim(),
              tags: Array.isArray(e.tags) ? e.tags.slice(0, 12) : [],
              scope: e.scope === 'project' ? 'project' : 'global',
              createdAt: Number(e.createdAt) || now(),
              hits: Number(e.hits) || 0
            };
          });
      } else {
        state.entries = [];
      }
      if (!LEGACY) state.entries = migrateLegacy(state.entries);
      state.loaded = true;
      return state.entries;
    }).catch(function () {
      state.entries = state.entries || [];
      state.loaded = true;
      return state.entries;
    });
  }

  function ensureLoaded() { return load(); }

  // ---------------------------------------------------------------------------
  // Scoring
  // ---------------------------------------------------------------------------
  function score(entry, queryTokens, rawQuery) {
    if (!queryTokens.length) return 0;
    var text = normalize(entry.text + ' ' + (entry.tags || []).join(' '));
    var eTokens = contentTokens(entry.text + ' ' + (entry.tags || []).join(' '));
    var score = 0;
    queryTokens.forEach(function (qt) {
      if (text.indexOf(qt) !== -1) score += 2;
      eTokens.forEach(function (et) {
        if (et === qt) score += 3;
        else if (et.indexOf(qt) !== -1 || qt.indexOf(et) !== -1) score += 1;
      });
    });
    // regex-ish: exact phrase present
    if (rawQuery && rawQuery.length > 2 && text.indexOf(rawQuery) !== -1) score += 6;
    return score;
  }

  function snippet(text, queryTokens, rawQuery) {
    var t = String(text || '');
    var lower = t.toLowerCase();
    var at = -1;
    if (rawQuery) at = lower.indexOf(rawQuery);
    if (at < 0 && queryTokens.length) {
      queryTokens.forEach(function (qt) {
        var i = lower.indexOf(qt);
        if (i >= 0 && (at < 0 || i < at)) at = i;
      });
    }
    if (at < 0) return clip(t, SNIPPET);
    var start = Math.max(0, at - 60);
    return (start > 0 ? '…' : '') + clip(t.slice(start), SNIPPET);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  function all() {
    return ensureLoaded().then(function () {
      return state.entries.slice().sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); })
        .map(function (e) { return JSON.parse(JSON.stringify(e)); });
    });
  }

  function count() {
    return ensureLoaded().then(function () { return state.entries.length; });
  }

  function dedupe(text) {
    var n = normalize(text);
    return state.entries.find(function (e) {
      var en = normalize(e.text);
      if (en === n) return true;
      // token-set identity (punctuation-insensitive: "2-space" === "2 space")
      var a = en.replace(/[^\w\s]+/g, ' ').split(/\s+/).sort().join(' ');
      var b = n.replace(/[^\w\s]+/g, ' ').split(/\s+/).sort().join(' ');
      if (a === b) return true;
      // high overlap (jaccard > 0.85)
      var setA = {}, setB = {};
      contentTokens(en).forEach(function (t) { setA[t] = 1; });
      contentTokens(n).forEach(function (t) { setB[t] = 1; });
      var ka = Object.keys(setA), kb = Object.keys(setB);
      if (!ka.length || !kb.length) return false;
      var inter = ka.filter(function (k) { return setB[k]; }).length;
      var uni = ka.length + kb.length - inter;
      return uni > 0 && inter / uni >= 0.85;
    }) || null;
  }

  function autoTags(text) {
    var t = [];
    if (/\b(indent|indentation|spaces|tabs|style|format)\b/i.test(text)) t.push('style');
    if (/\b(editor|monaco|vscode|theme|font|keybind)/i.test(text)) t.push('editor');
    if (/\b(shell|powershell|bash|cmd|terminal|npm|node|python)/i.test(text)) t.push('tooling');
    if (/\b(framework|react|vue|angular|express|django|rails|electron)/i.test(text)) t.push('stack');
    if (/\b(name|my name is|i'm called|call me)/i.test(text)) t.push('identity');
    if (/\b(prefer|favou?rite|like|dislike|avoid)\b/i.test(text)) t.push('preference');
    return t.slice(0, 5);
  }

  function remember(text, opts) {
    var o = opts || {};
    var raw = stripLead(String(text == null ? '' : text)).trim();
    if (!raw) return Promise.resolve(null);
    return ensureLoaded().then(function () {
      var dup = dedupe(raw);
      if (dup) {
        dup.hits = (dup.hits || 0) + 1;
        dup.updatedAt = now();
        return save().then(function () { return clone(dup); });
      }
      var entry = {
        id: uid(),
        text: clip(raw, 600),
        tags: Array.isArray(o.tags) && o.tags.length ? o.tags.slice(0, 12) : autoTags(raw),
        scope: o.scope === 'project' ? 'project' : 'global',
        createdAt: now(),
        updatedAt: now(),
        hits: 0
      };
      state.entries.push(entry);
      if (state.entries.length > MAX_ENTRIES) {
        state.entries.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
        state.entries = state.entries.slice(state.entries.length - MAX_ENTRIES);
      }
      return save().then(function () { return clone(entry); });
    }).catch(function () { return null; });
  }

  function recall(query, limit) {
    var lim = Number(limit) > 0 ? Number(limit) : 8;
    var rawQuery = normalize(query);
    return ensureLoaded().then(function () {
      if (!rawQuery) {
        return state.entries.slice()
          .sort(function (a, b) { return (b.hits || 0) - (a.hits || 0) || (b.createdAt || 0) - (a.createdAt || 0); })
          .slice(0, lim)
          .map(function (e) { return { entry: clone(e), score: 1, snippet: snippet(e.text, [], rawQuery) }; });
      }
      var qt = contentTokens(rawQuery);
      var scored = state.entries.map(function (e) {
        return { entry: e, score: score(e, qt, rawQuery), snippet: snippet(e.text, qt, rawQuery) };
      }).filter(function (r) { return r.score > 0; });
      scored.sort(function (a, b) {
        return b.score - a.score || (b.entry.createdAt || 0) - (a.entry.createdAt || 0);
      });
      var top = scored.slice(0, lim);
      top.forEach(function (r) { r.entry.hits = (r.entry.hits || 0) + 1; });
      if (top.length) scheduleSave();
      return top.map(function (r) {
        return { entry: clone(r.entry), score: r.score, snippet: r.snippet };
      });
    }).catch(function () { return []; });
  }

  function forget(id) {
    return ensureLoaded().then(function () {
      var before = state.entries.length;
      state.entries = state.entries.filter(function (e) { return e.id !== id; });
      return save().then(function () { return before - state.entries.length; });
    }).catch(function () { return 0; });
  }

  function clear() {
    return ensureLoaded().then(function () {
      state.entries = [];
      return save().then(function () { return true; });
    }).catch(function () { return false; });
  }

  function getPromptBlock() {
    try {
      if (!state.loaded) {
        // best-effort synchronous answer from whatever is cached
        if (!state.entries.length) return '';
      }
      if (!state.entries.length) return '';
      var ranked = state.entries.slice().sort(function (a, b) {
        var sa = (a.hits || 0) * 2 + recency(a.createdAt);
        var sb = (b.hits || 0) * 2 + recency(b.createdAt);
        return sb - sa;
      }).slice(0, 12);
      var header = '## LONG-TERM MEMORY (user-stated facts and preferences)';
      var out = [header];
      var used = header.length;
      for (var i = 0; i < ranked.length; i++) {
        var line = '- ' + clip(ranked[i].text, 160);
        if (used + line.length + 1 > PROMPT_MAX) break;
        out.push(line);
        used += line.length + 1;
      }
      if (out.length === 1) return '';
      return out.join('\n');
    } catch (e) { return ''; }
  }
  function recency(ts) {
    var ageDays = (now() - (Number(ts) || now())) / 864e5;
    return ageDays < 30 ? (30 - ageDays) / 30 : 0;
  }

  // ---------------------------------------------------------------------------
  // Auto-capture of durable statements
  // ---------------------------------------------------------------------------
  var TRIGGERS = [
    /\b(?:please\s+)?remember(?:\s+that)?\b/i,
    /\balways\b/i,
    /\bnever\b/i,
    /\bfrom now on\b/i,
    /\bmy name is\b/i,
    /\bcall me\b/i,
    /\bi(?:'m| am)\s+called\b/i,
    /\bi prefer\b/i,
    /\bi like\b/i,
    /\bi (?:really )?(?:dislike|hate)\b/i,
    /\bi(?:'m| am) working (?:on|with|using)\b/i,
    /\bkeep in mind\b/i,
    /\bdon'?t (?:ever )?(?:use|add|do)\b/i,
    /\bmake sure (?:to|you)\b/i,
    /\bwe use\b/i,
    /\bmy (?:workflow|style|setup|team) (?:is|uses)\b/i
  ];

  function suggest(text) {
    try {
      var raw = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
      if (!raw) return null;
      var sentence = pickSentence(raw);
      if (!sentence) return null;
      var hit = TRIGGERS.some(function (re) { return re.test(sentence); });
      if (!hit) return null;
      var body = stripLead(sentence)
        .replace(/[.!?]+$/, '')
        .trim();
      if (body.length < 4) return null;
      return {
        text: clip(body, 600),
        tags: autoTags(body),
        scope: 'global',
        trigger: 'auto'
      };
    } catch (e) { return null; }
  }

  function pickSentence(raw) {
    var lines = raw.split('\n').map(function (l) { return l.trim(); })
      .filter(function (l) { return l && !/^```/.test(l); });
    for (var i = 0; i < lines.length; i++) {
      if (TRIGGERS.some(function (re) { return re.test(lines[i]); })) {
        var joined = [lines[i]];
        // also pull the next line if it continues the thought
        if (i + 1 < lines.length && lines[i + 1].length < 120 && !TRIGGERS.test(lines[i + 1])
          && !/^\s*[-*]\s/.test(lines[i + 1])) joined.push(lines[i + 1]);
        return joined.join(' ').trim();
      }
    }
    return null;
  }

  var lastAutoKey = '';
  function autoCapture(text) {
    try {
      var cand = suggest(text);
      if (!cand) return Promise.resolve(null);
      var key = normalize(cand.text);
      if (key && key === lastAutoKey) return Promise.resolve(null);
      return ensureLoaded().then(function () {
        if (dedupe(cand.text)) { lastAutoKey = key; return null; }
        lastAutoKey = key;
        return remember(cand.text, { tags: cand.tags, scope: cand.scope });
      });
    } catch (e) { return Promise.resolve(null); }
  }

  // ---------------------------------------------------------------------------
  // Migration: pick up a few memories that already live in a local storage bag
  // ---------------------------------------------------------------------------
  function migrateLegacy(existing) {
    try {
      if (existing.length) return existing;
      var bags = [window.agentMemory && window.agentMemory.legacy, window.appMemory, null];
      for (var b = 0; b < bags.length; b++) {
        var src = bags[b] || (function () {
          try { return JSON.parse(window.localStorage.getItem('cloudcode.memory') || 'null'); } catch (e) { return null; }
        })();
        if (src && Array.isArray(src.entries)) return src.entries;
      }
    } catch (e) { /* ignore */ }
    return existing;
  }

  function clone(e) {
    return { id: e.id, text: e.text, tags: (e.tags || []).slice(), scope: e.scope, createdAt: e.createdAt, updatedAt: e.updatedAt, hits: e.hits || 0 };
  }

  // ---------------------------------------------------------------------------
  // Memory UI
  // ---------------------------------------------------------------------------
  function actionsHost() { return safe('#ai-chat-view .sidebar-header .actions'); }

  function injectButton() {
    var host = actionsHost();
    if (!host) return null;
    if (host.querySelector ? host.querySelector('.mem-btn-open') : null) return null;
    var b = el('button', 'icon-btn mem-btn-open', '🧠');
    b.type = 'button';
    b.title = 'Long-term memory';
    b.setAttribute('aria-label', 'Long-term memory');
    b.addEventListener('click', function (e) {
      e.preventDefault();
      try { openOverlay(); } catch (err) { if (window.console) console.error('[agentMemory] overlay failed', err); }
    });
    host.appendChild(b);
    return b;
  }

  function closeOverlay() {
    if (state.overlay && state.overlay.parentNode) state.overlay.parentNode.removeChild(state.overlay);
    state.overlay = null;
  }

  function confirmUI(msg) {
    try { return window.confirm(msg); } catch (e) { return true; }
  }

  function openOverlay() {
    closeOverlay();
    var wrap = el('div', 'mem-overlay');
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    var card = el('div', 'mem-card');

    var head = el('div', 'mem-card-head');
    head.appendChild(el('span', 'mem-card-title', 'Long-term memory'));
    var x = el('button', 'icon-btn mem-close', '✕');
    x.type = 'button';
    x.title = 'Close';
    x.addEventListener('click', closeOverlay);
    head.appendChild(x);
    card.appendChild(head);
    wrap.appendChild(card);

    var add = el('div', 'mem-add');
    var ta = el('textarea', 'mem-textarea');
    ta.rows = 2;
    ta.placeholder = 'e.g. Prefers 2-space indentation.';
    ta.setAttribute('aria-label', 'New memory');
    var addRow = el('div', 'mem-add-row');
    var addBtn = el('button', 'mem-btn mem-btn-primary', 'Remember');
    addBtn.type = 'button';
    var scopeSel = el('select', 'mem-select');
    [['global', 'Global'], ['project', 'Project']].forEach(function (p) {
      var o = el('option', null, p[1]);
      o.value = p[0];
      scopeSel.appendChild(o);
    });
    scopeSel.setAttribute('aria-label', 'Scope');
    addRow.appendChild(addBtn);
    addRow.appendChild(scopeSel);
    add.appendChild(ta);
    add.appendChild(addRow);
    card.appendChild(add);

    addBtn.addEventListener('click', function () {
      var v = ta.value.trim();
      if (!v) return;
      remember(v, { scope: scopeSel.value }).then(function (r) {
        ta.value = '';
        if (r) render([], 0);
      });
    });
    ta.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); addBtn.click(); }
    });

    var tools = el('div', 'mem-toolbar');
    var search = el('input', 'mem-input mem-search');
    search.type = 'search';
    search.placeholder = 'Search memory…';
    search.setAttribute('aria-label', 'Search memory');
    tools.appendChild(search);
    var clearBtn = el('button', 'mem-btn mem-btn-danger', 'Clear all');
    clearBtn.type = 'button';
    clearBtn.addEventListener('click', function () {
      if (!state.entries.length) return;
      if (confirmUI('Delete all ' + state.entries.length + ' long-term memories? This cannot be undone.')) {
        clear().then(function () { render([], 0); });
      }
    });
    tools.appendChild(clearBtn);
    card.appendChild(tools);

    var list = el('div', 'mem-list');
    list.setAttribute('tabindex', '0');
    card.appendChild(list);

    function render(rows, focusIdx) {
      var host = rows;
      if (!host || !host.length) { host = state.entries.slice(); }
      list.innerHTML = '';
      if (!host.length) {
        list.appendChild(el('div', 'mem-empty', 'No memories yet. Statements like "always use tabs" or "remember that I prefer 2 spaces" are saved automatically.'));
        return;
      }
      host.sort(function (a, b) { return (b.hits || 0) - (a.hits || 0) || (b.createdAt || 0) - (a.createdAt || 0); });
      host.forEach(function (e, i) {
        var row = el('div', 'mem-row');
        row.setAttribute('data-id', e.id);
        var txt = el('div', 'mem-text', e.text);
        row.appendChild(txt);
        var meta = el('div', 'mem-meta');
        meta.textContent = relativeTime(e.createdAt) + ' · ' + (e.hits || 0) + ' hits · ' + (e.scope || 'global')
          + ((e.tags && e.tags.length) ? ' · ' + e.tags.join(', ') : '');
        row.appendChild(meta);
        var del = el('button', 'icon-btn mem-del', '🗑');
        del.type = 'button';
        del.title = 'Forget';
        del.setAttribute('aria-label', 'Forget memory');
        del.addEventListener('click', function () {
          forget(e.id).then(function () { render([], 0); });
        });
        row.appendChild(del);
        if (i === focusIdx) row.classList.add('mem-row-focus');
        list.appendChild(row);
      });
    }

    var timer = null;
    search.addEventListener('input', function () {
      var q = search.value;
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        if (!q.trim()) { render([], -1); return; }
        recall(q, 50).then(function (rows) {
          list.innerHTML = '';
          if (!rows.length) { list.appendChild(el('div', 'mem-empty', 'No matches.')); return; }
          rows.forEach(function (r) {
            var e = r.entry;
            var row = el('div', 'mem-row');
            row.setAttribute('data-id', e.id);
            var txt = el('div', 'mem-text');
            txt.appendChild(el('span', 'mem-snip', r.snippet));
            row.appendChild(txt);
            var meta = el('div', 'mem-meta');
            meta.textContent = relativeTime(e.createdAt) + ' · score ' + r.score;
            row.appendChild(meta);
            var del = el('button', 'icon-btn mem-del', '🗑');
            del.type = 'button';
            del.title = 'Forget';
            del.addEventListener('click', function () { forget(e.id).then(function () { render([], 0); }); });
            row.appendChild(del);
            list.appendChild(row);
          });
        });
      }, 180);
    });

    list.addEventListener('keydown', function (e) {
      var rows = Array.prototype.slice.call(list.querySelectorAll('.mem-row'));
      if (!rows.length) return;
      var cur = -1;
      rows.forEach(function (r, i) { if (r.classList.contains('mem-row-focus')) cur = i; });
      if (e.key === 'ArrowDown') { e.preventDefault(); focusRow(rows, cur + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); focusRow(rows, cur - 1); }
      else if (e.key === 'Escape') { e.preventDefault(); closeOverlay(); }
    });

    function focusRow(rows, idx) {
      if (idx < 0) idx = rows.length - 1;
      if (idx >= rows.length) idx = 0;
      rows.forEach(function (r) { r.classList.remove('mem-row-focus'); });
      rows[idx].classList.add('mem-row-focus');
      try { rows[idx].focus(); } catch (err) { /* ignore */ }
    }

    wrap.addEventListener('mousedown', function (e) { if (e.target === wrap) closeOverlay(); });
    wrap.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.preventDefault(); closeOverlay(); } });
    document.body.appendChild(wrap);
    state.overlay = wrap;

    ensureLoaded().then(function () { render([], 0); });
    try { ta.focus(); } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------------------
  // Hook into chat capture (works with or without sessions.js)
  // ---------------------------------------------------------------------------
  function hookChat() {
    var api = {
      all: all,
      remember: remember,
      recall: recall,
      forget: forget,
      clear: clear,
      count: count,
      getPromptBlock: getPromptBlock,
      suggest: suggest,
      autoCapture: autoCapture,
      autoCaptureAfterUserMessage: autoCapture,
      closeOverlay: closeOverlay,
      _state: state,
      _ensureLoaded: ensureLoaded
    };
    try { window.agentMemory = api; } catch (e) { /* ignore */ }
    return api;
  }

  function autoWire() {
    // 1) if sessions.js exposes recordMessage, wrap it so every captured user
    //    message also feeds memory auto-capture.
    setTimeout(function () {
      var s = window.sessions;
      if (s && typeof s.recordMessage === 'function' && !s.__memWrapped) {
        var orig = s.recordMessage;
        s.recordMessage = function (role, text) {
          var r = orig.apply(s, arguments);
          if (role === 'user') { try { autoCapture(text); } catch (e) { /* ignore */ } }
          return r;
        };
        s.__memWrapped = true;
      }
      // 2) also wrap the chat controller's user-message append as a fallback
      var ai = window.ai;
      if (ai && typeof ai.appendUserMessage === 'function' && !ai.__memWrapped) {
        var o2 = ai.appendUserMessage;
        ai.appendUserMessage = function (text) {
          var res = o2.apply(ai, arguments);
          try { autoCapture(text); } catch (e) { /* ignore */ }
          return res;
        };
        ai.__memWrapped = true;
      }
    }, 400);
  }

  function init() {
    var api = hookChat();
    if (typeof document !== 'undefined') {
      injectButton();
      ensureLoaded();
    }
    autoWire();
    try { window.addEventListener('beforeunload', function () { if (state.saveTimer) { clearTimeout(state.saveTimer); save(); } }); }
    catch (e) { /* ignore */ }
    return api;
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { init: init };
  if (typeof window !== 'undefined') init();
})();
