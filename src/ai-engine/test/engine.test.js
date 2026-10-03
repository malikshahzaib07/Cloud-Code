// Cloud AI engine test suite.
//
//   node src/ai-engine/test/run.js
//
// Zero dependencies, plain Node, no framework.

'use strict';

const path = require('path');
const { group, ok, eq, throws, finish } = require('./run.js');

const engine = require(path.join(__dirname, '..', 'index.js'));
const { protocol, tools, prompt, AgentLoop } = engine;

// ===========================================================================
group('protocol — native tool calls');

{
  const r = protocol.extractNativeToolCalls({
    role: 'assistant',
    content: '',
    tool_calls: [{
      id: 'call_0',
      type: 'function',
      function: { name: 'read_file', arguments: '{"path":"a.js"}' }
    }]
  });
  ok(r.usedNativeTools, 'usedNativeTools true');
  eq(r.toolCalls, [{ id: 'call_0', name: 'read_file', arguments: { path: 'a.js' } }],
    'arguments parsed from a JSON string');
}

{
  const r = protocol.extractNativeToolCalls({
    tool_calls: [{ id: 'x', function: { name: 'list_dir', arguments: { path: '.' } } }]
  });
  eq(r.toolCalls[0].arguments, { path: '.' }, 'arguments passed through as an object');
  ok(r.usedNativeTools, 'usedNativeTools true (object args)');
}

{
  const r = protocol.extractNativeToolCalls({ content: 'hi' });
  eq(r.toolCalls, [], 'no tool calls');
  ok(r.usedNativeTools === false, 'usedNativeTools false');
}

{
  const r = protocol.extractNativeToolCalls({
    tool_calls: [{ function: { name: 'read_file', arguments: 'not json {' } }]
  });
  eq(r.toolCalls[0].arguments, { _raw: 'not json {' }, 'unparseable args kept raw');
  ok(/^call_/.test(r.toolCalls[0].id), 'synthesised id');
}

// ===========================================================================
group('protocol — text protocol');

{
  const r = protocol.extractTextToolCalls(
    'Let me look.\n<<<TOOL>>>\n{"name":"list_dir","args":{"path":"src"}}\n<<<END>>>\nbye'
  );
  eq(r.toolCalls, [{ id: 'fb_0', name: 'list_dir', arguments: { path: 'src' } }],
    'block parsed into a tool call');
  ok(r.content.indexOf('<<<TOOL>>>') === -1, 'block removed from content');
  ok(r.content.indexOf('Let me look.') === 0, 'prose kept');
}

{
  const r = protocol.extractTextToolCalls('<<<TOOL>>>\nI refuse to emit JSON\n<<<END>>>');
  eq(r.toolCalls, [], 'unparseable payload yields no tool call');
  ok(/could not be parsed as JSON/.test(r.content), 'instruction appended');
  ok(r.content.indexOf('Reply with ONLY') !== -1, 're-emit instruction present');
  ok(r.content.indexOf('I refuse') === -1, 'broken payload and block removed');
}

{
  const r = protocol.extractTextToolCalls('plain answer');
  eq(r.toolCalls, [], 'no block → no tool calls');
  eq(r.content, 'plain answer', 'content untouched');
}

// ===========================================================================
group('protocol — tolerant JSON');

{
  eq(protocol.parseToolPayload('{"name":"a","args":{"p":1}}'), { name: 'a', args: { p: 1 } }, 'plain JSON');
  eq(protocol.parseToolPayload('```json\n{"name":"a"}\n```'), { name: 'a' }, 'fenced JSON');
  eq(protocol.parseToolPayload('{/* c */"name":"a"}'), { name: 'a' }, 'block comment stripped');
  eq(protocol.parseToolPayload('{"name":"a", // x\n "args":{}}'), { name: 'a', args: {} }, 'line comment stripped');
  eq(protocol.parseToolPayload('{"name":"a","args":{"p":1,},}'), { name: 'a', args: { p: 1 } }, 'trailing commas');
  eq(protocol.parseToolPayload('{"name":"a","args":{"p":1'), { name: 'a', args: { p: 1 } },
    'truncated braces balanced');
  eq(protocol.parseToolPayload('{"name":"a","args":{"p":"trunc'), { name: 'a', args: { p: 'trunc' } },
    'unclosed string closed');
  eq(protocol.parseToolPayload('{"path":"a.js","content":"x'), { path: 'a.js', content: 'x' },
    'top-level truncation repaired');
  eq(protocol.parseToolPayload('no json here'), null, 'unparseable → null');
  eq(protocol.parseToolPayload(''), null, 'empty → null');
  eq(protocol.parseToolPayload(null), null, 'null → null');
}

// ===========================================================================
group('protocol — message formatting');

{
  const m = protocol.formatToolResult({
    usedNativeTools: true,
    toolCall: { id: 'c1', name: 'read_file' },
    text: 'body'
  });
  eq(m, { role: 'tool', tool_call_id: 'c1', content: 'body' }, 'native tool message');
}

{
  const m = protocol.formatToolResult({
    usedNativeTools: false,
    toolCall: { id: 'fb_0', name: 'read_file' },
    text: 'body'
  });
  eq(m, { role: 'user', content: '<<<RESULT tool="read_file">>>\nbody\n<<<END>>>' },
    'text-protocol result message');

  // `res` is accepted as an alias for `usedNativeTools`, like the app used to.
  eq(protocol.formatToolResult({ res: { usedNativeTools: true }, toolCall: { id: 'c1' }, text: 'x' }).role,
    'tool', 'res.usedNativeTools alias honoured');
}

{
  const m = protocol.formatAssistantTurn({
    usedNativeTools: true,
    content: 'hi',
    toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'a.js' } }]
  });
  eq(m.role, 'assistant', 'native turn role');
  eq(m.content, 'hi', 'native turn content');
  eq(m.tool_calls[0].function, { name: 'read_file', arguments: '{"path":"a.js"}' }, 'native turn tool call');

  const t = protocol.formatAssistantTurn({
    usedNativeTools: false,
    content: 'planning',
    toolCalls: [{ id: 'fb_0', name: 'read_file', arguments: { path: 'a.js' } }]
  });
  eq(t.content, 'planning\n\n<<<TOOL>>>\n{"name":"read_file","args":{"path":"a.js"}}\n<<<END>>>',
    'text-protocol turn content');
}

// ===========================================================================
group('protocol — ASCII decoration filter');

{
  const text = [
    'Here is a diagram:',
    '',
    '```mermaid',
    'graph TD;',
    'A-->B;',
    '```',
    '',
    'And a table:',
    '',
    '| a | b |',
    '|---|---|',
    '| 1 | 2 |'
  ].join('\n');
  const out = protocol.stripAsciiDecoration(text);
  ok(out.indexOf('graph TD') === -1, 'mermaid fence body removed');
  ok(out.indexOf('| 1 | 2 |') !== -1, 'markdown table kept');
  ok(out.indexOf('|---|---|') !== -1, 'markdown table separator kept');
  ok(/Here is a diagram/.test(out), 'prose kept');
}

{
  const out = protocol.stripAsciiDecoration([
    'Intro line',
    '───────────────',
    '████ 60% ████ 30%',
    '+-----+-----+',
    '●●●●●●',
    '~~~~~~',
    'Final sentence.'
  ].join('\n'));
  eq(out.split('\n').filter(Boolean), ['Intro line', 'Final sentence.'],
    'box drawing / bars / borders / bullets removed, prose kept');
}

{
  const src = '```js\nconst a = 1;\n```';
  eq(protocol.stripAsciiDecoration(src), src, 'normal code fence untouched');
}

{
  eq(protocol.condenseText('a\n\n  b\tc', 100), 'a b c', 'condense collapses whitespace');
  eq(protocol.condenseText('x'.repeat(50), 10), 'x'.repeat(10), 'condense clamps length');
  eq(protocol.condenseText(null), '', 'condense null → empty');
}

// ===========================================================================
group('tools — schemas');

{
  eq(tools.TOOL_NAMES.length, 16, '16 tools registered');
  for (const t of tools.TOOLS) {
    const f = t.function || {};
    ok(typeof f.name === 'string' && f.name, f.name + ': has name');
    ok(typeof f.description === 'string' && f.description.length > 10, f.name + ': has description');
    ok(f.parameters && f.parameters.type === 'object', f.name + ': has object parameters');
  }
  eq(tools.TOOL_NAMES, [
    'list_dir', 'read_file', 'list_tree', 'find_files', 'search_code', 'edit_file',
    'write_file', 'delete_file', 'move_file', 'run_command', 'read_files',
    'delete_files', 'move_files', 'read_env', 'remember', 'recall'
  ], 'tool names in schema order');
  for (const n of tools.TOOL_NAMES) {
    ok(!!tools.TOOL_ICONS[n], n + ': has an icon');
    ok(!!tools.TOOL_TITLES[n], n + ': has a title');
  }
}

// ===========================================================================
group('tools — normalizeArgs');

{
  eq(tools.normalizeArgs('read_file', { file: 'a.js' }).path, 'a.js', 'file → path');
  eq(tools.normalizeArgs('read_file', { filename: 'a.js' }).path, 'a.js', 'filename → path');
  eq(tools.normalizeArgs('read_file', { file_path: 'a.js' }).path, 'a.js', 'file_path → path');
  eq(tools.normalizeArgs('write_file', { text: 'body' }).content, 'body', 'text → content');
  eq(tools.normalizeArgs('edit_file', { find: 'x' }).old_string, 'x', 'find → old_string');
  eq(tools.normalizeArgs('search_code', { pattern: 'foo' }).query, 'foo', 'pattern → query');
  eq(tools.normalizeArgs('run_command', { cmd: 'npm test' }).command, 'npm test', 'cmd → command');
}

{
  eq(tools.normalizeArgs('edit_file', { replace_all: 'true' }).replace_all, true, '"true" → true');
  eq(tools.normalizeArgs('edit_file', { replace_all: 'no' }).replace_all, false, '"no" → false');
  eq(tools.normalizeArgs('read_file', { start_line: '12' }).start_line, 12, '"12" → number');
  const r = tools.normalizeArgs('read_file', { lines: '10-40' });
  eq([r.start_line, r.end_line], [10, 40], '"10-40" → line range');
  eq(tools.normalizeArgs('read_file', { lines: 7 }).start_line, 7, 'numeric "lines" → start_line');
}

{
  eq(tools.normalizeArgs('read_file', { arguments: '{"path":"nested.js"}' }).path, 'nested.js',
    'nested JSON string arguments merged');
  eq(tools.normalizeArgs('read_file', { arguments: { path: 'obj.js' } }).path, 'obj.js',
    'nested object arguments merged');
  eq(tools.normalizeArgs('read_file', { arguments: '{trunc' }).path, undefined,
    'unparseable nested arguments ignored');
}

{
  const m = tools.normalizeArgs('move_file', { target: 'a.js', dest: 'b.js', force: 'yes' });
  eq([m.path, m.to, m.overwrite], ['a.js', 'b.js', true], 'move_file from/target/force');
  eq(tools.normalizeArgs('delete_files', { files: 'a.js,b.js' }).paths, ['a.js', 'b.js'],
    'delete_files splits a string list');
  eq(tools.normalizeArgs('delete_files', { target: 'old', glob: '*.log' }).glob, '*.log',
    'delete_files glob alias');
  eq(tools.normalizeArgs('find_files', { in: 'src', max: 5 }).path, 'src', 'find_files "in" → path');
  eq(tools.normalizeArgs('find_files', { max: 5 }).limit, 5, 'find_files "max" → limit');
  eq(tools.normalizeArgs('remember', { fact: 'likes tabs', tags: 'prefs, build' }).tags,
    ['prefs', 'build'], 'remember tags split');
  eq(tools.normalizeArgs('remember', { fact: 'x' }).text, 'x', 'remember fact → text');
  eq(tools.normalizeArgs('read_env', { variable: 'PATH' }).name, 'PATH', 'read_env variable → name');
  eq(tools.normalizeArgs('read_env', { dump: 'true' }).all, true, 'read_env dump → all');
  eq(tools.normalizeArgs('list_tree', { levels: 4 }).depth, 4, 'list_tree levels → depth');
  eq(tools.normalizeArgs('read_files', { max_chars: '1000' }).max_chars, 1000, 'max_chars coerced');
}

// ===========================================================================
group('tools — parseLineRange');

{
  eq(tools.parseLineRange('10-40'), { start: 10, end: 40 }, '"10-40"');
  eq(tools.parseLineRange('10:20'), { start: 10, end: 20 }, '"10:20"');
  eq(tools.parseLineRange('25'), { start: 25, end: undefined }, '"25"');
  eq(tools.parseLineRange(5), { start: 5, end: undefined }, 'number');
  eq(tools.parseLineRange([1, 9]), { start: 1, end: 9 }, 'array');
  eq(tools.parseLineRange({ start: 3, end: 8 }), { start: 3, end: 8 }, 'object');
  eq(tools.parseLineRange(''), null, 'empty → null');
  eq(tools.parseLineRange(undefined), null, 'undefined → null');
  eq(tools.parseLineRange('nope'), null, 'garbage → null');
}

// ===========================================================================
group('tools — globToRegExp');

{
  const js = tools.globToRegExp('*.js');
  ok(js.test('a.js'), '*.js matches a.js');
  ok(!js.test('src/a.js'), '*.js does not cross a slash');
  ok(!js.test('a.css'), '*.js rejects a.css');

  const cfg = tools.globToRegExp('**/config/*.json');
  ok(cfg.test('config/a.json'), '**/config/*.json matches config/a.json');
  ok(cfg.test('x/y/config/a.json'), '**/config/*.json matches nested path');

  const q = tools.globToRegExp('src/**/test?.js');
  ok(q.test('src/test1.js'), 'src/**/test?.js matches src/test1.js');
  ok(q.test('src/a/b/test1.js'), 'src/**/test?.js matches nested');
  ok(!q.test('src/test10.js'), '? matches exactly one character');
}

// ===========================================================================
group('tools — resolvePath sandbox');

{
  const root = 'D:/Proj';
  eq(tools.resolvePath('src/a.js', { root }), 'D:/Proj/src/a.js', 'relative inside');
  eq(tools.resolvePath('.', { root }), 'D:/Proj', 'root itself');
  eq(tools.resolvePath('D:/Proj/src/../a.js', { root }), 'D:/Proj/a.js', 'internal .. collapsed');
  eq(tools.resolvePath('D:\\Proj\\src\\a.js', { root }), 'D:/Proj/src/a.js', 'backslashes normalised');
  eq(tools.resolvePath('D:/Proj/a.js', { root }), 'D:/Proj/a.js', 'absolute inside');
  throws(() => tools.resolvePath('../outside.js', { root }), '.. escape rejected');
  throws(() => tools.resolvePath('D:/Other/a.js', { root }), 'absolute outside rejected');
  eq(tools.resolvePath('../outside.js', { root, allowOutside: true }), 'D:/outside.js',
    'allowOutside permits the escape');
  eq(tools.resolvePath('D:/Other/a.js', { root, allowOutside: true }), 'D:/Other/a.js',
    'allowOutside permits absolute outside');
  throws(() => tools.resolvePath('', { root }), 'empty path rejected');
  throws(() => tools.resolvePath('a.js', {}), 'missing root rejected');
}

// ===========================================================================
group('prompt');

{
  const p = prompt.buildSystemPrompt({
    root: 'D:/Proj', today: '2026-10-02', thinkLevel: 'medium',
    maxSteps: 15, allowOutsideWorkspace: false
  });
  for (const section of [
    '## ENVIRONMENT', '## YOUR JOB', '## TOOLS', '## FINDING YOUR WAY AROUND',
    '## COMPLETENESS RULES', '## WORKFLOW', '## EDITING SAFELY', '## OUTPUT STYLE',
    '## RULES', '## WHEN THE TASK IS DONE', '<<<TOOL>>>', '<<<END>>>'
  ]) {
    ok(p.indexOf(section) !== -1, 'contains ' + section);
  }
  ok(p.indexOf('D:/Proj') !== -1 && p.indexOf('2026-10-02') !== -1, 'environment carries root and date');
  ok(/Reasoning effort: MEDIUM/.test(p), 'medium think level');
  ok(p.indexOf('15 steps') !== -1, 'maxSteps advertised');
  ok(/THINKING IS OFF/.test(prompt.buildSystemPrompt({ root: 'x', thinkLevel: 'off' })), 'off think level');
  ok(/Reasoning effort: LOW/.test(prompt.buildSystemPrompt({ root: 'x', thinkLevel: 'low' })), 'low think level');
  ok(/Reasoning effort: HIGH/.test(prompt.buildSystemPrompt({ root: 'x', thinkLevel: 'high' })), 'high think level');
  ok(/Allow agent outside workspace/.test(prompt.buildSystemPrompt({ root: 'x', allowOutsideWorkspace: true })) ||
     /accepted \(they still need approval/.test(prompt.buildSystemPrompt({ root: 'x', allowOutsideWorkspace: true })),
    'outside-workspace note honours the flag');
  ok(prompt.buildSystemPrompt({ root: 'x', allowOutsideWorkspace: false }).indexOf('rejected') !== -1,
    'sandbox note when outside access is off');

  const withMem = prompt.buildSystemPrompt({ root: 'x', memoryBlock: '## MEMORY\n- user likes tabs' });
  ok(withMem.indexOf('user likes tabs') !== -1, 'memory block injected');
  ok(prompt.buildSystemPrompt({ root: 'x' }).indexOf('## MEMORY') === -1, 'no memory block when empty');

  for (const n of tools.TOOL_NAMES) {
    ok(prompt.buildSystemPrompt({ root: 'x' }).indexOf(n) !== -1, 'prompt mentions ' + n);
  }
  ok(Buffer.byteLength(p, 'utf8') < 7000, 'prompt under 7 kB (' + Buffer.byteLength(p, 'utf8') + ' bytes)');
  ok(Buffer.byteLength(prompt.buildSystemPrompt({ root: 'D:/Proj', today: '2026-10-02', thinkLevel: 'high', maxSteps: 30, allowOutsideWorkspace: true, memoryBlock: '## MEMORY\n- prefers dark mode' }), 'utf8') < 7000,
    'worst-case prompt under 7 kB');
}

// ===========================================================================
group('loop — scripted 2-tool run');

(async () => {
  const turns = [
    {
      content: 'Let me look around.',
      toolCalls: [{ id: 'c1', name: 'list_dir', arguments: { path: 'src' } }],
      usedNativeTools: true
    },
    {
      content: '',
      toolCalls: [{ id: 'c2', name: 'read_file', arguments: { path: 'src/a.js' } }],
      usedNativeTools: true
    },
    { content: 'All done.', toolCalls: [], usedNativeTools: true }
  ];
  const events = [];
  const loop = new AgentLoop({
    maxSteps: 10,
    callModel: async () => turns.shift(),
    executeTool: async (tc) => 'result of ' + tc.name,
    onEvent: (e) => events.push(e.type)
  });
  const res = await loop.run({ messages: [{ role: 'user', content: 'go' }], systemPrompt: 'SYS' });

  eq(events, [
    'step', 'notice', 'tool_start', 'tool_end',   // turn 1
    'step', 'tool_start', 'tool_end',             // turn 2
    'step', 'assistant', 'done'                   // turn 3
  ], 'event order');

  eq(res.steps, 3, 'three steps');
  eq(res.stopReason, 'done', 'stopReason done');
  ok(res.ok, 'ok true');
  eq(res.finalText, 'All done.', 'final assistant text');

  eq(res.messages[0], { role: 'system', content: 'SYS' }, 'system prompt first');
  eq(res.messages[res.messages.length - 1], { role: 'assistant', content: 'All done.' }, 'last message is the answer');
  eq(res.messages[1], { role: 'user', content: 'go' }, 'user message kept');
  eq(res.messages[3], { role: 'tool', tool_call_id: 'c1', content: 'result of list_dir' }, 'tool result appended');
  eq(res.messages[2].tool_calls[0].function.arguments, '{"path":"src"}', 'assistant turn carries tool_calls');

  // --- text protocol ------------------------------------------------------
  {
    const events2 = [];
    const l2 = new AgentLoop({
      callModel: async () => turns2.shift(),
      executeTool: async () => 'text-result',
      onEvent: (e) => events2.push(e.type)
    });
    const turns2 = [
      { content: '<<<TOOL>>>\n{"name":"list_dir","args":{"path":"."}}\n<<<END>>>', toolCalls: [], usedNativeTools: false },
      { content: 'Finished.', toolCalls: [], usedNativeTools: false }
    ];
    const r2 = await l2.run({ messages: [] });
    eq(events2, ['step', 'tool_start', 'tool_end', 'step', 'assistant', 'done'], 'text-protocol event order');
    eq(r2.messages[0].content, '<<<TOOL>>>\n{"name":"list_dir","args":{"path":"."}}\n<<<END>>>',
      'assistant turn written in text protocol');
    eq(r2.messages[1].content, '<<<RESULT tool="list_dir">>>\ntext-result\n<<<END>>>',
      'result written in text protocol');
  }

  // --- maxSteps -----------------------------------------------------------
  {
    const ev = [];
    let calls = 0;
    const l3 = new AgentLoop({
      maxSteps: 3,
      callModel: async () => {
        calls++;
        return { content: '', toolCalls: [{ id: 'k', name: 'list_dir', arguments: { path: '.' } }], usedNativeTools: true };
      },
      executeTool: async () => 'ok',
      onEvent: (e) => ev.push(e)
    });
    const r3 = await l3.run({ messages: [] });
    eq(calls, 3, 'model called exactly maxSteps times');
    eq(r3.stopReason, 'max_steps', 'stopReason max_steps');
    ok(r3.ok === false, 'not ok');
    const notice = ev.find((e) => e.type === 'notice' && /maximum of/.test(e.text || ''));
    ok(!!notice, 'max-step notice emitted');
  }

  // --- throwing executeTool ----------------------------------------------
  {
    const ev = [];
    const l4 = new AgentLoop({
      callModel: async (m) => (m.length > 2
        ? { content: 'Recovered.', toolCalls: [], usedNativeTools: true }
        : { content: '', toolCalls: [{ id: 'e1', name: 'read_file', arguments: { path: 'missing' } }], usedNativeTools: true }),
      executeTool: async () => { throw new Error('ENOENT: no such file'); },
      onEvent: (e) => ev.push(e)
    });
    const r4 = await l4.run({ messages: [] });
    ok(ev.some((e) => e.type === 'tool_error' && /ENOENT/.test(e.message)), 'tool_error event');
    const toolMsg = r4.messages.find((m) => m.role === 'tool');
    ok(toolMsg && /Error: ENOENT/.test(toolMsg.content), 'error returned to the model as tool output');
    eq(r4.stopReason, 'done', 'loop survived the tool error');
    eq(r4.finalText, 'Recovered.', 'final answer after the error');
  }

  // --- throwing callModel -------------------------------------------------
  {
    const ev = [];
    const l5 = new AgentLoop({
      callModel: async () => { throw new Error('network down'); },
      onEvent: (e) => ev.push(e)
    });
    const r5 = await l5.run({ messages: [] });
    eq(r5.stopReason, 'model_error', 'model_error stop reason');
    ok(ev.some((e) => e.type === 'error'), 'error event emitted');
    ok(ev.some((e) => e.type === 'done'), 'done event always emitted');
  }

  // --- res.error ----------------------------------------------------------
  {
    const l6 = new AgentLoop({ callModel: async () => ({ error: 'HTTP 500' }) });
    const r6 = await l6.run({ messages: [] });
    eq(r6.stopReason, 'model_error', 'res.error ends the loop');
    eq(r6.error, 'HTTP 500', 'error surfaced');
  }

  // --- cancellation -------------------------------------------------------
  {
    const ev = [];
    const l7 = new AgentLoop({
      maxSteps: 5,
      callModel: async (m) => {
        l7.cancel(); // stop after the first turn
        return { content: '', toolCalls: [{ id: 'z', name: 'list_dir', arguments: { path: '.' } }], usedNativeTools: true };
      },
      executeTool: async () => 'never-run',
      onEvent: (e) => ev.push(e)
    });
    const r7 = await l7.run({ messages: [] });
    eq(r7.stopReason, 'cancelled', 'cancel sets stopReason');
    ok(r7.cancelled, 'cancelled flag');
    ok(!ev.some((e) => e.type === 'tool_start'), 'no tool started after cancel');
    ok(ev.some((e) => e.type === 'notice' && e.cancelled), 'cancelled notice emitted');
  }

  // --- external AbortSignal ----------------------------------------------
  {
    const ac = new AbortController();
    let n = 0;
    const l8 = new AgentLoop({
      callModel: async () => {
        n++;
        ac.abort();
        return { content: '', toolCalls: [], usedNativeTools: true };
      }
    });
    const r8 = await l8.run({ messages: [], signal: ac.signal });
    eq(n, 1, 'one call');
    eq(r8.stopReason, 'cancelled', 'external signal cancels');
  }

  // --- decoration stripped from the final answer --------------------------
  {
    const l9 = new AgentLoop({ callModel: async () => ({ content: 'Done.\n────────\nAll set.', toolCalls: [] }) });
    const r9 = await l9.run({ messages: [] });
    eq(r9.finalText, 'Done.\nAll set.', 'ASCII decoration stripped from the answer');
  }

  // --- facade -------------------------------------------------------------
  {
    const eng = engine.createEngine({
      callModel: async () => ({ content: 'hi', toolCalls: [] }),
      executeTool: async () => '',
      promptOptions: { root: 'D:/Proj', thinkLevel: 'high' }
    });
    eq(typeof eng.version, 'string', 'engine exposes a version');
    ok(/Reasoning effort: HIGH/.test(eng.systemPrompt()), 'engine builds the prompt');
    const r10 = await eng.run({ messages: [{ role: 'user', content: 'hi' }] });
    eq(r10.finalText, 'hi', 'engine.run works');
    ok(engine.protocol && engine.tools && engine.prompt && engine.AgentLoop && engine.createEngine,
      'facade exposes protocol/tools/prompt/AgentLoop/createEngine');
  }

  finish();
})();