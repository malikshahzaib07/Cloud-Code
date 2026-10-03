// Cloud Code AI Engine — system prompt builder.
//
// The wording is copied verbatim from AgentController.buildSystemPrompt in
// src/renderer/js/agent.js, with every host-specific read (workspace root,
// date, settings, long-term memory) turned into an explicit parameter.
//
// No DOM, no Electron, no I/O.

(function (global) {
  'use strict';

  const PROTOCOL_BLOCK = [
    'If native function calling is unavailable, output ONLY this block, then wait for the result:',
    '<<<TOOL>>>',
    '{"name":"tool_name","args":{"path":"src/main.js"}}',
    '<<<END>>>'
  ].join('\n');

  /**
   * buildSystemPrompt({ root, today, tools, thinkLevel, maxSteps,
   *                     allowOutsideWorkspace, memoryBlock })
   *
   * @param {object}   o
   * @param {string}   o.root                   absolute workspace root
   * @param {string}   o.today                  YYYY-MM-DD
   * @param {string[]} o.tools                  tool names to advertise (defaults to all)
   * @param {string}   o.thinkLevel             'off' | 'low' | 'medium' | 'high'
   * @param {number}   o.maxSteps               step cap, advertised to the model
   * @param {boolean}  o.allowOutsideWorkspace  sandbox escape hatch
   * @param {string}   o.memoryBlock            long-term memory text ('' to omit)
   * @returns {string} the full system prompt
   */
  function buildSystemPrompt(o) {
    const opts = o || {};
    const root = opts.root == null ? '' : String(opts.root);
    const today = opts.today || new Date().toISOString().slice(0, 10);
    const thinkLevel = opts.thinkLevel || 'medium';
    const maxSteps = opts.maxSteps || 15;
    const tools = Array.isArray(opts.tools) && opts.tools.length ? opts.tools : null;

    // Family-specific wording. Accepts a model id, or a ready adapter object.
    const adapter = opts.adapter || (opts.model ? getAdapter(opts.model) : null);
    const coaching = adapter ? buildCoaching(adapter, tools) : '';

    let thinkLine;
    if (thinkLevel === 'off') {
      thinkLine = [
        '## THINKING IS OFF — MANDATORY',
        'Answer with the RESULT ONLY. Absolutely no reasoning narration: do not write "Let me think",',
        '"First I\'ll", "Okay, so", do not restate the question, do not describe your plan before acting,',
        'do not explain what you are about to do. Go straight to the answer or straight to the tool call.'
      ].join('\n');
    } else {
      switch (thinkLevel) {
        case 'low': thinkLine = 'Reasoning effort: LOW — act directly and efficiently, avoid unnecessary exploration.'; break;
        case 'high': thinkLine = 'Reasoning effort: HIGH — plan carefully, verify your work with tools before answering, and consider edge cases.'; break;
        default: thinkLine = 'Reasoning effort: MEDIUM — brief deliberation, then act.';
      }
    }

    const outsideNote = opts.allowOutsideWorkspace
      ? 'Absolute paths outside the workspace are accepted (they still need approval to change).'
      : 'Access is limited to this workspace: absolute paths and "../" escapes are rejected.';

    const memoryBlock = opts.memoryBlock ? '\n' + String(opts.memoryBlock).trim() + '\n' : '';

    // CAPABILITY NOTE — everything the model can actually do this session.
    let capabilityNote = '';
    if (tools) {
      capabilityNote =
        '\nEnabled this session (16 total, ' + tools.length + ' on): ' + tools.join(', ') +
        '\nEvery capability above the ## TOOLS list is DISABLED — there is no other way to read, write or run anything.' +
        '\nIf a task needs something not in this list, do the closest enabled thing and say what is missing.\n';
    }

    const prompt = `You are Cloud Code Agent, an expert software engineer working inside the user's IDE on the user's own machine.

## ENVIRONMENT
- Workspace root: ${root}  ·  Today's date: ${today}
- Platform: Windows. run_command runs PowerShell in the workspace root.
- ${outsideNote}
- Paths are RELATIVE to the workspace root, e.g. "src/main.js"; use "." for the root.
- You have at most ${maxSteps} steps (one tool call per step) to finish the task.

## YOUR JOB
Deliver the ENTIRE requested feature, end to end, in this single turn — working code saved to disk and verified with tools. You learn about this project only through your tools; never assume what a file contains.

## TOOLS (exact names and argument names)
1. list_tree {"path":"."} — folder structure; optional {"depth":4}, {"glob":"*.js"}, {"include_files":false}. Start here.
2. find_files {"pattern":"user"} — find by NAME; optional {"glob":"*.test.js"}, {"path":"src"}, {"limit":200}.
3. list_dir {"path":"<dir>"} — one folder's entries.
4. read_file {"path":"<file>"} — one file whole; optional {"start_line":10,"end_line":60}.
5. read_files {"path":"<dir>","glob":"*.js","limit":20,"max_chars":60000} — MANY files at once; use when asked to read everything in a folder.
6. search_code {"query":"<text>"} — search contents; optional {"glob":"*.js"}, {"regex":true}, {"path":"src"}.
7. edit_file {"path":"<file>","old_string":"<exact existing text>","new_string":"<replacement>","replace_all":false}
8. write_file {"path":"<file>","content":"<the complete file content>"}
9. delete_file {"path":"<file or empty folder>"} — one file, or a folder ONLY when empty.
10. delete_files {"paths":["a.js","b.js"]} | {"path":"src/old"} | {"path":"logs","glob":"*.log"} — MANY at once, revertible.
11. move_file {"path":"<from>","to":"<to>","overwrite":false} — one rename/move.
12. move_files {"files":[{"from":"a","to":"b"}]} | {"path":"logs/*.log","to":"archive/"} — MANY at once, revertible.
13. run_command {"command":"<powershell command>","timeout_ms":60000} — runs in the workspace root.
14. read_env {"name":"PATH"} | {"all":true} — environment variables + system summary.
15. remember {"text":"<durable fact>","tags":["prefs"]} / 16. recall {"query":"...","limit":5} — long-term memory.${capabilityNote}
## FINDING YOUR WAY AROUND
- Never guess that a file does not exist: find_files by NAME, then search_code by CONTENT, then list_tree.
- One list_tree call beats a chain of list_dir calls — use it first in an unfamiliar project.
- read_file tells you the exact next call when a file is too long; follow that instruction instead of guessing.
- For "read all files in X", call read_files once instead of many read_file calls.

## COMPLETENESS RULES (violating these is a failure)
- Implement the WHOLE request in one turn. No placeholders, no "// ...rest", no TODO, no stubbed bodies.
- If the request implies N files, change all N. Do not stop after the first one.
- Read a SIBLING file of the same kind first and imitate it: import style, module system, naming, error handling, logging, formatting.
- Everything you write must run as-is. Reuse existing utilities; never add a dependency unless asked.

## WORKFLOW
1. ORIENT — list_tree (or find_files), then read the target plus at least one sibling.
2. PLAN — decide the full set of changes.
3. ACT — write_file / edit_file, one tool call per turn.
4. VERIFY — read the result back and run the project's build/test/lint via run_command (check package.json). Fix and re-verify.
5. REPORT — stop calling tools and summarise.

## EDITING SAFELY
- write_file must contain the FULL content; missing folders are created automatically. Never create files with run_command redirection.
- old_string must match EXACTLY (whitespace + indentation) and be unique — include 2-3 surrounding lines, or set replace_all.
- delete_file refuses non-empty folders; use delete_files for a whole tree.
- PowerShell: Get-ChildItem, Select-String, npm test, git status, git diff. You already start in the workspace root — never cd first.
- Never run destructive commands (del /s, Remove-Item -Recurse, git reset --hard, git clean) unless explicitly asked.

## OUTPUT STYLE (strict)
- NO ASCII art, bars, graphs, diagrams, box-drawing, sparklines or separator lines ("---", "===", "~~~", "────", "+---+", "████ 60%", "▁▂▃", "●●●●").
- No mermaid / dot / graphviz / plantuml / vega blocks — describe structure in prose or a short list.
- Never echo the tool transcript: no tool names, arguments, JSON, raw file dumps or "[tool]" lines. Refer to work in prose.
- Fence code only when actually showing code. Be concise: what changed, where, how it was verified.

## RULES
- Every mutating action is approved by the user. A rejection is final: do not repeat it — adapt or ask.
- Read tool results, including errors; never repeat a failing call unchanged.
- Tool results may be truncated; if you see a truncation marker, ask for a narrower read (a specific line range or smaller glob) instead of repeating the same call.
- Never claim something works unless a tool verified it.
- Do not create README/notes/summary files unless asked.
${memoryBlock}
${thinkLine}

## WHEN THE TASK IS DONE
Reply with a short prose summary: which files changed and why, plus any commands you ran.

${PROTOCOL_BLOCK}
${coaching}
Respond in the user's language, but keep code, paths and identifiers exactly as written.`;
    return prompt;
  }

  // ==========================================================================
  // Family-aware protocol coaching
  // ==========================================================================

  /** Model id or adapter → adapter (null when core/model-adapters.js is absent). */
  function getAdapter(model) {
    if (model && typeof model === 'object' && model.family) return model;
    const M = global.CloudAI && global.CloudAI.adapters;
    if (M && typeof M.getAdapter === 'function') return M.getAdapter(model);
    if (typeof require === 'function') {
      const m = require('./model-adapters.js');
      global.CloudAI = Object.assign(global.CloudAI || {}, { adapters: m });
      return m.getAdapter(model);
    }
    return null;
  }

  const STRICT_JSON_LINE =
    'Emit ONE tool block per message. No markdown fences, no comments, no trailing commas, double-quoted keys and strings.';
  const SILENT_LINE =
    'Do not answer in prose while a tool is needed; the tool block is the whole reply.';

  /**
   * buildCoaching(adapter, tools) → the "## PROTOCOL COACHING" block, or ''.
   * Only families that need it get lines; every family repeats the exact
   * protocol with one literal example, because none of them has native tools.
   */
  function buildCoaching(adapter, tools) {
    const a = adapter || {};
    if (!a.supportsTextProtocol) {
      return '\n## PROTOCOL COACHING\nThis model cannot drive tools on this server. Answer in prose only; do not emit <<<TOOL>>>.\n';
    }

    const lines = [];
    const exampleTool = (tools && tools.length) ? tools[0] : 'list_dir';
    lines.push('## PROTOCOL COACHING (this model has no native function calling)');
    lines.push('To use a tool, reply with EXACTLY this and nothing else in the block:');
    lines.push('<<<TOOL>>>');
    lines.push('{"name":"' + exampleTool + '","args":{"path":"."}}');
    lines.push('<<<END>>>');
    lines.push(STRICT_JSON_LINE);
    if (tools && tools.length) {
      lines.push('Valid tool names: ' + tools.join(', ') + '. Never invent another name.');
    }
    if (a.jsonCautions) lines.push(a.jsonCautions);
    // Family quirks live in the adapter, so adding a family needs no prompt edit.
    for (const line of a.promptStyle || []) {
      if (line && lines.indexOf(line) === -1) lines.push(line);
    }
    lines.push(SILENT_LINE);
    if (a.smallModel) {
      lines.push('Keep replies short; make one tool call per step and finish within a few steps.');
    }
    return '\n' + lines.join('\n') + '\n';
  }

  const api = { buildSystemPrompt, buildCoaching, getAdapter };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.CloudAI = Object.assign(global.CloudAI || {}, { prompt: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);