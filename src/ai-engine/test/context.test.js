// Context budget, tool-result truncation and stopReason semantics.
//
//   node src/ai-engine/test/run.js

'use strict';

const path = require('path');
const { group, ok, eq, finish } = require('./run.js');

const engine = require(path.join(__dirname, '..', 'index.js'));
const { context, tools, AgentLoop } = engine;

(async () => {

  // =========================================================================
  group('context — estimation');

  eq(context.estimateTokens(''), 0, 'empty string is 0');
  eq(context.estimateTokens('abcd'), 1, '4 chars ≈ 1 token');
  eq(context.estimateTokens('a'.repeat(400)), 100, '400 chars ≈ 100 tokens');
  ok(context.measureMessages([{ role: 'user', content: 'a'.repeat(400) }]) >= 100,
    'message measure includes content');
  ok(context.measureMessages([{ role: 'tool', content: 'x'.repeat(400) }, { role: 'tool', content: 'y'.repeat(400) }]) >
    context.measureMessages([{ role: 'tool', content: 'x'.repeat(400) }]), 'measure sums messages');

  // =========================================================================
  group('context — trimMessages');

  {
    // A conversation whose tool results dwarf the budget.
    const big = 'x'.repeat(4000); // ~1000 tokens each
    const msgs = [
      { role: 'system', content: 'SYS'.repeat(50) },
      { role: 'user', content: 'original request' },
      { role: 'assistant', content: '', tool_calls: [{ id: '1', function: { name: 'list_dir', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: '1', content: big },
      { role: 'assistant', content: 'second call' },
      { role: 'tool', tool_call_id: '2', content: big },
      { role: 'assistant', content: 'third call' },
      { role: 'tool', tool_call_id: '3', content: big },
      { role: 'user', content: 'latest user request — never trimmed' }
    ];
    const r = context.trimMessages(msgs, { budget: 2000, keepRecent: 1, maxChars: 400 });
    ok(r.trimmed > 0, 'trimming happened');
    ok(r.estimatedTokens < context.measureMessages(msgs), 'estimate shrank');
    eq(r.messages[0], msgs[0], 'system prompt untouched (same content)');
    eq(r.messages[1], msgs[1], 'first user message untouched');
    eq(r.messages[r.messages.length - 1], msgs[msgs.length - 1], 'latest user request untouched');
    // newest tool result kept whole (keepRecent 1), older ones clipped
    eq(r.messages[7].content, big, 'most recent tool result kept whole');
    ok(/…\(truncated\)$/.test(r.messages[3].content), 'older tool result clipped with marker');
    ok(r.messages[3].content.length < 500, 'clipped to ~maxChars');
    ok(r.messages[5].content.length < 500, 'second-older also clipped');
  }

  {
    // Small conversation → nothing happens.
    const msgs = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'tool', tool_call_id: '1', content: 'short' }
    ];
    const r = context.trimMessages(msgs, { budget: 12000 });
    eq(r.trimmed, 0, 'no trim under the budget');
    eq(r.messages[2].content, 'short', 'content unchanged');
  }

  {
    // Text-protocol results are recognised and trimmed too.
    const msgs = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '<<<TOOL>>>\nx\n<<<END>>>' },
      { role: 'user', content: '<<<RESULT tool="list_dir">>>\n' + 'y'.repeat(3000) + '\n<<<END>>>' },
      { role: 'assistant', content: 'again' },
      { role: 'user', content: '<<<RESULT tool="read_file">>>\n' + 'z'.repeat(3000) + '\n<<<END>>>' },
      { role: 'user', content: 'latest' }
    ];
    const r = context.trimMessages(msgs, { budget: 1000, keepRecent: 1, maxChars: 300 });
    ok(r.trimmed >= 1, 'text-protocol tool result trimmed');
    ok(r.messages[3].content.indexOf('<<<END>>>') !== -1, 'RESULT wrapper preserved');
    eq(r.messages[5].content, msgs[5].content, 'newest RESULT kept whole');
    eq(r.messages[6].content, 'latest', 'latest user request intact');
  }

  {
    // The system prompt itself is never dropped even in a tiny budget.
    const msgs = [
      { role: 'system', content: 'S'.repeat(2000) },
      { role: 'user', content: 'hi' },
      { role: 'tool', tool_call_id: '1', content: 'T'.repeat(2000) }
    ];
    const r = context.trimMessages(msgs, { budget: 100, keepRecent: 0, maxChars: 120 });
    eq(r.messages[0].content, msgs[0].content, 'system kept');
    eq(r.messages[1].content, 'hi', 'user kept');
    ok(r.trimmed >= 1, 'tool result trimmed even in tiny budget');
  }

  // =========================================================================
  group('tools — truncateResult');

  {
    eq(tools.truncateResult('read_file', 'short'), 'short', 'small result untouched');
    const big = 'z'.repeat(200 * 1024); // 200 KB
    const out = tools.truncateResult('read_file', big);
    ok(out.length < 70 * 1024, 'read_file capped near 64 KB');
    ok(/…\(truncated — \d+ bytes omitted\)$/.test(out), 'truncation marker present');

    const outSearch = tools.truncateResult('search_code', big);
    ok(outSearch.length < 40 * 1024, 'search_code capped near 32 KB');

    const outCmd = tools.truncateResult('run_command', big);
    ok(outCmd.length < 40 * 1024, 'run_command capped near 32 KB');

    const outSmall = tools.truncateResult('delete_file', big);
    ok(outSmall.length < 8 * 1024, 'delete_file capped near 4 KB');

    eq(tools.truncateResult('unknown_tool', 'x'.repeat(40 * 1024)).length < 36 * 1024, true,
      'unknown tool falls back to 32 KB');
    eq(tools.truncateResult('read_file', null), '', 'null → empty string');
    eq(tools.truncateResult('read_file', 42), '42', 'non-string coerced');

    ok(typeof tools.MAX_RESULT_BYTES.read_file === 'number', 'MAX_RESULT_BYTES exported');
    for (const n of tools.TOOL_NAMES) {
      ok(typeof tools.MAX_RESULT_BYTES[n] === 'number' && tools.MAX_RESULT_BYTES[n] > 0,
        n + ' has a maxResultBytes budget');
      const f = tools.getTool(n).function;
      ok(f.maxResultBytes === tools.MAX_RESULT_BYTES[n], n + ' schema carries maxResultBytes');
    }
  }

  // =========================================================================
  group('loop — stopReason and trimmed');

  {
    // completed is distinct from no_tool_call and max_steps
    const r1 = await new AgentLoop({ callModel: async () => ({ content: 'done.', toolCalls: [] }) })
      .run({ messages: [] });
    eq(r1.stopReason, 'completed', 'final answer → completed');
    ok(r1.ok, 'completed runs are ok');
    eq(r1.trimmed, 0, 'no trimming recorded when unnecessary');
    let calls3 = 0;

    const r2 = await new AgentLoop({ maxSteps: 2, callModel: async () => ({ content: '', toolCalls: [{ id: 'a', name: 'x', arguments: {} }] }), executeTool: async () => 'ok' })
      .run({ messages: [] });
    eq(r2.stopReason, 'max_steps', 'step cap → max_steps');
    ok(['completed', 'max_steps', 'no_tool_call'].indexOf(r2.stopReason) !== -1, 'distinct reasons');

    const r3 = await new AgentLoop({
      host: { nudgeOnSilentTurns: true }, maxSteps: 6,
      callModel: async () => {
        calls3++;
        return calls3 === 1
          ? { content: '<<<TOOL>>>\n{"name":"list_dir","args":{"path":"."}}\n<<<END>>>', toolCalls: [] }
          : { content: 'prose', toolCalls: [] };
      },
      executeTool: async () => 'c'
    }).run({ messages: [{ role: 'user', content: 'go' }] });
    eq(r3.stopReason, 'no_tool_call', 'nudge exhaustion → no_tool_call');
  }

  {
    // The loop trims a bloated transcript and reports it before calling the model.
    const big = 'q'.repeat(4000);
    const ev = [];
    let seenBudget = null;
    const turns = [
      { content: 'one', toolCalls: [{ id: '1', name: 'list_dir', arguments: {} }], usedNativeTools: true },
      { content: 'two', toolCalls: [{ id: '2', name: 'read_file', arguments: {} }], usedNativeTools: true },
      { content: 'final', toolCalls: [], usedNativeTools: true }
    ];
    const loop = new AgentLoop({
      context: { budget: 1200, keepRecent: 1, maxChars: 300 },
      callModel: async (m) => {
        if (turns.length === 1) seenBudget = context.measureMessages(m);
        return turns.shift();
      },
      executeTool: async (tc) => 'r:' + tc.name + big,
      onEvent: (e) => ev.push(e)
    });
    const r = await loop.run({ messages: [{ role: 'user', content: 'work' }], systemPrompt: 'S' });
    eq(r.stopReason, 'completed', 'completes after trimming');
    ok(r.trimmed > 0, 'result reports trimmed count');
    ok(ev.some((e) => e.type === 'notice' && /trimmed/i.test(e.text || '')), 'trim notice emitted');
    ok(seenBudget !== null && seenBudget < 3000, 'budget applied before the last model call (' + seenBudget + ')');
    // the budget trimmed the older duplication; the newest result survived
    const toolMsgs = r.messages.filter((m) => m.role === 'tool');
    ok(toolMsgs.length === 2, 'two tool results recorded');
    ok(toolMsgs[0].content.length < 500, 'older result clipped to ~maxChars');
    eq(toolMsgs[1].content, 'r:read_file' + big, 'newest result kept whole');
  }

  {
    // truncateResult is wired into the loop: a huge tool output is clipped
    // before it enters the transcript.
    let captured = null;
    const loop = new AgentLoop({
      callModel: async (m) => {
        captured = m;
        return m.length > 2
          ? { content: 'ok', toolCalls: [] }
          : { content: 'go', toolCalls: [{ id: '1', name: 'run_command', arguments: {} }], usedNativeTools: true };
      },
      executeTool: async () => 'w'.repeat(100 * 1024)
    });
    const r = await loop.run({ messages: [] });
    const toolMsg = r.messages.find((m) => m.role === 'tool');
    ok(toolMsg.content.length < 40 * 1024, 'loop clips run_command output to 32 KB');
    ok(/truncated/.test(toolMsg.content), 'marker present in transcript');
    ok(captured[2] && captured[2].content.length < 40 * 1024, 'model received the clipped result');
  }

  {
    // facade exposes context + truncateResult + per-tool maxResultBytes
    ok(!!engine.context && typeof engine.context.trimMessages === 'function', 'facade exposes context');
    ok(typeof engine.tools.truncateResult === 'function', 'facade exposes truncateResult via tools');
  }

  finish();
})();
