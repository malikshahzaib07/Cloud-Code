// ============================================================================
// Cloud Code — Command Palette (Ctrl+Shift+P) & Quick Open (Ctrl+P)
//
// Classic script (no modules). Exports on window:
//   window.FileIndex       — shared, cached, fuzzy-searchable file index
//   window.CommandPalette  — the palette class
//   window.palette         — default live instance
// ============================================================================

// ------------------------------- helpers ----------------------------------

function paletteEscapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Case-insensitive fuzzy subsequence match.
// Returns { score, indices } when every query char appears in order, else null.
// Score: +8 match at index 0, +6 match right after / - _ . (segment boundary),
// +5 per consecutive matched pair, minus the gap span (shorter gaps score higher).
function paletteFuzzyMatch(query, text) {
  const q = String(query === null || query === undefined ? '' : query).toLowerCase();
  const t = String(text === null || text === undefined ? '' : text).toLowerCase();
  if (!q) return { score: 0, indices: [] };

  const BOUNDARY = '/-_.';
  const LOOKAHEAD = 8;

  // Greedy left-to-right subsequence walk. When preferBoundary is set, prefer a
  // match that sits at index 0 or right after a boundary char within LOOKAHEAD.
  function greedy(preferBoundary) {
    const indices = [];
    let from = 0;
    for (let i = 0; i < q.length; i++) {
      const ch = q.charAt(i);
      let pos = -1;
      if (preferBoundary) {
        const limit = Math.min(t.length, from + LOOKAHEAD);
        for (let k = from; k < limit; k++) {
          if (t.charAt(k) === ch && (k === 0 || BOUNDARY.indexOf(t.charAt(k - 1)) !== -1)) {
            pos = k;
            break;
          }
        }
      }
      if (pos === -1) pos = t.indexOf(ch, from);
      if (pos === -1) return null; // not a subsequence
      indices.push(pos);
      from = pos + 1;
    }
    return indices;
  }

  function scoreOf(indices) {
    let score = 0;
    for (let i = 0; i < indices.length; i++) {
      const p = indices[i];
      if (p === 0) score += 8;
      else if (BOUNDARY.indexOf(t.charAt(p - 1)) !== -1) score += 6;
      if (i > 0 && indices[i - 1] + 1 === p) score += 5; // consecutive run
    }
    const span = indices[indices.length - 1] - indices[0] + 1;
    score -= span - indices.length; // shorter gaps score higher
    return score;
  }

  const plain = greedy(false);
  if (!plain) return null;

  let bestIndices = plain;
  let bestScore = scoreOf(plain);
  const atBoundary = greedy(true);
  if (atBoundary) {
    const alt = scoreOf(atBoundary);
    if (alt > bestScore) {
      bestScore = alt;
      bestIndices = atBoundary;
    }
  }
  return { score: bestScore, indices: bestIndices };
}

// Build HTML for `text`, wrapping matched chars (absolute indices, shifted by
// `offset`) in <span class="hl">. Always HTML-escapes the text.
function paletteHighlight(text, indices, offset) {
  const src = String(text === null || text === undefined ? '' : text);
  const shift = offset || 0;
  const set = new Set();
  if (indices) {
    for (let i = 0; i < indices.length; i++) {
      const rel = indices[i] - shift;
      if (rel >= 0 && rel < src.length) set.add(rel);
    }
  }

  let html = '';
  let buf = '';
  let inHl = false;
  for (let i = 0; i < src.length; i++) {
    const hl = set.has(i);
    if (hl !== inHl) {
      html += inHl
        ? '<span class="hl">' + paletteEscapeHtml(buf) + '</span>'
        : paletteEscapeHtml(buf);
      buf = '';
      inHl = hl;
    }
    buf += src.charAt(i);
  }
  html += inHl
    ? '<span class="hl">' + paletteEscapeHtml(buf) + '</span>'
    : paletteEscapeHtml(buf);
  return html;
}

// -------------------------------- FileIndex --------------------------------

const FileIndex = {
  _cache: new Map(),   // rootPath -> entries[]
  _pending: new Map(), // rootPath -> Promise<entries[]>

  // Promise<entries[]>; caches per root. Returns [] for a falsy root or on any
  // error (the error is cached too so we do not hammer a broken backend).
  async load(root, force = false) {
    if (!root) return [];
    if (force) {
      this._cache.delete(root);
      this._pending.delete(root);
    }
    if (this._cache.has(root)) return this._cache.get(root);
    if (this._pending.has(root)) return this._pending.get(root);

    if (!window.electronAPI || typeof window.electronAPI.listFilesRecursive !== 'function') {
      this._cache.set(root, []);
      return [];
    }

    let request;
    request = Promise.resolve()
      .then(() => window.electronAPI.listFilesRecursive(root, 5000))
      .then((entries) => {
        const list = Array.isArray(entries)
          ? entries.filter((e) => e && typeof e.path === 'string')
          : [];
        // Only publish when this is still the active request for the root so a
        // stale in-flight listing cannot overwrite a fresher cache.
        if (this._pending.get(root) === request) {
          this._cache.set(root, list);
          this._pending.delete(root);
        }
        return list;
      })
      .catch((err) => {
        console.error('[FileIndex] listFilesRecursive failed:', err);
        if (this._pending.get(root) === request) {
          this._cache.set(root, []);
          this._pending.delete(root);
        }
        return [];
      });

    this._pending.set(root, request);
    return request;
  },

  // Promise<Array<{path, relPath, name, score}>> fuzzy-ranked against relPath
  // (name matches weighted on top). An empty query returns the first `limit`
  // entries alphabetically by relPath.
  async search(query, limit = 40) {
    const q = String(query === null || query === undefined ? '' : query).trim().toLowerCase();
    const root = window.explorer && window.explorer.rootPath ? window.explorer.rootPath : null;
    const entries = await this.load(root);

    if (!q) {
      return entries
        .slice()
        .sort((a, b) => String(a.relPath || '').localeCompare(String(b.relPath || '')))
        .slice(0, limit)
        .map((e) => ({ path: e.path, relPath: e.relPath || '', name: e.name || '', score: 0 }));
    }

    const out = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const relPath = e.relPath || '';
      const name = e.name || '';
      const match = paletteFuzzyMatch(q, relPath);
      if (!match) continue; // must be a subsequence of relPath

      let score = match.score;
      const nameMatch = paletteFuzzyMatch(q, name);
      if (nameMatch && nameMatch.score > score) score = nameMatch.score;
      if (name.toLowerCase().indexOf(q) === 0) score += 10; // full query starts name

      out.push({ path: e.path, relPath: relPath, name: name, score: score });
    }

    out.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.relPath.length !== b.relPath.length) return a.relPath.length - b.relPath.length;
      return a.relPath.localeCompare(b.relPath);
    });
    return out.slice(0, limit);
  },

  // Cached entries for the current root (or []).
  all() {
    const root = window.explorer && window.explorer.rootPath ? window.explorer.rootPath : null;
    if (!root) return [];
    return this._cache.get(root) || [];
  },

  // Clear the cache (call after files change).
  invalidate() {
    this._cache.clear();
    this._pending.clear();
  }
};

window.FileIndex = FileIndex;

// ----------------------------- CommandPalette ------------------------------

class CommandPalette {
  constructor() {
    // Defensive singleton: guarantees one overlay / one document listener even
    // if more than one module instantiates the palette.
    if (CommandPalette._instance) return CommandPalette._instance;

    this.commands = new Map(); // id -> {title, keyHint, category, handler}
    this.mode = 'commands';
    this.items = [];
    this.activeIdx = 0;
    this.lastQuery = '';
    this._seq = 0; // guards async populate() races

    this._buildDom();
    this._bindEvents();
    this._registerBuiltins();

    CommandPalette._instance = this;
  }

  // ------------------------------ DOM --------------------------------------

  _buildDom() {
    const overlay = document.createElement('div');
    overlay.id = 'palette-overlay';
    overlay.className = 'palette-overlay hidden';
    overlay.innerHTML =
      '<div class="palette-panel">' +
      '  <input id="palette-input" class="palette-input" spellcheck="false" autocomplete="off" placeholder="Type a command...">' +
      '  <div id="palette-results" class="palette-results"></div>' +
      '  <div class="palette-footer">' +
      '    <span><kbd>↑↓</kbd> navigate</span>' +
      '    <span><kbd>↵</kbd> run</span>' +
      '    <span><kbd>esc</kbd> close</span>' +
      '    <span class="palette-mode-hint" id="palette-mode-hint">commands</span>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(overlay);

    this.overlay = overlay;
    this.input = overlay.querySelector('#palette-input');
    this.results = overlay.querySelector('#palette-results');
    this.modeHint = overlay.querySelector('#palette-mode-hint');
  }

  _bindEvents() {
    this.input.addEventListener('input', () => {
      this.populate().catch((err) => console.error('[palette] populate failed:', err));
    });

    // Click on the dimmed backdrop closes the palette.
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.close();
    });

    // Global shortcuts (capture phase so Monaco never swallows them).
    document.addEventListener(
      'keydown',
      (e) => {
        const mod = e.ctrlKey || e.metaKey;
        if (mod && e.shiftKey && (e.key === 'P' || e.key === 'p')) {
          e.preventDefault();
          this.open('commands');
          return;
        }
        if (mod && !e.shiftKey && (e.key === 'P' || e.key === 'p')) {
          e.preventDefault();
          this.open('files');
          return;
        }
        if (!this._isOpen()) return;

        switch (e.key) {
          case 'Escape':
            e.preventDefault();
            this.close();
            break;
          case 'ArrowDown':
            e.preventDefault();
            e.stopPropagation();
            this.moveActive(1);
            break;
          case 'ArrowUp':
            e.preventDefault();
            e.stopPropagation();
            this.moveActive(-1);
            break;
          case 'Enter':
            e.preventDefault();
            this.runActive();
            break;
          case 'Tab':
            e.preventDefault();
            break;
          default:
            break;
        }
      },
      true
    );

    // Note: #command-palette-btn is wired by app.js (which owns the top bar).
  }

  _registerBuiltins() {
    this.register('file.openFolder', {
      title: 'File: Open Folder…',
      keyHint: 'Ctrl+O',
      category: 'File',
      handler: () => {
        if (window.explorer) window.explorer.openFolder();
      }
    });
    this.register('file.save', {
      title: 'File: Save',
      keyHint: 'Ctrl+S',
      category: 'File',
      handler: () => {
        if (window.editor && typeof window.editor.saveActiveFile === 'function') {
          window.editor.saveActiveFile();
        }
      }
    });
    this.register('view.terminal', {
      title: 'View: Toggle Terminal',
      keyHint: 'Ctrl+`',
      category: 'View',
      handler: () => {
        const btn = document.getElementById('toggle-terminal-btn');
        if (btn) btn.click();
      }
    });
    this.register('files.refreshIndex', {
      title: 'Files: Refresh File Index',
      category: 'Files',
      handler: () => this.refreshFiles()
    });
  }

  // ---------------------------- API ----------------------------------------

  // Register (or replace, keeping position) a command. Returns the id.
  register(id, def) {
    const spec = def || {};
    this.commands.set(id, {
      title: typeof spec.title === 'string' && spec.title ? spec.title : String(id),
      keyHint: spec.keyHint || '',
      category: spec.category || '',
      handler: spec.handler
    });
    if (this._isOpen() && this.mode === 'commands') {
      this.populate().catch((err) => console.error('[palette] populate failed:', err));
    }
    return id;
  }

  // mode: 'commands' | 'files'
  open(mode) {
    this.mode = mode === 'files' ? 'files' : 'commands';
    this.overlay.classList.remove('hidden');
    this.input.value = '';
    this.lastQuery = '';
    this._syncChrome();
    this.populate().catch((err) => console.error('[palette] populate failed:', err));
    this.input.focus();
  }

  close() {
    this._seq++;
    this.overlay.classList.add('hidden');
    this.input.value = '';
    this.results.innerHTML = '';
    this.items = [];
    this.activeIdx = 0;
    this.lastQuery = '';
    this.input.blur();
  }

  refreshFiles() {
    FileIndex.invalidate();
    if (this._isOpen() && this.mode === 'files') {
      this.populate().catch((err) => console.error('[palette] populate failed:', err));
    }
  }

  isOpen() {
    return this._isOpen();
  }

  // ------------------------- population -------------------------------------

  async populate() {
    const seq = ++this._seq;
    const raw = this.input.value;

    // '>' in the input always switches to commands mode, however it got there.
    if (raw.charAt(0) === '>' && this.mode !== 'commands') {
      this.mode = 'commands';
      this._syncChrome();
    }
    const query = (raw.charAt(0) === '>' ? raw.slice(1) : raw).trim();
    this.lastQuery = query;

    if (this.mode === 'commands') {
      this.renderResults(this._filterCommands(query), 'commands');
      return;
    }

    // ---- files mode ----
    if (!window.electronAPI || typeof window.electronAPI.listFilesRecursive !== 'function') {
      this._setMessage('File search unavailable (not running in Electron)');
      return;
    }
    const root = window.explorer && window.explorer.rootPath ? window.explorer.rootPath : null;
    if (!root) {
      this._setMessage('No folder open — press Ctrl+O to open one');
      return;
    }

    this._setMessage('Loading files...', 'palette-loading');
    try {
      let items;
      if (!query) {
        const entries = await FileIndex.load(root);
        if (!this._isCurrent(seq)) return;
        items = entries
          .slice()
          .sort((a, b) => String(a.relPath || '').localeCompare(String(b.relPath || '')))
          .slice(0, 60)
          .map((e) => ({
            type: 'file',
            path: e.path,
            relPath: e.relPath || '',
            name: e.name || '',
            score: 0
          }));
      } else {
        const found = await FileIndex.search(query, 40);
        if (!this._isCurrent(seq)) return;
        items = found.map((f) => ({
          type: 'file',
          path: f.path,
          relPath: f.relPath,
          name: f.name,
          score: f.score
        }));
      }
      if (!this._isCurrent(seq)) return;
      this.renderResults(items, 'files');
    } catch (err) {
      console.error('[palette] file search failed:', err);
      if (this._isCurrent(seq)) this._setMessage('File search failed');
    }
  }

  _isCurrent(seq) {
    return seq === this._seq && this._isOpen() && this.mode === 'files';
  }

  _filterCommands(query) {
    const out = [];
    this.commands.forEach((cmd, id) => {
      const item = {
        type: 'command',
        id: id,
        title: cmd.title,
        keyHint: cmd.keyHint,
        category: cmd.category,
        handler: cmd.handler,
        _t: [],
        _c: []
      };
      if (query) {
        const titleMatch = paletteFuzzyMatch(query, cmd.title);
        if (titleMatch) {
          item._t = titleMatch.indices;
        } else {
          const cat = cmd.category || '';
          const hay = cat ? cat + ' ' + cmd.title : cmd.title;
          const hayMatch = paletteFuzzyMatch(query, hay);
          if (!hayMatch) return; // fuzzy match against title + category
          const catPart = cat ? cat.length + 1 : 0;
          item._t = hayMatch.indices
            .filter((i) => i >= catPart)
            .map((i) => i - catPart);
          item._c = hayMatch.indices.filter((i) => i < catPart && i < cat.length);
        }
      }
      out.push(item);
    });
    return out;
  }

  // -------------------------- rendering -------------------------------------

  renderResults(items, mode) {
    this.items = Array.isArray(items) ? items : [];
    this.activeIdx = 0;

    if (!this.items.length) {
      this.results.innerHTML = '<div class="palette-empty">No matching results</div>';
      return;
    }

    let html = '';
    for (let i = 0; i < this.items.length; i++) {
      html += mode === 'commands'
        ? this._rowCommand(this.items[i], i)
        : this._rowFile(this.items[i], i);
    }
    this.results.innerHTML = html;

    const rows = this.results.querySelectorAll('.palette-item');
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const idx = Number(row.getAttribute('data-idx'));
      if (idx === this.activeIdx) row.classList.add('active');
      row.addEventListener('click', () => {
        this.setActive(idx);
        this.runActive();
      });
      row.addEventListener('mouseenter', () => this.setActive(idx));
    }
  }

  _rowCommand(item, i) {
    const cat = item.category
      ? '<span class="palette-item-cat">' + paletteHighlight(item.category, item._c, 0) + '</span>'
      : '';
    const label = '<span class="palette-item-label">' + paletteHighlight(item.title, item._t, 0) + '</span>';
    const key = item.keyHint
      ? '<span class="palette-item-key">' + paletteEscapeHtml(item.keyHint) + '</span>'
      : '';
    return '<div class="palette-item" data-idx="' + i + '">' + cat + label + key + '</div>';
  }

  _rowFile(item, i) {
    const relPath = String(item.relPath || '');
    const name = item.name || relPath.split('/').pop() || relPath;
    const dirLen = Math.max(0, relPath.length - name.length);
    const dir = relPath.slice(0, dirLen);
    const indices = this._fileHighlight(relPath, name);

    const nameHtml = '<span class="palette-file-name">' + paletteHighlight(name, indices, dirLen) + '</span>';
    const dirHtml = dir
      ? '<span class="palette-file-dir">' + paletteHighlight(dir, indices, 0) + '</span>'
      : '';
    return '<div class="palette-item" data-idx="' + i + '">' + nameHtml + dirHtml + '</div>';
  }

  // Absolute relPath indices of the best fuzzy match (name match preferred on
  // ties so the highlight lands on the file name itself).
  _fileHighlight(relPath, name) {
    const query = this.lastQuery;
    if (!query) return [];
    const relMatch = paletteFuzzyMatch(query, relPath);
    const nameMatch = paletteFuzzyMatch(query, name);
    const offset = Math.max(0, relPath.length - name.length);

    let best = null;
    if (relMatch) best = relMatch.indices;
    if (nameMatch && (!relMatch || nameMatch.score >= relMatch.score)) {
      best = nameMatch.indices.map((idx) => idx + offset);
    }
    return best || [];
  }

  _setMessage(text, cls) {
    this.items = [];
    this.activeIdx = 0;
    this.results.innerHTML =
      '<div class="' + (cls || 'palette-empty') + '">' + paletteEscapeHtml(text) + '</div>';
  }

  // --------------------------- navigation -----------------------------------

  setActive(idx) {
    if (idx < 0 || idx >= this.items.length) return;
    this.activeIdx = idx;
    this._applyActive(false);
  }

  moveActive(delta) {
    const n = this.items.length;
    if (!n) return;
    this.activeIdx = (((this.activeIdx + delta) % n) + n) % n; // wrap around
    this._applyActive(true);
  }

  _applyActive(scroll) {
    const rows = this.results.querySelectorAll('.palette-item');
    let activeRow = null;
    for (let i = 0; i < rows.length; i++) {
      const isActive = Number(rows[i].getAttribute('data-idx')) === this.activeIdx;
      rows[i].classList.toggle('active', isActive);
      if (isActive) activeRow = rows[i];
    }
    if (activeRow && scroll) activeRow.scrollIntoView({ block: 'nearest' });
  }

  runActive() {
    const item = this.items[this.activeIdx];
    if (!item) return;

    if (item.type === 'file') {
      try {
        if (window.editor && typeof window.editor.openFileByPath === 'function') {
          const result = window.editor.openFileByPath(item.path);
          if (result && typeof result.catch === 'function') {
            result.catch((err) => console.error('[palette] openFileByPath failed:', err));
          }
        }
      } catch (err) {
        console.error('[palette] openFileByPath failed:', err);
      }
      this.close();
      return;
    }

    this.close();
    try {
      item.handler();
    } catch (e) {
      console.error(e);
    }
  }

  // --------------------------- internals ------------------------------------

  _isOpen() {
    return !!this.overlay && !this.overlay.classList.contains('hidden');
  }

  _syncChrome() {
    this.input.placeholder = this.mode === 'files' ? 'Search files by name' : 'Type a command...';
    this.modeHint.textContent = this.mode;
  }
}

window.CommandPalette = CommandPalette;

// Boot a default instance so the shortcuts work even if no other module
// creates one (agent.js expects window.palette to exist).
if (document.body) {
  window.palette = window.palette || new CommandPalette();
} else {
  document.addEventListener('DOMContentLoaded', () => {
    window.palette = window.palette || new CommandPalette();
  });
}
