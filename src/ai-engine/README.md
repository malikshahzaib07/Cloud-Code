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
│   ├── model-adapters.js per-family model adapters (family, prompt style, JSON cautions)
│   ├── tools.js          tool schemas + argument normalisation + path sandbox
│   ├── prompt.js         system prompt builder (family-aware)
│   ├── context.js        context budget manager (trims old tool results)
│   └── loop.js           AgentLoop — the tool loop
└── test/
    ├── run.js            zero-dependency harness + entry point
    ├── engine.test.js    protocol / tools / prompt / loop suite
    └── adapters.test.js  model-adapter, family-prompt and loop-resilience suite
```

## What each module owns

| Module | Owns | Does **not** own |
| --- | --- | --- |
| `core/protocol.js` | `<<<TOOL>>>`/`<<<RESULT>>>` text protocol, tolerant JSON repair, native `tool_calls` parsing, transcript message formatting (`formatAssistantTurn`, `formatToolResult`), `stripAsciiDecoration` / `stripLeadingThinking` / `condenseText` | any I/O, any model client |
| `core/model-adapters.js` | `detectFamily`, `getAdapter`, `listKnownFamilies`, `isUsableForAgent`, `stripReasoning` — what a given model id can and cannot do | completions, prompting |
| `core/tools.js` | the 16 OpenAI function schemas (`TOOLS`), `TOOL_ICONS` / `TOOL_TITLES`, `normalizeArgs` (alias + stringly-typed coercion + nested `arguments`), `parseLineRange`, `globToRegExp`, `resolvePath` sandbox | executing tools, rendering cards |
| `core/prompt.js` | `buildSystemPrompt({root, today, tools, thinkLevel, maxSteps, allowOutsideWorkspace, memoryBlock})` | reading settings or memory itself |
| `core/context.js` | `trimMessages`, `measureMessages`, token estimate — clips old tool results when the transcript exceeds the budget | sending prompts, rendering |
| `core/loop.js` | `AgentLoop` — control flow, step cap, cancellation, per-tool error containment, context trim, per-tool result caps, event emission | the model client, tool implementations, the DOM |

## Public API

```js
window.CloudAI = {
  version,                 // '1.0.0'
  protocol,                // parseToolPayload, extractNativeToolCalls,
                           // extractTextToolCalls, stripToolBlocks,
                           // formatAssistantTurn, formatToolResult,
                           // stripAsciiDecoration, stripLeadingThinking,
                           // isDecorativeLine, condenseText
  adapters,                // detectFamily, getAdapter, listKnownFamilies,
                           // isUsableForAgent, isImageOnly, stripReasoning
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
  onEvent: (evt) => { /* evt.type */ },
  host: { nudgeOnSilentTurns: true },   // correct a model that chats instead of calling a tool
  requireToolFirstStep: false           // also correct a prose FIRST turn
});

const result = await loop.run({ messages, systemPrompt });
// { ok, steps, stopReason, cancelled, finalText, messages, error,
//   lastError, nudges, retries, trimmed }
```

`stopReason` is one of `completed`, `cancelled`, `max_steps`, `model_error`,
`empty_response`, `no_tool_call`. `loop.cancel(reason)` stops it at the next safe
point; an `AbortSignal` passed to `run()` also works. The result also carries
`trimmed` — how many old tool results the context budget manager clipped.

Events (`onEvent`): `step`, `tool_start`, `tool_end`, `tool_error`, `assistant`,
`notice`, `done`, `error`, plus the resilience events `retry` and `health`.

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
<script src="src/ai-engine/core/model-adapters.js"></script>
<script src="src/ai-engine/core/tools.js"></script>
<script src="src/ai-engine/core/prompt.js"></script>
<script src="src/ai-engine/core/context.js"></script>
<script src="src/ai-engine/core/loop.js"></script>
<script src="src/ai-engine/index.js"></script>
```

Renderer (`AgentController`):
1. build the prompt with `CloudAI.prompt.buildSystemPrompt({ root, today, tools:
   CloudAI.tools.TOOL_NAMES, thinkLevel, maxSteps, allowOutsideWorkspace,
   memoryBlock, model: selectedModelId })` — the `model` parameter is optional
   and adds the family coaching block;
2. create a loop with `callModel` = `window.electronAPI.aiChatOnce` (which already
   returns `{content, toolCalls, usedNativeTools, reasoning}`; it may also use
   `CloudAI.protocol.parseToolPayload` directly) and `executeTool` = the existing
   `prepareTool` / approval-gate / `applyEdit` machinery, routed through
   `CloudAI.tools.resolvePath(args.path, { root, allowOutside })`;
3. render `onEvent` (thinking panel, tool cards, notices) and `result.finalText`.

Main process: `ai:chatOnce` can use `CloudAI.protocol.parseToolPayload` /
`extractNativeToolCalls` / `extractTextToolCalls` (they are pure and safe there);
nothing else in the engine belongs in the main process.

## Working with different models

The host serves ~20 self-hosted models across six families (Qwen, DeepSeek-R,
Llama, Mistral, Phi, Gemma) plus at least one image-only model.

**No model on this server supports native tool calling.** Every completion comes
back with `usedNativeTools: false`, so the `<<<TOOL>>>{"name":…,"args":{…}}<<<END>>>`
text protocol in `core/protocol.js` is the primary and only working path. The
`supportsNativeTools` flag on each adapter is kept because a future server may
expose a tool-capable endpoint; nothing depends on it today.

### The adapter system

`core/model-adapters.js` maps a model id to one adapter object:

```js
const a = CloudAI.adapters.getAdapter('deepseek-r1-8b');
a.family;                // 'deepseek-r'
a.supportsNativeTools;   // false on this server
a.supportsTextProtocol;  // true
a.reasoningWrapper;      // 'deepseek-r' | 'qwen' | 'none' — how to strip <think>…
a.promptStyle;           // family-specific lines added under "## PROTOCOL COACHING"
a.jsonCautions;          // extra JSON-formatting wording ('' when not needed)
a.recommendedForAgent;   // false for image-only models and for ≤ ~9B models
a.smallModel;            // true when the id is ≤ 9B
a.reasoningModel;        // true for the R1-style reasoning models
```

Other exports: `detectFamily(modelId)`, `listKnownFamilies()`,
`isUsableForAgent(modelId)` (false for image-only and for unknown ids),
`isImageOnly(modelId)`, `stripReasoning(text, wrapperName)`.

Known families: `qwen-coder`, `qwen`, `deepseek-r`, `deepseek`, `llama`,
`mistral`, `gemma`, `phi`, `unknown`. Note that `qwen-image-2-1` resolves to
family `qwen` but is flagged `imageOnly`, `supportsTextProtocol: false` and
`recommendedForAgent: false` — it must never be offered as an agent backend.

### How the host picks an adapter

The host passes the selected model id into the prompt builder; nothing else is
required:

```js
const systemPrompt = CloudAI.prompt.buildSystemPrompt({
  root, tools: CloudAI.tools.TOOL_NAMES, thinkLevel, maxSteps,
  model: selectedModelId          // or: adapter: CloudAI.adapters.getAdapter(id)
});
```

`buildSystemPrompt` stays backwards compatible: with no `model`/`adapter` it
returns the same base prompt as before, under 7 kB. With one it appends a
`## PROTOCOL COACHING` block containing the exact protocol, one literal example
built from the first **enabled** tool, and the family's own lines:

| Family | extra coaching |
| --- | --- |
| all text families | repeat the protocol + literal example; `Emit ONE tool block per message. No markdown fences, no comments, no trailing commas, double-quoted keys and strings.`; `Do not answer in prose while a tool is needed; the tool block is the whole reply.` |
| `deepseek-r` (and any `reasoningModel`) | `Do not narrate your reasoning before the block. Output the tool block as the first thing in your reply.` |
| `qwen`, `qwen-coder` | `Do not wrap the reply in <think> tags or output the block inside a code fence.` |
| `llama` | `Never invent a tool name — only the names listed above exist.` |
| `mistral` | `Never wrap the JSON in a markdown fence and never add [TOOL_CALL] style tags.` |
| `gemma` | `Never start the reply with a role marker such as "<start_of_turn>model".` |
| small (≤ 9B) | `Keep replies short; make one tool call per step and finish within a few steps.` |
| image-only | told the model cannot drive tools and must not emit `<<<TOOL>>>` at all |

When `tools` is supplied the prompt also gains a **capability note** naming the
enabled tools and saying that everything else is disabled.

To clean a raw completion before it reaches the prompt or the transcript:

```js
const clean = CloudAI.adapters.stripReasoning(raw, adapter.reasoningWrapper);
```

DeepSeek-R's `<think>…</think>` and bare `</think>`/`</answer>` variants are
stripped; Qwen's unterminated `<think>` consumes the remainder (an empty answer
is better than leaked deliberation). `none` leaves text untouched.

### Adding a family

1. Add one object to `FAMILIES` in `core/model-adapters.js` (`family`, `label`,
   `imageOnly`, `supportsNativeTools`, `supportsTextProtocol`, `reasoningWrapper`,
   `promptStyle`, `jsonCautions`, `recommendedForAgent`, `smallModel`,
   `reasoningModel`).
2. Add one matching rule to `RULES` (first match wins) and/or an entry in
   `IMAGE_ONLY_PATTERNS`.
3. That's it. `prompt.js` reads `promptStyle` / `jsonCautions` generically, so
   no prompt edit is needed. Add a case to `REASONING_WRAPPERS` only if the
   family needs a new thinking-channel shape.

### Loop resilience

* **Retry with backoff** — network errors, timeouts, 5xx and 429 are retried up
  to twice, after 400 ms and 1200 ms (`AgentLoop({ retryDelaysMs })` overrides
  the schedule, mainly for tests). Each attempt emits a `retry` event
  (`{ attempt, maxAttempts, delayMs, kind, message, retryable }`) so the UI can
  say "reconnecting…". Non-transient failures (4xx, protocol problems) are never
  retried.
* **Model health** — the `error` event now carries
  `{ kind: 'transport' | 'http' | 'protocol' | 'cancelled', message, retryable }`,
  a matching `health` event is emitted, `result.lastError` exposes the same
  object, and `classifyError(message, aborted)` is exported for hosts that want
  to classify their own failures.
* **Protocol nudge** — a model that answers in prose when a tool was clearly
  needed gets one corrective message naming the exact block to emit, at most
  twice (`MAX_NUDGES`), after which the loop finishes cleanly with
  `stopReason: 'no_tool_call'` and an explicit "no files were changed" message
  instead of looping forever. Enabled by `host.nudgeOnSilentTurns` (after a tool
  has already run) and/or `requireToolFirstStep` (before any tool has run);
  both default to off, so today's "assistant answers in prose ⇒ done" behaviour
  is unchanged by default.

The original event contract is untouched — `step`, `tool_start`, `tool_end`,
`tool_error`, `assistant`, `notice`, `done` and `error` all behave as before,
and `maxSteps`, `AbortSignal`/`cancel()`, tool errors returned to the model and
decoration stripping all still work.

## Tests

```
node src/ai-engine/test/run.js
```

Zero dependencies, no framework, plain Node. 600 assertions covering the
protocol (native + text, fenced/commented/trailing-comma/truncated payloads,
both result formats, the ASCII filter), the tools (schema completeness,
`normalizeArgs` aliases and coercions, `parseLineRange`, `globToRegExp`,
`resolvePath` sandbox on/off), the prompt (sections, think levels, memory block,
tool list, < 7 kB), the loop (event order for both protocols, `maxSteps`,
tool/model errors, cancellation via `cancel()` and `AbortSignal`, decoration
filtering, facade), and the model adapters (family detection for every server
model id, image-only refusal, adapter completeness, reasoning-wrapper stripping,
family-specific prompt blocks appearing only for the right family, prompt size
budgets, retry/backoff behaviour and the protocol nudge).

## How to improve the engine

* **Adding a model family** = one object in `FAMILIES` + one rule in `RULES`
  (`core/model-adapters.js`). The prompt picks the wording up automatically.
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