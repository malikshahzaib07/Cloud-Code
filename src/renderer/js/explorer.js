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
    const name = prompt('Enter new file name:');
    if (!name) return;

    const filePath = `${this.rootPath}/${name}`.replace(/\\/g, '/');
    try {
      await window.electronAPI.createFile(filePath);
      await this.render();
      if (window.editor) {
        window.editor.openFile(filePath, '');
      }
    } catch (err) {
      alert('Error creating file: ' + err.message);
    }
  }

  async createNewFolder() {
    if (!this.rootPath) {
      alert('Please open a folder first!');
      return;
    }
    const name = prompt('Enter new folder name:');
    if (!name) return;

    const dirPath = `${this.rootPath}/${name}`.replace(/\\/g, '/');
    try {
      await window.electronAPI.createDirectory(dirPath);
      await this.render();
    } catch (err) {
      alert('Error creating folder: ' + err.message);
    }
  }
}

window.FileExplorer = FileExplorer;
