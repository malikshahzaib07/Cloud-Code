// Cloud Code Agent — autonomous tool-calling loop with approval gates,
// diff review, and revertible change tracking.
//
// Hybrid protocol: sends native OpenAI `tools` schemas; if the server rejects
// or ignores them, falls back to a strict text protocol:
//   <<<TOOL>>>\n{"name":"...","args":{...}}\n<<<END>>>
// Results come back as native `tool` messages or as <<<RESULT>>> user blocks.

const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List the files and folders inside a workspace directory.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path relative to the workspace root. Use "." for the root.' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text file from the workspace. Optionally read a 1-based line range for large files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the workspace root.' },
          start_line: { type: 'number', description: 'Optional 1-based first line.' },
          end_line: { type: 'number', description: 'Optional 1-based last line (inclusive).' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_tree',
      description: 'Recursively show the structure of a folder (directories and files). Use this FIRST to orient yourself in an unfamiliar codebase instead of calling list_dir over and over.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory to walk, relative to the workspace root. Defaults to "." (whole project).' },
          depth: { type: 'number', description: 'How many levels deep to walk (default 3, max 8).' },
          include_files: { type: 'boolean', description: 'Include file names as well as folders (default true).' },
          glob: { type: 'string', description: 'Only include files matching this pattern, e.g. "*.js".' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'find_files',
      description: 'Find files by NAME anywhere in the workspace (substring, /regex/ or glob). Use when you roughly know what a file is called but not where it lives.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Case-insensitive substring, or /regex/, matched against the file name and path.' },
          glob: { type: 'string', description: 'Glob such as "*.test.js" or "**/config/*.json".' },
          path: { type: 'string', description: 'Restrict the search to this subdirectory.' },
          limit: { type: 'number', description: 'Maximum results (default 100, max 500).' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_code',
      description: 'Search file contents across the workspace (literal or regex text search).',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text or regex to search for.' },
          glob: { type: 'string', description: 'Optional filename filter, e.g. "*.js" or "src/**".' },
          regex: { type: 'boolean', description: 'Treat query as a regular expression (default false).' },
          case_sensitive: { type: 'boolean', description: 'Case-sensitive matching (default false).' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace an exact string in an existing file. old_string must match the file exactly and uniquely unless replace_all is true. Prefer this over write_file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the workspace root.' },
          old_string: { type: 'string', description: 'Exact text to replace (include surrounding context to make it unique).' },
          new_string: { type: 'string', description: 'Replacement text.' },
          replace_all: { type: 'boolean', description: 'Replace every occurrence (default false).' }
        },
        required: ['path', 'old_string', 'new_string']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create a new file or completely overwrite an existing file with the given content.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the workspace root.' },
          content: { type: 'string', description: 'Full new file content.' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete a file from the workspace, or a folder ONLY when it is empty. Never use this to delete a whole directory tree — delete the children one by one instead. Destructive: always routed through the user approval gate.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the workspace root, or an empty folder path.' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'move_file',
      description: 'Rename or move a file/folder. The destination folder is created if it does not exist. Fails if the destination already exists unless overwrite is true.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Existing source path relative to the workspace root.' },
          to: { type: 'string', description: 'New path relative to the workspace root (file name may change).' },
          overwrite: { type: 'boolean', description: 'Allow replacing an existing file at the destination (default false).' }
        },
        required: ['path', 'to']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run a shell command in the workspace root and return its exit code, stdout and stderr.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command line to execute (e.g. "npm test", "dir", "python app.py").' },
          timeout_ms: { type: 'number', description: 'Optional timeout in milliseconds (default 60000, max 600000).' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_files',
      description: 'Read MANY text files in one call. Use this when the user asks you to read all files in a folder (or all files matching a glob) — it returns them concatenated with "=== path ===" separators under a character budget.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File or folder to read (workspace-relative). A folder is read recursively.' },
          glob: { type: 'string', description: 'Only read files matching this glob, e.g. "*.js" or "**/*.test.js".' },
          limit: { type: 'number', description: 'Maximum number of files (default 20, max 200).' },
          max_chars: { type: 'number', description: 'Total character budget for the whole result (default 60000, max 200000).' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_files',
      description: 'Delete MANY files and/or folders in ONE call. Accepts {"paths":["a.js","b.js"]}, a single {"path":"src/old"} (deleted recursively), or {"path":"logs","glob":"*.log"}. Empty folders are removed too. Every deleted file is recorded so "Revert" restores it. Destructive: always routed through the user approval gate.',
      parameters: {
        type: 'object',
        properties: {
          paths: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative file or folder paths to delete.' },
          path: { type: 'string', description: 'A single file/folder path, or the folder to search when "glob" is given.' },
          glob: { type: 'string', description: 'Delete every file matching this glob under "path" (e.g. "*.log").' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'move_files',
      description: 'Move or rename MANY files/folders in ONE call. Accepts {"files":[{"from":"a","to":"b"}]}, {"from":"src/x","to":"backup/x"}, or {"path":"logs/*.log","to":"archive/"} (a folder destination keeps the original file names). Destination folders are created automatically; an existing destination is only replaced when overwrite is true. Tracked for revert.',
      parameters: {
        type: 'object',
        properties: {
          files: { type: 'array', items: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] }, description: 'Explicit from/to pairs.' },
          from: { type: 'string', description: 'Single source path.' },
          to: { type: 'string', description: 'Single destination path (ends with "/" or names a folder to keep base names).' },
          path: { type: 'string', description: 'Glob pattern selecting the sources, e.g. "logs/*.log".' },
          overwrite: { type: 'boolean', description: 'Allow replacing an existing destination (default false).' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_env',
      description: 'Inspect the environment: one variable by {"name":"PATH"}, or a filtered/capped dump with {"all":true} plus a short system summary (platform, cwd, project name/version, detected node/electron versions). Values come from the workspace .env files and the system summary; no new IPC is used.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'A single variable name (case-insensitive).' },
          all: { type: 'boolean', description: 'Dump all discovered variables (capped at 200 entries).' },
          filter: { type: 'string', description: 'Only include variables whose name contains this substring.' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'remember',
      description: 'Store a durable fact for future conversations (user preferences, project conventions, decisions). Use sparingly, only for things that stay true later.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The fact to remember, written as a short standalone sentence.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional category tags, e.g. ["prefs","build"].' }
        },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'recall',
      description: 'Search long-term memory for previously stored facts relevant to the current task.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to look for.' },
          limit: { type: 'number', description: 'Maximum memories to return (default 5, max 20).' }
        },
        required: ['query']
      }
    }
  }
];

const READONLY_TOOLS = new Set([
  'list_dir', 'read_file', 'search_code', 'read_files', 'read_env', 'recall'
]);
const TOOL_ICONS = {
  list_dir: '📁', read_file: '📖', search_code: '🔎',
  edit_file: '✏️', write_file: '📝', run_command: '🖥️',
  delete_file: '🗑️', move_file: '📦',
  list_tree: '🗂', find_files: '🔍',
  read_files: '📚', delete_files: '🧹', move_files: '📦',
  read_env: '🌱', remember: '🧠', recall: '🧠'
};
const TOOL_TITLES = {
  list_dir: 'List directory', read_file: 'Read file', search_code: 'Search code',
  edit_file: 'Edit file', write_file: 'Write file', run_command: 'Run command',
  delete_file: 'Delete file or folder', move_file: 'Move / rename',
  list_tree: 'Show folder tree', find_files: 'Find files by name',
  read_files: 'Read many files', delete_files: 'Delete files', move_files: 'Move / rename files',
  read_env: 'Read environment', remember: 'Remember', recall: 'Recall'
};

/** Characters that only ever appear in decorative ASCII art, never in prose. */
const BOX_CHARS = /[\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2B00-\u2BFF\u2190-\u21FF]/;
/** A line made exclusively of ASCII graphic/punctuation characters. */
const ASCII_ART_LINE = /^[!-/:-@[-`{-~]{3,}$/;
/** Block/bar glyphs used by fake bar charts and sparklines. */
const BAR_GLYPHS = /[\u2581-\u258F\u2591-\u2593\u25A0-\u25FF\u2800-\u28FF\u{1F3B2}\u{1F53C}\u{1F53D}]/u;
/** A line that carries at least one bar glyph and is mostly bars/spaces/labels. */
const BAR_LINE = /^[^\n]*?[%0-9A-Za-z ,.:()\-+#]{0,12}\s*[\u2581-\u258F\u2591-\u2593\u25A0-\u25FF]{2,}[^\n]*$/u;
/** `+-----+-----+` style table borders (real markdown tables use `|`). */
const ASCII_TABLE_BORDER = /^\+[-+|=]*\+$/;
/** Lines made only of bullet glyphs: `●●●●`, `◆`, `▪▪▪▪`. */
const BULLET_RUN = /^[●◆▪▫◻◼■□▶►➤•·*]+$/u;
/** Fenced blocks whose info string renders as broken ASCII art in this panel. */
const GRAPH_FENCE = /^[ \t]*(?:```|~~~)[ \t]*(mermaid|dot|graphviz|plantuml|vega|vega-lite|chart)\b[^\n]*$[\s\S]*?^[ \t]*(?:```|~~~)[ \t]*$/gim;
/** One line, judge function shared by the fence-aware filter. */
function isDecorativeLine(t) {
  if (!t) return false;
  if (ASCII_TABLE_BORDER.test(t)) return true;
  // markdown table rows (and their `|---|---|` separators) are legitimate
  if (t.indexOf('|') !== -1) return false;
  if (BULLET_RUN.test(t)) return true;
  if (BAR_GLYPHS.test(t) && BAR_LINE.test(t)) return true;
  return BOX_CHARS.test(t) || ASCII_ART_LINE.test(t);
}

/**
 * stripAsciiDecoration(text)
 * Removes decorative-only content (graph-language fenced blocks, box drawing,
 * ──────, ======, ~~~~, ▁▂▃ sparklines, ████ 60% bars, +---+ borders, runs of
 * ●/◆ bullets) from model prose, keeping prose, code and real markdown tables
 * (which use `|`). Applied ONLY to agent-authored text — never to tool output
 * or file contents, which may legitimately contain such characters.
 */
function stripAsciiDecoration(text) {
  // The engine owns this filter; keep the local copy as a fallback.
  const eng = (typeof window !== 'undefined' && window.CloudAI && window.CloudAI.protocol) || null;
  if (eng && typeof eng.stripAsciiDecoration === 'function') {
    try {
      return eng.stripAsciiDecoration(text);
    } catch (e) {
      /* fall through to the local implementation */
    }
  }
  if (typeof text !== 'string' || !text) return '';
  // 1. whole graph/diagram blocks — they can never render correctly here
  const withoutGraphs = text.replace(GRAPH_FENCE, '\n[diagram omitted]\n');
  // 2. line-level decoration
  const out = [];
  for (const raw of withoutGraphs.split(/\r?\n/)) {
    const t = raw.trim();
    if (isDecorativeLine(t)) continue;
    out.push(raw.replace(/\s+$/, ''));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * stripLeadingThinking(text)
 * When "Think: Off" is set the model still sometimes narrates its reasoning in
 * the answer itself ("Let me think…", "First, I'll…", "Okay, so…"). Drop those
 * leading paragraphs; never touch the rest.
 */
const THINKING_OPENERS = /^(let me|i(?:'| a)?m |first[,!]?|okay[,!]?|ok[,!]?|hmm|alright|now[,!]?|to (?:do|start|figure|solve)|i need to (?:check|find|look)|the (?:user|request) (?:asks|wants)|so[,!]?|well[,!]?)\b/i;
function stripLeadingThinking(text) {
  if (typeof text !== 'string' || !text.trim()) return typeof text === 'string' ? text : '';
  const lines = text.split(/\r?\n/);
  let i = 0;
  let dropped = 0;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (!t) { i++; if (dropped) dropped++; continue; }
    if (dropped) break;                                  // answer has started
    if (THINKING_OPENERS.test(t)) { i++; dropped = 1; continue; }
    break;
  }
  return dropped ? lines.slice(i).join('\n').replace(/^\s*\n/, '').trim() : text.trim();
}

/** Collapse control characters and clamp a model line to a readable length. */
function condenseText(text, max) {
  const n = max || 140;
  return String(text == null ? '' : text)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, n);
}

/**
 * Parse a line range emitted by a local model: "10-40", "10:", 25,
 * { start: 1, end: 40 }, [1, 40] …  Returns { start, end } or null.
 */
function parseLineRange(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number' && isFinite(v)) return { start: Math.max(1, Math.floor(v)), end: undefined };
  if (Array.isArray(v)) {
    const s = Number(v[0]);
    const e = Number(v[1]);
    return isFinite(s) ? { start: Math.max(1, Math.floor(s)), end: isFinite(e) && e > 0 ? Math.floor(e) : undefined } : null;
  }
  if (typeof v === 'object') {
    const s = Number(v.start || v.from || v.start_line || v.startLine || 1);
    const e = Number(v.end || v.to || v.end_line || v.endLine || 0);
    return isFinite(s) ? { start: Math.max(1, Math.floor(s)), end: isFinite(e) && e > 0 ? Math.floor(e) : undefined } : null;
  }
  if (typeof v === 'string') {
    const m = v.match(/(\d+)\s*(?:[-–:]|to)\s*(\d+)/i);
    if (m) return { start: Math.max(1, parseInt(m[1], 10)), end: parseInt(m[2], 10) };
    const n = parseInt(v.trim(), 10);
    if (isFinite(n)) return { start: Math.max(1, n), end: undefined };
  }
  return null;
}

/**
 * Directories that are never worth showing or searching: dependencies, VCS
 * metadata and build output (so exploring never drowns in generated copies).
 */
const NOISE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'release', 'out', 'coverage',
  '.next', '.nuxt', '.cache', '.venv', 'venv', '__pycache__', 'target',
  '.idea', '.gradle', '.pytest_cache', 'vendor', 'out-tsc'
]);

class AgentController {
  constructor() {
    this.messages = [];          // conversation including system prompt + tool traffic
    this.hasTask = false;        // whether system prompt + prior turns exist
    this.running = false;
    this.cancelRequested = false;
    this.sessionAllow = new Set(); // categories auto-approved for this session
    this.useNativeTools = true;  // flipped off after a tools-rejected response
    this.reqSeq = 0;
    this.step = 0;
    this.changes = new Map();    // abs path -> { path, original, updated, time }
    this.diffSeq = 0;
    this._lastPreview = '';

    // --- Stop machinery -----------------------------------------------------
    // Every timer the agent owns is registered here so a stop can wipe them all
    // at once (no stray debounce firing after the run is gone).
    this._timers = new Set();
    // Resolvers of approvals the user has not answered yet. A stop resolves them
    // as "cancelled" so the chat can never hang on an unanswered approval card.
    this._pendingApprovals = new Set();
    // "Thinking…" placeholder nodes currently in the chat; a stop removes them
    // so no spinner is left spinning.
    this._thinkingNodes = new Set();
    // Guards the "Agent stopped." notice so it can appear exactly once per run,
    // no matter how many stop paths fire (loop tail + run finalizer).
    this._stopNotified = false;
    // Id of the in-flight aiChatOnce request ('agent-<reqSeq>'), or null.
    this._activeReqId = null;

    this.buildUi();
    this.bindUi();
  }

  // ==========================================================================
  // UI — run bar, changes badge/popup
  // ==========================================================================
  buildUi() {
    const chatView = document.getElementById('ai-chat-view');
    if (chatView) {
      const bar = document.createElement('div');
      bar.id = 'agent-run-bar';
      bar.className = 'agent-run-bar hidden';
      bar.innerHTML = `
        <select id="agent-mode-select" class="agent-mode-select" title="Agent autonomy mode">
          <option value="ask">🛡 Ask before changes</option>
          <option value="edit-auto">✏️ Auto-edit · ask commands</option>
          <option value="full-auto">🚀 Fully autonomous</option>
        </select>
        <span id="agent-run-status" class="agent-run-status"></span>
        <button id="agent-new-task-btn" class="agent-mini-btn" title="Start a fresh task (clears agent memory)">New Task</button>
        <button id="agent-stop-btn" class="agent-mini-btn danger hidden" title="Stop the agent">■ Stop</button>
      `;
      const messages = document.getElementById('chat-messages');
      chatView.insertBefore(bar, messages);
    }

    const statusItem = document.getElementById('statusbar-changes');
    if (statusItem) {
      statusItem.addEventListener('click', () => this.toggleChangesPopup());
      const popup = document.createElement('div');
      popup.id = 'changes-popup';
      popup.className = 'changes-popup hidden';
      popup.innerHTML = `
        <div class="changes-head">
          <span>Agent changes</span>
          <button id="changes-revert-all" class="agent-mini-btn">Revert all</button>
        </div>
        <div id="changes-list" class="changes-list"><div class="changes-empty">No pending changes.</div></div>
      `;
      document.body.appendChild(popup);
    }
  }

  bindUi() {
    const modeSelect = document.getElementById('agent-mode-select');
    if (modeSelect) {
      modeSelect.addEventListener('change', () => {
        if (window.AppSettings) window.AppSettings.set('agentMode', modeSelect.value);
        // Let the chat control bar's autonomy dropdown follow this control.
        try {
          window.dispatchEvent(new CustomEvent('agent:mode-changed', {
            detail: { mode: modeSelect.value }
          }));
        } catch (e) { /* CustomEvent unavailable */ }
      });
      document.addEventListener('settings-changed', () => {
        const v = window.AppSettings ? window.AppSettings.get('agentMode') : 'ask';
        if (modeSelect.value !== v) modeSelect.value = v;
      });
      // initial value
      const v = window.AppSettings ? window.AppSettings.get('agentMode') : 'ask';
      modeSelect.value = v;
    }

    const stopBtn = document.getElementById('agent-stop-btn');
    if (stopBtn) stopBtn.addEventListener('click', () => this.requestStop());

    const newTaskBtn = document.getElementById('agent-new-task-btn');
    if (newTaskBtn) newTaskBtn.addEventListener('click', () => this.newTask());

    const revertAll = document.getElementById('changes-revert-all');
    if (revertAll) {
      revertAll.addEventListener('click', async () => {
        const paths = Array.from(this.changes.keys());
        for (const p of paths) {
          try { await this.revertChange(p); } catch (e) { console.error(e); }
        }
        this.renderChangesList();
      });
    }

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      this.hideChangesPopup();
      // Escape is also the universal "stop" while a task runs — but only when no
      // popup owns it, otherwise it would steal Escape from dropdowns/dialogs.
      if (!this.running || this.cancelRequested) return;
      const POPUPS = '.dd-menu:not([hidden]), .ctx-menu, .cc-dialog-overlay, .sess-overlay, .mem-overlay';
      let popup = null;
      try { popup = document.querySelector(POPUPS); } catch (err) { popup = null; }
      if (popup) return;
      e.preventDefault();
      this.requestStop();
    });
  }

  /**
   * Register a timer the agent owns so a stop can clear it. Returns the id.
   */
  setTimer(fn, ms) {
    const id = setTimeout(() => {
      this._timers.delete(id);
      fn();
    }, ms);
    this._timers.add(id);
    return id;
  }

  /** Clear every timer the agent still owns (debounces, approval timeouts…). */
  clearTimers() {
    for (const id of this._timers) clearTimeout(id);
    this._timers.clear();
  }

  /** Drop every "Thinking…" placeholder so no spinner outlives the run. */
  clearThinkingNodes() {
    for (const node of Array.from(this._thinkingNodes)) this.removeNode(node);
    this._thinkingNodes.clear();
  }

  setVisible(visible) {
    const bar = document.getElementById('agent-run-bar');
    if (bar) bar.classList.toggle('hidden', !visible);
  }

  setStatus(text) {
    const el = document.getElementById('agent-run-status');
    if (el) el.textContent = text || '';
  }

  /** Flag the run bar as "unwinding" so the UI reads as stopping, not idle. */
  setStopping(stopping) {
    const bar = document.getElementById('agent-run-bar');
    if (bar) bar.setAttribute('data-stopping', stopping ? '1' : '0');
  }

  setRunning(running) {
    this.running = running;
    const stopBtn = document.getElementById('agent-stop-btn');
    if (stopBtn) {
      stopBtn.classList.toggle('hidden', !running);
      // A fresh run always starts with an armed stop button.
      if (running) stopBtn.disabled = false;
    }
    const statusItem = document.getElementById('statusbar-agent-steps');
    if (statusItem) statusItem.classList.toggle('hidden', !running);
    if (running) {
      this.setStopping(false);
    } else {
      this.setStopping(false);
      this.setStatus('');
    }
  }

  updateStepBadge() {
    const el = document.getElementById('statusbar-agent-steps');
    if (el) el.innerHTML = `<span>Agent: step ${this.step}</span>`;
  }

  // ==========================================================================
  // Entry point — called by AIAssistant when Chat/Agent mode is "agent"
  // ==========================================================================
  async handleUserPrompt(displayText, fullText, preview) {
    if (this.running) {
      this.pushNotice('The agent is already working — press **Stop** first, or start a New Task.');
      return;
    }

    const root = window.explorer ? window.explorer.rootPath : null;
    if (!root) {
      this.pushNotice('⚠ No folder open. Press **Ctrl+O** to open a workspace before using the Agent.');
      return;
    }

    const ai = window.ai;
    const userContent = fullText || displayText;
    this.setRunning(true);
    this.cancelRequested = false;
    this.step = 0;
    this.sessionAllow = new Set();
    this._stopNotified = false;
    this._activeReqId = null;
    // Per-run counters for the AgentFeatures summary card.
    this._runActive = true;
    this._runStart = Date.now();
    this._runTools = 0;
    this._runCommands = 0;
    this._runFiles = new Set();
    this._runStopped = false;
    this._runError = false;
    if (ai) ai.setSendButtonState(true);

    if (ai) ai.appendUserMessage(displayText, preview || '');

    if (!this.hasTask) {
      this.messages = [{ role: 'system', content: this.buildSystemPrompt(root) }];
      this.hasTask = true;
    }
    this.messages.push({ role: 'user', content: userContent });

    this.showWelcomeOnce();
    this.setStatus('Thinking…');
    this.updateStepBadge();

    try {
      await this.loop();
    } catch (err) {
      console.error('Agent loop crashed:', err);
      this._runError = true;
      this.pushAssistant('⚠ Agent error: ' + (err && err.message ? err.message : String(err)));
    } finally {
      this.setRunning(false);
      this._activeReqId = null;
      // Nothing may outlive the run: timers, placeholders and unanswered
      // approvals are all released here.
      this.clearTimers();
      this.clearThinkingNodes();
      this.releaseApprovals();
      if (ai) ai.setSendButtonState(false);
      this._runActive = false;
      // Run summary for AgentFeatures (window.agent.lastRunSummary + event).
      try {
        const summary = {
          durationMs: Date.now() - (this._runStart || Date.now()),
          tools: this._runTools || 0,
          filesChanged: this._runFiles ? this._runFiles.size : 0,
          commands: this._runCommands || 0,
          ok: !(this._runStopped || this._runError)
        };
        this.lastRunSummary = summary;
        if (window.agent) window.agent.lastRunSummary = summary;
        window.dispatchEvent(new CustomEvent('agent:run-finished', { detail: summary }));
      } catch (e) { /* CustomEvent unavailable */ }
    }
  }

  /**
   * Stop the run now.
   *
   * Cancel sequence (exact order):
   *   1. bail out when nothing is running, or when a stop is already in flight
   *      (repeated clicks / send-button presses are then no-ops);
   *   2. `cancelRequested = true` — every await point in the loop re-checks it;
   *   3. arm the UI: stop button disabled, status "Stopping…";
   *   4. destroy the in-flight HTTP request via aiCancelOnce so the renderer
   *      does not sit waiting for a model response that is already unwanted;
   *   5. resolve every pending approval as "cancelled";
   *   6. clear all timers and remove the "Thinking…" placeholders.
   *
   * The loop tail emits the single "⏹ Agent stopped." notice and the final
   * `agent:thinking` `done` event that lets the chat panel clean itself up.
   */
  requestStop() {
    if (!this.running) return;              // no run in progress → no-op
    if (this.cancelRequested) return;      // stop already requested → no-op

    this.cancelRequested = true;

    // (3) instant UI feedback — the button must never look clickable again.
    const stopBtn = document.getElementById('agent-stop-btn');
    if (stopBtn) stopBtn.disabled = true;
    this.setStopping(true);
    this.setStatus('Stopping…');

    // (4) abort the in-flight request. The main process keys requests by the
    // 'agent-<reqSeq>' id we sent; the bare reqSeq is tried too (defensively,
    // some bridges key on the raw number). Both may be missing/throw.
    const reqId = this._activeReqId || ('agent-' + this.reqSeq);
    const api = window.electronAPI;
    if (api && typeof api.aiCancelOnce === 'function') {
      try { api.aiCancelOnce(reqId); } catch (e) { /* bridge unavailable */ }
      try { if (reqId !== String(this.reqSeq)) api.aiCancelOnce(this.reqSeq); } catch (e) { /* ignore */ }
    }

    // (5) an approval card the user never answered must not keep the run alive.
    this.releaseApprovals();

    // (6) no stray debounce, no spinning placeholder after the stop.
    this.clearTimers();
    this.clearThinkingNodes();
  }

  /**
   * Resolve every outstanding approval request as "cancelled". The promise
   * settles with `false` (do not execute) and the card is marked cancelled.
   */
  releaseApprovals() {
    const pending = Array.from(this._pendingApprovals);
    this._pendingApprovals.clear();
    for (const resolver of pending) {
      try { resolver(false, false, true); } catch (e) { /* card already gone */ }
    }
  }

  onSendClicked() {
    if (this.running) this.requestStop();
  }

  reset(silent) {
    if (this.running) this.requestStop();
    this.messages = [];
    this.hasTask = false;
    this.sessionAllow = new Set();
    this.useNativeTools = true;
    this.setStatus('');
    if (!silent) this.pushNotice('🆕 Started a new task — agent memory cleared.');
  }

  newTask() {
    this.reset(false);
  }

  // ==========================================================================
  // System prompt & message formatting
  // ==========================================================================
  buildSystemPrompt(root) {
    const today = new Date().toISOString().slice(0, 10);
    const thinkLevel = window.AppSettings ? window.AppSettings.get('thinkLevel') : 'medium';
    const off = thinkLevel === 'off';
    this.thinkOff = off;
    let thinkLine;
    if (off) {
      thinkLine = [
        '## THINKING IS OFF — MANDATORY',
        'Answer with the RESULT ONLY. Absolutely no reasoning narration: do not write "Let me think",',
        '"First I\'ll", "Okay, so", do not restate the question, do not describe your plan before acting,',
        'do not explain what you are about to do. Go straight to the answer or straight to the tool call.'
      ].join('\n');
    } else {
      switch (thinkLevel) {
        case 'low': thinkLine = 'Reasoning effort: LOW — act directly and efficiently, avoid unnecessary exploration.'; break;
        case 'high': thinkLine = 'Reasoning effort: HIGH — plan carefully, verify your work with tools before answering, and consider edge cases.'; break;
        default: thinkLine = 'Reasoning effort: MEDIUM — brief deliberation, then act.';
      }
    }
    const allowOutside = !!(window.AppSettings && window.AppSettings.get('agentAllowOutsideWorkspace'));
    const outsideNote = allowOutside
      ? 'Absolute paths outside the workspace are accepted (they still need approval to change).'
      : 'Access is limited to this workspace: absolute paths and "../" escapes are rejected.';
    const memoryBlock = this.memoryPromptBlock();
    const prompt = `You are Cloud Code Agent, an expert software engineer working inside the user's IDE on the user's own machine.

## ENVIRONMENT
- Workspace root: ${root}  ·  Today's date: ${today}
- Platform: Windows. run_command runs PowerShell in the workspace root.
- ${outsideNote}
- Paths are RELATIVE to the workspace root, e.g. "src/main.js"; use "." for the root.

## YOUR JOB
Deliver the ENTIRE requested feature, end to end, in this single turn — working code saved to disk and verified with tools. You learn about this project only through your tools; never assume what a file contains.

## TOOLS (exact names and argument names)
1. list_tree {"path":"."} — folder structure; optional {"depth":4}, {"glob":"*.js"}, {"include_files":false}. Start here.
2. find_files {"pattern":"user"} — find by NAME; optional {"glob":"*.test.js"}, {"path":"src"}, {"limit":200}.
3. list_dir {"path":"<dir>"} — one folder's entries.
4. read_file {"path":"<file>"} — one file whole; optional {"start_line":10,"end_line":60}.
5. read_files {"path":"<dir>","glob":"*.js","limit":20,"max_chars":60000} — MANY files at once; use when asked to read everything in a folder.
6. search_code {"query":"<text>"} — search contents; optional {"glob":"*.js"}, {"regex":true}, {"path":"src"}.
7. edit_file {"path":"<file>","old_string":"<exact existing text>","new_string":"<replacement>","replace_all":false}
8. write_file {"path":"<file>","content":"<the complete file content>"}
9. delete_file {"path":"<file or empty folder>"} — one file, or a folder ONLY when empty.
10. delete_files {"paths":["a.js","b.js"]} | {"path":"src/old"} | {"path":"logs","glob":"*.log"} — MANY at once, revertible.
11. move_file {"path":"<from>","to":"<to>","overwrite":false} — one rename/move.
12. move_files {"files":[{"from":"a","to":"b"}]} | {"path":"logs/*.log","to":"archive/"} — MANY at once, revertible.
13. run_command {"command":"<powershell command>","timeout_ms":60000} — runs in the workspace root.
14. read_env {"name":"PATH"} | {"all":true} — environment variables + system summary.
15. remember {"text":"<durable fact>","tags":["prefs"]} / 16. recall {"query":"...","limit":5} — long-term memory.

## FINDING YOUR WAY AROUND
- Never guess that a file does not exist: find_files by NAME, then search_code by CONTENT, then list_tree.
- One list_tree call beats a chain of list_dir calls — use it first in an unfamiliar project.
- read_file tells you the exact next call when a file is too long; follow that instruction instead of guessing.
- For "read all files in X", call read_files once instead of many read_file calls.

## COMPLETENESS RULES (violating these is a failure)
- Implement the WHOLE request in one turn. No placeholders, no "// ...rest", no TODO, no stubbed bodies.
- If the request implies N files, change all N. Do not stop after the first one.
- Read a SIBLING file of the same kind first and imitate it: import style, module system, naming, error handling, logging, formatting.
- Everything you write must run as-is. Reuse existing utilities; never add a dependency unless asked.

## WORKFLOW
1. ORIENT — list_tree (or find_files), then read the target plus at least one sibling.
2. PLAN — decide the full set of changes.
3. ACT — write_file / edit_file, one tool call per turn.
4. VERIFY — read the result back and run the project's build/test/lint via run_command (check package.json). Fix and re-verify.
5. REPORT — stop calling tools and summarise.

## EDITING SAFELY
- write_file must contain the FULL content; missing folders are created automatically. Never create files with run_command redirection.
- old_string must match EXACTLY (whitespace + indentation) and be unique — include 2-3 surrounding lines, or set replace_all.
- delete_file refuses non-empty folders; use delete_files for a whole tree.
- PowerShell: Get-ChildItem, Select-String, npm test, git status, git diff. You already start in the workspace root — never cd first.
- Never run destructive commands (del /s, Remove-Item -Recurse, git reset --hard, git clean) unless explicitly asked.

## OUTPUT STYLE (strict — the user hates decorative output)
- NO ASCII art, NO bars, NO graphs, NO diagrams, NO box-drawing characters, NO sparklines, NO separator or "graph" lines of any kind ("---", "===", "~~~", "────", "+---+", "████ 60%", "▁▂▃▄▅", "●●●●").
- Never emit mermaid / dot / graphviz / plantuml / vega diagram blocks — describe the structure in prose or a short markdown list instead.
- Never echo, paste, quote or narrate the tool transcript: no tool names, no arguments, no JSON, no raw file dumps, no "[tool]" lines. Refer to work in prose ("I updated the parser in agent.js").
- Wrap code in fenced blocks ONLY when you are actually showing code.
- Be concise: what changed, where, and how it was verified.

## RULES
- Every mutating action is approved by the user. A rejection is final: do not repeat it — adapt or ask.
- Read tool results, including errors; never repeat a failing call unchanged.
- Never claim something works unless a tool verified it.
- Do not create README/notes/summary files unless asked.
${memoryBlock}
${thinkLine}

## WHEN THE TASK IS DONE
Reply with a short prose summary: which files changed and why, plus any commands you ran.

If native function calling is unavailable, output ONLY this block, then wait for the result:
<<<TOOL>>>
{"name":"tool_name","args":{"path":"src/main.js"}}
<<<END>>>

Respond in the user's language, but keep code, paths and identifiers exactly as written.`;
    return prompt;
  }

  /**
   * Long-term memory block provided by another module (window.agentMemory).
   * Returns '' when the module is absent or has nothing worth injecting, so the
   * prompt is never padded with an empty heading.
   */
  memoryPromptBlock() {
    try {
      const mem = window.agentMemory;
      if (!mem || typeof mem.getPromptBlock !== 'function') return '';
      const block = String(mem.getPromptBlock() || '').trim();
      return block ? '\n' + block + '\n' : '';
    } catch (e) {
      return '';
    }
  }

  formatAssistantTurn(res, content, toolCalls) {
    if (res && res.usedNativeTools) {
      const msg = { role: 'assistant', content: content || null };
      msg.tool_calls = toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments || {}) }
      }));
      return msg;
    }
    const blocks = toolCalls.map((tc) =>
      '<<<TOOL>>>\n' + JSON.stringify({ name: tc.name, args: tc.arguments || {} }) + '\n<<<END>>>'
    ).join('\n');
    return { role: 'assistant', content: (content ? content + '\n\n' : '') + blocks };
  }

  formatToolResult(res, tc, text) {
    if (res && res.usedNativeTools) {
      return { role: 'tool', tool_call_id: tc.id, content: text };
    }
    return { role: 'user', content: `<<<RESULT tool="${tc.name}">>>\n${text}\n<<<END>>>` };
  }

  // ==========================================================================
  // The loop
  // ==========================================================================
  async loop() {
    const maxSteps = window.AppSettings ? (+window.AppSettings.get('maxSteps') || 15) : 15;
    this._maxSteps = maxSteps;
    // "Think: Off" is a hard switch: deterministic output, zero narration.
    const thinkLevel = window.AppSettings ? window.AppSettings.get('thinkLevel') : 'medium';
    this.thinkOff = thinkLevel === 'off';
    const temperature = this.thinkOff ? 0 : 0.2;
    const model = document.getElementById('model-select')
      ? document.getElementById('model-select').value : undefined;
    let finalSummary = '';

    while (!this.cancelRequested) {
      this.step += 1;
      this.updateStepBadge();
      if (this.step > maxSteps) {
        this.pushNotice(`⏹ Reached the maximum of **${maxSteps} steps** (configurable in Settings → Agent).`);
        break;
      }
      this.setStatus(`Thinking… (step ${this.step}/${maxSteps})`);
      this.emitThinking('planning', `Planning next step (${this.step}/${maxSteps})`, this.step);

      const thinking = this.thinkOff ? null : this.pushThinking();
      let res = null;
      // The id we register with the main process, so requestStop() can abort
      // exactly this HTTP request instead of waiting for the model to finish.
      const reqId = 'agent-' + (this.reqSeq + 1);
      this._activeReqId = reqId;
      try {
        res = await window.electronAPI.aiChatOnce({
          id: reqId,
          model,
          messages: this.messages,
          tools: this.useNativeTools ? AGENT_TOOLS : undefined,
          temperature,
          maxTokens: this.maxTokens()
        });
      } catch (err) {
        res = { error: err && err.message ? err.message : String(err) };
      } finally {
        this.reqSeq += 1;
        if (this._activeReqId === reqId) this._activeReqId = null;
        this.removeNode(thinking);
      }

      // A response that lands after the stop is discarded wholesale: no tool is
      // executed, nothing is pushed into the transcript, and the loop exits now
      // instead of starting another step.
      if (this.cancelRequested) break;
      if (!res) break;
      if (res.error) {
        if (this.cancelRequested) break;
        this.pushAssistant(`⚠ **Agent request failed:** ${res.error}`);
        break;
      }
      if (res.toolsRejected && this.useNativeTools) {
        this.useNativeTools = false;
        this.pushNotice('ℹ The model endpoint does not support native tool calling — switched to the built-in text tool protocol.');
      }
      // The main process may return a separate `reasoning` field. It is a
      // private thinking channel: it is never sent to the UI and never enters
      // the transcript.
      if (res.reasoning) delete res.reasoning;

      let content = (res.content || '').trim();
      const toolCalls = res.toolCalls || [];

      // If the model used native tool calls AND left a text-protocol block
      // behind, strip the block so it never pollutes the transcript.
      if (toolCalls.length && res.usedNativeTools && content.includes('<<<TOOL>>>')) {
        content = content.replace(/<<<TOOL>>>[\s\S]*?<<<END>>>/g, '').trim();
      }
      // With thinking off the model still narrates inside `content` — drop it.
      if (this.thinkOff && content) content = stripLeadingThinking(content);

      if (toolCalls.length === 0) {
        const clean = stripAsciiDecoration(content);
        finalSummary = clean;
        this.messages.push({ role: 'assistant', content: clean || '(no response)' });
        this.pushAssistant(clean || '(The agent produced no final response.)');
        this.emitThinking('done', (clean || 'Finished').split('\n')[0], this.step);
        break;
      }

      if (content) {
        this.emitThinking('thinking', condenseText(content, 400), this.step);
      }

      this.messages.push(this.formatAssistantTurn(res, content, toolCalls));

      for (const tc of toolCalls) {
        if (this.cancelRequested) {
          this.messages.push(this.formatToolResult(res, tc, 'Cancelled by the user.'));
          continue;
        }
        const resultText = await this.executeToolCall(tc);
        this.messages.push(this.formatToolResult(res, tc, resultText));
      }
    }

    // Exactly one "stopped" notice per run, regardless of which path broke the
    // loop (abort, cancelled approval, max steps reached mid-flight).
    if (this.cancelRequested && !this._stopNotified) {
      this._stopNotified = true;
      this.pushNotice('⏹ Agent stopped.');
    }
    this._runStopped = !!this.cancelRequested;
    if (!finalSummary) {
      // Final `done` event: this is the documented contract that lets the chat
      // thinking panel close/clear itself after a stop. It must be emitted
      // AFTER the stop notice so the panel is already up when it arrives.
      this.emitThinking('done', this.cancelRequested ? 'Stopped by the user' : 'Finished', this.step);
    }
    this.cancelRequested = false;
  }

  /**
   * Realtime progress signal for the chat panel.
   * Event: window 'agent:thinking'
   * detail: { text: string (<=140 chars, plain text), phase: 'planning'|'thinking'|'tool'|'done', step: number }
   * Never throws, even if dispatchEvent / CustomEvent are unavailable.
   */
  emitThinking(phase, text, step) {
    try {
      if (this.thinkOff) return; // "Think: Off" emits no thinking events at all
      if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
      const clean = condenseText(text, 140);
      const evt = typeof CustomEvent === 'function'
        ? new CustomEvent('agent:thinking', { detail: { text: clean, phase, step: step || 0 } })
        : null;
      if (!evt) return;
      window.dispatchEvent(evt);
    } catch (e) { /* never let a UI signal break the loop */ }
  }

  // ==========================================================================
  // Single tool call: prepare → (permission) → execute
  // ==========================================================================
  async executeToolCall(tc) {
    // Live progress events for AgentFeatures (plan checklist / summary card).
    try { window.dispatchEvent(new CustomEvent('agent:tool-start', { detail: { name: tc && tc.name } })); } catch (e) { /* no CustomEvent */ }
    let ok = true;
    try {
      const out = await this._executeToolCallImpl(tc);
      ok = !/^(Error|Cancelled|The user rejected)/.test(String(out == null ? '' : out));
      // Per-run counters rendered by AgentFeatures' summary card.
      if (this._runActive) {
        this._runTools += 1;
        const nm = (tc && tc.name) || '';
        const a = (tc && tc.arguments) || {};
        if (nm === 'run_command') this._runCommands += 1;
        if ((nm === 'edit_file' || nm === 'write_file' || nm === 'delete_file' || nm === 'move_file') && a.path) this._runFiles.add(a.path);
        if (nm === 'delete_files') {
          if (Array.isArray(a.paths)) a.paths.forEach((p) => this._runFiles.add(p));
          else if (a.path) this._runFiles.add(a.path);
        }
        if (nm === 'move_files') {
          if (Array.isArray(a.files)) a.files.forEach((f) => { if (f && f.from) this._runFiles.add(f.from); });
          else if (a.from) this._runFiles.add(a.from);
          else if (a.path) this._runFiles.add(a.path);
        }
      }
      return out;
    } catch (err) {
      ok = false;
      throw err;
    } finally {
      try { window.dispatchEvent(new CustomEvent('agent:tool-end', { detail: { name: tc && tc.name, ok } })); } catch (e) { /* no CustomEvent */ }
    }
  }

  async _executeToolCallImpl(tc) {
    const name = tc.name;
    const args = this.normalizeArgs(name, tc.arguments || {});
    const card = this.renderToolCard(name, args);
    const title = TOOL_TITLES[name] || name;

    if (!AGENT_TOOLS.some((t) => t.function.name === name)) {
      card.setState('error', 'Unknown tool: ' + name);
      return `Error: unknown tool "${name}". Available: ${AGENT_TOOLS.map((t) => t.function.name).join(', ')}`;
    }

    try {
      const plan = await this.prepareTool(name, args);
      this.emitThinking('tool', `${title}: ${condenseText(this.planTarget(plan, args), 100)}`, this.step);

      if (plan.kind === 'read') {
        card.setState('running');
        const out = await plan.run();
        card.setState('done', out, true); // raw tool output — never filtered
        this.emitThinking('tool', `${title} finished`, this.step);
        return this.trunc(out, 6000);
      }

      // Mutating actions go through the autonomy gate
      card.setState('awaiting');
      this.emitThinking('tool', `Waiting for approval: ${title} ${condenseText(this.planTarget(plan, args), 80)}`, this.step);
      const approved = await this.requestPermission(card, plan);
      if (!approved) {
        if (this.cancelRequested) {
          // Resolved by a stop, not by the user: the card already shows
          // "cancelled", so don't overwrite it with "rejected".
          card.setState('cancelled');
          return 'Cancelled by the user.';
        }
        card.setState('rejected');
        this.emitThinking('tool', `${title} rejected by the user`, this.step);
        return 'The user rejected this action. Do not repeat it — adapt your approach or ask the user what they would prefer.';
      }

      // A stop may land between the approval and the write. File writes are
      // NOT interrupted once started: writeFile is a single atomic IPC to the
      // main process, so the file is always written in full or not at all —
      // never truncated. We only skip writes that have not begun yet, which is
      // what the cancelRequested check below does.
      if (this.cancelRequested) {
        card.setState('cancelled');
        return 'Cancelled by the user — nothing was applied.';
      }

      if (plan.kind === 'edit') {
        card.setState('running');
        await this.applyEdit(plan);
        card.setState('done', plan.summary);
        this.emitThinking('tool', `${title} applied: ${condenseText(plan.summary, 100)}`, this.step);
        return `Applied and saved: ${plan.path}\n${plan.summary}\nThe file on disk has been updated.`;
      }

      if (plan.kind === 'delete') {
        card.setState('running');
        const summary = await this.applyDelete(plan);
        card.setState('deleted', summary);
        this.emitThinking('tool', `${title}: ${condenseText(summary, 100)}`, this.step);
        return summary;
      }

      if (plan.kind === 'move') {
        card.setState('running');
        const summary = await this.applyMove(plan);
        card.setState('moved', summary);
        this.emitThinking('tool', `${title}: ${condenseText(summary, 100)}`, this.step);
        return summary;
      }

      if (plan.kind === 'command') {
        card.setState('running');
        const r = await window.electronAPI.runCommand({
          command: plan.command,
          cwd: window.explorer.rootPath,
          timeoutMs: plan.timeoutMs
        });
        const out = this.formatCommandOutput(plan.command, r);
        card.setState(r && r.code === 0 ? 'done' : 'error', out, true);
        return this.trunc(out, 8000);
      }

      card.setState('error', 'Internal: unknown plan kind');
      return 'Error: internal tool planning failure.';
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      card.setState('error', msg);
      return 'Error: ' + msg;
    }
  }

  // --- Planning (validation + computed results, no side effects) -----------
  async prepareTool(name, args) {
    switch (name) {
      case 'list_dir': {
        const dir = this.resolvePath(args.path || '.');
        return {
          kind: 'read',
          run: async () => {
            const entries = await window.electronAPI.readDirectory(dir);
            if (!entries.length) return '(empty directory)';
            const lines = entries.slice(0, 500).map((e) => (e.isDirectory ? e.name + '/' : e.name));
            const note = entries.length > 500 ? `\n[... ${entries.length - 500} more entries]` : '';
            return lines.join('\n') + note;
          }
        };
      }
      case 'read_file': {
        const file = this.resolvePath(args.path);
        return {
          kind: 'read',
          run: async () => {
            let out;
            if (args.start_line || args.end_line) {
              const r = await window.electronAPI.readFileRange(file, args.start_line || 1, args.end_line);
              const flag = r.truncated ? ` [lines ${r.startLine}-${r.endLine} of ${r.totalLines} — more content below]` : ` [lines ${r.startLine}-${r.endLine} of ${r.totalLines}]`;
              out = r.content + flag;
            } else {
              const full = await window.electronAPI.readFile(file);
              if (full.length > 120000) {
                const head = full.slice(0, 120000);
                const linesRead = head.split('\n').length;
                const totalLines = full.split('\n').length;
                // The hint goes FIRST as well as last: long results are clipped
                // before they reach the model, and a clipped-away footer is
                // exactly what used to leave it unable to continue reading.
                out = `[large file: ${full.length} chars, ${totalLines} lines total. Showing the first ${linesRead} line(s). ` +
                  `Continue with read_file {"path":"${args.path}","start_line":${linesRead + 1}}]\n\n` +
                  head +
                  `\n\n[end of the shown portion — ${linesRead} of ${totalLines} lines read]`;
              } else {
                out = full;
              }
            }
            return out;
          }
        };
      }
      case 'list_tree': {
        const dir = this.resolvePath(args.path || '.');
        const maxDepth = Math.min(8, Math.max(1, parseInt(args.depth, 10) || 3));
        const includeFiles = args.include_files === undefined ? true : !!args.include_files;
        const globStr = String(args.glob || args.filter || '').trim();
        const globRe = globStr ? this.globToRegExp(globStr) : null;
        const IGNORE = NOISE_DIRS;
        return {
          kind: 'read',
          run: async () => {
            const lines = [];
            let count = 0;
            const LIMIT = 3000;
            const walk = async (current, prefix, depth) => {
              if (depth > maxDepth || count >= LIMIT) return;
              let entries;
              try {
                entries = await window.electronAPI.readDirectory(current);
              } catch (e) {
                lines.push(prefix + '  [unreadable]');
                return;
              }
              entries.sort((a, b) => {
                if (a.isDirectory === b.isDirectory) return a.name.localeCompare(b.name);
                return a.isDirectory ? -1 : 1;
              });
              for (const e of entries) {
                if (count >= LIMIT) return;
                if (e.isDirectory) {
                  if (IGNORE.has(e.name)) continue;
                  lines.push(prefix + e.name + '/');
                  count++;
                  await walk(current + '/' + e.name, prefix + e.name + '/', depth + 1);
                } else if (includeFiles) {
                  if (globRe && !globRe.test(e.name)) continue;
                  lines.push(prefix + e.name);
                  count++;
                }
              }
            };
            await walk(dir, '', 1);
            if (!lines.length) return '(no matching files or folders)';
            const more = count >= LIMIT
              ? `\n[...stopped after ${LIMIT} entries — narrow "path" or set "glob"]`
              : '';
            return lines.join('\n') + more;
          }
        };
      }
      case 'find_files': {
        const sub = args.path ? this.resolvePath(args.path) : this.resolvePath('.');
        const pattern = String(args.pattern || args.name || args.query || args.text || '').trim();
        const globStr = String(args.glob || '').trim();
        const limit = Math.min(500, Math.max(1, parseInt(args.limit, 10) || 100));
        const globRe = globStr ? this.globToRegExp(globStr) : null;
        let nameRe = null;
        if (pattern) {
          const m = pattern.match(/^\/(.*)\/([gimsuy]*)$/);
          const body = m ? m[1] : pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          try {
            nameRe = new RegExp(body, m ? (m[2] || 'i') : 'i');
          } catch (e) {
            nameRe = null;
          }
        }
        return {
          kind: 'read',
          run: async () => {
            const files = (await window.electronAPI.listFilesRecursive(sub, 20000)) || [];
            const hits = files.filter((f) => {
              // Skip build output / vendored noise the same way list_tree does.
              const rel = String(f.relPath || '');
              if (rel.split('/').some((seg) => NOISE_DIRS.has(seg))) return false;
              if (nameRe && !nameRe.test(f.name) && !nameRe.test(f.relPath)) return false;
              if (globRe && !globRe.test(f.relPath) && !globRe.test(f.name)) return false;
              return true;
            });
            if (!hits.length) {
              return `No files matched${pattern ? ` "${pattern}"` : ''}${globStr ? ` glob "${globStr}"` : ''} under ${sub}.`;
            }
            const shown = hits.slice(0, limit);
            const more = hits.length > limit
              ? `\n[${hits.length - limit} more matches — raise "limit" or narrow the pattern]`
              : '';
            return `${hits.length} match(es):\n` + shown.map((f) => f.relPath).join('\n') + more;
          }
        };
      }
      case 'search_code': {
        const query = String(args.query || '');
        if (!query) throw new Error('search_code requires a query.');
        // Optional scope: search inside a subfolder instead of the whole project.
        const scope = args.path ? this.resolvePath(args.path) : (window.explorer.rootPath || null);
        return {
          kind: 'read',
          run: async () => {
            const res = await window.electronAPI.searchInFiles(scope, query, {
              glob: args.glob || undefined,
              regex: !!args.regex,
              caseSensitive: !!args.case_sensitive,
              maxResults: 120,
              maxPerFile: 12
            });
            if (res && res.error) throw new Error(res.error);
            if (!res || !res.length) return `No matches for "${query}"${args.glob ? ' in ' + args.glob : ''}${scope ? ' under ' + scope : ''}.`;
            const lines = res.map((r) => `${r.relPath}:${r.line}: ${r.text}`);
            const more = res.length >= 120 ? '\n[results capped at 120 — narrow with "glob" or "path"]' : '';
            return lines.join('\n') + more;
          }
        };
      }
      case 'edit_file': {
        const file = this.resolvePath(args.path);
        const original = await window.electronAPI.readFile(file).catch(() => null);
        if (original === null) throw new Error(`File not found: ${args.path}`);
        const oldS = String(args.old_string ?? '');
        const newS = String(args.new_string ?? '');
        if (oldS === '') throw new Error('old_string must not be empty.');
        if (oldS === newS) throw new Error('old_string and new_string are identical — nothing to change.');

        const occurrences = original.split(oldS).length - 1;
        if (occurrences === 0) {
          throw new Error(`old_string was not found in ${args.path}. Copy it EXACTLY from the file (whitespace and indentation matter), or read the file again.`);
        }
        if (occurrences > 1 && !args.replace_all) {
          throw new Error(`old_string matches ${occurrences} times in ${args.path}. Include more surrounding context to make it unique, or set replace_all=true.`);
        }

        const updated = args.replace_all
          ? original.split(oldS).join(newS)
          : original.replace(oldS, newS);
        if (updated === original) throw new Error('The edit produced no change.');

        return {
          kind: 'edit',
          path: file,
          original,
          updated,
          summary: this.diffSummary(original, updated) + ` (edit_file${args.replace_all ? ', replace_all' : ''})`
        };
      }
      case 'write_file': {
        const file = this.resolvePath(args.path);
        const content = String(args.content ?? '');
        const original = await window.electronAPI.readFile(file).catch(() => null);
        if (original !== null && original === content) {
          throw new Error(`${args.path} already contains exactly this content — nothing to do.`);
        }
        return {
          kind: 'edit',
          path: file,
          original: original === null ? '' : original,
          updated: content,
          summary: original === null
            ? `created new file (${content.split('\n').length} lines)`
            : this.diffSummary(original, content) + ' (write_file overwrite)'
        };
      }
      case 'delete_file': {
        const rel = String(args.path || '').trim();
        if (!rel) throw new Error('delete_file requires a path.');
        const file = this.resolvePath(rel);
        const rootRaw = String(window.explorer ? window.explorer.rootPath : '').replace(/\\/g, '/').replace(/\/+$/, '');
        const rootLower = rootRaw.toLowerCase();

        // Refuse to nuke the workspace root itself.
        if (file.toLowerCase() === rootLower || file.toLowerCase() + '/' === rootLower + '/') {
          throw new Error(
            `Refusing to delete the workspace root (${rel}). ` +
            'Delete files and subfolders individually instead, or ask the user to close the folder manually.'
          );
        }

        // A readable text file → plain file delete. Otherwise treat it as a folder.
        const content = await window.electronAPI.readFile(file).catch(() => null);
        if (content !== null) {
          const bytes = new Blob([content]).size;
          return {
            kind: 'delete',
            path: file,
            relPath: rel,
            isDir: false,
            original: content,
            summary: `deleted file ${rel} (${this.humanSize(bytes)}) (delete_file)`
          };
        }

        const entries = await window.electronAPI.readDirectory(file).catch((e) => {
          const err = new Error(`Nothing to delete at ${rel}: ${e && e.message ? e.message : 'path not found'}`);
          err.__notFound = true;
          throw err;
        });

        if (entries.length) {
          const names = entries.slice(0, 20).map((e) => (e.isDirectory ? e.name + '/' : e.name));
          const more = entries.length > 20 ? ` (+${entries.length - 20} more)` : '';
          throw new Error(
            `Folder "${rel}" is not empty (${entries.length} entries: ${names.join(', ')}${more}). ` +
            'delete_file only removes empty folders — delete the children with delete_file first, one at a time.'
          );
        }

        // Empty folder.
        return {
          kind: 'delete',
          path: file,
          relPath: rel,
          isDir: true,
          summary: `deleted empty folder ${rel} (delete_file)`
        };
      }
      case 'move_file': {
        const fromRel = String(args.path || '').trim();
        const toRel = String(args.to || '').trim();
        if (!fromRel) throw new Error('move_file requires "path" (the source).');
        if (!toRel) throw new Error('move_file requires "to" (the destination).');
        const from = this.resolvePath(fromRel);
        const to = this.resolvePath(toRel);
        if (from.toLowerCase() === to.toLowerCase()) {
          throw new Error('move_file: source and destination are the same path — nothing to do.');
        }

        const existing = await window.electronAPI.readFile(to).catch(() => null);
        const destExists = existing !== null ||
          (await window.electronAPI.readDirectory(to).catch(() => null) !== null);
        if (destExists && !args.overwrite) {
          throw new Error(
            `move_file: "${toRel}" already exists. Choose a different destination, or set overwrite=true to replace it.`
          );
        }
        const srcIsDir = (await window.electronAPI.readDirectory(from).catch(() => null)) !== null;

        return {
          kind: 'move',
          path: from,
          to,
          fromRel,
          toRel,
          isDir: srcIsDir,
          overwrite: !!args.overwrite,
          summary: `moved ${fromRel} → ${toRel} (move_file)`
        };
      }
      case 'run_command': {
        const command = String(args.command || '').trim();
        if (!command) throw new Error('command must not be empty.');
        const requested = parseInt(args.timeout_ms, 10);
        const timeoutMs = isFinite(requested) && requested > 0
          ? Math.min(600000, Math.max(1000, requested))
          : 60000; // default stays 60 s
        return { kind: 'command', command, timeoutMs };
      }
      case 'read_files': {
        return this.prepareReadFiles(args);
      }
      case 'delete_files': {
        return await this.prepareDeleteFiles(args);
      }
      case 'move_files': {
        return await this.prepareMoveFiles(args);
      }
      case 'read_env': {
        return { kind: 'read', run: async () => this.collectEnv(args) };
      }
      case 'remember': {
        const text = String(args.text || args.fact || args.content || args.memory || '').trim();
        if (!text) throw new Error('remember requires "text" (the fact to store).');
        return {
          kind: 'read',
          run: async () => {
            const mem = window.agentMemory;
            if (!mem || typeof mem.remember !== 'function') {
              return 'Long-term memory is not available in this session (window.agentMemory is not loaded), so nothing was stored. Continue the task normally — do not retry this call.';
            }
            const opts = {};
            if (Array.isArray(args.tags) && args.tags.length) opts.tags = args.tags.map(String);
            if (args.key) opts.key = String(args.key);
            const r = await mem.remember(text, opts);
            return `Stored in long-term memory: ${condenseText(text, 200)}${r === false ? ' (the store rejected it — nothing persisted)' : ''}.`;
          }
        };
      }
      case 'recall': {
        const query = String(args.query || args.text || args.q || '').trim();
        if (!query) throw new Error('recall requires "query".');
        const limit = Math.min(20, Math.max(1, parseInt(args.limit, 10) || 5));
        return {
          kind: 'read',
          run: async () => {
            const mem = window.agentMemory;
            if (!mem || typeof mem.recall !== 'function') {
              return 'Long-term memory is not available in this session (window.agentMemory is not loaded), so there is nothing to recall. Continue the task normally — do not retry this call.';
            }
            const hits = await mem.recall(query, limit);
            if (!hits || !hits.length) return `No memories matched "${query}".`;
            return `Memories matching "${query}":\n` + hits.map((h) => '- ' + condenseText(typeof h === 'string' ? h : (h.text || JSON.stringify(h)), 240)).join('\n');
          }
        };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  // --- Bulk read ------------------------------------------------------------
  /** read_files: many files, one call, one character budget. */
  prepareReadFiles(args) {
    const target = String(args.path || args.dir || args.folder || '.').trim() || '.';
    const abs = this.resolvePath(target);
    const globStr = String(args.glob || args.filter || '').trim();
    const globRe = globStr ? this.globToRegExp(globStr) : null;
    const limit = Math.min(200, Math.max(1, parseInt(args.limit, 10) || 20));
    const budget = Math.min(200000, Math.max(500, parseInt(args.max_chars, 10) || 60000));

    return {
      kind: 'read',
      run: async () => {
        // A single file: no walk needed.
        const asFile = await window.electronAPI.readFile(abs).catch(() => null);
        let candidates;
        if (asFile !== null) {
          candidates = [{ relPath: target, absPath: abs }];
        } else {
          const all = (await window.electronAPI.listFilesRecursive(abs, 20000)) || [];
          candidates = all
            .filter((f) => !String(f.relPath || '').split('/').some((seg) => NOISE_DIRS.has(seg)))
            .filter((f) => !globRe || globRe.test(f.relPath) || globRe.test(f.name))
            .map((f) => ({ relPath: f.relPath, absPath: abs + '/' + f.relPath }));
        }
        if (!candidates.length) {
          return `No text files found under ${target}${globStr ? ` matching "${globStr}"` : ''}. It may be empty or contain only ignored folders (node_modules, dist, .git).`;
        }

        const chosen = candidates.slice(0, limit);
        const skippedByLimit = candidates.length - chosen.length;
        const parts = [];
        const notes = [];
        let used = 0;
        let read = 0;
        let skippedByBudget = 0;
        let unreadable = 0;

        for (const c of chosen) {
          const body = await window.electronAPI.readFile(c.absPath).catch(() => null);
          if (body === null) { unreadable++; continue; }
          read++;
          const header = `\n=== ${c.relPath} ===\n`;
          const room = budget - used - header.length;
          if (room <= 200) { skippedByBudget = chosen.length - read + 1; break; }
          const clipped = body.length > room;
          const text = clipped ? body.slice(0, room) : body;
          parts.push(header + text + (clipped ? '\n[truncated — budget exhausted]' : ''));
          used += header.length + text.length + 1;
        }

        if (skippedByLimit) notes.push(`${skippedByLimit} more file(s) matched but were not read (limit ${limit}) — raise "limit" or narrow "glob"`);
        if (skippedByBudget) notes.push(`${skippedByBudget} file(s) were not read because the ${budget}-char budget was exhausted — continue with read_file or read_files with a smaller "path"`);
        if (unreadable) notes.push(`${unreadable} file(s) could not be read as text`);

        const head = `[read_files: ${read} file(s) from ${target}${globStr ? ` matching "${globStr}"` : ''}, ${used} of ${budget} chars]`;
        const tail = notes.length ? '\n[skipped: ' + notes.join('; ') + ']' : '';
        return head + parts.join('\n') + tail;
      }
    };
  }

  // --- Bulk delete ----------------------------------------------------------
  /** delete_files: expand targets, refuse the root, keep every original. */
  async prepareDeleteFiles(args) {
    const rawTargets = [];
    const globStr = String(args.glob || args.pattern || args.filter || '').trim();
    // With a glob, `path` is the SEARCH BASE, not a delete target.
    const paths = args.paths !== undefined ? args.paths
      : (args.files !== undefined && typeof args.files === 'string') ? args.files
        : (globStr ? undefined : args.path);
    if (Array.isArray(paths)) {
      for (const p of paths) if (String(p || '').trim()) rawTargets.push(String(p).trim());
    } else if (typeof paths === 'string' && paths.trim()) {
      rawTargets.push(paths.trim());
    }

    if (globStr) {
      const base = this.resolvePath(String(args.path || args.dir || '.').trim() || '.');
      const re = this.globToRegExp(globStr);
      const all = (await window.electronAPI.listFilesRecursive(base, 20000)) || [];
      const hits = all.filter((f) => re.test(f.relPath) || re.test(f.name));
      if (!hits.length) throw new Error(`delete_files: no files matched "${globStr}" under ${base} — nothing to delete.`);
      const baseRel = String(args.path || '.').replace(/\\/g, '/').replace(/\/+$/, '');
      const baseKey = this.resolvePath(String(args.path || '.').trim() || '.').toLowerCase();
      for (const f of hits) {
        const rel = baseRel && baseRel !== '.' ? baseRel + '/' + f.relPath : f.relPath;
        // A glob selects FILES; never remove the folder that merely contains them.
        if (this.resolvePath(rel).toLowerCase() === baseKey) continue;
        rawTargets.push(rel);
      }
    }

    if (!rawTargets.length) {
      throw new Error('delete_files requires "paths" (an array), a "path", or "path" + "glob".');
    }

    const rootRaw = String(window.explorer ? window.explorer.rootPath : '').replace(/\\/g, '/').replace(/\/+$/, '');
    const rootLower = rootRaw.toLowerCase();

    const items = [];
    const seen = new Set();
    for (const rel of rawTargets) {
      let abs;
      try { abs = this.resolvePath(rel); } catch (e) { throw new Error(`delete_files: ${rel} — ${e.message}`); }
      const key = abs.toLowerCase();
      if (seen.has(key)) continue;
      if (key === rootLower || key === rootLower.replace(/\/$/, '')) {
        throw new Error(
          `Refusing to delete the workspace root (${rel}). ` +
          'delete_files can never remove the folder the project lives in — ask the user to close it manually.'
        );
      }

      const content = await window.electronAPI.readFile(abs).catch(() => null);
      if (content !== null) {
        seen.add(key);
        items.push({ path: abs, relPath: rel, isDir: false, original: content });
        continue;
      }

      const entries = await window.electronAPI.readDirectory(abs).catch(() => null);
      if (entries === null) {
        throw new Error(`delete_files: "${rel}" does not exist — nothing to delete.`);
      }
      if (!entries.length) {
        seen.add(key);
        items.push({ path: abs, relPath: rel, isDir: true, original: null });
        continue;
      }
      // Non-empty folder → expand the whole tree, deepest entries first.
      // expandTree returns the folder itself last and `key` is deliberately NOT
      // recorded yet, so its own entry survives the dedupe below.
      const tree = await this.expandTree(abs, rel);
      if (!tree.length) throw new Error(`delete_files: "${rel}" is empty but could not be expanded.`);
      for (const t of tree) {
        const tKey = t.path.toLowerCase();
        if (seen.has(tKey)) continue;
        seen.add(tKey);
        items.push(t);
      }
    }

    if (!items.length) throw new Error('delete_files: every requested path was already gone — nothing to do.');
    const fileCount = items.filter((i) => !i.isDir).length;
    const dirCount = items.length - fileCount;
    const shown = items.slice(0, 10).map((i) => i.relPath + (i.isDir ? '/' : ''));
    const more = items.length > 10 ? `, +${items.length - 10} more` : '';
    const label = dirCount
      ? `${items.length} item(s): ${fileCount} file(s), ${dirCount} folder(s)`
      : `${items.length} file(s)`;

    return {
      kind: 'delete',
      items,
      summary: `DELETE ${label} — ${shown.join(', ')}${more}. All of them can be restored with Revert.`,
      detail: items.map((i) => i.relPath + (i.isDir ? '/' : '')).join('\n')
    };
  }

  /** Recursively list a folder: files with content, then empty/deeper folders. */
  async expandTree(dirAbs, dirRel, out) {
    out = out || [];
    const entries = await window.electronAPI.readDirectory(dirAbs).catch(() => null);
    if (entries === null) return out;
    const dirs = [];
    for (const e of entries) {
      if (NOISE_DIRS.has(e.name)) continue; // never nuke vendored noise by accident
      const childAbs = dirAbs + '/' + e.name;
      const childRel = dirRel + '/' + e.name;
      if (e.isDirectory) dirs.push([childAbs, childRel]);
      else {
        const content = await window.electronAPI.readFile(childAbs).catch(() => null);
        out.push({ path: childAbs, relPath: childRel, isDir: false, original: content === null ? '' : content });
      }
    }
    // deepest first so folders are empty by the time we remove them
    for (const [a, r] of dirs) await this.expandTree(a, r, out);
    out.push({ path: dirAbs, relPath: dirRel, isDir: true, original: null });
    return out;
  }

  // --- Bulk move ------------------------------------------------------------
  /** move_files: explicit pairs, a single pair, or a glob into a folder. */
  async prepareMoveFiles(args) {
    const overwrite = !!args.overwrite;
    const pairs = [];

    const files = Array.isArray(args.files) ? args.files : null;
    if (files) {
      for (const f of files) {
        if (!f || typeof f !== 'object') continue;
        const from = String(f.from || f.path || f.source || '').trim();
        const to = String(f.to || f.dest || f.destination || f.target || '').trim();
        if (!from || !to) throw new Error('move_files: every entry in "files" needs both "from" and "to".');
        pairs.push({ from, to });
      }
    }

    const singleFrom = String(args.from || args.path || '').trim();
    const singleTo = String(args.to || args.dest || args.destination || '').trim();
    if (!files || !files.length) {
      if (!singleFrom || !singleTo) {
        throw new Error('move_files requires "files":[{"from","to"}], or "from" + "to", or "path" (glob) + "to".');
      }
      // glob sources?
      if (singleFrom.match(/[*?]/)) {
        const lastSlash = Math.max(singleFrom.lastIndexOf('/'), singleFrom.lastIndexOf('\\'));
        const dirPart = lastSlash > 0 ? singleFrom.slice(0, lastSlash) : '.';
        const globStr = lastSlash > 0 ? singleFrom.slice(lastSlash + 1) : singleFrom;
        const re = this.globToRegExp(globStr);
        const base = this.resolvePath(dirPart);
        const all = (await window.electronAPI.listFilesRecursive(base, 20000)) || [];
        const hits = all.filter((f) => re.test(f.relPath) || re.test(f.name));
        if (!hits.length) throw new Error(`move_files: no files matched "${singleFrom}" under ${base}.`);
        for (const f of hits) {
          const from = (dirPart && dirPart !== '.' ? dirPart + '/' : '') + f.relPath;
          pairs.push({ from, to: singleTo });
        }
      } else {
        pairs.push({ from: singleFrom, to: singleTo });
      }
    }

    const items = [];
    const seen = new Set();
    for (const p of pairs) {
      const fromAbs = this.resolvePath(p.from);
      let toRel = p.to;
      let toAbs = this.resolvePath(toRel);

      // A folder destination (trailing "/" or an existing directory) keeps the name.
      const destIsDir = /[\\/]$/.test(toRel) ||
        (await window.electronAPI.readFile(toAbs).catch(() => null) === null &&
          (await window.electronAPI.readDirectory(toAbs).catch(() => null) !== null));
      if (destIsDir) {
        const base = p.from.split(/[\\/]/).filter(Boolean).pop() || '';
        toRel = toRel.replace(/[\\/]+$/, '') + '/' + base;
        toAbs = this.resolvePath(toRel);
      }

      if (fromAbs.toLowerCase() === toAbs.toLowerCase()) {
        throw new Error(`move_files: source and destination are the same path (${p.from}) — nothing to do.`);
      }
      const key = fromAbs.toLowerCase() + '->' + toAbs.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      const srcIsFile = (await window.electronAPI.readFile(fromAbs).catch(() => null)) !== null;
      const srcIsDir = !srcIsFile &&
        (await window.electronAPI.readDirectory(fromAbs).catch(() => null)) !== null;
      if (!srcIsFile && !srcIsDir) {
        throw new Error(`move_files: "${p.from}" does not exist.`);
      }
      const destExists = (await window.electronAPI.readFile(toAbs).catch(() => null) !== null) ||
        (await window.electronAPI.readDirectory(toAbs).catch(() => null) !== null);
      if (destExists && !overwrite) {
        throw new Error(
          `move_files: "${toRel}" already exists. Pick another destination, or set overwrite=true to replace it.`
        );
      }
      items.push({
        path: fromAbs, to: toAbs, fromRel: p.from, toRel,
        isDir: srcIsDir, overwrite
      });
    }

    if (!items.length) throw new Error('move_files: nothing to move.');
    const shown = items.slice(0, 10).map((i) => `${i.fromRel} → ${i.toRel}`);
    const more = items.length > 10 ? `, +${items.length - 10} more` : '';
    return {
      kind: 'move',
      items,
      summary: `MOVE ${items.length} item(s) — ${shown.join(', ')}${more}. Reversible with Revert.`,
      detail: shown.join('\n')
    };
  }

  // --- Environment ----------------------------------------------------------
  /**
   * read_env: renderer processes have no environment object, and no new IPC may
   * added, so this is built from the existing bridge — the workspace .env
   * files, package.json and the navigator/platform surface. The summary says
   * plainly which facts are unavailable rather than inventing them.
   */
  async collectEnv(args) {
    const root = window.explorer ? window.explorer.rootPath : null;
    const vars = new Map();
    const sources = [];

    // Preferred path: the real OS environment + machine facts from the main
    // process (secrets are masked there before they ever reach the model).
    let sys = null;
    if (window.electronAPI && window.electronAPI.sysInfo) {
      try {
        const info = await window.electronAPI.sysInfo();
        if (info && info.ok) {
          sys = info;
          sources.push('process environment');
          const env = info.env || {};
          for (const k of Object.keys(env).sort()) {
            vars.set(k, { value: String(env[k]), from: 'process.env' });
          }
        }
      } catch (e) {
        sys = null;
      }
    }

    const ENV_FILES = ['.env', '.env.local', '.env.development', '.env.production', 'env.txt'];
    for (const name of ENV_FILES) {
      let abs;
      try { abs = this.resolvePath(name); } catch (e) { continue; }
      const raw = await window.electronAPI.readFile(abs).catch(() => null);
      if (raw === null) continue;
      sources.push(name);
      for (const line of raw.split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const m = t.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (!m) continue;
        let v = m[2].trim();
        if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
        if (!vars.has(m[1])) vars.set(m[1], { value: v, from: name });
      }
    }

    // User-level info reachable without new IPC.
    if (root) {
      const pkgRaw = await window.electronAPI.readFile(this.resolvePath('package.json')).catch(() => null);
      if (pkgRaw !== null) {
        try {
          const pkg = JSON.parse(pkgRaw);
          sources.push('package.json');
          const eng = pkg.engines || {};
          const meta = [
            ['PROJECT_NAME', pkg.name || '(unnamed)'],
            ['PROJECT_VERSION', pkg.version || '(none)'],
            ['NODE_REQUIRED', eng.node || '(unspecified)']
          ];
          for (const [k, v] of meta) if (!vars.has(k)) vars.set(k, { value: String(v), from: 'package.json' });
        } catch (e) { /* malformed package.json is not fatal */ }
      }
    }

    const s = sys && sys.system ? sys.system : null;
    const summary = [
      'System summary:',
      '- platform: ' + ((s && (s.platform + ' ' + s.arch)) || (typeof navigator !== 'undefined' && navigator.platform ? navigator.platform : 'unknown')) +
      (s && s.release ? ' (' + s.release + ')' : '') +
      (s && s.cpus ? ' · ' + s.cpus + ' logical cores' : ''),
      '- workspace cwd: ' + (root || 'no folder open') +
      (s && s.cwd ? ' · process cwd: ' + s.cwd : ''),
      '- memory: ' + (s ? Math.round(s.freeMemMB / 1024) + ' GB free of ' + Math.round(s.totalMemMB / 1024) + ' GB' : 'not readable from the renderer') +
      (s && s.homedir ? ' · home: ' + s.homedir : ''),
      '- versions: node ' + ((s && s.node) || '?') +
      (s && s.electron ? ' · electron ' + s.electron : '') +
      (s && s.chrome ? ' · chromium ' + s.chrome : '') +
      (s && s.appVersion ? ' · app ' + s.appVersion : ''),
      '- electron version: not readable from the renderer; read it from package.json devDependencies',
      '- free memory: not readable from the renderer; run run_command {"command":"Get-CimInstance Win32_OperatingSystem"}'
    ].join('\n');

    const wanted = String(args.name || '').trim();
    const filter = String(args.filter || '').trim();
    const CAP = 200;

    if (wanted) {
      const key = wanted.toUpperCase();
      const hit = Array.from(vars.entries()).find(([k]) => k.toUpperCase() === key);
      const lines = [`${key} = ${hit ? hit[1].value : '(not found)'}`, `(source: ${hit ? hit[1].from : 'unavailable'})`];
      if (vars.has(key) || /^(PATH|OS|NOTEPAD|TEMP|TMP|USERPROFILE|HOME|SHELL|PROCESSOR_ARCHITECTURE|COMPUTERNAME|USERNAME|APPDATA|LOCALAPPDATA|EDITOR|TERM)$/.test(key)) {
        lines.push(sys
          ? 'Source: the real process environment (secret-looking values are masked).'
          : 'Note: the true OS environment lives in the main process and no env IPC is available here.');
      }
      return summary + '\n\n' + lines.join('\n');
    }

    let entries = Array.from(vars.entries());
    if (filter) {
      const f = filter.toLowerCase();
      entries = entries.filter(([k]) => k.toLowerCase().includes(f));
    }
    if (!entries.length) {
      return summary + '\n\nNo variables matched' + (filter ? ` "${filter}"` : '') +
        '.\nSources inspected: ' + (sources.length ? sources.join(', ') : 'none found') +
        '.\nThe renderer cannot read the real OS environment; use run_command ("Get-ChildItem Env:") when you need it.';
    }
    const shown = entries.slice(0, CAP);
    const lines = shown.map(([k, v]) => `${k} = ${v.value}   (${v.from})`);
    const more = entries.length > CAP ? `\n[${entries.length - CAP} more variables — narrow with "filter" or "name"]` : '';
    return summary + '\n\n' +
      `${shown.length} of ${entries.length} variable(s) from: ${sources.join(', ') || 'workspace'}:\n` +
      lines.join('\n') + more +
      '\nNote: the renderer cannot read the real OS environment; use run_command ("Get-ChildItem Env:") for that.';
  }

  // --- Approval gate -------------------------------------------------------
  requestPermission(card, plan) {
    const mode = window.AppSettings ? window.AppSettings.get('agentMode') : 'ask';
    const category = plan.kind === 'command' ? 'command' : 'edit';

    // Dry run: the approval gate is forced ON for every mutating action, even
    // in Fully-auto / edit-auto mode or when the session pre-approved it.
    const dryRun = (typeof window !== 'undefined' && window.agentDryRun === true);
    if (!dryRun && this.sessionAllow.has(category)) return Promise.resolve(true);
    if (!dryRun && mode === 'full-auto') return Promise.resolve(true);
    if (!dryRun && mode === 'edit-auto' && category === 'edit') return Promise.resolve(true);

    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      /**
       * @param {boolean} ok        approved?
       * @param {boolean} allowAll  remember the choice for this session
       * @param {boolean} cancelled resolved because the user pressed Stop
       */
      const finish = (ok, allowAll, cancelled) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this._timers.delete(timer)) clearTimeout(timer);
        this._pendingApprovals.delete(finish);
        if (allowAll) this.sessionAllow.add(category);
        if (cancelled) {
          // Never leave a dead approval card hanging in the chat.
          try { card.setState('cancelled'); } catch (e) { /* card detached */ }
        }
        card.closeDiff();
        resolve(ok);
      };
      // A stop can reach this promise at any time before the user clicks.
      this._pendingApprovals.add(finish);

      // Auto-open the diff proposal for file edits (VS Code / Cursor style)
      if (plan.kind === 'edit') {
        card.openDiff(plan, (ok) => finish(ok, false));
      } else if (plan.detail || plan.summary) {
        // Bulk plans (delete_files / move_files) list exactly what will change.
        card.setState('awaiting', plan.detail || plan.summary);
      }

      const approvedLabel = plan.kind === 'command' ? '▶ Run' : '✓ Approve';
      card.showActions([
        { label: approvedLabel, cls: 'approve', onClick: () => finish(true, false) },
        { label: '✕ Reject', cls: 'reject', onClick: () => finish(false, false) },
        { label: 'Allow all in this session', cls: 'allow', onClick: () => finish(true, true) }
      ]);

      // 5-minute approval timeout. Registered as an agent-owned timer so a stop
      // clears it instead of leaving it pending forever.
      timer = this.setTimer(() => finish(false, false), 5 * 60 * 1000);
    });
  }

  // --- Apply an approved edit ---------------------------------------------
  async applyEdit(plan) {
    const existed = plan.original !== '';
    // directories may need creating for new nested files
    const lastSlash = Math.max(plan.path.lastIndexOf('/'), plan.path.lastIndexOf('\\'));
    if (lastSlash > 0) {
      const dir = plan.path.slice(0, lastSlash);
      await window.electronAPI.createDirectory(dir).catch(() => {});
    }
    // Stop semantics for an in-flight write: we deliberately do NOT race the
    // stop against this await. writeFile hands the full content to the main
    // process in one IPC, so it either completes (whole file on disk, tracked
    // for revert) or never starts (skipped by the cancelRequested check in
    // executeToolCall). A half-written file is therefore impossible; the only
    // observable effect of stopping mid-write is that the write completes and
    // stays in the Revert list.
    await window.electronAPI.writeFile(plan.path, plan.updated);

    // Sync an open editor tab (keep it clean — disk == buffer)
    const em = window.editor;
    if (em && em.tabs) {
      const tab = em.tabs.get(plan.path);
      if (tab) {
        try {
          if (tab.model.getValue() !== plan.updated) tab.model.setValue(plan.updated);
          tab.originalContent = plan.updated;
          tab.dirty = false;
          em.renderTabs();
        } catch (e) { console.warn('tab sync failed', e); }
      }
    }

    this.trackChange(plan.path, plan.original, plan.updated);
    this.refreshIndexes();
  }

  // --- Apply an approved delete --------------------------------------------
  async applyDelete(plan) {
    // Bulk (delete_files): items[]; single (delete_file): this path/original.
    const items = Array.isArray(plan.items) && plan.items.length
      ? plan.items
      : [{ path: plan.path, relPath: plan.relPath, isDir: plan.isDir, original: plan.original }];

    const deleted = [];
    const failed = [];
    // Deepest paths first so folders are empty when they are removed.
    const ordered = items.slice().sort((a, b) => b.path.length - a.path.length);

    for (const item of ordered) {
      const original = item.original !== undefined && item.original !== null
        ? item.original
        : (await window.electronAPI.readFile(item.path).catch(() => ''));
      const r = await window.electronAPI.deletePath(item.path).catch((e) => ({ error: e && e.message ? e.message : String(e) }));
      if (r && r.error) {
        failed.push(`${item.relPath} (${r.error})`);
        continue;
      }
      deleted.push(item.relPath + (item.isDir ? '/' : ''));
      this.closeTabFor(item.path);
      if (item.isDir) {
        this.changes.delete(item.path); // an empty folder has nothing to restore
      } else {
        // tracked with updated === null so "revert" restores the exact content
        this.trackChange(item.path, original, null);
      }
    }
    this.refreshIndexes();

    const head = deleted.slice(0, 10).join(', ') + (deleted.length > 10 ? `, +${deleted.length - 10} more` : '');
    const tail = failed.length ? `\nFailed to delete ${failed.length} item(s): ${failed.join(', ')}` : '';
    return `Deleted ${deleted.length} item(s): ${head}. Use Revert to restore them.${tail}`;
  }

  // --- Apply an approved move / rename --------------------------------------
  async applyMove(plan) {
    const items = Array.isArray(plan.items) && plan.items.length ? plan.items : [plan];
    const moved = [];
    const failed = [];

    for (const item of items) {
      const lastSlash = Math.max(item.to.lastIndexOf('/'), item.to.lastIndexOf('\\'));
      if (lastSlash > 0) {
        await window.electronAPI.createDirectory(item.to.slice(0, lastSlash)).catch(() => {});
      }
      // Snapshot the content BEFORE the move so revert can put it back.
      let content = null;
      if (!item.isDir) content = await window.electronAPI.readFile(item.path).catch(() => '');
      // ...and the content an overwrite is about to destroy.
      let overwritten = null;
      if (item.overwrite && !item.isDir) {
        overwritten = await window.electronAPI.readFile(item.to).catch(() => null);
      }
      if (item.overwrite) await window.electronAPI.deletePath(item.to).catch(() => {});

      let res = await window.electronAPI.renamePath(item.path, item.to)
        .catch((e) => ({ error: e && e.message ? e.message : String(e) }));
      if (!res || res.error) {
        // Fallback for cross-volume moves the OS cannot rename directly.
        if (!item.isDir) {
          const c = content === null ? await window.electronAPI.readFile(item.path) : content;
          await window.electronAPI.writeFile(item.to, c);
          await window.electronAPI.deletePath(item.path).catch(() => {});
          res = { ok: true };
        } else {
          failed.push(`${item.fromRel} (${(res && res.error) || 'unknown error'})`);
          continue;
        }
      }

      const previous = this.changes.get(item.path);
      if (previous) this.changes.delete(item.path);
      if (!item.isDir) {
        const payload = previous && previous.updated !== null ? previous.updated : (content === null ? '' : content);
        // source tracked as "deleted" + destination as "added" → revert moves back
        this.trackChange(item.path, payload, null);
        this.trackChange(item.to, null, payload, overwritten);
      } else {
        this.renderChangesBadge();
        this.renderChangesList();
      }
      moved.push(`${item.fromRel} → ${item.toRel}`);
      this.closeTabFor(item.path);
    }

    this.refreshIndexes();
    const head = moved.slice(0, 10).join(', ') + (moved.length > 10 ? `, +${moved.length - 10} more` : '');
    const tail = failed.length ? `\nFailed to move ${failed.length} item(s): ${failed.join(', ')}` : '';
    return `Moved ${moved.length} item(s): ${head}.${tail}`;
  }

  closeTabFor(path) {
    try {
      const em = window.editor;
      if (em && em.tabs && em.tabs.has && em.tabs.has(path)) em.closeByKey ? em.closeByKey(path) : null;
    } catch (e) { /* tab bookkeeping is best-effort */ }
  }

  /** Short one-line description of what a prepared tool call will do. */
  planTarget(plan, args) {
    if (plan && Array.isArray(plan.items) && plan.items.length) {
      const n = plan.items.length;
      const first = plan.items[0];
      const head = plan.kind === 'move' && first.toRel ? `${first.fromRel} -> ${first.toRel}` : first.relPath;
      return n > 1 ? `${head} (+${n - 1} more)` : head;
    }
    if (plan && plan.relPath) {
      return plan.kind === 'move' ? `${plan.fromRel} -> ${plan.toRel}` : plan.relPath;
    }
    if (plan && plan.path) return plan.path;
    if (plan && plan.command) return plan.command;
    if (args && Array.isArray(args.paths)) return `${args.paths.length} paths`;
    if (args && Array.isArray(args.files)) return `${args.files.length} files`;
    return (args && (args.path || args.name || args.text || args.query || args.command)) || '';
  }

  humanSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  /**
   * @param {string|null} [overwritten] content that an overwrite move destroyed
   *        at this path; revert puts it back after removing the moved-in file.
   */
  trackChange(path, original, updated, overwritten) {
    this.changes.set(path, { path, original, updated, time: Date.now(), overwritten: overwritten || null });
    this.renderChangesBadge();
    this.renderChangesList();
  }

  async revertChange(path) {
    const change = this.changes.get(path);
    if (!change) return;
    if (change.updated === null) {
      // was deleted by the agent → restore it
      await window.electronAPI.createDirectory(
        path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))) || '.'
      ).catch(() => {});
      await window.electronAPI.writeFile(path, change.original == null ? '' : change.original);
    } else if (change.original === null) {
      // was created by the agent (e.g. moved in) → remove it again
      await window.electronAPI.deletePath(path).catch(() => {});
      // an overwrite move also destroyed whatever used to live here
      if (change.overwritten != null) {
        await window.electronAPI.createDirectory(
          path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))) || '.'
        ).catch(() => {});
        await window.electronAPI.writeFile(path, change.overwritten);
      }
    } else {
      await window.electronAPI.writeFile(path, change.original);
    }
    const em = window.editor;
    if (em && em.tabs) {
      const tab = em.tabs.get(path);
      if (tab) {
        try {
          if (tab.model.getValue() !== change.original) tab.model.setValue(change.original);
          tab.originalContent = change.original;
          tab.dirty = false;
          em.renderTabs();
        } catch (e) { console.warn(e); }
      }
    }
    this.changes.delete(path);
    this.renderChangesBadge();
    this.refreshIndexes();
  }

  refreshIndexes() {
    try { if (window.FileIndex) window.FileIndex.invalidate(); } catch (e) {}
    try { if (window.palette) window.palette.refreshFiles(); } catch (e) {}
    try { if (window.workspaceSearch) window.workspaceSearch.refresh(); } catch (e) {}
  }

  renderChangesBadge() {
    const badge = document.getElementById('statusbar-changes');
    if (!badge) return;
    const n = this.changes.size;
    badge.classList.toggle('hidden', n === 0);
    badge.innerHTML = `<span>◈ ${n} change${n === 1 ? '' : 's'}</span>`;
  }

  toggleChangesPopup() {
    const popup = document.getElementById('changes-popup');
    if (!popup) return;
    if (popup.classList.contains('hidden')) {
      this.renderChangesList();
      const badge = document.getElementById('statusbar-changes');
      const r = badge ? badge.getBoundingClientRect() : { right: window.innerWidth - 20, top: window.innerHeight - 30 };
      popup.style.right = Math.max(12, window.innerWidth - r.right) + 'px';
      popup.classList.remove('hidden');
    } else {
      popup.classList.add('hidden');
    }
  }

  hideChangesPopup() {
    const popup = document.getElementById('changes-popup');
    if (popup) popup.classList.add('hidden');
  }

  renderChangesList() {
    const list = document.getElementById('changes-list');
    if (!list) return;
    list.innerHTML = '';
    if (!this.changes.size) {
      list.innerHTML = '<div class="changes-empty">No pending changes.</div>';
      return;
    }
    for (const change of this.changes.values()) {
      const row = document.createElement('div');
      row.className = 'change-row';
      const name = change.path.split(/[\\/]/).pop();
      const dir = change.path.split(/[\\/]/).slice(-2, -1)[0] || '';
      const deleted = change.updated === null;
      const added = change.original === null;
      const verb = deleted ? 'deleted' : (added ? 'added/moved in' : 'edited');
      row.innerHTML = `
        <div class="change-info" title="${this.escapeAttr(change.path)}">
          <span class="change-name">${this.escape(name)}</span>
          <span class="change-dir">${this.escape(dir)}/</span>
          <span class="change-verb">${verb}</span>
        </div>
        <div class="change-actions">
          <button class="change-btn" data-act="diff" title="Review diff"${deleted || added ? ' disabled' : ''}>◈ Diff</button>
          <button class="change-btn" data-act="revert" title="Revert to original">↺</button>
        </div>
      `;
      const diffBtn = row.querySelector('[data-act="diff"]');
      if (!deleted && !added) {
        diffBtn.addEventListener('click', () => {
          this.openChangeDiff(change);
        });
      }
      row.querySelector('[data-act="revert"]').addEventListener('click', async () => {
        await this.revertChange(change.path);
        this.renderChangesList();
      });
      list.appendChild(row);
    }
  }

  openChangeDiff(change) {
    const id = 'change-' + (++this.diffSeq);
    window.editor.openDiffTab({
      id,
      title: change.path.split(/[\\/]/).pop(),
      oldContent: change.original,
      newContent: change.updated,
      meta: {
        acceptLabel: '✓ Keep changes',
        revertLabel: '↺ Revert file',
        onAccept: async () => { window.editor.closeByKey('diff:' + id); },
        onRevert: async () => {
          await this.revertChange(change.path);
          window.editor.closeByKey('diff:' + id);
        }
      }
    });
  }

  // ==========================================================================
  // Tool cards (per-step UI)
  // ==========================================================================
  renderToolCard(name, args) {
    const self = this;
    const container = document.getElementById('chat-messages');
    const node = document.createElement('div');
    node.className = 'tool-card';
    node.dataset.state = 'pending';

    const target = (args.paths && Array.isArray(args.paths))
      ? `${args.paths.length} paths`
      : (args.files && Array.isArray(args.files))
        ? `${args.files.length} files`
        : (args.path && args.to ? `${args.path} → ${args.to}` : null)
          || (Array.isArray(args.path) ? `${args.path.length} paths` : null)
          || args.path || args.name || args.text || args.command || args.query || '';
    node.innerHTML = `
      <div class="tool-head">
        <span class="tool-ico">${TOOL_ICONS[name] || '🔧'}</span>
        <span class="tool-name">${this.escape(TOOL_TITLES[name] || name)}</span>
        <span class="tool-target">${this.escape(this.trunc(String(target), 70))}</span>
        <span class="tool-badge">…</span>
      </div>
      <div class="tool-detail hidden"></div>
      <div class="tool-actions hidden"></div>
    `;
    container.appendChild(node);
    if (window.ai) window.ai.scrollToBottom();

    const detail = node.querySelector('.tool-detail');
    const badge = node.querySelector('.tool-badge');
    const actions = node.querySelector('.tool-actions');
    let diffId = null;

    const card = {
      node,
      /**
       * @param {string} state  badge/card state
       * @param {string} [text] detail body
       * @param {boolean} [raw] true when the text is verbatim tool output
       *        (file contents, command stdout) which must NOT be filtered;
       *        agent-authored summaries default to filtered.
       */
      setState(state, text, raw) {
        node.dataset.state = state;
        const labels = {
          pending: '…', running: 'working…', done: '✓ done',
          deleted: '🗑 deleted', moved: '📦 moved',
          error: '✗ error', rejected: '✕ rejected', awaiting: 'awaiting approval',
          cancelled: '⏹ cancelled'
        };
        badge.textContent = labels[state] || state;
        if (text) {
          detail.classList.remove('hidden');
          detail.innerHTML = '';
          const pre = document.createElement('pre');
          pre.className = 'tool-output';
          const s = raw ? String(text) : stripAsciiDecoration(text);
          pre.textContent = s.length > 900 ? s.slice(0, 900) + '\n[…]' : s;
          detail.appendChild(pre);
          if (window.ai) window.ai.scrollToBottom();
        }
        if (state === 'done' || state === 'deleted' || state === 'moved' || state === 'error' ||
          state === 'rejected' || state === 'cancelled') {
          actions.classList.add('hidden');
        }
      },
      showActions(buttons) {
        actions.classList.remove('hidden');
        actions.innerHTML = '';
        buttons.forEach((b) => {
          const btn = document.createElement('button');
          btn.className = 'tool-act-btn ' + (b.cls || '');
          btn.textContent = b.label;
          btn.addEventListener('click', () => {
            actions.innerHTML = '';
            actions.classList.add('hidden');
            b.onClick();
          });
          actions.appendChild(btn);
        });
        if (window.ai) window.ai.scrollToBottom();
      },
      openDiff(plan, onDecision) {
        diffId = 'agent-pending-' + (++self.diffSeq);
        window.editor.openDiffTab({
          id: diffId,
          title: (plan.path.split(/[\\/]/).pop() || 'file') + ' (agent proposal)',
          oldContent: plan.original,
          newContent: plan.updated,
          meta: {
            acceptLabel: '✓ Approve & Apply',
            revertLabel: '✕ Reject',
            onAccept: async (finalContent) => {
              if (typeof finalContent === 'string' && finalContent !== plan.updated) {
                plan.updated = finalContent;
                plan.summary += ' (modified by user in diff view)';
              }
              onDecision(true);
            },
            onRevert: async () => { onDecision(false); }
          }
        });
      },
      closeDiff() {
        if (diffId) {
          try { window.editor.closeByKey('diff:' + diffId); } catch (e) {}
          diffId = null;
        }
      }
    };

    return card;
  }

  // ==========================================================================
  // Chat message helpers (reuses AIAssistant rendering)
  // ==========================================================================
  showWelcomeOnce() {
    if (this._welcomed) return;
    this._welcomed = true;
    const container = document.getElementById('chat-messages');
    if (!container) return;
    const el = document.createElement('div');
    el.className = 'chat-msg assistant agent-welcome';
    el.innerHTML = `
      <div class="sender-title">🤖 Agent</div>
      <div class="msg-body">
        I can explore the codebase, edit files and run commands.
        Each change goes through the <b>review bar</b> — approve, inspect the diff, or reject it.
        Mode is set by the 🛡 selector above (<b>Ask</b> / <b>Auto-edit</b> / <b>Autonomous</b>).
      </div>
    `;
    container.appendChild(el);
  }

  pushAssistant(markdown) {
    const ai = window.ai;
    const container = document.getElementById('chat-messages');
    if (!container) return null;
    // every agent-authored string goes through the same decorative filter
    let clean = stripAsciiDecoration(markdown);
    if (this.thinkOff) clean = stripLeadingThinking(clean);
    const el = document.createElement('div');
    el.className = 'chat-msg assistant';
    el.innerHTML = `
      <div class="sender-title">🤖 Cloud Code Agent</div>
      <div class="msg-body"></div>
    `;
    const body = el.querySelector('.msg-body');
    if (ai) {
      body.innerHTML = ai.renderMarkdown(clean);
      ai.wireCodeButtons(body);
    } else {
      body.textContent = clean;
    }
    container.appendChild(el);
    if (ai) ai.scrollToBottom();
    return el;
  }

  pushNotice(markdown) {
    const container = document.getElementById('chat-messages');
    if (!container) return null;
    // notices are agent-authored prose — strip decorative ASCII lines
    const clean = stripAsciiDecoration(markdown);
    const el = document.createElement('div');
    el.className = 'agent-notice';
    const ai = window.ai;
    if (ai) el.innerHTML = ai.renderMarkdown(clean);
    else el.textContent = clean;
    container.appendChild(el);
    if (ai) ai.scrollToBottom();
    return el;
  }

  pushThinking() {
    const container = document.getElementById('chat-messages');
    if (!container) return null;
    const el = document.createElement('div');
    el.className = 'chat-msg assistant agent-thinking-msg';
    el.innerHTML = `
      <div class="sender-title">🤖 Cloud Code Agent</div>
      <div class="msg-body"><span class="agent-spinner"></span> Thinking…</div>
    `;
    container.appendChild(el);
    if (window.ai) window.ai.scrollToBottom();
    // Tracked so requestStop() can remove every live placeholder at once.
    this._thinkingNodes.add(el);
    return el;
  }

  removeNode(el) {
    if (el) this._thinkingNodes.delete(el);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  mentionSummary() {
    return '';
  }

  // ==========================================================================
  // Utilities
  // ==========================================================================
  resolvePath(p) {
    const rootRaw = window.explorer ? window.explorer.rootPath : null;
    if (!rootRaw) throw new Error('No workspace folder is open.');
    // The engine owns the path sandbox; keep the local copy as a fallback.
    const eng = (window.CloudAI && window.CloudAI.tools) || null;
    if (eng && typeof eng.resolvePath === 'function') {
      try {
        return eng.resolvePath(p, {
          root: String(rootRaw).replace(/\\/g, '/').replace(/\/+$/, ''),
          allowOutside: !!(window.AppSettings && window.AppSettings.get('agentAllowOutsideWorkspace'))
        });
      } catch (e) {
        if (e && /outside the workspace/i.test(e.message || '')) throw e;
        /* fall through to the local implementation */
      }
    }
    const root = String(rootRaw).replace(/\\/g, '/').replace(/\/+$/, '');
    let norm = String(p == null ? '' : p).trim().replace(/\\/g, '/');
    if (!norm) throw new Error('Empty path.');
    const isAbs = /^[a-zA-Z]:\//.test(norm) || norm.startsWith('/');
    const full = isAbs ? norm : root + '/' + norm;

    const parts = [];
    for (const seg of full.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') {
        if (parts.length > 1) parts.pop(); // never pop the drive/root
        continue;
      }
      parts.push(seg);
    }
    let out = parts.join('/');
    if (/^[a-zA-Z]:$/.test(parts[0]) || /^[a-zA-Z]:/.test(full)) {
      out = parts.join('/'); // D:/...
    } else if (!/^[a-zA-Z]:/.test(out)) {
      out = '/' + out;
    }

    const inWorkspace = out.toLowerCase() === root.toLowerCase() ||
      out.toLowerCase().startsWith(root.toLowerCase() + '/');
    const allowOutside = !!(window.AppSettings && window.AppSettings.get('agentAllowOutsideWorkspace'));
    if (!inWorkspace && !allowOutside) {
      throw new Error(
        `Path is outside the workspace: ${p}\n` +
        'All paths must be relative to the workspace root. To work on files outside ' +
        'it, the user can enable "Allow agent outside workspace" in Settings.'
      );
    }
    return out;
  }

  /**
   * Small local models are loose with argument names (path vs file vs filename,
   * content vs text, ...) and sometimes emit JSON that got truncated. Normalise
   * the common aliases + coerce stringly-typed booleans/numbers so a tool call
   * is never lost over a cosmetic mismatch.
   */
  normalizeArgs(name, args) {
    // The engine owns argument normalisation; keep the local copy as a fallback.
    const eng = (window.CloudAI && window.CloudAI.tools) || null;
    if (eng && typeof eng.normalizeArgs === 'function') {
      try {
        return eng.normalizeArgs(name, args);
      } catch (e) {
        /* fall through to the local implementation */
      }
    }
    const a = (args && typeof args === 'object' && !Array.isArray(args))
      ? Object.assign({}, args)
      : {};

    // Some models nest the payload or stringify it.
    if (typeof a.arguments === 'string') {
      try {
        const parsed = JSON.parse(a.arguments);
        if (parsed && typeof parsed === 'object') Object.assign(a, parsed);
      } catch (e) {
        // truncated / invalid JSON — leave as-is
      }
      delete a.arguments;
    } else if (a.arguments && typeof a.arguments === 'object') {
      Object.assign(a, a.arguments);
    }

    const pick = (...keys) => {
      for (const k of keys) {
        if (a[k] !== undefined && a[k] !== null && a[k] !== '') return a[k];
      }
      return undefined;
    };

    const path = pick('path', 'file', 'file_path', 'filePath', 'filename', 'file_name',
      'target', 'dir', 'directory', 'folder', 'filepath');
    if (path !== undefined && a.path === undefined) a.path = path;

    const content = pick('content', 'text', 'contents', 'body', 'code', 'new_content', 'newContent');
    if (content !== undefined && a.content === undefined) a.content = content;

    const oldStr = pick('old_string', 'oldString', 'old_text', 'oldText', 'old',
      'find', 'search_for', 'searchFor', 'target_text', 'targetText', 'original');
    if (oldStr !== undefined && a.old_string === undefined) a.old_string = oldStr;

    const newStr = pick('new_string', 'newString', 'new_text', 'newText', 'new',
      'replace', 'replacement', 'replaced', 'with');
    if (newStr !== undefined && a.new_string === undefined) a.new_string = newStr;

    if (name === 'search_code') {
      const query = pick('query', 'q', 'pattern', 'needle', 'search', 'search_text', 'text_to_find');
      if (query !== undefined && a.query === undefined) a.query = query;
    }

    if (name === 'find_files') {
      const pattern = pick('pattern', 'name', 'filename', 'file_name', 'query', 'text', 'contains', 'match');
      if (pattern !== undefined && a.pattern === undefined) a.pattern = pattern;
      const glob = pick('glob', 'filter', 'extension', 'ext', 'mask');
      if (glob !== undefined && a.glob === undefined) a.glob = glob;
      const inDir = pick('in', 'dir', 'directory', 'folder', 'under');
      if (inDir !== undefined && a.path === undefined) a.path = inDir;
      const lim = pick('limit', 'max', 'max_results', 'maxResults', 'count');
      if (lim !== undefined && a.limit === undefined) a.limit = lim;
    }

    if (name === 'list_tree') {
      const depth = pick('depth', 'levels', 'max_depth', 'maxDepth', 'level');
      if (depth !== undefined && a.depth === undefined) a.depth = depth;
      const glob = pick('glob', 'filter', 'only', 'extension', 'ext');
      if (glob !== undefined && a.glob === undefined) a.glob = glob;
    }

    if (name === 'move_file' || name === 'rename_file') {
      const from = pick('from', 'source', 'src', 'source_path', 'sourcePath',
        'old_path', 'oldPath', 'old_name', 'oldName', 'path');
      if (from !== undefined && a.path === undefined) a.path = from;
      const to = pick('to', 'dest', 'destination', 'destination_path', 'destinationPath',
        'dst', 'new_path', 'newPath', 'new_name', 'newName', 'target_path', 'targetPath');
      if (to !== undefined && a.to === undefined) a.to = to;
      // a bare "target" was already folded into path by the generic picker above;
      // if the model used it as the destination, swap it over.
      if (a.to === undefined && (a.dest !== undefined || a.destination !== undefined)) {
        a.to = a.dest !== undefined ? a.dest : a.destination;
      }
      const ow = pick('overwrite', 'overwriteExisting', 'force', 'replace');
      if (ow !== undefined && a.overwrite === undefined) a.overwrite = ow;
      if (a.overwrite === undefined && a.force !== undefined) a.overwrite = a.force;
    }

    if (name === 'delete_file') {
      // `target` / `file` / `filename` are folded into path by the generic picker.
      if (a.path === undefined) {
        const p = pick('target', 'file', 'filename', 'file_name', 'dir', 'directory', 'folder');
        if (p !== undefined) a.path = p;
      }
    }

    if (name === 'delete_files') {
      // plural: paths / files / items, plus a single "path" and an optional glob
      let list = pick('paths', 'files', 'items', 'targets', 'file_list', 'fileList');
      if (typeof list === 'string') list = list.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
      if (list !== undefined) a.paths = list;
      if (a.path === undefined) {
        const p = pick('target', 'file', 'filename', 'dir', 'directory', 'folder');
        if (p !== undefined) a.path = p;
      }
      const glob = pick('glob', 'pattern', 'filter', 'extension', 'ext', 'mask');
      if (glob !== undefined && a.glob === undefined) a.glob = glob;
    }

    if (name === 'move_files') {
      let list = pick('files', 'items', 'pairs', 'moves', 'renames');
      if (typeof list === 'string') {
        list = list.split(/[;\n]/).map((s) => s.trim()).filter(Boolean)
          .map((s) => {
            const m = s.split(/\s*(?:->|=>|:)\s*/);
            return m.length >= 2 ? { from: m[0], to: m[1] } : { from: s };
          });
      }
      if (list !== undefined) a.files = list;
      const from = pick('from', 'source', 'src', 'old_path', 'oldPath');
      if (from !== undefined && a.from === undefined) a.from = from;
      const to = pick('to', 'dest', 'destination', 'destination_path', 'dst', 'new_path', 'newPath');
      if (to !== undefined && a.to === undefined) a.to = to;
      // "path" may be the glob/source; a bare "target" was folded into path above.
      if (a.path === undefined) {
        const p = pick('pattern', 'glob', 'filter');
        if (p !== undefined) a.path = p;
      }
      const ow = pick('overwrite', 'force', 'replace', 'overwriteExisting');
      if (ow !== undefined && a.overwrite === undefined) a.overwrite = ow;
    }

    if (name === 'read_files') {
      const glob = pick('glob', 'filter', 'extension', 'ext', 'pattern');
      if (glob !== undefined && a.glob === undefined) a.glob = glob;
      const lim = pick('limit', 'max', 'count', 'max_files', 'maxFiles');
      if (lim !== undefined && a.limit === undefined) a.limit = lim;
      const mc = pick('max_chars', 'maxChars', 'max_characters', 'char_budget', 'chars', 'budget');
      if (mc !== undefined && a.max_chars === undefined) a.max_chars = mc;
    }

    if (name === 'read_env') {
      const n = pick('name', 'key', 'variable', 'var');
      if (n !== undefined && a.name === undefined) a.name = n;
      const f = pick('filter', 'prefix', 'contains', 'pattern');
      if (f !== undefined && a.filter === undefined) a.filter = f;
      if (a.all === undefined && (a.dump !== undefined || a.everything !== undefined)) a.all = true;
    }

    if (name === 'remember') {
      const t = pick('text', 'fact', 'memory', 'note', 'content', 'value');
      if (t !== undefined && a.text === undefined) a.text = t;
      if (typeof a.tags === 'string') a.tags = a.tags.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    }

    if (name === 'recall') {
      const q = pick('query', 'q', 'text', 'search', 'term', 'about');
      if (q !== undefined && a.query === undefined) a.query = q;
      const lim = pick('limit', 'max', 'count', 'top');
      if (lim !== undefined && a.limit === undefined) a.limit = lim;
    }

    if (name === 'run_command') {
      const t = pick('timeout_ms', 'timeoutMs', 'timeout', 'timeout_ms_max');
      if (t !== undefined && a.timeout_ms === undefined) a.timeout_ms = t;
    }

    const command = pick('command', 'cmd', 'shell_command', 'shellCommand', 'script', 'run');
    if (command !== undefined && a.command === undefined) a.command = command;

    // stringly-typed booleans
    for (const k of ['replace_all', 'replaceAll', 'regex', 'case_sensitive', 'caseSensitive',
      'overwrite', 'include_files', 'includeFiles', 'files', 'with_files', 'all', 'everything', 'dump']) {
      if (typeof a[k] === 'string') a[k] = /^(true|yes|1)$/i.test(a[k].trim());
    }
    if (a.replace_all === undefined && a.replaceAll !== undefined) a.replace_all = a.replaceAll;

    // stringly-typed numbers
    for (const k of ['start_line', 'startLine', 'end_line', 'endLine', 'depth', 'limit',
      'max_depth', 'maxDepth', 'max_chars', 'maxChars', 'timeout_ms', 'timeoutMs', 'timeout']) {
      if (typeof a[k] === 'string' && /^\d+$/.test(a[k].trim())) a[k] = parseInt(a[k], 10);
    }
    if (a.max_chars === undefined && a.maxChars !== undefined) a.max_chars = a.maxChars;
    if (a.timeout_ms === undefined && a.timeoutMs !== undefined) a.timeout_ms = a.timeoutMs;
    if (a.start_line === undefined && a.startLine === undefined && a.lines !== undefined) {
      const r = parseLineRange(a.lines);
      if (r) {
        a.start_line = r.start;
        if (r.end !== undefined) a.end_line = r.end;
      }
    }
    return a;
  }

  /** Convert a glob ("**\/config/*.json") to a case-insensitive RegExp. */
  globToRegExp(glob) {
    const src = String(glob == null ? '' : glob).trim();
    let out = '';
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (ch === '*') {
        if (src[i + 1] === '*') {
          if (src[i + 2] === '/') { out += '(?:.*/)?'; i += 2; }
          else { out += '.*'; i += 1; }
        } else {
          out += '[^/]*';
        }
      } else if (ch === '?') {
        out += '[^/]';
      } else if ('.+^${}()|[]\\/'.indexOf(ch) !== -1) {
        out += '\\' + ch;
      } else {
        out += ch;
      }
    }
    return new RegExp('^' + out + '$', 'i');
  }

  /** Token budget for one agent turn (longer file writes need headroom). */
  maxTokens() {
    const v = window.AppSettings ? window.AppSettings.get('agentMaxTokens') : 0;
    const n = parseInt(v, 10);
    if (!isFinite(n) || n < 512) return 4096;
    return Math.min(16384, n);
  }

  diffSummary(oldText, newText) {
    const a = oldText.split('\n');
    const b = newText.split('\n');
    if (!oldText) return `+${b.length} lines`;
    if (!newText) return `-${a.length} lines`;
    // cheap approximation without full LCS: count lines only in one side
    const setA = new Set(a);
    const setB = new Set(b);
    let added = 0, removed = 0;
    for (const l of b) if (!setA.has(l)) added++;
    for (const l of a) if (!setB.has(l)) removed++;
    if (!added && !removed) return 'content reorganized (line count unchanged)';
    return `+${added} / -${removed} lines`;
  }

  /**
   * Head+tail instead of a blind head cut: the interesting part of a failing
   * command (stack trace, summary) is very often at the END.
   */
  headTail(text, headChars, tailChars) {
    const s = String(text == null ? '' : text);
    const h = headChars || 4000;
    const t = tailChars || 1500;
    if (s.length <= h + t + 80) return s;
    const dropped = s.length - h - t;
    return s.slice(0, h) +
      `\n[... ${dropped} chars omitted from the middle — re-run with output redirected to a file and read_file it if you need everything ...]\n` +
      s.slice(s.length - t);
  }

  formatCommandOutput(command, r) {
    if (!r) return `Command "${command}" returned no result.`;
    if (r.error) return `Command failed to start: ${r.error}`;
    let out = `$ ${command}\n`;
    if (r.stdout) out += this.headTail(r.stdout, 4000, 1500);
    if (r.stderr) out += (r.stdout ? '\n[stderr]\n' : '') + this.headTail(r.stderr, 2000, 1500);
    if (!r.stdout && !r.stderr) out += '(no output)\n';
    const code = r.code === undefined || r.code === null ? 'unknown' : r.code;
    if (code !== 0) {
      out += `\n[FAILED — exit code ${code}. The command did NOT succeed: fix the cause and re-run, or adapt your plan. Do not report success.]`;
    } else {
      out += `\n[exit code: 0`;
    }
    out += `${r.timedOut ? ', TIMED OUT' : ''}${r.truncated ? ', output truncated' : ''}, ${r.durationMs}ms]`;
    return out;
  }

  trunc(text, n) {
    const s = String(text == null ? '' : text);
    return s.length > n ? s.slice(0, n) + `\n[...truncated, ${s.length} chars total]` : s;
  }

  escape(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  escapeAttr(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }
}

window.AgentController = AgentController;

// Exposed for tests / tooling: schemas and pure text helpers.
window.AgentInternals = {
  AGENT_TOOLS,
  READONLY_TOOLS,
  TOOL_ICONS,
  TOOL_TITLES,
  stripAsciiDecoration,
  stripLeadingThinking,
  isDecorativeLine,
  condenseText,
  parseLineRange
};
