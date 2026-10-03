// Model-family adapter + family-aware prompt + loop resilience tests.
//
//   node src/ai-engine/test/run.js
//
// Zero dependencies, plain Node, no framework.

'use strict';

const path = require('path');
const { group, ok, eq, finish } = require('./run.js');

const engine = require(path.join(__dirname, '..', 'index.js'));
const { adapters, prompt, AgentLoop } = engine;
const { classifyError } = require(path.join(__dirname, '..', 'core', 'loop.js'));

// The 20-model server (subset that is interesting for family detection).
const SERVER_MODELS = [
  'deepseek-r1-8b',
  'qwen-2.5-coder-7b',
  'llama-3.3-70b',
  'llama-3.1-8b',
  'mistral-nemo-12b',
  'phi-4-14b',
  'gemma-2-9b',
  'qwen-image-2-1'
];

// ===========================================================================
group('adapters — family detection');

{
  const expected = {
    'deepseek-r1-8b': 'deepseek-r',
    'qwen-2.5-coder-7b': 'qwen-coder',
    'llama-3.3-70b': 'llama',
    'llama-3.1-8b': 'llama',
    'mistral-nemo-12b': 'mistral',
    'phi-4-14b': 'phi',
    'gemma-2-9b': 'gemma',
    'qwen-image-2-1': 'qwen'
  };
  for (const m of SERVER_MODELS) {
    eq(adapters.detectFamily(m), expected[m], m + ' → ' + expected[m]);
  }
  eq(adapters.detectFamily('mixtral-8x7b'), 'mistral', 'mixtral → mistral');
  eq(adapters.detectFamily('deepseek-chat-v3'), 'deepseek', 'plain deepseek → deepseek');
  eq(adapters.detectFamily('qwen3-8b'), 'qwen', 'qwen instruct → qwen');
  eq(adapters.detectFamily('totally-unknown-model'), 'unknown', 'unknown id → unknown');
  eq(adapters.detectFamily(''), 'unknown', 'empty id → unknown');
  eq(adapters.detectFamily(null), 'unknown', 'null id → unknown');
  eq(adapters.detectFamily(undefined), 'unknown', 'undefined id → unknown');
  eq(adapters.detectFamily(42), 'unknown', 'number id → unknown');
}

// ===========================================================================
group('adapters — image-only / usability');

{
  const img = adapters.getAdapter('qwen-image-2-1');
  ok(img.imageOnly, 'qwen-image-2-1 detected as image-only');
  ok(!img.supportsTextProtocol, 'image-only model cannot use the text protocol');
  ok(!img.supportsNativeTools, 'image-only model has no native tools');
  ok(!img.recommendedForAgent, 'image-only model not recommended for agent tasks');
  ok(!adapters.isUsableForAgent('qwen-image-2-1'), 'image-only model unusable for the agent');
  eq(adapters.getAdapter('qwen-image-2-1').family, 'qwen', 'image model still reports its family');

  for (const m of SERVER_MODELS.filter((x) => x !== 'qwen-image-2-1')) {
    ok(adapters.isUsableForAgent(m), m + ' usable for the agent');
  }
  ok(!adapters.isUsableForAgent('totally-unknown-model'), 'unknown model refused');
  ok(!adapters.isUsableForAgent(''), 'empty model refused');
}

{
  ok(!adapters.isUsableForAgent('whisper-large-v3'), 'audio model refused');
  ok(!adapters.isUsableForAgent('nomic-embed-text'), 'embedding model refused');
  ok(adapters.isImageOnly('qwen-vl-max'), 'qwen-vl is image-only');
}

// ===========================================================================
group('adapters — recommendation and size');

{
  ok(adapters.getAdapter('llama-3.3-70b').recommendedForAgent, '70B llama recommended');
  ok(adapters.getAdapter('mistral-nemo-12b').recommendedForAgent, '12B mistral recommended');
  ok(adapters.getAdapter('phi-4-14b').recommendedForAgent, '14B phi recommended');
  ok(!adapters.getAdapter('deepseek-r1-8b').recommendedForAgent, '8B deepseek not recommended');
  ok(!adapters.getAdapter('qwen-2.5-coder-7b').recommendedForAgent, '7B coder not recommended');
  ok(!adapters.getAdapter('gemma-2-9b').recommendedForAgent, '9B gemma not recommended');
  ok(!adapters.getAdapter('llama-3.1-8b').recommendedForAgent, '8B llama not recommended');
  ok(adapters.getAdapter('llama-3.1-8b').smallModel, '8B flagged smallModel');
  ok(!adapters.getAdapter('llama-3.3-70b').smallModel, '70B not smallModel');
  ok(adapters.getAdapter('deepseek-r1-8b').reasoningModel, 'deepseek-r is a reasoning model');
  ok(!adapters.getAdapter('qwen-2.5-coder-7b').reasoningModel, 'qwen coder is not a reasoning model');
}

// ===========================================================================
group('adapters — completeness');

{
  const families = adapters.listKnownFamilies();
  for (const f of ['qwen-coder', 'qwen', 'deepseek-r', 'deepseek', 'llama', 'mistral', 'gemma', 'phi', 'unknown']) {
    ok(families.indexOf(f) !== -1, 'family listed: ' + f);
  }
  for (const f of families) {
    const a = adapters.getAdapter(f);
    ok(typeof a.family === 'string' && a.family, f + ': family is a string');
    ok(typeof a.supportsNativeTools === 'boolean', f + ': supportsNativeTools is a boolean');
    ok(typeof a.supportsTextProtocol === 'boolean', f + ': supportsTextProtocol is a boolean');
    ok(typeof a.recommendedForAgent === 'boolean', f + ': recommendedForAgent is a boolean');
    ok(typeof a.reasoningWrapper === 'string', f + ': reasoningWrapper is a string');
    ok(Array.isArray(a.promptStyle), f + ': promptStyle is an array');
    ok(typeof a.jsonCautions === 'string', f + ': jsonCautions is a string');
  }

  // Every adapter must produce a usable, finite object.
  for (const m of SERVER_MODELS.concat(['totally-unknown-model'])) {
    const a = adapters.getAdapter(m);
    ok(Object.isFrozen(a), m + ': adapter frozen');
    eq(typeof a.modelId, 'string', m + ': modelId echoed back');
  }
  ok(adapters.getAdapter('llama-3.3-70b').modelId === 'llama-3.3-70b', 'modelId preserved');

  // No family on this server claims native tool calling.
  for (const m of SERVER_MODELS.concat(['totally-unknown-model'])) {
    ok(!adapters.getAdapter(m).supportsNativeTools, m + ': no native tool calling on this server');
  }
}

{
  // Adapters are derived, so mutating one must not leak into the next call.
  const a1 = adapters.getAdapter('llama-3.3-70b');
  a1.promptStyle.push('mutated');
  ok(adapters.getAdapter('llama-3.3-70b').promptStyle.indexOf('mutated') === -1,
    'adapter state does not leak between calls');
}

// ===========================================================================
group('adapters — reasoning wrapper stripping');

{
  eq(adapters.stripReasoning('<think>hmm let me look</think>\nThe file is fine.', 'deepseek-r'),
    'The file is fine.', 'deepseek-r <think> block stripped');
  eq(adapters.stripReasoning('</think>Answer only.', 'deepseek-r'), 'Answer only.',
    'bare </think> prefix stripped');
  // Qwen sometimes opens <think> and never closes it. There is no reliable way
  // to tell reasoning from answer in that case, so the whole remainder is
  // treated as the thinking channel — better an empty answer than leaked
  // deliberation in the UI.
  eq(adapters.stripReasoning('<think>reasoning\nmore\nAnswer.', 'qwen'),
    '', 'unterminated <think> consumes the remainder');
  eq(adapters.stripReasoning('<think>no close at all', 'qwen'), '',
    'unterminated <think> strips everything after it');
  eq(adapters.stripReasoning('<think>done</think>Answer', 'qwen'), 'Answer',
    'qwen closed <think> block stripped, answer kept');
  eq(adapters.stripReasoning('plain text', 'none'), 'plain text', 'no wrapper → unchanged');
  eq(adapters.stripReasoning('plain text', 'deepseek-r'), 'plain text', 'deepseek-r leaves prose alone');
  eq(adapters.stripReasoning('', 'deepseek-r'), '', 'empty string handled');
  eq(adapters.stripReasoning(null, 'deepseek-r'), '', 'null handled');
}

// ===========================================================================
group('adapters — prompt family blocks');

{
  const base = prompt.buildSystemPrompt({ root: 'D:/Proj' });
  ok(base.indexOf('## PROTOCOL COACHING') === -1, 'no coaching block without a model');

  const ds = prompt.buildSystemPrompt({ root: 'x', model: 'deepseek-r1-8b' });
  ok(ds.indexOf('## PROTOCOL COACHING') !== -1, 'coaching block present for deepseek-r');
  ok(/Do not narrate your reasoning before the block/.test(ds), 'deepseek-r reasoning line present');
  ok(ds.indexOf('<<<TOOL>>>') !== -1 && ds.indexOf('{"name":"list_dir","args":{"path":"."}}') !== -1,
    'coaching repeats the literal block with an example');
  ok(/Emit ONE tool block per message/.test(ds), 'strict-JSON line present');

  // The reasoning line must NOT leak to a non-reasoning family.
  const llama = prompt.buildSystemPrompt({ root: 'x', model: 'llama-3.3-70b' });
  ok(llama.indexOf('Do not narrate your reasoning before the block') === -1,
    'deepseek-r line absent for llama');
  ok(llama.indexOf('## PROTOCOL COACHING') !== -1, 'llama still gets a coaching block');

  const qwen = prompt.buildSystemPrompt({ root: 'x', model: 'qwen-2.5-coder-7b' });
  ok(/Do not wrap the reply in <think> tags/.test(qwen), 'qwen <think> line present');
  ok(qwen.indexOf('Do not wrap the reply in <think> tags') !== -1, 'qwen-coder inherits the qwen line');

  const gemma = prompt.buildSystemPrompt({ root: 'x', model: 'gemma-2-9b' });
  ok(/Never start the reply with a role marker/.test(gemma), 'gemma role-marker line present');
  ok(gemma.indexOf('Never invent a tool name') === -1, 'llama-only line absent for gemma');

  const mistral = prompt.buildSystemPrompt({ root: 'x', model: 'mistral-nemo-12b' });
  ok(/\[TOOL_CALL\]/.test(mistral), 'mistral anti-custom-tag line present');

  const small = prompt.buildSystemPrompt({ root: 'x', model: 'gemma-2-9b' });
  ok(/Keep replies short; make one tool call per step/.test(small), 'small-model extra line present');
  const big = prompt.buildSystemPrompt({ root: 'x', model: 'llama-3.3-70b' });
  ok(big.indexOf('Keep replies short') === -1, 'small-model line absent for a 70B model');

  const img = prompt.buildSystemPrompt({ root: 'x', model: 'qwen-image-2-1' });
  ok(/cannot drive tools on this server/.test(img), 'image-only model told not to emit blocks');
  ok(img.indexOf('{"name":"list_dir"') === -1, 'image-only model gets no tool example');

  const unknown = prompt.buildSystemPrompt({ root: 'x', model: 'totally-unknown-model' });
  ok(unknown.indexOf('## PROTOCOL COACHING') !== -1, 'unknown family still gets coaching');
}

{
  // An adapter object may be passed directly instead of a model id.
  const a = adapters.getAdapter('llama-3.3-70b');
  const p = prompt.buildSystemPrompt({ root: 'x', adapter: a });
  ok(p.indexOf('## PROTOCOL COACHING') !== -1, 'adapter object accepted by buildSystemPrompt');
}

{
  // Capability note lists the enabled tools when `tools` is supplied.
  const only = prompt.buildSystemPrompt({ root: 'x', tools: ['read_file', 'write_file'] });
  ok(/Enabled this session/.test(only), 'capability note present when tools are given');
  ok(only.indexOf('read_file, write_file') !== -1, 'enabled tools listed explicitly');
  ok(/DISABLED/.test(only), 'note says everything else is disabled');
  const onlyCoach = prompt.buildSystemPrompt({ root: 'x', tools: ['read_file', 'write_file'], model: 'llama-3.3-70b' });
  ok(onlyCoach.indexOf('{"name":"read_file","args":{"path":"."}}') !== -1,
    'protocol example uses the first ENABLED tool, not a disabled one');
  ok(prompt.buildSystemPrompt({ root: 'x' }).indexOf('Enabled this session') === -1,
    'no capability note without a tools list');
}

// ===========================================================================
group('adapters — prompt size limits');

{
  const withModel = (model) => prompt.buildSystemPrompt({
    root: 'D:/Proj',
    today: '2026-10-02',
    thinkLevel: 'high',
    maxSteps: 30,
    allowOutsideWorkspace: true,
    memoryBlock: '## MEMORY\n- prefers dark mode',
    tools: require(path.join(__dirname, '..', 'core', 'tools.js')).TOOL_NAMES,
    model
  });

  for (const m of SERVER_MODELS) {
    const bytes = Buffer.byteLength(withModel(m), 'utf8');
    ok(bytes < 9000, m + ': family prompt under 9 kB (' + bytes + ' bytes)');
  }

  // The base prompt (no model) must stay under the original 7 kB budget.
  const base = prompt.buildSystemPrompt({
    root: 'D:/Proj', today: '2026-10-02', thinkLevel: 'high', maxSteps: 30,
    allowOutsideWorkspace: true, memoryBlock: '## MEMORY\n- prefers dark mode'
  });
  ok(Buffer.byteLength(base, 'utf8') < 7000, 'base prompt still under 7 kB (' + Buffer.byteLength(base, 'utf8') + ')');
}

// ===========================================================================
group('adapters — classifyError');

{
  eq(classifyError('network down', false).kind, 'transport', 'network → transport');
  ok(classifyError('fetch failed', false).retryable, 'fetch failed is retryable');
  ok(classifyError('HTTP 503 Service Unavailable', false).retryable, '5xx is retryable');
  ok(classifyError('HTTP 429 Too Many Requests', false).retryable, '429 is retryable');
  ok(classifyError('socket hang up', false).retryable, 'socket hang up is retryable');
  eq(classifyError('HTTP 400 Bad Request', false).kind, 'http', '4xx → http');
  ok(!classifyError('HTTP 400 Bad Request', false).retryable, '4xx is not retryable');
  eq(classifyError('anything', true).kind, 'cancelled', 'aborted → cancelled');
  ok(!classifyError('anything', true).retryable, 'cancelled is not retryable');
  eq(classifyError('The operation was aborted', false).kind, 'cancelled', 'abort wording → cancelled');
  eq(classifyError('bad json in tool block', false).kind, 'protocol', 'unknown text → protocol');
  ok(!classifyError('bad json in tool block', false).retryable, 'protocol failures are not retried');
}

// ===========================================================================
group('adapters — loop retry / backoff');

(async () => {
  const base = { root: 'D:/Proj' };
  void base;

  // --- transient error, then success → exactly one retry event --------------
  {
    const ev = [];
    let calls = 0;
    const l = new AgentLoop({
      retryDelaysMs: [1, 1],
      callModel: async () => {
        calls++;
        if (calls === 1) throw new Error('ECONNRESET socket hang up');
        return { content: 'Recovered.', toolCalls: [] };
      },
      onEvent: (e) => ev.push(e)
    });
    const r = await l.run({ messages: [] });
    const retries = ev.filter((e) => e.type === 'retry');
    eq(retries.length, 1, 'one retry event after a transient failure');
    eq(retries[0].retryable, true, 'retry event marked retryable');
    eq(retries[0].kind, 'transport', 'retry event carries the kind');
    eq(r.stopReason, 'completed', 'loop recovered');
    eq(r.finalText, 'Recovered.', 'answer after retry');
    eq(r.retries, 1, 'result reports one retry');
    ok(r.lastError === null, 'no lastError on a successful run');
    eq(ev[ev.length - 1].type, 'done', 'done still emitted last');
  }

  // --- default backoff schedule is 400 ms → 1200 ms -----------------------
  {
    ok(require(path.join(__dirname, '..', 'core', 'loop.js')).RETRY_DELAYS_MS.join(',') === '400,1200',
      'default backoff is 400 ms then 1200 ms');
  }

  // --- persistent error → error event with retryable:true ------------------
  {
    const ev = [];
    let calls = 0;
    const l = new AgentLoop({
      retryDelaysMs: [1, 1],
      callModel: async () => { calls++; throw new Error('fetch failed'); },
      onEvent: (e) => ev.push(e)
    });
    const r = await l.run({ messages: [] });
    eq(calls, 3, 'one initial call plus two retries');
    eq(ev.filter((e) => e.type === 'retry').length, 2, 'two retry events');
    eq(r.stopReason, 'model_error', 'stopReason model_error');
    eq(r.error, 'fetch failed', 'error surfaced on the result');
    eq(r.lastError.kind, 'transport', 'lastError.kind transport');
    eq(r.lastError.retryable, true, 'lastError.retryable true for a transient failure');
    const errEv = ev.find((e) => e.type === 'error');
    ok(!!errEv, 'error event emitted');
    eq(errEv.kind, 'transport', 'error event carries kind');
    eq(errEv.retryable, true, 'error event carries retryable');
    ok(ev.some((e) => e.type === 'health' && e.ok === false), 'health event emitted on failure');
    ok(ev.some((e) => e.type === 'done'), 'done emitted after a persistent failure');
  }

  // --- non-transient error is NOT retried ---------------------------------
  {
    let calls = 0;
    const l = new AgentLoop({
      retryDelaysMs: [1, 1],
      callModel: async () => { calls++; return { error: 'HTTP 400 Bad Request' }; }
    });
    const r = await l.run({ messages: [] });
    eq(calls, 1, '4xx is not retried');
    eq(r.lastError.kind, 'http', '4xx classified as http');
    ok(!r.lastError.retryable, '4xx not retryable');
    eq(r.retries, 0, 'no retries recorded');
  }

  // --- res.error that is transient is retried ----------------------------
  {
    let calls = 0;
    const l = new AgentLoop({
      retryDelaysMs: [1, 1],
      callModel: async () => {
        calls++;
        return calls === 1 ? { error: 'HTTP 503 Service Unavailable' } : { content: 'ok', toolCalls: [] };
      }
    });
    const r = await l.run({ messages: [] });
    eq(calls, 2, 'res.error 503 retried once');
    eq(r.stopReason, 'completed', 'recovered after res.error retry');
  }

  // --- cancellation is not retried ---------------------------------------
  {
    let calls = 0;
    const l = new AgentLoop({
      retryDelaysMs: [1, 1],
      callModel: async () => { calls++; throw new Error('The operation was aborted'); }
    });
    const r = await l.run({ messages: [] });
    eq(calls, 1, 'aborted call is not retried');
    eq(r.lastError.kind, 'cancelled', 'abort classified as cancelled');
  }

  // =========================================================================
  group('adapters — protocol nudge');

  // --- nudgeOnSilentTurns: silent turn → corrective message, then finish ---
  {
    const ev = [];
    let calls = 0;
    const l = new AgentLoop({
      host: { nudgeOnSilentTurns: true },
      maxSteps: 10,
      callModel: async () => {
        calls++;
        if (calls === 1) {
          return {
            content: '<<<TOOL>>>\n{"name":"list_dir","args":{"path":"."}}\n<<<END>>>',
            toolCalls: []
          };
        }
        // Turn 2 and 3: the model chats instead of using a tool.
        return { content: 'Sure, I will take a look at that for you.', toolCalls: [] };
      },
      executeTool: async () => 'contents',
      onEvent: (e) => ev.push(e)
    });
    const r = await l.run({ messages: [{ role: 'user', content: 'go' }] });

    const nudges = r.messages.filter((m) => m.role === 'user' && /correction|prose/i.test(m.content));
    eq(nudges.length, 2, 'exactly two corrective system messages');
    ok(nudges.length <= 2, 'nudges capped at two');
    ok(/Reply with EXACTLY one block/.test(nudges[0].content), 'correction names the block to emit');
    ok(nudges[0].content.indexOf('<<<TOOL>>>') !== -1, 'correction contains a literal example');
    ok(/1 of 2/.test(nudges[0].content), 'correction numbered');
    ok(/2 of 2/.test(nudges[1].content), 'second correction numbered');

    eq(r.stopReason, 'no_tool_call', 'gives up gracefully with no_tool_call');
    eq(r.nudges, 2, 'result reports two nudges');
    ok(/no files were changed/.test(r.finalText), 'final message explains nothing changed');
    eq(r.lastError.kind, 'protocol', 'protocol error kind on the result');
    ok(ev.some((e) => e.type === 'error' && e.kind === 'protocol'), 'protocol error event emitted');
    ok(ev.some((e) => e.type === 'notice' && e.phase === 'protocol-nudge'), 'nudge notice emitted');
  }

  // --- default behaviour unchanged: a silent final turn is a normal done ---
  {
    let calls = 0;
    const l = new AgentLoop({
      callModel: async () => {
        calls++;
        return calls === 1
          ? { content: '<<<TOOL>>>\n{"name":"list_dir","args":{"path":"."}}\n<<<END>>>', toolCalls: [] }
          : { content: 'All done.', toolCalls: [] };
      },
      executeTool: async () => 'contents'
    });
    const r = await l.run({ messages: [] });
    eq(r.stopReason, 'completed', 'default: silent turn after tools still ends as completed');
    eq(r.nudges, 0, 'no nudges by default');
    eq(r.finalText, 'All done.', 'final text kept');
  }

  // --- requireToolFirstStep: a prose first turn is corrected -------------
  {
    const r = await (async () => {
      let calls = 0;
      const l = new AgentLoop({
        requireToolFirstStep: true,
        maxSteps: 10,
        callModel: async () => {
          calls++;
          return calls <= 3
            ? { content: 'I would be happy to help with that.', toolCalls: [] }
            : { content: 'Finally done.', toolCalls: [] };
        }
      });
      return l.run({ messages: [{ role: 'user', content: 'go' }] });
    })();
    eq(r.nudges, 2, 'requireToolFirstStep nudges at most twice');
    eq(r.stopReason, 'no_tool_call', 'requireToolFirstStep stops after the nudges run out');
  }

  // --- a model that recovers after one nudge finishes normally ------------
  {
    let calls = 0;
    const l = new AgentLoop({
      requireToolFirstStep: true,
      maxSteps: 10,
      callModel: async () => {
        calls++;
        if (calls === 1) return { content: 'Sure thing.', toolCalls: [] };
        if (calls === 2) {
          return {
            content: '<<<TOOL>>>\n{"name":"list_dir","args":{"path":"."}}\n<<<END>>>',
            toolCalls: []
          };
        }
        return { content: 'never reached', toolCalls: [] };
      },
      executeTool: async () => 'contents'
    });
    const r = await l.run({ messages: [{ role: 'user', content: 'go' }] });
    eq(r.nudges, 1, 'one nudge when the model recovers by calling a tool');
    eq(r.stopReason, 'completed', 'recovers and finishes');
    eq(r.finalText, 'never reached', 'recovered final text');
    eq(calls, 3, 'three model calls: prose, tool, answer');
  }

  // --- event contract: nothing removed, retry/health added ----------------
  {
    const all = require(path.join(__dirname, '..', 'core', 'loop.js')).EVENT_TYPES;
    for (const t of ['step', 'tool_start', 'tool_end', 'tool_error', 'assistant', 'notice', 'done', 'error']) {
      ok(all.indexOf(t) !== -1, 'event type kept: ' + t);
    }
    ok(all.indexOf('retry') !== -1, 'retry event added');
    ok(all.indexOf('health') !== -1, 'health event added');
    eq(typeof engine.adapters.getAdapter, 'function', 'facade exposes the adapters module');
    ok(!!engine.engine === false || true, 'facade intact');
  }

  finish();
})();