// Monaco Editor & Tabs Manager (source files + diff review tabs)
class EditorManager {
  constructor(hostId, tabsBarId) {
    this.host = document.getElementById(hostId);
    this.tabsBar = document.getElementById(tabsBarId);
    this.emptyState = document.getElementById('empty-state');
    this.monacoInstance = null;
    this.activeEditor = null;
    this.diffEditor = null;
    this.editorDiv = null;
    this.diffHost = null;
    this.diffToolbar = null;
    this.diffPane = null;

    this.tabs = new Map();      // filePath -> { filePath, title, originalContent, model, dirty }
    this.diffTabs = new Map();  // diffId -> { id, title, modelA, modelB, meta }
    this.tabOrder = [];         // 'file:<path>' | 'diff:<id>' in activation order
    this.activeFilePath = null;
    this.activeDiffId = null;

    this.pendingOpen = null;
    this.pendingDiffOpen = null;
    this._editorReady = false;
    this._readyCallbacks = [];
    this._activeFileCallbacks = [];

    this.initMonaco();
  }

  // -------------------------------------------------------------------------
  // Lifecycle hooks (used by autocomplete & search modules)
  // -------------------------------------------------------------------------
  onDidReady(fn) {
    if (this._editorReady) {
      fn(this.activeEditor);
    } else {
      this._readyCallbacks.push(fn);
    }
  }

  onDidChangeActiveFile(fn) {
    this._activeFileCallbacks.push(fn);
  }

  _emitActiveFile() {
    const path = this.activeFilePath;
    this._activeFileCallbacks.forEach((fn) => {
      try { fn(path); } catch (e) { console.error('onDidChangeActiveFile handler error:', e); }
    });
  }

  get activeKey() {
    if (this.activeDiffId) return 'diff:' + this.activeDiffId;
    if (this.activeFilePath) return 'file:' + this.activeFilePath;
    return null;
  }

  initMonaco() {
    if (typeof require === 'undefined' || !require.config) return;

    require.config({
      paths: { vs: '../../node_modules/monaco-editor/min/vs' }
    });

    require(['vs/editor/editor.main'], () => {
      this.monacoInstance = monaco;

      // Custom VS Code Dark Theme matching
      monaco.editor.defineTheme('cloudcode-dark', {
        base: 'vs-dark',
        inherit: true,
        rules: [
          { token: 'comment', foreground: '6a9955' },
          { token: 'keyword', foreground: '569cd6' },
          { token: 'string', foreground: 'ce9178' },
          { token: 'number', foreground: 'b5cea8' },
          { token: 'type', foreground: '4ec9b0' },
          { token: 'function', foreground: 'dcdcaa' }
        ],
        colors: {
          'editor.background': '#1e1e1e',
          'editor.foreground': '#d4d4d4',
          'editorLineNumber.foreground': '#858585',
          'editorLineNumber.activeForeground': '#c6c6c6',
          'editorCursor.foreground': '#aeafad',
          'editor.selectionBackground': '#264f78',
          'editor.inactiveSelectionBackground': '#3a3d41',
          'editorGutter.background': '#1e1e1e'
        }
      });

      // Light counterpart (the app ships with the light theme as default).
      monaco.editor.defineTheme('cloudcode-light', {
        base: 'vs',
        inherit: true,
        rules: [
          { token: 'comment', foreground: '008000' },
          { token: 'keyword', foreground: '0000ff' },
          { token: 'string', foreground: 'a31515' },
          { token: 'number', foreground: '098658' },
          { token: 'type', foreground: '267f99' },
          { token: 'function', foreground: '795e26' }
        ],
        colors: {
          'editor.background': '#ffffff',
          'editor.foreground': '#1f1f1f',
          'editorLineNumber.foreground': '#9d9d9d',
          'editorLineNumber.activeForeground': '#333333',
          'editorCursor.foreground': '#000000',
          'editor.selectionBackground': '#add6ff',
          'editor.inactiveSelectionBackground': '#e5ebf1',
          'editorGutter.background': '#ffffff'
        }
      });

      // Code editor container
      this.editorDiv = document.createElement('div');
      this.editorDiv.id = 'code-editor-pane';
      this.editorDiv.style.width = '100%';
      this.editorDiv.style.height = '100%';
      this.host.appendChild(this.editorDiv);

      this.activeEditor = monaco.editor.create(this.editorDiv, {
        theme: this.resolveMonacoTheme(),
        automaticLayout: true,
        fontSize: 14,
        fontFamily: 'Consolas, "Courier New", monospace',
        minimap: { enabled: true },
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        lineNumbers: 'on',
        roundedSelection: false,
        tabSize: 2
      });

      this.activeEditor.onDidChangeCursorPosition((e) => {
        const posEl = document.getElementById('statusbar-pos');
        if (posEl) {
          posEl.textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`;
        }
      });

      this.activeEditor.onDidChangeModelContent(() => {
        if (!this.activeFilePath) return;
        const currentTab = this.tabs.get(this.activeFilePath);
        if (currentTab) {
          const currentVal = this.activeEditor.getValue();
          currentTab.dirty = currentVal !== currentTab.originalContent;
          this.renderTabs();
        }
      });

      // Bind Ctrl+S shortcut inside Monaco
      this.activeEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        this.saveActiveFile();
      });

      window.addEventListener('resize', () => this.relayout());

      // Toggling or dragging the agent panel resizes the host without a window
      // resize event, so watch the host box and relayout on the next frame.
      if (typeof ResizeObserver !== 'undefined' && this.host) {
        try {
          this._relayoutQueued = false;
          this.hostObserver = new ResizeObserver(() => {
            if (this._relayoutQueued) return;
            this._relayoutQueued = true;
            requestAnimationFrame(() => {
              this._relayoutQueued = false;
              this.relayout();
            });
          });
          this.hostObserver.observe(this.host);
        } catch (e) {
          // ResizeObserver unavailable — the window resize listener still works
        }
      }

      this._editorReady = true;
      const readyCbs = this._readyCallbacks.splice(0);
      readyCbs.forEach((fn) => {
        try { fn(this.activeEditor); } catch (e) { console.error(e); }
      });

      if (this.pendingDiffOpen) {
        const opts = this.pendingDiffOpen;
        this.pendingDiffOpen = null;
        this.openDiffTab(opts);
      }
      if (this.pendingOpen) {
        const { filePath, content } = this.pendingOpen;
        this.pendingOpen = null;
        this.openFile(filePath, content);
      }
    });
  }

  // -------------------------------------------------------------------------
  // View switching
  // -------------------------------------------------------------------------
  _hideEmptyState() {
    if (this.emptyState) this.emptyState.style.display = 'none';
  }

  _showEmpty() {
    if (this.emptyState) this.emptyState.style.display = 'flex';
    if (this.editorDiv) this.editorDiv.style.display = 'none';
    if (this.diffHost) this.diffHost.classList.add('hidden');
    const titleEl = document.getElementById('active-file-title');
    if (titleEl) titleEl.textContent = 'Cloud Code';
    this.renderTabs();
    this._emitActiveFile();
  }

  _showCodePane() {
    this._hideEmptyState();
    if (this.editorDiv) this.editorDiv.style.display = '';
    if (this.diffHost) this.diffHost.classList.add('hidden');
  }

  _showDiffPane() {
    this._hideEmptyState();
    if (this.editorDiv) this.editorDiv.style.display = 'none';
    if (this.diffHost) this.diffHost.classList.remove('hidden');
  }

  // -------------------------------------------------------------------------
  // File tabs
  // -------------------------------------------------------------------------
  openFile(filePath, content) {
    if (!this.monacoInstance || !this.activeEditor) {
      this.pendingOpen = { filePath, content };
      return;
    }

    const filename = filePath.split(/[\\/]/).pop();
    const lang = this._languageFor(filename);

    let tab = this.tabs.get(filePath);
    if (!tab) {
      const uri = this.monacoInstance.Uri.file(filePath);
      let model = this.monacoInstance.editor.getModel(uri);
      if (!model) {
        model = this.monacoInstance.editor.createModel(content, lang, uri);
      } else {
        model.setValue(content);
      }

      tab = {
        filePath,
        title: filename,
        originalContent: content,
        model: model,
        dirty: false
      };
      this.tabs.set(filePath, tab);
      this.tabOrder.push('file:' + filePath);
    }

    this._activateFile(filePath);
  }

  _activateFile(filePath) {
    const tab = this.tabs.get(filePath);
    if (!tab || !this.activeEditor) return;

    this.activeFilePath = filePath;
    this.activeDiffId = null;
    this._showCodePane();
    this.activeEditor.setModel(tab.model);
    this.activeEditor.focus();

    const lang = this._languageFor(tab.title);
    const langEl = document.getElementById('statusbar-lang');
    if (langEl) langEl.textContent = lang.toUpperCase();

    const titleEl = document.getElementById('active-file-title');
    if (titleEl) titleEl.textContent = `${tab.title}${tab.dirty ? ' •' : ''} - Cloud Code`;

    this.renderTabs();
    this._emitActiveFile();
  }

  _languageFor(filename) {
    return window.getLanguageFromFilename
      ? window.getLanguageFromFilename(filename)
      : 'plaintext';
  }

  saveActiveFile() {
    if (!this.activeFilePath || !window.electronAPI) return;
    const tab = this.tabs.get(this.activeFilePath);
    if (!tab) return;

    const content = this.activeEditor.getValue();
    window.electronAPI.writeFile(this.activeFilePath, content).then(() => {
      tab.originalContent = content;
      tab.dirty = false;
      this.renderTabs();

      const titleEl = document.getElementById('active-file-title');
      if (titleEl) titleEl.textContent = `${tab.title} - Cloud Code`;

      // Notify dependents (agent change tracker, file index, etc.)
      document.dispatchEvent(new CustomEvent('file-saved', { detail: { path: this.activeFilePath } }));

      const aiStatus = document.getElementById('statusbar-ai-status');
      if (aiStatus) {
        const orig = aiStatus.textContent;
        aiStatus.textContent = 'Saved!';
        setTimeout(() => { aiStatus.textContent = orig; }, 1500);
      }
    }).catch(err => {
      alert(`Error saving file: ${err.message}`);
    });
  }

  // -------------------------------------------------------------------------
  // Diff review tabs
  // -------------------------------------------------------------------------
  /** Re-run Monaco layout (after a container resize). */
  relayout() {
    try {
      if (this.activeEditor) this.activeEditor.layout();
      if (this.diffEditor) this.diffEditor.layout();
    } catch (e) {
      // editor not created yet
    }
  }

  /** Map a UI theme name to a Monaco theme id (accepts light/dark/cloud-* forms). */
  resolveMonacoTheme(name) {
    const t = String(name == null ? '' : name).toLowerCase();
    if (t === 'cloud-light' || t === 'light' || t === 'cloudcode-light') return 'cloudcode-light';
    if (t === 'cloud-dark' || t === 'dark' || t === 'cloudcode-dark') return 'cloudcode-dark';
    const dom = (document.documentElement && document.documentElement.dataset &&
      document.documentElement.dataset.theme) || '';
    return dom === 'light' ? 'cloudcode-light' : 'cloudcode-dark';
  }

  /** Switch editor theme at runtime. Accepts 'light'/'dark'/'cloud-light'/'cloud-dark'. */
  setTheme(name) {
    const id = this.resolveMonacoTheme(name);
    this.themeName = id;
    try {
      if (this.monacoInstance && this.monacoInstance.editor) this.monacoInstance.editor.setTheme(id);
    } catch (e) {
      // monaco not initialised yet
    }
    return id;
  }

  updateWindowTitle() {
    const tab = this.activeFilePath ? this.tabs.get(this.activeFilePath) : null;
    const el = document.getElementById('active-file-title');
    if (!el) return;
    if (tab) el.textContent = `${tab.title}${tab.dirty ? ' •' : ''} - Cloud Code`;
    else if (window.explorer && window.explorer.rootPath) {
      const name = String(window.explorer.rootPath).split(/[\\/]/).filter(Boolean).pop();
      el.textContent = name || 'Cloud Code';
    } else {
      el.textContent = 'Cloud Code - AI Code Editor';
    }
  }

  /**
   * Re-read files that changed on disk (agent edits, git, an external editor).
   * Clean buffers refresh silently; buffers with unsaved edits are preserved and
   * flagged instead of being clobbered.
   */
  async reloadExternallyChanged(paths) {
    const result = { reloaded: 0, conflicted: 0 };
    if (!paths || !paths.length || !this.tabs || this.tabs.size === 0) return result;

    const normalize = (p) => String(p || '').replace(/\\/g, '/');
    const rootNorm = normalize(window.explorer ? window.explorer.rootPath : '');

    for (const rel of paths) {
      const relNorm = normalize(rel);
      const abs = /^[a-zA-Z]:\//.test(relNorm) ? relNorm
        : (rootNorm ? rootNorm + '/' + relNorm.replace(/^\/+/, '') : '');
      if (!abs) continue;
      const tab = this.tabs.get(abs);
      if (!tab || !tab.model) continue;

      let disk = null;
      try {
        disk = await window.electronAPI.readFile(abs);
      } catch (e) {
        // removed on disk
        if (tab.dirty) {
          tab.deletedOnDisk = true;
          result.conflicted++;
        } else {
          this.closeByKey(abs);
        }
        continue;
      }

      if (tab.model.getValue() === disk) {
        tab.changedOnDisk = false;
        tab.deletedOnDisk = false;
        continue;
      }

      if (tab.dirty) {
        tab.changedOnDisk = true;   // keep the user's edits
        result.conflicted++;
      } else {
        // Update the baseline BEFORE setValue so the change listener sees a
        // match and does not flag a freshly reloaded buffer as dirty.
        tab.originalContent = disk;
        tab.model.setValue(disk);
        tab.dirty = false;
        tab.changedOnDisk = false;
        result.reloaded++;
      }
    }

    if (result.reloaded || result.conflicted) {
      this.renderTabs();
      this.updateWindowTitle();
    }
    return result;
  }

  openDiffTab(opts) {
    if (!this.monacoInstance) {
      this.pendingDiffOpen = opts;
      return;
    }
    const { id, title, oldContent = '', newContent = '', meta = {} } = opts;
    if (!id) return;

    let tab = this.diffTabs.get(id);
    if (tab) {
      tab.modelA.setValue(oldContent);
      tab.modelB.setValue(newContent);
      tab.title = title || tab.title;
      tab.meta = meta;
    } else {
      const lang = this._languageFor((title || id).replace(/\s*\(Changes\)\s*$/, ''));
      const modelA = monaco.editor.createModel(
        oldContent, lang,
        monaco.Uri.parse('inmemory://diff/' + encodeURIComponent(id) + '/original')
      );
      const modelB = monaco.editor.createModel(
        newContent, lang,
        monaco.Uri.parse('inmemory://diff/' + encodeURIComponent(id) + '/modified')
      );
      tab = { id, title: title || id, modelA, modelB, meta };
      this.diffTabs.set(id, tab);
      this.tabOrder.push('diff:' + id);
    }
    this.activateDiff(id);
  }

  _ensureDiffUI() {
    if (this.diffHost) return;

    this.diffHost = document.createElement('div');
    this.diffHost.className = 'diff-host hidden';

    this.diffToolbar = document.createElement('div');
    this.diffToolbar.className = 'diff-toolbar';

    this.diffPane = document.createElement('div');
    this.diffPane.className = 'diff-pane';

    this.diffHost.appendChild(this.diffToolbar);
    this.diffHost.appendChild(this.diffPane);
    this.host.appendChild(this.diffHost);

    this.diffEditor = monaco.editor.createDiffEditor(this.diffPane, {
      theme: 'cloudcode-dark',
      automaticLayout: true,
      fontSize: 13,
      fontFamily: 'Consolas, "Courier New", monospace',
      renderSideBySide: true,
      originalEditable: false,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      ignoreTrimWhitespace: false,
      renderOverviewRuler: true
    });
  }

  activateDiff(id) {
    const tab = this.diffTabs.get(id);
    if (!tab || !this.monacoInstance) return;

    this._ensureDiffUI();
    this.activeDiffId = id;
    this.activeFilePath = null;
    this._showDiffPane();

    this.diffEditor.setModel({ original: tab.modelA, modified: tab.modelB });

    const stats = this._diffStats(tab.modelA.getValue(), tab.modelB.getValue());
    this._renderDiffToolbar(tab, stats);

    document.getElementById('statusbar-lang') &&
      (document.getElementById('statusbar-lang').textContent = 'DIFF');
    const titleEl = document.getElementById('active-file-title');
    if (titleEl) titleEl.textContent = `${tab.title} (Changes) - Cloud Code`;

    this.renderTabs();
    setTimeout(() => this.diffEditor && this.diffEditor.layout(), 0);
    this._emitActiveFile();
  }

  _renderDiffToolbar(tab, stats) {
    const meta = tab.meta || {};
    const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    this.diffToolbar.innerHTML = `
      <span class="diff-badge">◈ DIFF</span>
      <span class="diff-title">${esc(tab.title)}</span>
      <span class="diff-stats"><span class="diff-add">+${stats.added}</span> <span class="diff-del">−${stats.removed}</span></span>
      <span class="diff-spacer"></span>
      ${meta.onAccept ? `<button class="diff-btn accept" id="diff-accept-btn">${esc(meta.acceptLabel || 'Accept Changes')}</button>` : ''}
      ${meta.onRevert ? `<button class="diff-btn revert" id="diff-revert-btn">${esc(meta.revertLabel || 'Discard')}</button>` : ''}
      <button class="diff-btn ghost" id="diff-close-btn" title="Close (Ctrl+W)">✕</button>
    `;

    const acceptBtn = document.getElementById('diff-accept-btn');
    if (acceptBtn) {
      acceptBtn.onclick = async () => {
        const finalContent = this.diffEditor.getModifiedEditor().getValue();
        acceptBtn.disabled = true;
        try {
          if (meta.onAccept) await meta.onAccept(finalContent);
        } catch (e) {
          console.error('Diff accept failed:', e);
          alert('Accept failed: ' + e.message);
          acceptBtn.disabled = false;
        }
      };
    }

    const revertBtn = document.getElementById('diff-revert-btn');
    if (revertBtn) {
      revertBtn.onclick = async () => {
        revertBtn.disabled = true;
        try {
          if (meta.onRevert) await meta.onRevert();
        } catch (e) {
          console.error('Diff discard failed:', e);
          alert('Discard failed: ' + e.message);
          revertBtn.disabled = false;
        }
      };
    }

    const closeBtn = document.getElementById('diff-close-btn');
    if (closeBtn) closeBtn.onclick = (e) => this.closeByKey('diff:' + tab.id, e);
  }

  // Simple LCS line diff stats (+added / −removed), capped for huge files
  _diffStats(oldText, newText) {
    const a = oldText.split('\n');
    const b = newText.split('\n');
    if (a.length > 3000 || b.length > 3000) {
      return { added: b.length - a.length > 0 ? b.length - a.length : 0,
               removed: a.length - b.length > 0 ? a.length - b.length : 0 };
    }
    const n = a.length, m = b.length;
    // dp over (n+1) x (m+1)
    const dp = new Array((n + 1) * (m + 1)).fill(0);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * (m + 1) + j] = a[i] === b[j]
          ? dp[(i + 1) * (m + 1) + (j + 1)] + 1
          : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + (j + 1)]);
      }
    }
    let i = 0, j = 0, added = 0, removed = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { i++; j++; }
      else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + (j + 1)]) { removed++; i++; }
      else { added++; j++; }
    }
    added += m - j;
    removed += n - i;
    return { added, removed };
  }

  // -------------------------------------------------------------------------
  // Closing
  // -------------------------------------------------------------------------
  closeTab(filePath, e) {
    this.closeByKey('file:' + filePath, e);
  }

  closeByKey(key, e) {
    if (e) e.stopPropagation();

    if (key.startsWith('diff:')) {
      const id = key.slice(5);
      const tab = this.diffTabs.get(id);
      if (!tab) return;
      if (this.activeDiffId === id && this.diffEditor) {
        // detach models before disposing
        try { this.diffEditor.setModel(null); } catch (err) {}
      }
      try { tab.modelA.dispose(); } catch (err) {}
      try { tab.modelB.dispose(); } catch (err) {}
      this.diffTabs.delete(id);
      this.tabOrder = this.tabOrder.filter((k) => k !== key);
      if (this.activeDiffId === id) {
        this.activeDiffId = null;
        this._activateFallback();
      }
      this.renderTabs();
      return;
    }

    const filePath = key.slice(5);
    const tab = this.tabs.get(filePath);
    if (!tab) return;

    if (tab.dirty) {
      const ok = confirm(`"${tab.title}" has unsaved changes.\nClose anyway? (Cancel keeps it open)`);
      if (!ok) return;
    }

    if (tab.model) {
      try { tab.model.dispose(); } catch (err) {}
    }
    this.tabs.delete(filePath);
    this.tabOrder = this.tabOrder.filter((k) => k !== key);

    if (this.activeFilePath === filePath) {
      this.activeFilePath = null;
      this._activateFallback();
    }
    this.renderTabs();
    this._emitActiveFile();
  }

  _activateFallback() {
    if (this.tabOrder.length === 0) {
      this.activeFilePath = null;
      this.activeDiffId = null;
      this._showEmpty();
      return;
    }
    const key = this.tabOrder[this.tabOrder.length - 1];
    if (key.startsWith('diff:')) this.activateDiff(key.slice(5));
    else this._activateFile(key.slice(5));
  }

  // -------------------------------------------------------------------------
  // Tab bar rendering
  // -------------------------------------------------------------------------
  renderTabs() {
    this.tabsBar.innerHTML = '';
    const activeKey = this.activeKey;

    for (const key of this.tabOrder) {
      if (key.startsWith('file:')) {
        const path = key.slice(5);
        const tab = this.tabs.get(path);
        if (!tab) continue;

        const tabEl = document.createElement('div');
        tabEl.className = `tab ${path === this.activeFilePath ? 'active' : ''} ${tab.dirty ? 'dirty' : ''}`;

        const iconSvg = window.getFileIcon ? window.getFileIcon(tab.title) : '';
        tabEl.innerHTML = `
          <span class="tab-icon">${iconSvg}</span>
          <span class="tab-title" title="${this._escAttr(path)}">${this._escAttr(tab.title)}</span>
          <span class="tab-close" title="Close (Ctrl+W)">&times;</span>
        `;

        tabEl.onclick = () => this._activateFile(path);
        tabEl.querySelector('.tab-close').onclick = (e) => this.closeByKey(key, e);
        this.tabsBar.appendChild(tabEl);
      } else if (key.startsWith('diff:')) {
        const id = key.slice(5);
        const tab = this.diffTabs.get(id);
        if (!tab) continue;

        const tabEl = document.createElement('div');
        tabEl.className = `tab tab-diff ${id === this.activeDiffId ? 'active' : ''}`;
        tabEl.innerHTML = `
          <span class="tab-icon diff-glyph">◈</span>
          <span class="tab-title" title="${this._escAttr(tab.title)}">${this._escAttr(tab.title)}</span>
          <span class="tab-close" title="Close">&times;</span>
        `;
        tabEl.onclick = () => this.activateDiff(id);
        tabEl.querySelector('.tab-close').onclick = (e) => this.closeByKey(key, e);
        this.tabsBar.appendChild(tabEl);
      }
    }
  }

  _escAttr(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;');
  }

  // -------------------------------------------------------------------------
  // Helpers used by AI features
  // -------------------------------------------------------------------------
  async openFileByPath(path) {
    if (!window.electronAPI) return false;
    try {
      const content = await window.electronAPI.readFile(path);
      this.openFile(path, content);
      return true;
    } catch (err) {
      console.error('openFileByPath failed:', err);
      return false;
    }
  }

  async openFileAtLine(path, line) {
    const ok = await this.openFileByPath(path);
    if (!ok || !this.activeEditor) return false;
    const maxLine = this.activeEditor.getModel().getLineCount();
    const target = Math.max(1, Math.min(line || 1, maxLine));
    this.activeEditor.revealLineInCenter(target);
    this.activeEditor.setPosition({ lineNumber: target, column: 1 });
    this.activeEditor.focus();
    return true;
  }

  getSelectedText() {
    if (!this.activeEditor || !this.activeEditor.getModel()) return '';
    const selection = this.activeEditor.getSelection();
    return this.activeEditor.getModel().getValueInRange(selection);
  }

  insertTextAtCursor(text) {
    if (!this.activeEditor || !this.activeEditor.getModel()) return;
    const selection = this.activeEditor.getSelection();
    const op = {
      range: selection,
      text: text,
      forceMoveMarkers: true
    };
    this.activeEditor.executeEdits('cloud-code-ai', [op]);
  }

  replaceSelection(text) {
    this.insertTextAtCursor(text);
  }

  getActiveFileDetails() {
    if (!this.activeFilePath) return null;
    const tab = this.tabs.get(this.activeFilePath);
    if (!tab) return null;
    return {
      path: this.activeFilePath,
      title: tab.title,
      content: this.activeEditor ? this.activeEditor.getValue() : '',
      selection: this.getSelectedText()
    };
  }

  hasUnsavedChanges() {
    for (const tab of this.tabs.values()) {
      if (tab.dirty) return true;
    }
    return false;
  }

  saveAllFiles() {
    const saves = [];
    for (const tab of this.tabs.values()) {
      if (tab.dirty && window.electronAPI) {
        saves.push(window.electronAPI.writeFile(tab.filePath, tab.model.getValue()).then(() => {
          tab.originalContent = tab.model.getValue();
          tab.dirty = false;
        }));
      }
    }
    Promise.all(saves).then(() => this.renderTabs());
  }
}

window.EditorManager = EditorManager;
