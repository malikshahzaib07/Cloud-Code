// Cloud Code AI Engine — tool-call protocol.
//
// Pure parsing/formatting. No DOM, no Electron, no I/O. This module owns the
// hybrid tool protocol:
//   native  : OpenAI `tool_calls` on the assistant message
//   text    : <<<TOOL>>>\n{"name":"...","args":{...}}\n<<<END>>>   (fallback)
// and the tolerant-JSON recovery used for the fallback payloads.
//
// Behaviour is copied verbatim from src/main/main.js (`ai:chatOnce`) and the
// message helpers of src/renderer/js/agent.js.

(function (global) {
  'use strict';

  // ==========================================================================
  // Tolerant JSON for <<<TOOL>>> payloads
  // ==========================================================================

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

  // ==========================================================================
  // Native tool calls
  // ==========================================================================

  /**
   * Extract native OpenAI tool calls from a completion message.
   * `function.arguments` may be a JSON string or already an object.
   * @returns {{toolCalls: Array, usedNativeTools: boolean}}
   */
  function extractNativeToolCalls(message) {
    const msg = message && typeof message === 'object' ? message : {};
    const toolCalls = [];
    const list = Array.isArray(msg.tool_calls) ? msg.tool_calls
      : Array.isArray(msg.function_call) ? [{ id: msg.function_call.id, function: msg.function_call }] : null;
    if (list) {
      for (const tc of list) {
        if (!tc) continue;
        const fn = tc.function || tc;
        const raw = fn ? fn.arguments : undefined;
        let args = {};
        if (typeof raw === 'string') {
          try { args = JSON.parse(raw); } catch (e) { args = { _raw: raw }; }
        } else if (raw && typeof raw === 'object') {
          args = raw;
        }
        toolCalls.push({
          id: tc.id || `call_${toolCalls.length}`,
          name: (fn && fn.name) || '',
          arguments: args
        });
      }
    }
    return { toolCalls, usedNativeTools: toolCalls.length > 0 };
  }

  // ==========================================================================
  // Text-protocol fallback
  // ==========================================================================

  const TOOL_BLOCK_RE = /<<<TOOL>>>\s*([\s\S]*?)\s*<<<END>>>/;
  const TOOL_BLOCKS_RE = /<<<TOOL>>>[\s\S]*?<<<END>>>/g;

  /**
   * Extract the <<<TOOL>>> fallback block from message content.
   * @returns {{toolCalls: Array, content: string}} `content` is the assistant
   *   text with the block removed; when the payload cannot be parsed a short
   *   instruction asking the model to re-emit only the block is appended.
   */
  function extractTextToolCalls(content) {
    const text = typeof content === 'string' ? content : '';
    const m = text.match(TOOL_BLOCK_RE);
    if (!m) return { toolCalls: [], content: text };
    const j = parseToolPayload(m[1]);
    if (j) {
      return {
        toolCalls: [{
          id: `fb_${0}`,
          name: j.name || j.tool || '',
          arguments: j.args || j.arguments || j.parameters || {}
        }],
        content: text.replace(m[0], '').trim()
      };
    }
    return {
      toolCalls: [],
      content: text.replace(m[0], '').trim() +
        '\n\n⚠ Your tool call could not be parsed as JSON. Reply with ONLY:\n' +
        '<<<TOOL>>>\n{"name":"tool_name","args":{...}}\n<<<END>>>'
    };
  }

  /** Remove every text-protocol block from assistant content. */
  function stripToolBlocks(content) {
    return String(content == null ? '' : content).replace(TOOL_BLOCKS_RE, '').trim();
  }

  // ==========================================================================
  // Message formatting
  // ==========================================================================

  /** The assistant message to append for one model turn. */
  function formatAssistantTurn(opts) {
    const o = opts || {};
    const content = o.content || '';
    const toolCalls = Array.isArray(o.toolCalls) ? o.toolCalls : [];
    const usedNativeTools = o.usedNativeTools !== undefined
      ? !!o.usedNativeTools
      : !!(o.res && o.res.usedNativeTools);
    if (usedNativeTools) {
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

  /**
   * The message to append after one tool call: a native `tool` message, or a
   * <<<RESULT tool="…">>> user block for the text protocol.
   */
  function formatToolResult(opts) {
    const o = opts || {};
    const usedNativeTools = o.usedNativeTools !== undefined
      ? !!o.usedNativeTools
      : !!(o.res && o.res.usedNativeTools);
    const toolCall = o.toolCall || {};
    const text = o.text == null ? '' : String(o.text);
    if (usedNativeTools) {
      return { role: 'tool', tool_call_id: toolCall.id, content: text };
    }
    return { role: 'user', content: `<<<RESULT tool="${toolCall.name}">>>\n${text}\n<<<END>>>` };
  }

  // ==========================================================================
  // ASCII-decoration filter (agent-authored prose only)
  // ==========================================================================

  /** Characters that only ever appear in decorative ASCII art, never in prose. */
  const BOX_CHARS = /[\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2B00-\u2BFF\u2190-\u21FF]/;
  /** A line made exclusively of ASCII graphic/punctuation characters. */
  const ASCII_ART_LINE = /^[!-/:-@[-`{-~]{4,}$/;
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

  const api = {
    parseToolPayload,
    extractNativeToolCalls,
    extractTextToolCalls,
    stripToolBlocks,
    formatAssistantTurn,
    formatToolResult,
    stripAsciiDecoration,
    stripLeadingThinking,
    isDecorativeLine,
    condenseText
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.CloudAI = Object.assign(global.CloudAI || {}, { protocol: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);