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
          command: { type: 'string', description: 'The command line to execute (e.g. "npm test", "dir", "python app.py").' }
        },
        required: ['command']
      }
    }
  }
];

const READONLY_TOOLS = new Set(['list_dir', 'read_file', 'search_code']);
const TOOL_ICONS = {
  list_dir: '📁', read_file: '📖', search_code: '🔎',
  edit_file: '✏️', write_file: '📝', run_command: '🖥️',
  delete_file: '🗑️', move_file: '📦'
};
const TOOL_TITLES = {
  list_dir: 'List directory', read_file: 'Read file', search_code: 'Search code',
  edit_file: 'Edit file', write_file: 'Write file', run_command: 'Run command',
  delete_file: 'Delete file or folder', move_file: 'Move / rename'
};

/** Characters that only ever appear in decorative ASCII art, never in prose. */
const BOX_CHARS = /[\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2B00-\u2BFF\u2190-\u21FF]/;
/** A line made exclusively of ASCII graphic/punctuation characters. */
const ASCII_ART_LINE = /^[!-/:-@[-`{-~]{4,}$/;

/**
 * stripAsciiDecoration(text)
 * Removes decorative-only lines (box drawing, ──────, ======, ~~~~, ASCII
 * graph bars/boxes) from model prose and collapses runs of blank lines to one.
 * Applied ONLY to agent-authored summary/notice text — never to tool output or
 * file contents, which may legitimately contain such characters.
 */
function stripAsciiDecoration(text) {
  if (typeof text !== 'string' || !text) return '';
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim();
    // markdown table rows (and their `|---|---|` separators) are legitimate
    const isTableRow = t.indexOf('|') !== -1;
    if (t && !isTableRow && (BOX_CHARS.test(t) || ASCII_ART_LINE.test(t))) continue;
    out.push(raw.replace(/\s+$/, ''));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
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
      if (e.key === 'Escape') this.hideChangesPopup();
    });
  }

  setVisible(visible) {
    const bar = document.getElementById('agent-run-bar');
    if (bar) bar.classList.toggle('hidden', !visible);
  }

  setStatus(text) {
    const el = document.getElementById('agent-run-status');
    if (el) el.textContent = text || '';
  }

  setRunning(running) {
    this.running = running;
    const stopBtn = document.getElementById('agent-stop-btn');
    if (stopBtn) stopBtn.classList.toggle('hidden', !running);
    const statusItem = document.getElementById('statusbar-agent-steps');
    if (statusItem) statusItem.classList.toggle('hidden', !running);
    if (!running) this.setStatus('');
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
      this.pushAssistant('⚠ Agent error: ' + (err && err.message ? err.message : String(err)));
    } finally {
      this.setRunning(false);
      if (ai) ai.setSendButtonState(false);
    }
  }

  requestStop() {
    if (!this.running) return;
    this.cancelRequested = true;
    this.setStatus('Stopping…');
    // cancel any in-flight completion
    if (window.electronAPI && window.electronAPI.aiCancelOnce) {
      window.electronAPI.aiCancelOnce('agent-' + this.reqSeq);
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
    let thinkLine;
    switch (thinkLevel) {
      case 'off': thinkLine = 'Reasoning effort: OFF — go straight to the answer, minimal exploration.'; break;
      case 'low': thinkLine = 'Reasoning effort: LOW — act directly and efficiently, avoid unnecessary exploration.'; break;
      case 'high': thinkLine = 'Reasoning effort: HIGH — plan carefully, verify your work with tools before answering, and consider edge cases.'; break;
      default: thinkLine = 'Reasoning effort: MEDIUM — brief deliberation, then act.';
    }
    const allowOutside = !!(window.AppSettings && window.AppSettings.get('agentAllowOutsideWorkspace'));
    const outsideNote = allowOutside
      ? '- Outside-workspace access is ENABLED: absolute paths are accepted, but prefer workspace-relative paths.'
      : '- Access is limited to this workspace: absolute paths and "../" escapes are rejected.';
    return `You are Cloud Code Agent, an expert software engineer working inside the user's IDE on the user's own machine.

## ENVIRONMENT
- Workspace root: ${root}
- Today's date: ${today}
- Platform: Windows. run_command executes PowerShell in the workspace root.
- ${outsideNote}
- Every path you pass to a tool is RELATIVE to the workspace root, e.g. "src/main.js"; use "." for the root.

## YOUR JOB
Deliver the ENTIRE requested feature, end to end, in this single turn — working, runnable code saved to disk and verified with tools. You can only learn about this project through your tools; never assume what a file contains.

## TOOLS (use these exact names and argument names)
1. list_dir   {"path":"<dir>"} — list a folder ("." = workspace root).
2. read_file  {"path":"<file>"} — whole file; add {"start_line":10,"end_line":60} for large files.
3. search_code {"query":"<text>"} — search the workspace; optional {"glob":"*.js"}, {"regex":true}.
4. edit_file  {"path":"<file>","old_string":"<exact text that exists>","new_string":"<replacement>","replace_all":false}
5. write_file {"path":"<file>","content":"<the complete file content>"} — create or deliberately overwrite.
6. delete_file {"path":"<file or empty folder>"} — deletes a file, or a folder ONLY when empty.
7. move_file  {"path":"<from>","to":"<to>","overwrite":false} — rename/move; dest folders auto-created.
8. run_command {"command":"<powershell command>"} — run in the workspace root.

## COMPLETENESS RULES (violating these is a failure)
- Implement the WHOLE request in one turn. No placeholders, no "// ...rest of implementation", no TODO, no empty or stubbed function bodies, no "you can extend this further", no "apply the same change elsewhere".
- If the request implies N files, change all N. Do not stop after the first one.
- Read a SIBLING file of the same kind first and imitate it: import style, module system, naming, error handling, logging, formatting, comment density.
- Handle the errors and edge cases the real code must survive (missing file, empty input, async failure) in the same style as the surrounding code.
- Everything you write must run as-is. Never depend on code you did not write or did not verify.
- Reuse the project's existing utilities; never add a dependency unless the user asked.

## WORKFLOW
1. ORIENT  — list_dir, then read_file the target and at least one sibling.
2. PLAN    — decide the full set of changes before acting.
3. ACT     — write_file / edit_file file by file, one tool call per turn.
4. VERIFY  — read_file the result back, and run the project's build/test/lint via run_command when one exists (check package.json). Fix any failure, then re-verify.
5. REPORT  — stop calling tools and summarise what changed and how it was verified.

## EDITING SAFELY
- write_file must contain the FULL content; missing folders are created automatically. Never create files with run_command redirection.
- old_string must match the file EXACTLY (whitespace + indentation) and be unique — include 2-3 surrounding lines when the text repeats, otherwise set replace_all.
- delete_file refuses non-empty folders: delete the children first.
- PowerShell: Get-ChildItem, Select-String, npm test, git status, git diff. Commands already start in the workspace root — never cd first.
- Never run destructive commands (del /s, Remove-Item -Recurse, git reset --hard, git clean) unless explicitly asked.

## OUTPUT STYLE
- Never draw ASCII art, box-drawing characters, progress bars, graphs, or decorative separator lines ("---", "===", "~~~", "────"). Use plain prose and markdown lists instead.
- Wrap code in fenced code blocks ONLY when you are actually showing code.
- Be concise: report what changed, where, and how it was verified.

## RULES
- Every mutating action is approved by the user. A rejection is final: do not repeat it — adapt or ask.
- Read tool results, including errors; never repeat a failing call unchanged.
- Never claim something works unless a tool verified it.
- Do not create README/notes/summary files unless asked.

${thinkLine}

## WHEN THE TASK IS DONE
Reply with a short prose summary: which files changed and why, plus any commands you ran.

If native function calling is unavailable in your responses, output ONLY this block, then wait for the result:
<<<TOOL>>>
{"name":"tool_name","args":{"path":"src/main.js"}}
<<<END>>>

Respond in the user's language, but keep code, paths and identifiers exactly as written.`;
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

      const thinking = this.pushThinking();
      let res = null;
      try {
        res = await window.electronAPI.aiChatOnce({
          id: 'agent-' + (++this.reqSeq),
          model,
          messages: this.messages,
          tools: this.useNativeTools ? AGENT_TOOLS : undefined,
          temperature: 0.2,
          maxTokens: this.maxTokens()
        });
      } catch (err) {
        res = { error: err && err.message ? err.message : String(err) };
      } finally {
        this.removeNode(thinking);
      }

      if (this.cancelRequested) break;
      if (!res) break;
      if (res.error) {
        if (/cancel|destroy|socket|ECONNRESET|timed out/i.test(res.error) && this.cancelRequested) break;
        this.pushAssistant(`⚠ **Agent request failed:** ${res.error}`);
        break;
      }
      if (res.toolsRejected && this.useNativeTools) {
        this.useNativeTools = false;
        this.pushNotice('ℹ The model endpoint does not support native tool calling — switched to the built-in text tool protocol.');
      }

      let content = (res.content || '').trim();
      const toolCalls = res.toolCalls || [];

      // If the model used native tool calls AND left a text-protocol block
      // behind, strip the block so it never pollutes the transcript.
      if (toolCalls.length && res.usedNativeTools && content.includes('<<<TOOL>>>')) {
        content = content.replace(/<<<TOOL>>>[\s\S]*?<<<END>>>/g, '').trim();
      }

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

    if (this.cancelRequested) {
      this.pushNotice('⏹ Agent stopped.');
      this.cancelRequested = false;
    }
    if (!finalSummary) {
      this.emitThinking('done', this.cancelRequested ? 'Stopped by the user' : 'Finished', this.step);
    }
  }

  /**
   * Realtime progress signal for the chat panel.
   * Event: window 'agent:thinking'
   * detail: { text: string (<=140 chars, plain text), phase: 'planning'|'thinking'|'tool'|'done', step: number }
   * Never throws, even if dispatchEvent / CustomEvent are unavailable.
   */
  emitThinking(phase, text, step) {
    try {
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
        card.setState('done', out);
        this.emitThinking('tool', `${title} finished`, this.step);
        return this.trunc(out, 6000);
      }

      // Mutating actions go through the autonomy gate
      card.setState('awaiting');
      this.emitThinking('tool', `Waiting for approval: ${title} ${condenseText(this.planTarget(plan, args), 80)}`, this.step);
      const approved = await this.requestPermission(card, plan);
      if (!approved) {
        card.setState('rejected');
        this.emitThinking('tool', `${title} rejected by the user`, this.step);
        return 'The user rejected this action. Do not repeat it — adapt your approach or ask the user what they would prefer.';
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
          timeoutMs: 60000
        });
        const out = this.formatCommandOutput(plan.command, r);
        card.setState(r && r.code === 0 ? 'done' : 'error', out);
        return this.trunc(out, 6000);
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
              if (full.length > 80000) {
                out = full.slice(0, 80000) +
                  `\n[...truncated: file is ${full.length} chars. Use start_line/end_line to read the rest.]`;
              } else {
                out = full;
              }
            }
            return out;
          }
        };
      }
      case 'search_code': {
        const query = String(args.query || '');
        if (!query) throw new Error('search_code requires a query.');
        const root = window.explorer.rootPath;
        return {
          kind: 'read',
          run: async () => {
            const res = await window.electronAPI.searchInFiles(root, query, {
              glob: args.glob || undefined,
              regex: !!args.regex,
              caseSensitive: !!args.case_sensitive,
              maxResults: 60,
              maxPerFile: 10
            });
            if (res && res.error) throw new Error(res.error);
            if (!res || !res.length) return `No matches for "${query}"${args.glob ? ' in ' + args.glob : ''}.`;
            const lines = res.map((r) => `${r.relPath}:${r.line}: ${r.text}`);
            const more = res.length >= 60 ? '\n[results capped at 60]' : '';
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
        return { kind: 'command', command };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  // --- Approval gate -------------------------------------------------------
  requestPermission(card, plan) {
    const mode = window.AppSettings ? window.AppSettings.get('agentMode') : 'ask';
    const category = plan.kind === 'command' ? 'command' : 'edit';

    if (this.sessionAllow.has(category)) return Promise.resolve(true);
    if (mode === 'full-auto') return Promise.resolve(true);
    if (mode === 'edit-auto' && category === 'edit') return Promise.resolve(true);

    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok, allowAll) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (allowAll) this.sessionAllow.add(category);
        card.closeDiff();
        resolve(ok);
      };

      // Auto-open the diff proposal for file edits (VS Code / Cursor style)
      if (plan.kind === 'edit') {
        card.openDiff(plan, (ok) => finish(ok, false));
      }

      const approvedLabel = plan.kind === 'command' ? '▶ Run' : '✓ Approve';
      card.showActions([
        { label: approvedLabel, cls: 'approve', onClick: () => finish(true, false) },
        { label: '✕ Reject', cls: 'reject', onClick: () => finish(false, false) },
        { label: 'Allow all in this session', cls: 'allow', onClick: () => finish(true, true) }
      ]);

      const timer = setTimeout(() => finish(false, false), 5 * 60 * 1000); // 5 min
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
    if (!plan.isDir) {
      const original = plan.original !== undefined && plan.original !== null
        ? plan.original
        : (await window.electronAPI.readFile(plan.path).catch(() => ''));
      const r = await window.electronAPI.deletePath(plan.path);
      if (r && r.error) throw new Error(`delete_file failed: ${r.error}`);
      // tracked with updated === null so "revert" restores the file
      this.trackChange(plan.path, original, null);
    } else {
      const r = await window.electronAPI.deletePath(plan.path);
      if (r && r.error) throw new Error(`delete_file failed: ${r.error}`);
      this.changes.delete(plan.path);
    }
    this.closeTabFor(plan.path);
    this.refreshIndexes();
    return plan.summary;
  }

  // --- Apply an approved move / rename --------------------------------------
  async applyMove(plan) {
    const lastSlash = Math.max(plan.to.lastIndexOf('/'), plan.to.lastIndexOf('\\'));
    if (lastSlash > 0) {
      await window.electronAPI.createDirectory(plan.to.slice(0, lastSlash)).catch(() => {});
    }
    if (plan.overwrite) await window.electronAPI.deletePath(plan.to).catch(() => {});

    let res = await window.electronAPI.renamePath(plan.path, plan.to).catch((e) => ({ error: e && e.message ? e.message : String(e) }));
    if (!res || res.error) {
      // Fallback for cross-volume moves the OS cannot rename directly.
      if (!plan.isDir) {
        const content = await window.electronAPI.readFile(plan.path);
        await window.electronAPI.writeFile(plan.to, content);
        await window.electronAPI.deletePath(plan.path).catch(() => {});
        res = { ok: true };
      } else {
        throw new Error(`move_file failed: ${(res && res.error) || 'unknown error'}`);
      }
    }

    const previous = this.changes.get(plan.path);
    if (previous) this.changes.delete(plan.path);
    if (!plan.isDir) {
      // tracked with original === null so "revert" removes the moved-in file
      this.trackChange(plan.to, null, previous ? previous.updated : '');
    } else {
      this.renderChangesBadge();
      this.renderChangesList();
    }
    this.closeTabFor(plan.path);
    this.refreshIndexes();
    return plan.summary;
  }

  closeTabFor(path) {
    try {
      const em = window.editor;
      if (em && em.tabs && em.tabs.has && em.tabs.has(path)) em.closeByKey ? em.closeByKey(path) : null;
    } catch (e) { /* tab bookkeeping is best-effort */ }
  }

  /** Short one-line description of what a prepared tool call will do. */
  planTarget(plan, args) {
    if (plan && plan.relPath) {
      return plan.kind === 'move' ? `${plan.fromRel} -> ${plan.toRel}` : plan.relPath;
    }
    if (plan && plan.path) return plan.path;
    if (plan && plan.command) return plan.command;
    return (args && (args.path || args.query || args.command)) || '';
  }

  humanSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  trackChange(path, original, updated) {
    this.changes.set(path, { path, original, updated, time: Date.now() });
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
      await window.electronAPI.deletePath(path);
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

    const target = (args.path && args.to ? `${args.path} → ${args.to}` : null)
      || args.path || args.command || args.query || '';
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
      setState(state, text) {
        node.dataset.state = state;
        const labels = {
          pending: '…', running: 'working…', done: '✓ done',
          deleted: '🗑 deleted', moved: '📦 moved',
          error: '✗ error', rejected: '✕ rejected', awaiting: 'awaiting approval'
        };
        badge.textContent = labels[state] || state;
        if (text) {
          detail.classList.remove('hidden');
          detail.innerHTML = '';
          const pre = document.createElement('pre');
          pre.className = 'tool-output';
          const s = String(text);
          pre.textContent = s.length > 700 ? s.slice(0, 700) + '\n[…]' : s;
          detail.appendChild(pre);
          if (window.ai) window.ai.scrollToBottom();
        }
        if (state === 'done' || state === 'deleted' || state === 'moved' || state === 'error' || state === 'rejected') {
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
    const el = document.createElement('div');
    el.className = 'chat-msg assistant';
    el.innerHTML = `
      <div class="sender-title">🤖 Cloud Code Agent</div>
      <div class="msg-body"></div>
    `;
    const body = el.querySelector('.msg-body');
    if (ai) {
      body.innerHTML = ai.renderMarkdown(markdown);
      ai.wireCodeButtons(body);
    } else {
      body.textContent = markdown;
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
    return el;
  }

  removeNode(el) {
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

    const command = pick('command', 'cmd', 'shell_command', 'shellCommand', 'script', 'run');
    if (command !== undefined && a.command === undefined) a.command = command;

    // stringly-typed booleans
    for (const k of ['replace_all', 'replaceAll', 'regex', 'case_sensitive', 'caseSensitive', 'overwrite']) {
      if (typeof a[k] === 'string') a[k] = /^(true|yes|1)$/i.test(a[k].trim());
    }
    if (a.replace_all === undefined && a.replaceAll !== undefined) a.replace_all = a.replaceAll;

    // stringly-typed line numbers
    for (const k of ['start_line', 'startLine', 'end_line', 'endLine']) {
      if (typeof a[k] === 'string' && /^\d+$/.test(a[k].trim())) a[k] = parseInt(a[k], 10);
    }
    if (a.start_line === undefined && a.startLine === undefined && a.lines !== undefined) {
      const r = parseLineRange(a.lines);
      if (r) {
        a.start_line = r.start;
        if (r.end !== undefined) a.end_line = r.end;
      }
    }
    return a;
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

  formatCommandOutput(command, r) {
    if (!r) return `Command "${command}" returned no result.`;
    if (r.error) return `Command failed to start: ${r.error}`;
    let out = `$ ${command}\n`;
    if (r.stdout) out += r.stdout;
    if (r.stderr) out += (r.stdout ? '\n[stderr]\n' : '') + r.stderr;
    if (!r.stdout && !r.stderr) out += '(no output)\n';
    out += `\n[exit code: ${r.code}${r.timedOut ? ', TIMED OUT after 60s' : ''}${r.truncated ? ', output truncated' : ''}, ${r.durationMs}ms]`;
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
  condenseText,
  parseLineRange
};
