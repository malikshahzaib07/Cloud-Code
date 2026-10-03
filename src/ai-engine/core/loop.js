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

  /** Event types the host may render. */
  const EVENT_TYPES = ['step', 'tool_start', 'tool_end', 'tool_error', 'assistant', 'notice', 'done', 'error'];

  class AgentLoop {
    /**
     * @param {object}   o
     * @param {number}  [o.maxSteps=15]
     * @param {function} o.callModel   async (messages, {signal, tools}) =>
     *        { content, toolCalls, usedNativeTools, reasoning, finishReason, error }
     * @param {function} o.executeTool async (toolCall) => Promise<string>
     * @param {function} [o.onEvent]   (evt) => void, evt.type ∈ EVENT_TYPES
     */
    constructor(o) {
      const opts = o || {};
      this.maxSteps = Math.max(1, parseInt(opts.maxSteps, 10) || 15);
      this.callModel = opts.callModel;
      this.executeTool = opts.executeTool;
      this.onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : null;
      this.messages = [];
      this.step = 0;
      this.running = false;
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

          let res;
          try {
            res = await this.callModel(this.messages, {
              signal,
              useNativeTools,
              step: this.step
            });
          } catch (err) {
            if (this._aborted(signal)) { stopReason = 'cancelled'; break; }
            error = err && err.message ? err.message : String(err);
            this._emit({ type: 'error', message: error, step: this.step });
            stopReason = 'model_error';
            break;
          }

          if (this._aborted(signal)) { stopReason = 'cancelled'; break; }
          if (!res) { stopReason = 'empty_response'; break; }

          if (res.error) {
            error = String(res.error);
            if (/cancel|destroy|socket|ECONNRESET|timed out/i.test(error) && this._aborted(signal)) {
              stopReason = 'cancelled';
              break;
            }
            this._emit({ type: 'error', message: error, step: this.step });
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
            finalText = clean;
            this.messages.push({ role: 'assistant', content: clean || '(no response)' });
            this._emit({ type: 'assistant', content: clean || '(no response)', reasoning, step: this.step });
            stopReason = 'done';
            break;
          }

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
        ok: stopReason === 'done',
        steps: this.step,
        stopReason,
        cancelled: stopReason === 'cancelled',
        finalText,
        messages: this.messages,
        error
      };
      this._emit({ type: 'done', result });
      return result;
    }

    _aborted(signal) {
      if (this.cancelReason) return true;
      return !!(signal && signal.aborted);
    }
  }

  const api = { AgentLoop, EVENT_TYPES };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.CloudAI = Object.assign(global.CloudAI || {}, { AgentLoop, loop: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);