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

  // Last model that actually answered a request, per workspace, so a bad
  // switch is one click to undo.
  var LS_GOOD_MODEL = 'cc.model.lastGood';
  // Health probe budget. A model that has not answered in 20 s is not
  // "slow", it is broken — say so instead of spinning forever.
  var PROBE_TIMEOUT_MS = 20000;
  // How long the trigger keeps the "✓ Saved" confirmation.
  var SAVED_MS = 1200;

  // Autonomy modes — must match agent.js' `#agent-mode-select` values and
  // settings.js' `DEFAULTS.agentMode` ('ask').
  var AGENT_MODES = ['ask', 'edit-auto', 'full-auto'];
  var DEFAULT_AGENT_MODE = 'ask';

  var AGENT_MODE_LABELS = {
    ask: 'Ask before changes',
    'edit-auto': 'Auto-edit',
    'full-auto': 'Fully auto'
  };

  var AGENT_MODE_HINTS = {
    ask: 'Every file edit and command is confirmed before it runs (safest).',
    'edit-auto': 'File edits apply on their own; commands still ask first.',
    'full-auto': 'Edits and commands run without asking. Only use on throwaway work.'
  };

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

  // Accepts both shapes listAiModels() may return: plain strings and
  // `{ id }` / `{ name }` objects. De-duplicates case-insensitively while
  // keeping the first spelling the server used.
  function normalizeModels(list) {
    var out = [];
    var seen = Object.create(null);
    if (!list || typeof list.length !== 'number') return out;
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      var id = null;
      if (typeof item === 'string') id = item;
      else if (item && typeof item === 'object') {
        if (typeof item.id === 'string' && item.id) id = item.id;
        else if (typeof item.name === 'string' && item.name) id = item.name;
      }
      if (typeof id !== 'string') continue;
      id = id.trim();
      if (!id) continue;
      var key = id.toLowerCase();
      if (seen[key]) continue;
      seen[key] = true;
      out.push(id);
    }
    return out;
  }

  // Case-insensitive contains over the whole query (space separated terms
  // must all match, in any order).
  function matchesFilter(item, filter) {
    if (!filter) return true;
    var hay = (item.searchText || (item.value + ' ' + (item.label || ''))).toLowerCase();
    var terms = String(filter).toLowerCase().split(/\s+/);
    for (var i = 0; i < terms.length; i++) {
      if (terms[i] && hay.indexOf(terms[i]) === -1) return false;
    }
    return true;
  }

  /* ---------------------------------------------------------------------
     Model family classification.

     NONE of the models behind this backend support native tool calling:
     every request comes back with `usedNativeTools: false`, so the agent
     drives them entirely through the `<<<TOOL>>>…<<<END>>>` text protocol.
     That makes three properties of a model id matter to the user, and
     getting them wrong is what made "switching the model" look broken:

       1. IMAGE  — cannot answer a text prompt at all → not selectable.
       2. THINK  — emits a reasoning wrapper, which pollutes the text
                   protocol the agent parses → flagged, not blocked.
       3. CODER  — instruction-tuned coding models, the ones that actually
                   follow the tool protocol → "recommended".

     Rules are deliberately ordered: image → coder → reasoning → plain, so
     an id like `qwen-image-2-1` can never be mistaken for a coder model.
     --------------------------------------------------------------------- */
  var BADGE_REASONING = 'thinking';
  var BADGE_CODER = 'coder';
  var BADGE_IMAGE = 'image';

  var TIP_IMAGE = 'image model — cannot answer text prompts';
  var TIP_REASONING = 'reasoning model — may add thinking output that confuses the agent tool parser';
  var TIP_CODER = 'recommended for coding — follows the agent tool protocol';
  var TIP_PLAIN = 'general chat model — may or may not follow the agent tool protocol';

  // Image generation models (any `*-image*`, or a known diffusion family).
  function isImageModel(s) {
    if (/(^|[-_.])image([-_.]|$)/.test(s)) return true;
    return /^(flux|sdxl|dall|stable-diffusion|midjourney|ideogram)/.test(s);
  }

  // Instruction-tuned coding models. Checked before `isReasoningModel` so a
  // hypothetical `*-coder-r1` still counts as the usable coder.
  function isCoderModel(s) {
    if (/qwen[\d.]*-?coder/.test(s)) return true;      // qwen-2.5-coder-7b
    if (/coder/.test(s)) return true;                 // *-coder-*, *coder*
    if (/^codestral/.test(s)) return true;
    if (/^gpt-oss/.test(s)) return true;
    if (/llama.*instruct/.test(s)) return true;
    if (/qwen.*instruct/.test(s)) return true;
    if (/(^|[-_.])it([-_.]|$)/.test(s)) return true;   // mistral-nemo-…-it
    return false;
  }

  // Reasoning / thinking models: R-series (`deepseek-r1-8b`), `reason*`,
  // `thinking*`, `<think>`-flavoured ids.
  function isReasoningModel(s) {
    if (/(^|[-_.])r\d+([-_.]|$)/.test(s)) return true;   // deepseek-r1-8b
    if (/reason/.test(s)) return true;
    if (/think/.test(s)) return true;
    if (/(^|[-_.])o\d+([-_.]|$)/.test(s)) return true;   // gpt-oss-20b style
    return false;
  }

  // The "Agent-friendly" filter: models known to follow the tool protocol.
  // Deliberately a subset of isCoderModel (no bare `-it`), so the filtered
  // view is small and trustworthy.
  function isAgentFriendlyModel(s) {
    if (isImageModel(s)) return false;
    if (/qwen.*coder/.test(s)) return true;
    if (/^codestral/.test(s)) return true;
    if (/^gpt-oss/.test(s)) return true;
    if (/llama.*instruct/.test(s)) return true;
    return false;
  }

  // Single source of truth for badges / tooltips / selectability.
  function classifyModel(id) {
    var s = String(id == null ? '' : id).toLowerCase();
    if (isImageModel(s)) {
      return {
        family: 'image',
        badge: BADGE_IMAGE,
        tip: TIP_IMAGE,
        disabled: true,
        agentFriendly: false
      };
    }
    if (isCoderModel(s)) {
      return {
        family: 'coder',
        badge: BADGE_CODER,
        tip: TIP_CODER,
        disabled: false,
        agentFriendly: isAgentFriendlyModel(s)
      };
    }
    if (isReasoningModel(s)) {
      return {
        family: 'reasoning',
        badge: BADGE_REASONING,
        tip: TIP_REASONING,
        disabled: false,
        agentFriendly: false
      };
    }
    return {
      family: 'plain',
      badge: '',
      tip: TIP_PLAIN,
      disabled: false,
      agentFriendly: false
    };
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
    this._agentMode = DEFAULT_AGENT_MODE;
    this._modelListOk = false;
    this._initMode();
    // Native <select>s become hidden, aria-hidden *proxies*: their `.value`
    // stays authoritative (agent.js + ai-assistant.js read it directly),
    // while the visible control is the custom `dd-*` dropdown below.
    this._hideProxy(this.el.think);
    this._hideProxy(this.el.model);
    this._initThink();
    this._initModel();
    this._initAgentMode();
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

     With `opts.searchable` the popup grows a filter box ("Type to filter…"),
     a scrollable list (`.dd-list`) and a "showing X of Y" footer
     (`.dd-foot`) so an arbitrarily long list is browsable and — crucially —
     never silently truncated.
     --------------------------------------------------------------------- */
  ChatControls.prototype._createDropdown = function (opts) {
    var self = this;
    var dd = {
      key: opts.key,
      select: opts.select || null,
      items: [],
      visible: [],
      filter: '',
      value: '',
      activeIndex: 0,
      open: false,
      disabled: false,
      searchable: !!opts.searchable
    };

    var root = document.createElement('div');
    root.className = 'dd';
    if (dd.searchable) root.classList.add('dd-searchable');

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

    // Filter box (searchable dropdowns only)
    var search = null;
    if (dd.searchable) {
      search = document.createElement('input');
      search.type = 'text';
      search.className = 'dd-search';
      search.setAttribute('placeholder', opts.searchPlaceholder || 'Type to filter…');
      search.setAttribute('aria-label', 'Filter list');
      search.setAttribute('autocomplete', 'off');
      search.setAttribute('spellcheck', 'false');
    }

    var list = document.createElement('div');
    list.className = 'dd-list';
    list.setAttribute('role', 'presentation');

    var foot = document.createElement('div');
    foot.className = 'dd-foot';

    // Transient save/confirm state shown on the trigger itself
    // ("saving…" → "✓ Saved") so a switch is visibly *landed*.
    var status = document.createElement('span');
    status.className = 'dd-status';
    status.hidden = true;

    trigger.innerHTML = CARET_SVG;
    trigger.insertBefore(label, trigger.firstChild);
    trigger.appendChild(status);

    if (search) menu.appendChild(search);
    // Optional per-dropdown action panel (model dropdown: filter toggle,
    // Test connection, health result, retry/restore actions).
    if (opts.buildExtras) menu.appendChild(opts.buildExtras(dd));
    menu.appendChild(list);
    if (dd.searchable) menu.appendChild(foot);

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
    dd.list = list;
    dd.foot = foot;
    dd.search = search;

    dd.setItems = function (items, selected) {
      dd.items = (items || []).map(function (it) {
        var item = {
          value: it.value,
          label: it.label || it.value,
          hint: it.hint || '',
          badge: it.badge || '',
          badgeKind: it.badgeKind || 'plain',
          disabled: it.disabled === true,
          disabledTip: it.disabledTip || ''
        };
        item.searchText = (item.value + ' ' + item.label + ' ' + (item.badge || '')).toLowerCase();
        return item;
      });
      if (selected != null) dd.value = selected;
      dd.setFilter('');
      dd.sync();
    };

    // Transient trigger state. `text` falsy → back to the model id.
    dd.setStatus = function (text, kind) {
      if (!text) {
        status.hidden = true;
        status.textContent = '';
        status.className = 'dd-status';
        trigger.classList.remove('dd-has-status');
        return;
      }
      // Untrusted error text still goes in as textContent, never markup.
      status.textContent = text;
      status.className = 'dd-status' + (kind ? ' dd-status-' + kind : '');
      status.hidden = false;
      trigger.classList.add('dd-has-status');
    };

    dd.statusText = function () { return status.textContent; };

    // Re-run the predicate + repaint (after an external state change).
    dd.refresh = function () { dd.renderMenu(); };

    dd.setFilter = function (text) {
      dd.filter = text == null ? '' : String(text);
      if (search && search.value !== dd.filter) search.value = dd.filter;
      dd.renderMenu();
      if (opts.onFilter && dd.open) opts.onFilter(dd.filter, dd.visible.length, dd.items.length);
    };

    dd.renderMenu = function () {
      while (list.firstChild) list.removeChild(list.firstChild);
      dd.visible = [];
      for (var i = 0; i < dd.items.length; i++) {
        var it = dd.items[i];
        if (!matchesFilter(it, dd.filter)) continue;
        // opts.predicate powers the "Agent-friendly only" toggle.
        if (opts.predicate && !opts.predicate(it.value, it)) continue;
        dd.visible.push(it);
      }

      var selectedRow = -1;
      dd.visible.forEach(function (item, i) {
        var row = document.createElement('div');
        row.className = 'dd-item';
        row.setAttribute('role', 'option');
        row.dataset.index = String(i);
        row.setAttribute('aria-selected', item.value === dd.value ? 'true' : 'false');
        if (item.disabled) {
          row.classList.add('dd-item-disabled');
          row.setAttribute('aria-disabled', 'true');
        }
        var check = document.createElement('span');
        check.className = 'dd-check';
        check.setAttribute('aria-hidden', 'true');
        check.textContent = item.value === dd.value ? '✓' : '';
        var text = document.createElement('span');
        text.className = 'dd-item-label';
        text.textContent = item.label;         // untrusted → textContent
        row.appendChild(check);
        row.appendChild(text);
        if (item.badge) {
          var badge = document.createElement('span');
          badge.className = 'dd-badge dd-badge-' + item.badgeKind;
          badge.textContent = item.badge;      // untrusted → textContent
          row.appendChild(badge);
        }
        // The most actionable explanation wins: why it is unselectable,
        // else the family warning, else the model state.
        row.title = item.disabled
          ? (item.disabledTip || item.hint || '')
          : (item.hint || item.disabledTip || '');
        if (item.disabled) row.style.cursor = 'not-allowed';
        if (item.value === dd.value) selectedRow = i;
        row.addEventListener('mousedown', function (e) {
          e.preventDefault();
          if (item.disabled) {
            // Explain instead of silently doing nothing.
            dd.showStatus(item.disabledTip || TIP_IMAGE, 'warn', 2200);
            return;
          }
          dd.close(true);
          dd.chooseVisible(i);
        });
        row.addEventListener('mouseenter', function () {
          if (!item.disabled) dd.setActive(i);
        });
        list.appendChild(row);
      });

      // Never render an empty popup: say so, and keep the list navigable.
      if (!dd.visible.length) {
        var empty = document.createElement('div');
        empty.className = 'dd-empty-row';
        empty.textContent = dd.items.length
          ? (dd.filter ? 'No matches for “' + dd.filter + '”' : (opts.emptyFilteredText || 'Nothing to show'))
          : (opts.emptyText || 'Nothing to show');
        list.appendChild(empty);
      }

      if (foot) {
        var total = dd.items.length;
        var shown = dd.visible.length;
        var filtered = !!dd.filter || (opts.predicate && shown !== total);
        foot.textContent = !filtered && !dd.filter
          ? total + (total === 1 ? ' model' : ' models')
          : 'showing ' + shown + ' of ' + total;
        foot.classList.toggle('dd-foot-filtered', filtered);
      }

      dd.activeIndex = selectedRow >= 0 ? selectedRow : 0;
      dd.setActive(dd.activeIndex);
    };

    // Brief feedback on the trigger (blocked pick, save confirmation, probe
    // result). One timer owns the status so a late timer can never wipe a
    // newer message.
    dd.showStatus = function (text, kind, ms) {
      dd.setStatus(text, kind);
      if (dd._statusTimer) clearTimeout(dd._statusTimer);
      dd._statusTimer = null;
      if (text) {
        dd._statusTimer = setTimeout(function () {
          dd._statusTimer = null;
          dd.setStatus(opts.idleStatus ? opts.idleStatus() : '');
        }, ms || SAVED_MS);
      }
    };

    // Index of `v` within the *currently visible* rows.
    dd.indexOfVisible = function (v) {
      for (var i = 0; i < dd.visible.length; i++) if (dd.visible[i].value === v) return i;
      return -1;
    };

    dd.indexOfValue = function (v) {
      for (var i = 0; i < dd.items.length; i++) if (dd.items[i].value === v) return i;
      return 0;
    };

    dd.setActive = function (i) {
      if (!dd.visible.length) { dd.activeIndex = 0; return; }
      var start = Math.max(0, Math.min(dd.visible.length - 1, i));
      // Never land the keyboard cursor on an unselectable row.
      var guard = dd.visible.length;
      while (guard-- > 0 && dd.visible[start] && dd.visible[start].disabled) {
        start = start + 1 < dd.visible.length ? start + 1 : start - 1;
      }
      dd.activeIndex = start;
      var rows = list.querySelectorAll ? list.querySelectorAll('.dd-item') : [];
      for (var k = 0; k < rows.length; k++) rows[k].classList.toggle('dd-item-active', k === dd.activeIndex);
    };

    dd.scrollActiveIntoView = function () {
      var rows = list.querySelectorAll ? list.querySelectorAll('.dd-item') : [];
      var row = rows && rows[dd.activeIndex];
      if (!row || typeof row.scrollIntoView !== 'function') return;
      try { row.scrollIntoView({ block: 'nearest' }); } catch (e) { /* ignore */ }
    };

    dd.sync = function () {
      label.textContent = dd.display();
      trigger.classList.toggle('dd-open', dd.open);
      trigger.classList.toggle('dd-empty', !dd.value);
      trigger.classList.toggle('dd-disabled', !!dd.disabled);
      trigger.disabled = !!dd.disabled;
      trigger.setAttribute('aria-expanded', dd.open ? 'true' : 'false');
      if (dd.select && dd.value) {
        dd.syncProxy();
      }
    };

    // The proxy <select> is the value authority for agent.js / ai-assistant.js.
    dd.syncProxy = function () {
      var sel = dd.select;
      if (!sel || !dd.value) return;
      var opts2 = sel.options || [];
      var found = false;
      for (var i = 0; i < opts2.length; i++) {
        if (opts2[i].value === dd.value) { found = true; break; }
      }
      if (!found) {
        var o = document.createElement('option');
        o.value = dd.value;
        o.textContent = dd.value;
        sel.appendChild(o);
      }
      sel.value = dd.value;
    };

    dd.display = function () {
      var it = dd.items[dd.indexOfValue(dd.value)];
      return it ? it.label : (dd.value || opts.placeholder || '—');
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
      dd.setFilter(dd.filter);
      dd.sync();
      if (search && search.focus) search.focus();
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

    // Select by *visible* index (what the user actually clicked / arrowed to).
    dd.chooseVisible = function (i) {
      var item = dd.visible[i];
      if (!item) return;
      if (item.disabled) {
        dd.showStatus(item.disabledTip || 'Not selectable', 'warn', 2200);
        return;
      }
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
          if (k === 'ArrowUp' && dd.visible.length) dd.setActive(dd.visible.length - 1);
        }
        return;
      }
      if (k === 'ArrowDown') {
        e.preventDefault();
        dd.setActive(dd.activeIndex + 1);
        dd.scrollActiveIntoView();
      } else if (k === 'ArrowUp') {
        e.preventDefault();
        dd.setActive(dd.activeIndex - 1);
        dd.scrollActiveIntoView();
      } else if (k === 'Home' && dd.visible.length) {
        e.preventDefault(); dd.setActive(0); dd.scrollActiveIntoView();
      } else if (k === 'End' && dd.visible.length) {
        e.preventDefault(); dd.setActive(dd.visible.length - 1); dd.scrollActiveIntoView();
      } else if (k === 'PageDown') {
        e.preventDefault(); dd.setActive(dd.activeIndex + 8); dd.scrollActiveIntoView();
      } else if (k === 'PageUp') {
        e.preventDefault(); dd.setActive(dd.activeIndex - 8); dd.scrollActiveIntoView();
      } else if (k === 'Enter' || (k === ' ' && !(search && search === e.target))) {
        e.preventDefault();
        dd.close(true);
        dd.chooseVisible(dd.activeIndex);
      } else if (k === 'Tab') {
        dd.close();
      }
    };

    trigger.addEventListener('keydown', dd.onKeydown);
    trigger.addEventListener('click', function () { dd.toggle(); });
    menu.addEventListener('keydown', function (e) { dd.onKeydown(e); });
    if (search) {
      search.addEventListener('input', function () { dd.setFilter(search.value); });
      // Clicking the filter box must not toggle the trigger.
      search.addEventListener('click', function (e) { e.stopPropagation(); });
      search.addEventListener('keydown', function (e) {
        // Printable characters belong to the filter, not the menu.
        if (e.key.length === 1 || e.key === 'Backspace') e.stopPropagation();
      });
    }
    // Keep focus inside the widget while the popup is open.
    trigger.addEventListener('blur', function () {
      if (!dd.open) return;
      if (root.contains(document.activeElement)) return;
      dd.close();
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
    // Scroll (capture) covers the panel resize handle + any scrollable
    // ancestor — but scrolling *inside* the popup must not close it.
    global.document.addEventListener('scroll', function (e) {
      var dd = self._openDropdown;
      if (!dd) return;
      if (e && e.target && dd.root && dd.root.contains(e.target)) return;
      dd.close();
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
    this._modelListOk = false;
    // Switch state machine: 'idle' | 'saving' | 'saved' | 'failed'
    this._modelSaveState = 'idle';
    this._modelAgentOnly = false;
    this._modelError = null;      // { model, message }
    this._saveError = null;       // { model, message } — failed persistence
    this._probeResult = null;     // { kind, text, pending, model }
    this._probeSeq = 0;
    this._probeTimer = null;
    this._lastGoodModel = this._readLastGoodModel();
    this.el.model.addEventListener('change', function () {
      self.setModel(self.el.model.value);
    });
    this.modelDd = this._createDropdown({
      key: 'model',
      id: 'model-dd',
      select: this.el.model,
      searchable: true,
      searchPlaceholder: 'Type to filter models…',
      emptyText: 'No models available',
      emptyFilteredText: 'No agent-friendly models match this filter',
      placeholder: DEFAULT_MODEL,
      // Model ids come from the server: they are only ever compared as
      // strings (never injected as markup), and the toggle filters on them.
      predicate: function (value) {
        return !self._modelAgentOnly || isAgentFriendlyModel(value);
      },
      buildExtras: function (dd) { return self._buildModelExtras(); },
      // Keep the pending failure visible while the trigger shows a save state.
      idleStatus: function () {
        return (self._modelError && self._modelError.model === self._model)
          ? '⚠ ' + String(self._modelError.message || 'error').slice(0, 40)
          : '';
      },
      onChange: function (v) { self.setModel(v); }
    });
    this._buildErrorBar();
    this._watchAiErrors();
    this._loadModel();
  };

  // ---------------------------- model popup chrome --------------------------

  // Action panel pinned between the filter box and the list: agent-friendly
  // toggle, Test connection, live probe result, and the recovery actions that
  // appear only when there is something to recover from.
  ChatControls.prototype._buildModelExtras = function () {
    var self = this;
    var box = document.createElement('div');
    box.className = 'dd-extras';

    var row = document.createElement('div');
    row.className = 'dd-extras-row';

    // "Agent-friendly only" — the fix for "switching seems broken": most of
    // the list cannot drive the agent at all.
    var toggle = document.createElement('label');
    toggle.className = 'dd-toggle';
    toggle.title = 'Show only models known to follow the agent tool protocol';
    var box2 = document.createElement('input');
    box2.type = 'checkbox';
    box2.className = 'dd-toggle-box';
    box2.checked = false;
    var tText = document.createElement('span');
    tText.className = 'dd-toggle-text';
    tText.textContent = 'Agent-friendly only';
    toggle.appendChild(box2);
    toggle.appendChild(tText);
    box2.addEventListener('change', function () {
      self._modelAgentOnly = !!box2.checked;
      self.modelDd.setFilter(self.modelDd.filter);
    });

    var test = document.createElement('button');
    test.type = 'button';
    test.className = 'dd-action dd-action-test';
    test.textContent = 'Test connection';
    test.title = 'Send a one-word prompt to the selected model (20 s limit)';
    test.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); });
    test.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      self.testModelConnection();
    });

    row.appendChild(toggle);
    row.appendChild(test);
    box.appendChild(row);

    // Probe result line (textContent only — error text is untrusted).
    var out = document.createElement('div');
    out.className = 'dd-probe';
    out.hidden = true;
    out.setAttribute('role', 'status');
    box.appendChild(out);

    // Recovery actions: retry the last prompt / go back to a working model.
    var fix = document.createElement('div');
    fix.className = 'dd-extras-fix';
    fix.hidden = true;

    var retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'dd-action dd-action-retry';
    retry.textContent = 'Retry last prompt';
    retry.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); });
    retry.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); self.retryLastPrompt(); });

    var save = document.createElement('button');
    save.type = 'button';
    save.className = 'dd-action dd-action-save';
    save.textContent = 'Retry save';
    save.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); });
    save.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); self.retryModelSave(); });

    var good = document.createElement('button');
    good.type = 'button';
    good.className = 'dd-action dd-action-good';
    good.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); });
    good.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); self.restoreLastGoodModel(); });

    var coder = document.createElement('button');
    coder.type = 'button';
    coder.className = 'dd-action dd-action-coder';
    coder.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); });
    coder.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); self.setModel(DEFAULT_MODEL); });

    fix.appendChild(retry);
    fix.appendChild(save);
    fix.appendChild(good);
    fix.appendChild(coder);
    box.appendChild(fix);

    this._modelExtras = {
      box: box, out: out, fix: fix,
      retry: retry, save: save, good: good, coder: coder, test: test
    };
    return box;
  };

  // Which recovery actions are offered, right now:
  //  - a failed save            → "Retry save"
  //  - a failed request on the  → "Retry last prompt", "Restore last working
  //    current model              model", and "Switch to <coder>" when the
  //                                failing model is not itself a coder model
  ChatControls.prototype._renderFix = function () {
    var x = this._modelExtras;
    if (!x) return;
    var saveFailed = !!this._saveError;
    var failedModel = this._modelError && this._modelError.model === this._model;
    var show = saveFailed || !!failedModel;
    x.fix.hidden = !show;
    x.save.hidden = !saveFailed;
    x.retry.hidden = !failedModel;
    x.good.hidden = !failedModel || !this._lastGoodModel || this._lastGoodModel === this._model;
    x.good.textContent = this._lastGoodModel
      ? 'Restore last working model (' + this._lastGoodModel + ')'
      : 'Restore last working model';
    // Only offer the coder suggestion when it is a different model that is
    // actually available in the list.
    var hasCoder = false;
    if (this.modelDd) {
      for (var i = 0; i < this.modelDd.items.length; i++) {
        if (this.modelDd.items[i].value === DEFAULT_MODEL) { hasCoder = true; break; }
      }
    }
    var offerCoder = failedModel && !isCoderModel(String(this._model).toLowerCase())
      && this._model !== DEFAULT_MODEL && hasCoder;
    x.coder.hidden = !offerCoder;
    x.coder.textContent = 'Switch to ' + DEFAULT_MODEL;
  };

  // Control-bar error affordance (always visible when there is an error).
  ChatControls.prototype._renderModelError = function () {
    var e = this._errorBar;
    if (!e) return;
    var err = this._modelError;
    if (!err) {
      e.root.hidden = true;
      return;
    }
    e.root.hidden = false;
    e.msg.textContent = err.model + ': ' + String(err.message || 'request failed');
    e.root.title = 'Last AI request failed on ' + err.model;
    this._renderFix();
  };

  ChatControls.prototype._clearModelError = function () {
    this._modelError = null;
    this._renderModelError();
  };

  /* ---- failure intake ------------------------------------------------ */
  // Every failure path funnels through here so the ⚠, the control-bar retry
  // and the "switch to a coder model" suggestion are consistent.
  ChatControls.prototype.noteAiError = function (err, model) {
    var m = (typeof model === 'string' && model) ? model : this._model;
    if (!m) return;
    var msg = (err && err.message) ? err.message : String(err == null ? 'unknown error' : err);
    this._modelError = { model: m, message: msg };
    // Repaint so the failing entry carries the ⚠ badge.
    if (this.modelDd && this.modelDd.items.length) {
      this._setOptions(this.modelDd.items.map(function (it) { return it.value; }), this._modelListOk);
    } else {
      this._renderModelError();
    }
  };

  // "Model doesn't respond" arrives from three places; all three are wired.
  ChatControls.prototype._watchAiErrors = function () {
    var self = this;
    function onErr(e) {
      var msg = (e && e.detail && (e.detail.message || e.detail.error)) || (e && e.detail) || null;
      self.noteAiError(msg);
    }
    global.addEventListener('chat:error', onErr);
    global.addEventListener('ai:error', onErr);
    try {
      var api = global.electronAPI;
      if (api && typeof api.onAiError === 'function') {
        api.onAiError(function (err) { self.noteAiError(err); });
      }
    } catch (e) { /* ignore */ }
  };

  // Re-send the last user prompt. Prefers the in-memory history, falls back to
  // whatever is in the composer; never throws.
  ChatControls.prototype.retryLastPrompt = function () {
    var text = '';
    try {
      var ai = global.ai;
      if (ai && ai.history && ai.history.length) {
        for (var i = ai.history.length - 1; i >= 0; i--) {
          if (ai.history[i] && ai.history[i].role === 'user' && ai.history[i].content) {
            text = String(ai.history[i].content);
            break;
          }
        }
      }
      if (!text && ai && ai.input && ai.input.value) text = String(ai.input.value);
    } catch (e) { /* ignore */ }
    if (!text) {
      if (this.modelDd) this.modelDd.showStatus('No prompt to retry', 'warn', 2000);
      return false;
    }
    try {
      var ai2 = global.ai;
      if (ai2 && typeof ai2.sendPromptWithContext === 'function') {
        ai2.sendPromptWithContext(text);
      } else if (ai2 && ai2.input && typeof ai2.handleSend === 'function') {
        ai2.input.value = text;
        ai2.handleSend();
      } else {
        throw new Error('no assistant');
      }
    } catch (e) {
      this.noteAiError((e && e.message) || e, this._model);
      return false;
    }
    this._renderModelError();
    return true;
  };


  // Always-on last-error affordance in the control bar, next to the model
  // trigger. Hidden while there is no error.
  ChatControls.prototype._buildErrorBar = function () {
    var self = this;
    var bar = document.createElement('div');
    bar.className = 'cc-model-error';
    bar.hidden = true;
    bar.setAttribute('role', 'alert');

    var icon = document.createElement('span');
    icon.className = 'cc-model-error-icon';
    icon.textContent = '⚠';

    var msg = document.createElement('span');
    msg.className = 'cc-model-error-msg';

    var retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'cc-model-error-btn';
    retry.textContent = 'Retry';
    retry.addEventListener('click', function () { self.retryLastPrompt(); });

    bar.appendChild(icon);
    bar.appendChild(msg);
    bar.appendChild(retry);

    this._errorBar = { root: bar, msg: msg, retry: retry };

    // Park it in the bar, immediately after the model dropdown.
    var host = this.el.bar;
    if (host && this.modelDd && this.modelDd.root.parentNode === host) {
      host.insertBefore(bar, this.modelDd.root.nextSibling);
    } else if (host) {
      host.appendChild(bar);
    }
  };

  // ------------------------- last known-good model --------------------------

  ChatControls.prototype._readLastGoodModel = function () {
    try {
      var v = global.localStorage && global.localStorage.getItem(LS_GOOD_MODEL);
      return typeof v === 'string' && v ? v : null;
    } catch (e) { return null; }
  };

  ChatControls.prototype._writeLastGoodModel = function (m) {
    if (typeof m !== 'string' || !m) return;
    this._lastGoodModel = m;
    try {
      if (global.localStorage) global.localStorage.setItem(LS_GOOD_MODEL, m);
    } catch (e) { /* ignore */ }
  };

  // A model is "known good" once it has proven it can answer a request.
  ChatControls.prototype.markModelGood = function (m) {
    if (typeof m !== 'string' || !m) return;
    if (this._lastGoodModel !== m) this._writeLastGoodModel(m);
    if (this._modelError && this._modelError.model === m) this._clearModelError();
    else this._renderModelError();
  };

  // Called after a failed request so a good switch can be undone.
  ChatControls.prototype.restoreLastGoodModel = function () {
    var m = this._lastGoodModel;
    if (!m) {
      if (this.modelDd) this.modelDd.showStatus('No known-good model yet', 'warn', 2200);
      return false;
    }
    if (m === this._model) {
      if (this.modelDd) this.modelDd.showStatus('Already on ' + m, 'warn', 1600);
      return false;
    }
    this.setModel(m);
    return true;
  };


  ChatControls.prototype._loadModel = function () {
    var self = this;
    var api = global.electronAPI;
    var current = this._model;

    // getAiConfig() is asynchronous (IPC). Reading it synchronously used to
    // yield `undefined`, so the control bar booted showing the default model
    // while the saved config held another one — the dropdown then looked like
    // switching models "did nothing". Handle both shapes.
    var applyCfg = function (cfg) {
      if (!cfg || typeof cfg.model !== 'string' || !cfg.model) return false;
      if (cfg.model === self._model) return true;
      if (self._booted) {
        // Full path: proxy, label, persistence, event.
        self.setModel(cfg.model);
      } else {
        // Still booting: remember it and re-render so the label/proxy already
        // show the saved model; the model list lands right after.
        self._model = cfg.model;
        if (typeof self._setOptions === 'function') self._setOptions([], self._modelListOk !== false);
      }
      return true;
    };

    var raw = null;
    try {
      if (api && typeof api.getAiConfig === 'function') raw = api.getAiConfig();
    } catch (e) {
      console.debug('chat-controls: getAiConfig failed', e);
    }

    if (raw && typeof raw.then === 'function') {
      // Async IPC: keep booting with what we have; the saved model is applied
      // as soon as it arrives (and re-renders the list that follows).
      raw.then(applyCfg).catch(function (e) {
        console.debug('chat-controls: getAiConfig failed', e);
      });
    } else {
      applyCfg(raw);
    }

    // Optimistic single-entry list: the popup is never empty, even before the
    // server answers (or if it never does).
    this._setOptions([], false);

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
      var models = normalizeModels(list);
      // _setOptions prepends the active model itself when it is missing and
      // never truncates, so hundreds of models render in full.
      self._setOptions(models, models.length > 0);
    }).catch(function (e) {
      console.debug('chat-controls: listAiModels failed', e);
      self._setOptions([], false);
    });
  };

  // Rebuilds both the hidden proxy's options and the visible dropdown.
  // `ok` is false when the server list was unavailable → the popup keeps the
  // configured model alone and says so instead of silently showing nothing.
  ChatControls.prototype._setOptions = function (models, ok) {
    var self = this;
    var sel = this.el.model;
    var current = this._model;
    this._modelListOk = ok !== false;

    // De-duplicate case-insensitively (normalizeModels already does, but
    // setModel() can inject entries later).
    var seen = Object.create(null);
    var list = [];
    (models || []).forEach(function (m) {
      if (typeof m !== 'string') return;
      m = m.trim();
      if (!m) return;
      var key = m.toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      list.push(m);
    });
    // Never drop the active model: prepend it if the server didn't list it.
    var ci = seen[String(current).toLowerCase()];
    if (current && !ci) { list.unshift(current); seen[String(current).toLowerCase()] = true; }
    if (list.length === 0) list = [current || DEFAULT_MODEL];
    // Current model first, then alphabetical.
    list.sort(function (a, b) {
      if (a === current) return -1;
      if (b === current) return 1;
      var x = a.toLowerCase(), y = b.toLowerCase();
      return x < y ? -1 : (x > y ? 1 : 0);
    });

    // The proxy <select> holds EVERY model — agent.js / ai-assistant.js read
    // `.value` from it, and anything reading `.options` sees the full list.
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
      var solo = list.length < 2;
      var keepFilter = this.modelDd.filter;
      this.modelDd.disabled = false;
      this.modelDd.trigger.classList.toggle('dd-solo', solo);
      this.modelDd.trigger.title = solo
        ? 'Could not reach the model server — showing the configured model (' + current + ')'
        : 'AI model used for chat and agent requests · ' + list.length + ' available';
      this.modelDd.setItems(list.map(function (m) {
        var c = classifyModel(m);
        var failed = self._modelError && self._modelError.model === m;
        var parts = [];
        if (m === current) parts.push('Currently selected');
        if (c.tip) parts.push(c.tip);
        if (solo && m !== current) parts.push('Model server unreachable');
        if (failed) parts.unshift('Last request failed: ' + String(self._modelError.message || 'unknown error'));
        return {
          value: m,
          label: m,
          badge: failed ? '⚠' : c.badge,
          badgeKind: failed ? 'error' : (c.family === 'coder' ? 'good' : (c.badge ? 'warn' : 'plain')),
          disabled: c.disabled,
          disabledTip: c.tip,
          hint: parts.join(' · ')
        };
      }), current);
      // Rebuilding the list must not silently drop what the user typed.
      if (keepFilter) this.modelDd.setFilter(keepFilter);
      this._renderProbe();
      this._renderModelError();
    }
  };

  ChatControls.prototype.setModel = function (m) {
    if (!this._booted || !this.el.model) return;
    if (typeof m !== 'string' || !m) return;
    this._model = m;
    if (this.modelDd) this.modelDd.syncProxy();
    else if (this.el.model) {
      var opts = this.el.model.options || [];
      var found = false;
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
        this.modelDd.items = [{
          value: m,
          label: m,
          hint: 'Currently selected',
          badge: classifyModel(m).badge,
          badgeKind: 'plain',
          disabled: classifyModel(m).disabled,
          disabledTip: classifyModel(m).tip
        }].concat(this.modelDd.items);
      }
      this.modelDd.value = m;
      this.modelDd.renderMenu();
      this.modelDd.sync();
    }
    // The proxy is authoritative immediately; persistence is confirmed
    // asynchronously and reported on the trigger (see _persistModel).
    this._persistModel(m);
    global.dispatchEvent(new CustomEvent('chat:model-changed', { detail: { model: m } }));
  };

  /* ---- switch state machine -------------------------------------------
     idle ──setModel()──► saving ──resolved──► saved ──1.2 s──► idle
                            │
                            └──rejected/threw──► failed ──► idle
                                                        (Retry stays available)

     `saved` is only claimed when `updateAiConfig` actually resolved — the
     whole point is that the user can trust the confirmation.
     --------------------------------------------------------------------- */
  ChatControls.prototype._setSaveState = function (state, errText) {
    this._modelSaveState = state;
    var dd = this.modelDd;
    if (!dd) return;
    if (state === 'saving') {
      dd.showStatus('saving…', 'saving');
    } else if (state === 'saved') {
      this._saveError = null;
      dd.showStatus('✓ Saved', 'ok', SAVED_MS);
      this._renderFix();
    } else if (state === 'failed') {
      this._saveError = { model: this._model, message: String(errText || 'update failed') };
      dd.showStatus('✗ Could not save', 'error', 3000);
      this._renderFix();
    } else {
      this._setSaveStateLabel();
    }
  };

  // Restore the idle status (which may be the ⚠ last-error line).
  ChatControls.prototype._setSaveStateLabel = function () {
    var dd = this.modelDd;
    if (!dd) return;
    var idle = '';
    if (this._saveError && this._saveError.model === this._model) {
      idle = '⚠ not saved';
    } else if (this._modelError && this._modelError.model === this._model) {
      idle = '⚠ ' + String(this._modelError.message || 'error').slice(0, 40);
    }
    if (idle) dd.showStatus(idle, 'error', 3000);
    else dd.showStatus('');
  };

  ChatControls.prototype._persistModel = function (m) {
    var self = this;
    var api = global.electronAPI;
    if (!api || typeof api.updateAiConfig !== 'function') {
      // No bridge: the proxy still holds the value for this session.
      this._setSaveState('failed', 'no AI bridge');
      return;
    }
    this._setSaveState('saving');
    var res;
    try {
      res = api.updateAiConfig({ model: m });
    } catch (e) {
      console.debug('chat-controls: updateAiConfig failed', e);
      this._setSaveState('failed', (e && e.message) || e);
      return;
    }
    if (!res || typeof res.then !== 'function') {
      // Synchronous bridge (or test double): it cannot have failed loudly.
      this._setSaveState('saved');
      return;
    }
    res.then(function () {
      // A newer switch may have landed while this one was in flight.
      if (self._model !== m) return;
      self._setSaveState('saved');
    }).catch(function (e) {
      console.debug('chat-controls: updateAiConfig failed', e);
      self._setSaveState('failed', (e && e.message) || e);
    });
  };

  // Explicit re-attempt after a failed save.
  ChatControls.prototype.retryModelSave = function () {
    if (!this._model) return false;
    this._persistModel(this._model);
    return true;
  };

  /* ---- health probe ---------------------------------------------------
     One `aiChatOnce` with a 3-token prompt against the *currently selected*
     model, raced against a 20 s timeout. Never throws: every outcome ends up
     as a line of text in the popup (and a status on the trigger).
     --------------------------------------------------------------------- */
  ChatControls.prototype._renderProbe = function () {
    var x = this._modelExtras;
    if (!x || !x.out) return;
    var p = this._probeResult;
    if (!p) {
      x.out.hidden = true;
      x.out.textContent = '';
      x.out.className = 'dd-probe';
      x.test.disabled = false;
      x.test.textContent = 'Test connection';
      return;
    }
    x.out.hidden = false;
    x.out.className = 'dd-probe dd-probe-' + p.kind;
    // Untrusted model id + server error text → textContent only.
    x.out.textContent = p.text;
    if (p.pending) {
      x.test.disabled = true;
      x.test.textContent = 'Testing…';
    } else {
      x.test.disabled = false;
      x.test.textContent = 'Test connection';
    }
  };

  ChatControls.prototype.testModelConnection = function (model) {
    var self = this;
    var m = (typeof model === 'string' && model) ? model : this._model;
    var api = global.electronAPI;

    if (!m) {
      this._probeResult = { kind: 'bad', text: '✗ no model selected', pending: false };
      this._renderProbe();
      return Promise.resolve(false);
    }
    if (!api || typeof api.aiChatOnce !== 'function') {
      this._probeResult = { kind: 'bad', text: '✗ AI bridge unavailable — cannot test', pending: false };
      this._renderProbe();
      if (this.modelDd) this.modelDd.showStatus('✗ no AI bridge', 'error', 2500);
      return Promise.resolve(false);
    }

    var started = Date.now();
    var reqId = 'cc-probe-' + (++this._probeSeq);
    this._probeResult = { kind: 'pending', text: '… testing ' + m, pending: true, model: m };
    this._renderProbe();
    if (this.modelDd) this.modelDd.showStatus('testing…', 'saving', PROBE_TIMEOUT_MS);

    var payload = {
      id: reqId,
      model: m,
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
      maxTokens: 16,
      temperature: 0
    };

    var settled = false;
    var call;
    try {
      call = api.aiChatOnce(payload);
    } catch (e) {
      return this._probeFail(m, (e && e.message) || e, Date.now() - started);
    }
    if (!call || typeof call.then !== 'function') {
      // Synchronous test double / bridge: no error means it answered.
      return this._probeOk(m, Date.now() - started);
    }

    var timeout = new Promise(function (resolve) {
      self._probeTimer = setTimeout(function () { resolve({ __ccTimeout: true }); }, PROBE_TIMEOUT_MS);
    });

    return Promise.race([call, timeout]).then(function (res) {
      if (settled) return false;
      settled = true;
      if (self._probeTimer) { clearTimeout(self._probeTimer); self._probeTimer = null; }
      if (res && res.__ccTimeout) {
        // Best effort: tell the main process to drop the HTTP request.
        try {
          if (typeof api.aiCancelOnce === 'function') api.aiCancelOnce(reqId);
        } catch (e) { /* ignore */ }
        return self._probeFail(m, 'timed out after ' + Math.round(PROBE_TIMEOUT_MS / 1000) + ' s — model does not respond', Date.now() - started, true);
      }
      if (res && res.error) return self._probeFail(m, res.error, Date.now() - started);
      return self._probeOk(m, Date.now() - started);
    }).catch(function (e) {
      if (settled) return false;
      settled = true;
      if (self._probeTimer) { clearTimeout(self._probeTimer); self._probeTimer = null; }
      return self._probeFail(m, (e && e.message) || e, Date.now() - started);
    });
  };

  ChatControls.prototype._probeOk = function (m, ms) {
    this._probeResult = {
      kind: 'good',
      pending: false,
      model: m,
      text: '✓ ' + m + ' works (' + Math.max(0, Math.round(ms)) + ' ms)'
    };
    this._renderProbe();
    if (this.modelDd) this.modelDd.showStatus('✓ ' + Math.max(0, Math.round(ms)) + ' ms', 'ok', 1800);
    // It answered → it is a known-good model for this workspace.
    this.markModelGood(m);
    return true;
  };

  ChatControls.prototype._probeFail = function (m, errText, ms, isTimeout) {
    var msg = String(errText == null ? 'unknown error' : errText);
    this._probeResult = {
      kind: 'bad',
      pending: false,
      model: m,
      text: '✗ ' + m + ' failed: ' + msg + (isTimeout ? '' : ' (' + Math.max(0, Math.round(ms)) + ' ms)')
    };
    this._renderProbe();
    if (this.modelDd) this.modelDd.showStatus('✗ no response', 'error', 3000);
    this.noteAiError(msg, m);
    return false;
  };

  // --------------------------- autonomy mode --------------------------------
  // The agent run bar owns `#agent-mode-select`; this is the same setting
  // surfaced in the chat control bar next to think level and model. Both
  // read/write `AppSettings.get/set('agentMode')` and stay in sync through
  // the `agent:mode-changed` (window) and `settings-changed` (document)
  // events.
  ChatControls.prototype._initAgentMode = function () {
    var self = this;
    this._initGlobalDismiss();

    this._agentMode = this._readAgentMode();

    this.agentDd = this._createDropdown({
      key: 'agentMode',
      id: 'agent-mode-dd',
      // No proxy <select> exists in the control bar: settings.js owns the
      // storage, so `get/set('agentMode')` is the single source of truth.
      select: null,
      placeholder: AGENT_MODE_LABELS[DEFAULT_AGENT_MODE],
      onChange: function (v) { self.setAgentMode(v, true); }
    });

    // Park it in the bar, right after the model dropdown and before 📎.
    this.agentDd.root.classList.add('dd-mode');
    var host = this.el.bar;
    if (host) {
      var anchor = this.el.attach;
      if (anchor && anchor.parentNode === host) host.insertBefore(this.agentDd.root, anchor);
      else host.appendChild(this.agentDd.root);
    }

    this.agentDd.setItems(AGENT_MODES.map(function (m) {
      return { value: m, label: AGENT_MODE_LABELS[m], hint: AGENT_MODE_HINTS[m] };
    }), this._agentMode);
    this._syncAgentModeUi(this._agentMode);

    // The run bar's own select (or anything else) can change the mode.
    global.addEventListener('agent:mode-changed', function (e) {
      var m = e && e.detail ? e.detail.mode : null;
      self._syncAgentModeUi(self._normalizeAgentMode(m));
    });

    // …and so can the settings modal.
    global.document.addEventListener('settings-changed', function () {
      self._syncAgentModeUi(self._readAgentMode());
    });
  };

  // Read the persisted mode (settings.js is authoritative; 'ask' if unknown).
  ChatControls.prototype.getAgentMode = function () {
    return this._agentMode || DEFAULT_AGENT_MODE;
  };

  ChatControls.prototype._readAgentMode = function () {
    try {
      var s = global.AppSettings;
      if (s && typeof s.get === 'function') {
        return this._normalizeAgentMode(s.get('agentMode'));
      }
    } catch (e) { /* fall through to the default */ }
    return DEFAULT_AGENT_MODE;
  };

  ChatControls.prototype._normalizeAgentMode = function (v) {
    return AGENT_MODES.indexOf(v) === -1 ? DEFAULT_AGENT_MODE : v;
  };

  // `broadcast` = the user picked here; otherwise we are mirroring a change
  // that came from elsewhere and must not echo it back.
  ChatControls.prototype.setAgentMode = function (mode, broadcast) {
    if (!this._booted) return;
    var m = this._normalizeAgentMode(mode);
    var changed = m !== this._agentMode;
    this._agentMode = m;
    if (this.agentDd) {
      this.agentDd.value = m;
      this.agentDd.renderMenu();
      this.agentDd.sync();
    }
    this._syncAgentModeUi(m);
    if (!changed && !broadcast) return;
    try {
      var s = global.AppSettings;
      if (s && typeof s.set === 'function') {
        var r = s.set('agentMode', m);
        if (r && typeof r.then === 'function') {
          r.catch(function (e) { console.debug('chat-controls: save agentMode failed', e); });
        }
      }
    } catch (e) { /* ignore */ }
    if (broadcast === false) return;
    try {
      global.dispatchEvent(new CustomEvent('agent:mode-changed', { detail: { mode: m } }));
    } catch (e) { /* CustomEvent unavailable */ }
    try {
      global.dispatchEvent(new CustomEvent('chat:agent-mode-changed', { detail: { mode: m } }));
    } catch (e) { /* ignore */ }
  };

  // Push a mode into the visible dropdown (no writes, no re-broadcast).
  ChatControls.prototype._syncAgentModeUi = function (mode) {
    var m = this._normalizeAgentMode(mode);
    this._agentMode = m;
    if (this.agentDd) {
      this.agentDd.value = m;
      this.agentDd.renderMenu();
      this.agentDd.sync();
      var it = this.agentDd.items[this.agentDd.indexOfValue(m)];
      this.agentDd.trigger.title = 'Autonomy mode — '
        + (it ? it.label : m) + '. ' + AGENT_MODE_HINTS[m];
    }
    // Keep the agent run bar's native select in step (value only → no loop).
    var runSelect = global.document.getElementById('agent-mode-select');
    if (runSelect && runSelect.value !== m) runSelect.value = m;
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

    // Count badge first so "how much context is attached" is readable at a
    // glance even when the chips themselves scroll out of view.
    var count = document.createElement('span');
    count.className = 'attach-count';
    count.textContent = this.attachments.length + ' attached';
    box.appendChild(count);

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
