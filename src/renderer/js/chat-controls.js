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
    this._initMode();
    this._initThink();
    this._initModel();
    this._initAttach();
    this._renderChips();
  }

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
    // Keep the option list honest even if index.html drifted.
    if (!this.el.think.options || this.el.think.options.length === 0) {
      THINK_LEVELS.forEach(function (lv) {
        var o = document.createElement('option');
        o.value = lv;
        o.textContent = 'Think: ' + lv.charAt(0).toUpperCase() + lv.slice(1);
        self.el.think.appendChild(o);
      });
    }
    this.el.think.value = this._readThink();
    this.el.think.addEventListener('change', function () {
      var lv = self._normalizeThink(self.el.think.value);
      self.el.think.value = lv;
      self._writeThink(lv);
      global.dispatchEvent(new CustomEvent('chat:think-changed', { detail: { level: lv } }));
    });
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
    this._model = DEFAULT_MODEL;
    this.el.model.addEventListener('change', function () {
      self.setModel(self.el.model.value);
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
      if (p) this._setOptions(normalizeModels(p));
      return;
    }
    p.then(function (list) {
      // _setOptions prepends the active model itself when it is missing.
      self._setOptions(normalizeModels(list));
    }).catch(function (e) {
      console.debug('chat-controls: listAiModels failed', e);
    });
  };

  // Rebuilds the option list, keeping `current` selected even if absent.
  ChatControls.prototype._setOptions = function (models) {
    var sel = this.el.model;
    if (!sel) return;
    var current = this._model;
    var list = [];
    (models || []).forEach(function (m) {
      if (m && list.indexOf(m) === -1) list.push(m);
    });
    // Never drop the active model: prepend it if the server didn't list it.
    if (current && list.indexOf(current) === -1) list.unshift(current);
    if (list.length === 0) list = [current || DEFAULT_MODEL];

    sel.textContent = '';
    list.forEach(function (m) {
      var o = document.createElement('option');
      o.value = m;
      o.textContent = m;
      sel.appendChild(o);
    });
    if (list.indexOf(current) !== -1) sel.value = current;
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
