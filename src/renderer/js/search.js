// ============================================================================
// search.js — Workspace-wide search sidebar view (Ctrl+Shift+F)
// Classic <script> file (no modules). Renders inside #search-view.
// Every electronAPI call is guarded so a plain-browser preview degrades
// gracefully. User content is never injected via innerHTML unescaped.
//
// Exports: window.WorkspaceSearch (+ window.workspaceSearch)
// ============================================================================

class WorkspaceSearch {
  constructor() {
    const view = document.getElementById('search-view');
    if (!view) return;
    if (view.__searchInstance) return view.__searchInstance;

    this.view = view;
    this.lastQuery = '';
    this.lastGlob = '';
    this.running = false;
    this._debounce = null;
    this._gen = 0;

    view.innerHTML = `
      <div class="sidebar-header"><span>SEARCH</span><div class="actions"><button class="icon-btn" id="search-refresh-btn" title="Refresh results"><svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.417A6 6 0 1 1 8 2v1z"/><path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466z"/></svg></button></div></div>
      <div class="search-controls">
        <div class="search-row"><input id="search-input" placeholder="Search across workspace" spellcheck="false" autocomplete="off"><span id="search-count" class="search-count"></span></div>
        <div class="search-row"><input id="search-glob-input" placeholder="Files to include (e.g. *.js)" spellcheck="false" autocomplete="off"></div>
      </div>
      <div id="search-results" class="search-results"><div class="search-empty">Type a query and press Enter.</div></div>`;

    this.input = view.querySelector('#search-input');
    this.globInput = view.querySelector('#search-glob-input');
    this.count = view.querySelector('#search-count');
    this.results = view.querySelector('#search-results');
    view.__searchInstance = this;

    this._wire();
  }

  // -------------------------------------------------------------- wiring --
  _wire() {
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.run();
      } else if (e.key === 'Escape') {
        this.clear();
      }
    });
    this.input.addEventListener('input', () => this._schedule());

    this.globInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.run();
      }
    });
    this.globInput.addEventListener('input', () => this._schedule());

    const refreshBtn = this.view.querySelector('#search-refresh-btn');
    if (refreshBtn) refreshBtn.addEventListener('click', () => this.refresh());
  }

  _schedule() {
    if (this._debounce) clearTimeout(this._debounce);
    this._debounce = setTimeout(() => {
      this._debounce = null;
      if (this._value(this.input).length >= 2) this.run();
      else this._prompt();
    }, 400);
  }

  // ------------------------------------------------------------- states --
  _value(el) {
    return el ? String(el.value || '').trim() : '';
  }

  _setCount(text) {
    if (this.count) this.count.textContent = text || '';
  }

  _setEmpty(text, cls) {
    if (!this.results) return;
    const el = document.createElement('div');
    el.className = cls || 'search-empty';
    el.textContent = text == null ? '' : String(text);
    this.results.textContent = '';
    this.results.appendChild(el);
  }

  _prompt() {
    this._gen++;
    this.running = false;
    this._setCount('');
    this._setEmpty('Type a query and press Enter.');
  }

  clear() {
    if (this._debounce) {
      clearTimeout(this._debounce);
      this._debounce = null;
    }
    if (this.input) this.input.value = '';
    this.lastQuery = '';
    // _prompt() bumps the generation, invalidating any in-flight search.
    this._prompt();
  }

  // ----------------------------------------------------------------- run --
  async run() {
    if (!this.input || !this.results) return;
    if (this._debounce) {
      clearTimeout(this._debounce);
      this._debounce = null;
    }

    if (!window.electronAPI || !window.electronAPI.searchInFiles) {
      this._setCount('');
      this._setEmpty('Search unavailable (not running in Electron)');
      return;
    }

    const root = (window.explorer && window.explorer.rootPath) || null;
    if (!root) {
      this._setCount('');
      this._setEmpty('No folder open — press Ctrl+O.');
      return;
    }

    const q = this._value(this.input);
    if (!q) {
      this._prompt();
      return;
    }
    const glob = this._value(this.globInput);
    this.lastQuery = q;
    this.lastGlob = glob;

    const gen = ++this._gen;
    this.running = true;
    this._setCount('…');
    this._setEmpty('Searching…');

    let res;
    try {
      res = await window.electronAPI.searchInFiles(root, q, {
        glob: glob || undefined,
        maxResults: 200,
        maxPerFile: 20
      });
    } catch (e) {
      res = { error: (e && e.message) ? String(e.message) : String(e) };
    }

    if (gen !== this._gen) return; // superseded by a newer search / clear
    this.running = false;

    if (res && res.error) {
      this._setCount('');
      this._setEmpty('⚠ ' + res.error, 'search-empty error');
      return;
    }

    const list = Array.isArray(res) ? res : [];
    if (list.length === 0) {
      this._setCount('');
      this._setEmpty('No results found.');
      return;
    }

    this._render(list, q);
  }

  // --------------------------------------------------------------- render --
  _render(list, q) {
    // Group by relPath, preserving first-seen order.
    const groups = new Map();
    list.forEach((r) => {
      const rel = (r && (r.relPath || r.path)) || '';
      if (!groups.has(rel)) groups.set(rel, []);
      groups.get(rel).push(r);
    });

    const frag = document.createDocumentFragment();
    groups.forEach((items, rel) => {
      const parts = String(rel).split(/[\\/]/);
      const base = parts.pop() || '';
      const dir = parts.length ? parts.join('/') + '/' : '';

      const header = document.createElement('div');
      header.className = 'search-file';
      header.title = String(rel);
      const arrow = document.createElement('span');
      arrow.className = 'sf-arrow';
      arrow.textContent = '▾';
      const nameEl = document.createElement('span');
      nameEl.className = 'sf-name';
      nameEl.textContent = base;
      const dirEl = document.createElement('span');
      dirEl.className = 'sf-dir';
      dirEl.textContent = dir;
      const cntEl = document.createElement('span');
      cntEl.className = 'sf-count';
      cntEl.textContent = String(items.length);
      header.appendChild(arrow);
      header.appendChild(nameEl);
      header.appendChild(dirEl);
      header.appendChild(cntEl);

      const matches = document.createElement('div');
      matches.className = 'search-matches';

      header.addEventListener('click', () => {
        const collapsed = header.classList.toggle('collapsed');
        matches.style.display = collapsed ? 'none' : '';
      });

      items.forEach((r) => {
        const row = document.createElement('div');
        row.className = 'search-match';
        row.setAttribute('data-path', String((r && r.path) || ''));
        row.setAttribute('data-line', String((r && r.line) || 1));

        const lineEl = document.createElement('span');
        lineEl.className = 'sm-line';
        lineEl.textContent = String((r && r.line) != null ? r.line : '');
        const textEl = document.createElement('span');
        textEl.className = 'sm-text';
        // Safe: escaped text pieces joined with literal <mark> tags only.
        textEl.innerHTML = WorkspaceSearch._highlight((r && r.text) || '', q);

        row.appendChild(lineEl);
        row.appendChild(textEl);
        row.addEventListener('click', () => this._openMatch(row));
        matches.appendChild(row);
      });

      frag.appendChild(header);
      frag.appendChild(matches);
    });

    this.results.textContent = '';
    this.results.appendChild(frag);
    this._setCount(list.length + ' matches · ' + groups.size + ' files');
  }

  _openMatch(row) {
    const path = row.getAttribute('data-path');
    const line = parseInt(row.getAttribute('data-line'), 10) || 1;
    if (!path) return;
    if (window.editor && typeof window.editor.openFileAtLine === 'function') {
      try {
        const p = window.editor.openFileAtLine(path, line);
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch (e) {
        console.debug('search: open failed', e);
      }
    }
  }

  // -------------------------------------------------------------- public --
  refresh() {
    if (!this.input || !this.results) return;
    if (!this.lastQuery) {
      this._prompt();
      return;
    }
    return this.run();
  }

  focusInput() {
    if (!this.input) return;
    this.input.focus();
    this.input.select();
  }

  // ------------------------------------------------------------- helpers --
  static _esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Case-insensitive literal highlight: escaped pieces + literal <mark> tags.
  static _highlight(text, query) {
    const raw = String(text == null ? '' : text);
    const q = String(query == null ? '' : query);
    if (!q) return WorkspaceSearch._esc(raw);

    const hay = raw.toLowerCase();
    const needle = q.toLowerCase();
    let out = '';
    let i = 0;
    let idx = hay.indexOf(needle, i);
    while (idx !== -1 && needle.length > 0) {
      out += WorkspaceSearch._esc(raw.slice(i, idx));
      out += '<mark>' + WorkspaceSearch._esc(raw.slice(idx, idx + needle.length)) + '</mark>';
      i = idx + needle.length;
      idx = hay.indexOf(needle, i);
    }
    out += WorkspaceSearch._esc(raw.slice(i));
    return out;
  }
}

window.WorkspaceSearch = WorkspaceSearch;

// ---------------------------------------------------------------------------
// Boot: build the view as soon as #search-view exists.
// ---------------------------------------------------------------------------
(function bootWorkspaceSearch() {
  if (window.__workspaceSearchBooted) return;
  window.__workspaceSearchBooted = true;

  const start = () => {
    if (window.workspaceSearch) return;
    if (!document.getElementById('search-view')) return;
    try {
      window.workspaceSearch = new WorkspaceSearch();
    } catch (e) {
      console.warn('search view unavailable:', e);
    }
  };

  start();
  if (!window.workspaceSearch && document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  }
})();
