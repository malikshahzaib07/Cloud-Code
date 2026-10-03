'use strict';
/**
 * AI backend HTTP client — dependency-free, Electron-free, testable.
 *
 * Extracted from the inline `https`/`http` handlers in `src/main/main.js`.
 * The transport (`http` / `https`) is injectable so plain Node tests can stub
 * `request()` without touching the network.
 *
 * Usage in the Electron main process:
 *   const { createAiClient } = require('./ai-engine/main/client');
 *   const ai = createAiClient({ baseUrl, apiKey, model });
 *   const res = await ai.chatOnce({ messages, tools });
 *   if (res.error) console.error(res.error);
 *
 * Usage in tests:
 *   const client = createAiClient({ baseUrl, apiKey, model, http: fakeHttp });
 */

// ---------------------------------------------------------------------------
// Small URL helper (exported — the renderer/protocol side needs the same rule).
// ---------------------------------------------------------------------------

/** True when `value` is an absolute http:// or https:// URL. */
function isHttpUrl(value) {
  try {
    const u = new URL(String(value));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

const DEFAULT_TIMEOUT_MS = 180000;
const ERROR_SNIPPET_LEN = 600;
const MASKS = '\u2022'; // "•"

/** Mask an API key for display: `abcd••••••••wxyz`. */
function maskApiKey(key) {
  const k = String(key || '');
  if (k.length > 8) return k.slice(0, 4) + MASKS.repeat(8) + k.slice(-4);
  return MASKS.repeat(8);
}

/**
 * Pull the payload out of a `<<<TOOL>>> … <<<END>>>` block.
 * `src/ai-engine/core/protocol.js` owns the real parser; require it
 * defensively so this module keeps working on its own.
 */
let externalParser = null;
try {
  // eslint-disable-next-line global-require
  const proto = require('../core/protocol');
  if (proto && typeof proto.parseToolPayload === 'function') externalParser = proto.parseToolPayload;
} catch (e) {
  externalParser = null;
}

/** Tolerant JSON repair: code fences, comments, trailing commas, truncation. */
function fallbackParseToolPayload(raw) {
  if (!raw) return null;
  let text = String(raw).trim();
  text = text.replace(/^```(?:json|jsonc)?\s*/i, '').replace(/```\s*$/, '').trim();
  text = text.replace(/\/\*[\s\S]*?\*\//g, '');           // block comments
  text = text.replace(/(^|[\s{[,])\/\/[^\n]*/g, '$1');    // line comments
  text = text.replace(/,\s*([}\]])/g, '$1');              // trailing commas

  try { return JSON.parse(text); } catch (e) { /* repair below */ }

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
  let s = false, e2 = false;
  for (let i = 0; i < core.length; i++) {
    const ch = core[i];
    if (e2) { e2 = false; continue; }
    if (ch === '\\') { e2 = true; continue; }
    if (ch === '"') s = !s;
  }
  const unclosedString = s;

  const attempts = [];
  if (unclosedString) attempts.push(core + '"');
  attempts.push(core + (unclosedString ? '"' : '') + '}'.repeat(Math.max(0, opens - closes)));
  attempts.push('{"name":"write_file","args":' + attempts[attempts.length - 1]); // truncated at top level

  for (const candidate of attempts) {
    try { return JSON.parse(candidate); } catch (e3) { /* next repair */ }
  }
  return null;
}

/**
 * Did a HTTP 400 reject the `tools` parameter (rather than something else)?
 * Servers word this many ways: "tools is not supported", "invalid schema for
 * function", "tool_choice", "reasoning", … We only retry when the body hints at
 * tool handling, so unrelated 400s fail fast instead of silently doubling the
 * round-trips.
 */
function looksLikeToolRejection(body) {
  const text = String(body || '').toLowerCase();
  if (!text) return false;
  return /\btools?\b|tool_calls|tool_choice|function calling|\bfunctions?\b|reasoning/.test(text);
}

/** Normalise an OpenAI-style `usage` object; returns undefined when absent. */
function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return undefined;
  const out = {};
  if (usage.prompt_tokens != null) out.prompt_tokens = Number(usage.prompt_tokens) || 0;
  if (usage.completion_tokens != null) out.completion_tokens = Number(usage.completion_tokens) || 0;
  if (usage.total_tokens != null) out.total_tokens = Number(usage.total_tokens) || 0;
  return Object.keys(out).length ? out : undefined;
}

function parseToolPayload(raw) {
  if (externalParser) {
    try { return externalParser(raw); } catch (e) { /* fall through */ }
  }
  return fallbackParseToolPayload(raw);
}

/**
 * Create a client instance.
 * @param {object}   [opts]
 * @param {string}   [opts.baseUrl]  e.g. https://host/v1
 * @param {string}   [opts.apiKey]
 * @param {string}   [opts.model]
 * @param {object}   [opts.http]     injected `http` module (falls back to node:http)
 * @param {object}   [opts.https]    injected `https` module (falls back to node:https)
 * @param {number}   [opts.timeoutMs] default 180000
 */
function createAiClient(opts = {}) {
  const nodeHttp = opts.http || require('http');
  const nodeHttps = opts.https || require('https');
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS;

  const config = {
    baseUrl: normalizeBaseUrl(opts.baseUrl) || '',
    apiKey: String(opts.apiKey || ''),
    model: String(opts.model || '')
  };

  const pending = new Set();   // every live request, for cancelAll()
  let streamReq = null;        // the current streaming request
  let streamHandle = null;     // its handle, so cancelAll() can mark it cancelled

  function normalizeBaseUrl(v) {
    return String(v || '').trim().replace(/\/+$/, '');
  }

  function transportFor(url) {
    return url.protocol === 'https:' ? nodeHttps : nodeHttp;
  }

  function track(req) {
    pending.add(req);
    return req;
  }

  function untrack(req) {
    pending.delete(req);
  }

  // -- config ---------------------------------------------------------------

  function getConfig() {
    return {
      baseUrl: config.baseUrl,
      apiKey: maskApiKey(config.apiKey),
      model: config.model,
      configured: isConfigured()
    };
  }

  /**
   * Patch the in-memory config. A masked key (containing "••") is ignored so
   * a round-trip through `getConfig()` cannot destroy the real key. Returns the
   * raw (unmasked) config so the host can persist it.
   */
  function setConfig(patch = {}) {
    const p = patch || {};
    if (p.baseUrl) config.baseUrl = normalizeBaseUrl(p.baseUrl);
    if (p.apiKey && !String(p.apiKey).includes(MASKS)) config.apiKey = String(p.apiKey).trim();
    if (p.model) config.model = String(p.model).trim();
    return getRawConfig();
  }

  function getRawConfig() {
    return { baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model };
  }

  function isConfigured() {
    return Boolean(config.baseUrl && isHttpUrl(config.baseUrl));
  }

  // -- low level request ----------------------------------------------------

  /**
   * Perform an HTTP request and buffer the whole response.
   * Resolves `{ statusCode, body }`; never rejects.
   */
  function requestBuffered({ method = 'GET', path, body = null, timeout = timeoutMs, headers = {}, signal }) {
    return new Promise((resolve) => {
      let settled = false;
      let req = null;
      const done = (value) => {
        if (settled) return;
        settled = true;
        if (req) untrack(req);
        resolve(value);
      };

      if (!isHttpUrl(config.baseUrl)) {
        return done({ error: `Invalid or missing base URL: ${config.baseUrl || '(none)'}` });
      }

      let url;
      try {
        url = new URL(path.startsWith('/') ? `${config.baseUrl}${path}` : `${config.baseUrl}/${path}`);
      } catch (e) {
        return done({ error: `Invalid request URL: ${e.message}` });
      }

      const client = transportFor(url);
      const payload = body === null ? null : Buffer.from(JSON.stringify(body));
      const finalHeaders = Object.assign({
        Authorization: `Bearer ${config.apiKey}`
      }, headers);
      if (payload) {
        finalHeaders['Content-Type'] = 'application/json';
        finalHeaders['Content-Length'] = payload.length;
      }

      try {
        req = track(client.request(url, { method, headers: finalHeaders, timeout }, (res) => {
          let text = '';
          res.on('data', (c) => { text += c; });
          res.on('end', () => done({ statusCode: res.statusCode, statusMessage: res.statusMessage, body: text }));
          res.on('error', (err) => done({ error: err.message }));
        }));
      } catch (e) {
        return done({ error: e.message });
      }

      req.on('error', (err) => done({ error: err.message }));
      req.on('timeout', () => {
        try { req.destroy(new Error(`AI request timed out (${Math.round(timeout / 1000)}s)`)); } catch (e) {}
      });
      if (signal) {
        if (signal.aborted) { try { req.destroy(); } catch (e) {} return done({ error: 'Aborted' }); }
        signal.addEventListener('abort', () => { try { req.destroy(); } catch (e) {} }, { once: true });
      }

      if (payload) {
        try { req.write(payload); } catch (e) { /* destroy triggers 'error' */ }
      }
      try { req.end(); } catch (e) { done({ error: e.message }); }
    });
  }

  // -- chatOnce -------------------------------------------------------------

  function buildChatBody({ model, messages, tools, temperature, maxTokens }, includeTools) {
    const body = {
      model: model || config.model,
      messages: Array.isArray(messages) ? messages : [],
      stream: false,
      temperature: temperature !== undefined ? temperature : 0.7
    };
    if (maxTokens) body.max_tokens = maxTokens;
    if (includeTools && Array.isArray(tools) && tools.length) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    return body;
  }

  async function chatOnce({ messages, tools, temperature, maxTokens, model, signal } = {}) {
    const args = { model, messages, tools, temperature, maxTokens };
    try {
      let res = await postChatOnce(args, true, signal);
      if (res.error && res.toolsRejected) {
        // Server rejected the `tools` parameter — retry once without it so the
        // text-protocol (<<<TOOL>>>) fallback can take over.
        res = await postChatOnce({ ...args, tools: null }, false, signal);
        if (!res.error) res.toolsRejected = true;
      }
      return res;
    } catch (err) {
      return { error: (err && err.message) || String(err), toolCalls: [], usedNativeTools: false };
    }
  }

  async function postChatOnce(args, includeTools, signal) {
    const body = buildChatBody(args, includeTools);
    const res = await requestBuffered({ method: 'POST', path: '/chat/completions', body, signal });
    if (res.error) {
      return { error: res.error, toolsRejected: false, toolCalls: [], usedNativeTools: false };
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      return {
        error: `HTTP ${res.statusCode}: ${String(res.body || '').slice(0, ERROR_SNIPPET_LEN)}`,
        toolsRejected: includeTools && res.statusCode === 400 && looksLikeToolRejection(res.body),
        toolCalls: [],
        usedNativeTools: false
      };
    }

    let parsed;
    try {
      parsed = JSON.parse(res.body);
    } catch (e) {
      return { error: `Invalid JSON response: ${e.message}`, toolCalls: [], usedNativeTools: false };
    }

    const choice = parsed && parsed.choices && parsed.choices[0];
    const msg = (choice && choice.message) || {};
    let content = typeof msg.content === 'string' ? msg.content : '';
    // Some local models stream their chain-of-thought in a separate field.
    const reasoning = String(msg.reasoning_content || msg.reasoning || msg.thinking || '');
    const toolCalls = [];
    let usedNativeTools = false;

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

    // Text-protocol fallback: <<<TOOL>>>{...}<<<END>>>
    if (!toolCalls.length) {
      const m = content.match(/<<<TOOL>>>\s*([\s\S]*?)\s*<<<END>>>/);
      if (m) {
        const j = parseToolPayload(m[1]);
        if (j) {
          toolCalls.push({
            id: `fb_${toolCalls.length}`,
            name: j.name || j.tool || '',
            arguments: j.args || j.arguments || j.parameters || {}
          });
          content = content.replace(m[0], '').trim();
        } else {
          content = content.replace(m[0], '').trim() +
            '\n\n\u26A0 Your tool call could not be parsed as JSON. Reply with ONLY:\n' +
            '<<<TOOL>>>\n{"name":"tool_name","args":{...}}\n<<<END>>>';
        }
      }
    }

    return {
      content,
      reasoning,
      toolCalls,
      usedNativeTools,
      finishReason: (choice && choice.finish_reason) || null,
      usage: normalizeUsage(parsed && parsed.usage),
      error: null
    };
  }

  // -- chatStream -----------------------------------------------------------

  /**
   * Start an SSE chat stream. Returns a handle with `cancel()`.
   * The returned handle is also exposed via `cancelStream()`.
   */
  function chatStream({ messages, temperature, maxTokens, model, onChunk, onEnd, onError, signal } = {}) {
    const emit = (fn, arg) => {
      if (typeof fn !== 'function') return;
      try { fn(arg); } catch (e) { /* consumer callback threw */ }
    };

    cancelStream();

    const body = {
      model: model || config.model,
      messages: Array.isArray(messages) ? messages : [],
      stream: true,
      temperature: temperature !== undefined ? temperature : 0.7
    };
    if (maxTokens) body.max_tokens = maxTokens;

    let finished = false;
    let req = null;
    let usage = null;

    const handle = {
      cancelled: false,
      cancel() {
        handle.cancelled = true;
        if (req) {
          try { req.destroy(); } catch (e) {}
          req = null;
        }
        streamReq = null;
        streamHandle = null;
        return true;
      }
    };

    const fail = (message) => {
      if (finished) return;
      finished = true;
      streamReq = null;
      if (!handle.cancelled) emit(onError, String(message));
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      streamReq = null;
      if (!handle.cancelled) emit(onEnd, usage);
    };

    if (!isHttpUrl(config.baseUrl)) {
      handle.ready = Promise.resolve();
      fail(`Invalid or missing base URL: ${config.baseUrl || '(none)'}`);
      return handle;
    }

    let url;
    try {
      url = new URL(`${config.baseUrl}/chat/completions`);
    } catch (e) {
      handle.ready = Promise.resolve();
      fail(`Invalid request URL: ${e.message}`);
      return handle;
    }

    const payload = Buffer.from(JSON.stringify(body));
    const client = transportFor(url);
    try {
      req = track(client.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Length': payload.length,
          Accept: 'text/event-stream'
        },
        timeout: timeoutMs
      }, (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          let errData = '';
          res.on('data', (d) => { errData += d; });
          res.on('end', () => {
            fail(`HTTP ${res.statusCode}: ${errData || res.statusMessage}`);
          });
          return;
        }

        let buffer = '';
        res.on('data', (chunk) => {
          buffer += chunk.toString('utf-8');
          const lines = buffer.split('\n');
          buffer = lines.pop();          // keep the trailing partial line
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(':')) continue;
            if (trimmed === 'data: [DONE]') { finish(); return; }
            if (!trimmed.startsWith('data:')) continue;
            const jsonStr = trimmed.slice(5).trim();
            try {
              const data = JSON.parse(jsonStr);
              const content = data.choices && data.choices[0] && data.choices[0].delta && data.choices[0].delta.content;
              if (content) emit(onChunk, content);
              if (data.usage) usage = normalizeUsage(data.usage) || usage;
            } catch (e) {
              // ignore non-JSON chunk lines
            }
          }
        });
        res.on('end', finish);
        res.on('error', (err) => fail(err.message));
      }));
    } catch (e) {
      handle.ready = Promise.resolve();
      fail(e.message);
      return handle;
    }

    streamReq = req;
    streamHandle = handle;
    req.on('error', (err) => {
      if (handle.cancelled) { finish(); return; }
      fail(err.message);
    });
    req.on('timeout', () => {
      try { req.destroy(new Error(`AI request timed out (${Math.round(timeoutMs / 1000)}s)`)); } catch (e) {}
      fail(`AI request timed out (${Math.round(timeoutMs / 1000)}s)`);
    });
    if (signal) {
      if (signal.aborted) handle.cancel();
      else signal.addEventListener('abort', () => handle.cancel(), { once: true });
    }

    try { req.write(payload); } catch (e) { /* destroy triggers 'error' */ }
    try { req.end(); } catch (e) { fail(e.message); }

    handle.ready = Promise.resolve();
    return handle;
  }

  function cancelStream() {
    if (streamHandle) streamHandle.cancelled = true;
    if (streamReq) {
      try { streamReq.destroy(); } catch (e) {}
      streamReq = null;
    }
    streamHandle = null;
  }

  // -- listModels -----------------------------------------------------------

  async function listModels({ timeout = 10000, signal } = {}) {
    try {
      const res = await requestBuffered({ method: 'GET', path: '/models', timeout, signal });
      if (res.error) return [];
      if (res.statusCode < 200 || res.statusCode >= 300) return [];
      const parsed = JSON.parse(res.body);
      const data = parsed && parsed.data;
      const list = Array.isArray(data) ? data : [];
      const ids = [];
      for (const m of list) {
        const id = typeof m === 'string' ? m : (m && m.id);
        if (id && !ids.includes(id)) ids.push(String(id));
      }
      return ids;
    } catch (e) {
      return [];
    }
  }

  // -- generateImage --------------------------------------------------------

  async function generateImage({ prompt, size, model, signal } = {}) {
    const p = String(prompt || '').trim();
    if (!p) return { error: 'A prompt is required.' };

    const body = {
      model: model || 'gpt-image-1',
      prompt: p,
      n: 1,
      size: size || '1024x1024',
      response_format: 'b64_json'
    };

    let res;
    try {
      res = await requestBuffered({ method: 'POST', path: '/images/generations', body, signal });
    } catch (e) {
      return { error: (e && e.message) || String(e) };
    }

    if (res.error) return { error: res.error };
    if (res.statusCode < 200 || res.statusCode >= 300) {
      return {
        error: `Image endpoint returned ${res.statusCode}. ` +
          'Your local server may not support image generation.'
      };
    }

    let parsed;
    try {
      parsed = JSON.parse(res.body);
    } catch (e) {
      return { error: `Could not parse the image response: ${e.message}` };
    }

    const first = parsed && parsed.data && parsed.data[0];
    if (first && first.b64_json) {
      return {
        dataUrl: `data:image/png;base64,${first.b64_json}`,
        revisedPrompt: first.revised_prompt || ''
      };
    }
    if (first && first.url) return { url: first.url };
    return { error: 'The response contained no image data.' };
  }

  // -- cancellation ---------------------------------------------------------

  function cancelAll() {
    cancelStream();
    for (const req of Array.from(pending)) {
      try { req.destroy(); } catch (e) {}
    }
    pending.clear();
    return true;
  }

  return {
    getConfig,
    getRawConfig,
    setConfig,
    isConfigured,
    chatOnce,
    chatStream,
    cancelStream,
    listModels,
    generateImage,
    cancelAll
  };
}

module.exports = {
  createAiClient,
  isHttpUrl,
  maskApiKey,
  parseToolPayload,
  fallbackParseToolPayload,
  looksLikeToolRejection,
  normalizeUsage,
  DEFAULT_TIMEOUT_MS
};