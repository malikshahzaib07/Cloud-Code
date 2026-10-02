// File Explorer Tree Component
class FileExplorer {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.rootPath = null;
    this.expandedDirs = new Set();
  }

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

  async render() {
    if (!this.rootPath) {
      // Back to the empty IDE: restore the "no folder" screen and labels.
      const empty = document.getElementById('empty-state');
      if (empty) empty.style.display = '';
      const header = document.querySelector('#explorer-view .sidebar-header > span');
      if (header) header.textContent = 'EXPLORER';
      const title = document.getElementById('active-file-title');
      if (title) title.textContent = 'Cloud Code - AI Code Editor';

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

    this.container.innerHTML = '';
    const rootTree = await this.buildTree(this.rootPath);
    this.container.appendChild(rootTree);
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

        const node = document.createElement('div');
        node.className = 'tree-node';

        if (entry.isDirectory) {
          const isExpanded = this.expandedDirs.has(entry.path);
          const iconSvg = window.getFileIcon ? window.getFileIcon(entry.name, true, isExpanded) : '';

          node.innerHTML = `
            <span class="node-arrow">${isExpanded ? '▼' : '▶'}</span>
            <span class="node-icon">${iconSvg}</span>
            <span class="node-label" title="${entry.name}">${entry.name}</span>
          `;

          const childContainer = document.createElement('div');
          childContainer.className = `tree-children ${isExpanded ? 'expanded' : ''}`;
          childContainer.style.paddingLeft = '14px';

          node.onclick = async (e) => {
            e.stopPropagation();
            if (this.expandedDirs.has(entry.path)) {
              this.expandedDirs.delete(entry.path);
              childContainer.classList.remove('expanded');
              childContainer.innerHTML = '';
              node.querySelector('.node-arrow').textContent = '▶';
              node.querySelector('.node-icon').innerHTML = window.getFileIcon(entry.name, true, false);
            } else {
              this.expandedDirs.add(entry.path);
              childContainer.classList.add('expanded');
              node.querySelector('.node-arrow').textContent = '▼';
              node.querySelector('.node-icon').innerHTML = window.getFileIcon(entry.name, true, true);
              const children = await this.buildTree(entry.path);
              childContainer.appendChild(children);
            }
          };

          listContainer.appendChild(node);
          listContainer.appendChild(childContainer);

          if (isExpanded) {
            const children = await this.buildTree(entry.path);
            childContainer.appendChild(children);
          }
        } else {
          const iconSvg = window.getFileIcon ? window.getFileIcon(entry.name, false) : '';
          node.innerHTML = `
            <span class="node-arrow" style="visibility: hidden;">▶</span>
            <span class="node-icon">${iconSvg}</span>
            <span class="node-label" title="${entry.name}">${entry.name}</span>
          `;

          node.onclick = async (e) => {
            e.stopPropagation();
            document.querySelectorAll('.tree-node').forEach(n => n.classList.remove('active'));
            node.classList.add('active');

            try {
              const content = await window.electronAPI.readFile(entry.path);
              if (window.editor) {
                window.editor.openFile(entry.path, content);
              }
            } catch (err) {
              console.error('Failed to read file:', err);
            }
          };

          listContainer.appendChild(node);
        }
      }
    } catch (err) {
      console.error('Error listing directory:', err);
    }

    return listContainer;
  }

  async createNewFile() {
    if (!this.rootPath) {
      alert('Please open a folder first!');
      return;
    }
    // NOTE: Electron does not implement window.prompt(), so we use our own dialog.
    const name = await this.askName('New file name', '');
    if (!name) return;

    const clean = this.normalizeRelative(name);
    if (!clean) {
      alert('Invalid file name. Use a path inside the workspace, e.g. src/app.js');
      return;
    }

    const filePath = `${this.rootPath}/${clean}`.replace(/\\/g, '/');
    try {
      // Nested paths ("src/utils/x.js") need their folders created first.
      const slash = filePath.lastIndexOf('/');
      if (slash > 0) await window.electronAPI.createDirectory(filePath.slice(0, slash));
      await window.electronAPI.createFile(filePath);
      await this.render();
      if (window.editor) window.editor.openFile(filePath, '');
    } catch (err) {
      alert('Error creating file: ' + ((err && err.message) || err));
    }
  }

  async createNewFolder() {
    if (!this.rootPath) {
      alert('Please open a folder first!');
      return;
    }
    const name = await this.askName('New folder name', '');
    if (!name) return;

    const clean = this.normalizeRelative(name);
    if (!clean) {
      alert('Invalid folder name. Use a path inside the workspace, e.g. src/components');
      return;
    }

    const dirPath = `${this.rootPath}/${clean}`.replace(/\\/g, '/');
    try {
      await window.electronAPI.createDirectory(dirPath);
      await this.render();
    } catch (err) {
      alert('Error creating folder: ' + ((err && err.message) || err));
    }
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
