/* =============================================================================
 * Cloud Code — Chat Sessions (window.sessions)
 * -----------------------------------------------------------------------------
 * Every chat is a session.  Messages are captured passively with a
 * MutationObserver on #chat-messages so ai-assistant.js never has to change.
 *
 * Persistence
 *   store 'sessions'      -> { version, currentId, sessions: [summary…] }
 *   store 'session_<id>'  -> full record { id, title, createdAt, updatedAt,
 *                                        messages:[{role,text,at}], meta }
 * When window.electronAPI.storeRead/storeWrite are unavailable everything
 * degrades to an in-memory map instead of throwing.
 * ============================================================================= */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Store adapter (safe fallbacks)
  // ---------------------------------------------------------------------------
  var memStore = Object.create(null);
  var hasStore = function () {
    try {
      return !!(window.electronAPI && typeof window.electronAPI.storeRead === 'function'
        && typeof window.electronAPI.storeWrite === 'function');
    } catch (e) { return false; }
  };

  function storeRead(name) {
    if (hasStore()) {
      try {
        return Promise.resolve(window.electronAPI.storeRead(name)).catch(function () {
          return memStore[name] === undefined ? null : memStore[name];
        });
      } catch (e) { /* fall through */ }
    }
    return Promise.resolve(memStore[name] === undefined ? null : memStore[name]);
  }

  function storeWrite(name, data) {
    memStore[name] = data;
    if (hasStore()) {
      try {
        return Promise.resolve(window.electronAPI.storeWrite(name, data)).catch(function () { return false; });
      } catch (e) { return Promise.resolve(false); }
    }
    return Promise.resolve(true);
  }

  // ---------------------------------------------------------------------------
  // Constants / helpers
  // ---------------------------------------------------------------------------
  var INDEX_KEY = 'sessions';
  var TITLE_MAX = 60;
  var NEW_TITLE = 'New chat';

  function now() { return Date.now(); }
  function uid(prefix) {
    return (prefix || 's') + '_' + now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }
  function clone(v) {
    if (v === null || typeof v !== 'object') return v;
    return JSON.parse(JSON.stringify(v));
  }

  function stripMarkdown(s) {
    return String(s || '')
      .replace(/```[\s\S]*?```/g, ' code ')
      .replace(/~~~[\s\S]*?~~~/g, ' code ')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^\s{0,3}#{1,6}\s*/gm, '')
      .replace(/^\s{0,3}>\s?/gm, '')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/^\s*\d+\.\s+/gm, '')
      .replace(/^\s*#{1,6}\s*$/gm, '')
      .replace(/[*_~]{1,3}/g, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function deriveTitle(text) {
    var t = stripMarkdown(text);
    if (!t) return '';
    if (t.length > TITLE_MAX) {
      t = t.slice(0, TITLE_MAX);
      var cut = t.lastIndexOf(' ');
      if (cut > 20) t = t.slice(0, cut);
      t = t.trim() + '…';
    }
    return t;
  }

  function relativeTime(ts) {
    var d = now() - (Number(ts) || now());
    if (d < 45e3) return 'just now';
    if (d < 36e5) return Math.round(d / 6e4) + 'm ago';
    if (d < 864e5) return Math.round(d / 36e5) + 'h ago';
    if (d < 6048e5) return Math.round(d / 864e5) + 'd ago';
    return new Date(Number(ts) || now()).toLocaleDateString();
  }

  // ---------------------------------------------------------------------------
  // DOM helpers (all defensive)
  // ---------------------------------------------------------------------------
  function safe(sel) {
    try { return document.querySelector(sel); } catch (e) { return null; }
  }
  function byId(id) {
    try { return document.getElementById(id); } catch (e) { return null; }
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function isFn(o, n) { return !!(o && typeof o[n] === 'function'); }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  var state = {
    loaded: false,
    index: { version: 1, currentId: null, sessions: [] },
    cache: Object.create(null),     // id -> full session record
    saveTimer: null,
    domTimer: null,
    observer: null,
    rendering: false,
    overlay: null,
    openOverlay: null
  };

  function summaryOf(rec) {
    return {
      id: rec.id,
      title: rec.title,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      messageCount: (rec.messages || []).length,
      meta: rec.meta || {}
    };
  }

  function saveIndex() { return storeWrite(INDEX_KEY, state.index); }

  function loadIndex() {
    return storeRead(INDEX_KEY).then(function (data) {
      if (data && Array.isArray(data.sessions)) {
        state.index = {
          version: data.version || 1,
          currentId: data.currentId || null,
          sessions: data.sessions.filter(function (s) { return s && s.id; })
        };
      }
      state.loaded = true;
      return state.index;
    }).catch(function () { state.loaded = true; return state.index; });
  }

  function summary(id) {
    for (var i = 0; i < state.index.sessions.length; i++) {
      if (state.index.sessions[i].id === id) return state.index.sessions[i];
    }
    return null;
  }

  function upsertSummary(rec) {
    var s = summaryOf(rec);
    var existing = summary(rec.id);
    if (existing) {
      Object.keys(s).forEach(function (k) { existing[k] = s[k]; });
      existing.updatedAt = rec.updatedAt;
    } else {
      state.index.sessions.push(s);
    }
    return s;
  }

  function loadSession(id) {
    if (state.cache[id]) return Promise.resolve(state.cache[id]);
    return storeRead('session_' + id).then(function (data) {
      if (!data || !Array.isArray(data.messages)) {
        var s = summary(id);
        data = {
          id: id,
          title: (s && s.title) || NEW_TITLE,
          createdAt: (s && s.createdAt) || now(),
          updatedAt: (s && s.updatedAt) || now(),
          messages: [],
          meta: (s && s.meta) || {}
        };
      }
      data.messages = data.messages.filter(function (m) { return m && typeof m.text === 'string'; });
      state.cache[id] = data;
      return data;
    }).catch(function () {
      return { id: id, title: NEW_TITLE, createdAt: now(), updatedAt: now(), messages: [], meta: {} };
    });
  }

  function persistSession(rec) {
    state.cache[rec.id] = rec;
    return storeWrite('session_' + rec.id, rec);
  }

  function ensureLoaded() {
    if (state.loaded) return Promise.resolve(state.index);
    return loadIndex();
  }

  function currentId() { return state.index.currentId; }

  function newRecord(title) {
    var t = now();
    return {
      id: uid(),
      title: title || NEW_TITLE,
      createdAt: t,
      updatedAt: t,
      messages: [],
      meta: { workspace: currentWorkspace(), model: currentModel() }
    };
  }

  function currentWorkspace() {
    try {
      if (window.AppSettings && typeof window.AppSettings.get === 'function') {
        var w = window.AppSettings.get('workspace');
        if (w) return String(w);
      }
    } catch (e) { /* ignore */ }
    try { return document.title || ''; } catch (e2) { return ''; }
  }
  function currentModel() {
    try {
      var sel = document.getElementById('model-select');
      if (sel && sel.value) return sel.value;
    } catch (e) { /* ignore */ }
    try {
      if (window.AppSettings && typeof window.AppSettings.get === 'function') {
        return window.AppSettings.get('model') || '';
      }
    } catch (e2) { /* ignore */ }
    return '';
  }

  // ---------------------------------------------------------------------------
  // Persistence debounce
  // ---------------------------------------------------------------------------
  function scheduleSave() {
    if (state.saveTimer) return;
    state.saveTimer = setTimeout(function () {
      state.saveTimer = null;
      var id = currentId();
      if (id && state.cache[id]) {
        state.cache[id].updatedAt = now();
        upsertSummary(state.cache[id]);
        persistSession(state.cache[id]);
        saveIndex();
      }
    }, 400);
  }

  function flushSave() {
    if (state.saveTimer) { clearTimeout(state.saveTimer); state.saveTimer = null; }
    var id = currentId();
    if (id && state.cache[id]) {
      state.cache[id].updatedAt = now();
      upsertSummary(state.cache[id]);
      return Promise.all([persistSession(state.cache[id]), saveIndex()]);
    }
    return saveIndex();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  function list() {
    return ensureLoaded().then(function () {
      return state.index.sessions.slice().sort(function (a, b) {
        return (b.updatedAt || 0) - (a.updatedAt || 0);
      }).map(clone);
    });
  }

  function current() {
    return ensureLoaded().then(function () {
      var id = currentId();
      if (!id) return create();
      return loadSession(id);
    });
  }

  function create(forceNew) {
    return ensureLoaded().then(function () {
      var id = currentId();
      if (!forceNew && id) {
        return loadSession(id).then(function (rec) {
          // reuse the active session while it is still empty
          if (!rec.messages.length) return rec;
          return makeSession(rec);
        });
      }
      if (!forceNew && !id) return makeSession(newRecord());
      // forceNew: only make a new one when the current one has content
      if (id) {
        return loadSession(id).then(function (rec) {
          if (!rec.messages.length) return rec;
          return makeSession(newRecord());
        });
      }
      return makeSession(newRecord());
    });
  }

  function makeSession(rec) {
    state.index.currentId = rec.id;
    state.cache[rec.id] = rec;
    upsertSummary(rec);
    return persistSession(rec).then(function () { return saveIndex(); }).then(function () {
      renderMessages(rec);
      return rec;
    });
  }

  function open(id) {
    return ensureLoaded().then(function () {
      return loadSession(id);
    }).then(function (rec) {
      state.index.currentId = id;
      upsertSummary(rec);
      return saveIndex().then(function () {
        renderMessages(rec);
        return rec;
      });
    });
  }

  function rename(id, title) {
    return ensureLoaded().then(function () {
      return loadSession(id);
    }).then(function (rec) {
      var t = stripMarkdown(title || '').slice(0, 120) || NEW_TITLE;
      rec.title = t;
      rec.updatedAt = now();
      upsertSummary(rec);
      return persistSession(rec).then(function () { return saveIndex(); })
        .then(function () { return rec; });
    });
  }

  function renameCurrent(title) { return ensureLoaded().then(function () { return rename(currentId(), title); }); }

  function remove(id) {
    return ensureLoaded().then(function () {
      state.index.sessions = state.index.sessions.filter(function (s) { return s.id !== id; });
      delete state.cache[id];
      if (currentId() === id) state.index.currentId = null;
      return storeWrite('session_' + id, null).then(function () { return saveIndex(); })
        .then(function () {
          if (!currentId()) return create(true);
          return true;
        });
    });
  }

  function clearCurrent() {
    return ensureLoaded().then(function () {
      var id = currentId();
      if (!id) return create(true);
      return loadSession(id).then(function (rec) {
        rec.messages = [];
        rec.updatedAt = now();
        upsertSummary(rec);
        return persistSession(rec).then(function () { return saveIndex(); })
          .then(function () { renderMessages(rec); return rec; });
      });
    });
  }

  function search(q) {
    return ensureLoaded().then(function () {
      var query = String(q || '').trim().toLowerCase();
      if (!query) {
        return state.index.sessions.slice().sort(function (a, b) {
          return (b.updatedAt || 0) - (a.updatedAt || 0);
        }).map(clone);
      }
      var ids = state.index.sessions.filter(function (s) {
        return String(s.title || '').toLowerCase().indexOf(query) !== -1;
      }).map(function (s) { return s.id; });
      var rest = state.index.sessions.filter(function (s) { return ids.indexOf(s.id) === -1; });
      return Promise.all(rest.map(function (s) {
        return loadSession(s.id).then(function (rec) {
          var hit = (rec.messages || []).some(function (m) {
            return String(m.text || '').toLowerCase().indexOf(query) !== -1;
          });
          if (hit) ids.push(s.id);
        });
      })).then(function () {
        return state.index.sessions
          .filter(function (s) { return ids.indexOf(s.id) !== -1; })
          .sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); })
          .map(clone);
      });
    });
  }

  // --- recording -------------------------------------------------------------
  function recordMessage(role, text) {
    var t = String(text == null ? '' : text).trim();
    if (!t) return Promise.resolve(null);
    var r = (role === 'user' || role === 'assistant') ? role : 'assistant';
    return ensureLoaded().then(function () {
      var id = currentId();
      if (!id) return create(true).then(function (rec) { return push(rec, r, t); });
      return loadSession(id).then(function (rec) { return push(rec, r, t); });
    });
  }

  function push(rec, role, text) {
    var last = rec.messages[rec.messages.length - 1];
    if (last && last.role === role && last.text === text) return rec; // de-dupe
    rec.messages.push({ role: role, text: text, at: now() });
    rec.updatedAt = now();
    if (rec.title === NEW_TITLE && role === 'user') {
      var t = deriveTitle(text);
      if (t) rec.title = t;
    }
    upsertSummary(rec);
    scheduleSave();
    return rec;
  }

  // ---------------------------------------------------------------------------
  // Rendering (uses the app's own path when available)
  // ---------------------------------------------------------------------------
  function renderMessages(rec) {
    var container = byId('chat-messages');
    if (!container) return;
    var ai = window.ai;
    state.rendering = true;
    try {
      container.innerHTML = '';
      (rec.messages || []).forEach(function (m) {
        renderOne(container, m, ai);
      });
      scrollBottom(container);
    } catch (e) {
      /* never throw from rendering */
    } finally {
      state.rendering = false;
    }
    markSeen();
  }

  function renderOne(container, m, ai) {
    if (m.role === 'user' && isFn(ai, 'appendUserMessage')) {
      try {
        ai.appendUserMessage(m.text, '');
        var added = container.lastElementChild || container.lastChild;
        if (added && typeof added.setAttribute === 'function') added.setAttribute('data-sess-id', m.id || '');
        return;
      } catch (e) { /* fall back */ }
    }
    if (m.role === 'assistant') {
      var node = null;
      if (isFn(ai, 'createAssistantMessageNode')) {
        try { node = ai.createAssistantMessageNode(m.text); } catch (e) { node = null; }
      }
      if (node) {
        var body = node.querySelector ? node.querySelector('.msg-body') : null;
        if (body) {
          if (isFn(ai, 'renderMarkdown')) {
            try { body.innerHTML = ai.renderMarkdown(m.text); }
            catch (e2) { body.textContent = m.text; }
          } else { body.textContent = m.text; }
        } else { node.textContent = m.text; }
        container.appendChild(node);
        return;
      }
    }
    var d = el('div', 'chat-msg ' + (m.role === 'user' ? 'user msg-user' : 'assistant msg-assistant') + ' sess-restored');
    var h = el('div', 'msg-head');
    h.appendChild(el('span', 'msg-role', m.role === 'user' ? 'You' : 'Cloud Code'));
    d.appendChild(h);
    var b = el('div', 'msg-body');
    var body2 = el('div', 'msg-text');
    body2.textContent = m.text;
    b.appendChild(body2);
    d.appendChild(b);
    container.appendChild(d);
  }

  function scrollBottom(container) {
    try { if (window.ai && isFn(window.ai, 'scrollToBottom')) { window.ai.scrollToBottom(); return; } } catch (e) { /* ignore */ }
    try { container.scrollTop = container.scrollHeight; } catch (e2) { /* ignore */ }
  }

  // ---------------------------------------------------------------------------
  // MutationObserver capture
  // ---------------------------------------------------------------------------
  var seen = typeof WeakMap === 'function' ? new WeakMap() : null;
  var seenFallback = [];

  function setSeen(node, rec) {
    if (seen) seen.set(node, rec);
    else { seenFallback.push({ node: node, rec: rec }); if (seenFallback.length > 400) seenFallback.shift(); }
  }
  function getSeen(node) {
    if (seen) return seen.get(node) || null;
    for (var i = seenFallback.length - 1; i >= 0; i--) {
      if (seenFallback[i].node === node) return seenFallback[i].rec;
    }
    return null;
  }
  function markSeen() {
    var container = byId('chat-messages');
    if (!container) return;
    Array.prototype.slice.call(container.children || []).forEach(function (node) {
      var text = nodeText(node);
      var prev = getSeen(node);
      if (prev) { prev.text = text; return; }
      setSeen(node, { text: text });
    });
  }

  function nodeRole(node) {
    var cls = (node.className && String(node.className)) || '';
    if (/msg-user|\buser\b|chat-msg\s+user/.test(cls)) return 'user';
    if (/msg-welcome/.test(cls)) return null; // welcome banner is not a message
    // anything else (including tool-cards, notices and unrecognised nodes)
    // is recorded as an assistant turn
    return 'assistant';
  }

  function nodeText(node) {
    // Prefer the controller's own source text when present (markdown-safe).
    if (node._aiSourceText) return String(node._aiSourceText).trim();
    var body = node.querySelector ? (node.querySelector('.msg-text') || node.querySelector('.msg-body') || node) : node;
    var clone = body.cloneNode ? body.cloneNode(true) : body;
    if (clone.querySelectorAll) {
      Array.prototype.slice.call(clone.querySelectorAll('.msg-context, .msg-typing, .msg-cursor, .msg-error-row, button, .code-actions'))
        .forEach(function (n) { if (n.parentNode) n.parentNode.removeChild(n); });
    }
    return String((clone.textContent || '')).replace(/\s+$/, '').trim();
  }

  function scan() {
    if (state.rendering) return;
    var container = byId('chat-messages');
    if (!container) return;
    var children = Array.prototype.slice.call(container.children || []);
    var dirty = false;
    children.forEach(function (node) {
      if (!node || node.nodeType !== 1) return;
      var text = nodeText(node);
      var prev = getSeen(node);
      if (!prev) {
        // new bubble
        var role = nodeRole(node);
        if (role === null) { setSeen(node, { text: text }); return; }
        if (!text) { setSeen(node, { text: text }); return; }
        setSeen(node, { text: text });
        dirty = true;
        recordMessage(role, text);
        return;
      }
      if (text && text !== prev.text) {
        prev.text = text; // streaming update of an existing bubble
        dirty = true;
        touchLast(roleOfBubble(node), text);
      }
    });
    if (dirty) scheduleSave();
  }

  function roleOfBubble(node) {
    if (prevRoleCache.length > 300) prevRoleCache.shift();
    for (var i = prevRoleCache.length - 1; i >= 0; i--) {
      if (prevRoleCache[i].node === node) return prevRoleCache[i].role;
    }
    var r = nodeRole(node) || 'assistant';
    prevRoleCache.push({ node: node, role: r });
    return r;
  }
  var prevRoleCache = [];

  // replace the last recorded message of the same role (streaming)
  function touchLast(role, text) {
    ensureLoaded().then(function () {
      var id = currentId();
      if (!id) return;
      var rec = state.cache[id];
      if (!rec) return;
      for (var i = rec.messages.length - 1; i >= 0; i--) {
        if (rec.messages[i].role === role) { rec.messages[i].text = text; break; }
      }
      rec.updatedAt = now();
      upsertSummary(rec);
    });
  }

  function startObserver() {
    var container = byId('chat-messages');
    if (!container || state.observer) return;
    var MO = window.MutationObserver || (typeof MutationObserver !== 'undefined' ? MutationObserver : null);
    if (!MO) return;
    try {
      state.observer = new MO(function () {
        if (state.domTimer) clearTimeout(state.domTimer);
        state.domTimer = setTimeout(scan, 60);
      });
      state.observer.observe(container, { childList: true, subtree: true, characterData: true });
    } catch (e) { state.observer = null; }
  }

  // ---------------------------------------------------------------------------
  // UI — history overlay
  // ---------------------------------------------------------------------------
  function actionsHost() {
    return safe('#ai-chat-view .sidebar-header .actions');
  }

  function makeIconBtn(cls, symbol, title) {
    var b = el('button', cls, symbol);
    b.type = 'button';
    b.title = title;
    b.setAttribute('aria-label', title);
    return b;
  }

  function injectButton() {
    var host = actionsHost();
    if (!host) return null;
    if (host.querySelector ? host.querySelector('.sess-history-btn') : null) return null;
    var b = makeIconBtn('icon-btn sess-history-btn', '🕘', 'Chat history');
    b.addEventListener('click', function (e) { e.preventDefault(); openHistory(); });
    host.appendChild(b); // append only — never reorder existing children
    return b;
  }

  function overlayShell(title, extraClass) {
    closeOverlay();
    var wrap = el('div', 'sess-overlay ' + (extraClass || ''));
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    var card = el('div', 'sess-card');
    var head = el('div', 'sess-card-head');
    var h = el('span', 'sess-card-title', title);
    head.appendChild(h);
    var x = makeIconBtn('icon-btn sess-close', '✕', 'Close');
    x.addEventListener('click', closeOverlay);
    head.appendChild(x);
    card.appendChild(head);
    wrap.appendChild(card);
    wrap.addEventListener('mousedown', function (e) { if (e.target === wrap) closeOverlay(); });
    document.body.appendChild(wrap);
    state.overlay = wrap;
    return { wrap: wrap, card: card };
  }

  function closeOverlay() {
    if (state.overlay && state.overlay.parentNode) state.overlay.parentNode.removeChild(state.overlay);
    state.overlay = null;
    state.openOverlay = null;
  }

  function openHistory() {
    var o = overlayShell('Chat history', 'sess-history');
    state.openOverlay = 'history';
    var card = o.card;

    var bar = el('div', 'sess-toolbar');
    var nb = el('button', 'sess-btn sess-btn-primary', '＋ New chat');
    nb.type = 'button';
    nb.addEventListener('click', function () {
      create(true).then(function () { closeOverlay(); });
    });
    bar.appendChild(nb);
    var search = el('input', 'sess-input sess-search');
    search.type = 'search';
    search.placeholder = 'Search chats…';
    search.setAttribute('aria-label', 'Search chats');
    bar.appendChild(search);
    card.appendChild(bar);

    var listEl = el('div', 'sess-list');
    listEl.setAttribute('tabindex', '0');
    card.appendChild(listEl);

    function render(rows, focusIdx) {
      listEl.innerHTML = '';
      if (!rows.length) {
        listEl.appendChild(el('div', 'sess-empty', 'No chats yet. Send a message to start one.'));
        return;
      }
      rows.forEach(function (s, i) {
        var row = el('div', 'sess-row' + (s.id === currentId() ? ' sess-row-active' : ''));
        row.setAttribute('data-id', s.id);
        row.setAttribute('data-idx', String(i));
        row.setAttribute('role', 'option');

        var main = el('button', 'sess-row-main');
        main.type = 'button';
        main.appendChild(el('span', 'sess-row-title', s.title || NEW_TITLE));
        var meta = el('span', 'sess-row-meta');
        meta.textContent = relativeTime(s.updatedAt) + ' · ' + (s.messageCount || 0) + ' msg';
        main.appendChild(meta);
        main.addEventListener('click', function () {
          open(s.id).then(function () { closeOverlay(); });
        });
        row.appendChild(main);

        var acts = el('span', 'sess-row-actions');
        var ren = makeIconBtn('icon-btn sess-mini', '✎', 'Rename');
        ren.addEventListener('click', function (e) { e.stopPropagation(); inlineRename(row, s); });
        acts.appendChild(ren);
        var del = makeIconBtn('icon-btn sess-mini sess-del', '🗑', 'Delete');
        del.addEventListener('click', function (e) {
          e.stopPropagation();
          if (confirmUI('Delete chat "' + (s.title || NEW_TITLE) + '"? This cannot be undone.')) {
            remove(s.id).then(function () { return list(); }).then(function (rows2) { render(rows2, 0); });
          }
        });
        acts.appendChild(del);
        row.appendChild(acts);
        listEl.appendChild(row);
        if (i === focusIdx) {
          row.classList.add('sess-row-focus');
          try { row.focus ? row.focus() : main.focus(); } catch (e) { /* ignore */ }
        }
      });
    }

    list().then(function (rows) { render(rows, -1); });

    search.addEventListener('input', function () {
      var q = search.value;
      (q ? searchSessions(q) : list()).then(function (rows) { render(rows, -1); });
    });

    listEl.addEventListener('keydown', function (e) {
      var rows = Array.prototype.slice.call(listEl.querySelectorAll('.sess-row'));
      if (!rows.length) return;
      var cur = rows.findIndex ? rows.findIndex(function (r) { return r.classList.contains('sess-row-focus'); }) : -1;
      if (e.key === 'ArrowDown') { e.preventDefault(); move(rows, cur + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(rows, cur - 1); }
      else if (e.key === 'Enter' && cur >= 0) {
        e.preventDefault();
        var id = rows[cur].getAttribute('data-id');
        open(id).then(closeOverlay);
      } else if (e.key === 'Escape') { e.preventDefault(); closeOverlay(); }
    });

    function move(rows, idx) {
      if (idx < 0) idx = rows.length - 1;
      if (idx >= rows.length) idx = 0;
      rows.forEach(function (r) { r.classList.remove('sess-row-focus'); });
      rows[idx].classList.add('sess-row-focus');
      try { rows[idx].focus(); } catch (e) { /* ignore */ }
    }

    o.wrap.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); closeOverlay(); }
    });
    try { search.focus(); } catch (e) { /* ignore */ }
  }

  // local name so it does not clash with window.confirm semantics in tests
  function confirmUI(msg) {
    try { return window.confirm(msg); } catch (e) { return true; }
  }

  function inlineRename(row, s) {
    if (row.querySelector ? row.querySelector('.sess-rename') : null) return;
    var input = el('input', 'sess-input sess-rename');
    input.type = 'text';
    input.value = s.title || '';
    var ok = el('button', 'sess-btn sess-btn-sm', 'Save');
    ok.type = 'button';
    var cancel = el('button', 'sess-btn sess-btn-sm sess-btn-ghost', 'Cancel');
    cancel.type = 'button';
    var box = el('div', 'sess-rename-box');
    box.appendChild(input);
    box.appendChild(ok);
    box.appendChild(cancel);
    row.appendChild(box);
    try { input.focus(); input.select(); } catch (e) { /* ignore */ }

    function commit() {
      rename(s.id, input.value).then(function () { return list(); })
        .then(function (rows) { if (state.openOverlay === 'history') renderListAgain(rows); });
    }
    ok.addEventListener('click', commit);
    cancel.addEventListener('click', function () { box.parentNode && box.parentNode.removeChild(box); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); if (box.parentNode) box.parentNode.removeChild(box); }
    });
  }

  function renderListAgain(rows) {
    if (!state.overlay) return;
    var l = state.overlay.querySelector ? state.overlay.querySelector('.sess-list') : null;
    if (!l) return;
    l.innerHTML = '';
    rows.forEach(function (s) {
      var row = el('div', 'sess-row' + (s.id === currentId() ? ' sess-row-active' : ''));
      row.setAttribute('data-id', s.id);
      var main = el('button', 'sess-row-main');
      main.type = 'button';
      main.appendChild(el('span', 'sess-row-title', s.title || NEW_TITLE));
      var meta = el('span', 'sess-row-meta');
      meta.textContent = relativeTime(s.updatedAt) + ' · ' + (s.messageCount || 0) + ' msg';
      main.appendChild(meta);
      main.addEventListener('click', function () { open(s.id).then(closeOverlay); });
      row.appendChild(main);
      var acts = el('span', 'sess-row-actions');
      var ren = makeIconBtn('icon-btn sess-mini', '✎', 'Rename');
      ren.addEventListener('click', function (e) { e.stopPropagation(); inlineRename(row, s); });
      acts.appendChild(ren);
      var del = makeIconBtn('icon-btn sess-mini sess-del', '🗑', 'Delete');
      del.addEventListener('click', function (e) {
        e.stopPropagation();
        if (confirmUI('Delete chat "' + (s.title || NEW_TITLE) + '"? This cannot be undone.')) {
          remove(s.id).then(function () { return list(); }).then(renderListAgain);
        }
      });
      acts.appendChild(del);
      row.appendChild(acts);
      l.appendChild(row);
    });
  }

  function searchSessions(q) { return search(q); }

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  function init() {
    var api = {
      list: list,
      current: current,
      open: open,
      create: create,
      rename: rename,
      remove: remove,
      renameCurrent: renameCurrent,
      clearCurrent: clearCurrent,
      search: search,
      recordMessage: recordMessage,
      flush: flushSave,
      deriveTitle: deriveTitle,
      relativeTime: relativeTime,
      closeOverlay: closeOverlay,
      // internals exposed for the test harness / other modules
      _scan: scan,
      _startObserver: startObserver,
      _state: state
    };
    try { window.sessions = api; } catch (e) { /* ignore */ }

    if (typeof document === 'undefined') return api;
    injectButton();
    ensureLoaded().then(function () {
      var id = currentId();
      if (!id) {
        create(true).then(function () { startObserver(); });
      } else {
        return loadSession(id).then(function (rec) {
          var container = byId('chat-messages');
          if (container && !container.children.length && rec.messages.length) renderMessages(rec);
          else markSeen();
          startObserver();
        });
      }
    }).catch(function () { startObserver(); });

    try {
      window.addEventListener('beforeunload', function () { flushSave(); });
    } catch (e) { /* ignore */ }

    return api;
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { init: init };
  if (typeof window !== 'undefined') init();
})();
