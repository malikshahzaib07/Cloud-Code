// ============================================================================
// Inline Edit (Ctrl+K) — Cursor / VS Code style inline chat
//
//   1. Select code (or put the cursor on a line) and press Ctrl+K.
//   2. A small floating "Describe the change…" box appears near the selection.
//   3. Enter asks the local LLM for a replacement of exactly that selection
//      and previews it in-place with green whole-line highlighting.
//   4. A floating action bar shows +N −M, Apply (Enter / Ctrl+Enter),
//      Reject (Esc) and a "Changes" popover listing removed lines.
//   5. Reject restores the original text; Apply keeps the new text.
//
// Classic browser script (no import/export). Exports: window.InlineEdit
// Depends on: window.editor (EditorManager / Monaco) and window.electronAPI.
// Every dependency is guarded — the feature silently no-ops when absent.
// ============================================================================

class InlineEdit {
  constructor() {
    this.active = false;          // gates re-entry for the whole module
    this.range = null;            // original target range in the model
    this.previewRange = null;     // range covered by the previewed text
    this.originalText = '';
    this.previewText = '';
    this.currentRequestId = null; // aiChatOnce id (for stale-guard + cancel)

    this.widget = null;           // .inline-edit-widget DOM node
    this.diffBar = null;          // .inline-diff-bar DOM node
    this.popover = null;          // .ie-removed-pop DOM node
    this.decoCollection = null;   // Monaco decorations for the preview

    this.scrollSub = null;        // disposable from onDidScroll
    this._resizeHandler = null;
    this._captureHandler = null;
    this._previewKeyHandler = null;
    this._genKeyHandler = null;
    this._busy = false;

    if (!window.editor) return;
    window.editor.onDidReady(() => this.bind());
  }

  // Lazily resolved: activeEditor is not guaranteed to be set when ready fires.
  get ed() {
    return window.editor ? window.editor.activeEditor : null;
  }

  // ---------------------------------------------------------------------------
  // Activation — Ctrl+K (document capture listener is the primary binding)
  // ---------------------------------------------------------------------------
  bind() {
    if (this._captureHandler) return;

    this._captureHandler = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      if (e.key !== 'k' && e.key !== 'K') return;

      const host = document.getElementById('monaco-host');
      const ed = this.ed;
      const editorFocused =
        (ed && ed.hasTextFocus && ed.hasTextFocus()) ||
        (host && host.contains(document.activeElement));
      if (!editorFocused) return;

      e.preventDefault();
      e.stopPropagation();
      if (this.active) this.focusInput();
      else this.activate();
    };
    document.addEventListener('keydown', this._captureHandler, true);

    // Secondary binding inside Monaco (it owns a Ctrl+K chord, so the capture
    // listener above stays the primary path).
    try {
      const ed = this.ed;
      if (ed && ed.addCommand && typeof monaco !== 'undefined') {
        ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, () => {
          if (this.active) this.focusInput();
          else this.activate();
        });
      }
    } catch (err) { /* ignore — capture listener still works */ }
  }

  focusInput() {
    if (!this.active || this.diffBar || !this.widget) return;
    const input = this.widget.querySelector('.ie-input');
    if (!input || input.disabled) return;
    try { input.focus(); } catch (err) { /* ignore */ }
    this.positionWidget();
  }

  // ---------------------------------------------------------------------------
  // Prompt phase
  // ---------------------------------------------------------------------------
  activate() {
    if (this.active) { this.focusInput(); return; }

    const ed = this.ed;
    if (!ed || !window.editor || !window.editor.activeFilePath || !window.electronAPI) return;
    if (typeof monaco === 'undefined') return;

    const model = ed.getModel();
    if (!model) return;

    // Target: the selection, or the whole current line when the selection is empty.
    let range = null;
    const sel = ed.getSelection();
    if (sel && !sel.isEmpty()) {
      range = new monaco.Range(sel.startLineNumber, sel.startColumn, sel.endLineNumber, sel.endColumn);
    } else {
      const pos = ed.getPosition();
      if (!pos) return;
      const lineLen = model.getLineContent(pos.lineNumber).length;
      range = new monaco.Range(pos.lineNumber, 1, pos.lineNumber, lineLen + 1);
    }

    const host = document.getElementById('monaco-host');
    if (!host) return;

    this.range = range;
    this.originalText = model.getValueInRange(range);
    this.active = true;
    this._busy = false;

    const widget = document.createElement('div');
    widget.className = 'inline-edit-widget';
    widget.id = 'inline-edit-widget';
    widget.innerHTML =
      '<div class="ie-row"><span class="ie-spark">✦</span>' +
      '<input class="ie-input" placeholder="Describe the change… (Enter to apply, Esc to cancel)" spellcheck="false">' +
      '<span class="ie-key-hint">⏎</span></div>' +
      '<div class="ie-status"></div>';
    host.appendChild(widget);
    this.widget = widget;

    // Don't let the editor steal focus / global handlers fire from the widget.
    widget.addEventListener('mousedown', (e) => e.stopPropagation());
    widget.addEventListener('keydown', (e) => e.stopPropagation());

    const input = widget.querySelector('.ie-input');
    const status = widget.querySelector('.ie-status');
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.cancel();
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        this.submit();
      }
    });

    // Keep the widget glued to its anchor while scrolling / resizing.
    if (ed.onDidScroll) {
      try {
        this.scrollSub = ed.onDidScroll(() => this._reposition());
      } catch (err) { this.scrollSub = null; }
    }
    this._resizeHandler = () => this._reposition();
    window.addEventListener('resize', this._resizeHandler);

    this._reposition();
    setTimeout(() => {
      try { if (this.widget === widget) input.focus(); } catch (err) { /* ignore */ }
    }, 0);
  }

  // ---------------------------------------------------------------------------
  // Positioning (widget + action bar live inside #monaco-host → position:absolute)
  // ---------------------------------------------------------------------------
  positionWidget() {
    const ed = this.ed;
    if (!ed || !this.widget || !this.range) return;
    const host = document.getElementById('monaco-host');
    if (!host) return;
    const vp = ed.getScrolledVisiblePosition(this.range.getStartPosition());
    if (!vp) return;

    const w = this.widget;
    let top = vp.top - (w.offsetHeight || 60) - 8;
    if (top < 4) top = vp.top + vp.height + 8;
    let left = Math.max(4, vp.left);
    left = Math.min(left, host.clientWidth - (w.offsetWidth || 360) - 4);
    if (left < 4) left = 4;

    w.style.top = top + 'px';
    w.style.left = left + 'px';
  }

  positionBar() {
    const ed = this.ed;
    if (!ed || !this.diffBar) return;
    const host = document.getElementById('monaco-host');
    if (!host) return;
    const anchor = this.previewRange || this.range;
    if (!anchor) return;
    const vp = ed.getScrolledVisiblePosition(anchor.getStartPosition());
    if (!vp) return;

    const bar = this.diffBar;
    let top = vp.top - (bar.offsetHeight || 30) - 8;
    if (top < 4) top = vp.top + vp.height + 8;
    let left = Math.max(4, vp.left);
    left = Math.min(left, host.clientWidth - (bar.offsetWidth || 360) - 4);
    if (left < 4) left = 4;

    bar.style.top = top + 'px';
    bar.style.left = left + 'px';
  }

  // Repositions whichever elements are currently present.
  _reposition() {
    if (!this.active) return;
    try { this.positionWidget(); } catch (err) { /* ignore */ }
    try { this.positionBar(); } catch (err) { /* ignore */ }
  }

  // ---------------------------------------------------------------------------
  // Ask the model for a replacement of this.originalText
  // ---------------------------------------------------------------------------
  async submit() {
    if (!this.active || this._busy) return;
    if (!this.widget) return;

    const ed = this.ed;
    const model = ed ? ed.getModel() : null;
    if (!ed || !model) return;
    if (!window.electronAPI || !window.electronAPI.aiChatOnce) return;

    const input = this.widget.querySelector('.ie-input');
    const status = this.widget.querySelector('.ie-status');
    if (!input || !status) return;

    const instruction = (input.value || '').trim();
    if (!instruction) {
      status.textContent = 'Enter an instruction first';
      status.classList.add('error');
      return;
    }

    this._busy = true;
    status.classList.remove('error');
    status.textContent = '✦ Generating…';
    input.disabled = true;
    this._attachGenKeys(); // input is disabled → handle Esc while generating

    const genId = 'inline-' + Date.now();
    this.currentRequestId = genId;

    const lang = model.getLanguageId
      ? model.getLanguageId()
      : (model.getModeId ? model.getModeId() : '');
    let title = '';
    try {
      const details = window.editor.getActiveFileDetails
        ? window.editor.getActiveFileDetails()
        : null;
      title = (details && details.title) || window.editor.activeFilePath || '';
    } catch (err) {
      title = window.editor.activeFilePath || '';
    }

    const messages = [
      {
        role: 'system',
        content: 'You are an inline code editor inside a code editor. ' +
          'Replace ONLY the given selected code exactly as instructed. ' +
          'Output ONLY the replacement code: no markdown, no code fences, no explanations, ' +
          'no commentary before or after. The output must be the complete replacement text ' +
          'for the selection.'
      },
      {
        role: 'user',
        content: 'File: ' + title + ' (language: ' + lang + ')\n\n' +
          'Instruction: ' + instruction + '\n\n' +
          'Selected code:\n```\n' + this.originalText + '\n```\n' +
          'Return only the replacement code.'
      }
    ];

    let res = null;
    try {
      res = await window.electronAPI.aiChatOnce({
        id: genId,
        messages: messages,
        maxTokens: 2000,
        temperature: 0.3
      });
    } catch (err) {
      res = { error: (err && err.message) || String(err) };
    }
    this._detachGenKeys();

    // Stale (cancelled / superseded) — the widget may already be gone.
    if (!this.active || this.currentRequestId !== genId) return;

    this._busy = false;
    input.disabled = false;

    if (res && res.error) {
      status.textContent = '⚠ ' + res.error;
      status.classList.add('error');
      try { input.focus(); } catch (err) { /* ignore */ }
      return;
    }

    // Unwrap code fences — otherwise keep the EXACT text (whitespace matters).
    let text = (res && res.content) || '';
    const fenced = text.match(/^```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n?```\s*$/);
    if (fenced) {
      text = fenced[1];
    } else {
      text = text.replace(/^```[a-zA-Z0-9_-]*\r?\n/, '').replace(/\r?\n?```\s*$/, '');
    }

    if (!text || !text.trim()) {
      status.textContent = '⚠ Empty response from model';
      status.classList.add('error');
      try { input.focus(); } catch (err) { /* ignore */ }
      return;
    }

    if (text === this.originalText) {
      status.textContent = 'No changes produced';
      status.classList.remove('error');
      try { input.focus(); } catch (err) { /* ignore */ }
      return;
    }

    this.showPreview(text);
  }

  // Escape while the input is disabled (generation in flight).
  _attachGenKeys() {
    if (this._genKeyHandler) return;
    this._genKeyHandler = (e) => {
      if (!this.active || this.currentRequestId == null) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.cancel();
      }
    };
    document.addEventListener('keydown', this._genKeyHandler, true);
  }

  _detachGenKeys() {
    if (!this._genKeyHandler) return;
    document.removeEventListener('keydown', this._genKeyHandler, true);
    this._genKeyHandler = null;
  }

  // ---------------------------------------------------------------------------
  // Preview phase — text is already in the model, highlighted in green
  // ---------------------------------------------------------------------------
  showPreview(newText) {
    const ed = this.ed;
    if (!ed || !this.range || typeof monaco === 'undefined') return;
    const model = ed.getModel();
    if (!model) return;
    const host = document.getElementById('monaco-host');
    if (!host) return;

    try { ed.pushUndoStop(); } catch (err) { /* ignore */ }
    try {
      ed.executeEdits('inline-edit-preview', [
        { range: this.range, text: newText, forceMoveMarkers: true }
      ]);
    } catch (err) {
      console.debug('inline-edit preview failed:', err);
      return;
    }
    try { ed.pushUndoStop(); } catch (err) { /* ignore */ }

    // Compute the range now covered by the previewed text.
    const start = this.range.getStartPosition();
    let endLine, endCol;
    if (newText.indexOf('\n') === -1) {
      endLine = start.lineNumber;
      endCol = start.column + newText.length;
    } else {
      const lines = newText.split('\n');
      endLine = start.lineNumber + lines.length - 1;
      endCol = lines[lines.length - 1].length + 1;
    }
    this.previewRange = new monaco.Range(start.lineNumber, start.column, endLine, endCol);
    this.previewText = newText;

    // Whole-line green highlighting over the previewed lines (capped at 2000).
    const decos = [];
    const lastLine = Math.min(endLine, model.getLineCount(), start.lineNumber + 1999);
    for (let L = start.lineNumber; L <= lastLine; L++) {
      decos.push({
        range: new monaco.Range(L, 1, L, model.getLineContent(L).length + 1),
        options: {
          isWholeLine: true,
          className: 'ie-line-added',
          linesDecorationsClassName: 'ie-gutter-add'
        }
      });
    }
    try {
      this.decoCollection = ed.createDecorationsCollection(decos);
    } catch (err) {
      this.decoCollection = null;
    }

    // Hide the prompt, show the action bar.
    if (this.widget) this.widget.style.display = 'none';

    const bar = document.createElement('div');
    bar.className = 'inline-diff-bar';
    bar.id = 'inline-diff-bar';
    bar.innerHTML =
      '<span class="ie-stats"><b class="ie-add">+0</b><b class="ie-del">−0</b></span>' +
      '<button class="ie-btn ie-accept" title="Apply (Enter)">✓ Apply</button>' +
      '<button class="ie-btn ie-reject" title="Reject (Esc)">✕ Reject</button>' +
      '<button class="ie-btn ie-changes">Changes ▾</button>' +
      '<span class="ie-status-inline"></span>';
    host.appendChild(bar);
    this.diffBar = bar;

    const stats = this._lcsDiffStats(this.originalText.split('\n'), newText.split('\n'));
    const addEl = bar.querySelector('.ie-add');
    const delEl = bar.querySelector('.ie-del');
    if (addEl) addEl.textContent = '+' + stats.added;
    if (delEl) delEl.textContent = '−' + stats.removed;

    const changesBtn = bar.querySelector('.ie-changes');
    if (changesBtn && stats.removed === 0) {
      changesBtn.style.display = 'none'; // nothing was removed → no popover
    } else if (changesBtn) {
      changesBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._toggleRemovedPop(stats.removedLines);
      });
    }

    const acceptBtn = bar.querySelector('.ie-accept');
    if (acceptBtn) {
      acceptBtn.addEventListener('click', (e) => { e.stopPropagation(); this.accept(); });
    }
    const rejectBtn = bar.querySelector('.ie-reject');
    if (rejectBtn) {
      rejectBtn.addEventListener('click', (e) => { e.stopPropagation(); this.reject(); });
    }
    const statusInline = bar.querySelector('.ie-status-inline');
    if (statusInline) statusInline.textContent = 'Preview — Enter applies, Esc rejects';

    bar.addEventListener('mousedown', (e) => e.stopPropagation());
    bar.addEventListener('keydown', (e) => e.stopPropagation());

    this._attachPreviewKeys();
    this._reposition();
  }

  _attachPreviewKeys() {
    if (this._previewKeyHandler) return;
    this._previewKeyHandler = (e) => {
      if (!this.active) return;
      // Ignore keys typed into text fields outside the editor (chat, terminal…)
      // so Enter/Esc there don't apply or reject the preview.
      const t = e.target;
      const inMonaco = !!(t && t.closest && t.closest('.monaco-editor'));
      const typingElsewhere = !!t &&
        (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) &&
        !inMonaco;
      if (typingElsewhere) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.reject();
        return;
      }
      if (e.key === 'Enter') { // plain Enter or Ctrl+Enter
        e.preventDefault();
        e.stopPropagation();
        this.accept();
      }
    };
    document.addEventListener('keydown', this._previewKeyHandler, true);
  }

  _detachPreviewKeys() {
    if (!this._previewKeyHandler) return;
    document.removeEventListener('keydown', this._previewKeyHandler, true);
    this._previewKeyHandler = null;
  }

  _toggleRemovedPop(removedLines) {
    const bar = this.diffBar;
    if (!bar) return;

    if (this.popover && this.popover.parentNode) {
      this.popover.parentNode.removeChild(this.popover);
      this.popover = null;
      return;
    }

    const pop = document.createElement('div');
    pop.className = 'ie-removed-pop';
    const list = removedLines || [];
    if (list.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ie-removed-line';
      empty.textContent = ' (no removed lines) ';
      pop.appendChild(empty);
    } else {
      for (let i = 0; i < list.length; i++) {
        const lineEl = document.createElement('div');
        lineEl.className = 'ie-removed-line';
        lineEl.textContent = list[i] === '' ? ' ' : list[i];
        pop.appendChild(lineEl);
      }
    }
    bar.appendChild(pop);
    this.popover = pop;
  }

  // ---------------------------------------------------------------------------
  // Apply / Reject / Cancel
  // ---------------------------------------------------------------------------
  accept() {
    if (!this.active) return;
    this._cleanup(true);
  }

  reject() {
    if (!this.active) return;

    const ed = this.ed;
    const model = ed ? ed.getModel() : null;
    if (ed && model && this.previewRange && this.previewText && typeof monaco !== 'undefined') {
      try { ed.pushUndoStop(); } catch (err) { /* ignore */ }
      try {
        const cur = model.getValueInRange(this.previewRange);
        if (cur === this.previewText) {
          ed.executeEdits('inline-edit-reject', [
            { range: this.previewRange, text: this.originalText, forceMoveMarkers: true }
          ]);
        } else {
          // Text moved (edited after preview) — locate it before reverting.
          const idx = model.getValue().indexOf(this.previewText);
          if (idx >= 0) {
            const s = model.getPositionAt(idx);
            const e2 = model.getPositionAt(idx + this.previewText.length);
            ed.executeEdits('inline-edit-reject', [
              {
                range: new monaco.Range(s.lineNumber, s.column, e2.lineNumber, e2.column),
                text: this.originalText,
                forceMoveMarkers: true
              }
            ]);
          }
        }
      } catch (err) { /* ignore */ }
      try { ed.pushUndoStop(); } catch (err) { /* ignore */ }
    }

    this._cleanup(false);
  }

  cancel() {
    if (!this.active) return;
    if (this.currentRequestId && window.electronAPI && window.electronAPI.aiCancelOnce) {
      try { window.electronAPI.aiCancelOnce(this.currentRequestId); } catch (err) { /* ignore */ }
    }
    this._cleanup(false);
  }

  // Shared teardown. `applied` === true → the preview text stays in the model.
  _cleanup(applied) {
    const path = window.editor ? window.editor.activeFilePath : null;
    const appliedText = this.previewText;

    this._detachPreviewKeys();
    this._detachGenKeys();

    if (this.decoCollection) {
      try { this.decoCollection.clear(); } catch (err) { /* ignore */ }
      this.decoCollection = null;
    }
    if (this.scrollSub) {
      try { this.scrollSub.dispose(); } catch (err) { /* ignore */ }
      this.scrollSub = null;
    }
    if (this._resizeHandler) {
      window.removeEventListener('resize', this._resizeHandler);
      this._resizeHandler = null;
    }

    this._removeNode(this.popover);
    this.popover = null;
    this._removeNode(this.widget);
    this.widget = null;
    this._removeNode(this.diffBar);
    this.diffBar = null;

    this.active = false;
    this._busy = false;
    this.range = null;
    this.previewRange = null;
    this.originalText = '';
    this.previewText = '';
    this.currentRequestId = null;

    const ed = this.ed;
    if (ed) { try { ed.focus(); } catch (err) { /* ignore */ } }

    if (applied) {
      document.dispatchEvent(new CustomEvent('inline-edit-applied', {
        detail: { path: path, text: appliedText }
      }));
    }
  }

  _removeNode(node) {
    if (node && node.parentNode) {
      try { node.parentNode.removeChild(node); } catch (err) { /* ignore */ }
    }
  }

  // ---------------------------------------------------------------------------
  // Line diff stats: exact LCS when affordable, approximation for huge inputs.
  // Returns { added, removed, removedLines }
  // ---------------------------------------------------------------------------
  _lcsDiffStats(a, b) {
    const removedLines = [];

    if (a.length * b.length <= 4000000) {
      const n = a.length;
      const m = b.length;
      const rowLen = m + 1;
      const dp = new Array((n + 1) * rowLen).fill(0);

      for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
          dp[i * rowLen + j] = a[i] === b[j]
            ? dp[(i + 1) * rowLen + j + 1] + 1
            : Math.max(dp[(i + 1) * rowLen + j], dp[i * rowLen + j + 1]);
        }
      }

      let i = 0, j = 0, added = 0, removed = 0;
      while (i < n && j < m) {
        if (a[i] === b[j]) {
          i++; j++;
        } else if (dp[(i + 1) * rowLen + j] >= dp[i * rowLen + j + 1]) {
          removed++;
          removedLines.push(a[i]);
          i++;
        } else {
          added++;
          j++;
        }
      }
      while (i < n) { removed++; removedLines.push(a[i]); i++; }
      while (j < m) { added++; j++; }

      return { added: added, removed: removed, removedLines: removedLines };
    }

    // Too large for LCS — approximate: lines of a that never appear in b.
    const setB = new Set(b);
    for (let i = 0; i < a.length && removedLines.length < 100; i++) {
      if (!setB.has(a[i])) removedLines.push(a[i]);
    }
    return {
      added: Math.max(0, b.length - a.length),
      removed: Math.max(0, a.length - b.length),
      removedLines: removedLines
    };
  }
}

window.InlineEdit = InlineEdit;
