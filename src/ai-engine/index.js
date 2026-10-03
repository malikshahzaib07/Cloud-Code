// Cloud Code AI Engine — public facade.
//
// Classic <script>, no modules, no build step, no Electron, no DOM. Loading this
// file after core/protocol.js, core/tools.js, core/prompt.js and core/loop.js
// registers window.CloudAI:
//
//   <script src="core/protocol.js"></script>
//   <script src="core/model-adapters.js"></script>
//   <script src="core/tools.js"></script>
//   <script src="core/prompt.js"></script>
//   <script src="core/context.js"></script>
//   <script src="core/loop.js"></script>
//   <script src="index.js"></script>
//
// In Node: const CloudAI = require('./index.js');

(function (global) {
  'use strict';

  function pick(name) {
    if (global.CloudAI && global.CloudAI[name]) return global.CloudAI[name];
    if (typeof require === 'function') return require('./core/' + name + '.js');
    throw new Error('Cloud AI engine: core/' + name + '.js is not loaded.');
  }

  const protocol = pick('protocol');
  const adapters = pick('model-adapters');
  const tools = pick('tools');
  const prompt = pick('prompt');
  const loop = pick('loop');
  const context = pick('context');

  const VERSION = '1.2.0';

  /**
   * createEngine(options)
   *
   * A thin object that ties the pieces together for the host app. It owns no
   * state beyond the last system prompt it built.
   *
   * @param {object}  o
   * @param {function} [o.callModel]   (messages, {signal}) => {content, toolCalls, ...}
   * @param {function} [o.executeTool] (toolCall) => Promise<string>
   * @param {function} [o.onEvent]     (evt) => void
   * @param {object}  [o.promptOptions] defaults for buildSystemPrompt()
   */
  function createEngine(o) {
    const opts = o || {};
    const promptOptions = opts.promptOptions || {};
    return {
      version: VERSION,
      protocol,
      adapters,
      tools,
      prompt,
      context,
      AgentLoop: loop.AgentLoop,

      /** The adapter for a model id (or null when unknown). */
      adapter(modelId) {
        return adapters.getAdapter(modelId);
      },

      /** Build the system prompt, merging engine defaults with per-call options. */
      systemPrompt(overrides) {
        return prompt.buildSystemPrompt(Object.assign({}, promptOptions, overrides || {}));
      },

      /** Create a loop bound to this engine's model/executor hooks. */
      createLoop(loopOptions) {
        return new loop.AgentLoop(Object.assign({
          callModel: opts.callModel,
          executeTool: opts.executeTool,
          onEvent: opts.onEvent
        }, loopOptions || {}));
      },

      /** Convenience: one-shot run with the engine's hooks. */
      run(runOptions) {
        return this.createLoop((runOptions || {}).loopOptions).run(runOptions || {});
      }
    };
  }

  const CloudAI = {
    version: VERSION,
    protocol,
    adapters,
    tools,
    prompt,
    context,
    AgentLoop: loop.AgentLoop,
    createEngine
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = CloudAI;
  global.CloudAI = CloudAI;
})(typeof globalThis !== 'undefined' ? globalThis : this);