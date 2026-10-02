// Ghost Text Inline Completion (Copilot-style) — see styles/autocomplete.css (.ghost-text)
class GhostAutocomplete {
  constructor() {
    this.ready = false;
    this.editor = null;
    this.ghostText = null;      // full completion text or null
    this.ghostPos = null;       // monaco position the ghost belongs to
    this.collection = null;     // decorations collection
    this.busy = false;          // single-flight request guard
    this.generation = 0;        // stale-response guard
    this.requestId = null;      // in-flight request id (for cancellation)
    this.debounceTimer = null;
    this._applying = false;     // true while we insert our own edit
    this.lastChangeSize = 0;    // length of last inserted text
    this._sessionEnabled = true; // used only when AppSettings is unavailable

    if (!window.editor) return;
    window.editor.onDidReady((ed) => this.init(ed));
  }

  init(editorInstance) {
    if (this.ready) return;
    this.editor = editorInstance;
    this.ready = true;

    editorInstance.onDidChangeModelContent((e) => {
      if (this._applying) return;
      this.lastChangeSize = e && e.changes && e.changes[0] ? e.changes[0].text.length : 0;
      this.dismiss();
      if (!this.enabledNow()) return;
      this.schedule();
    });

    editorInstance.onDidChangeCursorSelection(() => {
      if (this._applying) return;
      if (this.ghostText) this.dismiss();
    });

    editorInstance.onDidChangeModel(() => this.dismiss());

    editorInstance.onKeyDown((e) => {
      if (!this.ghostText) return;
      if (e.keyCode === monaco.KeyCode.Tab) {
        e.preventDefault();
        this.accept();
      } else if (e.keyCode === monaco.KeyCode.Escape) {
        e.preventDefault();
        this.dismiss();
      }
    });

    if (window.editor.onDidChangeActiveFile) {
      window.editor.onDidChangeActiveFile(() => this.dismiss());
    }

    document.addEventListener('settings-changed', () => {
      if (!this.enabledNow()) this.dismiss();
    });
  }

  // -----------------------------------------------------------------------
  // Scheduling
  // -----------------------------------------------------------------------
  schedule() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.lastChangeSize > 100) return; // paste / large edit — skip
    const delay = window.AppSettings ? (+window.AppSettings.get('autocompleteDelay') || 350) : 350;
    this.debounceTimer = setTimeout(() => this.request(), delay);
  }

  async request() {
    this.debounceTimer = null;
    if (!this.enabledNow()) return;
    if (!window.electronAPI || !window.electronAPI.aiChatOnce) return;
    if (!window.editor || !window.editor.activeFilePath) return;
    if (this.busy) return;

    const editorInstance = this.editor;
    if (!editorInstance) return;
    if (editorInstance.hasTextFocus && typeof editorInstance.hasTextFocus === 'function') {
      if (!editorInstance.hasTextFocus()) return;
    } else {
      const host = document.getElementById('monaco-host');
      if (!host || !host.contains(document.activeElement)) return;
    }

    const model = editorInstance.getModel();
    if (!model) return;
    const pos = editorInstance.getPosition();
    if (!pos) return;

    const offset = model.getOffsetAt(pos);
    const full = model.getValue();
    const before = full.slice(Math.max(0, offset - 1500), offset);
    const after = full.slice(offset, offset + 400);
    const lang = model.getLanguageId ? model.getLanguageId() : (model.getModeId ? model.getModeId() : '');
    const title = ((window.editor.getActiveFileDetails && window.editor.getActiveFileDetails()) || {}).title || 'file';

    const messages = [
      {
        role: 'system',
        content: "You are a code completion engine. Respond with ONLY the code that immediately follows the user's cursor. Rules: output raw code only — no explanations, no markdown, no code fences, no comments about the code, never repeat text that appears before or after the cursor."
      },
      {
        role: 'user',
        content: 'File: ' + title + ' (language: ' + lang + ')\n\n<BEFORE>\n' + before + '\n</BEFORE>\n<CURSOR/>\n<AFTER>\n' + after + '\n</AFTER>\n\nComplete the code right after <CURSOR/>.'
      }
    ];

    this.busy = true;
    const gen = ++this.generation;
    const id = 'ac-' + gen + '-' + Date.now();
    this.requestId = id;

    let res;
    try {
      res = await window.electronAPI.aiChatOnce({ id, messages, maxTokens: 80, temperature: 0.15 });
    } catch (err) {
      this.busy = false;
      console.debug('autocomplete:', err);
      return;
    }

    // Settle
    this.busy = false;
    if (gen !== this.generation) return; // stale (dismissed / superseded)
    if (!res || res.error || !res.content) {
      console.debug('autocomplete:', res && res.error);
      return;
    }

    // Clean text: strip a markdown fence if the model wrapped its answer.
    let text = res.content;
    const m = text.match(/^```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n?```\s*$/);
    if (m) {
      text = m[1];
    } else {
      text = text.replace(/^```[a-zA-Z0-9_-]*\r?\n/, '').replace(/\r?\n?```\s*$/, '');
    }

    // Validate (do NOT trim — indentation matters)
    if (!text || !text.length) return;
    if (text.length > 1500) return;
    if (text.indexOf('<<<TOOL') !== -1) return;

    const now = editorInstance.getPosition();
    if (!now || now.lineNumber !== pos.lineNumber || now.column !== pos.column) return;

    this.ghostText = text;
    this.ghostPos = now;

    const lines = text.split('\n');
    let display = lines[0];
    if (display.length > 180) display = display.slice(0, 180) + '…';
    if (lines.length > 1) display += ' ⏎+' + (lines.length - 1);

    const decoration = {
      range: new monaco.Range(now.lineNumber, now.column, now.lineNumber, now.column),
      options: {
        isWholeLine: false,
        after: {
          content: display,
          inlineClassName: 'ghost-text',
          cursorStops: (monaco.editor.CursorStopPolicy ? monaco.editor.CursorStopPolicy.Before : undefined)
        }
      }
    };
    if (this.collection) this.collection.clear();
    this.collection = editorInstance.createDecorationsCollection([decoration]);
  }

  // -----------------------------------------------------------------------
  // Accept / dismiss
  // -----------------------------------------------------------------------
  accept() {
    if (!this.ghostText || !this.editor) { this.dismiss(); return; }
    const pos = this.editor.getPosition();
    if (!pos || !this.ghostPos ||
        pos.lineNumber !== this.ghostPos.lineNumber ||
        pos.column !== this.ghostPos.column) {
      this.dismiss();
      return;
    }

    this._applying = true;
    try {
      this.editor.pushUndoStop();
      this.editor.executeEdits('ghost-accept', [{
        range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column),
        text: this.ghostText,
        forceMoveMarkers: true
      }]);
      this.editor.pushUndoStop();
    } finally {
      this._applying = false;
    }
    this.dismiss();
  }

  dismiss() {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.collection) {
      this.collection.clear();
      this.collection = null;
    }
    this.ghostText = null;
    this.ghostPos = null;
    this.generation++;
    if (this.requestId && window.electronAPI && window.electronAPI.aiCancelOnce) {
      window.electronAPI.aiCancelOnce(this.requestId);
    }
    this.requestId = null;
  }

  // -----------------------------------------------------------------------
  // Settings
  // -----------------------------------------------------------------------
  enabledNow() {
    if (!window.electronAPI || !window.electronAPI.aiChatOnce) return false;
    if (window.AppSettings) return !!window.AppSettings.get('autocompleteEnabled');
    return this._sessionEnabled !== false;
  }

  setEnabled(bool) {
    const value = !!bool;
    if (window.AppSettings) {
      const p = window.AppSettings.set('autocompleteEnabled', value);
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } else {
      this._sessionEnabled = value;
      if (!value) this.dismiss();
    }
  }

  isEnabled() {
    return this.enabledNow();
  }
}

window.GhostAutocomplete = GhostAutocomplete;

// Self-instantiate once window.editor exists (app.js creates it on DOMContentLoaded).
(function bootGhostAutocomplete() {
  if (window.__ghostAutocompleteBooted) return;
  if (window.editor) {
    window.__ghostAutocompleteBooted = true;
    try {
      window.ghostAutocomplete = new GhostAutocomplete();
    } catch (e) {
      console.debug('autocomplete disabled:', e);
    }
    return;
  }
  const schedule = (document.readyState === 'loading')
    ? (fn) => document.addEventListener('DOMContentLoaded', () => setTimeout(fn, 0), { once: true })
    : (fn) => setTimeout(fn, 0);
  // Retry briefly in case EditorManager is constructed a tick later.
  let attempts = 0;
  const tick = () => {
    if (window.editor) { bootGhostAutocomplete(); return; }
    if (++attempts > 50) return;
    setTimeout(tick, 100);
  };
  schedule(tick);
})();
