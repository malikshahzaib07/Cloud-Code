const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // File System
  openDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
  openFiles: () => ipcRenderer.invoke('dialog:openFiles'),
  readDirectory: (dirPath) => ipcRenderer.invoke('fs:readDirectory', dirPath),
  readFile: (filePath) => ipcRenderer.invoke('fs:readFile', filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke('fs:writeFile', filePath, content),
  createFile: (filePath) => ipcRenderer.invoke('fs:createFile', filePath),
  createDirectory: (dirPath) => ipcRenderer.invoke('fs:createDirectory', dirPath),
  watchWorkspace: (rootPath) => ipcRenderer.invoke('fs:watch', rootPath),
  unwatchWorkspace: () => ipcRenderer.invoke('fs:unwatch'),
  shellShowItemInFolder: (targetPath) => ipcRenderer.invoke('shell:showItemInFolder', targetPath),
  onFilesChanged: (callback) => {
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on('fs:changed', listener);
    return () => ipcRenderer.removeListener('fs:changed', listener);
  },
  deletePath: (targetPath) => ipcRenderer.invoke('fs:deletePath', targetPath),
  renamePath: (oldPath, newPath) => ipcRenderer.invoke('fs:renamePath', oldPath, newPath),
  listFilesRecursive: (rootPath, maxFiles) => ipcRenderer.invoke('fs:listFilesRecursive', rootPath, maxFiles),
  searchInFiles: (rootPath, query, options) => ipcRenderer.invoke('fs:searchInFiles', rootPath, query, options),
  readFileRange: (filePath, startLine, endLine) => ipcRenderer.invoke('fs:readFileRange', filePath, startLine, endLine),

  // Shell (agent tool; approval gate handled in renderer)
  runCommand: (opts) => ipcRenderer.invoke('shell:run', opts),

  // Settings (persisted in userData/settings.json)
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSet: (patch) => ipcRenderer.invoke('settings:set', patch),

  // Terminal
  startTerminal: (cwd, size) => ipcRenderer.send('terminal:start', cwd, size),
  sendTerminalInput: (data) => ipcRenderer.send('terminal:input', data),
  resizeTerminal: (cols, rows) => ipcRenderer.send('terminal:resize', cols, rows),
  onTerminalData: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('terminal:data', listener);
    return () => ipcRenderer.removeListener('terminal:data', listener);
  },
  onTerminalExit: (callback) => {
    const listener = (event, info) => callback(info);
    ipcRenderer.on('terminal:exit', listener);
    return () => ipcRenderer.removeListener('terminal:exit', listener);
  },

  // AI Assistant
  getAiConfig: () => ipcRenderer.invoke('ai:getConfig'),
  updateAiConfig: (config) => ipcRenderer.invoke('ai:updateConfig', config),
  listAiModels: () => ipcRenderer.invoke('ai:listModels'),
  startAiChatStream: (payload) => ipcRenderer.send('ai:chatStream', payload),
  stopAiChatStream: () => ipcRenderer.send('ai:stopStream'),
  // One-shot completion with tool-calling (agent loop, autocomplete, inline edit)
  aiChatOnce: (payload) => ipcRenderer.invoke('ai:chatOnce', payload),
  aiCancelOnce: (id) => ipcRenderer.invoke('ai:cancelOnce', id),
  onAiChunk: (callback) => {
    const listener = (event, chunk) => callback(chunk);
    ipcRenderer.on('ai:chunk', listener);
    return () => ipcRenderer.removeListener('ai:chunk', listener);
  },
  onAiEnd: (callback) => {
    const listener = (event) => callback();
    ipcRenderer.on('ai:end', listener);
    return () => ipcRenderer.removeListener('ai:end', listener);
  },
  onAiError: (callback) => {
    const listener = (event, error) => callback(error);
    ipcRenderer.on('ai:error', listener);
    return () => ipcRenderer.removeListener('ai:error', listener);
  }
});
