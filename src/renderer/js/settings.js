// ============================================================================
// settings.js — Settings store (window.AppSettings) + Settings modal
// Classic <script> file (no modules). Every electronAPI call is guarded so a
// plain-browser preview degrades gracefully.
//
// Exports: window.AppSettings, window.SettingsModal (+ window.settingsModal)
// ============================================================================

window.AppSettings = {
  DEFAULTS: {
    agentMode: 'ask',
    maxSteps: 15,
    autocompleteEnabled: true,
    autocompleteDelay: 350,
    agentAllowOutsideWorkspace: false,
    agentMaxTokens: 4096
  },
  data: {},
  async load() {
    if (window.electronAPI && window.electronAPI.settingsGet) {
      try {
        const saved = await window.electronAPI.settingsGet();
        this.data = (saved && typeof saved === 'object') ? saved : {};
      } catch (e) {
        console.warn('settings load failed', e);
      }
    }
    return this.data;
  },
  get(key) {
    return (key in this.data) ? this.data[key] : this.DEFAULTS[key];
  },
  async set(key, value) {
    this.data[key] = value;
    if (window.electronAPI && window.electronAPI.settingsSet) {
      try {
        await window.electronAPI.settingsSet({ [key]: value });
      } catch (e) {
        console.warn('settings save failed', e);
      }
    }
    document.dispatchEvent(new CustomEvent('settings-changed', { detail: { ...this.data } }));
    return value;
  }
};

// ---------------------------------------------------------------------------
// Settings modal (full-screen overlay, appended to <body>)
// ---------------------------------------------------------------------------
class SettingsModal {
  constructor() {
    // Idempotent: a second `new SettingsModal()` reuses the first instance.
    const existing = document.getElementById('settings-overlay');
    if (existing && existing.__settingsInstance) return existing.__settingsInstance;

    this.overlay = null;
    this._existingEl = existing || null;
    this._saving = false;

    // Escape closes the modal and is swallowed so other Esc handlers stay quiet.
    this._onKeyDown = (e) => {
      if (e.key === 'Escape' && this.isOpen()) {
        e.stopPropagation();
        this.close();
      }
    };
    document.addEventListener('keydown', this._onKeyDown, true);

    if (document.body) {
      this._mount();
    } else {
      document.addEventListener('DOMContentLoaded', () => this._mount(), { once: true });
    }
  }

  // -------------------------------------------------------------- markup --
  _markup() {
    return `
      <div class="settings-panel" role="dialog" aria-modal="true" aria-label="Settings">
        <div class="settings-head">
          <span class="settings-title">⚙ Settings</span>
          <button type="button" class="settings-close" title="Close (Esc)">✕</button>
        </div>
        <nav class="settings-tabs">
          <button type="button" class="settings-tab active" data-tab="ai">AI Provider</button>
          <button type="button" class="settings-tab" data-tab="agent">Agent</button>
          <button type="button" class="settings-tab" data-tab="features">Features</button>
          <button type="button" class="settings-tab" data-tab="about">About</button>
        </nav>
        <div class="settings-body">

          <section class="settings-page active" data-page="ai">
            <div class="field">
              <label for="set-baseurl">API Base URL</label>
              <input type="text" id="set-baseurl" spellcheck="false" autocomplete="off" placeholder="http://127.0.0.1:8000/v1">
            </div>
            <div class="field">
              <label for="set-apikey">API Key</label>
              <input type="password" id="set-apikey" autocomplete="new-password" placeholder="•••••••• (leave unchanged to keep current key)">
            </div>
            <div class="field">
              <label for="set-model">Model</label>
              <input type="text" id="set-model" list="set-model-list" spellcheck="false" autocomplete="off" placeholder="Model id">
              <datalist id="set-model-list"></datalist>
            </div>
            <div class="field-row">
              <button type="button" class="settings-btn ghost" id="set-test">Test Connection</button>
            </div>
            <p class="settings-note">OpenAI-compatible endpoint (local GPU tunnel or cloud).</p>
          </section>

          <section class="settings-page" data-page="agent">
            <div class="mode-cards">
              <label class="mode-card">
                <input type="radio" name="agentic-mode" value="ask" checked>
                <span class="mode-title">Ask</span>
                <span class="mode-desc">Ask before every change — approve each edit &amp; command individually</span>
              </label>
              <label class="mode-card">
                <input type="radio" name="agentic-mode" value="edit-auto">
                <span class="mode-title">Auto-edit</span>
                <span class="mode-desc">Auto-edit files — file edits apply immediately, shell commands still ask</span>
              </label>
              <label class="mode-card">
                <input type="radio" name="agentic-mode" value="full-auto">
                <span class="mode-title">Full-auto</span>
                <span class="mode-desc">Fully autonomous — edits and commands run without asking</span>
              </label>
            </div>
            <div class="field">
              <label for="set-maxsteps">Maximum agent steps per task</label>
              <input type="number" id="set-maxsteps" min="1" max="50" value="15">
            </div>
            <div class="field">
              <label for="set-agent-maxtokens">Token budget per agent turn</label>
              <input type="number" id="set-agent-maxtokens" min="512" max="16384" step="256" value="4096">
              <p class="settings-note">Raise it if the agent struggles to write longer files (a local model may truncate its output).</p>
            </div>
            <div class="field">
              <label class="check-label" for="set-outside-workspace">
                <input type="checkbox" id="set-outside-workspace">
                <span>Allow agent outside workspace</span>
              </label>
              <p class="settings-note">Lets the agent read/write absolute paths outside the opened folder (e.g. system files). Every edit still needs your approval.</p>
            </div>
            <p class="settings-note">You can also switch modes from the chat header.</p>
          </section>

          <section class="settings-page" data-page="features">
            <div class="field">
              <label class="check-label" for="set-autocomplete">
                <input type="checkbox" id="set-autocomplete" checked>
                <span>Ghost-text autocomplete (Tab to accept)</span>
              </label>
            </div>
            <div class="field">
              <label for="set-autodelay">Completion delay (ms)</label>
              <input type="number" id="set-autodelay" min="100" max="3000" step="50" value="350">
            </div>
          </section>

          <section class="settings-page" data-page="about">
            <p class="about-text">Cloud Code 1.0.0 — AI Agentic IDE built with Electron + Monaco</p>
            <table class="shortcuts-table">
              <tbody>
                <tr><td><kbd>Ctrl+P</kbd></td><td>Quick Open</td></tr>
                <tr><td><kbd>Ctrl+Shift+P</kbd></td><td>Command Palette</td></tr>
                <tr><td><kbd>Ctrl+K</kbd></td><td>Inline Edit</td></tr>
                <tr><td><kbd>Ctrl+Shift+F</kbd></td><td>Search</td></tr>
                <tr><td><kbd>Ctrl+Shift+E</kbd></td><td>Explorer</td></tr>
                <tr><td><kbd>Ctrl+\`</kbd></td><td>Terminal</td></tr>
                <tr><td><kbd>Ctrl+S</kbd></td><td>Save</td></tr>
              </tbody>
            </table>
          </section>

        </div>
        <div class="settings-foot">
          <span class="settings-msg"></span>
          <button type="button" class="settings-btn ghost" data-act="cancel">Cancel</button>
          <button type="button" class="settings-btn primary" data-act="save">Save</button>
        </div>
      </div>`;
  }

  _mount() {
    if (this.overlay || !document.body) return;
    let el = this._existingEl || document.getElementById('settings-overlay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'settings-overlay';
      el.className = 'settings-overlay hidden';
      el.innerHTML = this._markup();
      document.body.appendChild(el);
    }
    this._existingEl = null;
    this.overlay = el;
    el.__settingsInstance = this;
    this._wire();
  }

  $(id) {
    return this.overlay ? this.overlay.querySelector('#' + id) : null;
  }

  _wire() {
    const o = this.overlay;

    const closeBtn = o.querySelector('.settings-close');
    if (closeBtn) closeBtn.addEventListener('click', () => this.close());

    // Backdrop click (only when the overlay itself was hit).
    o.addEventListener('click', (e) => {
      if (e.target === o) this.close();
    });

    // Tabs
    o.querySelectorAll('.settings-tab').forEach((btn) => {
      btn.addEventListener('click', () => this._showTab(btn.getAttribute('data-tab')));
    });

    // Agent mode cards (native radios, visually hidden inside the labels)
    o.querySelectorAll('input[name="agentic-mode"]').forEach((radio) => {
      radio.addEventListener('change', () => this._syncModeCards());
    });

    // Test connection
    const testBtn = o.querySelector('#set-test');
    if (testBtn) testBtn.addEventListener('click', () => this._test());

    // Footer actions
    o.querySelectorAll('.settings-foot [data-act]').forEach((btn) => {
      const act = btn.getAttribute('data-act');
      btn.addEventListener('click', () => {
        if (act === 'save') this._save();
        else this.close();
      });
    });
  }

  // ------------------------------------------------------------ behavior --
  _showTab(name) {
    const o = this.overlay;
    if (!o || !name) return;
    o.querySelectorAll('.settings-tab').forEach((b) => {
      b.classList.toggle('active', b.getAttribute('data-tab') === name);
    });
    o.querySelectorAll('.settings-page').forEach((p) => {
      p.classList.toggle('active', p.getAttribute('data-page') === name);
    });
  }

  _syncModeCards() {
    const o = this.overlay;
    if (!o) return;
    o.querySelectorAll('.mode-card').forEach((card) => {
      const radio = card.querySelector('input[name="agentic-mode"]');
      card.classList.toggle('selected', !!(radio && radio.checked));
    });
  }

  _setMsg(text, kind) {
    const el = this.overlay ? this.overlay.querySelector('.settings-msg') : null;
    if (!el) return;
    el.textContent = text || '';
    el.className = 'settings-msg' + (kind ? ' ' + kind : '');
  }

  isOpen() {
    return !!(this.overlay && !this.overlay.classList.contains('hidden'));
  }

  close() {
    if (!this.overlay) return;
    this.overlay.classList.add('hidden');
  }

  async open() {
    this._mount();
    if (!this.overlay) return;
    const o = this.overlay;

    o.classList.remove('hidden');
    this._setMsg('', '');

    // --- AI provider (the API key is NEVER put into an input value) ---
    let masked = '';
    if (window.electronAPI && window.electronAPI.getAiConfig) {
      try {
        const cfg = (await window.electronAPI.getAiConfig()) || {};
        const urlEl = this.$('set-baseurl');
        const modelEl = this.$('set-model');
        if (urlEl) urlEl.value = cfg.baseUrl || '';
        if (modelEl) modelEl.value = cfg.model || '';
        masked = cfg.apiKey || '';
      } catch (e) {
        console.warn('settings: ai config load failed', e);
      }
    }
    const keyEl = this.$('set-apikey');
    if (keyEl) {
      keyEl.value = '';
      keyEl.placeholder = masked
        ? ('Current: ' + masked)
        : '•••••••• (leave unchanged to keep current key)';
    }

    // --- Local settings ---
    const S = window.AppSettings;
    const acEl = this.$('set-autocomplete');
    if (acEl) acEl.checked = S ? !!S.get('autocompleteEnabled') : true;
    const delayEl = this.$('set-autodelay');
    if (delayEl) delayEl.value = S ? S.get('autocompleteDelay') : 350;
    const stepsEl = this.$('set-maxsteps');
    if (stepsEl) stepsEl.value = S ? S.get('maxSteps') : 15;
    const tokEl = this.$('set-agent-maxtokens');
    if (tokEl) tokEl.value = S ? S.get('agentMaxTokens') : 4096;
    const outsideEl = this.$('set-outside-workspace');
    if (outsideEl) outsideEl.checked = !!(S && S.get('agentAllowOutsideWorkspace'));

    let mode = S ? S.get('agentMode') : 'ask';
    if (mode !== 'ask' && mode !== 'edit-auto' && mode !== 'full-auto') mode = 'ask';
    const radio = o.querySelector('input[name="agentic-mode"][value="' + mode + '"]');
    if (radio) radio.checked = true;
    this._syncModeCards();

    // --- Model suggestions (ignore failures) ---
    try {
      await this._fillModels();
    } catch (e) { /* ignore */ }

    const first = this.$('set-baseurl');
    if (first) first.focus();
  }

  async _fillModels() {
    if (!window.electronAPI || !window.electronAPI.listAiModels) return;
    let models;
    try {
      models = await window.electronAPI.listAiModels();
    } catch (e) {
      return;
    }
    if (!Array.isArray(models)) return;
    const list = this.$('set-model-list');
    if (!list) return;
    list.textContent = '';
    models.forEach((m) => {
      const opt = document.createElement('option');
      opt.value = String(m);
      list.appendChild(opt);
    });
  }

  async _test() {
    this._setMsg('Testing connection…', '');
    if (!window.electronAPI || !window.electronAPI.listAiModels) {
      this._setMsg('✗ Cannot test — not running in Electron', 'error');
      return;
    }
    try {
      const models = await window.electronAPI.listAiModels();
      if (Array.isArray(models) && models.length > 0) {
        this._setMsg('✓ Connected — ' + models.length + ' models available', 'success');
      } else if (Array.isArray(models)) {
        this._setMsg('✗ Connected, but no models are available', 'error');
      } else {
        this._setMsg('✗ Unexpected response from the endpoint', 'error');
      }
    } catch (e) {
      this._setMsg('✗ ' + ((e && e.message) || 'Connection failed'), 'error');
    }
  }

  async _save() {
    if (this._saving) return;
    this._saving = true;
    try {
      const urlEl = this.$('set-baseurl');
      const keyEl = this.$('set-apikey');
      const modelEl = this.$('set-model');
      const baseUrl = urlEl ? urlEl.value.trim() : '';
      const typedKey = keyEl ? keyEl.value : '';
      const model = modelEl ? modelEl.value.trim() : '';
      const mode = this._currentMode();
      const maxSteps = SettingsModal._clampInt(
        this.$('set-maxsteps') ? this.$('set-maxsteps').value : null, 1, 50, 15);
      const acEl = this.$('set-autocomplete');
      const autocompleteEnabled = acEl ? !!acEl.checked : true;
      const autocompleteDelay = SettingsModal._clampInt(
        this.$('set-autodelay') ? this.$('set-autodelay').value : null, 100, 3000, 350);
      const agentMaxTokens = SettingsModal._clampInt(
        this.$('set-agent-maxtokens') ? this.$('set-agent-maxtokens').value : null, 512, 16384, 4096);
      const outsideEl = this.$('set-outside-workspace');
      const agentAllowOutsideWorkspace = outsideEl ? !!outsideEl.checked : false;

      if (window.electronAPI && window.electronAPI.updateAiConfig) {
        try {
          await window.electronAPI.updateAiConfig({
            baseUrl: baseUrl,
            apiKey: (typedKey && typedKey.indexOf('••••') === -1) ? typedKey : undefined,
            model: model
          });
        } catch (e) {
          this._setMsg('✗ ' + ((e && e.message) || 'Failed to save AI config'), 'error');
          return;
        }
      }

      if (window.AppSettings) {
        await window.AppSettings.set('agentMode', mode);
        await window.AppSettings.set('maxSteps', maxSteps);
        await window.AppSettings.set('autocompleteEnabled', autocompleteEnabled);
        await window.AppSettings.set('autocompleteDelay', autocompleteDelay);
        await window.AppSettings.set('agentMaxTokens', agentMaxTokens);
        await window.AppSettings.set('agentAllowOutsideWorkspace', agentAllowOutsideWorkspace);
      }

      this._setMsg('✓ Saved', 'success');
      setTimeout(() => this.close(), 400);
    } finally {
      this._saving = false;
    }
  }

  _currentMode() {
    const radio = this.overlay
      ? this.overlay.querySelector('input[name="agentic-mode"]:checked')
      : null;
    return radio ? radio.value : 'ask';
  }

  static _clampInt(value, min, max, fallback) {
    let n = parseInt(String(value), 10);
    if (!Number.isFinite(n)) n = fallback;
    if (n < min) n = min;
    if (n > max) n = max;
    return n;
  }
}

window.SettingsModal = SettingsModal;

// ---------------------------------------------------------------------------
// Boot: preload persisted settings + build the (hidden) modal once.
// ---------------------------------------------------------------------------
(function bootSettingsModal() {
  if (window.__settingsModalBooted) return;
  window.__settingsModalBooted = true;

  try {
    const loading = window.AppSettings.load();
    if (loading && typeof loading.catch === 'function') loading.catch(() => {});
  } catch (e) {
    console.warn('settings load failed', e);
  }

  try {
    if (!window.settingsModal) window.settingsModal = new SettingsModal();
  } catch (e) {
    console.warn('settings modal unavailable:', e);
  }
})();
