// Cloud Code AI Engine — the DOM-free tool loop.
//
// AgentLoop owns nothing but control flow: it asks the host for a completion,
// hands each tool call to the host's executor, formats the transcript with
// core/protocol.js, and reports progress through onEvent(). It never touches
// the DOM, Electron, the filesystem or the network.
//
//   const loop = new AgentLoop({ maxSteps, callModel, executeTool, onEvent });
//   const result = await loop.run({ messages, systemPrompt });

(function (global) {
  'use strict';

  // Lazy protocol lookup so load order does not matter in the browser.
  function protocol() {
    if (global.CloudAI && global.CloudAI.protocol) return global.CloudAI.protocol;
    if (typeof require === 'function') {
      const p = require('./protocol.js');
      global.CloudAI = Object.assign(global.CloudAI || {}, { protocol: p });
      return p;
    }
    throw new Error('Cloud AI engine: core/protocol.js must be loaded before core/loop.js');
  }

  /**
   * Event types the host may render. The first eight are the original contract
   * and must not be renamed or removed; `retry` and `health` were added for
   * transient-failure resilience.
   */
  const EVENT_TYPES = [
    'step', 'tool_start', 'tool_end', 'tool_error',
    'assistant', 'notice', 'done', 'error',
    'retry', 'health'
  ];

  /** Lazy tools lookup so load order does not matter in the browser. */
  function tools() {
    if (global.CloudAI && global.CloudAI.tools) return global.CloudAI.tools;
    if (typeof require === 'function') {
      const t = require('./tools.js');
      global.CloudAI = Object.assign(global.CloudAI || {}, { tools: t });
      return t;
    }
    throw new Error('Cloud AI engine: core/tools.js must be loaded before core/loop.js');
  }

  /** Lazy context lookup so load order does not matter in the browser. */
  function context() {
    if (global.CloudAI && global.CloudAI.context) return global.CloudAI.context;
    if (typeof require === 'function') {
      const c = require('./context.js');
      global.CloudAI = Object.assign(global.CloudAI || {}, { context: c });
      return c;
    }
    throw new Error('Cloud AI engine: core/context.js must be loaded before core/loop.js');
  }

  /** Retry budget and backoff schedule for transient transport failures. */
  const RETRY_DELAYS_MS = [400, 1200];

  /** Maximum protocol nudges injected for a model that keeps answering in prose. */
  const MAX_NUDGES = 2;

  /** Error shapes that are worth retrying: network, timeout, 5xx, 429. */
  const TRANSIENT_RE = /\b(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|network|fetch failed|timeout|timed out|temporarily unavailable|service unavailable|bad gateway|gateway timeout|overloaded|\b429\b|\b500\b|\b502\b|\b503\b|\b504\b)/i;

  /** Classify a failure so the host can offer "retry" / "switch model". */
  function classifyError(message, aborted) {
    const msg = String(message == null ? '' : message);
    if (aborted) return { kind: 'cancelled', message: msg, retryable: false };
    if (/abort|destroy|cancel/i.test(msg) && !TRANSIENT_RE.test(msg)) {
      return { kind: 'cancelled', message: msg, retryable: false };
    }
    if (/\b(4\d\d)\b/.test(msg) && !TRANSIENT_RE.test(msg)) {
      return { kind: 'http', message: msg, retryable: false };
    }
    if (TRANSIENT_RE.test(msg)) return { kind: 'transport', message: msg, retryable: true };
    if (/^\s*(HTTP|status)/i.test(msg)) return { kind: 'http', message: msg, retryable: false };
    return { kind: 'protocol', message: msg, retryable: false };
  }

  function sleep(ms, signal) {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      if (signal && typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
      }
    });
  }

  class AgentLoop {
    /**
     * @param {object}   o
     * @param {number}  [o.maxSteps=15]
     * @param {function} o.callModel   async (messages, {signal, tools}) =>
     *        { content, toolCalls, usedNativeTools, reasoning, finishReason, error }
     * @param {function} o.executeTool async (toolCall) => Promise<string>
     * @param {function} [o.onEvent]   (evt) => void, evt.type ∈ EVENT_TYPES
     * @param {object}  [o.host]       { nudgeOnSilentTurns } — set
     *        `nudgeOnSilentTurns: true` to let the loop correct a model that
     *        answers in prose while a tool was clearly needed.
     * @param {boolean} [o.requireToolFirstStep=false] — treat a first turn with
     *        no tool call as a protocol failure and correct it.
     */
    constructor(o) {
      const opts = o || {};
      this.maxSteps = Math.max(1, parseInt(opts.maxSteps, 10) || 15);
      this.callModel = opts.callModel;
      this.executeTool = opts.executeTool;
      this.onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : null;
      const host = opts.host || {};
      this.nudgeOnSilentTurns = host.nudgeOnSilentTurns === undefined
        ? false
        : !!host.nudgeOnSilentTurns;
      this.requireToolFirstStep = !!opts.requireToolFirstStep;
      this.retryDelaysMs = Array.isArray(opts.retryDelaysMs) ? opts.retryDelaysMs.slice() : RETRY_DELAYS_MS.slice();
      // Context budget: { budget, keepRecent, maxChars } — see core/context.js.
      this.contextOptions = opts.context && typeof opts.context === 'object' ? Object.assign({}, opts.context) : {};
      this.messages = [];
      this.step = 0;
      this.running = false;
      this.lastError = null;
      this._controller = null;
    }

    /** Ask the loop to stop; safe to call at any time, including mid-request. */
    cancel(reason) {
      this.cancelReason = reason || 'Cancelled by the user.';
      if (this._controller) {
        try { this._controller.abort(); } catch (e) { /* already aborted */ }
      }
    }

    get signal() {
      return this._controller ? this._controller.signal : null;
    }

    _emit(evt) {
      if (!this.onEvent) return;
      try { this.onEvent(evt); } catch (e) { /* a UI signal must never break the loop */ }
    }

    /**
     * Run the loop to completion.
     * @param {object} o
     * @param {Array}  [o.messages]     prior conversation (without the system prompt)
     * @param {string} [o.systemPrompt] prepended as a system message
     * @param {AbortSignal} [o.signal]  external cancellation
     * @returns {Promise<object>} { ok, steps, stopReason, finalText, messages, error }
     */
    async run(o) {
      const opts = o || {};
      const msgs = [];
      if (opts.systemPrompt) msgs.push({ role: 'system', content: opts.systemPrompt });
      for (const m of (opts.messages || [])) msgs.push(m);
      this.messages = msgs;

      this._controller = typeof AbortController === 'function' ? new AbortController() : null;
      if (opts.signal) {
        if (opts.signal.aborted) this._controller && this._controller.abort();
        else if (typeof opts.signal.addEventListener === 'function') {
          opts.signal.addEventListener('abort', () => this._controller && this._controller.abort());
        }
      }
      const signal = this._controller ? this._controller.signal : undefined;

      this.running = true;
      this.step = 0;
      this.cancelReason = null;

      let finalText = '';
      let stopReason = 'done';
      let error = null;
      let useNativeTools = true;
      let nudges = 0;
      let retriesUsed = 0;
      let trimmedTotal = 0;
      const contextOpts = Object.assign({}, this.contextOptions,
        opts.context && typeof opts.context === 'object' ? opts.context : {});
      this.lastError = null;
      this._toolsAlreadyUsed = false;

      try {
        for (;;) {
          if (this._aborted(signal)) { stopReason = 'cancelled'; break; }

          if (this.step >= this.maxSteps) {
            const msg = `Reached the maximum of **${this.maxSteps}** steps (configurable in Settings → Agent).`;
            this._emit({ type: 'notice', text: msg, step: this.step });
            stopReason = 'max_steps';
            break;
          }

          this.step += 1;
          this._emit({ type: 'step', step: this.step, maxSteps: this.maxSteps });

          // --- context budget ---------------------------------------------
          // Trim old tool results BEFORE asking for the next completion so
          // the estimate we send never exceeds the budget.
          const trimmed = context().trimMessages(this.messages, contextOpts);
          if (trimmed.trimmed > 0) {
            trimmedTotal += trimmed.trimmed;
            this.messages = trimmed.messages;
            this._emit({
              type: 'notice',
              text: 'Context budget reached — trimmed ' + trimmed.trimmed +
                ' older tool result(s) to their first ~' +
                (contextOpts.maxChars || context().DEFAULT_MAX_CHARS) + ' characters.',
              step: this.step,
              trimmed: trimmed.trimmed,
              estimatedTokens: trimmed.estimatedTokens
            });
          }

          let res;
          // --- transient-failure retry with backoff --------------------------
          for (;;) {
            try {
              res = await this.callModel(this.messages, { signal, useNativeTools, step: this.step });
            } catch (err) {
              res = { error: err && err.message ? err.message : String(err), __thrown: true };
            }
            if (!res) break;
            if (!res.error) break;
            if (this._aborted(signal)) break;

            const info = classifyError(res.error, false);
            if (!info.retryable || retriesUsed >= this.retryDelaysMs.length) break;

            const delay = this.retryDelaysMs[retriesUsed];
            retriesUsed += 1;
            this._emit({
              type: 'retry',
              step: this.step,
              attempt: retriesUsed,
              maxAttempts: this.retryDelaysMs.length + 1,
              delayMs: delay,
              kind: info.kind,
              message: info.message,
              retryable: true
            });
            await sleep(delay, signal);
            if (this._aborted(signal)) { res = null; break; }
          }

          if (this._aborted(signal)) { stopReason = 'cancelled'; break; }

          if (!res) { stopReason = res === null ? 'cancelled' : 'empty_response'; break; }

          if (res.error) {
            error = String(res.error);
            const info = classifyError(error, this._aborted(signal));
            this.lastError = info;
            if (info.kind === 'cancelled') { stopReason = 'cancelled'; break; }
            this._emit({ type: 'error', kind: info.kind, message: error, retryable: info.retryable, step: this.step });
            this._emit({
              type: 'health',
              step: this.step,
              ok: false,
              kind: info.kind,
              message: error,
              retryable: info.retryable,
              retriesUsed
            });
            stopReason = 'model_error';
            break;
          }

          if (res.toolsRejected && useNativeTools) {
            useNativeTools = false;
            this._emit({
              type: 'notice',
              text: 'The model endpoint does not support native tool calling — switched to the built-in text tool protocol.',
              step: this.step
            });
          }

          // `reasoning` is a private thinking channel: it never enters the transcript.
          const reasoning = res.reasoning || null;

          let content = String(res.content || '').trim();
          let toolCalls = Array.isArray(res.toolCalls) ? res.toolCalls : [];
          let usedNativeTools = !!res.usedNativeTools;

          if (!toolCalls.length && content.includes('<<<TOOL>>>')) {
            // Text-protocol fallback. Hosts usually do this in callModel, but the
            // loop does it too so it works with any model client.
            const parsed = protocol().extractTextToolCalls(content);
            content = parsed.content;
            if (parsed.toolCalls.length) {
              toolCalls = toolCalls.concat(parsed.toolCalls);
              usedNativeTools = false;
            }
          }

          // A model that used native tool calls AND left a text-protocol block
          // behind would double-report; strip the block.
          if (toolCalls.length && usedNativeTools && content.includes('<<<TOOL>>>')) {
            content = protocol().stripToolBlocks(content);
          }

          if (toolCalls.length === 0) {
            const clean = protocol().stripAsciiDecoration(content);
            // A "silent turn" is prose where a tool was clearly needed:
            //   nudgeOnSilentTurns  → a tool has already run, then the model chats
            //   requireToolFirstStep → the model chats before any tool has run
            const silentTurn = this.nudgeOnSilentTurns
              ? this._toolsAlreadyUsed
              : (this.requireToolFirstStep && !this._toolsAlreadyUsed);

            if (silentTurn && nudges < MAX_NUDGES) {
              // The model answered in prose where a tool was clearly needed.
              // Correct it once or twice with the exact block shape, then continue.
              nudges += 1;
              this.messages.push({ role: 'assistant', content: clean || '(no response)' });
              const correction =
                'Your last message was prose. No tool was called, so nothing happened on disk. ' +
                'Reply with EXACTLY one block and nothing else:\n' +
                '<<<TOOL>>>\n{"name":"list_dir","args":{"path":"."}}\n<<<END>>>\n' +
                'No explanation, no markdown fence, no trailing comma, double-quoted keys. ' +
                '(Correction ' + nudges + ' of ' + MAX_NUDGES + '.)';
              this.messages.push({ role: 'user', content: correction });
              this._emit({
                type: 'notice',
                text: 'The model answered without calling a tool — asking it to emit the tool block (attempt ' + nudges + ' of ' + MAX_NUDGES + ').',
                step: this.step,
                phase: 'protocol-nudge'
              });
              continue;
            }

            if (silentTurn) {
              // Out of nudges: stop gracefully with an explicit final message.
              const msg = 'The model did not use any tool after ' + MAX_NUDGES +
                ' correction attempts, so no files were changed.';
              finalText = clean ? clean + '\n\n' + msg : msg;
              this.messages.push({ role: 'assistant', content: clean || '(no response)' });
              this._emit({ type: 'assistant', content: finalText, reasoning, step: this.step });
              this.lastError = { kind: 'protocol', message: msg, retryable: false };
              this._emit({ type: 'error', kind: 'protocol', message: msg, retryable: false, step: this.step });
              stopReason = 'no_tool_call';
              break;
            }

            finalText = clean;
            this.messages.push({ role: 'assistant', content: clean || '(no response)' });
            this._emit({ type: 'assistant', content: clean || '(no response)', reasoning, step: this.step });
            stopReason = 'completed';
            break;
          }

          this._toolsAlreadyUsed = true;
          if (content) this._emit({ type: 'notice', content, reasoning, step: this.step, phase: 'thinking' });

          this.messages.push(protocol().formatAssistantTurn({ content, toolCalls, usedNativeTools }));

          for (const tc of toolCalls) {
            if (this._aborted(signal)) {
              this.messages.push(protocol().formatToolResult({ usedNativeTools, toolCall: tc, text: this.cancelReason || 'Cancelled by the user.' }));
              this._emit({ type: 'tool_end', toolCall: tc, text: this.cancelReason || 'Cancelled by the user.', cancelled: true });
              continue;
            }
            this._emit({ type: 'tool_start', toolCall: tc, step: this.step });
            let text;
            try {
              text = await this.executeTool(tc);
              if (text == null) text = '';
              text = String(text);
              // Never let a huge tool output blow the context budget.
              text = tools().truncateResult(tc.name, text);
              this._emit({ type: 'tool_end', toolCall: tc, text, step: this.step });
            } catch (err) {
              // Tool failures are returned to the model, never thrown out of the loop.
              const msg = err && err.message ? err.message : String(err);
              text = 'Error: ' + msg;
              this._emit({ type: 'tool_error', toolCall: tc, message: msg, step: this.step });
            }
            this.messages.push(protocol().formatToolResult({ usedNativeTools, toolCall: tc, text }));
          }
        }
      } finally {
        this.running = false;
      }

      if (stopReason === 'cancelled') {
        this._emit({ type: 'notice', text: 'Agent stopped.', step: this.step, cancelled: true });
      }
      const result = {
        ok: stopReason === 'completed',
        steps: this.step,
        stopReason,
        cancelled: stopReason === 'cancelled',
        finalText,
        messages: this.messages,
        error,
        lastError: this.lastError,
        nudges,
        retries: retriesUsed,
        trimmed: trimmedTotal
      };
      this._emit({ type: 'done', result });
      return result;
    }

    _aborted(signal) {
      if (this.cancelReason) return true;
      return !!(signal && signal.aborted);
    }
  }

  const api = { AgentLoop, EVENT_TYPES, RETRY_DELAYS_MS, MAX_NUDGES, classifyError };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.CloudAI = Object.assign(global.CloudAI || {}, { AgentLoop, loop: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);