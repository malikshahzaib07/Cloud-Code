// File Explorer Tree Component
class FileExplorer {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.rootPath = null;
    this.expandedDirs = new Set();

    // --- VS Code-style selection state -------------------------------------
    // Absolute path of the folder the user last interacted with (root default)
    // and of the last clicked file. Header buttons act on `selectedDir`.
    this.selectedDir = null;
    this.selectedFile = null;

    this.ctxMenu = null;      // live popup element
    this.ctxTarget = null;    // { kind: 'dir' | 'file', path, name }
    this.fileChangeTimer = null;
    this._ctxBound = false;

    // render() re-entrancy guard: a filesystem event storm (git checkout, a
    // bulk agent write, ...) must not interleave tree rebuilds.
    this._rendering = false;
    this._renderQueued = false;

    this.bindWorkspaceChanges();
    this.ensureHeaderActions();
    this.ensureStylesheet();
    this.ensureTreeKeyboard();
  }

  /* ====================================================================== */
  /* Styles + keyboard                                                      */
  /* ====================================================================== */

  /**
   * Load the modernized tree stylesheet. index.html is owned elsewhere, so
   * instead of editing it we append the <link> lazily from this module (the
   * same pattern as ensureHeaderActions appending the Open Folder button).
   * It is appended *after* theme-light.css, and the selectors in
   * explorer.css carry one extra class of specificity, so both win cleanly.
   */
  ensureStylesheet() {
    try {
      if (document.getElementById('explorer-style')) return;
      const link = document.createElement('link');
      link.id = 'explorer-style';
      link.rel = 'stylesheet';
      link.href = 'styles/explorer.css';
      (document.head || document.documentElement).appendChild(link);
    } catch (e) { /* styles are an enhancement */ }
  }

  /**
   * Arrow-key navigation for the tree (VS Code style): Up/Down move the
   * selection, Right expands a folder (or steps into it), Left collapses it
   * (or jumps to its parent), Enter opens/toggles. Focus rides on the
   * container; the active row follows selection, so a re-render keeps the
   * cursor where the user left it.
   */
  ensureTreeKeyboard() {
    if (!this.container || this._kbdBound) return;
    this._kbdBound = true;
    try {
      if (!this.container.hasAttribute('tabindex')) {
        this.container.setAttribute('tabindex', '0');
      }
    } catch (e) {}
    this.container.addEventListener('keydown', (e) => this.onTreeKey(e));
  }

  treeRows() {
    try {
      return Array.prototype.slice
        .call(this.container.querySelectorAll('.tree-node'))
        .filter((n) => n.offsetParent !== null);
    } catch (e) { return []; }
  }

  activateRow(row) {
    if (!row) return;
    if (row.dataset.kind === 'dir') {
      this.selectedDir = row.dataset.path;
      this.selectedFile = null;
    } else {
      this.selectedFile = row.dataset.path;
      this.selectedDir = this.parentOf(row.dataset.path);
    }
    this.markActive(row);
    try { row.scrollIntoView({ block: 'nearest' }); } catch (e) {}
  }

  onTreeKey(e) {
    if (this.ctxMenu) return;
    const key = e.key;
    if (key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'ArrowLeft' &&
        key !== 'ArrowRight' && key !== 'Enter') return;
    const rows = this.treeRows();
    if (!rows.length) return;
    e.preventDefault();
    e.stopPropagation();

    let idx = rows.findIndex((n) => n.classList.contains('active'));

    if (key === 'ArrowDown' || key === 'ArrowUp') {
      if (idx < 0) idx = 0;
      else idx = key === 'ArrowDown' ? Math.min(rows.length - 1, idx + 1)
                                     : Math.max(0, idx - 1);
      this.activateRow(rows[idx]);
      return;
    }
    if (idx < 0) idx = 0;
    const row = rows[idx];
    if (!row) return;

    if (key === 'Enter') { row.click(); return; }

    const childWrap = row.nextElementSibling;
    const isOpen = !!(childWrap && childWrap.classList &&
                      childWrap.classList.contains('expanded'));

    if (key === 'ArrowRight') {
      if (row.dataset.kind === 'dir') {
        if (!isOpen) { row.click(); } // expand
        else {
          const first = childWrap.querySelector('.tree-node');
          if (first && first.offsetParent !== null) this.activateRow(first);
        }
      }
      return;
    }

    // ArrowLeft
    if (row.dataset.kind === 'dir' && isOpen) { row.click(); return; } // collapse
    const list = row.parentNode;
    if (list && list.parentNode && list.parentNode.classList &&
        list.parentNode.classList.contains('tree-children')) {
      const parentRow = list.parentNode.previousElementSibling;
      if (parentRow && parentRow.classList && parentRow.classList.contains('tree-node')) {
        this.activateRow(parentRow);
      }
    }
  }

  /* ====================================================================== */
  /* Header actions                                                         */
  /* ====================================================================== */

  /**
   * VS Code shows an "Open Folder" action in the Explorer title bar next to
   * New File / New Folder / Refresh. The static markup cannot contain it (it
   * is built once per view), so we append it here - idempotently, and always
   * *after* the existing buttons so none of them are displaced.
   */
  ensureHeaderActions() {
    let actions = null;
    try {
      actions = document.querySelector('#explorer-view .sidebar-header .actions');
    } catch (e) { return null; }
    if (!actions) return null;
    if (document.getElementById('explorer-open-folder-btn')) return actions;

    const btn = document.createElement('button');
    btn.className = 'icon-btn explorer-header-btn';
    btn.id = 'explorer-open-folder-btn';
    btn.title = 'Open Folder';
    btn.setAttribute('aria-label', 'Open Folder');
    btn.innerHTML =
      '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">' +
      '<path d="M14.5 3H7.71l-.85-.85A.5.5 0 0 0 6.5 2h-5A1.5 1.5 0 0 0 0 3.5v9A1.5 1.5 0 0 0 1.5 14h13a1.5 1.5 0 0 0 1.5-1.5v-8A1.5 1.5 0 0 0 14.5 3zm-2 4.5H10v1.5h1.5v1.5H10V12H8.5v-1.5H7V9h1.5V7.5H10V9h2.5z"/>' +
      '</svg>';
    btn.onclick = (e) => {
      e.stopPropagation();
      this.openFolder(); // no argument -> native folder picker
    };
    actions.appendChild(btn);
    return actions;
  }

  /* ====================================================================== */
  /* Workspace opening                                                      */
  /* ====================================================================== */

  async openFolder(folderPath) {
    // No path given -> show the native folder picker.
    if (!folderPath && window.electronAPI) {
      try {
        folderPath = await window.electronAPI.openDirectory();
      } catch (e) {
        alert('Could not open the folder picker:\n' + ((e && e.message) || e));
        return;
      }
    }
    if (!folderPath) return; // user cancelled

    this.rootPath = folderPath;
    this.expandedDirs.clear();
    this.expandedDirs.add(folderPath);
    this.selectedDir = folderPath;
    this.selectedFile = null;
    this.closeContextMenu();

    // Make sure the header has the Open Folder action in every layout.
    this.ensureHeaderActions();

    this.applyWorkspaceLabels(folderPath);

    // Re-index files for the command palette / @-mentions / agent.
    try { if (window.palette && window.palette.refreshFiles) window.palette.refreshFiles(); } catch (e) {}

    await this.render();

    // Point the terminal at the new workspace root (reuse the live shell).
    try { if (window.terminal && window.terminal.cd) window.terminal.cd(folderPath); } catch (e) {}
  }

  /** The folder header buttons / actions should act on. Falls back to root. */
  targetDir() {
    return this.selectedDir || this.rootPath || null;
  }

  /**
   * Reflect the workspace folder name in the Explorer header + the title bar.
   * Called by openFolder() and closeFolder() only.
   */
  applyWorkspaceLabels(folderPath) {
    if (folderPath) {
      const name = String(folderPath).split(/[\\/]/).filter(Boolean).pop() || String(folderPath);
      const empty = document.getElementById('empty-state');
      if (empty) empty.style.display = 'none';
      const header = document.querySelector('#explorer-view .sidebar-header > span');
      if (header) header.textContent = name.toUpperCase();
      const title = document.getElementById('active-file-title');
      if (title) title.textContent = name;
    } else {
      const empty = document.getElementById('empty-state');
      if (empty) empty.style.display = '';
      const header = document.querySelector('#explorer-view .sidebar-header > span');
      if (header) header.textContent = 'EXPLORER';
      const title = document.getElementById('active-file-title');
      if (title) title.textContent = 'Cloud Code - AI Code Editor';
    }
  }

  /**
   * "Close Folder" (VS Code parity).
   *
   * IMPORTANT: this detaches the workspace *in the UI only*. Nothing on disk
   * is touched - no deletePath / rm / rename is ever called here - it just
   * forgets the root, stops the watcher and renders the "no folder" state.
   */
  async closeFolder() {
    const name = this.rootPath ? this.baseName(this.rootPath) : 'the current folder';
    const ok = confirm(
      'Close the folder "' + name + '"?\n\n' +
      'The folder stays on disk - only this window stops working on it.'
    );
    if (!ok) return false;

    const hadFolder = !!this.rootPath;

    // Stop watching before dropping the root, so no stale event re-renders.
    try {
      if (hadFolder && window.fileWatcher && typeof window.fileWatcher.stop === 'function') {
        window.fileWatcher.stop();
      }
    } catch (e) { /* watcher is optional */ }

    this.closeContextMenu();

    // Reset the workspace state (UI only).
    this.rootPath = null;
    this.selectedDir = null;
    this.selectedFile = null;
    this.expandedDirs.clear();

    // Reset the header / title and paint the "no folder" state.
    this.applyWorkspaceLabels(null);
    this.ensureHeaderActions();
    await this.render();

    // Re-index so @-mentions / palette stop offering the old folder's files.
    try { if (window.palette && window.palette.refreshFiles) window.palette.refreshFiles(); } catch (e) {}
    return true;
  }

  /* ====================================================================== */
  /* Automatic refresh on external file changes                             */
  /* ====================================================================== */

  /**
   * The app dispatches `workspace:files-changed` whenever the filesystem is
   * mutated from anywhere (main process watcher, agent tools, ...). We just
   * re-render (debounced) - no polling.
   */
  bindWorkspaceChanges() {
    if (typeof window === 'undefined' || this._ctxBound) return;
    this._ctxBound = true;
    window.addEventListener('workspace:files-changed', () => {
      if (this.fileChangeTimer) clearTimeout(this.fileChangeTimer);
      this.fileChangeTimer = setTimeout(() => {
        this.fileChangeTimer = null;
        this.closeContextMenu();
        this.render().catch((e) => console.error('Explorer auto-refresh failed:', e));
      }, 150);
    });
  }

  /* ====================================================================== */
  /* Rendering                                                              */
  /* ====================================================================== */

  /**
   * Re-entrancy-safe render. Concurrent calls (a burst of
   * `workspace:files-changed` events during a git checkout) collapse into a
   * single rebuild plus at most one queued follow-up, so the tree never
   * thrashes or interleaves two async walks of the same container.
   */
  async render() {
    if (this._rendering) { this._renderQueued = true; return this._renderPromise || Promise.resolve(); }
    this._rendering = true;
    this._renderPromise = this._render().finally(() => {
      this._rendering = false;
      this._renderPromise = null;
      if (this._renderQueued) {
        this._renderQueued = false;
        this.render().catch((e) => console.error('Explorer queued re-render failed:', e));
      }
    });
    return this._renderPromise;
  }

  async _render() {
    this.closeContextMenu();

    // NOTE (safety): a closed *editor tab* must never look like a closed
    // *folder*. Nothing in this method - and nothing else in this class -
    // derives `rootPath` from "is a file open"; only openFolder() sets it and
    // only closeFolder() clears it. So when the editor drops its last tab and
    // shows its own empty screen, the tree below is re-rendered unchanged.
    if (!this.rootPath) {
      // Back to the empty IDE: restore the "no folder" screen and labels.
      this.applyWorkspaceLabels(null);

      this.selectedDir = null;
      this.selectedFile = null;

      this.container.innerHTML = `
        <div style="padding: 20px 16px; text-align: center; color: var(--text-secondary);">
          <p style="margin-bottom: 12px;">No folder opened</p>
          <button id="open-folder-cta" style="
            background: var(--accent-color);
            color: white;
            border: none;
            padding: 6px 14px;
            font-size: 12px;
            border-radius: 2px;
            cursor: pointer;
          ">Open Folder</button>
        </div>
      `;
      const cta = document.getElementById('open-folder-cta');
      if (cta) cta.onclick = () => this.openFolder();
      return;
    }

    if (!this.selectedDir || !this.isInsideRoot(this.selectedDir)) {
      this.selectedDir = this.rootPath;
    }
    if (this.selectedFile && !this.isInsideRoot(this.selectedFile)) {
      this.selectedFile = null;
    }

    // Build the new tree BEFORE touching the DOM: if the root read fails we
    // keep the previously rendered tree and only append a note.
    const rootTree = await this.buildTree(this.rootPath);

    if (rootTree.querySelector('.explorer-read-error') && this.container.childNodes.length) {
      // Transient failure at the root level - do not blank the sidebar.
      const stale = this.container.querySelector('.explorer-read-error');
      if (stale) stale.parentNode.removeChild(stale);
      this.container.appendChild(this.readErrorNote(this.rootPath));
      return;
    }

    this.container.innerHTML = '';
    this.container.appendChild(rootTree);
  }

  /** Guard: a stale selection must never survive a folder switch. */
  isInsideRoot(p) {
    if (!p || !this.rootPath) return false;
    const a = String(p).replace(/\\/g, '/').toLowerCase();
    const b = String(this.rootPath).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
    return a === b || a.startsWith(b + '/');
  }

  joinPath(dir, name) {
    return `${String(dir).replace(/[\\/]+$/, '')}/${name}`.replace(/\\/g, '/');
  }

  /** Create the DOM for one entry (used for the real node and for refreshes). */
  createNode(entry, isExpanded) {
    const node = document.createElement('div');
    node.className = 'tree-node';
    if (entry.isDirectory) {
      if (entry.path === this.selectedDir) node.classList.add('active');
    } else if (entry.path === this.selectedFile) {
      node.classList.add('active');
    }

    // The chevron is always a "▶" glyph; expanded state rotates it via the
    // .expanded class (CSS transition), which refreshIcon() toggles below.
    const arrow = document.createElement('span');
    arrow.className = 'node-arrow';
    arrow.textContent = '▶';
    if (!entry.isDirectory) arrow.style.visibility = 'hidden';

    const icon = document.createElement('span');
    icon.className = 'node-icon';
    icon.innerHTML = this.iconFor(entry.name, !!entry.isDirectory, !!isExpanded);

    if (entry.isDirectory && isExpanded) node.classList.add('expanded');

    const label = document.createElement('span');
    label.className = 'node-label';
    label.textContent = entry.name;               // never innerHTML with user data
    label.title = entry.name;

    node.appendChild(arrow);
    node.appendChild(icon);
    node.appendChild(label);

    node.dataset.path = entry.path;
    node.dataset.kind = entry.isDirectory ? 'dir' : 'file';
    node.dataset.name = entry.name;

    // --- context menu ------------------------------------------------------
    node.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const x = (e.clientX !== undefined && e.clientX !== 0) ? e.clientX : 0;
      const y = (e.clientY !== undefined && e.clientY !== 0) ? e.clientY : 0;
      // Right-click selects too (VS Code behaviour).
      if (entry.isDirectory) this.selectedDir = entry.path;
      else this.selectedFile = entry.path;
      this.showContextMenu(entry.isDirectory ? 'dir' : 'file', entry, x, y);
    });

    // Clicking a row should give the tree keyboard focus, so arrow keys work
    // immediately after a mouse interaction.
    node.addEventListener('mousedown', () => {
      try { this.container.focus({ preventScroll: true }); } catch (e) {}
    });

    return node;
  }

  /* ====================================================================== */
  /* Icons                                                                  */
  /* ====================================================================== */

  /**
   * Modern, consistent file/folder glyphs. Semantic `.fi-*` classes carry
   * the colours (see explorer.css) so both themes stay in tune; stroke/fill
   * inherit `currentColor`. 16x16 box, rendered at a uniform 16px by CSS.
   */
  iconFor(name, isDirectory, isOpen) {
    const lower = String(name || '').toLowerCase();

    if (isDirectory) {
      return isOpen
        ? '<svg class="fi fi-folder-open" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M1.5 2A1.5 1.5 0 0 0 0 3.5v9A1.5 1.5 0 0 0 1.5 14h13a1.5 1.5 0 0 0 1.5-1.5v-5A1.5 1.5 0 0 0 14.5 6H8.414l-1.707-1.707A1 1 0 0 0 6 4H1.5z"/></svg>'
        : '<svg class="fi fi-folder" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M1.5 2A1.5 1.5 0 0 0 0 3.5v9A1.5 1.5 0 0 0 1.5 14h13a1.5 1.5 0 0 0 1.5-1.5v-7A1.5 1.5 0 0 0 14.5 4H7.414l-1.707-1.707A1 1 0 0 0 5 2H1.5z"/></svg>';
    }

    if (lower.indexOf('.env') === 0) {
      return '<svg class="fi fi-env" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 1a3 3 0 0 0-3 3v2H4a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1h-1V4a3 3 0 0 0-3-3zm1 8.5v2a1 1 0 0 1-2 0v-2a1 1 0 0 1 2 0zM7 4a1 1 0 0 1 2 0v2H7V4z"/></svg>';
    }
    if (lower.indexOf('.git') === 0) {
      return '<svg class="fi fi-git" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M15.4 7.4L8.6.6a1 1 0 0 0-1.4 0L5.7 2.1l2.1 2.1a1.5 1.5 0 0 1 1.9 1.9l2.1 2.1a1.5 1.5 0 1 1-.7.7L9 6.8v4.4a1.5 1.5 0 1 1-1 0V6.6a1.5 1.5 0 0 1-.8-.8L5.1 7.9a1.5 1.5 0 1 1-.7-.7l2.1-2.1-2.9-2.9-3 3a1 1 0 0 0 0 1.4l6.8 6.8a1 1 0 0 0 1.4 0l6.6-6.6a1 1 0 0 0 0-1.4z"/></svg>';
    }

    const ext = lower.lastIndexOf('.') > 0 ? lower.slice(lower.lastIndexOf('.') + 1) : '';
    switch (ext) {
      case 'json':
        return '<svg class="fi fi-json" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M4.5 2A1.5 1.5 0 0 0 3 3.5V6a1 1 0 0 1-1 1v2a1 1 0 0 1 1 1v2.5A1.5 1.5 0 0 0 4.5 14h1v-1h-1a.5.5 0 0 1-.5-.5V9.667A1.5 1.5 0 0 0 2.5 8 1.5 1.5 0 0 0 4 6.333V3.5a.5.5 0 0 1 .5-.5h1V2h-1zm7 0h-1v1h1a.5.5 0 0 1 .5.5v2.833A1.5 1.5 0 0 0 13.5 8a1.5 1.5 0 0 0-1.5 1.667V12.5a.5.5 0 0 1-.5.5h-1v1h1a1.5 1.5 0 0 0 1.5-1.5V10a1 1 0 0 1 1-1V7a1 1 0 0 1-1-1V3.5A1.5 1.5 0 0 0 11.5 2z"/></svg>';
      case 'md':
      case 'markdown':
        return '<svg class="fi fi-md" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M1 3.5A1.5 1.5 0 0 1 2.5 2h11A1.5 1.5 0 0 1 15 3.5v9a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 12.5v-9zM3 5v6h1.5V7.5l1.5 2 1.5-2V11H9V5H7.5L6 7.2 4.5 5H3zm8 0v3.5h-1.5L11.5 11l2-2.5H12V5h-1z"/></svg>';
      case 'js':
      case 'mjs':
      case 'cjs':
      case 'jsx':
        return '<svg class="fi fi-js" viewBox="0 0 16 16" aria-hidden="true"><rect width="16" height="16" rx="2"/><path fill="#000" d="M5.5 12c-.9 0-1.4-.4-1.7-.9l.9-.6c.2.4.4.6.8.6.4 0 .7-.2.7-.6V6.5h1.2V10.5c0 1-.7 1.5-1.9 1.5zm5.3-.1c-.9 0-1.6-.5-1.9-1.2l.9-.5c.2.4.5.7 1 .7.4 0 .8-.2.8-.5 0-.4-.3-.5-.9-.7l-.5-.2c-.9-.4-1.3-.8-1.3-1.6 0-.9.7-1.5 1.8-1.5.8 0 1.4.3 1.7.8l-.8.5c-.2-.3-.5-.4-.9-.4-.4 0-.7.2-.7.5 0 .3.2.4.8.6l.4.2c1 .4 1.4.9 1.4 1.7 0 1-.8 1.4-1.9 1.4z"/></svg>';
      case 'ts':
      case 'tsx':
        return '<svg class="fi fi-ts" viewBox="0 0 16 16" aria-hidden="true"><rect width="16" height="16" rx="2"/><path fill="#fff" d="M4.2 6.5h3.6v1H6.5v4.5h-1V7.5H4.2v-1zm6.7 5.4c-.9 0-1.6-.5-1.9-1.2l.9-.5c.2.4.5.7 1 .7.4 0 .8-.2.8-.5 0-.4-.3-.5-.9-.7l-.5-.2c-.9-.4-1.3-.8-1.3-1.6 0-.9.7-1.5 1.8-1.5.8 0 1.4.3 1.7.8l-.8.5c-.2-.3-.5-.4-.9-.4-.4 0-.7.2-.7.5 0 .3.2.4.8.6l.4.2c1 .4 1.4.9 1.4 1.7 0 1-.8 1.4-1.9 1.4z"/></svg>';
      default:
        return '<svg class="fi fi-file" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M4 1h5.5L13 4.5V14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1zm5 1v3h3L9 2z"/></svg>';
    }
  }

  async buildTree(dirPath) {
    const listContainer = document.createElement('div');
    listContainer.className = 'tree-list';

    try {
      const entries = await window.electronAPI.readDirectory(dirPath);

      for (const entry of this.sortEntries(entries || [])) {
        // Skip heavy or hidden directories
        if (entry.name === 'node_modules' || entry.name === '.git') {
          continue;
        }

        if (entry.isDirectory) {
          const isExpanded = this.expandedDirs.has(entry.path);
          const node = this.createNode(entry, isExpanded);

          // --- hover quick actions (new file / new folder) ------------------
          const actions = document.createElement('span');
          actions.className = 'tree-hover-actions';
          actions.appendChild(this.hoverButton('New File…', '\u{1F4C4}', (e) => {
            e.stopPropagation();
            this.createNewFileIn(entry.path);
          }));
          actions.appendChild(this.hoverButton('New Folder…', '\u{1F4C1}', (e) => {
            e.stopPropagation();
            this.createNewFolderIn(entry.path);
          }));
          node.appendChild(actions);

          const childContainer = document.createElement('div');
          childContainer.className = `tree-children ${isExpanded ? 'expanded' : ''}`;

          const refreshIcon = () => {
            const expanded = this.expandedDirs.has(entry.path);
            const arrowEl = node.querySelector('.node-arrow');
            if (arrowEl) arrowEl.textContent = '▶'; // rotation comes from .expanded
            node.classList.toggle('expanded', expanded);
            node.querySelector('.node-icon').innerHTML =
              this.iconFor(entry.name, true, expanded);
          };

          node.onclick = async (e) => {
            e.stopPropagation();
            // Left-clicking a folder makes it the active creation target.
            this.selectedDir = entry.path;
            this.selectedFile = null;
            this.markActive(node);

            if (this.expandedDirs.has(entry.path)) {
              this.expandedDirs.delete(entry.path);
              childContainer.classList.remove('expanded');
              childContainer.innerHTML = '';
            } else {
              this.expandedDirs.add(entry.path);
              childContainer.classList.add('expanded');
              const children = await this.buildTree(entry.path);
              childContainer.appendChild(children);
            }
            refreshIcon();
          };

          listContainer.appendChild(node);
          listContainer.appendChild(childContainer);

          if (isExpanded) {
            const children = await this.buildTree(entry.path);
            childContainer.appendChild(children);
          }
        } else {
          const node = this.createNode(entry, false);
          node.onclick = async (e) => {
            e.stopPropagation();
            this.selectedFile = entry.path;
            if (entry.path.split('/').length > 1) this.selectedDir = this.parentOf(entry.path);
            this.markActive(node);
            await this.openFile(entry.path);
          };
          listContainer.appendChild(node);
        }
      }
    } catch (err) {
      // A transient read failure must NOT blank the tree: keep whatever was
      // already rendered and add a small inline note instead.
      console.error('Error listing directory:', dirPath, err);
      listContainer.appendChild(this.readErrorNote(dirPath));
    }

    return listContainer;
  }

  /** Small, non-blocking "could not read folder" row (explorer-* namespace). */
  readErrorNote(dirPath) {
    const note = document.createElement('div');
    note.className = 'explorer-read-error';
    note.setAttribute('role', 'status');
    note.textContent = 'Could not read "' + this.baseName(dirPath) + '" \u2014 click Refresh to retry.';
    return note;
  }

  /**
   * VS Code ordering: folders first, then files, each alphabetical and
   * case-insensitive. Ties (e.g. "A" vs "a") keep a stable, deterministic
   * fallback so two consecutive renders never shuffle the rows.
   */
  sortEntries(entries) {
    return entries.slice().sort((a, b) => {
      const ad = a.isDirectory ? 0 : 1;
      const bd = b.isDirectory ? 0 : 1;
      if (ad !== bd) return ad - bd;               // folders before files
      const an = String(a.name || '').toLowerCase();
      const bn = String(b.name || '').toLowerCase();
      if (an < bn) return -1;
      if (an > bn) return 1;
      const aRaw = String(a.name || '');
      const bRaw = String(b.name || '');
      if (aRaw < bRaw) return -1;                  // deterministic tie-break
      if (aRaw > bRaw) return 1;
      return 0;
    });
  }

  hoverButton(title, glyph, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'icon-btn tree-hover-btn';
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.textContent = glyph;
    btn.onclick = onClick;
    return btn;
  }

  markActive(node) {
    document.querySelectorAll('.tree-node').forEach((n) => n.classList.remove('active'));
    if (node) node.classList.add('active');
  }

  parentOf(p) {
    const s = String(p).replace(/\\/g, '/');
    const i = s.lastIndexOf('/');
    return i > 0 ? s.slice(0, i) : s;
  }

  baseName(p) {
    const parts = String(p).replace(/\\/g, '/').split('/').filter(Boolean);
    return parts.pop() || String(p);
  }

  extOf(name) {
    const i = String(name).lastIndexOf('.');
    return i > 0 ? String(name).slice(i) : '';
  }

  async openFile(path) {
    try {
      const content = await window.electronAPI.readFile(path);
      if (window.editor) window.editor.openFile(path, content);
    } catch (err) {
      console.error('Failed to read file:', err);
      alert('Error opening file: ' + ((err && err.message) || err));
    }
  }

  /* ====================================================================== */
  /* Context menu                                                           */
  /* ====================================================================== */

  /**
   * Menu definition for a target. Kept as pure data so it is easy to reason
   * about (and test): folder menus and file menus differ.
   */
  getMenuItems(kind, entry) {
    const isDir = kind === 'dir';
    const items = isDir
      ? [
          { id: 'newFile', label: 'New File…' },
          { id: 'newFolder', label: 'New Folder…' },
          { sep: true },
          { id: 'rename', label: 'Rename…' },
          { id: 'refresh', label: 'Refresh' },
          { id: 'copyPath', label: 'Copy Path' },
        ]
      : [
          { id: 'open', label: 'Open' },
          { sep: true },
          { id: 'rename', label: 'Rename…' },
          { id: 'duplicate', label: 'Duplicate' },
          { id: 'copyPath', label: 'Copy Path' },
        ];

    if (isDir) {
      // "Reveal in Explorer" only when the bridge actually exposes it - the
      // preload surface can change between builds, so check at runtime.
      if (this.canRevealInFolder()) {
        items.push({ id: 'reveal', label: 'Reveal in Explorer' });
      }
      items.push({ sep: true }, { id: 'delete', label: 'Delete Folder', danger: true });

      // --- workspace-level actions ---------------------------------------
      // Appended (never replacing what is above) to match VS Code: the
      // folder menu ends with Reveal / Open Folder / Close Folder.
      items.push(
        { sep: true },
        { id: 'openFolder', label: 'Open Folder\u2026' },
        { id: 'closeFolder', label: 'Close Folder' }
      );
    } else {
      items.push({ sep: true }, { id: 'delete', label: 'Delete', danger: true });
    }
    return items;
  }

  /** Runtime capability check for "Reveal in Explorer". */
  canRevealInFolder() {
    try {
      return !!(window.electronAPI && typeof window.electronAPI.shellShowItemInFolder === 'function');
    } catch (e) {
      return false;
    }
  }

  /** Runtime capability check for the native folder picker. */
  canOpenFolder() {
    try {
      return !!(window.electronAPI && typeof window.electronAPI.openDirectory === 'function');
    } catch (e) {
      return false;
    }
  }

  showContextMenu(kind, entry, x, y) {
    this.closeContextMenu();
    this.ctxTarget = { kind: kind, path: entry.path, name: entry.name };
    this._lastTarget = this.ctxTarget;

    const menu = document.createElement('div');
    menu.className = 'ctx-menu';
    menu.setAttribute('role', 'menu');

    for (const item of this.getMenuItems(kind, entry)) {
      if (item.sep) {
        const sep = document.createElement('div');
        sep.className = 'ctx-sep';
        menu.appendChild(sep);
        continue;
      }
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'ctx-item' + (item.danger ? ' danger' : '');
      row.setAttribute('role', 'menuitem');
      row.dataset.action = item.id;
      row.textContent = item.label;
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        this.closeContextMenu();
        this.runMenuAction(item.id);
      });
      menu.appendChild(row);
    }

    document.body.appendChild(menu);
    this.ctxMenu = menu;

    // Clamp inside the viewport.
    const rect = menu.getBoundingClientRect ? menu.getBoundingClientRect() : { width: 160, height: 200 };
    const vw = (typeof window !== 'undefined' && window.innerWidth) || 1024;
    const vh = (typeof window !== 'undefined' && window.innerHeight) || 768;
    // Keep the popup fully on-screen: clamp horizontally, and flip *upwards*
    // (anchored to its bottom edge) when it would overflow the viewport.
    const left = Math.max(4, Math.min(x || 0, Math.max(4, vw - rect.width - 4)));
    let top = y || 0;
    if (top + rect.height > vh - 4) {
      top = Math.max(4, vh - rect.height - 4); // flip up / clamp to the bottom
      menu.classList.add('ctx-menu-flip-up');
      menu.style.top = top + 'px';
      menu.style.transformOrigin = 'bottom ' + Math.max(0, (y || 0) - top) + 'px';
    } else {
      top = Math.max(4, top);
      menu.style.top = top + 'px';
    }
    menu.style.left = left + 'px';

    this.bindMenuDismissers();
    this.setActiveItem(-1);
  }

  items() {
    return this.ctxMenu
      ? Array.prototype.slice.call(this.ctxMenu.querySelectorAll('.ctx-item'))
      : [];
  }

  setActiveItem(index) {
    const list = this.items();
    list.forEach((el, i) => el.classList.toggle('selected', i === index));
    if (list[index]) list[index].focus();
  }

  onMenuKey(e) {
    const list = this.items();
    if (!list.length) return;
    let idx = list.findIndex((el) => el.classList.contains('selected'));
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.setActiveItem((idx + 1) % list.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.setActiveItem(idx <= 0 ? list.length - 1 : idx - 1);
    } else if (e.key === 'Enter') {
      if (idx >= 0) {
        e.preventDefault();
        const el = list[idx];
        const action = el.dataset.action;
        this.closeContextMenu();
        this.runMenuAction(action);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.closeContextMenu();
    }
  }

  bindMenuDismissers() {
    if (this._dismissBound) return;
    this._dismissBound = true;
    this._onDocDown = (e) => {
      if (!this.ctxMenu) return;
      if (this.ctxMenu.contains(e.target)) return;
      this.closeContextMenu();
    };
    this._onKey = (e) => {
      if (!this.ctxMenu) return;
      this.onMenuKey(e);
    };
    this._onScroll = () => this.closeContextMenu();
    this._onBlur = () => this.closeContextMenu();
    document.addEventListener('mousedown', this._onDocDown, true);
    document.addEventListener('keydown', this._onKey, true);
    document.addEventListener('scroll', this._onScroll, true);
    window.addEventListener('blur', this._onBlur);
  }

  unbindMenuDismissers() {
    if (!this._dismissBound) return;
    this._dismissBound = false;
    document.removeEventListener('mousedown', this._onDocDown, true);
    document.removeEventListener('keydown', this._onKey, true);
    document.removeEventListener('scroll', this._onScroll, true);
    window.removeEventListener('blur', this._onBlur);
  }

  closeContextMenu() {
    if (this.ctxMenu && this.ctxMenu.parentNode) {
      this.ctxMenu.parentNode.removeChild(this.ctxMenu);
    }
    this.ctxMenu = null;
    this.ctxTarget = null;
    this.unbindMenuDismissers();
  }

  runMenuAction(action) {
    // The menu is closed *before* the action runs, so keep the target around.
    const t = this._lastTarget || this.ctxTarget;
    if (!action || !t) return Promise.resolve();
    switch (action) {
      case 'newFile':   return this.createNewFileIn(t.path);
      case 'newFolder': return this.createNewFolderIn(t.path);
      case 'open':      return this.openFile(t.path);
      case 'rename':    return this.renameEntry(t);
      case 'duplicate': return this.duplicateFile(t);
      case 'copyPath':  return this.copyPath(t.path);
      case 'refresh':   return this.refresh();
      case 'reveal':    return this.revealInFolder(t.path);
      case 'openFolder': return this.openFolder();     // native picker
      case 'closeFolder': return this.closeFolder();   // UI-only detach
      case 'delete':    return t.kind === 'dir' ? this.deleteFolder(t) : this.deleteFile(t);
      default:          return Promise.resolve();
    }
  }

  refresh() {
    return this.render();
  }

  /* ====================================================================== */
  /* Creation (header buttons -> selected folder, else root)               */
  /* ====================================================================== */

  /**
   * Header "New File" - creates inside the selected folder, falling back to
   * the workspace root (VS Code parity). `selectedDir` may be a nested folder
   * because folder rows are click-to-select.
   */
  async createNewFile() {
    const dir = this.targetDir();
    if (!dir) {
      alert('Please open a folder first!');
      return;
    }
    return this.createNewFileIn(dir);
  }

  /** Header "New Folder" - same target resolution as createNewFile(). */
  async createNewFolder() {
    const dir = this.targetDir();
    if (!dir) {
      alert('Please open a folder first!');
      return;
    }
    return this.createNewFolderIn(dir);
  }

  /** Create a file *inside* `dir` (default: the selected folder / root). */
  async createNewFileIn(dir) {
    const base = dir || this.targetDir();
    if (!base) {
      alert('Please open a folder first!');
      return;
    }
    // NOTE: Electron does not implement window.prompt(), so we use our own
    // dialog. It pre-selects the *basename* so typing replaces it (VS Code).
    const name = await this.askName('New file name', '', { okLabel: 'Create' });
    if (!name) return;

    const clean = this.normalizeRelative(name);
    if (!clean) {
      alert('Invalid file name. Use a path inside "' + this.baseName(base) + '", e.g. src/app.js');
      return;
    }

    const filePath = this.joinPath(base, clean);
    try {
      // Nested paths ("src/utils/x.js") need their folders created first.
      const slash = filePath.lastIndexOf('/');
      if (slash > 0) {
        const parent = filePath.slice(0, slash);
        if (parent !== String(base).replace(/\\/g, '/')) {
          await window.electronAPI.createDirectory(parent);
        }
      }
      await window.electronAPI.createFile(filePath);

      // VS Code: the new file becomes the active selection, its folder chain
      // stays expanded (never collapse after a create), and it opens.
      this.selectedFile = filePath;
      this.selectedDir = this.parentOf(filePath) || base;
      this.expandChainTo(filePath);

      await this.render();

      // Open it in the editor AFTER the tree is painted so the selection is
      // visible when the tab appears.
      if (window.editor) window.editor.openFile(filePath, '');
    } catch (err) {
      alert('Error creating file: ' + ((err && err.message) || err));
    }
  }

  /**
   * Expand the workspace root and every folder down to `path` so a freshly
   * created nested entry ("a/b/c.txt") is visible without manual clicking.
   */
  expandChainTo(path) {
    const p = String(path).replace(/\\/g, '/');
    if (!this.rootPath) return;
    let cur = this.parentOf(p);
    const root = String(this.rootPath).replace(/\\/g, '/').replace(/\/$/, '');
    // Walk up to the root, adding each ancestor, then add the root itself.
    while (cur && cur !== root && cur.length > root.length && this.isInsideRoot(cur)) {
      this.expandedDirs.add(cur);
      const up = this.parentOf(cur);
      if (up === cur) break;
      cur = up;
    }
    if (this.isInsideRoot(root)) this.expandedDirs.add(root);
  }

  /** Create a folder *inside* `dir` (default: the selected folder / root). */
  async createNewFolderIn(dir) {
    const base = dir || this.targetDir();
    if (!base) {
      alert('Please open a folder first!');
      return;
    }
    const name = await this.askName('New folder name', '', { okLabel: 'Create' });
    if (!name) return;

    const clean = this.normalizeRelative(name);
    if (!clean) {
      alert('Invalid folder name. Use a path inside "' + this.baseName(base) + '", e.g. src/components');
      return;
    }

    const dirPath = this.joinPath(base, clean);
    try {
      await window.electronAPI.createDirectory(dirPath);

      // VS Code: the new folder stays expanded AND the cursor lands inside it
      // so the user can immediately create the first file. Never collapse.
      this.expandChainTo(dirPath);
      this.expandedDirs.add(dirPath);
      this.selectedDir = dirPath;
      this.selectedFile = null;

      await this.render();
      // The cursor is now *inside* the new folder (selectedDir === dirPath),
      // so the header New File button and the tree hover action both create
      // there - no extra modal, no manual clicking.
    } catch (err) {
      alert('Error creating folder: ' + ((err && err.message) || err));
    }
  }

  

  /* ====================================================================== */
  /* Rename / duplicate / delete / copy                                     */
  /* ====================================================================== */

  async renameEntry(target) {
    if (!target) return;
    const suggested = target.kind === 'dir'
      ? target.name
      : this.extOf(target.name) ? target.name.slice(0, -this.extOf(target.name).length) : target.name;

    const name = await this.askName(
      'Rename ' + (target.kind === 'dir' ? 'folder' : 'file'),
      suggested,
      { okLabel: 'Rename' }
    );
    if (!name) return;

    const clean = this.normalizeRelative(name);
    if (!clean) {
      alert('Invalid name. Enter a plain file/folder name.');
      return;
    }
    if (clean === target.name) return;

    const newPath = this.joinPath(this.parentOf(target.path), clean);
    if (newPath === target.path) return;

    try {
      await window.electronAPI.renamePath(target.path, newPath);
      if (this.selectedFile === target.path) this.selectedFile = newPath;
      if (this.selectedDir === target.path) this.selectedDir = newPath;
      this.expandedDirs.delete(target.path);
      this.expandedDirs.add(newPath);
      await this.render();
    } catch (err) {
      alert('Error renaming: ' + ((err && err.message) || err));
    }
  }

  async duplicateFile(target) {
    if (!target) return;
    const ext = this.extOf(target.name);
    const stem = ext ? target.name.slice(0, -ext.length) : target.name;
    const copyPath = this.joinPath(this.parentOf(target.path), stem + ' copy' + ext);
    try {
      const content = await window.electronAPI.readFile(target.path);
      const slash = copyPath.lastIndexOf('/');
      if (slash > 0) await window.electronAPI.createDirectory(copyPath.slice(0, slash));
      await window.electronAPI.writeFile(copyPath, typeof content === 'string' ? content : String(content));
      await this.render();
      alert('Created ' + this.baseName(copyPath));
    } catch (err) {
      alert('Error duplicating file: ' + ((err && err.message) || err));
    }
  }

  async deleteFolder(target) {
    if (!target) return;
    let count = null;
    try {
      const entries = await window.electronAPI.readDirectory(target.path);
      count = entries.length;
    } catch (err) {
      count = null; // unknown -> assume it might contain something
    }

    let message = 'Delete folder ' + target.name + '? This cannot be undone.';
    if (count !== 0) {
      message = 'Folder ' + target.name + ' is not empty.\nDelete it and everything inside it? This cannot be undone.';
    }
    if (!confirm(message)) return;

    try {
      await window.electronAPI.deletePath(target.path);
      this.expandedDirs.delete(target.path);
      if (this.selectedDir && String(this.selectedDir).startsWith(target.path)) {
        this.selectedDir = this.rootPath;
      }
      await this.render();
    } catch (err) {
      alert('Error deleting folder: ' + ((err && err.message) || err));
    }
  }

  async deleteFile(target) {
    if (!target) return;
    if (!confirm('Delete ' + target.name + '? This cannot be undone.')) return;
    try {
      await window.electronAPI.deletePath(target.path);
      if (this.selectedFile === target.path) this.selectedFile = null;
      await this.render();
    } catch (err) {
      alert('Error deleting file: ' + ((err && err.message) || err));
    }
  }

  copyPath(path) {
    if (!path) return Promise.resolve();
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return Promise.resolve(navigator.clipboard.writeText(path))
          .catch(() => alert('Could not copy path to clipboard.'));
      }
    } catch (e) {}
    alert(path);
    return Promise.resolve();
  }

  revealInFolder(path) {
    try {
      if (window.electronAPI && window.electronAPI.shellShowItemInFolder) {
        return Promise.resolve(window.electronAPI.shellShowItemInFolder(path));
      }
    } catch (e) {}
    alert('Reveal in Explorer is not available.');
    return Promise.resolve();
  }

  /** Normalise a user-entered relative path (no escapes, no absolute paths). */
  normalizeRelative(name) {
    const parts = String(name).trim().replace(/\\/g, '/').split('/');
    const kept = [];
    for (const part of parts) {
      const p = part.trim();
      if (!p || p === '.') continue;
      if (p === '..') return ''; // no escaping the workspace
      kept.push(p);
    }
    return kept.join('/');
  }

  /**
   * VS Code-style single-line input. Electron has no window.prompt(), so the
   * explorer used to silently do nothing when New File / New Folder was clicked.
   */
  askName(title, defaultValue, options) {
    const opts = options || {};
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'cc-dialog-overlay';
      overlay.innerHTML = `
        <div class="cc-dialog" role="dialog" aria-modal="true">
          <div class="cc-dialog-title"></div>
          <input class="cc-dialog-input" type="text" spellcheck="false" />
          <div class="cc-dialog-hint">Sub-folders are created automatically, e.g. src/utils/helpers.js</div>
          <div class="cc-dialog-actions">
            <button class="cc-dialog-btn" type="button" data-act="cancel">Cancel</button>
            <button class="cc-dialog-btn primary" type="button" data-act="ok">Create</button>
          </div>
        </div>`;
      overlay.querySelector('.cc-dialog-title').textContent = title;
      const okBtn = overlay.querySelector('[data-act="ok"]');
      if (okBtn && opts.okLabel) okBtn.textContent = opts.okLabel;

      const input = overlay.querySelector('.cc-dialog-input');
      const initial = defaultValue || '';
      input.value = initial;
      document.body.appendChild(overlay);

      // VS Code behaviour: pre-fill the suggested name but select only the
      // *stem* ("utils.js" -> "utils" selected) so typing replaces the name
      // while the extension survives. With no suggestion, start empty with the
      // caret at position 0. If there is no extension, select the whole stem.
      const dot = initial.lastIndexOf('.');
      const stemEnd = dot > 0 ? dot : initial.length;
      const selectEnd = opts.selectStem === false ? 0 : stemEnd;
      // Recorded for tests / assertions.
      this._lastAskSelection = { start: 0, end: selectEnd, value: initial };
      setTimeout(() => {
        input.focus();
        if (typeof input.setSelectionRange === 'function') {
          // Selection 0..stemEnd, so the caret ends up right after the stem.
          input.setSelectionRange(0, selectEnd);
        } else if (typeof input.select === 'function' && selectEnd > 0) {
          input.select();
        }
      }, 30);

      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        document.removeEventListener('keydown', onKey, true);
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        resolve(value);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault(); e.stopPropagation();
          done(null);
        } else if (e.key === 'Enter') {
          e.preventDefault(); e.stopPropagation();
          done(input.value.trim() || null);
        }
      };
      document.addEventListener('keydown', onKey, true);

      overlay.addEventListener('click', (e) => {
        const act = e.target && e.target.getAttribute ? e.target.getAttribute('data-act') : null;
        if (act === 'ok') return done(input.value.trim() || null);
        if (act === 'cancel' || e.target === overlay) return done(null);
      });
    });
  }
}

window.FileExplorer = FileExplorer;