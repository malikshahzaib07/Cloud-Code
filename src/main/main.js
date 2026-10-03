const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const { spawn } = require('child_process');
const https = require('https');
const http = require('http');

// ---------------------------------------------------------------------------
// AI engine — the single source of truth for the tool-call protocol and the
// backend client. Everything degrades to the built-in implementation if these
// modules are unavailable.
// ---------------------------------------------------------------------------
let EngineProtocol = null;
let EngineClient = null;
try {
  EngineProtocol = require('../ai-engine/core/protocol.js');
  EngineClient = require('../ai-engine/main/client.js');
} catch (e) {
  console.warn('AI engine modules unavailable, using built-in fallbacks:', e.message);
}

let aiClient = null;
function getAiClient() {
  if (!EngineClient) return null;
  if (!aiClient) {
    try {
      aiClient = EngineClient.createAiClient({
        baseUrl: aiBaseUrl,
        apiKey: aiApiKey,
        model: aiModel
      });
    } catch (e) {
      console.warn('AI client init failed:', e.message);
      return null;
    }
  }
  return aiClient;
}

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
  agentAllowOutsideWorkspace: true, // agent may read/write paths outside the workspace (edits still need approval)
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

// ---------------------------------------------------------------------------
// System facts for the agent: real environment variables + machine info.
// Secrets are masked so they are never echoed into a chat transcript.
// ---------------------------------------------------------------------------
const SENSITIVE_ENV = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|SESSION|COOKIE/i;

ipcMain.handle('sys:info', async () => {
  try {
    const env = {};
    const keys = Object.keys(process.env).sort();
    for (const k of keys) {
      const v = process.env[k] == null ? '' : String(process.env[k]);
      env[k] = SENSITIVE_ENV.test(k) ? (v.slice(0, 2) + '***') : v.slice(0, 2000);
    }
    return {
      ok: true,
      env,
      envCount: keys.length,
      system: {
        platform: process.platform,
        arch: process.arch,
        release: process.getSystemVersion ? process.getSystemVersion() : os.release(),
        hostname: os.hostname(),
        homedir: os.homedir(),
        tmpdir: os.tmpdir(),
        cwd: process.cwd(),
        cpus: os.cpus().length,
        totalMemMB: Math.round(os.totalmem() / (1024 * 1024)),
        freeMemMB: Math.round(os.freemem() / (1024 * 1024)),
        node: process.versions.node,
        electron: process.versions.electron || null,
        chrome: process.versions.chrome || null,
        appVersion: (() => { try { return app.getVersion(); } catch (e) { return null; } })()
      }
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---------------------------------------------------------------------------
// Images — preview support (no npm dependency needed: data URLs + base64) and
// an optional OpenAI-compatible image-generation endpoint.
// ---------------------------------------------------------------------------
const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif'
};

ipcMain.handle('fs:readImage', async (event, filePath) => {
  try {
    const ext = path.extname(String(filePath)).toLowerCase();
    const mime = IMAGE_MIME[ext];
    if (!mime) return { error: `Not an image: ${ext || filePath}` };
    const stat = await fsp.stat(filePath);
    if (stat.size > 25 * 1024 * 1024) return { error: 'Image is larger than 25 MB.' };
    const buf = await fsp.readFile(filePath);
    return { mime, size: stat.size, dataUrl: `data:${mime};base64,${buf.toString('base64')}` };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('fs:writeBase64', async (event, filePath, dataUrl) => {
  try {
    const match = /^data:([^;]+);base64,(.*)$/s.exec(String(dataUrl || ''));
    if (!match) return { error: 'Expected a base64 data URL.' };
    const mime = match[1];
    const ext = Object.keys(IMAGE_MIME).find((e) => IMAGE_MIME[e] === mime) || '.png';
    let target = String(filePath);
    if (!path.extname(target)) target += ext;
    const dir = path.dirname(target);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(target, Buffer.from(match[2], 'base64'));
    return { ok: true, path: target };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('ai:generateImage', async (event, opts = {}) => {
  // Prefer the engine client (single implementation, unit tested).
  const client = getAiClient();
  if (client) {
    try {
      const r = await client.generateImage(opts);
      if (r && !r.error) return r;
    } catch (e) {
      console.warn('generateImage via engine failed, using fallback:', e.message);
    }
  }
  const prompt = String(opts.prompt || '').trim();
  if (!prompt) return { error: 'A prompt is required.' };
  try {
    const url = new URL(`${aiBaseUrl}/images/generations`);
    const client = url.protocol === 'https:' ? https : http;
    const postBody = JSON.stringify({
      model: opts.model || 'gpt-image-1',
      prompt,
      n: 1,
      size: opts.size || '1024x1024',
      response_format: 'b64_json'
    });

    return await new Promise((resolve) => {
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
          if (res.statusCode < 200 || res.statusCode >= 300) {
            resolve({
              error: `Image endpoint returned ${res.statusCode}. ` +
                'Your local server may not support image generation.'
            });
            return;
          }
          try {
            const parsed = JSON.parse(body);
            const first = parsed && parsed.data && parsed.data[0];
            if (first && first.b64_json) {
              resolve({ dataUrl: `data:image/png;base64,${first.b64_json}`, revisedPrompt: first.revised_prompt || '' });
            } else if (first && first.url) {
              resolve({ url: first.url });
            } else {
              resolve({ error: 'The response contained no image data.' });
            }
          } catch (err) {
            resolve({ error: `Could not parse the image response: ${err.message}` });
          }
        });
      });
      req.on('error', (err) => resolve({ error: err.message }));
      req.write(postBody);
      req.end();
    });
  } catch (err) {
    return { error: err.message };
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
    // -ExecutionPolicy Bypass: without it the user's machine policy blocks any
    // script execution ("running scripts is disabled on this system").
    return { file: 'powershell.exe', args: ['-NoLogo', '-ExecutionPolicy', 'Bypass'] };
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
  if (aiClient) {
    try {
      aiClient.setConfig({
        baseUrl: aiBaseUrl,
        apiKey: aiApiKey,
        model: aiModel
      });
    } catch (e) { /* client keeps its old config */ }
  }
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

// ---------------------------------------------------------------------------
// Generic JSON store in the app's userData folder. Used by the session manager
// and the agent's long-term memory so both survive restarts and model changes.
// Names are sanitised: letters, digits, dot, dash, underscore only.
// ---------------------------------------------------------------------------
function storePathFor(name) {
  const safe = String(name || 'store')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/^\.+/, '_');
  return path.join(app.getPath('userData'), 'store', `${safe || 'store'}.json`);
}

ipcMain.handle('store:read', async (event, name) => {
  try {
    const p = storePathFor(name);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (err) {
    console.warn('store:read failed:', err.message);
    return null;
  }
});

ipcMain.handle('store:write', async (event, name, data) => {
  try {
    const p = storePathFor(name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.warn('store:write failed:', err.message);
    return false;
  }
});

ipcMain.handle('ai:listModels', async () => {
  // Prefer the engine client (single implementation, unit tested).
  const client = getAiClient();
  if (client) {
    try {
      return await client.listModels();
    } catch (e) {
      console.warn('listModels via engine failed, using fallback:', e.message);
    }
  }
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
let currentAiThinkState = { emit: '', buffering: false, pending: '' };

/**
 * Stateful filter for streamed content. Reasoning models interleave
 * `<think>…</think>` with the answer; because the tags can be split across SSE
 * chunks we buffer the region between an opening and a closing tag.
 * Returns `{ emit, buffering }` — `emit` is the text safe to forward.
 */
function filterStreamedReasoning(state, chunk) {
  const prev = state || { buffering: false, pending: '' };
  let buffering = !!prev.buffering;
  let pending = prev.pending || '';

  const OPEN = /<\s*(think|thinking)\s*>|<\|\s*(begin_of_thought|thinking)\s*\|>/i;
  const CLOSE = /<\s*\/\s*(think|thinking)\s*>|<\|\s*(end_of_thought|\/thinking)\s*\|>/i;
  // Fragments that could still grow into one of the tags above.
  const TAG_CANDIDATES = [
    '<think>', '<think>', '</think>', '</thinking>',
    '<|begin_of_thought|>', '<|end_of_thought|>', '<|thinking|>', '<|/thinking|>'
  ];
  const couldStartTag = (s) => {
    if (!s || s[0] !== '<' || s.indexOf('>') !== -1) return false;
    const lower = s.toLowerCase();
    return TAG_CANDIDATES.some((c) => c.toLowerCase().startsWith(lower));
  };

  let text = pending + String(chunk || '');
  pending = '';
  let out = '';
  let guard = 0;

  // Only treat an opening tag as reasoning when it opens the message or sits on
  // its own line — otherwise ordinary prose like "use <thinking> tags" is eaten.
  const looksLikeReasoningStart = (t, index) => {
    if (index === 0) return true;
    const closeIdx = t.indexOf('>', index);
    const after = closeIdx === -1 ? '' : t[closeIdx + 1];
    return t[index - 1] === '\n' || after === '\n';
  };

  while (guard++ < 40) {
    if (buffering) {
      const m = text.match(CLOSE);
      if (!m) {
        pending = text.slice(-24);
        return { emit: out, buffering: true, pending };
      }
      text = text.slice(m.index + m[0].length);
      buffering = false;
      continue;
    }

    const open = text.match(OPEN);
    if (open && looksLikeReasoningStart(text, open.index)) {
      out += text.slice(0, open.index);
      text = text.slice(open.index + open[0].length);
      buffering = true;
      continue;
    }

    // A tag split across SSE chunks: hold back the possible fragment.
    const tail = text.match(/<[^>]*$/);
    if (tail && couldStartTag(tail[0])) {
      out += text.slice(0, tail.index);
      pending = tail[0];
      break;
    }

    out += text;
    break;
  }

  return { emit: out, buffering, pending };
}

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
              const delta = data.choices && data.choices[0] && data.choices[0].delta;
              const content = delta && delta.content;
              if (content) {
                // Streamed chain-of-thought arrives mixed into content; hold it
                // back and drop it instead of printing raw <think> blocks.
                currentAiThinkState = filterStreamedReasoning(currentAiThinkState, content);
                if (currentAiThinkState.emit) {
                  event.sender.send('ai:chunk', currentAiThinkState.emit);
                }
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
    currentAiThinkState = { emit: '', buffering: false, pending: '' };
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
  // PowerShell (not cmd) so .ps1 scripts, npm/git/python and ordinary shell
  // syntax all work; -ExecutionPolicy Bypass avoids "script execution is
  // disabled by the system policy" errors from the user's machine policy.
  const bin = isWin ? 'powershell.exe' : '/bin/bash';
  const args = isWin
    ? ['-NoLogo', '-ExecutionPolicy', 'Bypass', '-Command', command]
    : ['-lc', command];
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

/**
 * Reasoning models (DeepSeek-R, Qwen thinking variants) often emit their
 * chain-of-thought INSIDE the content field, wrapped in think tags. Left in
 * place it hides the tool block from the text protocol, so the agent looks
 * like it stopped responding. Strip the wrappers and keep the text.
 */
function stripReasoningWrappers(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  // Paired blocks first.
  out = out.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
  out = out.replace(/<\|begin_of_thought\|>[\s\S]*?<\|end_of_thought\|>/gi, '');
  out = out.replace(/<\|thinking\|>[\s\S]*?<\|\/thinking\|>/gi, '');
  // Unterminated opening tag (truncated response): drop the rest.
  out = out.replace(/<think(?:ing)?>[\s\S]*$/i, '');
  out = out.replace(/<\|begin_of_thought\|>[\s\S]*$/i, '');
  return out.replace(/^\s*<\/?think(?:ing)?>\s*/i, '').trim();
}

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
              toolsRejected: includeTools && res.statusCode === 400,
              kind: 'http',
              // 5xx and rate limiting are worth one more try; a 4xx is not.
              retryable: res.statusCode >= 500 || res.statusCode === 429
            });
            return;
          }
          try {
            const parsed = JSON.parse(body);
            const choice = parsed.choices && parsed.choices[0];
            const msg = (choice && choice.message) || {};
            let content = typeof msg.content === 'string' ? msg.content : '';
            // Some local models stream their chain-of-thought in a separate
            // field. Keep it apart from the answer so the renderer can hide it
            // when the user set "Think: Off".
            let reasoning = String(
              msg.reasoning_content || msg.reasoning || msg.thinking || ''
            );
            const toolCalls = [];
            let usedNativeTools = false;

            // Recover the answer when the model wrapped its thinking in content.
            const cleaned = stripReasoningWrappers(content);
            if (cleaned && cleaned !== content) {
              reasoning = (reasoning + (reasoning ? '\n' : '') + content).trim() || reasoning;
              content = cleaned;
            }

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
                // Engine protocol is the single source of truth when available.
                const parse = (EngineProtocol && EngineProtocol.parseToolPayload) || parseToolPayload;
                const j = parse(m[1]);
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
              reasoning,
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
        resolve({ id, error: err.message, toolsRejected: false, kind: 'transport', retryable: true });
      });
      req.on('timeout', () => {
        req.destroy(new Error('AI request timed out (180s)'));
      });

      onceRequests.set(id, req);
      req.write(postBody);
      req.end();
    } catch (err) {
      resolve({ id, error: err.message, kind: 'transport', retryable: true });
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

  // Transient failures (network blip, 5xx, rate limit, timeout) — retry with a
  // short backoff so a transient hiccup does not look like "model is dead".
  const MAX_RETRIES = 2;
  for (let attempt = 0; attempt < MAX_RETRIES && result.error && result.retryable; attempt++) {
    const delay = attempt === 0 ? 400 : 1200;
    await new Promise((r) => setTimeout(r, delay));
    result = await requestChatOnce(id + `_r${attempt}`, payload, true);
    if (result.error && result.toolsRejected) {
      result = await requestChatOnce(id + `_r${attempt}`, { ...payload, tools: null }, false);
    }
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
