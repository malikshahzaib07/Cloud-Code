# Cloud AI Engine

The reusable, DOM-free core of the Cloud Code AI agent: the tool schemas, the
system prompt, the tool-call protocol and the tool loop. It has no dependency on
Electron, the DOM, the filesystem or the network — the host app supplies those.

It was extracted from `src/renderer/js/agent.js` (~1700 lines of agent logic
mixed with rendering) and `src/main/main.js` so the agent's behaviour can be
improved and tested without touching a single UI file.

## Layout

```
src/ai-engine/
├── README.md
├── index.js              facade — registers window.CloudAI
├── core/
│   ├── protocol.js       tool-call protocol + ASCII-decoration filter
│   ├── tools.js          tool schemas + argument normalisation + path sandbox
│   ├── prompt.js         system prompt builder
│   └── loop.js           AgentLoop — the tool loop
└── test/
    ├── run.js            zero-dependency harness + entry point
    └── engine.test.js    the suite
```

## What each module owns

| Module | Owns | Does **not** own |
| --- | --- | --- |
| `core/protocol.js` | `<<<TOOL>>>`/`<<<RESULT>>>` text protocol, tolerant JSON repair, native `tool_calls` parsing, transcript message formatting (`formatAssistantTurn`, `formatToolResult`), `stripAsciiDecoration` / `stripLeadingThinking` / `condenseText` | any I/O, any model client |
| `core/tools.js` | the 16 OpenAI function schemas (`TOOLS`), `TOOL_ICONS` / `TOOL_TITLES`, `normalizeArgs` (alias + stringly-typed coercion + nested `arguments`), `parseLineRange`, `globToRegExp`, `resolvePath` sandbox | executing tools, rendering cards |
| `core/prompt.js` | `buildSystemPrompt({root, today, tools, thinkLevel, maxSteps, allowOutsideWorkspace, memoryBlock})` | reading settings or memory itself |
| `core/loop.js` | `AgentLoop` — control flow, step cap, cancellation, per-tool error containment, event emission | the model client, tool implementations, the DOM |

## Public API

```js
window.CloudAI = {
  version,                 // '1.0.0'
  protocol,                // parseToolPayload, extractNativeToolCalls,
                           // extractTextToolCalls, stripToolBlocks,
                           // formatAssistantTurn, formatToolResult,
                           // stripAsciiDecoration, stripLeadingThinking,
                           // isDecorativeLine, condenseText
  tools,                   // TOOLS, TOOL_NAMES, TOOL_ICONS, TOOL_TITLES,
                           // READONLY_TOOLS, NOISE_DIRS, normalizeArgs,
                           // parseLineRange, globToRegExp, resolvePath, getTool
  prompt,                  // buildSystemPrompt
  AgentLoop,               // class
  createEngine             // (options) => engine facade
};
```

### `AgentLoop`

```js
const loop = new CloudAI.AgentLoop({
  maxSteps: 15,
  callModel: async (messages, { signal, useNativeTools, step }) =>
    ({ content, toolCalls, usedNativeTools, reasoning, finishReason, error }),
  executeTool: async (toolCall) => 'the text to append as the tool result',
  onEvent: (evt) => { /* evt.type */ }
});

const result = await loop.run({ messages, systemPrompt });
// { ok, steps, stopReason, cancelled, finalText, messages, error }
```

`stopReason` is one of `done`, `cancelled`, `max_steps`, `model_error`,
`empty_response`. `loop.cancel(reason)` stops it at the next safe point; an
`AbortSignal` passed to `run()` also works.

Events (`onEvent`): `step`, `tool_start`, `tool_end`, `tool_error`, `assistant`,
`notice`, `done`, `error`.

Guarantees:
* a tool that throws becomes `Error: …` text appended as the tool result — the
  loop is never killed by a tool;
* the step cap emits a clear `notice` instead of truncating silently;
* the model answering without tool calls ends the run and becomes `finalText`;
* the `<<<TOOL>>>` text protocol works even if the host's model client does not
  implement it (`protocol.extractTextToolCalls` is applied by the loop);
* ASCII decoration is stripped from the final answer only — never from tool output.

### `createEngine`

```js
const engine = CloudAI.createEngine({
  callModel, executeTool, onEvent,
  promptOptions: { root, thinkLevel, maxSteps, allowOutsideWorkspace }
});
engine.systemPrompt({ memoryBlock });   // merged with promptOptions
engine.createLoop({ maxSteps });        // AgentLoop bound to the hooks
engine.run({ messages, systemPrompt });  // one-shot
```

## How the host app wires it in

Load order in `index.html` (after the other renderer scripts):

```html
<script src="src/ai-engine/core/protocol.js"></script>
<script src="src/ai-engine/core/tools.js"></script>
<script src="src/ai-engine/core/prompt.js"></script>
<script src="src/ai-engine/core/loop.js"></script>
<script src="src/ai-engine/index.js"></script>
```

Renderer (`AgentController`):
1. build the prompt with `CloudAI.prompt.buildSystemPrompt({ root, today, tools:
   CloudAI.tools.TOOL_NAMES, thinkLevel, maxSteps, allowOutsideWorkspace,
   memoryBlock })`;
2. create a loop with `callModel` = `window.electronAPI.aiChatOnce` (which already
   returns `{content, toolCalls, usedNativeTools, reasoning}`; it may also use
   `CloudAI.protocol.parseToolPayload` directly) and `executeTool` = the existing
   `prepareTool` / approval-gate / `applyEdit` machinery, routed through
   `CloudAI.tools.resolvePath(args.path, { root, allowOutside })`;
3. render `onEvent` (thinking panel, tool cards, notices) and `result.finalText`.

Main process: `ai:chatOnce` can use `CloudAI.protocol.parseToolPayload` /
`extractNativeToolCalls` / `extractTextToolCalls` (they are pure and safe there);
nothing else in the engine belongs in the main process.

## Tests

```
node src/ai-engine/test/run.js
```

Zero dependencies, no framework, plain Node. 257 assertions covering the
protocol (native + text, fenced/commented/trailing-comma/truncated payloads,
both result formats, the ASCII filter), the tools (schema completeness,
`normalizeArgs` aliases and coercions, `parseLineRange`, `globToRegExp`,
`resolvePath` sandbox on/off), the prompt (sections, think levels, memory block,
tool list, < 7 kB) and the loop (event order for both protocols, `maxSteps`,
tool/model errors, cancellation via `cancel()` and `AbortSignal`, decoration
filtering, facade).

## How to improve the engine

* **Adding a tool** = one entry in `TOOLS` (`core/tools.js`) + one entry each in
  `TOOL_ICONS` / `TOOL_TITLES` + a line in the `## TOOLS` section of
  `core/prompt.js` + a case in the host's `prepareTool`. Add its aliases to
  `normalizeArgs` if local models are likely to fumble the argument names.
* **Changing behaviour** = `core/prompt.js` (wording/rules) or `core/tools.js`
  (schemas, normalisation, sandbox). Both are pure and unit-tested.
* **Never edit UI files from here.** `src/renderer/js/agent.js`,
  `ai-assistant.js`, `src/main/main.js`, `preload.js`, `index.html` and the
  stylesheets are owned by the app, not by the engine. If the engine seems to need
  a UI change, emit a new event type or a new `result` field instead.
* Keep every module DOM-free and Electron-free; `core/` must stay requireable from
  plain Node so the tests keep running.