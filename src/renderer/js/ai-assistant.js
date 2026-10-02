// AI Assistant Panel — streaming chat, Chat/Agent mode routing,
// @-mention file context, quick prompts & code actions
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

    // @mention popup state
    this.mentionItems = [];
    this.mentionIdx = 0;
    this.mentionVisible = false;
    this.lastAttachments = [];

    this.init();
  }

  init() {
    this.sendBtn.onclick = () => this.handleSend();
    this.input.addEventListener('keydown', (e) => this.onInputKeydown(e));

    // Chat / Agent mode toggle
    if (this.modeChatBtn) this.modeChatBtn.onclick = () => this.setMode('chat');
    if (this.modeAgentBtn) this.modeAgentBtn.onclick = () => this.setMode('agent');

    // @-mention autocomplete in the chat input
    this.input.addEventListener('input', () => this.updateMentions());
    this.input.addEventListener('blur', () => setTimeout(() => this.hideMentions(), 150));
    this.input.addEventListener('click', () => this.updateMentions());

    if (this.clearBtn) {
      this.clearBtn.onclick = () => {
        this.history = [];
        this.messagesContainer.innerHTML = '';
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

    // Populate models from backend
    if (window.electronAPI && window.electronAPI.listAiModels) {
      window.electronAPI.listAiModels().then(models => {
        if (models && models.length && this.modelSelect) {
          this.modelSelect.innerHTML = '';
          models.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m;
            opt.textContent = m;
            if (m.includes('coder')) opt.selected = true;
            this.modelSelect.appendChild(opt);
          });
        }
      });
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
          const body = this.currentResponseNode.querySelector('.msg-body');
          if (body) {
            body.innerHTML = `<span style="color: #f87171;">⚠️ ${this.escapeHtml(err)}</span>`;
          }
        }
        this.currentResponseNode = null;
        this.currentResponseText = '';
      });
    }

    this.setMode('chat');
    this.renderWelcome();
  }

  // ==========================================================================
  // Chat / Agent mode
  // ==========================================================================
  setMode(mode) {
    this.mode = mode === 'agent' ? 'agent' : 'chat';
    if (this.modeChatBtn) this.modeChatBtn.classList.toggle('active', this.mode === 'chat');
    if (this.modeAgentBtn) this.modeAgentBtn.classList.toggle('active', this.mode === 'agent');
    if (window.agent && window.agent.setVisible) window.agent.setVisible(this.mode === 'agent');
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
        window.agent.requestStop();
        return;
      }
      const text = this.input.value.trim();
      if (!text) return;
      this.input.value = '';
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
    this.dispatch(text);
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
    const level = window.AppSettings ? window.AppSettings.get('thinkLevel') : 'medium';
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
    this.currentResponseNode = this.createAssistantMessageNode();
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
  // Message rendering
  // ==========================================================================
  renderWelcome() {
    const welcome = document.createElement('div');
    welcome.className = 'chat-msg assistant';
    welcome.innerHTML = `
      <div class="sender-title">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="#007acc"><path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0zM4.5 7.5a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm7 0a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm-7 3.5a.5.5 0 0 1 .5-.5h6a.5.5 0 0 1 0 1h-6a.5.5 0 0 1-.5-.5z"/></svg>
        <span>Cloud Code AI Assistant</span>
      </div>
      <div class="msg-body" style="color: #aaa;">
        Hi! I am your local AI coding companion powered by your private GPU tunnel.
        Type <code>@</code> to attach files, switch to <b>Agent</b> mode to let me edit files and run commands,
        or use a quick action below.
      </div>
    `;
    this.messagesContainer.appendChild(welcome);
  }

  appendUserMessage(text, contextPreview) {
    const el = document.createElement('div');
    el.className = 'chat-msg user';

    let contextHtml = '';
    if (contextPreview) {
      contextHtml = `<div class="msg-context">${this.escapeHtml(contextPreview)}</div>`;
    }

    el.innerHTML = `
      <div class="sender-title">You</div>
      <div class="msg-body">${contextHtml}<div>${this.escapeHtml(text)}</div></div>
    `;
    this.messagesContainer.appendChild(el);
    this.scrollToBottom();
  }

  createAssistantMessageNode() {
    const el = document.createElement('div');
    el.className = 'chat-msg assistant';
    el.innerHTML = `
      <div class="sender-title">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="#007acc"><path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0zM4.5 7.5a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm7 0a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm-7 3.5a.5.5 0 0 1 .5-.5h6a.5.5 0 0 1 0 1h-6a.5.5 0 0 1-.5-.5z"/></svg>
        <span>Cloud Code AI</span>
      </div>
      <div class="msg-body">
        <span class="typing-indicator" style="color: #888;">Thinking...</span>
      </div>
    `;
    return el;
  }

  updateResponseDisplay(node, text) {
    const body = node.querySelector('.msg-body');
    if (!body) return;
    body.innerHTML = this.renderMarkdown(text);
    this.wireCodeButtons(body);
  }

  finalizeResponseDisplay(node, text) {
    this.updateResponseDisplay(node, text);
  }

  renderMarkdown(md) {
    // Basic Markdown parser for code blocks and bolding
    let html = '';
    const parts = md.split(/(```[\s\S]*?```)/g);

    for (const part of parts) {
      if (part.startsWith('```') && part.endsWith('```')) {
        const firstLineEnd = part.indexOf('\n');
        const lang = part.slice(3, firstLineEnd).trim() || 'code';
        const code = part.slice(firstLineEnd + 1, -3);

        html += `
          <div class="code-block-container">
            <div class="code-header">
              <span>${lang}</span>
              <div style="display: flex; gap: 6px;">
                <button class="btn-code-action btn-copy-code" data-code="${this.escapeAttr(code)}">Copy</button>
                <button class="btn-code-action btn-insert-code" data-code="${this.escapeAttr(code)}">Apply to Editor</button>
              </div>
            </div>
            <pre><code>${this.escapeHtml(code)}</code></pre>
          </div>
        `;
      } else {
        let text = this.escapeHtml(part);
        text = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
        text = text.replace(/`([^`]+)`/g, '<code style="background:#2b2b2b;padding:2px 4px;border-radius:3px;font-size:12px;">$1</code>');
        text = text.replace(/\n/g, '<br>');
        html += text;
      }
    }
    return html;
  }

  wireCodeButtons(container) {
    container.querySelectorAll('.btn-copy-code').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const code = btn.dataset.code;
        navigator.clipboard.writeText(code).then(() => {
          btn.textContent = 'Copied!';
          setTimeout(() => btn.textContent = 'Copy', 1500);
        });
      };
    });

    container.querySelectorAll('.btn-insert-code').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const code = btn.dataset.code;
        if (window.editor) {
          window.editor.insertTextAtCursor(code);
          btn.textContent = 'Applied!';
          setTimeout(() => btn.textContent = 'Apply to Editor', 1500);
        }
      };
    });
  }

  setSendButtonState(isStreaming) {
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

  scrollToBottom() {
    this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
  }

  escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;');
  }

  escapeAttr(str) {
    if (!str) return '';
    return str.replace(/"/g, '&quot;');
  }
}

window.AIAssistant = AIAssistant;
