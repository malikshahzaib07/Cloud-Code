// Cloud Code AI Engine — model-family adapters.
//
// The self-hosted server exposes ~20 models from six families. None of them
// supports native (OpenAI `tool_calls`) function calling today, so the text
// protocol is the primary path for every model. Each family nevertheless has a
// different set of quirks: DeepSeek-R narrates inside <think> blocks, Qwen and
// friends leak markdown fences into JSON, small instruct models want to chat
// instead of emitting a tool block.
//
// This module maps a model id to one adapter object. The host picks the
// adapter, the prompt builder uses `promptStyle` / `jsonCautions` to add a
// family-specific PROTOCOL COACHING block, and the loop uses
// `reasoningWrapper` to clean the completion.
//
// Pure: no DOM, no Electron, no I/O.

(function (global) {
  'use strict';

  /** Parameter counts at or below this count as "small" (≤ ~9B). */
  const SMALL_MODEL_PARAMETERS = 9;

  /**
   * The per-family table. Adding a family = adding one object here (plus, if it
   * needs new wording, nothing else — prompt.js reads the fields below).
   *
   * Fields:
   *   family                 canonical name
   *   label                  human-readable, for the model picker
   *   imageOnly              true for diffusion / embedding style models
   *   supportsNativeTools    known tool-capable families only (none on this server)
   *   supportsTextProtocol   false for image-only and known-bad models
   *   reasoningWrapper       how to strip the family's thinking channel
   *   promptStyle            lines appended under "## PROTOCOL COACHING"
   *   jsonCautions           extra JSON-formatting wording ('' when not needed)
   *   recommendedForAgent    true for coder/instruct models that follow
   *                          instructions; false for image-only models and for
   *                          tiny models when the task needs multi-file edits
   *   smallModel             <= ~9B: usable for chat, unreliable for big edits
   *   reasoningModel         true for models that emit a thinking channel
   */
  const FAMILIES = {
    'qwen-coder': {
      family: 'qwen-coder',
      label: 'Qwen Coder',
      imageOnly: false,
      supportsNativeTools: false,
      supportsTextProtocol: true,
      reasoningWrapper: 'qwen',
      promptStyle: [
        'You have no function-calling API. The only way to touch the filesystem is the <<<TOOL>>> block.',
        'Every reply that needs a tool is the block and nothing else.',
        'Do not wrap the reply in <think> tags or output the block inside a code fence.'
      ],
      jsonCautions: '',
      recommendedForAgent: true,
      smallModel: false,
      reasoningModel: false
    },

    qwen: {
      family: 'qwen',
      label: 'Qwen',
      imageOnly: false,
      supportsNativeTools: false,
      supportsTextProtocol: true,
      reasoningWrapper: 'qwen',
      promptStyle: [
        'You have no function-calling API. The only way to touch the filesystem is the <<<TOOL>>> block.',
        'Every reply that needs a tool is the block and nothing else.',
        'Do not wrap the reply in <think> tags or output the block inside a code fence.'
      ],
      jsonCautions: '',
      recommendedForAgent: true,
      smallModel: false,
      reasoningModel: false
    },

    'deepseek-r': {
      family: 'deepseek-r',
      label: 'DeepSeek-R (reasoning)',
      imageOnly: false,
      supportsNativeTools: false,
      supportsTextProtocol: true,
      reasoningWrapper: 'deepseek-r',
      promptStyle: [
        'Do not narrate your reasoning before the block. Output the tool block as the first thing in your reply.',
        'Keep any deliberation short: a couple of sentences at most, and only when thinkLevel allows it.'
      ],
      jsonCautions: '',
      recommendedForAgent: true,
      smallModel: false,
      reasoningModel: true
    },

    deepseek: {
      family: 'deepseek',
      label: 'DeepSeek',
      imageOnly: false,
      supportsNativeTools: false,
      supportsTextProtocol: true,
      reasoningWrapper: 'none',
      promptStyle: [
        'Output the tool block as the first thing in your reply.'
      ],
      jsonCautions: '',
      recommendedForAgent: true,
      smallModel: false,
      reasoningModel: false
    },

    llama: {
      family: 'llama',
      label: 'Llama',
      imageOnly: false,
      supportsNativeTools: false,
      supportsTextProtocol: true,
      reasoningWrapper: 'none',
      promptStyle: [
        'Do not answer in prose while a tool is needed; the tool block is the whole reply.',
        'Never invent a tool name — only the names listed above exist.'
      ],
      jsonCautions: '',
      recommendedForAgent: true,
      smallModel: false,
      reasoningModel: false
    },

    mistral: {
      family: 'mistral',
      label: 'Mistral',
      imageOnly: false,
      supportsNativeTools: false,
      supportsTextProtocol: true,
      reasoningWrapper: 'none',
      promptStyle: [
        'Output the tool block as the first thing in your reply.',
        'Never wrap the JSON in a markdown fence and never add [TOOL_CALL] style tags.'
      ],
      jsonCautions: '',
      recommendedForAgent: true,
      smallModel: false,
      reasoningModel: false
    },

    gemma: {
      family: 'gemma',
      label: 'Gemma',
      imageOnly: false,
      supportsNativeTools: false,
      supportsTextProtocol: true,
      reasoningWrapper: 'none',
      promptStyle: [
        'Output the tool block as the first thing in your reply.',
        'Never start the reply with a role marker such as "<start_of_turn>model".'
      ],
      jsonCautions: '',
      recommendedForAgent: true,
      smallModel: false,
      reasoningModel: false
    },

    phi: {
      family: 'phi',
      label: 'Phi',
      imageOnly: false,
      supportsNativeTools: false,
      supportsTextProtocol: true,
      reasoningWrapper: 'none',
      promptStyle: [
        'Output the tool block as the first thing in your reply.'
      ],
      jsonCautions: '',
      recommendedForAgent: true,
      smallModel: false,
      reasoningModel: false
    },

    unknown: {
      family: 'unknown',
      label: 'Unknown model',
      imageOnly: false,
      supportsNativeTools: false,
      supportsTextProtocol: true,
      reasoningWrapper: 'qwen',
      promptStyle: [],
      jsonCautions: '',
      recommendedForAgent: false,
      smallModel: false,
      reasoningModel: false
    }
  };

  /**
   * Image-only / non-text models. They are keyed by the id fragments that mark
   * them so `getAdapter` can refuse them as agent backends.
   */
  const IMAGE_ONLY_PATTERNS = [
    /image/i,
    /-vl\b/i,
    /embedding/i,
    /whisper/i,
    /tts/i
  ];

  /** Ordered rules: first match wins. `id` is a substring / regex over the id. */
  const RULES = [
    { family: 'qwen-coder', test: /qwen[0-9.\-]*coder|qwen-?c\b|coder-?qwen/i },
    { family: 'deepseek-r', test: /deepseek[.\-]?r\d/i },
    { family: 'deepseek', test: /deepseek/i },
    { family: 'qwen', test: /qwen/i },
    { family: 'llama', test: /llama/i },
    { family: 'mistral', test: /mistral|mixtral/i },
    { family: 'gemma', test: /gemma/i },
    { family: 'phi', test: /phi-?\d|\bphi\b/i }
  ];

  /** Parameter counts that make a model "small" (unreliable for big edits). */
  function isSmallModel(id) {
    // e.g. "deepseek-r1-8b" → 8b ; "llama-3.3-70b" → 70b
    const m = String(id || '').match(/(\d+(?:\.\d+)?)\s*b\b/i);
    if (!m) return false;
    return parseFloat(m[1]) <= SMALL_MODEL_PARAMETERS;
  }

  /**
   * detectFamily(modelId) -> 'qwen-coder' | 'qwen' | 'deepseek-r' | 'deepseek' |
   *                          'llama' | 'mistral' | 'gemma' | 'phi' | 'unknown'
   */
  function detectFamily(modelId) {
    const id = String(modelId == null ? '' : modelId);
    if (!id.trim()) return 'unknown';
    for (const rule of RULES) {
      if (rule.test.test(id)) return rule.family;
    }
    return 'unknown';
  }

  /** True for models that cannot return text at all (diffusion, embeddings, …). */
  function isImageOnly(modelId) {
    const id = String(modelId == null ? '' : modelId);
    if (!id.trim()) return false;
    return IMAGE_ONLY_PATTERNS.some((re) => re.test(id));
  }

  /**
   * getAdapter(modelId) -> a frozen adapter object for that model.
   * Unknown ids get the conservative `unknown` adapter.
   */
  function getAdapter(modelId) {
    const family = detectFamily(modelId);
    const base = FAMILIES[family] || FAMILIES.unknown;
    const imageOnly = base.imageOnly || isImageOnly(modelId);
    const small = isSmallModel(modelId);

    let recommended = base.recommendedForAgent;
    if (imageOnly) recommended = false;
    else if (family === 'unknown') recommended = false;
    // Tiny models are fine for chat, unreliable for multi-file edits.
    else if (small) recommended = false;

    const jsonCautions = imageOnly ? '' :
      (base.jsonCautions || '');

    const promptStyle = imageOnly ? [] : base.promptStyle.slice();

    return Object.freeze({
      modelId: String(modelId == null ? '' : modelId),
      family: base.family,
      label: imageOnly ? base.label + ' (image-only)' : base.label,
      imageOnly,
      supportsNativeTools: !imageOnly && base.supportsNativeTools,
      supportsTextProtocol: !imageOnly && base.supportsTextProtocol,
      reasoningWrapper: base.reasoningWrapper,
      promptStyle,
      jsonCautions,
      recommendedForAgent: recommended,
      smallModel: small,
      reasoningModel: !imageOnly && base.reasoningModel
    });
  }

  /** Names of every family this module knows about, including 'unknown'. */
  function listKnownFamilies() {
    return Object.keys(FAMILIES);
  }

  /**
   * isUsableForAgent(modelId) — can this model drive the tool loop?
   * False for image-only models and for unknown ids (the host should refuse
   * rather than fail mid-task).
   */
  function isUsableForAgent(modelId) {
    const a = getAdapter(modelId);
    return !a.imageOnly && a.family !== 'unknown' &&
      (a.supportsNativeTools || a.supportsTextProtocol);
  }

  // ==========================================================================
  // Reasoning-wrapper stripping
  // ==========================================================================

  const REASONING_WRAPPERS = {
    // <think>…</think> pairs, plus a bare </think> / <answer> tag with the text
    // that follows it (DeepSeek-R sometimes closes the channel without opening).
    'deepseek-r': /<\s*think\s*>[\s\S]*?<\s*\/\s*think\s*>|<\s*\/\s*think\s*>|<\s*\/?\s*answer\s*>/gi,
    // Qwen2.5 emits an opening <think> with no closer in some builds, so an
    // unterminated one consumes the rest of the reply.
    qwen: /<\s*think\s*>[\s\S]*?(?:<\s*\/\s*think\s*>|$)|<\s*\/\s*think\s*>/gi,
    none: null
  };

  /** Remove a family's thinking channel from raw completion text. */
  function stripReasoning(text, wrapperName) {
    const out = typeof text === 'string' ? text : '';
    const re = REASONING_WRAPPERS[wrapperName || 'none'] || REASONING_WRAPPERS.none;
    return re ? out.replace(re, '').trim() : out.trim();
  }

  const api = {
    FAMILIES,
    detectFamily,
    getAdapter,
    listKnownFamilies,
    isUsableForAgent,
    isImageOnly,
    stripReasoning
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.CloudAI = Object.assign(global.CloudAI || {}, { adapters: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);