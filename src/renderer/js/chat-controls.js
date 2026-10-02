/* ==========================================================================
   Cloud Code — Chat control bar (mode toggle, model select, think level,
   attach-files chips). Self-contained classic script; hangs off window.
   ========================================================================== */

(function (global) {
  'use strict';

  var DEFAULT_MODEL = 'qwen-2.5-coder-7b';
  var DEFAULT_THINK = 'medium';
  var THINK_LEVELS = ['off', 'low', 'medium', 'high'];
  var LS_KEY = 'cc.thinkLevel';
  var MAX_FILES = 10;
  var MAX_BYTES = 400 * 1024;

  var THINK_LABELS = {
    off: 'Think: Off',
    low: 'Think: Low',
    medium: 'Think: Medium',
    high: 'Think: High'
  };

  var THINK_HINTS = {
    off: 'Answer immediately — no extra reasoning.',
    low: 'Short, direct reasoning before answering.',
    medium: 'Brief reasoning before answering (default).',
    high: 'Careful step-by-step reasoning, edge cases considered.'
  };

  var CARET_SVG =
    '<svg class="dd-caret" width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">' +
    '<path d="M8 10.5 3.5 6h9L8 10.5z"/></svg>';

  var CLIP_ICON =
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<path d="M10.6 4.3 L5.2 9.7 a1.7 1.7 0 0 0 2.4 2.4 l6.1 -6.1 a3 3 0 0 0 -4.2 -4.2 L3.1 8.2 a4.2 4.2 0 0 0 5.9 5.9 l5.3 -5.3"' +
    ' stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function fmtSize(bytes) {
    var n = typeof bytes === 'number' && isFinite(bytes) && bytes > 0 ? bytes : 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) {
      var kb = n / 1024;
      return (kb >= 100 ? Math.round(kb) : Math.round(kb * 10) / 10) + ' KB';
    }
    var mb = n / (1024 * 1024);
    return (mb >= 100 ? Math.round(mb) : Math.round(mb * 10) / 10) + ' MB';
  }

  function normalizeModels(list) {
    var out = [];
    if (!list || typeof list.length !== 'number') return out;
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      var id = null;
      if (typeof item === 'string') id = item;
      else if (item && typeof item === 'object') {
        if (typeof item.id === 'string' && item.id) id = item.id;
        else if (typeof item.name === 'string' && item.name) id = item.name;
      }
      if (id && out.indexOf(id) === -1) out.push(id);
    }
    return out;
  }

  function ChatControls() {
    // Idempotent: hand back the live instance.
    if (ChatControls._instance) return ChatControls._instance;
    ChatControls._instance = this;

    this.attachments = [];
    this._booted = false;

    this.el = {
      bar: document.getElementById('chat-control-bar'),
      chatBtn: document.getElementById('mode-chat-btn'),
      agentBtn: document.getElementById('mode-agent-btn'),
      think: document.getElementById('think-level-select'),
      model: document.getElementById('model-select'),
      attach: document.getElementById('attach-files-btn'),
      chips: document.getElementById('attach-chips')
    };

    if (!this._checkDom()) return;

    this._booted = true;
    this._openDropdown = null;
    this._initMode();
    // Native <select>s become hidden, aria-hidden *proxies*: their `.value`
    // stays authoritative (agent.js + ai-assistant.js read it directly),
    // while the visible control is the custom `dd-*` dropdown below.
    this._hideProxy(this.el.think);
    this._hideProxy(this.el.model);
    this._initThink();
    this._initModel();
    this._initAttach();
    this._renderChips();
  }

  // A <select> that still works headlessly: same id, same .value, hidden.
  ChatControls.prototype._hideProxy = function (sel) {
    if (!sel) return sel;
    sel.classList.add('chat-select-proxy');
    sel.setAttribute('aria-hidden', 'true');
    sel.setAttribute('tabindex', '-1');
    // `hidden` keeps it out of the tab order and out of the layout while
    // leaving `.value` fully functional.
    sel.hidden = true;
    // If the author stylesheet wins on display, force it out of flow too.
    if (sel.style) sel.style.display = 'none';
    return sel;
  };

  /* ---------------------------------------------------------------------
     Dropdown — a VS Code quick-pick style menu (button + popup list).
     Namespaced `dd-*`. Keyboard: Enter/Space/ArrowUp/ArrowDown open,
     arrows move, Enter/Space select, Escape closes + restores focus.
     --------------------------------------------------------------------- */
  ChatControls.prototype._createDropdown = function (opts) {
    var self = this;
    var dd = {
      key: opts.key,
      select: opts.select,
      items: [],
      value: '',
      activeIndex: 0,
      open: false,
      disabled: false
    };

    var root = document.createElement('div');
    root.className = 'dd';

    var trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'dd-trigger';
    trigger.setAttribute('id', opts.id + '-trigger');
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('role', 'combobox');

    var label = document.createElement('span');
    label.className = 'dd-value';

    var menu = document.createElement('div');
    menu.className = 'dd-menu';
    menu.setAttribute('id', opts.id + '-menu');
    menu.setAttribute('role', 'listbox');
    menu.hidden = true;

    trigger.innerHTML = CARET_SVG;
    trigger.insertBefore(label, trigger.firstChild);

    root.appendChild(trigger);
    root.appendChild(menu);
    // Hide the native proxy visually but keep it as the value authority.
    if (opts.select && opts.select.parentNode) {
      opts.select.parentNode.insertBefore(root, opts.select);
    }

    dd.root = root;
    dd.trigger = trigger;
    dd.menu = menu;
    dd.label = label;

    dd.setItems = function (items, selected) {
      dd.items = items || [];
      if (selected != null) dd.value = selected;
      dd.renderMenu();
      dd.sync();
    };

    dd.renderMenu = function () {
      while (menu.firstChild) menu.removeChild(menu.firstChild);
      var active = false;
      dd.items.forEach(function (item, i) {
        var row = document.createElement('div');
        row.className = 'dd-item';
        row.setAttribute('role', 'option');
        row.dataset.index = String(i);
        var check = document.createElement('span');
        check.className = 'dd-check';
        check.setAttribute('aria-hidden', 'true');
        check.textContent = item.value === dd.value ? '✓' : '';
        var text = document.createElement('span');
        text.className = 'dd-item-label';
        text.textContent = item.label || item.value;   // untrusted → textContent
        if (item.hint) row.title = item.hint;
        row.appendChild(check);
        row.appendChild(text);
        if (item.value === dd.value) row.setAttribute('aria-selected', 'true');
        if (!active && item.value === dd.value) {
          row.classList.add('dd-item-active');
          active = true;
        }
        row.addEventListener('mousedown', function (e) {
          e.preventDefault();
          dd.close(true);
          dd.choose(i);
        });
        row.addEventListener('mouseenter', function () {
          dd.setActive(i);
        });
        menu.appendChild(row);
      });
      dd.setActive(active ? dd.indexOfValue(dd.value) : 0);
    };

    dd.indexOfValue = function (v) {
      for (var i = 0; i < dd.items.length; i++) if (dd.items[i].value === v) return i;
      return 0;
    };

    dd.setActive = function (i) {
      if (!dd.items.length) return;
      dd.activeIndex = Math.max(0, Math.min(dd.items.length - 1, i));
      var rows = menu.querySelectorAll ? menu.querySelectorAll('.dd-item') : [];
      for (var k = 0; k < rows.length; k++) rows[k].classList.toggle('dd-item-active', k === dd.activeIndex);
    };

    dd.sync = function () {
      label.textContent = dd.display();
      trigger.classList.toggle('dd-open', dd.open);
      trigger.classList.toggle('dd-empty', !dd.value);
      trigger.classList.toggle('dd-disabled', !!dd.disabled);
      trigger.disabled = !!dd.disabled;
      trigger.setAttribute('aria-expanded', dd.open ? 'true' : 'false');
      if (dd.select) {
        dd.select.value = dd.value;
      }
    };

    dd.display = function () {
      var it = dd.items[dd.indexOfValue(dd.value)];
      return it ? (it.label || it.value) : (dd.value || opts.placeholder || '—');
    };

    dd.toggle = function () {
      if (dd.disabled) return;
      if (dd.open) dd.close();
      else dd.show();
    };

    dd.show = function () {
      if (dd.disabled || dd.open) return;
      if (self._openDropdown && self._openDropdown !== dd) self._openDropdown.close();
      dd.open = true;
      self._openDropdown = dd;
      menu.hidden = false;
      dd.renderMenu();
      dd.sync();
    };

    dd.close = function (keepFocus) {
      if (!dd.open) return;
      dd.open = false;
      menu.hidden = true;
      dd.sync();
      if (self._openDropdown === dd) self._openDropdown = null;
      if (keepFocus && trigger.focus) trigger.focus();
    };

    dd.choose = function (i) {
      var item = dd.items[i];
      if (!item) return;
      if (item.value !== dd.value) {
        if (opts.onChange) opts.onChange(item.value);
      } else {
        dd.sync();
      }
    };

    dd.onKeydown = function (e) {
      var k = e.key;
      if (k === 'Escape') {
        e.preventDefault();
        dd.close(true);
        return;
      }
      if (!dd.open) {
        if (k === 'Enter' || k === ' ' || k === 'ArrowDown' || k === 'ArrowUp') {
          e.preventDefault();
          dd.show();
          if (k === 'ArrowUp' && dd.items.length) dd.setActive(dd.items.length - 1);
        }
        return;
      }
      if (k === 'ArrowDown') { e.preventDefault(); dd.setActive(dd.activeIndex + 1); }
      else if (k === 'ArrowUp') { e.preventDefault(); dd.setActive(dd.activeIndex - 1); }
      else if (k === 'Home') { e.preventDefault(); dd.setActive(0); }
      else if (k === 'End') { e.preventDefault(); dd.setActive(dd.items.length - 1); }
      else if (k === 'Enter' || k === ' ') { e.preventDefault(); dd.close(true); dd.choose(dd.activeIndex); }
      else if (k === 'Tab') { dd.close(); }
    };

    trigger.addEventListener('keydown', dd.onKeydown);
    trigger.addEventListener('click', function () { dd.toggle(); });
    menu.addEventListener('keydown', function (e) { dd.onKeydown(e); });
    // Keep focus on the trigger while the popup is open so Escape/Enter work.
    trigger.addEventListener('blur', function () {
      if (dd.open && !root.contains) return;
      if (dd.open && root.contains && root.contains(document.activeElement)) return;
      if (dd.open) dd.close();
    });

    dd.destroy = function () {
      if (root.parentNode) root.parentNode.removeChild(root);
    };

    return dd;
  };

  // Dismiss the open dropdown on outside click / scroll / resize.
  ChatControls.prototype._initGlobalDismiss = function () {
    var self = this;
    if (this._dismissWired) return;
    this._dismissWired = true;
    global.document.addEventListener('mousedown', function (e) {
      var dd = self._openDropdown;
      if (!dd) return;
      var t = e && e.target;
      if (t && dd.root.contains && dd.root.contains(t)) return;
      dd.close();
    }, true);
    global.addEventListener('resize', function () {
      if (self._openDropdown) self._openDropdown.close();
    });
    // Scroll (capture) covers the panel resize handle + any scrollable ancestor.
    global.document.addEventListener('scroll', function () {
      if (self._openDropdown) self._openDropdown.close();
    }, true);
  };

  // Returns true when every required element exists; logs once otherwise.
  ChatControls._missingLogged = false;
  ChatControls.prototype._checkDom = function () {
    var missing = null;
    for (var k in this.el) {
      if (!this.el[k]) { missing = k; break; }
    }
    if (missing) {
      if (!ChatControls._missingLogged) {
        ChatControls._missingLogged = true;
        console.debug('chat-controls disabled: missing #' + missing);
      }
      return false;
    }
    return true;
  };

  ChatControls.prototype.isBooted = function () {
    return this._booted === true;
  };

  // ----------------------------- mode ---------------------------------------

  ChatControls.prototype._initMode = function () {
    var self = this;
    this._onModeClick('chat', this.el.chatBtn);
    this._onModeClick('agent', this.el.agentBtn);
    // Coordinator broadcasts mode changes made elsewhere.
    global.addEventListener('chat:mode-set', function (e) {
      var m = e && e.detail ? e.detail.mode : null;
      self._syncMode(m === 'agent' ? 'agent' : 'chat');
    });
    this._syncMode(this._readMode());
  };

  ChatControls.prototype._onModeClick = function (mode, btn) {
    var self = this;
    btn.addEventListener('click', function () {
      self._syncMode(mode);
      try {
        if (global.ai && typeof global.ai.setMode === 'function') global.ai.setMode(mode);
      } catch (e) {
        console.debug('chat-controls: setMode failed', e);
      }
      global.dispatchEvent(new CustomEvent('chat:mode-changed', { detail: { mode: mode } }));
    });
  };

  ChatControls.prototype._readMode = function () {
    try {
      if (global.ai && global.ai.mode === 'agent') return 'agent';
    } catch (e) { /* ignore */ }
    return 'chat';
  };

  ChatControls.prototype._syncMode = function (mode) {
    if (!this.el.chatBtn || !this.el.agentBtn) return;
    var isAgent = mode === 'agent';
    this.el.agentBtn.classList.toggle('active', isAgent);
    this.el.chatBtn.classList.toggle('active', !isAgent);
  };

  // --------------------------- think level ----------------------------------

  ChatControls.prototype._initThink = function () {
    var self = this;
    this._initGlobalDismiss();

    var current = this._readThink();

    // Keep the hidden proxy's option list honest even if index.html drifted.
    var have = this.el.think.options ? this.el.think.options.length : 0;
    if (!have) {
      THINK_LEVELS.forEach(function (lv) {
        var o = document.createElement('option');
        o.value = lv;
        o.textContent = THINK_LABELS[lv];
        self.el.think.appendChild(o);
      });
    }
    this.el.think.value = current;

    // The proxy remains functional: an external `change` still routes through
    // the same normalise → persist → dispatch path.
    this.el.think.addEventListener('change', function () {
      self.setThink(self.el.think.value);
    });

    this.thinkDd = this._createDropdown({
      key: 'think',
      id: 'think-level-dd',
      select: this.el.think,
      placeholder: THINK_LABELS[DEFAULT_THINK],
      onChange: function (v) { self.setThink(v); }
    });
    this.thinkDd.setItems(THINK_LEVELS.map(function (lv) {
      return { value: lv, label: THINK_LABELS[lv], hint: THINK_HINTS[lv] };
    }), current);
    this.thinkDd.trigger.title = 'Thinking level — controls how much the model reasons before answering';
  };

  ChatControls.prototype.setThink = function (v) {
    if (!this._booted) return;
    var lv = this._normalizeThink(v);
    if (this.el.think) this.el.think.value = lv;
    if (this.thinkDd) {
      this.thinkDd.value = lv;
      this.thinkDd.renderMenu();
      this.thinkDd.sync();
    }
    this._writeThink(lv);
    global.dispatchEvent(new CustomEvent('chat:think-changed', { detail: { level: lv } }));
  };

  ChatControls.prototype._normalizeThink = function (v) {
    return THINK_LEVELS.indexOf(v) === -1 ? DEFAULT_THINK : v;
  };

  ChatControls.prototype._readThink = function () {
    try {
      var s = global.AppSettings;
      if (s && typeof s.get === 'function') {
        var v = s.get('thinkLevel');
        if (THINK_LEVELS.indexOf(v) !== -1) return v;
        if (v == null && s.DEFAULTS && THINK_LEVELS.indexOf(s.DEFAULTS.thinkLevel) !== -1) {
          return s.DEFAULTS.thinkLevel;
        }
      }
    } catch (e) { /* fall through to localStorage */ }
    try {
      var lv = global.localStorage && global.localStorage.getItem(LS_KEY);
      if (THINK_LEVELS.indexOf(lv) !== -1) return lv;
    } catch (e) { /* ignore */ }
    return DEFAULT_THINK;
  };

  ChatControls.prototype._writeThink = function (level) {
    try {
      var s = global.AppSettings;
      if (s && typeof s.set === 'function') {
        var r = s.set('thinkLevel', level);
        if (r && typeof r.then === 'function') {
          r.catch(function (e) { console.debug('chat-controls: save thinkLevel failed', e); });
        }
        return;
      }
    } catch (e) { /* fall through to localStorage */ }
    try {
      if (global.localStorage) global.localStorage.setItem(LS_KEY, level);
    } catch (e) { /* ignore */ }
  };

  // ------------------------------ model --------------------------------------

  ChatControls.prototype._initModel = function () {
    var self = this;
    this._initGlobalDismiss();
    this._model = DEFAULT_MODEL;
    this.el.model.addEventListener('change', function () {
      self.setModel(self.el.model.value);
    });
    this.modelDd = this._createDropdown({
      key: 'model',
      id: 'model-dd',
      select: this.el.model,
      placeholder: DEFAULT_MODEL,
      onChange: function (v) { self.setModel(v); }
    });
    this._loadModel();
  };

  ChatControls.prototype._loadModel = function () {
    var self = this;
    var api = global.electronAPI;
    var current = this._model;

    try {
      if (api && typeof api.getAiConfig === 'function') {
        var cfg = api.getAiConfig();
        if (cfg && typeof cfg.model === 'string' && cfg.model) current = cfg.model;
      }
    } catch (e) {
      console.debug('chat-controls: getAiConfig failed', e);
    }

    this._model = current;
    this._setOptions([current]);

    if (!api || typeof api.listAiModels !== 'function') return;

    var p;
    try {
      p = api.listAiModels();
    } catch (e) {
      console.debug('chat-controls: listAiModels failed', e);
      return;
    }
    if (!p || typeof p.then !== 'function') {
      this._setOptions(normalizeModels(p));
      return;
    }
    p.then(function (list) {
      // _setOptions prepends the active model itself when it is missing, so
      // the dropdown is never empty.
      self._setOptions(normalizeModels(list));
    }).catch(function (e) {
      console.debug('chat-controls: listAiModels failed', e);
    });
  };

  // Rebuilds both the hidden proxy's options and the visible dropdown,
  // keeping `current` selected even when the server didn't list it.
  // Never produces an empty list.
  ChatControls.prototype._setOptions = function (models) {
    var sel = this.el.model;
    var current = this._model;
    var list = [];
    (models || []).forEach(function (m) {
      if (m && list.indexOf(m) === -1) list.push(m);
    });
    // Never drop the active model: prepend it if the server didn't list it.
    if (current && list.indexOf(current) === -1) list.unshift(current);
    if (list.length === 0) list = [current || DEFAULT_MODEL];

    if (sel) {
      sel.textContent = '';
      list.forEach(function (m) {
        var o = document.createElement('option');
        o.value = m;
        o.textContent = m;
        sel.appendChild(o);
      });
      sel.value = current;
    }

    if (this.modelDd) {
      // A single-item list means the backend list is unavailable: keep the
      // control usable but visually flag that it is not a real choice.
      this.modelDd.disabled = false;
      this.modelDd.trigger.classList.toggle('dd-solo', list.length < 2);
      this.modelDd.trigger.title = list.length < 2
        ? 'Model list unavailable — showing the configured model (' + current + ')'
        : 'AI model used for chat and agent requests';
      this.modelDd.setItems(list.map(function (m) {
        return { value: m, label: m, hint: m === current ? 'Currently selected' : '' };
      }), current);
    }
  };

  ChatControls.prototype.setModel = function (m) {
    if (!this._booted || !this.el.model) return;
    if (typeof m !== 'string' || !m) return;
    this._model = m;
    if (this.el.model.value !== m) {
      // Option may not exist yet.
      var found = false;
      var opts = this.el.model.options || [];
      for (var i = 0; i < opts.length; i++) {
        if (opts[i].value === m) { found = true; break; }
      }
      if (!found) {
        var o = document.createElement('option');
        o.value = m;
        o.textContent = m;
        this.el.model.appendChild(o);
      }
      this.el.model.value = m;
    }
    if (this.modelDd) {
      var inList = false;
      this.modelDd.items.forEach(function (it) { if (it.value === m) inList = true; });
      if (!inList) {
        // Not in the list yet — add it rather than showing a stale label.
        this.modelDd.items = [{ value: m, label: m, hint: 'Currently selected' }]
          .concat(this.modelDd.items);
      }
      this.modelDd.value = m;
      this.modelDd.renderMenu();
      this.modelDd.sync();
    }
    try {
      var api = global.electronAPI;
      if (api && typeof api.updateAiConfig === 'function') api.updateAiConfig({ model: m });
    } catch (e) {
      console.debug('chat-controls: updateAiConfig failed', e);
    }
    global.dispatchEvent(new CustomEvent('chat:model-changed', { detail: { model: m } }));
  };

  // ---------------------------- attachments ---------------------------------

  ChatControls.prototype._initAttach = function () {
    var self = this;
    this.el.attach.innerHTML = CLIP_ICON;
    this.el.attach.addEventListener('click', function () { self._pickFiles(); });
  };

  ChatControls.prototype._pickFiles = function () {
    var self = this;
    var api = global.electronAPI;
    if (!api || typeof api.openFiles !== 'function') return;
    var p;
    try {
      p = api.openFiles();
    } catch (e) {
      console.debug('chat-controls: openFiles failed', e);
      return;
    }
    if (!p || typeof p.then !== 'function') {
      if (p) self.addFiles(p);
      return;
    }
    p.then(function (files) {
      self.addFiles(files);
    }).catch(function (e) {
      console.debug('chat-controls: openFiles cancelled', e);
    });
  };

  ChatControls.prototype.addFiles = function (list) {
    if (!this._booted || !list || typeof list.length !== 'number') return;
    var changed = false;
    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      if (!f || typeof f.path !== 'string' || !f.path) continue;
      var size = typeof f.size === 'number' && isFinite(f.size) && f.size > 0 ? f.size : 0;
      if (size > MAX_BYTES) continue;
      if (this._has(f.path)) continue;
      if (this.attachments.length >= MAX_FILES) break;
      this.attachments.push({
        path: f.path,
        name: typeof f.name === 'string' && f.name ? f.name : f.path.split(/[\\/]/).pop(),
        size: size
      });
      changed = true;
    }
    if (changed) this._emitAttachments();
  };

  ChatControls.prototype._has = function (p) {
    for (var i = 0; i < this.attachments.length; i++) {
      if (this.attachments[i].path === p) return true;
    }
    return false;
  };

  ChatControls.prototype.removeFile = function (p) {
    for (var i = 0; i < this.attachments.length; i++) {
      if (this.attachments[i].path === p) {
        this.attachments.splice(i, 1);
        this._emitAttachments();
        return true;
      }
    }
    return false;
  };

  ChatControls.prototype.clearAttachments = function () {
    if (!this._booted || this.attachments.length === 0) return;
    this.attachments = [];
    this._emitAttachments();
  };

  ChatControls.prototype.getAttachments = function () {
    return this.attachments.map(function (f) {
      return { path: f.path, name: f.name, size: f.size };
    });
  };

  ChatControls.prototype._emitAttachments = function () {
    this._renderChips();
    global.dispatchEvent(new CustomEvent('chat:attachments-changed', {
      detail: { count: this.attachments.length }
    }));
  };

  // Untrusted names go in via textContent only.
  ChatControls.prototype._renderChips = function () {
    var box = this.el.chips;
    if (!box) return;
    while (box.firstChild) box.removeChild(box.firstChild);

    var self = this;
    this.attachments.forEach(function (f) {
      var chip = document.createElement('span');
      chip.className = 'attach-chip';
      chip.title = f.path;

      var name = document.createElement('span');
      name.className = 'attach-chip-name';
      name.textContent = f.name;
      chip.appendChild(name);

      var size = document.createElement('span');
      size.className = 'attach-chip-size';
      size.textContent = fmtSize(f.size);
      chip.appendChild(size);

      var x = document.createElement('button');
      x.type = 'button';
      x.className = 'attach-chip-remove';
      x.title = 'Remove ' + f.name;
      x.setAttribute('aria-label', 'Remove attachment');
      x.textContent = '\u00d7';
      x.addEventListener('click', function () { self.removeFile(f.path); });
      chip.appendChild(x);

      box.appendChild(chip);
    });

    box.classList.toggle('hidden', this.attachments.length === 0);
  };

  global.ChatControls = ChatControls;
})(window);

(function (global) {
  'use strict';
  function boot() {
    if (global.__chatControlsBooted) return;
    global.__chatControlsBooted = true;
    try {
      global.chatControls = new global.ChatControls();
    } catch (e) {
      console.debug('chat-controls disabled:', e);
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})(window);
