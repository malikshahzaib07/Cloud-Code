// Cloud Code AI Engine — context budget manager.
//
// Keeps the conversation small enough for the ~8k-context local models:
//   * estimates the size of the transcript (chars/4 heuristic),
//   * when the estimate exceeds a configurable budget, truncates old tool
//     results (newest N tool results are always kept whole),
//   * never touches the system prompt or the latest user request.
//
// Pure and DOM-free. In the browser it registers window.CloudAI.context;
// in Node: require('./core/context.js').

(function (global) {
  'use strict';

  const DEFAULT_BUDGET = 12000;   // estimated tokens
  const DEFAULT_KEEP_RECENT = 2;  // newest tool results kept intact
  const DEFAULT_MAX_CHARS = 400;  // truncation size for older tool results
  const TRUNCATED_MARK = '…(truncated)';

  /** Rough token estimate for one string: chars/4, minimum 1. */
  function estimateTokens(text) {
    const s = text == null ? '' : String(text);
    if (!s) return 0;
    return Math.max(1, Math.ceil(s.length / 4));
  }

  /** Rough token estimate of one message (content + tool_call payload). */
  function estimateMessageTokens(m) {
    if (!m || typeof m !== 'object') return 0;
    let size = 0;
    if (m.content != null) size += String(m.content).length;
    if (Array.isArray(m.tool_calls)) {
      try { size += JSON.stringify(m.tool_calls).length; } catch (e) { /* ignore */ }
    }
    return Math.max(1, Math.ceil(size / 4)) + 4; // +4 per-message overhead
  }

  /** Total estimated tokens for a transcript. */
  function measureMessages(messages) {
    let total = 0;
    for (const m of (messages || [])) total += estimateMessageTokens(m);
    return total;
  }

  /** True for messages that carry tool output back to the model. */
  function isToolResult(m) {
    if (!m || typeof m !== 'object') return false;
    if (m.role === 'tool') return true;
    // text-protocol results arrive as user messages: <<<RESULT tool="…">>>
    if (m.role === 'user' && typeof m.content === 'string' &&
        /^\s*<<<RESULT\s+tool=/.test(m.content)) return true;
    return false;
  }

  /** Index of the latest genuine user request (never trimmed). */
  function latestUserIndex(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m && m.role === 'user' && !isToolResult(m)) return i;
    }
    return -1;
  }

  function truncateText(text, maxChars) {
    let s = String(text == null ? '' : text);
    if (s.endsWith(TRUNCATED_MARK)) s = s.slice(0, s.length - TRUNCATED_MARK.length);
    if (s.length <= maxChars) return s;
    return s.slice(0, maxChars) + TRUNCATED_MARK;
  }

  /** Truncate a tool-result message in place-style (returns a new object). */
  function truncateToolMessage(m, maxChars) {
    if (m.role === 'tool') {
      return Object.assign({}, m, { content: truncateText(m.content, maxChars) });
    }
    // text-protocol: <<<RESULT tool="x">>>\n…\n<<<END>>>
    const mm = String(m.content).match(/^(\s*<<<RESULT\s+tool="[^"]*">>>\s*\n?)([\s\S]*?)(\n?\s*<<<END>>>\s*)$/);
    if (mm) {
      return Object.assign({}, m, { content: mm[1] + truncateText(mm[2], maxChars) + mm[3] });
    }
    return Object.assign({}, m, { content: truncateText(m.content, maxChars) });
  }

  /**
   * trimMessages(messages, opts)
   *
   * @param {Array}  messages
   * @param {object} [o]
   * @param {number} [o.budget=12000]     token budget (chars/4 estimate)
   * @param {number} [o.keepRecent=2]     newest tool results kept whole
   * @param {number} [o.maxChars=400]     truncation size for older results
   * @returns {{ messages: Array, trimmed: number, estimatedTokens: number }}
   */
  function trimMessages(messages, o) {
    const opts = o || {};
    const budget = Number.isFinite(opts.budget) ? opts.budget : DEFAULT_BUDGET;
    const keepRecent = Math.max(0, opts.keepRecent == null ? DEFAULT_KEEP_RECENT : opts.keepRecent | 0);
    const maxChars = Math.max(80, Number.isFinite(opts.maxChars) ? opts.maxChars : DEFAULT_MAX_CHARS);

    const list = Array.isArray(messages) ? messages.slice() : [];
    const before = measureMessages(list);
    if (before <= budget) {
      return { messages: list, trimmed: 0, estimatedTokens: before };
    }

    // Tool-result indices, oldest first.
    const trIdx = [];
    for (let i = 0; i < list.length; i++) if (isToolResult(list[i])) trIdx.push(i);
    const protectedIdx = latestUserIndex(list);

    let trimmed = 0;
    const counted = new Set();
    const clip = (arr, n) => {
      for (const i of arr) {
        if (i === protectedIdx) continue;
        if (counted.has(i)) {
          out[i] = truncateToolMessage(out[i], n); // shrink further
          continue;
        }
        out[i] = truncateToolMessage(out[i], n);
        counted.add(i);
        trimmed++;
      }
    };
    const out = list.slice();

    // Pass 1: truncate tool results older than the most recent `keepRecent`.
    clip(trIdx.slice(0, Math.max(0, trIdx.length - keepRecent)), maxChars);
    if (measureMessages(out) <= budget) {
      return { messages: out, trimmed, estimatedTokens: measureMessages(out) };
    }

    // Pass 2: still over budget — also clip the recent tool results except
    // the newest one.
    clip(trIdx.slice(Math.max(0, trIdx.length - keepRecent), -1), maxChars);
    if (measureMessages(out) <= budget) {
      return { messages: out, trimmed, estimatedTokens: measureMessages(out) };
    }

    // Pass 3: last resort — clip the newest tool result too, but never the
    // system prompt or the latest user request.
    clip(trIdx, Math.max(120, Math.floor(maxChars / 2)));
    return { messages: out, trimmed, estimatedTokens: measureMessages(out) };
  }

  const api = {
    estimateTokens,
    estimateMessageTokens,
    measureMessages,
    isToolResult,
    trimMessages,
    DEFAULT_BUDGET,
    DEFAULT_KEEP_RECENT,
    DEFAULT_MAX_CHARS,
    TRUNCATED_MARK
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.CloudAI = Object.assign(global.CloudAI || {}, { context: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);
