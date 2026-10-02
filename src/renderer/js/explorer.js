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

    this.bindWorkspaceChanges();
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

    const name = String(folderPath).split(/[\\/]/).filter(Boolean).pop() || String(folderPath);

    // The "no folder open" screen must disappear as soon as a folder is opened.
    const empty = document.getElementById('empty-state');
    if (empty) empty.style.display = 'none';

    // VS Code-style: folder name in the Explorer header and the window title.
    const header = document.querySelector('#explorer-view .sidebar-header > span');
    if (header) header.textContent = name.toUpperCase();
    const title = document.getElementById('active-file-title');
    if (title) title.textContent = name;

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

  async render() {
    this.closeContextMenu();
    if (!this.rootPath) {
      // Back to the empty IDE: restore the "no folder" screen and labels.
      const empty = document.getElementById('empty-state');
      if (empty) empty.style.display = '';
      const header = document.querySelector('#explorer-view .sidebar-header > span');
      if (header) header.textContent = 'EXPLORER';
      const title = document.getElementById('active-file-title');
      if (title) title.textContent = 'Cloud Code - AI Code Editor';

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

    this.container.innerHTML = '';
    const rootTree = await this.buildTree(this.rootPath);
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

    const arrow = document.createElement('span');
    arrow.className = 'node-arrow';
    arrow.textContent = entry.isDirectory ? (isExpanded ? '▼' : '▶') : '▶';
    if (!entry.isDirectory) arrow.style.visibility = 'hidden';

    const icon = document.createElement('span');
    icon.className = 'node-icon';
    icon.innerHTML = window.getFileIcon
      ? window.getFileIcon(entry.name, !!entry.isDirectory, !!isExpanded)
      : '';

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

    return node;
  }

  async buildTree(dirPath) {
    const listContainer = document.createElement('div');
    listContainer.className = 'tree-list';

    try {
      const entries = await window.electronAPI.readDirectory(dirPath);

      for (const entry of entries) {
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
          childContainer.style.paddingLeft = '14px';

          const refreshIcon = () => {
            const expanded = this.expandedDirs.has(entry.path);
            node.querySelector('.node-arrow').textContent = expanded ? '▼' : '▶';
            node.querySelector('.node-icon').innerHTML = window.getFileIcon
              ? window.getFileIcon(entry.name, true, expanded) : '';
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
      console.error('Error listing directory:', err);
    }

    return listContainer;
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
      // "Reveal in Explorer" only when the bridge actually exposes it.
      if (window.electronAPI && window.electronAPI.shellShowItemInFolder) {
        items.push({ sep: true }, { id: 'reveal', label: 'Reveal in Explorer' });
      }
      items.push({ sep: true }, { id: 'delete', label: 'Delete Folder', danger: true });
    } else {
      items.push({ sep: true }, { id: 'delete', label: 'Delete', danger: true });
    }
    return items;
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
    const left = Math.max(4, Math.min(x || 0, vw - rect.width - 4));
    const top = Math.max(4, Math.min(y || 0, vh - rect.height - 4));
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';

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

  async createNewFile() {
    const dir = this.targetDir();
    if (!dir) {
      alert('Please open a folder first!');
      return;
    }
    return this.createNewFileIn(dir);
  }

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
    // NOTE: Electron does not implement window.prompt(), so we use our own dialog.
    const name = await this.askName('New file name', '');
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
      this.selectedDir = base;
      await this.render();
      if (window.editor) window.editor.openFile(filePath, '');
    } catch (err) {
      alert('Error creating file: ' + ((err && err.message) || err));
    }
  }

  /** Create a folder *inside* `dir` (default: the selected folder / root). */
  async createNewFolderIn(dir) {
    const base = dir || this.targetDir();
    if (!base) {
      alert('Please open a folder first!');
      return;
    }
    const name = await this.askName('New folder name', '');
    if (!name) return;

    const clean = this.normalizeRelative(name);
    if (!clean) {
      alert('Invalid folder name. Use a path inside "' + this.baseName(base) + '", e.g. src/components');
      return;
    }

    const dirPath = this.joinPath(base, clean);
    try {
      await window.electronAPI.createDirectory(dirPath);
      this.selectedDir = base;
      await this.render();
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

    const name = await this.askName('Rename ' + (target.kind === 'dir' ? 'folder' : 'file'), suggested);
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
  askName(title, defaultValue) {
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
      const input = overlay.querySelector('.cc-dialog-input');
      input.value = defaultValue || '';
      document.body.appendChild(overlay);
      setTimeout(() => { input.focus(); input.select(); }, 30);

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