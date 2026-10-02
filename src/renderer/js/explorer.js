// File Explorer Tree Component
class FileExplorer {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.rootPath = null;
    this.expandedDirs = new Set();
  }

  async openFolder(folderPath) {
    if (!folderPath && window.electronAPI) {
      folderPath = await window.electronAPI.openDirectory();
    }
    if (!folderPath) return;

    this.rootPath = folderPath;
    this.expandedDirs.clear();
    this.expandedDirs.add(folderPath);
    await this.render();
  }

  async render() {
    if (!this.rootPath) {
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
