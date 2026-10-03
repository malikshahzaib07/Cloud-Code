'use strict';
/**
 * Plain-Node tests for src/ai-engine/main/client.js — no framework.
 *
 *   node src/ai-engine/test/client.test.js
 *
 * The transport is a fake `http`/`https` module whose `request()` we drive, so
 * nothing touches the network.
 */

const assert = require('assert');
const { createAiClient, isHttpUrl, maskApiKey } = require('../main/client');

// ---------------------------------------------------------------------------
// Tiny test harness
// ---------------------------------------------------------------------------
let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`FAIL  ${name}\n      ${err && err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Fake transport
// ---------------------------------------------------------------------------

class FakeResponse extends (require('events').EventEmitter) {
  constructor(statusCode, body, headers) {
    super();
    this.statusCode = statusCode;
    this.statusMessage = statusCode === 200 ? 'OK' : 'Error';
    this.headers = headers || {};
    this._body = body;
  }
  emitBody() {
    if (this._body !== null && this._body !== undefined) this.emit('data', Buffer.from(this._body));
    this.emit('end');
  }
}

/**
 * Builds a fake http/https module.
 * @param {(index:number, req:object, res:object)=>void} script  runs after
 *        `end()`; emit response data yourself.
 * @param {(index:number)=>number} [statusFor]  status code the response carries
 *        *before* the callback fires (real servers send it with the headers).
 */
function makeTransport(script, statusFor) {
  const calls = [];
  const mod = {
    request(url, options, cb) {
      const index = calls.length;   // 0-based request number, fixed at creation
      const req = new (require('events').EventEmitter)();
      req.url = url;
      req.options = options;
      req.method = options.method;
      req.index = index;
      req.written = [];
      req.ended = false;
      req.destroyed = false;
      req.write = (chunk) => { req.written.push(chunk.toString()); return true; };
      req.end = () => {
        req.ended = true;
        const res = new FakeResponse(statusFor ? statusFor(index) : 200, '');
        req.response = res;
        // A destroyed request tears down its socket, so nothing more arrives.
        const realEmit = res.emit.bind(res);
        res.emit = (...args) => (req.destroyed ? false : realEmit(...args));
        if (typeof cb === 'function') cb(res);
        Promise.resolve()
          .then(() => script(index, req, res))
          .catch((err) => {
            // A throwing script simulates a transport-level failure.
            if (!req.destroyed) req.emit('error', err);
          });
      };
      req.destroy = (err) => {
        if (req.destroyed) return;
        req.destroyed = true;
        req.emit('error', err || new Error('socket hang up'));
      };
      calls.push(req);
      return req;
    },
    calls
  };
  return mod;
}

/** Canned JSON response helper. */
function json(statusCode, obj) {
  return (index, req, res) => {
    res.statusCode = statusCode;
    res._body = JSON.stringify(obj);
    res.emitBody();
  };
}

const BASE = { baseUrl: 'http://localhost:1234/v1', apiKey: 'sk-secret-key-value', model: 'qwen-test' };

function newClient(transport, extra) {
  return createAiClient(Object.assign({}, BASE, { http: transport, https: transport }, extra || {}));
}

function bodyOf(req) {
  return JSON.parse(req.written.join(''));
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

async function run() {
  console.log('\nAI client tests');

  await test('isHttpUrl / maskApiKey helpers', () => {
    assert.strictEqual(isHttpUrl('http://a.b/v1'), true);
    assert.strictEqual(isHttpUrl('https://a.b'), true);
    assert.strictEqual(isHttpUrl('ws://a.b'), false);
    assert.strictEqual(isHttpUrl('nonsense'), false);
    assert.strictEqual(maskApiKey('abcd1234wxyz'), `abcd${'\u2022'.repeat(8)}wxyz`);
    assert.strictEqual(maskApiKey('short'), '\u2022'.repeat(8));
  });

  await test('getConfig masks the API key', () => {
    const c = newClient(makeTransport(json(200, {})));
    const cfg = c.getConfig();
    assert.strictEqual(cfg.apiKey, `sk-s${'\u2022'.repeat(8)}alue`);
    assert.ok(!cfg.apiKey.includes('secret'));
    assert.strictEqual(cfg.baseUrl, BASE.baseUrl);
    assert.strictEqual(cfg.model, BASE.model);
    assert.strictEqual(cfg.configured, true);
  });

  await test('setConfig trims trailing slashes and ignores masked keys', () => {
    const c = newClient(makeTransport(json(200, {})));
    c.setConfig({ baseUrl: '  https://host.example/v1///  ', model: '  m2 ' });
    assert.strictEqual(c.getConfig().baseUrl, 'https://host.example/v1');
    assert.strictEqual(c.getConfig().model, 'm2');
    c.setConfig({ apiKey: `sk-s${'\u2022'.repeat(8)}alue` }); // masked → ignored
    assert.strictEqual(c.getRawConfig().apiKey, BASE.apiKey);
    c.setConfig({ apiKey: 'new-key-123456' });
    assert.strictEqual(c.getRawConfig().apiKey, 'new-key-123456');
  });

  await test('isConfigured is false for a bad base URL', () => {
    assert.strictEqual(createAiClient({ baseUrl: 'not a url' }).isConfigured(), false);
    assert.strictEqual(createAiClient({ baseUrl: 'http://x/v1' }).isConfigured(), true);
  });

  // -- chatOnce ------------------------------------------------------------

  await test('chatOnce: request shape (method, URL, headers, body)', async () => {
    const t = makeTransport(json(200, { choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] }));
    const res = await newClient(t).chatOnce({
      messages: [{ role: 'user', content: 'yo' }],
      tools: [{ type: 'function', function: { name: 'read_file' } }],
      temperature: 0.2,
      maxTokens: 256
    });
    const req = t.calls[0];
    assert.strictEqual(req.method, 'POST');
    assert.strictEqual(req.url.toString(), 'http://localhost:1234/v1/chat/completions');
    assert.strictEqual(req.options.headers.Authorization, `Bearer ${BASE.apiKey}`);
    assert.strictEqual(req.options.headers['Content-Type'], 'application/json');
    assert.strictEqual(req.options.headers['Content-Length'], Buffer.byteLength(req.written.join('')));
    const body = bodyOf(req);
    assert.strictEqual(body.model, BASE.model);
    assert.strictEqual(body.stream, false);
    assert.strictEqual(body.temperature, 0.2);
    assert.strictEqual(body.max_tokens, 256);
    assert.strictEqual(body.tool_choice, 'auto');
    assert.deepStrictEqual(body.tools, [{ type: 'function', function: { name: 'read_file' } }]);
    assert.strictEqual(res.content, 'hi');
    assert.strictEqual(res.finishReason, 'stop');
    assert.strictEqual(res.error, null);
  });

  await test('chatOnce: native tool_calls are parsed (JSON-string arguments)', async () => {
    const t = makeTransport(json(200, {
      choices: [{
        message: {
          content: 'reading',
          reasoning_content: 'thinking hard',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"a.js","limit":10}' }
          }]
        },
        finish_reason: 'tool_calls'
      }]
    }));
    const res = await newClient(t).chatOnce({ messages: [] });
    assert.strictEqual(res.usedNativeTools, true);
    assert.strictEqual(res.toolCalls.length, 1);
    assert.strictEqual(res.toolCalls[0].id, 'call_1');
    assert.strictEqual(res.toolCalls[0].name, 'read_file');
    assert.deepStrictEqual(res.toolCalls[0].arguments, { path: 'a.js', limit: 10 });
    assert.strictEqual(res.reasoning, 'thinking hard');
    assert.strictEqual(res.finishReason, 'tool_calls');
  });

  await test('chatOnce: unparseable native arguments become { _raw }', async () => {
    const t = makeTransport(json(200, {
      choices: [{ message: { content: '', tool_calls: [{ function: { name: 'f', arguments: '{oops' } }] } }]
    }));
    const res = await newClient(t).chatOnce({ messages: [] });
    assert.deepStrictEqual(res.toolCalls[0].arguments, { _raw: '{oops' });
    assert.strictEqual(res.toolCalls[0].id, 'call_0');
  });

  await test('chatOnce: text-protocol fallback yields a cleaned tool call', async () => {
    const t = makeTransport(json(200, {
      choices: [{
        message: {
          content: 'Let me look.\n<<<TOOL>>>{"name":"read_file","args":{"path":"x.js"}}<<<END>>>\nDone.'
        }
      }]
    }));
    const res = await newClient(t).chatOnce({ messages: [] });
    assert.strictEqual(res.toolCalls.length, 1);
    assert.strictEqual(res.toolCalls[0].name, 'read_file');
    assert.deepStrictEqual(res.toolCalls[0].arguments, { path: 'x.js' });
    assert.strictEqual(res.usedNativeTools, false);
    assert.ok(!res.content.includes('<<<TOOL>>>'), 'content should have the block removed');
    assert.strictEqual(res.content, 'Let me look.\n\nDone.');
  });

  await test('chatOnce: HTTP 400 tool rejection retries exactly once without tools', async () => {
    const t = makeTransport((index, req, res) => {
      if (index === 0) {
        res.statusCode = 400;
        res._body = JSON.stringify({ error: { message: "tools is not supported" } });
        res.emitBody();
        return;
      }
      res._body = JSON.stringify({ choices: [{ message: { content: 'fallback answer' } }] });
      res.emitBody();
    });
    const res = await newClient(t).chatOnce({
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ type: 'function', function: { name: 'noop' } }]
    });
    assert.strictEqual(t.calls.length, 2, 'exactly two requests');
    assert.ok(bodyOf(t.calls[0]).tools, 'first attempt sent tools');
    assert.strictEqual(bodyOf(t.calls[1]).tools, undefined, 'retry must drop tools');
    assert.strictEqual(bodyOf(t.calls[1]).tool_choice, undefined);
    assert.strictEqual(res.content, 'fallback answer');
    assert.strictEqual(res.error, null);
    assert.strictEqual(res.toolsRejected, true);
  });

  await test('chatOnce: a 400 that is not a tool rejection does not retry', async () => {
    const t = makeTransport(json(400, { error: { message: 'bad request: too long' } }));
    const res = await newClient(t).chatOnce({ messages: [], tools: [{ type: 'function' }] });
    assert.strictEqual(t.calls.length, 1);
    assert.ok(res.error.startsWith('HTTP 400:'), res.error);
  });

  await test('chatOnce: non-2xx resolves with status code and body snippet (no throw)', async () => {
    const t = makeTransport((index, req, res) => {
      res.statusCode = 503;
      res._body = 'X'.repeat(2000);
      res.emitBody();
    });
    const res = await newClient(t).chatOnce({ messages: [] });
    assert.ok(res.error.includes('503'), res.error);
    assert.ok(res.error.length < 700, 'body snippet should be truncated');
    assert.ok(res.error.includes('XXXX'), 'snippet retains the start of the body');
  });

  await test('chatOnce: transport error resolves with an error field', async () => {
    const t = makeTransport(() => { throw new Error('ECONNREFUSED'); });
    const res = await newClient(t).chatOnce({ messages: [] });
    assert.strictEqual(res.error, 'ECONNREFUSED');
  });

  await test('chatOnce: invalid JSON body resolves with an error field', async () => {
    const t = makeTransport((index, req, res) => { res._body = 'not json'; res.emitBody(); });
    const res = await newClient(t).chatOnce({ messages: [] });
    assert.ok(res.error.startsWith('Invalid JSON response:'), res.error);
  });

  // -- chatStream ----------------------------------------------------------

  await test('chatStream: emits chunks, ends on [DONE], and sends the right request', async () => {
    const t = makeTransport((index, req, res) => {
      setTimeout(() => {
        res.emit('data', 'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
        res.emit('data', 'data: {"choices":[{"delta":{"content":"lo"}}]}\n');
        res.emit('data', ': comment\n\n');
        res.emit('data', 'data: not-json\n');
        res.emit('data', 'data: [DONE]\n\n');
        res.emit('end');
      }, 0);
    });
    const chunks = [];
    let ended = 0;
    const handle = newClient(t).chatStream({
      messages: [{ role: 'user', content: 'hey' }],
      temperature: 0.4,
      onChunk: (c) => chunks.push(c),
      onEnd: () => { ended++; }
    });
    await handle.ready;
    await new Promise((r) => setTimeout(r, 20));

    const req = t.calls[0];
    assert.strictEqual(req.method, 'POST');
    assert.strictEqual(req.url.toString(), 'http://localhost:1234/v1/chat/completions');
    assert.strictEqual(req.options.headers.Authorization, `Bearer ${BASE.apiKey}`);
    assert.strictEqual(req.options.headers['Content-Type'], 'application/json');
    const body = bodyOf(req);
    assert.strictEqual(body.stream, true);
    assert.strictEqual(body.temperature, 0.4);
    assert.strictEqual(body.model, BASE.model);
    assert.deepStrictEqual(chunks, ['Hel', 'lo']);
    assert.strictEqual(ended, 1);
    assert.strictEqual(handle.cancelled, false);
  });

  await test('chatStream: ends when the response stream ends without [DONE]', async () => {
    const t = makeTransport((index, req, res) => {
      setTimeout(() => { res.emit('data', 'data: {"choices":[{"delta":{"content":"x"}}]}\n'); res.emit('end'); }, 0);
    });
    let ended = 0;
    const handle = newClient(t).chatStream({ messages: [], onEnd: () => { ended++; } });
    await handle.ready;
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(ended, 1);
  });

  await test('chatStream: non-2xx calls onError with status + body', async () => {
    const t = makeTransport((index, req, res) => {
      res._body = 'no such endpoint';
      res.emitBody();
    }, () => 404);
    let err = null;
    const handle = newClient(t).chatStream({ messages: [], onError: (e) => { err = e; } });
    await handle.ready;
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(err && err.startsWith('HTTP 404:'), String(err));
    assert.ok(err.includes('no such endpoint'));
  });

  await test('chatStream: cancel() destroys the request and suppresses callbacks', async () => {
    const t = makeTransport((index, req, res) => {
      setTimeout(() => { res.emit('data', 'data: {"choices":[{"delta":{"content":"late"}}]}\n'); res.emit('end'); }, 5);
    });
    const chunks = [];
    let ended = 0, errs = 0;
    const handle = newClient(t).chatStream({
      messages: [],
      onChunk: (c) => chunks.push(c),
      onEnd: () => { ended++; },
      onError: () => { errs++; }
    });
    await handle.ready;
    assert.strictEqual(handle.cancel(), true);
    assert.strictEqual(t.calls[0].destroyed, true);
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(chunks.length, 0);
    assert.strictEqual(ended, 0);
    assert.strictEqual(errs, 0);
  });

  await test('chatStream: a second stream cancels the previous one', async () => {
    const t = makeTransport(() => {});
    const c = newClient(t);
    const first = c.chatStream({ messages: [] });
    c.chatStream({ messages: [] });
    assert.strictEqual(first.cancelled, true, 'the superseded handle is marked cancelled');
    assert.strictEqual(t.calls[0].destroyed, true);
    assert.strictEqual(t.calls[1].destroyed, false);
  });

  await test('cancelAll destroys every live request', async () => {
    // Requests that never respond stay pending until cancelAll() destroys them.
    const t = makeTransport(() => {});
    const c = newClient(t);
    let streamError = null;
    c.chatStream({ messages: [], onError: (e) => { streamError = e; } });
    const pending = c.chatOnce({ messages: [] });
    assert.strictEqual(t.calls.length, 2);
    assert.strictEqual(c.cancelAll(), true);
    const res = await pending;
    assert.ok(res.error, 'the in-flight chatOnce should settle with an error');
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(streamError, null, 'a cancelled stream reports nothing');
  });

  // -- listModels ----------------------------------------------------------

  await test('listModels: handles [{id}] and ["id"], de-duplicates', async () => {
    const t = makeTransport(json(200, { data: [{ id: 'a' }, { id: 'b' }, { id: 'a' }, 'c', { id: 'b' }] }));
    const models = await newClient(t).listModels();
    assert.deepStrictEqual(models, ['a', 'b', 'c']);
    assert.strictEqual(t.calls[0].method, 'GET');
    assert.strictEqual(t.calls[0].url.toString(), 'http://localhost:1234/v1/models');
    assert.strictEqual(t.calls[0].options.headers.Authorization, `Bearer ${BASE.apiKey}`);
  });

  await test('listModels: returns [] on HTTP failure', async () => {
    assert.deepStrictEqual(await newClient(makeTransport(json(500, {}))).listModels(), []);
  });

  await test('listModels: returns [] when the body is not JSON', async () => {
    const t = makeTransport((i, req, res) => { res._body = '<html/>'; res.emitBody(); });
    assert.deepStrictEqual(await newClient(t).listModels(), []);
  });

  await test('listModels: returns [] on a transport error', async () => {
    const t = makeTransport(() => { throw new Error('boom'); });
    assert.deepStrictEqual(await newClient(t).listModels(), []);
  });

  // -- generateImage -------------------------------------------------------

  await test('generateImage: returns a dataUrl for b64_json', async () => {
    const t = makeTransport(json(200, { data: [{ b64_json: 'QUJD', revised_prompt: 'a cat' }] }));
    const res = await newClient(t).generateImage({ prompt: 'a cat', size: '512x512' });
    assert.strictEqual(res.dataUrl, 'data:image/png;base64,QUJD');
    assert.strictEqual(res.revisedPrompt, 'a cat');
    const req = t.calls[0];
    assert.strictEqual(req.url.toString(), 'http://localhost:1234/v1/images/generations');
    assert.strictEqual(req.options.headers.Authorization, `Bearer ${BASE.apiKey}`);
    const body = bodyOf(req);
    assert.strictEqual(body.prompt, 'a cat');
    assert.strictEqual(body.size, '512x512');
    assert.strictEqual(body.n, 1);
    assert.strictEqual(body.response_format, 'b64_json');
  });

  await test('generateImage: returns url when the server gives a URL', async () => {
    const t = makeTransport(json(200, { data: [{ url: 'http://cdn/img.png' }] }));
    const res = await newClient(t).generateImage({ prompt: 'x' });
    assert.strictEqual(res.url, 'http://cdn/img.png');
    assert.strictEqual(res.dataUrl, undefined);
  });

  await test('generateImage: friendly error on 404 / unsupported', async () => {
    const t = makeTransport(json(404, { error: 'nope' }));
    const res = await newClient(t).generateImage({ prompt: 'x' });
    assert.ok(res.error.includes('Image endpoint returned 404'), res.error);
    assert.ok(res.error.includes('may not support image generation'), res.error);
  });

  await test('generateImage: requires a prompt and handles an empty payload', async () => {
    const noPrompt = await newClient(makeTransport(json(200, {}))).generateImage({ prompt: '   ' });
    assert.strictEqual(noPrompt.error, 'A prompt is required.');
    const empty = await newClient(makeTransport(json(200, { data: [] }))).generateImage({ prompt: 'x' });
    assert.strictEqual(empty.error, 'The response contained no image data.');
  });

  await test('generateImage: bad base URL resolves with an error instead of throwing', async () => {
    const c = createAiClient({ baseUrl: 'garbage', apiKey: 'k', http: makeTransport(json(200, {})) });
    const res = await c.generateImage({ prompt: 'x' });
    assert.ok(res.error.includes('Invalid or missing base URL'), res.error);
  });

  // -- summary -------------------------------------------------------------
  const total = passed + failures.length;
  console.log(`\n${passed}/${total} assertions passed`);
  if (failures.length) {
    for (const f of failures) console.error(`  - ${f.name}: ${f.err && f.err.stack}`);
    process.exitCode = 1;
  }
}

run().catch((err) => {
  console.error('Test harness crashed:', err);
  process.exitCode = 1;
});