/* Chat Features for Cloud Code — slash commands, token meter, export chat.
 * Classic script (no modules). Exposes window.ChatFeatures and auto-boots. */
(function () {
  'use strict';

  var COMMANDS = [
    { name: 'explain',   label: '/explain',   desc: 'Explain the code in the active file or selection',
      prompt: 'Explain the following code in the active file or the text I provide: ' },
    { name: 'fix',       label: '/fix',       desc: 'Find and fix bugs in the code',
      prompt: 'Find and fix any bugs or errors in the following code from the active file or the text I provide: ' },
    { name: 'refactor',  label: '/refactor',  desc: 'Refactor code to be cleaner',
      prompt: 'Refactor the following code from the active file or the text I provide to be cleaner and more maintainable: ' },
    { name: 'test',      label: '/test',      desc: 'Generate unit tests',
      prompt: 'Generate comprehensive unit tests for the following code from the active file or the text I provide: ' },
    { name: 'document',  label: '/document',  desc: 'Write documentation / docstrings',
      prompt: 'Write clear documentation (docstrings and comments) for the following code from the active file or the text I provide: ' },
    { name: 'summarize', label: '/summarize', desc: 'Summarize the provided text/code',
      prompt: 'Summarize the following text or code concisely: ' },
    { name: 'help',      label: '/help',      desc: 'List available slash commands',
      prompt: 'List the available slash commands and what each does. The commands are: ' }
  ];

  function commandByName(name) {
    for (var i = 0; i < COMMANDS.length; i++) {
      if (COMMANDS[i].name === name) return COMMANDS[i];
    }
    return null;
  }

  /* Expand a leading /command into its full prompt. Unknown commands and
   * plain text pass through unchanged. */
  function expand(text) {
    if (typeof text !== 'string' || text.charAt(0) !== '/') return text;
    var m = text.match(/^\/([A-Za-z]+)([\s\S]*)$/);
    if (!m) return text;
    var cmd = commandByName(m[1].toLowerCase());
    if (!cmd) return text;
    var rest = m[2].replace(/^\s+/, '');
    if (cmd.name === 'help') {
      try {
        if (window.ai && typeof window.ai.renderNotice === 'function') {
          window.ai.renderNotice(
            'Slash commands: ' + COMMANDS.map(function (c) { return c.label + ' — ' + c.desc; }).join(' · '),
            'info'
          );
        }
      } catch (e) { /* notice is best-effort */ }
      return cmd.prompt + COMMANDS.map(function (c) { return c.label; }).join(', ') + (rest ? '\n\n' + rest : '');
    }
    return cmd.prompt + rest;
  }

  /* ---------------- Slash-command suggestion popup ---------------- */
  function SlashPopup(input) {
    this.input = input;
    this.el = document.createElement('div');
    this.el.className = 'ccf-slash-popup hidden';
    var parent = input.parentNode;
    if (parent) parent.appendChild(this.el);
    this.items = [];
    this.active = 0;
    this.visible = false;
  }

  SlashPopup.prototype.currentToken = function () {
    var v = this.input.value;
    if (v.charAt(0) !== '/') return null;
    if (/\s/.test(v)) return null; // command token finished — hide while typing args
    return v.slice(1);
  };

  SlashPopup.prototype.open = function (filter) {
    var q = (filter || '').toLowerCase();
    this.items = COMMANDS.filter(function (c) {
      return c.name.indexOf(q) === 0 || c.label.slice(1).indexOf(q) === 0;
    });
    if (!this.items.length) { this.close(); return; }
    this.active = 0;
    this.render();
    this.el.classList.remove('hidden');
    this.visible = true;
  };

  SlashPopup.prototype.close = function () {
    this.el.classList.add('hidden');
    this.visible = false;
    this.items = [];
  };

  SlashPopup.prototype.render = function () {
    var self = this;
    this.el.innerHTML = '';
    this.items.forEach(function (c, i) {
      var row = document.createElement('div');
      row.className = 'ccf-slash-item' + (i === self.active ? ' active' : '');
      row.innerHTML = '<span class="ccf-slash-label">' + c.label + '</span>' +
                      '<span class="ccf-slash-desc"></span>';
      row.querySelector('.ccf-slash-desc').textContent = c.desc;
      row.addEventListener('mousedown', function (e) {
        e.preventDefault();
        self.select(i);
      });
      self.el.appendChild(row);
    });
  };

  SlashPopup.prototype.move = function (delta) {
    if (!this.visible || !this.items.length) return;
    this.active = (this.active + delta + this.items.length) % this.items.length;
    this.render();
  };

  SlashPopup.prototype.select = function (i) {
    var c = this.items[i];
    if (!c) return;
    var v = this.input.value;
    var rest = '';
    var sp = v.indexOf(' ');
    var nl = v.indexOf('\n');
    var end = -1;
    if (sp !== -1) end = sp;
    if (nl !== -1 && (end === -1 || nl < end)) end = nl;
    if (end !== -1) rest = v.slice(end).replace(/^\s+/, '');
    this.input.value = '/' + c.name + (rest ? ' ' + rest : ' ');
    try {
      this.input.selectionStart = this.input.selectionEnd = this.input.value.length;
      this.input.focus();
      this.input.dispatchEvent(new Event('input', { bubbles: true }));
    } catch (e) { /* ignore */ }
    this.close();
    if (c.name === 'help') {
      try {
        if (window.ai && typeof window.ai.renderNotice === 'function') {
          window.ai.renderNotice(
            'Slash commands: ' + COMMANDS.map(function (x) { return x.label + ' — ' + x.desc; }).join(' · '),
            'info'
          );
        }
      } catch (e) { /* ignore */ }
    }
  };

  /* ---------------- Token / context meter ---------------- */
  function formatTokens(n) {
    if (n >= 1000) return '~' + (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k tokens';
    return '~' + n + ' tokens';
  }

  function estimateTokens() {
    var container = document.getElementById('chat-messages');
    if (!container) return 0;
    var chars = 0;
    var kids = container.children;
    for (var i = 0; i < kids.length; i++) {
      chars += (kids[i].textContent || '').length;
    }
    return Math.ceil(chars / 4);
  }

  function mountTokenMeter() {
    if (document.getElementById('ccf-token-meter')) return;
    var chip = document.createElement('span');
    chip.id = 'ccf-token-meter';
    chip.className = 'ccf-token-meter';
    chip.title = 'Estimated tokens in this conversation';
    chip.textContent = '~0 tokens';
    var bar = document.getElementById('chat-control-bar');
    if (bar) {
      bar.appendChild(chip);
    } else {
      var wrapper = document.querySelector('.input-box-wrapper');
      if (wrapper && wrapper.parentNode) wrapper.parentNode.insertBefore(chip, wrapper);
    }
    var update = function () {
      try { chip.textContent = formatTokens(estimateTokens()); } catch (e) { /* ignore */ }
    };
    update();
    setInterval(update, 2000);
    var input = document.getElementById('chat-input');
    if (input) {
      var t = null;
      input.addEventListener('input', function () {
        clearTimeout(t);
        t = setTimeout(update, 400);
      });
    }
  }

  /* ---------------- Export chat ---------------- */
  function exportChat() {
    var container = document.getElementById('chat-messages');
    var nodes = container ? container.querySelectorAll('.chat-msg') : [];
    var sections = [];
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var role = node.classList.contains('user') ? 'User' : 'Assistant';
      var body = node.querySelector ? node.querySelector('.msg-body') : null;
      var text = (typeof node._aiSourceText === 'string' && node._aiSourceText) ||
                 (body ? body.textContent : '') || node.textContent || '';
      text = text.replace(/\s+$/g, '');
      if (!text.trim()) continue; // skip empty/welcome placeholders
      sections.push('## ' + role + '\n\n' + text);
    }
    if (!sections.length) {
      try {
        if (window.ai && typeof window.ai.renderNotice === 'function') {
          window.ai.renderNotice('Nothing to export yet — send a message first.', 'info');
        }
      } catch (e) { /* ignore */ }
      return;
    }
    var md = '# Cloud Code Chat Export\n\n' + sections.join('\n\n') + '\n';
    try {
      var blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'cloud-code-chat.md';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { try { URL.revokeObjectURL(a.href); } catch (e) { /* ignore */ } }, 2000);
    } catch (e) {
      try {
        if (window.ai && typeof window.ai.renderNotice === 'function') {
          window.ai.renderNotice('Export failed: ' + (e && e.message ? e.message : e), 'error');
        }
      } catch (e2) { /* ignore */ }
    }
  }

  function mountExportButton() {
    if (document.getElementById('ccf-export-btn')) return;
    var btn = document.createElement('button');
    btn.id = 'ccf-export-btn';
    btn.className = 'icon-btn ccf-export-btn';
    btn.type = 'button';
    btn.title = 'Export chat as Markdown';
    btn.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">' +
      '<path d="M2.5 13.5A1.5 1.5 0 0 0 4 15h8a1.5 1.5 0 0 0 1.5-1.5v-2a.5.5 0 0 0-1 0v2a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5v-2a.5.5 0 0 0-1 0v2z"/>' +
      '<path d="M7.5 11a.5.5 0 0 0 .5-.5V2.707l1.146 1.147a.5.5 0 0 0 .708-.708l-2-2a.5.5 0 0 0-.708 0l-2 2a.5.5 0 1 0 .708.708L7.5 2.707V10.5a.5.5 0 0 0 .5.5z" transform="rotate(180 8 6.5)"/>' +
      '</svg>';
    btn.addEventListener('click', exportChat);

    var host = document.querySelector('#agent-panel-header, .agent-header, #ai-panel-header');
    if (host) {
      var actions = host.querySelector('.actions') || host;
      actions.appendChild(btn);
      return;
    }
    var header = document.querySelector('#agent-panel .sidebar-header .actions') ||
                 document.querySelector('#ai-chat-view .sidebar-header .actions') ||
                 document.querySelector('#agent-panel .sidebar-header');
    if (header) header.appendChild(btn);
  }

  /* ---------------- Send-path wrapping ---------------- */
  function wrapSend() {
    try {
      var ai = window.ai;
      if (!ai || typeof ai.handleSend !== 'function') return false;
      if (ai.__ccfSendWrapped) return true;
      var original = ai.handleSend.bind(ai);
      ai.handleSend = function () {
        try {
          var input = ai.input || document.getElementById('chat-input');
          if (input && typeof input.value === 'string' && input.value.charAt(0) === '/') {
            input.value = expand(input.value);
          }
        } catch (e) { /* never break send */ }
        return original();
      };
      ai.__ccfSendWrapped = true;
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ---------------- Boot ---------------- */
  function boot() {
    var input = document.getElementById('chat-input');
    var popup = input ? new SlashPopup(input) : null;

    if (input && popup) {
      input.addEventListener('input', function () {
        var token = popup.currentToken();
        if (token === null) { popup.close(); return; }
        // Only filter while the caret is still in the command token (no newline).
        if (input.value.indexOf('\n') !== -1 && input.selectionStart > input.value.indexOf('\n')) {
          popup.close();
          return;
        }
        popup.open(token);
      });
      input.addEventListener('keydown', function (e) {
        if (!popup.visible) return;
        if (e.key === 'ArrowDown') { e.preventDefault(); popup.move(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); popup.move(-1); }
        else if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          e.stopPropagation();
          popup.select(popup.active);
        } else if (e.key === 'Escape') { e.preventDefault(); popup.close(); }
      });
      document.addEventListener('mousedown', function (e) {
        if (!popup.visible) return;
        if (e.target !== input && !popup.el.contains(e.target)) popup.close();
      });
    }

    mountTokenMeter();
    mountExportButton();

    // window.ai is created asynchronously by app.js — poll briefly.
    if (!wrapSend()) {
      var tries = 0;
      var timer = setInterval(function () {
        tries++;
        if (wrapSend() || tries > 50) clearInterval(timer);
      }, 200);
    }
  }

  window.ChatFeatures = { expand: expand, boot: boot, COMMANDS: COMMANDS };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
