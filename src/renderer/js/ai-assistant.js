// AI Assistant Panel — streaming chat, Chat/Agent mode routing,
// @-mention file context, quick prompts & code actions
//
// Also owns the live agent "thinking" panel (namespace: think-*), which
// renders `agent:thinking` events from agent.js as a compact, collapsible
// block at the top of the message stream.

const THINK_MAX_LINES = 30;
const THINK_PHASES = ['planning', 'thinking', 'tool'];

// Chat box tuning: the textarea grows to ~8 lines and then scrolls.
const CHAT_MAX_INPUT_LINES = 8;
const CHAT_INPUT_LINE_FALLBACK = 18;   // px, when the UA gives us no line-height
// How close to the bottom counts as "the user is following along" (px).
const CHAT_STICK_GAP = 64;

// Empty-state capabilities. Each one is a clickable starter prompt.
const CHAT_STARTERS = [
  { icon: '📄', label: 'Create files', text: 'Create a new file src/utils/debounce.js with a small debounce helper and JSDoc comments for each parameter.' },
  { icon: '✏️', label: 'Edit code', text: 'Refactor the active file for clarity — shorter functions, clearer names — and show me what you changed.' },
  { icon: '🗑️', label: 'Delete or move files', text: 'Scan the project for unused or duplicated files and propose which ones to delete or move, and where to.' },
  { icon: '🔍', label: 'Search the project', text: 'Search the project for TODO and FIXME comments and summarise what each one asks for.' },
  { icon: '▶️', label: 'Run commands', text: 'List the project root, then run the test suite and summarise any failures.' }
];

class AIAssistant {
  constructor(messagesId, inputId, sendBtnId) {
    this.messagesContainer = document.getElementById(messagesId);
    this.input = document.getElementById(inputId);
    this.sendBtn = document.getElementById(sendBtnId);
    this.modelSelect = document.getElementById('model-select');
    this.clearBtn = document.getElementById('clear-chat-btn');
    this.modeChatBtn = document.getElementById('mode-chat-btn');
    this.modeAgentBtn = document.getElementById('mode-agent-btn');
    this.mentionPopup = document.getElementById('mention-popup');

    this.mode = 'chat';
    this.history = [];
    this.isStreaming = false;
    this.currentResponseNode = null;
    this.currentResponseText = '';

    // Chat box chrome (created in init())
    this.footerEl = this.input && this.input.closest ? this.input.closest('.chat-footer') : null;
    this.inputBox = this.input && this.input.closest ? this.input.closest('.input-box-wrapper') : null;
    this.hintEl = null;
    this.busyEl = null;
    this.busy = false;
    // Scroll stickiness: true while the user is reading the tail.
    this._stick = true;

    // @mention popup state
    this.mentionItems = [];
    this.mentionIdx = 0;
    this.mentionVisible = false;
    this.lastAttachments = [];

    // Live agent thinking panel (see AgentThinkingPanel below)
    this.thinkPanel = new AgentThinkingPanel(this.messagesContainer, this);

    this.init();
  }

  init() {
    this.sendBtn.onclick = () => this.handleSend();
    this.input.addEventListener('keydown', (e) => this.onInputKeydown(e));

    // Chat / Agent mode toggle
    if (this.modeChatBtn) this.modeChatBtn.onclick = () => this.setMode('chat');
    if (this.modeAgentBtn) this.modeAgentBtn.onclick = () => this.setMode('agent');

    // Auto-growing textarea (caps at CHAT_MAX_INPUT_LINES, then scrolls).
    this.buildFooterChrome();
    this.input.addEventListener('input', () => {
      this.autoGrowInput();
      this.updateMentions();
    });
    this.input.addEventListener('blur', () => setTimeout(() => this.hideMentions(), 150));
    this.input.addEventListener('click', () => this.updateMentions());

    // Scroll stickiness: track whether the user is following the tail.
    if (this.messagesContainer && this.messagesContainer.addEventListener) {
      this.messagesContainer.addEventListener('scroll', () => {
        this._stick = this.isNearBottom();
      }, { passive: true });
    }

    if (this.clearBtn) {
      this.clearBtn.onclick = () => {
        this.history = [];
        this.messagesContainer.innerHTML = '';
        this.thinkPanel.destroy();
        if (window.agent && window.agent.reset) window.agent.reset(true);
        this.renderWelcome();
      };
    }

    // Quick prompt buttons
    document.querySelectorAll('.quick-prompt-btn').forEach(btn => {
      btn.onclick = () => {
        this.sendPromptWithContext(btn.dataset.prompt);
      };
    });

    // NOTE: the model list is owned by chat-controls.js (custom `dd-*`
    // dropdowns). `#model-select` is kept in the DOM as a hidden proxy whose
    // `.value` is authoritative and kept in sync by chat-controls; we only
    // read it below at request time.
    if (window.electronAPI && typeof window.electronAPI.listAiModels === 'function' && this.modelSelect) {
      // Mirror the remote list into the proxy when chat-controls is absent
      // (e.g. a bare index.html preview) so sendChat still has a value.
      window.electronAPI.listAiModels().then(models => {
        if (!models || !models.length || !this.modelSelect) return;
        if (this.modelSelect.options && this.modelSelect.options.length > 1) return;
        const current = this.modelSelect.value;
        this.modelSelect.textContent = '';
        models.forEach(m => {
          const opt = document.createElement('option');
          opt.value = m;
          opt.textContent = m;
          this.modelSelect.appendChild(opt);
        });
        if (current) this.modelSelect.value = current;
      }).catch(() => {});
    }

    // Live agent reasoning stream → thinking panel
    window.addEventListener('agent:thinking', (e) => this.onAgentThinking(e));

    // "Think: Off" must apply *immediately*, without a reload: the control bar
    // broadcasts chat:think-changed, the settings modal broadcasts
    // settings-changed. Either way the panel goes away at once.
    window.addEventListener('chat:think-changed', () => this.syncThinkingLevel());
    document.addEventListener('settings-changed', () => this.syncThinkingLevel());

    // Clear the thinking panel when the agent itself resets (stop, new run).
    if (window.agent && window.agent.reset) {
      const agent = window.agent;
      const originalReset = agent.reset.bind(agent);
      agent.reset = (silent) => {
        this.thinkPanel.destroy();
        return originalReset(silent);
      };
    }

    // IPC Streaming Listeners (chat mode)
    if (window.electronAPI) {
      window.electronAPI.onAiChunk((chunk) => {
        if (!this.currentResponseNode) return;
        this.currentResponseText += chunk;
        this.updateResponseDisplay(this.currentResponseNode, this.currentResponseText);
        this.scrollToBottom();
      });

      window.electronAPI.onAiEnd(() => {
        this.isStreaming = false;
        this.setSendButtonState(false);
        if (this.currentResponseNode) {
          this.finalizeResponseDisplay(this.currentResponseNode, this.currentResponseText);
          this.history.push({ role: 'assistant', content: this.currentResponseText });
        }
        this.currentResponseNode = null;
        this.currentResponseText = '';
      });

      window.electronAPI.onAiError((err) => {
        this.isStreaming = false;
        this.setSendButtonState(false);
        if (this.currentResponseNode) {
          this.markError(this.currentResponseNode, err);
        }
        this.currentResponseNode = null;
        this.currentResponseText = '';
      });
    }

    // Hover actions (copy / regenerate) are delegated so they survive the
    // streaming re-render of a message body.
    if (this.messagesContainer && this.messagesContainer.addEventListener) {
      this.messagesContainer.addEventListener('click', (e) => this.onMessageClick(e));
    }

    // Keep the relative timestamps ("just now" → "3m ago") honest.
    this._msgTimeTimer = setInterval(() => this.refreshTimestamps(), 30000);

    this.setMode('chat');
    this.autoGrowInput();
    this.updateSendEnabled();
    this.setBusyState(false);
    this.renderWelcome();
  }

  // ==========================================================================
  // Chat box chrome: footer hint, busy state, auto-growing input, stick scroll
  // ==========================================================================

  // Adds the (namespaced) footer hint + busy progress line. Both are created
  // from JS so index.html stays untouched.
  buildFooterChrome() {
    const host = this.footerEl || (this.inputBox && this.inputBox.parentNode);
    if (!host || !document.createElement) return;

    if (!this.hintEl) {
      this.hintEl = document.createElement('div');
      this.hintEl.className = 'chat-hint';
      this.hintEl.textContent = 'Enter to send · Shift+Enter for a new line · @ attaches a file';
      if (this.inputBox && this.inputBox.nextSibling) {
        host.insertBefore(this.hintEl, this.inputBox.nextSibling);
      } else {
        host.appendChild(this.hintEl);
      }
    }

    if (!this.busyEl) {
      this.busyEl = document.createElement('div');
      this.busyEl.className = 'chat-busy-hint';
      this.busyEl.hidden = true;
      this.busyEl.innerHTML = '<span class="msg-spinner" aria-hidden="true"></span>'
        + '<span class="chat-busy-text"></span>';
      if (this.hintEl && this.hintEl.nextSibling) {
        host.insertBefore(this.busyEl, this.hintEl.nextSibling);
      } else {
        host.appendChild(this.busyEl);
      }
    }
  }

  // While a request is in flight: dim the input, show a progress hint and make
  // the button read unmistakably as "Stop".
  setBusyState(on, label) {
    this.busy = !!on;
    if (this.busyEl) {
      this.busyEl.hidden = !on;
      const text = this.busyEl.querySelector('.chat-busy-text');
      if (text) text.textContent = label || (this.mode === 'agent'
        ? 'Agent is working — press Stop to interrupt'
        : 'Thinking… press Stop to cancel');
    }
    if (this.inputBox && this.inputBox.classList) {
      this.inputBox.classList.toggle('chat-busy', !!on);
    }
    if (this.footerEl && this.footerEl.classList) {
      this.footerEl.classList.toggle('chat-footer-busy', !!on);
    }
    if (this.hintEl && this.hintEl.classList) {
      this.hintEl.classList.toggle('chat-hint-muted', !!on);
    }
    if (this.sendBtn && this.sendBtn.setAttribute) {
      this.sendBtn.setAttribute('aria-busy', on ? 'true' : 'false');
      this.sendBtn.classList.toggle('chat-stop', !!on);
    }
    this.updateSendEnabled();
  }

  // Send is only offered when there is something to send (and never while a
  // request is running — the button is a Stop button then).
  updateSendEnabled() {
    if (!this.sendBtn) return;
    const hasText = !!(this.input && String(this.input.value || '').trim());
    // A running agent owns the Stop button, so never disable it there.
    const agentRunning = this.mode === 'agent'
      && !!(window.agent && window.agent.running);
    this.sendBtn.disabled = !!(this.busy && !agentRunning) || (!hasText && !agentRunning);
  }

  _inputLineHeight() {
    let lh = 0;
    try {
      if (window.getComputedStyle) {
        lh = parseFloat(window.getComputedStyle(this.input).lineHeight);
      }
    } catch (e) { /* fall back */ }
    return (lh && isFinite(lh) && lh > 0) ? lh : CHAT_INPUT_LINE_FALLBACK;
  }

  _inputPadding() {
    let pad = 0;
    try {
      if (window.getComputedStyle) {
        const cs = window.getComputedStyle(this.input);
        pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
      }
    } catch (e) { /* ignore */ }
    return pad || 6;
  }

  // Height ceiling for the auto-growing textarea: ~8 lines.
  inputMaxHeight() {
    return Math.round(this._inputLineHeight() * CHAT_MAX_INPUT_LINES + this._inputPadding());
  }

  // Grow with the content up to the cap, then scroll internally. Also called
  // after a send so the box shrinks back.
  autoGrowInput() {
    const el = this.input;
    if (!el) return { height: 0, max: 0 };
    const lh = this._inputLineHeight();
    const pad = this._inputPadding();
    const max = Math.round(lh * CHAT_MAX_INPUT_LINES + pad);
    const lines = Math.max(1, String(el.value == null ? '' : el.value).split('\n').length);
    // `scrollHeight` is authoritative in a real layout; the line estimate keeps
    // the behaviour sane (and testable) where layout metrics are unavailable.
    const wanted = Math.max(el.scrollHeight || 0, Math.round(lines * lh + pad));
    const height = Math.min(wanted, max);
    el.style.height = height + 'px';
    el.style.overflowY = wanted > max ? 'auto' : 'hidden';
    if (el.classList) el.classList.toggle('chat-input-full', wanted > max);
    return { height, max, wanted, capped: wanted > max };
  }

  // True when the transcript is scrolled to (or near) the bottom.
  isNearBottom(gap) {
    const c = this.messagesContainer;
    if (!c) return true;
    const g = gap == null ? CHAT_STICK_GAP : gap;
    return (c.scrollHeight - c.scrollTop - c.clientHeight) <= g;
  }

  // Sticks to the bottom only if the user is already there; pass `force` to
  // override (never used automatically — history reading is never yanked).
  scrollToBottom(force) {
    const c = this.messagesContainer;
    if (!c) return false;
    const stick = force === true || (this._stick !== false && this.isNearBottom());
    if (!stick) return false;
    c.scrollTop = c.scrollHeight;
    return true;
  }

  // ==========================================================================
  // Chat / Agent mode
  // ==========================================================================
  setMode(mode) {
    this.mode = mode === 'agent' ? 'agent' : 'chat';
    if (this.modeChatBtn) this.modeChatBtn.classList.toggle('active', this.mode === 'chat');
    if (this.modeAgentBtn) this.modeAgentBtn.classList.toggle('active', this.mode === 'agent');
    if (window.agent && window.agent.setVisible) window.agent.setVisible(this.mode === 'agent');
    // A mode switch means a different runner owns the transcript — drop the
    // thinking panel rather than leaving stale reasoning on screen.
    if (this.thinkPanel) this.thinkPanel.destroy();
    if (this.input) {
      this.input.placeholder = this.mode === 'agent'
        ? 'Describe a task for the agent… (@ attaches files)'
        : 'Ask AI about your project… (@ attaches files)';
    }
    // Let the chat control bar mirror the mode (it also dispatches back).
    try {
      window.dispatchEvent(new CustomEvent('chat:mode-set', { detail: { mode: this.mode } }));
    } catch (e) {
      // CustomEvent unavailable (plain-browser preview)
    }
    this.syncBusyFromAgent();
    this.updateSendEnabled();
  }

  // ==========================================================================
  // Live agent thinking (agent:thinking from agent.js)
  // ==========================================================================
  onAgentThinking(e) {
    const d = (e && e.detail) || {};
    const phase = d.phase;

    // Any agent progress doubles as the "a request is in flight" signal.
    this.syncBusyFromAgent();

    // Re-checked on EVERY event (not only at boot), so switching the level
    // applies immediately without a reload. With thinking off there is no
    // panel at all — not even a hidden one waiting to be populated.
    if (!this.thinkingEnabled()) {
      if (this.thinkPanel && this.thinkPanel.isLive()) this.thinkPanel.destroy();
      return;
    }

    if (phase === 'done') {
      this.thinkPanel.finish(Number(d.step) || 0);
      return;
    }
    // Only agent runs produce reasoning; ignore stray events in chat mode.
    if (this.mode !== 'agent') return;
    this.thinkPanel.push({
      text: d.text == null ? '' : String(d.text),
      phase: THINK_PHASES.indexOf(phase) === -1 ? 'thinking' : phase,
      step: Number(d.step) || 0
    });
  }

  // Current reasoning level (read live from settings, never cached).
  thinkLevel() {
    try {
      const v = window.AppSettings ? window.AppSettings.get('thinkLevel') : null;
      return v == null ? 'medium' : String(v);
    } catch (e) {
      return 'medium';
    }
  }

  thinkingEnabled() {
    return this.thinkLevel() !== 'off';
  }

  // Applied whenever the level changes in either place.
  syncThinkingLevel() {
    if (!this.thinkingEnabled() && this.thinkPanel && this.thinkPanel.isLive()) {
      this.thinkPanel.destroy();
    }
  }

  // Agent runs have no `onAiEnd`; mirror `window.agent.running` into the
  // in-flight state so Stop is always obvious.
  syncBusyFromAgent() {
    if (this.mode !== 'agent') return;
    const running = !!(window.agent && window.agent.running);
    if (running !== this.busy) this.setBusyState(running);
  }

  // With thinking off, never surface reasoning-style payloads
  // (`res.reasoning`, `reasoning_content`, <think>…</think> blocks).
  stripReasoning(text) {
    if (text == null || text === '') return '';
    let s = String(text);
    s = s.replace(/<\s*think(?:ing)?\s*>[\s\S]*?<\s*\/\s*think(?:ing)?\s*>/gi, '');
    // `res.reasoning:` / `"reasoning_content":` / `reasoning = …`
    s = s.replace(/(?:res(?:ponse)?\s*\.\s*)?["']?reasoning(?:_content|_text)?["']?\s*[:=]\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\n]*)/gi, '');
    // Tidy up the JSON/object holes that removal leaves behind.
    s = s.replace(/\{\s*,/g, '{').replace(/,\s*\}/g, '}').replace(/,\s*,/g, ',');
    return s;
  }

  // What is safe to display for the current reasoning level.
  displayText(text) {
    return this.thinkingEnabled() ? String(text == null ? '' : text) : this.stripReasoning(text);
  }

  // ==========================================================================
  // Keyboard: Enter sends, Shift+Enter newline, arrows navigate @mentions
  // ==========================================================================
  onInputKeydown(e) {
    if (this.mentionVisible) {
      if (e.key === 'ArrowDown') {
        e.preventDefault(); e.stopPropagation();
        this.moveMention(1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation();
        this.moveMention(-1);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault(); e.stopPropagation();
        this.acceptMention();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation();
        this.hideMentions();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.handleSend();
    }
  }

  // ==========================================================================
  // Sending
  // ==========================================================================
  handleSend() {
    if (this.mode === 'agent') {
      if (window.agent && window.agent.running) {
        this.setBusyState(false);
        window.agent.requestStop();
        return;
      }
      const text = this.input.value.trim();
      if (!text) return;
      this.input.value = '';
      this.afterSend();
      this.dispatch(text);
      return;
    }

    if (this.isStreaming) {
      if (window.electronAPI && window.electronAPI.stopAiChatStream) {
        window.electronAPI.stopAiChatStream();
      }
      return;
    }

    const text = this.input.value.trim();
    if (!text) return;
    this.input.value = '';
    this.afterSend();
    this.dispatch(text);
  }

  // The textarea shrinks back to one line once the message is on its way.
  afterSend() {
    this.autoGrowInput();
    this.updateSendEnabled();
  }

  sendPromptWithContext(userPrompt) {
    this.dispatch(userPrompt);
  }

  async dispatch(userText) {
    if (!userText) return;

    // Resolve @file mentions into an attached-context block
    const mention = await this.resolveMentions(userText);
    // Resolve files attached with the paperclip button
    const attach = await this.buildAttachmentBlock();

    let fullText = userText;
    const attached = [];
    if (mention) {
      fullText += mention.block;
      attached.push(...mention.list);
    }
    if (attach) {
      fullText += attach.block;
      attached.push(...attach.list);
    }
    const preview = attached.length ? '📎 Attached: ' + attached.join(', ') : '';

    // Attachments are one-shot: clear the chips once they reach the model.
    if (window.chatControls && window.chatControls.clearAttachments) {
      window.chatControls.clearAttachments();
    }

    if (this.mode === 'agent') {
      if (window.agent && window.agent.handleUserPrompt) {
        window.agent.handleUserPrompt(userText, fullText, preview);
      }
      return;
    }

    this.sendChat(userText, fullText, preview);
  }

  // ==========================================================================
  // Attachments (paperclip) + thinking level
  // ==========================================================================
  async buildAttachmentBlock() {
    if (!window.chatControls || typeof window.chatControls.getAttachments !== 'function') return null;
    let files;
    try {
      files = window.chatControls.getAttachments() || [];
    } catch (e) {
      return null;
    }
    if (!files.length || !window.electronAPI || !window.electronAPI.readFile) return null;

    const MAX_FILES = 4;
    const MAX_CHARS = 8000;
    const names = [];
    const blocks = [];
    for (const f of files.slice(0, MAX_FILES)) {
      if (!f || !f.path) continue;
      try {
        const content = await window.electronAPI.readFile(f.path);
        if (typeof content !== 'string' || !content) continue;
        const safePath = String(f.path).replace(/"/g, '');
        blocks.push(`<file path="${safePath}">\n${content.slice(0, MAX_CHARS)}\n</file>`);
        names.push(f.name || safePath);
      } catch (e) {
        // unreadable file — skip it
      }
    }
    if (!blocks.length) return null;
    return { block: '\n\n[Attached files]\n' + blocks.join('\n\n'), list: names };
  }

  thinkDirective() {
    const level = this.thinkLevel();
    switch (level) {
      case 'off':
        return '';
      case 'low':
        return 'Answer directly and concisely. Prefer the shortest correct answer over lengthy deliberation.';
      case 'high':
        return 'Think carefully step by step before answering. Consider edge cases, verify your reasoning, and give a precise, complete answer.';
      default:
        return 'Think through the problem briefly before answering. Be accurate, practical and concise.';
    }
  }

  sendChat(displayText, fullText, preview) {
    let contextPreview = preview || '';
    let prompt = fullText;

    // Fallback context: selection / active file (when no @mentions attached)
    if (!preview && window.editor) {
      const details = window.editor.getActiveFileDetails();
      if (details) {
        if (details.selection && details.selection.trim()) {
          contextPreview = `Selected from ${details.title}:\n\`\`\`\n${details.selection.slice(0, 1500)}\n\`\`\``;
          prompt = `${fullText}\n\nHere is the relevant code snippet from "${details.title}":\n\`\`\`\n${details.selection}\n\`\`\``;
        } else if (details.content) {
          prompt = `${fullText}\n\nActive file: "${details.title}":\n\`\`\`\n${details.content.slice(0, 4000)}\n\`\`\``;
        }
      }
    }

    this.appendUserMessage(displayText, contextPreview);
    // Seed the conversation with a reasoning directive matching "Think" level.
    if (!this.history.length) {
      const directive = this.thinkDirective();
      if (directive) this.history.push({ role: 'system', content: directive });
    }
    this.history.push({ role: 'user', content: prompt });

    this.currentResponseText = '';
    this.currentResponseNode = this.createAssistantMessageNode(displayText);
    this.messagesContainer.appendChild(this.currentResponseNode);
    this.scrollToBottom();

    this.isStreaming = true;
    this.setSendButtonState(true);

    const model = this.modelSelect ? this.modelSelect.value : 'qwen-2.5-coder-7b';

    window.electronAPI.startAiChatStream({
      model: model,
      messages: this.history
    });
  }

  // ==========================================================================
  // @-mention popup (uses window.FileIndex from palette.js)
  // ==========================================================================
  updateMentions() {
    const value = this.input.value;
    const caret = this.input.selectionStart;
    const before = value.slice(0, caret);
    const m = before.match(/(^|\s)@([^\s@]*)$/);
    if (!m || !window.FileIndex || !window.explorer || !window.explorer.rootPath) {
      this.hideMentions();
      return;
    }
    this.showMentionCandidates(m[2]);
  }

  async showMentionCandidates(query) {
    if (!window.FileIndex) return;
    let entries;
    try {
      await window.FileIndex.load(window.explorer.rootPath);
      entries = await window.FileIndex.search(query, 8);
    } catch (e) {
      this.hideMentions();
      return;
    }
    if (!entries || !entries.length) {
      this.hideMentions();
      return;
    }
    this.mentionItems = entries;
    this.mentionIdx = 0;
    this.renderMentionPopup();
  }

  renderMentionPopup() {
    if (!this.mentionPopup) return;
    this.mentionPopup.innerHTML = '';
    this.mentionItems.forEach((entry, i) => {
      const row = document.createElement('div');
      row.className = 'mention-item' + (i === this.mentionIdx ? ' active' : '');
      const name = entry.name || entry.relPath;
      const dir = entry.relPath.slice(0, Math.max(0, entry.relPath.length - name.length));
      row.innerHTML = `<span class="mi-name"></span><span class="mi-dir"></span>`;
      row.querySelector('.mi-name').textContent = name;
      row.querySelector('.mi-dir').textContent = dir;
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.mentionIdx = i;
        this.acceptMention();
      });
      this.mentionPopup.appendChild(row);
    });
    this.mentionPopup.classList.remove('hidden');
    this.mentionVisible = true;
  }

  moveMention(delta) {
    if (!this.mentionItems.length) return;
    this.mentionIdx = (this.mentionIdx + delta + this.mentionItems.length) % this.mentionItems.length;
    this.renderMentionPopup();
  }

  acceptMention() {
    const entry = this.mentionItems[this.mentionIdx];
    if (!entry) return;
    const value = this.input.value;
    const caret = this.input.selectionStart;
    const before = value.slice(0, caret);
    const after = value.slice(caret);
    const replaced = before.replace(/@([^\s@]*)$/, '@' + entry.relPath + ' ');
    this.input.value = replaced + after;
    const newCaret = replaced.length;
    this.input.setSelectionRange(newCaret, newCaret);
    this.input.focus();
    this.hideMentions();
  }

  hideMentions() {
    if (this.mentionPopup) this.mentionPopup.classList.add('hidden');
    this.mentionVisible = false;
    this.mentionItems = [];
  }

  // Read the referenced files and build a context block for the prompt
  async resolveMentions(text) {
    const matches = Array.from(text.matchAll(/@([^\s@]+)/g));
    if (!matches.length || !window.FileIndex || !window.electronAPI) return null;
    if (!window.explorer || !window.explorer.rootPath) return null;

    let all;
    try {
      await window.FileIndex.load(window.explorer.rootPath);
      all = window.FileIndex.all();
    } catch (e) {
      return null;
    }
    if (!all || !all.length) return null;

    const picked = [];
    const seen = new Set();
    for (const m of matches.slice(0, 6)) {
      const token = m[1].replace(/[.,;:!?)\]]+$/, '');
      const entry = this.findFileEntry(all, token);
      if (entry && !seen.has(entry.path)) {
        seen.add(entry.path);
        picked.push(entry);
      }
    }
    if (!picked.length) return null;

    let block = '\n\n=== Attached files (@mentions) ===';
    let total = 0;
    const list = [];
    for (const entry of picked) {
      if (total > 40000) {
        block += '\n[context limit reached — remaining files skipped]';
        break;
      }
      let content;
      try {
        content = await window.electronAPI.readFile(entry.path);
      } catch (e) {
        block += `\n\n--- ${entry.relPath}: [could not read] ---`;
        continue;
      }
      if (content.length > 6000) {
        content = content.slice(0, 6000) + `\n[...truncated — file has ${content.length} chars]`;
      }
      total += content.length;
      list.push(entry.relPath);
      block += `\n\n--- ${entry.relPath} ---\n${content}`;
    }
    return list.length ? { block, list } : null;
  }

  findFileEntry(all, token) {
    const t = String(token).toLowerCase();
    return all.find((e) => e.relPath.toLowerCase() === t)
      || all.find((e) => e.relPath.toLowerCase().endsWith('/' + t))
      || all.find((e) => (e.name || '').toLowerCase() === t)
      || all.find((e) => e.relPath.toLowerCase().includes(t));
  }

  // ==========================================================================
  // Message rendering: chrome, markdown, code blocks, copy interactions
  // ==========================================================================
  // --------------------------------------------------------------------------
  // Message chrome: avatar glyph, role label, relative time, hover actions
  // --------------------------------------------------------------------------
  msgGlyph(role, isAgent) {
    if (role === 'user') return '👤';
    return isAgent ? '🤖' : '✦';
  }

  msgRoleLabel(role, isAgent, label) {
    if (label) return label;
    if (role === 'user') return 'You';
    return isAgent ? 'Cloud Code Agent' : 'Cloud Code AI';
  }

  relativeTime(ts) {
    const then = Number(ts) || Date.now();
    const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
    if (secs < 45) return 'just now';
    if (secs < 3600) return Math.floor(secs / 60) + 'm ago';
    if (secs < 86400) return Math.floor(secs / 3600) + 'h ago';
    const d = new Date(then);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return hh + ':' + mm;
  }

  headerHtml(role, opts) {
    const o = opts || {};
    const isUser = role === 'user';
    const isAgent = !!o.agent;
    const glyph = this.msgGlyph(role, isAgent);
    const label = this.msgRoleLabel(role, isAgent, o.label);
    const ts = Date.now();
    const actions = []
      .concat(['<button class="msg-act msg-act-copy" type="button" title="Copy message" aria-label="Copy message">⧉</button>'])
      .concat(isUser ? [] : ['<button class="msg-act msg-act-regen" type="button" title="Regenerate response" aria-label="Regenerate response">↻</button>'])
      .join('');
    return '<div class="msg-head">'
      + '<span class="msg-avatar ' + (isUser ? 'msg-avatar-user' : isAgent ? 'msg-avatar-agent' : 'msg-avatar-ai') + '">' + glyph + '</span>'
      + '<span class="msg-role">' + this.escapeHtml(label) + '</span>'
      + '<span class="msg-time" data-ts="' + ts + '">' + this.relativeTime(ts) + '</span>'
      + '<span class="msg-actions">' + actions + '</span>'
      + '</div>';
  }

  refreshTimestamps() {
    if (!this.messagesContainer || !this.messagesContainer.querySelectorAll) return;
    this.messagesContainer.querySelectorAll('.msg-time[data-ts]').forEach(el => {
      el.textContent = this.relativeTime(el.getAttribute('data-ts'));
    });
  }

  // Transient button label (✓ Copied, ✓ Inserted, …)
  flashLabel(btn, label, ms) {
    if (!btn) return;
    if (btn._msgLabelTimer) clearTimeout(btn._msgLabelTimer);
    if (btn._msgLabelOriginal == null) btn._msgLabelOriginal = btn.textContent;
    btn.textContent = label;
    if (btn.classList) btn.classList.add('msg-flash-ok');
    btn._msgLabelTimer = setTimeout(() => {
      btn.textContent = btn._msgLabelOriginal == null ? '' : btn._msgLabelOriginal;
      if (btn.classList) btn.classList.remove('msg-flash-ok');
      btn._msgLabelTimer = null;
    }, ms || 1200);
  }

  // Clipboard write with a legacy fallback for restricted contexts.
  copyText(text) {
    const value = text == null ? '' : String(text);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(value)
        .then(() => true)
        .catch(() => this.copyTextFallback(value));
    }
    return Promise.resolve(this.copyTextFallback(value));
  }

  copyTextFallback(value) {
    try {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.setAttribute('readonly', 'readonly');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return !!ok;
    } catch (e) {
      return false;
    }
  }

  // Delegated hover actions — survives streaming re-renders of the body.
  onMessageClick(e) {
    const target = e.target;
    if (!target || !target.closest) return;
    const btn = target.closest('.msg-act');
    if (!btn) return;
    const node = btn.closest ? btn.closest('.chat-msg') : null;
    if (e.stopPropagation) e.stopPropagation();
    const body = node && node.querySelector ? node.querySelector('.msg-body') : null;

    if (btn.classList.contains('msg-act-copy')) {
      const text = body ? (body.innerText != null && body.innerText !== '' ? body.innerText : body.textContent) : '';
      this.copyText(text).then(ok => { if (ok) this.flashLabel(btn, '✓ Copied'); });
      return;
    }
    if (btn.classList.contains('msg-act-regen')) {
      const text = (node && node._aiSourceText) || (body ? body.textContent : '') || '';
      try {
        window.dispatchEvent(new CustomEvent('chat:regenerate', { detail: { text: text } }));
      } catch (err) {
        // CustomEvent unavailable (plain-browser preview)
      }
      this.flashLabel(btn, '↻', 900);
    }
  }

  renderWelcome() {
    const welcome = document.createElement('div');
    welcome.className = 'chat-msg assistant msg-welcome';
    welcome._aiSourceText = '';
    welcome.innerHTML = this.headerHtml('assistant', { label: 'Cloud Code AI Assistant' })
      + '<div class="msg-body msg-muted">'
      + '<p>Hi! I am your local AI coding companion powered by your private GPU tunnel.</p>'
      + '<p>Type <code class="msg-inline-code">@</code> to attach files, switch to <b>Agent</b> mode to let me edit files and run commands, or use a quick action below.</p>'
      + '</div>'
      + this.emptyStateHtml();
    this.messagesContainer.appendChild(welcome);
    this.wireStarters(welcome);
  }

  // Empty state: what the agent can do, each line a one-click starter prompt.
  emptyStateHtml() {
    const items = CHAT_STARTERS.map((s) =>
      '<li class="chat-cap-item">'
      + '<span class="chat-cap-icon" aria-hidden="true">' + s.icon + '</span>'
      + '<span class="chat-cap-text">' + this.escapeHtml(s.label) + '</span>'
      + '</li>').join('');
    const starters = CHAT_STARTERS.map((s, i) =>
      '<button type="button" class="chat-starter" data-starter-index="' + i + '">'
      + '<span class="chat-starter-icon" aria-hidden="true">' + s.icon + '</span>'
      + '<span class="chat-starter-label">' + this.escapeHtml(s.label) + '</span>'
      + '</button>').join('');
    return '<div class="chat-empty">'
      + '<div class="chat-empty-title">I can…</div>'
      + '<ul class="chat-capabilities">' + items + '</ul>'
      + '<div class="chat-empty-title">Try one</div>'
      + '<div class="chat-starters">' + starters + '</div>'
      + '</div>';
  }

  wireStarters(container) {
    if (!container || !container.querySelectorAll) return;
    const self = this;
    container.querySelectorAll('.chat-starter[data-starter-index]').forEach((btn) => {
      btn.onclick = () => {
        const i = Number(btn.getAttribute('data-starter-index'));
        const s = CHAT_STARTERS[i];
        if (!s) return;
        self.sendPromptWithContext(s.text);
      };
    });
  }

  appendUserMessage(text, contextPreview) {
    const el = document.createElement('div');
    el.className = 'chat-msg user msg-user';
    el._aiSourceText = text || '';

    let contextHtml = '';
    if (contextPreview) {
      contextHtml = '<div class="msg-context">' + this.escapeHtml(contextPreview) + '</div>';
    }

    el.innerHTML = this.headerHtml('user')
      + '<div class="msg-body">'
      + contextHtml
      + '<div class="msg-text">' + this.escapeHtml(text) + '</div>'
      + '</div>';
    this.messagesContainer.appendChild(el);
    this.scrollToBottom();
  }

  createAssistantMessageNode(sourceText) {
    const el = document.createElement('div');
    el.className = 'chat-msg assistant msg-assistant';
    el._aiSourceText = sourceText || '';
    el.innerHTML = this.headerHtml('assistant')
      + '<div class="msg-body">'
      + '<div class="msg-typing"><span class="msg-spinner"></span><span>Thinking…</span></div>'
      + '</div>';
    return el;
  }

  // Notice / status line (ℹ info, ⚠ warning, ⚠ error).
  renderNotice(text, kind) {
    const level = kind === 'error' ? 'error' : (kind === 'warn' || kind === 'warning') ? 'warn' : 'info';
    const el = document.createElement('div');
    el.className = 'chat-msg msg-notice msg-notice-' + level;
    el.innerHTML = '<div class="msg-head msg-head-compact">'
      + '<span class="msg-symbol msg-symbol-' + level + '">' + (level === 'info' ? 'ℹ' : '⚠') + '</span>'
      + '<span class="msg-notice-text">' + this.escapeHtml(text) + '</span>'
      + '</div>';
    this.messagesContainer.appendChild(el);
    this.scrollToBottom();
    return el;
  }

  // Red-bordered error body. Preserves the previous inline ⚠ behaviour.
  markError(node, err) {
    if (!node) return;
    if (node.classList) node.classList.add('msg-error');
    const body = node.querySelector ? node.querySelector('.msg-body') : null;
    if (!body) return;
    body.innerHTML = '<div class="msg-error-row">'
      + '<span class="msg-symbol msg-symbol-warn">⚠</span>'
      + '<span class="msg-error-text">' + this.escapeHtml(err) + '</span>'
      + '</div>';
  }

  updateResponseDisplay(node, text, streaming) {
    const body = node.querySelector('.msg-body');
    if (!body) return;
    const live = streaming === undefined ? !!this.isStreaming : !!streaming;
    // Reasoning text never reaches the DOM while thinking is off.
    body.innerHTML = this.renderMarkdown(this.displayText(text)) + (live ? '<span class="msg-cursor"></span>' : '');
    this.wireCodeButtons(body);
  }

  finalizeResponseDisplay(node, text) {
    this.updateResponseDisplay(node, text, false);
  }

  // --------------------------------------------------------------------------
  // Markdown → HTML (XSS-safe: escape first, then transform)
  // --------------------------------------------------------------------------
  renderMarkdown(md) {
    if (md === null || md === undefined) return '';
    const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
    return this.renderBlocks(lines);
  }

  renderBlocks(lines) {
    let html = '';
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }

      // ---- fenced code -----------------------------------------------------
      const fence = line.match(/^\s{0,3}(```+|~~~+)\s*([^\s`~]*)/);
      if (fence) {
        const marker = fence[1].charAt(0);
        const len = fence[1].length;
        const lang = (fence[2] || '').replace(/[^A-Za-z0-9_+#.-]/g, '').slice(0, 24);
        const buf = [];
        i++;
        while (i < lines.length) {
          const close = lines[i].match(/^\s{0,3}(```+|~~~+)\s*$/);
          if (close && close[1].charAt(0) === marker && close[1].length >= len) { i++; break; }
          buf.push(lines[i]);
          i++;
        }
        html += this.renderCodeBlock(lang, buf.join('\n'));
        continue;
      }

      // ---- horizontal rule -------------------------------------------------
      if (/^\s{0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/.test(line)) {
        html += '<hr class="msg-hr">';
        i++;
        continue;
      }

      // ---- heading ---------------------------------------------------------
      const h = line.match(/^\s{0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/);
      if (h) {
        const level = h[1].length;
        html += '<h' + level + ' class="msg-h msg-h' + level + '">' + this.renderInline(h[2]) + '</h' + level + '>';
        i++;
        continue;
      }

      // ---- blockquote ------------------------------------------------------
      if (/^\s{0,3}>/.test(line)) {
        const buf = [];
        while (i < lines.length && (/^\s{0,3}>/.test(lines[i]) || (lines[i].trim() && buf.length && !this.isBlockStart(lines[i])))) {
          buf.push(lines[i].replace(/^\s{0,3}>[ \t]?/, ''));
          i++;
        }
        html += '<blockquote class="msg-quote">' + this.renderBlocks(buf) + '</blockquote>';
        continue;
      }

      // ---- table -----------------------------------------------------------
      if (line.indexOf('|') !== -1 && i + 1 < lines.length && this.isTableDivider(lines[i + 1])) {
        const head = this.splitRow(line);
        const align = this.splitRow(lines[i + 1]).map(this.cellAlign, this);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].trim() && lines[i].indexOf('|') !== -1) {
          rows.push(this.splitRow(lines[i]));
          i++;
        }
        html += this.renderTable(head, align, rows);
        continue;
      }

      // ---- list ------------------------------------------------------------
      if (/^\s{0,6}([-*+]|\d+[.)])[ \t]+/.test(line)) {
        const res = this.renderList(lines, i);
        html += res.html;
        i = res.next;
        continue;
      }

      // ---- paragraph -------------------------------------------------------
      const buf = [];
      while (i < lines.length && lines[i].trim() && !this.isBlockStart(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      if (!buf.length) { buf.push(lines[i]); i++; }
      html += '<p class="msg-p">' + this.renderInline(buf.join('\n')) + '</p>';
    }
    return html;
  }

  isBlockStart(line) {
    if (/^\s{0,3}(```|~~~)/.test(line)) return true;
    if (/^\s{0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/.test(line)) return true;
    if (/^\s{0,3}#{1,6}[ \t]+/.test(line)) return true;
    if (/^\s{0,3}>/.test(line)) return true;
    if (/^\s{0,6}([-*+]|\d+[.)])[ \t]+/.test(line)) return true;
    if (line.indexOf('|') !== -1) return true;
    return false;
  }

  isTableDivider(line) {
    if (line.indexOf('-') === -1) return false;
    if (line.indexOf('|') === -1) return false;
    return /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(line);
  }

  splitRow(row) {
    let s = String(row).trim();
    if (s.charAt(0) === '|') s = s.slice(1);
    if (s.charAt(s.length - 1) === '|') s = s.slice(0, -1);
    const cells = [];
    let cur = '';
    for (let k = 0; k < s.length; k++) {
      const ch = s.charAt(k);
      if (ch === '\\' && s.charAt(k + 1) === '|') { cur += '|'; k++; continue; }
      if (ch === '|') { cells.push(cur); cur = ''; continue; }
      cur += ch;
    }
    cells.push(cur);
    return cells.map(c => c.trim());
  }

  cellAlign(cell) {
    const c = String(cell || '').trim();
    const left = c.charAt(0) === ':';
    const right = c.charAt(c.length - 1) === ':';
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return '';
  }

  renderTable(head, align, rows) {
    const alignOf = (idx) => {
      const a = align && align[idx] ? align[idx] : '';
      return a ? ' style="text-align:' + a + '"' : '';
    };
    let html = '<div class="msg-tablewrap"><table class="msg-table"><thead><tr>';
    head.forEach((c, idx) => { html += '<th' + alignOf(idx) + '>' + this.renderInline(c) + '</th>'; });
    html += '</tr></thead><tbody>';
    rows.forEach(row => {
      html += '<tr>';
      for (let idx = 0; idx < head.length; idx++) {
        html += '<td' + alignOf(idx) + '>' + this.renderInline(row[idx] || '') + '</td>';
      }
      html += '</tr>';
    });
    html += '</tbody></table></div>';
    return html;
  }

  renderList(lines, start) {
    const first = lines[start].match(/^(\s*)([-*+]|\d+[.)])[ \t]+(.*)$/);
    const ordered = /\d/.test(first[2]);
    const baseIndent = first[1].length;
    const items = [];
    let i = start;
    while (i < lines.length) {
      const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])[ \t]+(.*)$/);
      if (!m) break;
      const indent = m[1].length;
      if (indent > baseIndent + 1 && items.length) {
        // continuation / nested line of the previous item
        items[items.length - 1].lines.push(lines[i].replace(new RegExp('^\\s{0,' + (baseIndent + 2) + '}'), ''));
        i++;
        continue;
      }
      if (indent > baseIndent + 1) break;
      if (indent < baseIndent) break;
      items.push({ lines: [m[3]] });
      i++;
    }
    const tag = ordered ? 'ol' : 'ul';
    let html = '<' + tag + ' class="msg-list">';
    items.forEach(item => {
      const firstLine = item.lines[0] || '';
      const check = firstLine.match(/^\[([ xX])\][ \t]+(.*)$/);
      if (check) {
        item.lines[0] = check[2];
        const box = check[1] === ' ' ? '☐' : '☑';
        html += '<li class="msg-li msg-li-task"><span class="msg-check">' + box + '</span>';
        html += this.renderBlocks(item.lines.length ? item.lines : ['']);
      } else {
        html += '<li class="msg-li">' + this.renderBlocks(item.lines.length ? item.lines : ['']);
      }
      html += '</li>';
    });
    html += '</' + tag + '>';
    return { html: html, next: i };
  }

  renderCodeBlock(lang, code) {
    const key = lang || 'text';
    return '<div class="msg-code" data-lang="' + this.escapeAttr(key) + '">'
      + '<div class="msg-code-head">'
      + '<span class="msg-code-lang">' + this.escapeHtml(key) + '</span>'
      + '<button class="msg-code-btn msg-code-insert" type="button" title="Insert at cursor">Insert</button>'
      + '<button class="msg-code-btn msg-code-copy" type="button" title="Copy code">Copy</button>'
      + '</div>'
      + '<pre class="msg-code-pre"><code class="msg-code-body">' + this.escapeHtml(code) + '</code></pre>'
      + '</div>';
  }

  // Inline transforms — input is already HTML-escaped.
  renderInline(text) {
    let s = this.escapeHtml(text);
    const codes = [];
    s = s.replace(/`([^`]+)`/g, (m, c) => {
      codes.push(c);
      return '\u0000' + (codes.length - 1) + '\u0000';
    });
    // links (http/https only)
    s = s.replace(/\[([^\]]*)\]\(([^)\s]*)\)/g, (m, label, url) => {
      const u = String(url || '').trim();
      if (!/^https?:\/\//i.test(u)) return m;
      // `u` is already HTML-escaped (escapeHtml ran first) — only quotes are
      // still dangerous inside the attribute, so avoid double-escaping `&`.
      const href = String(u).replace(/"/g, '&quot;');
      return '<a class="msg-link" href="' + href + '" target="_blank" rel="noopener noreferrer">'
        + (label || u) + '</a>';
    });
    s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    s = s.replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^\w*])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^\w_])_([^_\n]+?)_(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/~~([\s\S]+?)~~/g, '<del>$1</del>');
    s = s.replace(/\u0000(\d+)\u0000/g, (m, n) => '<code class="msg-inline-code">' + codes[Number(n)] + '</code>');
    return s;
  }

  wireCodeButtons(container) {
    if (!container || !container.querySelectorAll) return;
    const self = this;
    const codeOf = (btn) => {
      if (btn.dataset && btn.dataset.code) return btn.dataset.code;
      let host = btn.closest ? btn.closest('.msg-code, .code-block-container') : null;
      if (!host && container.closest) host = container.closest('.msg-code, .code-block-container');
      const scope = host || container;
      const pre = scope.querySelector('pre');
      if (pre) return pre.textContent || '';
      const code = scope.querySelector('code');
      return code ? (code.textContent || '') : '';
    };

    container.querySelectorAll('.msg-code-copy, .btn-copy-code').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        self.copyText(codeOf(btn)).then(ok => { if (ok) self.flashLabel(btn, '✓ Copied'); });
      };
    });

    container.querySelectorAll('.msg-code-insert, .btn-insert-code').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const code = codeOf(btn);
        if (window.editor && window.editor.insertTextAtCursor) {
          window.editor.insertTextAtCursor(code);
          self.flashLabel(btn, '✓ Inserted');
        }
      };
    });
  }

  setSendButtonState(isStreaming) {
    if (this.sendBtn && this.sendBtn.classList) {
      this.sendBtn.classList.toggle('chat-sending', !!isStreaming);
    }
    // In-flight state (dimmed input + progress hint) rides along with the
    // button so the two can never disagree.
    this.setBusyState(!!isStreaming);
    if (isStreaming) {
      this.sendBtn.innerHTML = '⏹';
      this.sendBtn.title = 'Stop generating';
      this.sendBtn.style.background = '#e53e3e';
    } else {
      this.sendBtn.innerHTML = `
        <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
          <path d="M15.854.146a.5.5 0 0 1 .11.54l-5.8 14.5a.5.5 0 0 1-.928.008L6.471 9.53 1.006 6.764a.5.5 0 0 1 .008-.928L15.514.036a.5.5 0 0 1 .34.11z"/>
        </svg>
      `;
      this.sendBtn.title = 'Send (Enter)';
      this.sendBtn.style.background = 'var(--accent-color)';
    }
  }

  escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;');
  }

  escapeAttr(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/&/g, '&amp;')
              .replace(/"/g, '&quot;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;');
  }
}

/* ==========================================================================
   AgentThinkingPanel — compact collapsible block above the message stream.

   Design choice: inline at the TOP of the message stream (not a floating
   overlay, not pinned to the control bar) because the panel scrolls with the
   transcript it describes, never covers messages, and dies with them.

   - lines are capped at THINK_MAX_LINES (oldest dropped)
   - never takes focus
   - auto-scrolls only when the user is already at the bottom
   ========================================================================== */
class AgentThinkingPanel {
  constructor(host, assistant) {
    this.host = host;
    this.assistant = assistant;
    this.el = null;
    this.logEl = null;
    this.lines = [];
    this.step = 0;
    this.finished = false;
    this.open = true;
  }

  isLive() { return !!this.el; }

  // Thinking off ⇒ no panel, ever. Re-checked on every push so a level change
  // takes effect immediately.
  enabled() {
    const a = this.assistant;
    return !!(a && typeof a.thinkingEnabled === 'function' ? a.thinkingEnabled() : true);
  }

  ensure() {
    if (this.el) return this.el;
    if (!this.host) return null;
    if (!this.enabled()) return null;

    const el = document.createElement('div');
    el.className = 'think-panel';
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', 'Agent reasoning');

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'think-head';
    head.setAttribute('aria-expanded', 'true');
    head.innerHTML = '<span class="think-spinner" aria-hidden="true"></span>'
      + '<span class="think-title">Thinking</span>'
      + '<span class="think-step"></span>'
      + '<span class="think-caret" aria-hidden="true">▾</span>';
    head.onclick = () => this.toggle();

    const log = document.createElement('div');
    log.className = 'think-log';

    el.appendChild(head);
    el.appendChild(log);

    // Top of the stream, before any message.
    if (this.host.insertBefore) this.host.insertBefore(el, this.host.firstChild);
    else this.host.appendChild(el);

    this.el = el;
    this.logEl = log;
    this.finished = false;
    this.open = true;
    this.render();
    return el;
  }

  push(entry) {
    if (!this.enabled()) { this.destroy(); return; }
    this.ensure();
    if (!this.el) return;
    this.step = Math.max(this.step, entry.step || 0);
    this.lines.push({ text: entry.text, phase: entry.phase });
    while (this.lines.length > THINK_MAX_LINES) this.lines.shift();
    this.finished = false;
    this.el.classList.remove('think-done');
    this.el.classList.add('think-live');
    this.open = true;
    this.render();
  }

  render() {
    if (!this.el || !this.logEl) return;
    const nearBottom = this.nearBottom();
    while (this.logEl.firstChild) this.logEl.removeChild(this.logEl.firstChild);

    this.lines.forEach((l) => {
      const row = document.createElement('div');
      row.className = 'think-line think-line-' + l.phase;
      const dot = document.createElement('span');
      dot.className = 'think-dot';
      dot.setAttribute('aria-hidden', 'true');
      const text = document.createElement('span');
      text.className = 'think-text';
      text.textContent = l.text;           // untrusted → textContent only
      row.appendChild(dot);
      row.appendChild(text);
      this.logEl.appendChild(row);
    });

    const title = this.el.querySelector('.think-title');
    const step = this.el.querySelector('.think-step');
    const head = this.el.querySelector('.think-head');
    if (title) title.textContent = this.finished ? 'Thought' : 'Thinking';
    if (step) step.textContent = this.step > 0 ? ('step ' + this.step) : '';
    if (head) {
      head.setAttribute('aria-expanded', this.open ? 'true' : 'false');
      head.title = this.finished
        ? (this.open ? 'Hide reasoning' : 'Reveal reasoning')
        : 'Agent reasoning (live)';
    }
    this.el.classList.toggle('think-collapsed', !this.open);
    this.el.classList.toggle('think-done', this.finished);

    if (!this.finished && nearBottom) this.scroll();
  }

  finish(step) {
    if (!this.el) { this.reset(); return; }
    if (step) this.step = Math.max(this.step, step);
    this.finished = true;
    this.open = false;                        // collapse to the one-liner
    this.el.classList.remove('think-live');
    this.render();
    const head = this.el.querySelector('.think-head');
    if (head) {
      const n = this.step || this.lines.length;
      head.title = 'Thought for ' + n + (n === 1 ? ' step' : ' steps') + ' · expand';
    }
  }

  toggle() {
    if (!this.el) return;
    this.open = !this.open;
    this.render();
  }

  nearBottom() {
    if (!this.host) return true;
    const gap = this.host.scrollHeight - this.host.scrollTop - this.host.clientHeight;
    return gap < 60;
  }

  scroll() {
    if (this.host) this.host.scrollTop = this.host.scrollHeight;
  }

  reset() {
    this.lines = [];
    this.step = 0;
    this.finished = false;
    this.open = true;
  }

  destroy() {
    if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
    this.el = null;
    this.logEl = null;
    this.reset();
  }
}

window.AIAssistant = AIAssistant;
window.AgentThinkingPanel = AgentThinkingPanel;
