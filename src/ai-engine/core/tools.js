// Cloud Code AI Engine — tool registry and argument normalisation.
//
// The OpenAI function schemas are copied verbatim from src/renderer/js/agent.js
// (AGENT_TOOLS). Argument normalisation is copied verbatim from AgentController
// (normalizeArgs / parseLineRange / globToRegExp) with the only change being that
// the workspace sandbox takes the root and the allowOutside flag as parameters
// instead of reading them off `window`.
//
// No DOM, no Electron, no I/O.

(function (global) {
  'use strict';

const TOOLS = [
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

/** Tool names, in schema order — handy for prompts and error messages. */
const TOOL_NAMES = TOOLS.map((t) => t.function.name);

/**
 * Per-tool cap on the size of a result the loop feeds back to the model.
 * A huge tool output can never blow the context budget; it is clipped
 * (with a marker) before it enters the transcript.
 */
const MAX_RESULT_BYTES = {
  list_dir: 16 * 1024,
  read_file: 64 * 1024,
  list_tree: 32 * 1024,
  find_files: 32 * 1024,
  search_code: 32 * 1024,
  edit_file: 8 * 1024,
  write_file: 8 * 1024,
  delete_file: 4 * 1024,
  move_file: 4 * 1024,
  run_command: 32 * 1024,
  read_files: 64 * 1024,
  delete_files: 8 * 1024,
  move_files: 8 * 1024,
  read_env: 16 * 1024,
  remember: 4 * 1024,
  recall: 16 * 1024
};

// Also hang the limit on each schema so a host can read it off the tool.
for (const t of TOOLS) {
  const n = t.function && t.function.name;
  if (n && MAX_RESULT_BYTES[n] !== undefined) t.function.maxResultBytes = MAX_RESULT_BYTES[n];
}

/** Byte length that works in Node and in the browser (no deps). */
function byteLength(s) {
  try {
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(s).length;
  } catch (e) { /* fall through */ }
  try {
    // classic UTF-8 byte-length trick
    return unescape(encodeURIComponent(s)).length;
  } catch (e2) {
    return String(s).length;
  }
}

/**
 * truncateResult(toolName, result)
 * Clip a tool output to the tool's maxResultBytes budget. Always returns a
 * string; adds a marker naming how much was dropped. Unknown tools fall
 * back to 32 KB.
 */
function truncateResult(toolName, result) {
  const s = result == null ? '' : String(result);
  const max = MAX_RESULT_BYTES[toolName] !== undefined ? MAX_RESULT_BYTES[toolName] : 32 * 1024;
  if (byteLength(s) <= max) return s;
  let cut = s.slice(0, max);
  // Multi-byte characters can push the estimate over the limit — shrink.
  let guard = 0;
  while (byteLength(cut) > max && cut.length > 0 && guard++ < 12) {
    cut = cut.slice(0, Math.floor(cut.length * 0.85));
  }
  const omitted = byteLength(s) - byteLength(cut);
  return cut + '\n…(truncated — ' + omitted + ' bytes omitted)';
}

/** Tools that never mutate the workspace, so they never need the approval gate. */
const READONLY_TOOLS = new Set([
  'list_dir', 'list_tree', 'find_files', 'read_file', 'read_files', 'search_code', 'read_env', 'recall'
]);

const TOOL_ICONS = {
  list_dir: '📁', read_file: '📖', search_code: '🔎',
  edit_file: '✏️', write_file: '📝', run_command: '🖥️',
  delete_file: '🗑️', move_file: '📦', list_tree: '🌲', find_files: '🧭',
  read_files: '📚', delete_files: '🧹', move_files: '📦',
  read_env: '🌱', remember: '🧠', recall: '🧠'
};
const TOOL_TITLES = {
  list_dir: 'List directory', read_file: 'Read file', search_code: 'Search code',
  edit_file: 'Edit file', write_file: 'Write file', run_command: 'Run command',
  delete_file: 'Delete file or folder', move_file: 'Move / rename',
  list_tree: 'List project tree', find_files: 'Find files',
  read_files: 'Read many files', delete_files: 'Delete files', move_files: 'Move / rename files',
  read_env: 'Read environment', remember: 'Remember', recall: 'Recall'
};

/**
 * Directories that are never worth showing or searching: dependencies, VCS
 * metadata and build output (so exploring never drowns in generated copies).
 */
const NOISE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'release', 'out', 'coverage',
  '.next', '.nuxt', '.cache', '.venv', 'venv', '__pycache__', 'target',
  '.idea', '.gradle', '.pytest_cache', 'vendor', 'out-tsc'
]);

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
    const m = v.match(/(\d+)\s*(?:[-\u2013:]|to)\s*(\d+)/i);
    if (m) return { start: Math.max(1, parseInt(m[1], 10)), end: parseInt(m[2], 10) };
    const n = parseInt(v.trim(), 10);
    if (isFinite(n)) return { start: Math.max(1, n), end: undefined };
  }
  return null;
}

/**
 * Small local models are loose with argument names (path vs file vs filename,
 * content vs text, ...) and sometimes emit JSON that got truncated. Normalise
 * the common aliases + coerce stringly-typed booleans/numbers so a tool call
 * is never lost over a cosmetic mismatch.
 */
function normalizeArgs(name, args) {
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

/** Convert a glob (e.g. "**\/config/*.json") to a case-insensitive RegExp. */
function globToRegExp(glob) {
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

/**
 * resolvePath(p, { root, allowOutside })
 * The workspace sandbox: relative paths resolve against `root`; ".." escapes and
 * absolute paths outside the root are rejected unless allowOutside is true.
 * Normalised to forward slashes, drive letters preserved. Throws on violation —
 * callers turn that into a tool error the model can recover from.
 */
function resolvePath(p, opts) {
  const o = opts || {};
  const rootRaw = o.root;
  if (!rootRaw) throw new Error('No workspace folder is open.');
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
  const allowOutside = !!o.allowOutside;
  if (!inWorkspace && !allowOutside) {
    throw new Error(
      `Path is outside the workspace: ${p}\n` +
      'All paths must be relative to the workspace root. To work on files outside ' +
      'it, the user can enable "Allow agent outside workspace" in Settings.'
    );
  }
  return out;
}

/** Find a schema by tool name. */
function getTool(name) {
  return TOOLS.find((t) => t.function.name === name) || null;
}

const api = {
  TOOLS,
  TOOL_NAMES,
  TOOL_ICONS,
  TOOL_TITLES,
  READONLY_TOOLS,
  NOISE_DIRS,
  MAX_RESULT_BYTES,
  truncateResult,
  normalizeArgs,
  parseLineRange,
  globToRegExp,
  resolvePath,
  getTool
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
global.CloudAI = Object.assign(global.CloudAI || {}, { tools: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);
