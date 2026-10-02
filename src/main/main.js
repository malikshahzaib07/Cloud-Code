const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const { spawn } = require('child_process');
const https = require('https');
const http = require('http');

// Load private configuration safely
let envConfig = {};
try {
  const envPath = path.join(__dirname, '../../.env.local');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    envContent.split('\n').forEach(line => {
      const match = line.match(/^([^=]+)=(.*)$/);
      if (match) envConfig[match[1].trim()] = match[2].trim();
    });
  }
} catch (e) {
  console.warn('Could not read .env.local', e);
}

let aiBaseUrl = envConfig.AI_BASE_URL || process.env.AI_BASE_URL || 'https://levitra-pair-bodies-travel.trycloudflare.com/v1';
let aiApiKey = envConfig.AI_API_KEY || process.env.AI_API_KEY || 'cloudforge-local-gpu';
let aiModel = envConfig.AI_MODEL || 'qwen-2.5-coder-7b';

// ---------------------------------------------------------------------------
// Persistent app settings (userData/settings.json)
// ---------------------------------------------------------------------------
const DEFAULT_SETTINGS = {
  agentMode: 'ask',            // 'ask' | 'edit-auto' | 'full-auto'
  maxSteps: 15,                // agent loop iteration cap
  autocompleteEnabled: true,   // ghost-text inline completions
  autocompleteDelay: 350,      // ms of idle before requesting a completion
  agentAllowOutsideWorkspace: false, // allow the agent to touch files outside the workspace
  agentMaxTokens: 4096,        // token budget per agent turn (long file writes)
  aiBaseUrl: null,             // overrides .env.local when set
  aiApiKey: null,
  aiModel: null
};

let settingsPath = null;
let appSettings = { ...DEFAULT_SETTINGS };

try {
  settingsPath = path.join(app.getPath('userData'), 'settings.json');
  if (fs.existsSync(settingsPath)) {
    Object.assign(appSettings, JSON.parse(fs.readFileSync(settingsPath, 'utf-8')));
  }
} catch (e) {
  console.warn('Could not read settings.json:', e.message);
}

// Persisted AI config wins over .env.local defaults
if (appSettings.aiBaseUrl) aiBaseUrl = appSettings.aiBaseUrl;
if (appSettings.aiApiKey) aiApiKey = appSettings.aiApiKey;
if (appSettings.aiModel) aiModel = appSettings.aiModel;

function persistSettings() {
  if (!settingsPath) return;
  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(appSettings, null, 2), 'utf-8');
  } catch (e) {
    console.warn('Could not write settings.json:', e.message);
  }
}

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'Cloud Code',
    backgroundColor: '#1e1e1e',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#181818',
      symbolColor: '#cccccc',
      height: 35
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// File system handlers
ipcMain.handle('dialog:openDirectory', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory']
  });
  if (canceled || !filePaths || filePaths.length === 0) return null;
  return filePaths[0];
});

// Multi-file picker for the chat "Attach files" button.
// Returns [{ path, name, size }] (bytes); [] when canceled or on error.
ipcMain.handle('dialog:openFiles', async () => {
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections']
    });
    if (canceled || !filePaths || filePaths.length === 0) return [];
    const out = [];
    for (const p of filePaths.slice(0, 25)) {
      try {
        const st = await fsp.stat(p);
        if (!st.isFile()) continue;
        out.push({
          path: p,
          name: String(p).split(/[\\/]/).pop() || p,
          size: st.size
        });
      } catch (e) {
        // skip files we cannot stat
      }
    }
    return out;
  } catch (e) {
    return [];
  }
});

ipcMain.handle('fs:readDirectory', async (event, dirPath) => {
  try {
    const entries = await fsp.readdir(dirPath, { withFileTypes: true });
    // Sort directories first, then files alphabetically
    const sorted = entries.sort((a, b) => {
      if (a.isDirectory() === b.isDirectory()) {
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      }
      return a.isDirectory() ? -1 : 1;
    });

    return sorted.map(entry => ({
      name: entry.name,
      path: path.join(dirPath, entry.name),
      isDirectory: entry.isDirectory(),
      extension: path.extname(entry.name).toLowerCase()
    }));
  } catch (error) {
    console.error('Error reading directory:', error);
    throw error;
  }
});

ipcMain.handle('fs:readFile', async (event, filePath) => {
  return await fsp.readFile(filePath, 'utf-8');
});

ipcMain.handle('fs:writeFile', async (event, filePath, content) => {
  await fsp.writeFile(filePath, content, 'utf-8');
  return true;
});

ipcMain.handle('fs:createFile', async (event, filePath) => {
  await fsp.writeFile(filePath, '', 'utf-8');
  return true;
});

ipcMain.handle('fs:createDirectory', async (event, dirPath) => {
  await fsp.mkdir(dirPath, { recursive: true });
  return true;
});

// ---------------------------------------------------------------------------
// Workspace watching — powers auto-reload of the explorer tree and of files
// that are open in the editor (edited by the agent, git, an external editor…).
// ---------------------------------------------------------------------------
let workspaceWatcher = null;
let watchDebounce = null;

function stopWorkspaceWatch() {
  if (watchDebounce) {
    clearTimeout(watchDebounce);
    watchDebounce = null;
  }
  if (workspaceWatcher) {
    try { workspaceWatcher.close(); } catch (e) { /* already closed */ }
    workspaceWatcher = null;
  }
}

ipcMain.handle('fs:watch', async (event, rootPath) => {
  stopWorkspaceWatch();
  if (!rootPath || !fs.existsSync(rootPath)) return false;
  try {
    workspaceWatcher = fs.watch(rootPath, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      const rel = String(filename).replace(/\\/g, '/');
      // Ignore noisy paths we never render.
      if (rel.startsWith('node_modules/') || rel.includes('/node_modules/') ||
          rel.includes('.git/') || rel.startsWith('.git/') ||
          rel.startsWith('release/') || rel.startsWith('dist/') ||
          rel.endsWith('~') || rel.endsWith('.tmp')) return;

      if (watchDebounce) clearTimeout(watchDebounce);
      watchDebounce = setTimeout(() => {
        watchDebounce = null;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('fs:changed', { type: eventType, path: rel });
        }
      }, 250);
    });
    workspaceWatcher.on('error', (err) => {
      console.warn('workspace watch error:', err.message);
      stopWorkspaceWatch();
    });
    return true;
  } catch (err) {
    // Recursive watching is unsupported on some platforms — degrade silently.
    console.warn('fs:watch unavailable:', err.message);
    workspaceWatcher = null;
    return false;
  }
});

ipcMain.handle('fs:unwatch', async () => {
  stopWorkspaceWatch();
  return true;
});

// "Reveal in Explorer" for the file-tree context menu.
ipcMain.handle('shell:showItemInFolder', async (event, targetPath) => {
  try {
    if (!targetPath || !fs.existsSync(targetPath)) return false;
    shell.showItemInFolder(targetPath);
    return true;
  } catch (err) {
    return false;
  }
});

app.on('before-quit', () => {
  stopWorkspaceWatch();
});

ipcMain.handle('fs:deletePath', async (event, targetPath) => {
  const stat = await fsp.stat(targetPath);
  if (stat.isDirectory()) {
    await fsp.rm(targetPath, { recursive: true, force: true });
  } else {
    await fsp.unlink(targetPath);
  }
  return true;
});

ipcMain.handle('fs:renamePath', async (event, oldPath, newPath) => {
  await fsp.rename(oldPath, newPath);
  return true;
});

// ---------------------------------------------------------------------------
// Terminal — a REAL pseudo-terminal via node-pty (ConPTY on Windows).
// This gives full ANSI colour, PSReadLine, working Ctrl+C/Ctrl+L/arrow keys and
// full-screen programs (vim, htop, git log -p). If node-pty cannot be loaded we
// degrade to a plain piped shell rather than losing the terminal.
// ---------------------------------------------------------------------------
let ptyProcess = null;   // node-pty process
let pipedProc = null;    // fallback child_process

function loadPty() {
  const candidates = [
    'node-pty',
    path.join(app.getAppPath(), 'node_modules', 'node-pty'),
    path.join(__dirname, '../../node_modules', 'node-pty')
  ];
  for (const c of candidates) {
    try {
      return require(c);
    } catch (e) {
      // try the next candidate
    }
  }
  console.warn('node-pty unavailable — falling back to a basic shell.');
  return null;
}

function shellSpec() {
  if (process.platform === 'win32') {
    return { file: 'powershell.exe', args: ['-NoLogo'] };
  }
  return { file: process.env.SHELL || '/bin/bash', args: ['-l'] };
}

function killTerminal() {
  if (ptyProcess) {
    try { ptyProcess.kill(); } catch (e) { /* already gone */ }
    ptyProcess = null;
  }
  if (pipedProc) {
    try { pipedProc.kill(); } catch (e) { /* already gone */ }
    pipedProc = null;
  }
}

const sendTerminal = (channel, payload) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
};

ipcMain.on('terminal:start', (event, cwd, size) => {
  killTerminal();

  const cols = (size && Number(size.cols)) || 80;
  const rows = (size && Number(size.rows)) || 24;
  const targetCwd = cwd && fs.existsSync(cwd) ? cwd : (app.getPath('home') || os.homedir() || process.cwd());

  // 1) Real PTY -------------------------------------------------------
  const pty = loadPty();
  if (pty) {
    try {
      const spec = shellSpec();
      ptyProcess = pty.spawn(spec.file, spec.args, {
        name: 'xterm-256color',
        cols: cols,
        rows: rows,
        cwd: targetCwd,
        env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
      });
      ptyProcess.onData((data) => sendTerminal('terminal:data', data));
      ptyProcess.onExit(({ exitCode, signal }) => {
        ptyProcess = null;
        sendTerminal('terminal:exit', { code: exitCode, signal: signal || null });
      });
      return;
    } catch (err) {
      console.error('PTY spawn failed, falling back to piped shell:', err);
      ptyProcess = null;
    }
  }

  // 2) Fallback: piped child process ----------------------------------
  try {
    const isWin = os.platform() === 'win32';
    pipedProc = spawn(isWin ? 'powershell.exe' : (process.env.SHELL || 'bash'), isWin ? ['-NoLogo'] : [], {
      cwd: targetCwd,
      env: { ...process.env, TERM: 'xterm-256color' },
      shell: false
    });
    pipedProc.stdout.on('data', (data) => sendTerminal('terminal:data', data.toString()));
    pipedProc.stderr.on('data', (data) => sendTerminal('terminal:data', data.toString()));
    pipedProc.on('exit', (code) => {
      pipedProc = null;
      sendTerminal('terminal:exit', { code: code, signal: null });
    });
  } catch (err) {
    console.error('Failed to spawn shell:', err);
    sendTerminal('terminal:data', '\r\n\x1b[31mFailed to start a shell: ' + (err.message || err) + '\x1b[0m\r\n');
  }
});

ipcMain.on('terminal:input', (event, data) => {
  if (ptyProcess) {
    try { ptyProcess.write(data); } catch (e) { /* shell closed */ }
  } else if (pipedProc && pipedProc.stdin && !pipedProc.stdin.destroyed) {
    pipedProc.stdin.write(data);
  }
});

// Tell the PTY when xterm's grid size changes (so full-screen programs redraw).
ipcMain.on('terminal:resize', (event, cols, rows) => {
  const c = Math.max(20, Number(cols) || 80);
  const r = Math.max(5, Number(rows) || 24);
  if (ptyProcess && typeof ptyProcess.resize === 'function') {
    try { ptyProcess.resize(c, r); } catch (e) { /* ignore */ }
  }
});

app.on('before-quit', () => {
  killTerminal();
});

/**
 * Parse the JSON payload of a <<<TOOL>>> block.
 * Self-hosted coder models wrap the JSON in code fences, emit trailing commas or
 * comments, and get truncated by the token limit while writing long files — all
 * of which used to silently drop the tool call. Recover from each case.
 */
function parseToolPayload(raw) {
  if (!raw) return null;
  let text = String(raw).trim();
  text = text.replace(/^```(?:json|jsonc)?\s*/i, '').replace(/```\s*$/, '').trim();
  text = text.replace(/\/\*[\s\S]*?\*\//g, '');           // block comments
  text = text.replace(/(^|[\s{[,])\/\/[^\n]*/g, '$1');    // line comments
  text = text.replace(/,\s*([}\]])/g, '$1');              // trailing commas

  try {
    return JSON.parse(text);
  } catch (e) {
    // fall through to repair
  }

  const start = text.indexOf('{');
  if (start === -1) return null;

  // Keep the longest balanced {...} prefix.
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }

  let core = end === -1 ? text.slice(start) : text.slice(start, end);
  core = core.replace(/,\s*$/, '');

  const opens = (core.match(/[{[]/g) || []).length;
  const closes = (core.match(/[}\]]/g) || []).length;
  const unclosedString = (() => {
    let s = false, e2 = false;
    for (let i = 0; i < core.length; i++) {
      const ch = core[i];
      if (e2) { e2 = false; continue; }
      if (ch === '\\') { e2 = true; continue; }
      if (ch === '"') s = !s;
    }
    return s;
  })();

  const attempts = [];
  if (unclosedString) attempts.push(core + '"');
  const padded = core + (unclosedString ? '"' : '') + '}'.repeat(Math.max(0, opens - closes));
  attempts.push(padded);
  attempts.push('{"name":"write_file","args":' + padded); // payload truncated at top level

  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch (e2) {
      // try the next repair
    }
  }
  return null;
}

// AI Assistant handlers (Direct HTTPS request handling with SSE parsing)
ipcMain.handle('ai:getConfig', () => {
  const maskedKey = aiApiKey && aiApiKey.length > 8 
    ? aiApiKey.slice(0, 4) + '••••••••' + aiApiKey.slice(-4)
    : '••••••••';
  return {
    baseUrl: aiBaseUrl,
    apiKey: maskedKey,
    model: aiModel
  };
});

ipcMain.handle('ai:updateConfig', (event, config) => {
  if (config.baseUrl) aiBaseUrl = config.baseUrl.trim().replace(/\/+$/, '');
  if (config.apiKey && !config.apiKey.includes('••••')) aiApiKey = config.apiKey.trim();
  if (config.model) aiModel = config.model.trim();
  appSettings.aiBaseUrl = aiBaseUrl;
  appSettings.aiApiKey = aiApiKey;
  appSettings.aiModel = aiModel;
  persistSettings();
  return true;
});

ipcMain.handle('settings:get', () => ({ ...DEFAULT_SETTINGS, ...appSettings }));

ipcMain.handle('settings:set', (event, patch) => {
  if (patch && typeof patch === 'object') {
    for (const key of Object.keys(patch)) {
      if (key in DEFAULT_SETTINGS) appSettings[key] = patch[key];
    }
    persistSettings();
  }
  return { ...DEFAULT_SETTINGS, ...appSettings };
});

ipcMain.handle('ai:listModels', async () => {
  try {
    const url = new URL(`${aiBaseUrl}/models`);
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? https : http;

    return new Promise((resolve) => {
      const req = client.request(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${aiApiKey}`
        },
        timeout: 10000
      }, res => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            if (parsed && parsed.data) {
              resolve(parsed.data.map(m => m.id));
            } else {
              resolve(['qwen-2.5-coder-7b', 'deepseek-r1-8b']);
            }
          } catch (e) {
            resolve(['qwen-2.5-coder-7b', 'deepseek-r1-8b']);
          }
        });
      });

      req.on('error', () => {
        resolve(['qwen-2.5-coder-7b', 'deepseek-r1-8b']);
      });

      req.end();
    });
  } catch (e) {
    return ['qwen-2.5-coder-7b', 'deepseek-r1-8b'];
  }
});

let currentAiRequest = null;

ipcMain.on('ai:chatStream', (event, payload) => {
  try {
    if (currentAiRequest) {
      try { currentAiRequest.destroy(); } catch (e) {}
      currentAiRequest = null;
    }

    const modelToUse = payload.model || aiModel || 'qwen-2.5-coder-7b';
    const postBody = JSON.stringify({
      model: modelToUse,
      messages: payload.messages || [],
      stream: true,
      temperature: payload.temperature !== undefined ? payload.temperature : 0.7
    });

    const url = new URL(`${aiBaseUrl}/chat/completions`);
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? https : http;

    const req = client.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${aiApiKey}`,
        'Content-Length': Buffer.byteLength(postBody)
      },
      timeout: 60000
    }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        let errData = '';
        res.on('data', d => errData += d);
        res.on('end', () => {
          event.sender.send('ai:error', `HTTP ${res.statusCode}: ${errData || res.statusMessage}`);
        });
        return;
      }

      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk.toString('utf-8');
        const lines = buffer.split('\n');
        // Keep the last partial line in the buffer
        buffer = lines.pop();

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue;
          if (trimmed === 'data: [DONE]') {
            event.sender.send('ai:end');
            return;
          }
          if (trimmed.startsWith('data: ')) {
            const jsonStr = trimmed.slice(6);
            try {
              const data = JSON.parse(jsonStr);
              const content = data.choices?.[0]?.delta?.content;
              if (content) {
                event.sender.send('ai:chunk', content);
              }
            } catch (err) {
              // Ignore non-json chunk lines
            }
          }
        }
      });

      res.on('end', () => {
        event.sender.send('ai:end');
        currentAiRequest = null;
      });
    });

    req.on('error', (err) => {
      event.sender.send('ai:error', err.message);
      currentAiRequest = null;
    });

    req.write(postBody);
    req.end();
    currentAiRequest = req;
  } catch (err) {
    event.sender.send('ai:error', err.message);
  }
});

ipcMain.on('ai:stopStream', () => {
  if (currentAiRequest) {
    try { currentAiRequest.destroy(); } catch (e) {}
    currentAiRequest = null;
  }
});

// ---------------------------------------------------------------------------
// Workspace walking & codebase search (powers quick-open, search view, agent)
// ---------------------------------------------------------------------------
const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.cache',
  '__pycache__', '.venv', 'venv', 'target', '.idea', '.vscode', 'coverage'
]);

function walkFiles(rootDir, opts = {}) {
  const maxFiles = Math.min(opts.maxFiles || 5000, 50000);
  const results = [];
  const stack = [rootDir];
  while (stack.length && results.length < maxFiles) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const entry of entries) {
      if (results.length >= maxFiles) break;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        stack.push(full);
      } else if (entry.isFile()) {
        results.push(full);
      }
    }
  }
  return results;
}

function globToRegExp(glob) {
  let re = '';
  let i = 0;
  const g = String(glob).trim();
  while (i < g.length) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        re += '.*';
        i += 2;
        if (g[i] === '/') i++;
      } else {
        re += '[^/]*';
        i++;
      }
    } else if (c === '?') {
      re += '[^/]';
      i++;
    } else if ('\\^$.|+()[]{}?'.includes(c)) {
      re += '\\' + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  return new RegExp('^' + re + '$', 'i');
}

ipcMain.handle('fs:listFilesRecursive', async (event, rootPath, maxFiles) => {
  if (!rootPath || !fs.existsSync(rootPath)) return [];
  try {
    const files = walkFiles(rootPath, { maxFiles });
    return files.map(f => ({
      path: f,
      relPath: path.relative(rootPath, f).split(path.sep).join('/'),
      name: path.basename(f)
    }));
  } catch (error) {
    console.error('listFilesRecursive error:', error);
    return [];
  }
});

ipcMain.handle('fs:searchInFiles', async (event, rootPath, query, options = {}) => {
  if (!rootPath || !fs.existsSync(rootPath) || !query) return [];
  const maxResults = Math.min(options.maxResults || 200, 1000);
  const maxPerFile = options.maxPerFile || 20;

  let regexMatcher = null;
  if (options.regex) {
    try {
      regexMatcher = new RegExp(query, options.caseSensitive ? 'g' : 'gi');
    } catch (e) {
      return { error: 'Invalid regular expression: ' + e.message };
    }
  }

  let globRe = null;
  if (options.glob) {
    try { globRe = globToRegExp(options.glob); } catch (e) { globRe = null; }
  }

  const results = [];
  const files = walkFiles(rootPath, { maxFiles: 20000 });
  const needle = options.caseSensitive ? query : query.toLowerCase();

  for (const filePath of files) {
    if (results.length >= maxResults) break;
    const relPath = path.relative(rootPath, filePath).split(path.sep).join('/');
    if (globRe && !globRe.test(relPath)) continue;

    let stat;
    try { stat = fs.statSync(filePath); } catch (e) { continue; }
    if (stat.size === 0 || stat.size > 1048576) continue; // skip empty & >1MB

    let content;
    try { content = fs.readFileSync(filePath, 'utf-8'); } catch (e) { continue; }
    if (content.indexOf('\u0000') !== -1) continue; // binary file

    const lines = content.split('\n');
    let fileHits = 0;
    for (let li = 0; li < lines.length; li++) {
      if (results.length >= maxResults || fileHits >= maxPerFile) break;
      const lineText = lines[li];
      let col = -1;
      if (regexMatcher) {
        regexMatcher.lastIndex = 0;
        const m = regexMatcher.exec(lineText);
        if (m) col = m.index + 1;
      } else {
        const hay = options.caseSensitive ? lineText : lineText.toLowerCase();
        const idx = hay.indexOf(needle);
        if (idx >= 0) col = idx + 1;
      }
      if (col >= 0) {
        results.push({
          path: filePath,
          relPath,
          line: li + 1,
          column: col,
          text: lineText.replace(/\t/g, '  ').trim().slice(0, 300)
        });
        fileHits++;
      }
    }
  }
  return results;
});

ipcMain.handle('fs:readFileRange', async (event, filePath, startLine, endLine) => {
  const content = await fsp.readFile(filePath, 'utf-8');
  const lines = content.split('\n');
  const total = lines.length;
  const start = Math.max(1, startLine || 1);
  const end = Math.min(total, endLine || Math.min(total, start + 199));
  return {
    content: lines.slice(start - 1, end).join('\n'),
    startLine: start,
    endLine: end,
    totalLines: total,
    truncated: end < total
  };
});

// ---------------------------------------------------------------------------
// Shell command execution (agent tool) — approval gate lives in the renderer
// ---------------------------------------------------------------------------
ipcMain.handle('shell:run', async (event, opts = {}) => {
  const command = String(opts.command || '').trim();
  if (!command) return { error: 'Empty command' };

  const cwd = opts.cwd && fs.existsSync(opts.cwd) ? opts.cwd : process.cwd();
  const timeoutMs = Math.min(opts.timeoutMs || 60000, 300000);
  const isWin = process.platform === 'win32';
  const bin = isWin ? 'cmd.exe' : '/bin/bash';
  const args = isWin ? ['/d', '/s', '/c', command] : ['-lc', command];
  const CAP = 51200; // 50KB cap per stream

  return new Promise((resolve) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(bin, args, {
        cwd,
        env: { ...process.env, TERM: 'xterm-256color' },
        windowsHide: true
      });
    } catch (err) {
      resolve({ error: err.message, code: -1, stdout: '', stderr: '', durationMs: 0 });
      return;
    }

    let stdout = '';
    let stderr = '';
    let outFull = false;
    let errFull = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (isWin) {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        } else {
          child.kill('SIGKILL');
        }
      } catch (e) {}
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      if (!outFull) {
        stdout += d.toString('utf-8');
        if (stdout.length >= CAP) { stdout = stdout.slice(0, CAP); outFull = true; }
      }
    });
    child.stderr.on('data', (d) => {
      if (!errFull) {
        stderr += d.toString('utf-8');
        if (stderr.length >= CAP) { stderr = stderr.slice(0, CAP); errFull = true; }
      }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ error: err.message, code: -1, stdout, stderr, timedOut, durationMs: Date.now() - started });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        code: code === null ? (signal ? 124 : -1) : code,
        signal: signal || null,
        timedOut,
        stdout,
        stderr,
        truncated: outFull || errFull,
        durationMs: Date.now() - started
      });
    });
  });
});

// ---------------------------------------------------------------------------
// One-shot (non-streaming) chat completion with tool-calling support.
// Tries native OpenAI `tools`; on HTTP 400 retries without them so the
// renderer's text-protocol (<<<TOOL>>>) fallback can take over.
// ---------------------------------------------------------------------------
const onceRequests = new Map();

function requestChatOnce(id, payload, includeTools) {
  return new Promise((resolve) => {
    try {
      const bodyObj = {
        model: payload.model || aiModel,
        messages: payload.messages || [],
        stream: false,
        temperature: payload.temperature !== undefined ? payload.temperature : 0.7
      };
      if (payload.maxTokens) bodyObj.max_tokens = payload.maxTokens;
      if (includeTools && Array.isArray(payload.tools) && payload.tools.length) {
        bodyObj.tools = payload.tools;
        bodyObj.tool_choice = 'auto';
      }

      const postBody = JSON.stringify(bodyObj);
      const url = new URL(`${aiBaseUrl}/chat/completions`);
      const client = url.protocol === 'https:' ? https : http;

      const req = client.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${aiApiKey}`,
          'Content-Length': Buffer.byteLength(postBody)
        },
        timeout: 180000
      }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          onceRequests.delete(id);
          if (res.statusCode < 200 || res.statusCode >= 300) {
            resolve({
              id,
              error: `HTTP ${res.statusCode}: ${body.slice(0, 600)}`,
              toolsRejected: includeTools && res.statusCode === 400
            });
            return;
          }
          try {
            const parsed = JSON.parse(body);
            const choice = parsed.choices && parsed.choices[0];
            const msg = (choice && choice.message) || {};
            let content = typeof msg.content === 'string' ? msg.content : '';
            const toolCalls = [];
            let usedNativeTools = false;

            if (Array.isArray(msg.tool_calls)) {
              for (const tc of msg.tool_calls) {
                let args = {};
                const raw = tc.function && tc.function.arguments;
                if (typeof raw === 'string') {
                  try { args = JSON.parse(raw); } catch (e) { args = { _raw: raw }; }
                } else if (raw && typeof raw === 'object') {
                  args = raw;
                }
                toolCalls.push({
                  id: tc.id || `call_${toolCalls.length}`,
                  name: (tc.function && tc.function.name) || '',
                  arguments: args
                });
              }
              usedNativeTools = toolCalls.length > 0;
            }

            // Text-protocol fallback: model answered with <<<TOOL>>>{...}<<<END>>>
            if (!toolCalls.length) {
              const m = content.match(/<<<TOOL>>>\s*([\s\S]*?)\s*<<<END>>>/);
              if (m) {
                const j = parseToolPayload(m[1]);
                if (j) {
                  toolCalls.push({
                    id: `fb_${toolCalls.length}`,
                    name: j.name || j.tool || '',
                    arguments: j.args || j.arguments || j.parameters || {}
                  });
                  content = content.replace(m[0], '').trim();
                } else {
                  // Unparseable payload — tell the model instead of going quiet.
                  content = content.replace(m[0], '').trim() +
                    '\n\n⚠ Your tool call could not be parsed as JSON. Reply with ONLY:\n' +
                    '<<<TOOL>>>\n{"name":"tool_name","args":{...}}\n<<<END>>>';
                }
              }
            }

            resolve({
              id,
              content,
              toolCalls,
              usedNativeTools,
              finishReason: (choice && choice.finish_reason) || null
            });
          } catch (e) {
            resolve({ id, error: `Invalid JSON response: ${e.message}` });
          }
        });
      });

      req.on('error', (err) => {
        onceRequests.delete(id);
        resolve({ id, error: err.message, toolsRejected: false });
      });
      req.on('timeout', () => {
        req.destroy(new Error('AI request timed out (180s)'));
      });

      onceRequests.set(id, req);
      req.write(postBody);
      req.end();
    } catch (err) {
      resolve({ id, error: err.message });
    }
  });
}

ipcMain.handle('ai:chatOnce', async (event, payload) => {
  const id = payload.id || `once_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  let result = await requestChatOnce(id, payload, true);

  // Server does not accept the `tools` parameter — retry without it so the
  // renderer-side text protocol (<<<TOOL>>> blocks) keeps the loop working.
  if (result.error && result.toolsRejected) {
    result = await requestChatOnce(id, { ...payload, tools: null }, false);
    if (!result.error) result.toolsRejected = true;
  }
  return result;
});

ipcMain.handle('ai:cancelOnce', async (event, id) => {
  const req = onceRequests.get(id);
  if (req) {
    try { req.destroy(); } catch (e) {}
    onceRequests.delete(id);
  }
  return true;
});
